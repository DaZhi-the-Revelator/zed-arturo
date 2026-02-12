#!/bin/bash
set -e

echo "============================================"
echo "Building with EMBEDDED bundle.js"
echo "============================================"
echo ""

echo "[1/5] Building language server bundle..."
cd language-server
npm install
npm run build
cd ..
echo "✓ Bundle created at root: bundle.js"
echo ""

echo "[2/5] Verifying bundle exists..."
if [ ! -f "bundle.js" ]; then
    echo "ERROR: bundle.js not created!"
    exit 1
fi
BUNDLE_SIZE=$(wc -c < bundle.js)
echo "  Size: $BUNDLE_SIZE bytes"
echo "✓ Bundle verified"
echo ""

echo "[3/5] Installing embedded lib.rs..."
cd src
if [ -f lib.rs.backup ]; then
    rm lib.rs.backup
fi
cp lib.rs lib.rs.backup
cp lib-embedded.rs lib.rs
cd ..
echo "✓ Embedded version installed"
echo ""

echo "[4/5] Building extension (bundle.js will be embedded)..."
cargo build --release
echo "✓ Extension built with embedded bundle!"
echo ""

echo "[5/5] Cleaning up..."
ZED_EXT="$HOME/.local/share/zed/extensions/work/arturo"
if [ -d "$ZED_EXT" ]; then
    rm -rf "$ZED_EXT"
    echo "✓ Old Zed installation removed"
else
    echo "✓ No old installation to remove"
fi
echo ""

echo "============================================"
echo "Build Complete!"
echo "============================================"
echo ""
echo "The language server bundle is now EMBEDDED in extension.wasm"
echo "This means:"
echo "  ✓ No need to copy bundle.js manually"
echo "  ✓ Works immediately after installing in Zed"
echo "  ✓ Bundle is extracted to temp directory at runtime"
echo ""
echo "Extension size:"
WASM_SIZE=$(wc -c < extension.wasm)
echo "  $WASM_SIZE bytes"
echo ""
echo "Next steps:"
echo "  1. Close Zed completely"
echo "  2. Reopen Zed"
echo "  3. Ctrl+Shift+P → zed: install dev extension"
echo "  4. Browse to: $(pwd)"
echo "  5. Install and test!"
echo ""
echo "No manual copying needed! Everything is self-contained."
echo ""
