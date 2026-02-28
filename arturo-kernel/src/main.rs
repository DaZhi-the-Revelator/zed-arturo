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
use zmq::{Context, Socket, SocketType};

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
        let delim = b"<IDS|MSG>";
        let delim_pos = frames.iter().position(|f| f == delim)?;

        let identities = frames[..delim_pos].to_vec();
        let rest = &frames[delim_pos + 1..];
        if rest.len() < 5 {
            return None;
        }

        let hmac_sig = std::str::from_utf8(&rest[0]).ok()?;
        let header_raw   = &rest[1];
        let parent_raw   = &rest[2];
        let metadata_raw = &rest[3];
        let content_raw  = &rest[4];

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
            header:        serde_json::from_slice(header_raw).unwrap_or(json!({})),
            parent_header: serde_json::from_slice(parent_raw).unwrap_or(json!({})),
            metadata:      serde_json::from_slice(metadata_raw).unwrap_or(json!({})),
            content:       serde_json::from_slice(content_raw).unwrap_or(json!({})),
            buffers,
        })
    }

    fn to_frames(&self, key: &[u8]) -> Vec<Vec<u8>> {
        let header_raw   = serde_json::to_vec(&self.header).unwrap();
        let parent_raw   = serde_json::to_vec(&self.parent_header).unwrap();
        let metadata_raw = serde_json::to_vec(&self.metadata).unwrap();
        let content_raw  = serde_json::to_vec(&self.content).unwrap();

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
        "msg_id":   Uuid::new_v4().to_string(),
        "session":  session,
        "username": "arturo-kernel",
        "date":     Utc::now().to_rfc3339(),
        "msg_type": msg_type,
        "version":  "5.3"
    })
}

fn send_message(socket: &Socket, msg: &JupyterMessage, key: &[u8]) {
    let frames = msg.to_frames(key);
    for (i, frame) in frames.iter().enumerate() {
        let flags = if i == frames.len() - 1 { 0 } else { zmq::SNDMORE };
        socket.send(frame, flags).ok();
    }
}

fn recv_message(socket: &Socket, key: &[u8]) -> Option<JupyterMessage> {
    let mut frames = Vec::new();
    loop {
        let frame = socket.recv_bytes(0).ok()?;
        frames.push(frame);
        if !socket.get_rcvmore().unwrap_or(false) {
            break;
        }
    }
    JupyterMessage::from_frames(frames, key)
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
            let after  = trimmed[colon_pos + 1..].trim();
            let is_ident = !before.is_empty()
                && before.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '?')
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
                format!("Could not start `arturo`. Is Arturo installed and in PATH?\nError: {e}"),
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

    let stdout  = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr  = String::from_utf8_lossy(&output.stderr).to_string();
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
            { "text": "Arturo Documentation", "url": "https://arturo-lang.io/documentation" }
        ]
    })
}

// ── IOPub helpers ─────────────────────────────────────────────────────────────

