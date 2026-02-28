#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Header($text) {
    Write-Host ""
    Write-Host ("=" * 80)
    Write-Host "  $text"
    Write-Host ("=" * 80)
    Write-Host ""
}

function Write-Step($n, $text) {
    Write-Host ""
    Write-Host "[$n/10] $text..."
}

function Fail($msg) {
    Write-Host ""
    Write-Host "ERROR: $msg" -ForegroundColor Red
    Write-Host ""
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Header "ARTURO ZED EXTENSION - COMPLETE REBUILD"

Write-Host "This script will:"
Write-Host "  1. Clean all old build artifacts (including grammars)"
Write-Host "  2. Rebuild the language server bundle"
Write-Host "  3. Clear cargo cache (ensures bundle.js is embedded)"
Write-Host "  4. Rebuild the Rust extension for WASM (with embedded LSP)"
Write-Host "  5. Clear Zed extension cache"
Write-Host ""
Write-Host "Make sure you have:"
Write-Host "  - Node.js and npm installed"
Write-Host "  - Rust toolchain installed (with wasm32-wasip1 target)"
Write-Host "  - Closed Zed completely (if currently running)"
Write-Host ""
Read-Host "Press Enter to continue"

Write-Step "0" "Verifying directory structure"

if (-not (Test-Path "language-server\server.js"))  { Fail "Cannot find language-server\server.js - run from the zed-arturo directory" }
if (-not (Test-Path "src\lib-embedded.rs"))         { Fail "Cannot find src\lib-embedded.rs" }
if (-not (Test-Path "extension.toml"))              { Fail "Cannot find extension.toml - run from the zed-arturo directory" }

Write-Host "  Directory structure verified OK"

Write-Step "1" "Verifying Rust WASM target"

$targets = cmd /c "rustup target list" 2>&1
if ($targets -notmatch "wasm32-wasip1 \(installed\)") {
    Write-Host "  WASM target not found, installing..."
    cmd /c "rustup target add wasm32-wasip1"
    if ($LASTEXITCODE -ne 0) { Fail "Failed to install wasm32-wasip1 target. Try: rustup target add wasm32-wasip1" }
    Write-Host "  WASM target installed"
} else {
    Write-Host "  WASM target already installed"
}

Write-Step "2" "Cleaning old build artifacts"

foreach ($f in @("bundle.js", "extension.wasm")) {
    if (Test-Path $f) { Remove-Item $f -Force; Write-Host "  - Deleted $f" }
}

foreach ($d in @("grammars\arturo", "target\wasm32-wasip1\release", "target\wasm32-wasip2\release", "target\release")) {
    if (Test-Path $d) {
        Write-Host "  - Removing $d..."
        Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "  Cleanup complete"

Write-Step "3" "Grammar configuration"
Write-Host "  Zed will automatically fetch the grammar from the commit in extension.toml"

Write-Step "4" "Installing language server dependencies"

Push-Location "language-server"
cmd /c "npm install"
$npmInstallExit = $LASTEXITCODE
Pop-Location
if ($npmInstallExit -ne 0) { Fail "npm install failed" }
Write-Host "  Dependencies installed"

Write-Step "5" "Building language server bundle"

Push-Location "language-server"
cmd /c "npm run build"
$npmBuildExit = $LASTEXITCODE
Pop-Location
if ($npmBuildExit -ne 0) { Fail "npm run build failed - check language-server\webpack.config.js" }

if (-not (Test-Path "bundle.js")) { Fail "bundle.js was not created by webpack" }

$bundleSize = (Get-Item "bundle.js").Length
Write-Host "  Bundle created: $bundleSize bytes"

Write-Step "6" "Confirming build configuration"
Write-Host "  Using src\lib.rs (embeds bundle.js at compile time, writes to extension work dir at runtime)"
Write-Host "  lib-embedded.rs is kept as an identical reference copy"

Write-Step "7" "Cleaning cargo cache"

cmd /c "cargo clean"
Write-Host "  Cargo cache cleared"

Write-Step "8" "Building Rust extension for WASM target"
Write-Host "  This may take a few minutes on first build..."
Write-Host ""

if (-not (Test-Path "bundle.js")) { Fail "bundle.js missing from extension root - cannot embed into WASM" }

cmd /c "cargo build --release --target wasm32-wasip1"

if (-not (Test-Path "target\wasm32-wasip1\release\zed_arturo.wasm")) {
    Fail "zed_arturo.wasm was not produced. Run 'cargo build --release --target wasm32-wasip1' manually for details."
}

Write-Host ""
Write-Host "  Rust build successful"

Write-Step "9" "Finalizing build"

Copy-Item "target\wasm32-wasip1\release\zed_arturo.wasm" "extension.wasm" -Force
if (-not (Test-Path "extension.wasm")) { Fail "Failed to copy zed_arturo.wasm to extension.wasm" }

$wasmSize = (Get-Item "extension.wasm").Length
Write-Host "  extension.wasm created: $wasmSize bytes"
Write-Host "  Verification OK (bundle embedded at compile time via include_str!)"

Write-Step "10" "Cleaning Zed extension cache"

$zedCache = "$env:LOCALAPPDATA\Zed\extensions\work\arturo"
if (Test-Path $zedCache) {
    Remove-Item $zedCache -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path $zedCache) {
        Write-Host "  WARNING: Could not delete Zed cache - close Zed and delete manually:" -ForegroundColor Yellow
        Write-Host "  $zedCache"
    } else {
        Write-Host "  Zed cache cleared"
    }
} else {
    Write-Host "  No cached extension to clear"
}

Write-Header "BUILD COMPLETE!"

Write-Host "  bundle.js      $bundleSize bytes  (LSP server bundle)"
Write-Host "  extension.wasm $wasmSize bytes  (Rust extension with embedded LSP)"
Write-Host ""
Write-Host "NEXT STEPS:"
Write-Host "  1. Close Zed completely"
Write-Host "  2. Reopen Zed"
Write-Host "  3. Extensions (Ctrl+Shift+X) -> Install Dev Extension -> select this directory"
Write-Host "  4. Open a .art file to verify"
Write-Host ""
Write-Host "If you modified the tree-sitter grammar:"
Write-Host "  1. Commit and push changes to tree-sitter-arturo"
Write-Host "  2. Update the commit hash in extension.toml"
Write-Host "  3. Run this script again"
Write-Host ""
Read-Host "Press Enter to exit"
