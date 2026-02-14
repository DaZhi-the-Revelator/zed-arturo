#!/bin/bash
# ==============================================================================
# COMPLETE ARTURO EXTENSION REBUILD SCRIPT (Linux/Mac)
# ==============================================================================
# This script performs a complete, foolproof rebuild of the Zed extension.
# It handles all cleanup, building, and verification automatically.
# 
# See Rebuild.md in the Docs directory for detailed documentation.
# ==============================================================================

set -e  # Exit on error

echo ""
echo "================================================================================"
echo "                   ARTURO ZED EXTENSION - COMPLETE REBUILD"
echo "================================================================================"
echo ""
echo "This script will:"
echo "  1. Clean all old build artifacts (including grammars)"
echo "  2. Rebuild the language server bundle"
echo "  3. Clear cargo cache (ensures bundle.js is embedded)"
echo "  4. Rebuild the Rust extension for WASM (with embedded LSP)"
echo "  5. Clear Zed's extension cache"
echo ""
echo "Make sure you have:"
echo "  - Node.js and npm installed"
echo "  - Rust toolchain installed (with wasm32-wasip1 target)"
echo "  - Closed Zed completely (if currently running)"
echo ""
read -p "Press Enter to continue..."
echo ""

# ==============================================================================
# STEP 0: Verify directory structure
# ==============================================================================
echo "[0/10] Verifying directory structure..."

if [ ! -f "language-server/server.js" ]; then
    echo "ERROR: Cannot find language-server/server.js"
    echo "Are you in the zed-arturo directory?"
    echo "Current directory: $(pwd)"
    exit 1
fi

if [ ! -f "src/lib-embedded.rs" ]; then
    echo "ERROR: Cannot find src/lib-embedded.rs"
    echo "This file is required for embedded bundle builds."
    exit 1
fi

if [ ! -f "extension.toml" ]; then
    echo "ERROR: Cannot find extension.toml"
    echo "Are you in the zed-arturo directory?"
    exit 1
fi

echo "  Directory structure verified OK"
echo ""

# ==============================================================================
# STEP 1: Verify Rust WASM target installed
# ==============================================================================
echo "[1/10] Verifying Rust WASM target..."

if ! rustup target list | grep -q "wasm32-wasip1 (installed)"; then
    echo "  WASM target not found, installing..."
    rustup target add wasm32-wasip1 || {
        echo "ERROR: Failed to install wasm32-wasip1 target"
        echo "Try manually: rustup target add wasm32-wasip1"
        exit 1
    }
    echo "  WASM target installed"
else
    echo "  WASM target already installed"
fi
echo ""

# ==============================================================================
# STEP 2: Clean old build artifacts
# ==============================================================================
echo "[2/10] Cleaning old build artifacts..."

# Delete old bundle
if [ -f bundle.js ]; then
    rm bundle.js
    echo "  - Deleted old bundle.js"
fi

# Delete old WASM files
if [ -f extension.wasm ]; then
    rm extension.wasm
    echo "  - Deleted old extension.wasm"
fi

# Clean grammars directory - Zed will rebuild from extension.toml
if [ -d grammars/arturo ]; then
    echo "  - Removing grammars/arturo directory..."
    echo "    Zed will rebuild it from the commit specified in extension.toml"
    rm -rf grammars/arturo 2>/dev/null || {
        echo "    WARNING: Could not fully remove grammars/arturo"
        echo "    This may cause git checkout errors during build"
    }
fi

# Clean WASM target directories (where Zed extensions actually build to)
if [ -d target/wasm32-wasip1/release ]; then
    echo "  - Cleaning target/wasm32-wasip1/release directory..."
    rm -rf target/wasm32-wasip1/release
fi

if [ -d target/wasm32-wasip2/release ]; then
    echo "  - Cleaning target/wasm32-wasip2/release directory..."
    rm -rf target/wasm32-wasip2/release
fi

# Also clean regular release directory in case it exists
if [ -d target/release ]; then
    echo "  - Cleaning target/release directory..."
    rm -rf target/release
fi

echo "  Cleanup complete"
echo ""

# ==============================================================================
# STEP 3: Grammar will be fetched by Zed
# ==============================================================================
echo "[3/10] Grammar configuration..."

echo "  Grammars directory has been removed"
echo "  Zed will automatically fetch the grammar from:"
echo "  Repository: https://github.com/DaZhi-the-Revelator/tree-sitter-arturo"
echo "  Commit: (specified in extension.toml)"
echo ""
echo "  NOTE: If you modified tree-sitter-arturo grammar files, make sure:"
echo "    1. Changes are committed and pushed to GitHub"
echo "    2. extension.toml references the correct commit hash"
echo ""

