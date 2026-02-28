//! arturo-kernel — Jupyter kernel for the Arturo programming language
//!
//! Implements the Jupyter messaging protocol (v5.3) over ZeroMQ.
//! Zed's REPL uses this kernel when you open the REPL panel on a .art file.
//!
//! Architecture:
//!   - Shell socket:   receives execute_request, kernel_info_request, etc.
//!   - IOPub socket:   broadcasts status, stream output, and errors to all clients
//!   - Stdin socket:   (input_request — not used, kept for protocol compliance)
//!   - Control socket: handles shutdown_request, interrupt_request
//!   - Heartbeat:      echoes back raw bytes to signal liveness
//!
//! State persistence:
//!   Arturo has no persistent session mode suitable for piping, so each cell
//!   is executed via `arturo --no-color -e '<code>'`. To share state across
//!   cells the kernel tracks variable assignments from prior cells and prepends
//!   them to each new execution.

use chrono::Utc;
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::Sha256;
use std::{
    env, fs,
    path::PathBuf,
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
};
use uuid::Uuid;
use zeromq::{RouterSocket, PubSocket, RepSocket, Socket, SocketRecv, SocketSend, ZmqMessage};
use tokio::runtime::Runtime;

// ── Jupyter wire-protocol types ──────────────────────────────────────────────

#[derive(Debug, Clone)]
struct JupyterMessage {
    identities: Vec<Vec<u8>>,
    header: Value,
    parent_header: Value,
    metadata: Value,
    content: Value,
    buffers: Vec<Vec<u8>>,
}

impl JupyterMessage {
    fn from_frames(frames: Vec<Vec<u8>>, key: &[u8]) -> Option<Self> {
        let delim: &[u8] = b"<IDS|MSG>";
        let delim_pos = frames.iter().position(|f| f.as_slice() == delim)?;

        let identities = frames[..delim_pos].to_vec();
        let rest = &frames[delim_pos + 1..];
        if rest.len() < 5 {
            return None;
        }

        let hmac_sig = std::str::from_utf8(&rest[0]).ok()?;
        let header_raw = &rest[1];
        let parent_raw = &rest[2];
        let metadata_raw = &rest[3];
        let content_raw = &rest[4];

        if !key.is_empty() {
            let expected = compute_hmac(key, &[header_raw, parent_raw, metadata_raw, content_raw]);
            if expected != hmac_sig {
                eprintln!("[arturo-kernel] HMAC mismatch — dropping message");
                return None;
            }
        }

        let buffers = rest[5..].to_vec();

        Some(JupyterMessage {
            identities,
            header: serde_json::from_slice(header_raw).unwrap_or(json!({})),
            parent_header: serde_json::from_slice(parent_raw).unwrap_or(json!({})),
            metadata: serde_json::from_slice(metadata_raw).unwrap_or(json!({})),
            content: serde_json::from_slice(content_raw).unwrap_or(json!({})),
            buffers,
        })
    }

    fn to_frames(&self, key: &[u8]) -> Vec<Vec<u8>> {
        let header_raw = serde_json::to_vec(&self.header).unwrap();
        let parent_raw = serde_json::to_vec(&self.parent_header).unwrap();
        let metadata_raw = serde_json::to_vec(&self.metadata).unwrap();
        let content_raw = serde_json::to_vec(&self.content).unwrap();

        let sig = compute_hmac(key, &[&header_raw, &parent_raw, &metadata_raw, &content_raw]);

        let mut frames: Vec<Vec<u8>> = self.identities.clone();
        frames.push(b"<IDS|MSG>".to_vec());
        frames.push(sig.into_bytes());
        frames.push(header_raw);
        frames.push(parent_raw);
        frames.push(metadata_raw);
        frames.push(content_raw);
        for buf in &self.buffers {
            frames.push(buf.clone());
        }
        frames
    }

    fn to_zmq(&self, key: &[u8]) -> ZmqMessage {
        let frames = self.to_frames(key);
        let parts: Vec<bytes::Bytes> = frames.into_iter().map(bytes::Bytes::from).collect();
        ZmqMessage::from(parts)
    }
}

