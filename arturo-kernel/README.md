# arturo-kernel

A Jupyter kernel for the [Arturo programming language](https://arturo-lang.io/), written in Rust.
Integrates with [Zed's REPL](https://zed.dev/docs/repl) — press `Ctrl+Shift+Enter` (or `Cmd+Shift+Enter` on macOS) on any `.art` file to evaluate a cell.

---

## How it works

`arturo-kernel` implements the [Jupyter messaging protocol v5.3](https://jupyter-client.readthedocs.io/en/stable/messaging.html) over ZeroMQ.
Zed detects it automatically once the kernelspec is installed — no configuration needed.

**Stateful execution across cells:** the kernel accumulates top-level variable and function assignments from prior cells and prepends them to each new execution. This uses Arturo's `arturo --no-color -e '<code>'` subprocess model — one process per cell, with state threaded forward via preamble injection.

```txt
; Cell 1 — defines a function (accumulated into preamble)
double: function [n] [ n * 2 ]

; Cell 2 — uses the function defined above
print double 21   ; -> 42
```

---

## Requirements

### All platforms

- [Arturo](https://arturo-lang.io/) installed and `arturo` on your `PATH`
- [Jupyter](https://jupyter.org/) installed (`pip install jupyter` or via conda)
- [Zed](https://zed.dev/) with the **zed-arturo** extension installed

### Windows — additional prerequisites

The Rust toolchain on Windows requires the MSVC linker and C runtime headers. Install them in this order:

**1. Microsoft C++ Build Tools**

Download and run the [Visual Studio Build Tools installer](https://visualstudio.microsoft.com/visual-cpp-build-tools/). When the installer opens, select the **Desktop development with C++** workload and install it. You do not need the full Visual Studio IDE — the Build Tools alone are sufficient. If you already have Visual Studio 2019 or later installed, the required components are already present.

**2. Rust via rustup**

Download and run [rustup-init.exe](https://win.rustup.rs/). Accept all defaults. This installs `rustup`, `cargo`, and `rustc`, and adds `%USERPROFILE%\.cargo\bin` to your `PATH`. Open a new terminal after installation for the `PATH` change to take effect.

Verify:

```txt
rustc --version
cargo --version
```

**3. Python and Jupyter**

If you do not already have Python, download it from [python.org](https://www.python.org/downloads/windows/). During installation, check **Add Python to PATH**. Then install Jupyter:

```txt
pip install jupyter
```

### macOS / Linux — additional prerequisites

- **Rust**: install via [rustup](https://rustup.rs/) — `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- **macOS**: Xcode Command Line Tools are required — `xcode-select --install`
- **Linux**: ensure `gcc` or `clang` and `pkg-config` are installed — e.g. `sudo apt install build-essential pkg-config`

---

## Build & Install

### Windows

Open a terminal (Command Prompt or PowerShell) in the `zed-arturo` repository root:

```txt
cd arturo-kernel
install.bat
```

The script will:

1. Run `cargo build --release` to compile the kernel binary
2. Copy `arturo-kernel.exe` to `%USERPROFILE%\.cargo\bin\` (already on `PATH` after rustup)
3. Create `%APPDATA%\jupyter\kernels\arturo\` and write `kernel.json` there

### macOS / Linux

```txt
cd arturo-kernel
chmod +x install.sh
./install.sh
```

The script will:

1. Run `cargo build --release`
2. Copy `arturo-kernel` to `~/.cargo/bin/` (or `/usr/local/bin/` as a fallback)
3. Write the kernelspec to `~/Library/Jupyter/kernels/arturo/` (macOS) or `~/.local/share/jupyter/kernels/arturo/` (Linux)

### Verify

```txt
jupyter kernelspec list
# Should show:
#   arturo    /path/to/jupyter/kernels/arturo
```

---

## Using in Zed

1. Open any `.art` file
2. Add a cell separator comment: `; %%`
3. Place your cursor in a cell
4. Press `Ctrl+Shift+Enter` (Windows/Linux) or `Cmd+Shift+Enter` (macOS)

If the Arturo kernel does not appear in Zed's kernel picker, run **"REPL: Refresh Kernelspecs"** from the command palette (`Ctrl+Shift+P`).

---

## Cell separator

Zed uses `; %%` to delimit REPL cells in `.art` files:

```txt
; Cell 1
name: "Arturo"
print ["Hello from" name]

; %%

; Cell 2 — name is still in scope from Cell 1
print upper name
```

---

## Architecture

```txt
arturo-kernel/
├── src/
│   └── main.rs           # Full kernel implementation
├── kernelspec/
│   └── kernel.json       # Jupyter kernelspec descriptor
├── Cargo.toml            # Rust dependencies
├── install.bat           # Windows installer
└── install.sh            # macOS / Linux installer
```

### Dependencies

| Crate | Purpose |
|-------|---------|
| `zeromq` | Pure-Rust ZeroMQ (no libzmq C dependency) |
| `serde` / `serde_json` | Jupyter wire protocol JSON |
| `hmac` + `sha2` + `hex` | Message signing (HMAC-SHA256) |
| `uuid` | Message and session IDs |
| `chrono` | ISO 8601 timestamps in message headers |
| `tokio` | Async runtime for ZeroMQ sockets |

---

## State persistence

Each cell runs via `arturo --no-color -e '<code>'`. The kernel extracts top-level assignments (lines matching `identifier: value`) from each successfully executed cell and prepends them to subsequent cells, giving the appearance of a persistent session.

Statements beginning with `print`, `echo`, `prints`, or `inspect` are intentionally excluded from the preamble — they are side-effects, not state.

---

## Limitations

- **Re-execution overhead** — the full accumulated preamble is re-evaluated on every cell. Deep sessions with expensive initialisation will accumulate latency.
- **No autocomplete / introspection** — completion and hover come from the LSP (`server.js`), which works independently of the kernel.
- **No rich display** — output is plain text/stderr only.
- **Closures and object state** — values involving closures or system resources (sockets, DB handles) cannot be serialised into the preamble and will not survive across cells.