fn publish_status(
    iopub: &Arc<Mutex<Socket>>,
    key: &[u8],
    session_id: &str,
    parent: &JupyterMessage,
    execution_state: &str,
) {
    let msg = JupyterMessage {
        identities: vec![],
        header: make_header("status", session_id),
        parent_header: parent.header.clone(),
        metadata: json!({}),
        content: json!({ "execution_state": execution_state }),
        buffers: vec![],
    };
    send_message(&iopub.lock().unwrap(), &msg, key);
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

    let ctx = Context::new();

    let shell = ctx.socket(SocketType::ROUTER).unwrap();
    shell.bind(&conn.endpoint(conn.shell_port)).unwrap();

    let iopub = ctx.socket(SocketType::PUB).unwrap();
    iopub.bind(&conn.endpoint(conn.iopub_port)).unwrap();

    let stdin = ctx.socket(SocketType::ROUTER).unwrap();
    stdin.bind(&conn.endpoint(conn.stdin_port)).unwrap();

    let control = ctx.socket(SocketType::ROUTER).unwrap();
    control.bind(&conn.endpoint(conn.control_port)).unwrap();

    let heartbeat = ctx.socket(SocketType::REP).unwrap();
    heartbeat.bind(&conn.endpoint(conn.hb_port)).unwrap();

    eprintln!("[arturo-kernel] All sockets bound.");

    let iopub   = Arc::new(Mutex::new(iopub));
    let state   = Arc::new(Mutex::new(KernelState::new()));

    // Heartbeat thread — echo raw bytes back
    thread::spawn(move || loop {
        if let Ok(msg) = heartbeat.recv_bytes(0) {
            heartbeat.send(&msg, 0).ok();
        }
    });

    // Control thread — shutdown and interrupt
    {
        let key       = key.clone();
        let session_id = session_id.clone();
        let state     = Arc::clone(&state);
        thread::spawn(move || loop {
            if let Some(msg) = recv_message(&control, &key) {
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
                        send_message(&control, &reply, &key);
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
                        send_message(&control, &reply, &key);
                    }
                    other => eprintln!("[arturo-kernel] Unhandled control msg: {other}"),
                }
            }
        });
    }

    // Shell loop — main thread
    loop {
        let msg = match recv_message(&shell, &key) {
            Some(m) => m,
            None    => continue,
        };

        let msg_type = msg.header["msg_type"].as_str().unwrap_or("").to_string();
        eprintln!("[arturo-kernel] shell <- {msg_type}");

        match msg_type.as_str() {
            "kernel_info_request" => {
                let reply = JupyterMessage {
                    identities: msg.identities.clone(),
                    header: make_header("kernel_info_reply", &session_id),
                    parent_header: msg.header.clone(),
                    metadata: json!({}),
                    content: kernel_info_content(),
                    buffers: vec![],
                };
                send_message(&shell, &reply, &key);
            }

            "execute_request" => {
                let code   = msg.content["code"].as_str().unwrap_or("").to_string();
                let silent = msg.content["silent"].as_bool().unwrap_or(false);

                let exec_count = state.lock().unwrap().execution_count + 1;

                if !silent {
                    publish_status(&iopub, &key, &session_id, &msg, "busy");

                    let input_msg = JupyterMessage {
                        identities: vec![],
                        header: make_header("execute_input", &session_id),
                        parent_header: msg.header.clone(),
                        metadata: json!({}),
                        content: json!({ "code": code, "execution_count": exec_count }),
                        buffers: vec![],
                    };
                    send_message(&iopub.lock().unwrap(), &input_msg, &key);
                }

                let (stdout, stderr, is_error) = state.lock().unwrap().execute(&code);
                let final_count = state.lock().unwrap().execution_count;

                if !stdout.is_empty() && !silent {
                    let stream_msg = JupyterMessage {
                        identities: vec![],
                        header: make_header("stream", &session_id),
                        parent_header: msg.header.clone(),
                        metadata: json!({}),
                        content: json!({ "name": "stdout", "text": stdout }),
                        buffers: vec![],
                    };
                    send_message(&iopub.lock().unwrap(), &stream_msg, &key);
                }

                if is_error && !silent {
                    if !stderr.is_empty() {
                        let stream_msg = JupyterMessage {
                            identities: vec![],
                            header: make_header("stream", &session_id),
                            parent_header: msg.header.clone(),
                            metadata: json!({}),
                            content: json!({ "name": "stderr", "text": stderr }),
                            buffers: vec![],
                        };
                        send_message(&iopub.lock().unwrap(), &stream_msg, &key);
                    }
                    let error_msg = JupyterMessage {
                        identities: vec![],
                        header: make_header("error", &session_id),
                        parent_header: msg.header.clone(),
                        metadata: json!({}),
                        content: json!({
                            "ename": "ArturoError",
                            "evalue": "Arturo error",
                            "traceback": stderr.lines().collect::<Vec<_>>()
                        }),
                        buffers: vec![],
                    };
                    send_message(&iopub.lock().unwrap(), &error_msg, &key);
                } else if !stderr.is_empty() && !silent {
                    let stream_msg = JupyterMessage {
                        identities: vec![],
                        header: make_header("stream", &session_id),
                        parent_header: msg.header.clone(),
                        metadata: json!({}),
                        content: json!({ "name": "stderr", "text": stderr }),
                        buffers: vec![],
                    };
                    send_message(&iopub.lock().unwrap(), &stream_msg, &key);
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

                let reply = JupyterMessage {
                    identities: msg.identities.clone(),
                    header: make_header("execute_reply", &session_id),
                    parent_header: msg.header.clone(),
                    metadata: json!({}),
                    content: reply_content,
                    buffers: vec![],
                };
                send_message(&shell, &reply, &key);

                if !silent {
                    publish_status(&iopub, &key, &session_id, &msg, "idle");
                }
            }

            "is_complete_request" => {
                let reply = JupyterMessage {
                    identities: msg.identities.clone(),
                    header: make_header("is_complete_reply", &session_id),
                    parent_header: msg.header.clone(),
                    metadata: json!({}),
                    content: json!({ "status": "complete" }),
                    buffers: vec![],
                };
                send_message(&shell, &reply, &key);
            }

            "comm_info_request" => {
                let reply = JupyterMessage {
                    identities: msg.identities.clone(),
                    header: make_header("comm_info_reply", &session_id),
                    parent_header: msg.header.clone(),
                    metadata: json!({}),
                    content: json!({ "status": "ok", "comms": {} }),
                    buffers: vec![],
                };
                send_message(&shell, &reply, &key);
            }

            "history_request" => {
                let reply = JupyterMessage {
                    identities: msg.identities.clone(),
                    header: make_header("history_reply", &session_id),
                    parent_header: msg.header.clone(),
                    metadata: json!({}),
                    content: json!({ "status": "ok", "history": [] }),
                    buffers: vec![],
                };
                send_message(&shell, &reply, &key);
            }

            other => eprintln!("[arturo-kernel] Unhandled shell msg: {other}"),
        }
    }
}
