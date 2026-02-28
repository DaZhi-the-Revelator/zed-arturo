#!/usr/bin/env bash
# install.sh — Build and install the Arturo Jupyter kernel on macOS / Linux
set -e

echo "[arturo-kernel] Building release binary..."
cargo build --release

# Prefer ~/.cargo/bin (already on PATH for Rust users), fall back to /usr/local/bin
INSTALL_DIR="$HOME/.cargo/bin"
if [ ! -d "$INSTALL_DIR" ]; then
    INSTALL_DIR="/usr/local/bin"
fi

echo "[arturo-kernel] Installing binary to $INSTALL_DIR/arturo-kernel"
cp target/release/arturo-kernel "$INSTALL_DIR/arturo-kernel"
chmod +x "$INSTALL_DIR/arturo-kernel"

# Install kernelspec
JUPYTER_DATA=$(jupyter --data-dir 2>/dev/null || echo "$HOME/.local/share/jupyter")
KERNELSPEC_DIR="$JUPYTER_DATA/kernels/arturo"

echo "[arturo-kernel] Installing kernelspec to $KERNELSPEC_DIR"
mkdir -p "$KERNELSPEC_DIR"
cp kernelspec/kernel.json "$KERNELSPEC_DIR/kernel.json"

echo ""
echo "[arturo-kernel] Installation complete!"
echo ""
echo "To verify:"
echo "  jupyter kernelspec list"
echo ""
echo "Then in Zed, open a .art file and press Ctrl+Shift+Enter (macOS: Cmd+Shift+Enter)."
echo "Run 'repl: refresh kernelspecs' in the Zed command palette if Arturo does not appear."