# ==============================================================================
# STEP 4: Install/Update Language Server Dependencies
# ==============================================================================
echo "[4/10] Installing language server dependencies..."

cd language-server
npm install || {
    echo ""
    echo "ERROR: npm install failed"
    echo "Check your Node.js installation and network connection"
    exit 1
}
cd ..

echo "  Dependencies installed"
echo ""

# ==============================================================================
# STEP 5: Build Language Server Bundle
# ==============================================================================
echo "[5/10] Building language server bundle..."

cd language-server
echo "  Running webpack to bundle server.js..."
npm run build || {
    echo ""
    echo "ERROR: npm run build failed"
    echo "Check language-server/webpack.config.js and package.json"
    exit 1
}
cd ..

# Verify bundle was created
if [ ! -f bundle.js ]; then
    echo ""
    echo "ERROR: bundle.js was not created"
    echo "The webpack build may have failed silently"
    echo "Check language-server/package.json 'build' script"
    exit 1
fi

# Show bundle size
BUNDLE_SIZE=$(wc -c < bundle.js | tr -d ' ')
echo "  Bundle created: $BUNDLE_SIZE bytes"

# Basic verification that bundle contains code
if [ "$BUNDLE_SIZE" -lt 100000 ]; then
    echo ""
    echo "WARNING: bundle.js seems unusually small ($BUNDLE_SIZE bytes)"
    echo "Expected size: 500KB - 1MB"
    echo "The bundle may be incomplete"
    read -p "Press Enter to continue anyway..."
fi

echo ""

# ==============================================================================
# STEP 6: Install Embedded Build Configuration
# ==============================================================================
echo "[6/10] Configuring embedded build..."

cd src

# Backup current lib.rs
if [ -f lib.rs ] && [ ! -f lib.rs.backup ]; then
    cp lib.rs lib.rs.backup
fi

# Install embedded version
cp lib-embedded.rs lib.rs || {
    echo "ERROR: Failed to copy lib-embedded.rs to lib.rs"
    exit 1
}

cd ..

echo "  Embedded configuration installed (bundle.js will be included in WASM)"
echo ""

# ==============================================================================
# STEP 7: Clean Cargo Cache (CRITICAL for embedding bundle.js)
# ==============================================================================
echo "[7/10] Cleaning cargo cache..."
echo "  This ensures bundle.js will be embedded in the WASM file"
echo ""

cargo clean || {
    echo "WARNING: cargo clean failed, continuing anyway..."
}

echo "  Cargo cache cleared - will do full rebuild"
echo ""

# ==============================================================================
# STEP 8: Build Rust Extension for WASM
# ==============================================================================
echo "[8/10] Building Rust extension for WASM target..."
echo "  This may take a few minutes on first build..."
echo "  Target: wasm32-wasip1"
echo "  Zed will fetch and compile the grammar during this step..."
echo ""

cargo build --release --target wasm32-wasip1 || {
    echo ""
    echo "ERROR: Cargo build failed"
    echo ""
    echo "Common causes:"
    echo "  - bundle.js not found at root"
    echo "  - Rust toolchain not installed or outdated"
    echo "  - wasm32-wasip1 target not installed"
    echo "  - Grammar fetch/compile failed (check network connection)"
    echo "  - Missing system dependencies"
    echo ""
    echo "Try:"
    echo "  rustup update"
    echo "  rustup target add wasm32-wasip1"
    echo ""
    echo "Debug info:"
    rustup target list | grep wasm32
    exit 1
}

echo ""
echo "  Rust build successful"
echo "  Grammar was fetched and compiled by Zed"
echo ""

# ==============================================================================
# STEP 9: Copy WASM to Root and Verify Bundle Embedding
# ==============================================================================
echo "[9/10] Finalizing build..."

# Verify WASM was created in the correct location
if [ ! -f target/wasm32-wasip1/release/zed_arturo.wasm ]; then
    echo "ERROR: target/wasm32-wasip1/release/zed_arturo.wasm was not created"
    echo "The cargo build may have failed silently"
    echo ""
    echo "Checking other possible locations..."
    if [ -f target/release/libzed_arturo.dylib ]; then
        echo "Found at target/release/libzed_arturo.dylib (macOS)"
        echo "This means cargo built for the host instead of WASM!"
    fi
    if [ -f target/release/libzed_arturo.so ]; then
        echo "Found at target/release/libzed_arturo.so (Linux)"
        echo "This means cargo built for the host instead of WASM!"
    fi
    if [ -f target/wasm32-wasip2/release/zed_arturo.wasm ]; then
        echo "Found at target/wasm32-wasip2/release/zed_arturo.wasm"
        echo "Using wasip2 instead of wasip1"
    fi
    echo ""
    echo "Listing WASM files in target:"
    find target -name "*.wasm" 2>/dev/null || echo "No WASM files found"
    exit 1