fn zmq_to_frames(msg: ZmqMessage) -> Vec<Vec<u8>> {
    msg.into_vec().into_iter().map(|b| b.to_vec()).collect()
}

fn compute_hmac(key: &[u8], parts: &[&[u8]]) -> String {
    if key.is_empty() {
        return String::new();
    }
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts any key size");
    for part in parts {
        mac.update(part);
    }
    hex::encode(mac.finalize().into_bytes())
}

fn make_header(msg_type: &str, session: &str) -> Value {
    json!({
        "msg_id": Uuid::new_v4().to_string(),
        "session": session,
        "username": "arturo-kernel",
        "date": Utc::now().to_rfc3339(),
        "msg_type": msg_type,
        "version": "5.3"
    })
}

// ── Connection file ───────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct ConnectionInfo {
    ip: String,
    transport: String,
    shell_port: u16,
    iopub_port: u16,
    stdin_port: u16,
    control_port: u16,
    hb_port: u16,
    key: String,
    #[allow(dead_code)]
    signature_scheme: String,
    #[allow(dead_code)]
    kernel_name: Option<String>,
}

impl ConnectionInfo {
    fn endpoint(&self, port: u16) -> String {
        format!("{}://{}:{}", self.transport, self.ip, port)
    }
}

// ── Session state ─────────────────────────────────────────────────────────────

#[derive(Debug, Default)]
struct KernelState {
    /// Variable and function definitions from prior cells, prepended on each run.
    preamble: Vec<String>,
    execution_count: u32,
    tmp_dir: PathBuf,
    running_pid: Option<u32>,
}

impl KernelState {
    fn new() -> Self {
        let tmp_dir = env::temp_dir().join(format!("arturo-kernel-{}", Uuid::new_v4()));
        fs::create_dir_all(&tmp_dir).ok();
        KernelState {
            preamble: Vec::new(),
            execution_count: 0,
            tmp_dir,
            running_pid: None,
        }
    }

    fn execute(&mut self, code: &str) -> (String, String, bool) {
        self.execution_count += 1;

        let mut full_code = self.preamble.join("\n");
        if !full_code.is_empty() {
            full_code.push('\n');
        }
        full_code.push_str(code);

        let result = run_arturo(&full_code, self);

        if !result.2 {
            self.preamble.extend(extract_assignments(code));
        }

        result
    }
}

impl Drop for KernelState {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.tmp_dir).ok();
    }
}

// ── Arturo utilities ──────────────────────────────────────────────────────────

/// Extract top-level variable and function assignments from a cell so that
/// subsequent cells can reference them. In Arturo, assignments are of the form
/// `identifier: value` where `:` is the assignment operator.
fn extract_assignments(code: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut depth = 0i32;
    let mut current_block: Vec<&str> = Vec::new();
    let mut in_block = false;

    for line in code.lines() {
        let trimmed = line.trim();

        for ch in line.chars() {
            match ch {
                '[' | '{' | '(' => depth += 1,
                ']' | '}' | ')' => depth -= 1,
                _ => {}
            }
        }

        if in_block {
            current_block.push(line);
            if depth == 0 {
                result.push(current_block.join("\n"));
                current_block.clear();
                in_block = false;
            }
            continue;
        }

        if trimmed.is_empty()
            || trimmed.starts_with(';')
            || trimmed.starts_with("print ")
            || trimmed.starts_with("echo ")
            || trimmed.starts_with("prints ")
            || trimmed.starts_with("inspect ")
        {
            continue;
        }

        if let Some(colon_pos) = trimmed.find(':') {
            let before = &trimmed[..colon_pos];
            let after = trimmed[colon_pos + 1..].trim();
            let is_ident = !before.is_empty()
                && before
                    .chars()
                    .all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '?')
                && !after.is_empty();

            if is_ident {
                if depth > 0 {
                    current_block.push(line);
                    in_block = true;
                } else {
                    result.push(line.to_string());
                }
            }
        }
    }

    result
}

