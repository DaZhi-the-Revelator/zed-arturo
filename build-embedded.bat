@echo off
setlocal enabledelayedexpansion

echo.
echo ================================================================================
echo                   ARTURO ZED EXTENSION - COMPLETE REBUILD
echo ================================================================================
echo.
echo This script will:
echo   1. Clean all old build artifacts (including grammars)
echo   2. Rebuild the language server bundle
echo   3. Clear cargo cache (ensures bundle.js is embedded)
echo   4. Rebuild the Rust extension for WASM (with embedded LSP)
echo   5. Clear Zed's extension cache
echo.
echo Make sure you have:
echo   - Node.js and npm installed
echo   - Rust toolchain installed (with wasm32-wasip1 target)
echo   - Closed Zed completely (if currently running)
echo.
pause
echo.

:: ==============================================================================
:: STEP 0: Verify directory structure
:: ==============================================================================
echo [0/10] Verifying directory structure...

if not exist "language-server\server.js" (
    echo ERROR: Cannot find language-server\server.js
    echo Are you in the zed-arturo directory?
    echo Current directory: %CD%
    pause
    exit /b 1
)

if not exist "src\lib-embedded.rs" (
    echo ERROR: Cannot find src\lib-embedded.rs
    echo This file is required for embedded bundle builds.
    pause
    exit /b 1
)

if not exist "extension.toml" (
    echo ERROR: Cannot find extension.toml
    echo Are you in the zed-arturo directory?
    pause
    exit /b 1
)

echo   Directory structure verified OK
echo.

:: ==============================================================================
:: STEP 1: Verify Rust WASM target installed
:: ==============================================================================
echo [1/10] Verifying Rust WASM target...

rustup target list | findstr /C:"wasm32-wasip1 (installed)" >nul
if %errorlevel% neq 0 (
    echo   WASM target not found, installing...
    rustup target add wasm32-wasip1
    if %errorlevel% neq 0 (
        echo ERROR: Failed to install wasm32-wasip1 target
        echo Try manually: rustup target add wasm32-wasip1
        pause
        exit /b 1
    )
    echo   WASM target installed
) else (
    echo   WASM target already installed
)
echo.

:: ==============================================================================
:: STEP 2: Clean old build artifacts
:: ==============================================================================
echo [2/10] Cleaning old build artifacts...

if exist bundle.js (
    del /Q bundle.js
    echo   - Deleted old bundle.js
)

if exist extension.wasm (
    del /Q extension.wasm
    echo   - Deleted old extension.wasm
)

if exist grammars\arturo (
    echo   - Removing grammars\arturo directory...
    rmdir /S /Q grammars\arturo 2>nul
    if exist grammars\arturo (
        echo     WARNING: Could not fully remove grammars\arturo
    )
)

if exist target\wasm32-wasip1\release (
    echo   - Cleaning target\wasm32-wasip1\release...
    rmdir /S /Q target\wasm32-wasip1\release 2>nul
)

if exist target\wasm32-wasip2\release (
    echo   - Cleaning target\wasm32-wasip2\release...
    rmdir /S /Q target\wasm32-wasip2\release 2>nul
)

if exist target\release (
    echo   - Cleaning target\release...
    rmdir /S /Q target\release 2>nul
)

echo   Cleanup complete
echo.

:: ==============================================================================
:: STEP 3: Grammar note
:: ==============================================================================
echo [3/10] Grammar configuration...
echo   Zed will automatically fetch the grammar from the commit in extension.toml
echo.

:: ==============================================================================
:: STEP 4: Install language server dependencies
:: ==============================================================================
echo [4/10] Installing language server dependencies...

cd language-server
call npm install
if %errorlevel% neq 0 (
    echo ERROR: npm install failed
    cd ..
    pause
    exit /b 1
)
cd ..
echo   Dependencies installed
echo.

:: ==============================================================================
:: STEP 5: Build language server bundle
:: ==============================================================================
echo [5/10] Building language server bundle...

cd language-server
call npm run build
if %errorlevel% neq 0 (
    echo ERROR: npm run build failed
    echo Check language-server\webpack.config.js and package.json
    cd ..
    pause
    exit /b 1
)
cd ..

if not exist bundle.js (
    echo ERROR: bundle.js was not created
    pause
    exit /b 1
)