fi

# Copy to root and rename
cp target/wasm32-wasip1/release/zed_arturo.wasm extension.wasm || {
    echo "ERROR: Failed to copy zed_arturo.wasm to extension.wasm"
    exit 1
}

# Show extension size
WASM_SIZE=$(wc -c < extension.wasm | tr -d ' ')
echo "  Extension created: $WASM_SIZE bytes"

# Verify bundle is embedded by checking size
echo ""
echo "  Verifying bundle embedding..."
EXPECTED_MIN=$((BUNDLE_SIZE + 100000))

if [ "$WASM_SIZE" -lt "$EXPECTED_MIN" ]; then
    echo ""
    echo "  WARNING: WASM seems too small!"
    echo "  Bundle size:     $BUNDLE_SIZE bytes"
    echo "  WASM size:       $WASM_SIZE bytes"
    echo "  Expected min:    $EXPECTED_MIN bytes"
    echo ""
    echo "  The bundle may NOT be properly embedded!"
    echo "  This usually means cargo used a cached build."
    echo ""
    echo "  Try running: cargo clean && cargo build --release --target wasm32-wasip1"
    read -p "Press Enter to continue..."
else
    echo "  Bundle verification: OK"
    echo "  Bundle size:     $BUNDLE_SIZE bytes"
    echo "  WASM size:       $WASM_SIZE bytes"
    echo "  Bundle appears to be embedded correctly!"
fi

echo ""

# ==============================================================================
# STEP 10: Clean Zed Extension Cache
# ==============================================================================
echo "[10/10] Cleaning Zed extension cache..."

# Determine Zed cache location based on OS
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    ZED_CACHE="$HOME/Library/Application Support/Zed/extensions/work/arturo"
else
    # Linux
    ZED_CACHE="$HOME/.local/share/zed/extensions/work/arturo"
fi

if [ -d "$ZED_CACHE" ]; then
    rm -rf "$ZED_CACHE"
    if [ -d "$ZED_CACHE" ]; then
        echo "  WARNING: Could not delete Zed cache directory"
        echo "  Close Zed and try manually deleting: $ZED_CACHE"
    else
        echo "  Zed cache cleared"
    fi
else
    echo "  No cached extension to clear"
fi

echo ""

# ==============================================================================
# BUILD COMPLETE - Show Summary
# ==============================================================================
echo "================================================================================"
echo "                              BUILD COMPLETE!"
echo "================================================================================"
echo ""
echo "Build artifacts created:"
echo ""
echo "  bundle.js       - $BUNDLE_SIZE bytes (LSP server bundle)"
echo "  extension.wasm  - $WASM_SIZE bytes (Rust extension with embedded LSP)"
echo ""
echo "Grammar status:"
echo "  Fetched from GitHub (commit specified in extension.toml)"
echo "  Compiled by Zed during cargo build"
echo ""
echo "The extension is ready to install!"
echo ""
echo "================================================================================"
echo "                              NEXT STEPS"
echo "================================================================================"
echo ""
echo "1. CLOSE ZED COMPLETELY"
echo "   - Make sure it's fully closed, not just minimized"
echo "   - Check Activity Monitor (Mac) or System Monitor (Linux) if needed"
echo ""
echo "2. REOPEN ZED"
echo ""
echo "3. INSTALL DEV EXTENSION"
echo "   - Press Cmd+Shift+X (Mac) or Ctrl+Shift+X (Linux)"
echo "   - Click 'Install Dev Extension'"
echo "   - Browse to: $(pwd)"
echo "   - Click 'Open' or 'Select Folder'"
echo ""
echo "4. TEST THE EXTENSION"
echo "   - Open or create a .art file"
echo "   - Verify syntax highlighting works"
echo "   - Test LSP features (hover, completion, etc.)"
echo ""
echo "5. CHECK LOGS (if issues occur)"
echo "   - Menu -> View -> Zed Log"
echo "   - Look for 'arturo-lsp' entries"
echo ""
echo "================================================================================"
echo "                              IMPORTANT NOTES"
echo "================================================================================"
echo ""
echo "- All LSP features are ENABLED by default"
echo "- To change settings, edit Zed's settings.json"
echo "- Settings changes require a FULL ZED RESTART to take effect"
echo "- See Rebuild.md in the Docs directory for detailed documentation"
echo ""
echo "If you modified tree-sitter grammar:"
echo "  1. Commit and push changes to tree-sitter-arturo repository"
echo "  2. Get the new commit hash: git rev-parse HEAD"
echo "  3. Update extension.toml with the new commit hash"
echo "  4. Then run this script again"
echo ""
echo "================================================================================"
echo ""