fn run_arturo(code: &str, state: &mut KernelState) -> (String, String, bool) {
    let mut cmd = Command::new("arturo");
    cmd.arg("--no-color")
        .arg("-e")
        .arg(code)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return (
                String::new(),
                format!(
                    "Could not start `arturo`. Is Arturo installed and in PATH?\nError: {e}"
                ),
                true,
            );
        }
    };

    state.running_pid = Some(child.id());

    let output = match child.wait_with_output() {
        Ok(o) => o,
        Err(e) => {
            state.running_pid = None;
            return (String::new(), format!("Failed to wait on `arturo -e`: {e}"), true);
        }
    };

    state.running_pid = None;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let is_error = !output.status.success();

    (stdout, stderr, is_error)
}

fn interrupt_process(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as libc::pid_t, libc::SIGINT);
    }
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, TerminateProcess, PROCESS_TERMINATE,
        };
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if handle != 0 {
            TerminateProcess(handle, 1);
            CloseHandle(handle);
        }
    }
}

fn kernel_info_content() -> Value {
    json!({
        "status": "ok",
        "protocol_version": "5.3",
        "implementation": "arturo-kernel",
        "implementation_version": "0.1.0",
        "language_info": {
            "name": "arturo",
            "version": "0.9",
            "mimetype": "text/x-arturo",
            "file_extension": ".art",
            "pygments_lexer": "arturo",
            "codemirror_mode": "arturo"
        },
        "banner": "Arturo kernel for Zed — stateful REPL powered by arturo-kernel",
        "help_links": [
            {
                "text": "Arturo Documentation",
                "url": "https://arturo-lang.io/documentation"
            }
        ]
    })
}

// ── IOPub helpers ─────────────────────────────────────────────────────────────

macro_rules! pub_send {
    ($iopub:expr, $msg:expr, $key:expr, $rt:expr) => {
        $rt.block_on(async {
            let mut sock = $iopub.lock().unwrap();
            let _ = sock.send($msg.to_zmq($key)).await;
        });
    };
}

fn publish_status(
    iopub: &Arc<Mutex<PubSocket>>,
    key: &[u8],
    session: &str,
    parent: &JupyterMessage,
    execution_state: &str,
    rt: &Runtime,
) {
    pub_send!(
        iopub,
        JupyterMessage {
            identities: vec![b"status".to_vec()],
            header: make_header("status", session),
            parent_header: parent.header.clone(),
            metadata: json!({}),
            content: json!({ "execution_state": execution_state }),
            buffers: vec![],
        },
        key,
        rt
    );
}

fn publish_execute_input(
    iopub: &Arc<Mutex<PubSocket>>,
    key: &[u8],
    session: &str,
    parent: &JupyterMessage,
    code: &str,
    count: u32,
    rt: &Runtime,
) {
    pub_send!(
        iopub,
        JupyterMessage {
            identities: vec![b"execute_input".to_vec()],
            header: make_header("execute_input", session),
            parent_header: parent.header.clone(),
            metadata: json!({}),
            content: json!({ "code": code, "execution_count": count }),
            buffers: vec![],
        },
        key,
        rt
    );
}

fn publish_stream(
    iopub: &Arc<Mutex<PubSocket>>,
    key: &[u8],
    session: &str,
    parent: &JupyterMessage,
    name: &str,
    text: &str,
    rt: &Runtime,
) {
    pub_send!(
        iopub,
        JupyterMessage {
            identities: vec![format!("stream.{name}").into_bytes()],
            header: make_header("stream", session),
            parent_header: parent.header.clone(),
            metadata: json!({}),
            content: json!({ "name": name, "text": text }),
            buffers: vec![],
        },
        key,
        rt
    );
}

fn publish_error(
    iopub: &Arc<Mutex<PubSocket>>,
    key: &[u8],
    session: &str,
    parent: &JupyterMessage,
    ename: &str,
    evalue: &str,
    traceback: &str,
    rt: &Runtime,
) {
    pub_send!(
        iopub,
        JupyterMessage {
            identities: vec![b"error".to_vec()],
            header: make_header("error", session),
            parent_header: parent.header.clone(),
            metadata: json!({}),
            content: json!({
                "ename": ename,
                "evalue": evalue,
                "traceback": traceback.lines().collect::<Vec<_>>()
            }),
            buffers: vec![],
        },
        key,
        rt
    );
}