for %%A in (bundle.js) do set BUNDLE_SIZE=%%~zA
echo   Bundle created: %BUNDLE_SIZE% bytes

if %BUNDLE_SIZE% LSS 100000 (
    echo WARNING: bundle.js seems unusually small (%BUNDLE_SIZE% bytes^)
    pause
)
echo.

:: ==============================================================================
:: STEP 6: Confirm build configuration
:: ==============================================================================
echo [6/10] Confirming build configuration...
echo   Using src\lib.rs (direct server.js path, no temp file extraction)
echo   lib-embedded.rs is kept for reference but not used in dev builds.
echo.

:: ==============================================================================
:: STEP 7: Clean cargo cache
:: ==============================================================================
echo [7/10] Cleaning cargo cache...

cargo clean
if %errorlevel% neq 0 (
    echo WARNING: cargo clean failed, continuing anyway...
)

echo   Cargo cache cleared
echo.

:: ==============================================================================
:: STEP 8: Build Rust extension for WASM
:: ==============================================================================
echo [8/10] Building Rust extension for WASM target...
echo   This may take a few minutes on first build...
echo.

cargo build --release --target wasm32-wasip1

:: Check for the output file directly rather than trusting errorlevel,
:: since cargo may emit warnings that produce a non-zero exit code even
:: when the build succeeds.
if not exist target\wasm32-wasip1\release\zed_arturo.wasm (
    echo.
    echo ERROR: zed_arturo.wasm was not produced.
    echo.
    echo Common causes:
    echo   - bundle.js missing from the repo root
    echo   - Rust toolchain outdated (run: rustup update)
    echo   - wasm32-wasip1 target missing (run: rustup target add wasm32-wasip1)
    echo   - Network error fetching the tree-sitter grammar
    echo.
    pause
    exit /b 1
)

echo.
echo   Rust build successful
echo.

:: ==============================================================================
:: STEP 9: Copy WASM to root and verify
:: ==============================================================================
echo [9/10] Finalizing build...

copy /Y target\wasm32-wasip1\release\zed_arturo.wasm extension.wasm >nul
if %errorlevel% neq 0 (
    echo ERROR: Failed to copy zed_arturo.wasm to extension.wasm
    pause
    exit /b 1
)

for %%A in (extension.wasm) do set WASM_SIZE=%%~zA
echo   extension.wasm created: %WASM_SIZE% bytes

echo.
echo   Verifying bundle is embedded...
set /a EXPECTED_MIN=%BUNDLE_SIZE% + 100000
if %WASM_SIZE% LSS %EXPECTED_MIN% (
    echo   WARNING: WASM seems too small - bundle may not be embedded
    echo   Bundle: %BUNDLE_SIZE% bytes  WASM: %WASM_SIZE% bytes  Expected minimum: %EXPECTED_MIN% bytes
    pause
) else (
    echo   Verification OK (bundle embedded)
)
echo.

:: ==============================================================================
:: STEP 10: Clean Zed extension cache
:: ==============================================================================
echo [10/10] Cleaning Zed extension cache...

set ZED_CACHE=%LOCALAPPDATA%\Zed\extensions\work\arturo
if exist "%ZED_CACHE%" (
    rmdir /S /Q "%ZED_CACHE%" 2>nul
    if exist "%ZED_CACHE%" (
        echo   WARNING: Could not delete Zed cache - close Zed and delete manually:
        echo   %ZED_CACHE%
    ) else (
        echo   Zed cache cleared
    )
) else (
    echo   No cached extension to clear
)
echo.

:: ==============================================================================
:: BUILD COMPLETE
:: ==============================================================================
echo ================================================================================
echo                              BUILD COMPLETE!
echo ================================================================================
echo.
echo   bundle.js       %BUNDLE_SIZE% bytes  (LSP server bundle)
echo   extension.wasm  %WASM_SIZE% bytes  (Rust extension with embedded LSP)
echo.
echo NEXT STEPS:
echo   1. Close Zed completely
echo   2. Reopen Zed
echo   3. Extensions (Ctrl+Shift+X) -^> Install Dev Extension -^> select this directory
echo   4. Open a .art file to verify
echo.
echo If you modified the tree-sitter grammar:
echo   1. Commit and push changes to tree-sitter-arturo
echo   2. Update the commit hash in extension.toml
echo   3. Run this script again
echo.
pause