// ── Main ──────────────────────────────────────────────────────────────────────

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage: arturo-kernel <connection-file>");
        std::process::exit(1);
    }

    let conn_json = fs::read_to_string(&args[1]).expect("Could not read connection file");
    let conn: ConnectionInfo =
        serde_json::from_str(&conn_json).expect("Invalid connection file JSON");

    let key = conn.key.as_bytes().to_vec();
    let session_id = Uuid::new_v4().to_string();

    eprintln!("[arturo-kernel] Starting. Session: {session_id}");

    let rt = Arc::new(Runtime::new().expect("Could not create tokio runtime"));

    // Bind all sockets
    let (shell, iopub, _stdin, control, heartbeat) = rt.block_on(async {
        let mut shell = RouterSocket::new();
        shell.bind(&conn.endpoint(conn.shell_port)).await.unwrap();

        let mut iopub = PubSocket::new();
        iopub.bind(&conn.endpoint(conn.iopub_port)).await.unwrap();

        let mut stdin = RouterSocket::new();
        stdin.bind(&conn.endpoint(conn.stdin_port)).await.unwrap();

        let mut control = RouterSocket::new();
        control.bind(&conn.endpoint(conn.control_port)).await.unwrap();

        let mut heartbeat = RepSocket::new();
        heartbeat.bind(&conn.endpoint(conn.hb_port)).await.unwrap();

        (shell, iopub, stdin, control, heartbeat)
    });

    eprintln!("[arturo-kernel] All sockets bound.");

    let shell: Arc<Mutex<RouterSocket>> = Arc::new(Mutex::new(shell));
    let iopub: Arc<Mutex<PubSocket>> = Arc::new(Mutex::new(iopub));
    let control: Arc<Mutex<RouterSocket>> = Arc::new(Mutex::new(control));
    let heartbeat: Arc<Mutex<RepSocket>> = Arc::new(Mutex::new(heartbeat));
    let state = Arc::new(Mutex::new(KernelState::new()));

    // Heartbeat thread — echo raw bytes back
    {
        let heartbeat = Arc::clone(&heartbeat);
        let rt2 = Arc::clone(&rt);
        thread::spawn(move || loop {
            rt2.block_on(async {
                let msg_opt = heartbeat.lock().unwrap().recv().await.ok();
                if let Some(msg) = msg_opt {
                    let _ = heartbeat.lock().unwrap().send(msg).await;
                }
            });
        });
    }

    // Control thread — shutdown and interrupt
    {
        let control = Arc::clone(&control);
        let state = Arc::clone(&state);
        let key = key.clone();
        let session_id = session_id.clone();
        let rt2 = Arc::clone(&rt);
        thread::spawn(move || loop {
            let frames_opt = rt2.block_on(async {
                control.lock().unwrap().recv().await.ok().map(zmq_to_frames)
            });

            let msg = match frames_opt.and_then(|f| JupyterMessage::from_frames(f, &key)) {
                Some(m) => m,
                None => continue,
            };

            let msg_type = msg.header["msg_type"].as_str().unwrap_or("").to_string();

            match msg_type.as_str() {
                "shutdown_request" => {
                    let restart = msg.content["restart"].as_bool().unwrap_or(false);
                    let reply = JupyterMessage {
                        identities: msg.identities.clone(),
                        header: make_header("shutdown_reply", &session_id),
                        parent_header: msg.header.clone(),
                        metadata: json!({}),
                        content: json!({ "status": "ok", "restart": restart }),
                        buffers: vec![],
                    };
                    rt2.block_on(async {
                        let _ = control.lock().unwrap().send(reply.to_zmq(&key)).await;
                    });
                    eprintln!("[arturo-kernel] Shutdown. restart={restart}");
                    if !restart {
                        std::process::exit(0);
                    }
                }
                "interrupt_request" => {
                    if let Some(pid) = state.lock().unwrap().running_pid {
                        interrupt_process(pid);
                        eprintln!("[arturo-kernel] Interrupted pid={pid}");
                    }
                    let reply = JupyterMessage {
                        identities: msg.identities.clone(),
                        header: make_header("interrupt_reply", &session_id),
                        parent_header: msg.header.clone(),
                        metadata: json!({}),
                        content: json!({ "status": "ok" }),
                        buffers: vec![],
                    };
                    rt2.block_on(async {
                        let _ = control.lock().unwrap().send(reply.to_zmq(&key)).await;
                    });
                }
                other => eprintln!("[arturo-kernel] Unhandled control msg: {other}"),
            }
        });
    }

    // Shell loop — main thread
    loop {
        let frames_opt = rt.block_on(async {
            shell.lock().unwrap().recv().await.ok().map(zmq_to_frames)
        });

        let msg = match frames_opt.and_then(|f| JupyterMessage::from_frames(f, &key)) {
            Some(m) => m,
            None => continue,
        };

        let msg_type = msg.header["msg_type"].as_str().unwrap_or("").to_string();
        eprintln!("[arturo-kernel] shell <- {msg_type}");

        macro_rules! shell_reply {
            ($msg_type:expr, $content:expr) => {{
                let reply = JupyterMessage {
                    identities: msg.identities.clone(),
                    header: make_header($msg_type, &session_id),
                    parent_header: msg.header.clone(),
                    metadata: json!({}),
                    content: $content,
                    buffers: vec![],
                };
                rt.block_on(async {
                    let _ = shell.lock().unwrap().send(reply.to_zmq(&key)).await;
                });
            }};
        }

        match msg_type.as_str() {
            "kernel_info_request" => {
                shell_reply!("kernel_info_reply", kernel_info_content());
            }

            "execute_request" => {
                let code = msg.content["code"].as_str().unwrap_or("").to_string();
                let silent = msg.content["silent"].as_bool().unwrap_or(false);
                let exec_count = state.lock().unwrap().execution_count + 1;

                if !silent {
                    publish_status(&iopub, &key, &session_id, &msg, "busy", &rt);
                    publish_execute_input(&iopub, &key, &session_id, &msg, &code, exec_count, &rt);
                }

                let (stdout, stderr, is_error) = state.lock().unwrap().execute(&code);
                let final_count = state.lock().unwrap().execution_count;

                if !stdout.is_empty() && !silent {
                    publish_stream(&iopub, &key, &session_id, &msg, "stdout", &stdout, &rt);
                }

                if is_error && !silent {
                    if !stderr.is_empty() {
                        publish_stream(&iopub, &key, &session_id, &msg, "stderr", &stderr, &rt);
                    }
                    publish_error(
                        &iopub,
                        &key,
                        &session_id,
                        &msg,
                        "ArturoError",
                        "Arturo error",
                        &stderr,
                        &rt,
                    );
                } else if !stderr.is_empty() && !silent {
                    publish_stream(&iopub, &key, &session_id, &msg, "stderr", &stderr, &rt);
                }

                let reply_content = if is_error {
                    json!({
                        "status": "error",
                        "execution_count": final_count,
                        "ename": "ArturoError",
                        "evalue": "Arturo error",
                        "traceback": stderr.lines().collect::<Vec<_>>()
                    })
                } else {
                    json!({
                        "status": "ok",
                        "execution_count": final_count,
                        "payload": [],
                        "user_expressions": {}
                    })
                };

                shell_reply!("execute_reply", reply_content);

                if !silent {
                    publish_status(&iopub, &key, &session_id, &msg, "idle", &rt);
                }
            }

            "is_complete_request" => {
                shell_reply!("is_complete_reply", json!({ "status": "complete" }));
            }

            "comm_info_request" => {
                shell_reply!("comm_info_reply", json!({ "status": "ok", "comms": {} }));
            }

            "history_request" => {
                shell_reply!("history_reply", json!({ "status": "ok", "history": [] }));
            }

            other => {
                eprintln!("[arturo-kernel] Unhandled shell msg: {other}");
            }
        }
    }
}
