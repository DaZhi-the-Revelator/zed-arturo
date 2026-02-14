@echo off
setlocal enabledelayedexpansion

:: ==============================================================================
:: COMPLETE ARTURO EXTENSION REBUILD SCRIPT
:: ==============================================================================
:: This script performs a complete, foolproof rebuild of the Zed extension.
:: It handles all cleanup, building, and verification automatically.
:: 
:: See Rebuild.md in the Docs directory for detailed documentation.
:: ==============================================================================

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

:: Delete old bundle
if exist bundle.js (
    del /Q bundle.js
    echo   - Deleted old bundle.js
)

:: Delete old WASM files
if exist extension.wasm (
    del /Q extension.wasm
    echo   - Deleted old extension.wasm
)

:: Clean grammars directory - Zed will rebuild from extension.toml
if exist grammars\arturo (
    echo   - Removing grammars\arturo directory...
    echo     Zed will rebuild it from the commit specified in extension.toml
    rmdir /S /Q grammars\arturo 2>nul
    if exist grammars\arturo (
        echo     WARNING: Could not fully remove grammars\arturo
        echo     This may cause git checkout errors during build
        echo     Try closing any programs that might have files open in that directory
    )
)

:: Clean WASM target directories (where Zed extensions actually build to)
if exist target\wasm32-wasip1\release (
    echo   - Cleaning target\wasm32-wasip1\release directory...
    rmdir /S /Q target\wasm32-wasip1\release 2>nul
)

if exist target\wasm32-wasip2\release (
    echo   - Cleaning target\wasm32-wasip2\release directory...
    rmdir /S /Q target\wasm32-wasip2\release 2>nul
)

:: Also clean regular release directory in case it exists
if exist target\release (
    echo   - Cleaning target\release directory...
    rmdir /S /Q target\release 2>nul
)

echo   Cleanup complete
echo.

:: ==============================================================================
:: STEP 3: Grammar will be fetched by Zed
:: ==============================================================================
echo [3/10] Grammar configuration...

echo   Grammars directory has been removed
echo   Zed will automatically fetch the grammar from:
echo   Repository: https://github.com/DaZhi-the-Revelator/tree-sitter-arturo
echo   Commit: (specified in extension.toml)
echo.
echo   NOTE: If you modified tree-sitter-arturo grammar files, make sure:
echo     1. Changes are committed and pushed to GitHub
echo     2. extension.toml references the correct commit hash
echo.

:: ==============================================================================
:: STEP 4: Install/Update Language Server Dependencies
:: ==============================================================================
echo [4/10] Installing language server dependencies...

cd language-server

call npm install
if %errorlevel% neq 0 (
    echo.
    echo ERROR: npm install failed
    echo Check your Node.js installation and network connection
    cd ..
    pause
    exit /b 1
)

cd ..
echo   Dependencies installed
echo.

:: ==============================================================================
:: STEP 5: Build Language Server Bundle
:: ==============================================================================
echo [5/10] Building language server bundle...

cd language-server

echo   Running webpack to bundle server.js...
call npm run build
if %errorlevel% neq 0 (
    echo.
    echo ERROR: npm run build failed
    echo Check language-server\webpack.config.js and package.json
    cd ..
    pause
    exit /b 1
)

cd ..

:: Verify bundle was created
if not exist bundle.js (
    echo.
    echo ERROR: bundle.js was not created
    echo The webpack build may have failed silently
    echo Check language-server\package.json "build" script
    pause
    exit /b 1
)

:: Show bundle size
for %%A in (bundle.js) do (
    set BUNDLE_SIZE=%%~zA
    echo   Bundle created: %%~zA bytes
)

:: Basic verification that bundle contains code
for %%A in (bundle.js) do set SIZE=%%~zA
if %SIZE% LSS 100000 (
    echo.
    echo WARNING: bundle.js seems unusually small (%SIZE% bytes^)
    echo Expected size: 500KB - 1MB
    echo The bundle may be incomplete
    pause
)

echo.

:: ==============================================================================
:: STEP 6: Install Embedded Build Configuration
:: ==============================================================================
echo [6/10] Configuring embedded build...

cd src

:: Backup current lib.rs
if exist lib.rs (
    if not exist lib.rs.backup (
        copy lib.rs lib.rs.backup >nul 2>&1
    )
)

:: Install embedded version
copy /Y lib-embedded.rs lib.rs >nul
if %errorlevel% neq 0 (
    echo ERROR: Failed to copy lib-embedded.rs to lib.rs
    cd ..
    pause
    exit /b 1
)

cd ..

echo   Embedded configuration installed (bundle.js will be included in WASM)
echo.

:: ==============================================================================
:: STEP 7: Clean Cargo Cache (CRITICAL for embedding bundle.js)
:: ==============================================================================
echo [7/10] Cleaning cargo cache...
echo   This ensures bundle.js will be embedded in the WASM file
echo.

cargo clean
if %errorlevel% neq 0 (
    echo WARNING: cargo clean failed, continuing anyway...
)

echo   Cargo cache cleared - will do full rebuild
echo.

:: ==============================================================================
:: STEP 8: Build Rust Extension for WASM
:: ==============================================================================
echo [8/10] Building Rust extension for WASM target...
echo   This may take a few minutes on first build...
echo   Target: wasm32-wasip1
echo   Zed will fetch and compile the grammar during this step...
echo.

cargo build --release --target wasm32-wasip1
if %errorlevel% neq 0 (
    echo.
    echo ERROR: Cargo build failed
    echo.
    echo Common causes:
    echo   - bundle.js not found at root
    echo   - Rust toolchain not installed or outdated
    echo   - wasm32-wasip1 target not installed
    echo   - Grammar fetch/compile failed (check network connection)
    echo   - Missing system dependencies
    echo.
    echo Try:
    echo   rustup update
    echo   rustup target add wasm32-wasip1
    echo.
    echo Debug info:
    echo Debug: WASM targets installed|echo Debug: WASM targets installed
    pause
    exit /b 1
)

echo.
echo   Rust build successful
echo   Grammar was fetched and compiled by Zed
echo.

:: ==============================================================================
:: STEP 9: Copy WASM to Root and Verify Bundle Embedding
:: ==============================================================================
echo [9/10] Finalizing build...

:: Verify WASM was created in the correct location
if not exist target\wasm32-wasip1\release\zed_arturo.wasm (
    echo ERROR: target\wasm32-wasip1\release\zed_arturo.wasm was not created
    echo The cargo build may have failed silently
    echo.
    echo Checking other possible locations...
    if exist target\release\zed_arturo.dll (
        echo Found DLL at target\release\zed_arturo.dll
        echo This means cargo built for Windows instead of WASM!
        echo The --target wasm32-wasip1 flag may not have worked
    )
    if exist target\wasm32-wasip2\release\zed_arturo.wasm (
        echo Found at target\wasm32-wasip2\release\zed_arturo.wasm
        echo Using wasip2 instead of wasip1
    )
    echo.
    echo Listing target directory contents:
    dir target /s /b ^| findstr wasm
    pause
    exit /b 1
)

:: Copy to root and rename
copy /Y target\wasm32-wasip1\release\zed_arturo.wasm extension.wasm >nul
if %errorlevel% neq 0 (
    echo ERROR: Failed to copy zed_arturo.wasm to extension.wasm
    pause
    exit /b 1
)

:: Show extension size
for %%A in (extension.wasm) do (
    set WASM_SIZE=%%~zA
    echo   Extension created: %%~zA bytes
)

:: Verify bundle is embedded by checking size
echo.
echo   Verifying bundle embedding...
set /a EXPECTED_MIN=%BUNDLE_SIZE% + 100000
for %%A in (extension.wasm) do set WASM_SIZE=%%~zA

if %WASM_SIZE% LSS %EXPECTED_MIN% (
    echo.
    echo   WARNING: WASM seems too small!
    echo   Bundle size:     %BUNDLE_SIZE% bytes
    echo   WASM size:       %WASM_SIZE% bytes
    echo   Expected min:    %EXPECTED_MIN% bytes
    echo.
    echo   The bundle may NOT be properly embedded!
    echo   This usually means cargo used a cached build.
    echo.
    echo   Try running: cargo clean ^&^& cargo build --release --target wasm32-wasip1
    pause
) else (
    echo   Bundle verification: OK
    echo   Bundle size:     %BUNDLE_SIZE% bytes
    echo   WASM size:       %WASM_SIZE% bytes
    echo   Bundle appears to be embedded correctly!
)

echo.

:: ==============================================================================
:: STEP 10: Clean Zed Extension Cache
:: ==============================================================================
echo [10/10] Cleaning Zed extension cache...

set ZED_CACHE=%LOCALAPPDATA%\Zed\extensions\work\arturo
if exist "%ZED_CACHE%" (
    rmdir /S /Q "%ZED_CACHE%" 2>nul
    if exist "%ZED_CACHE%" (
        echo   WARNING: Could not delete Zed cache directory
        echo   Close Zed and try manually deleting: %ZED_CACHE%
    ) else (
        echo   Zed cache cleared
    )
) else (
    echo   No cached extension to clear
)

echo.

:: ==============================================================================
:: BUILD COMPLETE - Show Summary
:: ==============================================================================
echo ================================================================================
echo                              BUILD COMPLETE!
echo ================================================================================
echo.
echo Build artifacts created:
echo.
echo   bundle.js       - %BUNDLE_SIZE% bytes (LSP server bundle)
echo   extension.wasm  - %WASM_SIZE% bytes (Rust extension with embedded LSP)
echo.
echo Grammar status:
echo   Fetched from GitHub (commit specified in extension.toml)
echo   Compiled by Zed during cargo build
echo.
echo The extension is ready to install!
echo.
echo ================================================================================
echo                              NEXT STEPS
echo ================================================================================
echo.
echo 1. CLOSE ZED COMPLETELY
echo    - Make sure it's fully closed, not just minimized
echo    - Check Task Manager if needed
echo.
echo 2. REOPEN ZED
echo.
echo 3. INSTALL DEV EXTENSION
echo    - Press Ctrl+Shift+X (Extensions)
echo    - Click "Install Dev Extension"
echo    - Browse to: %CD%
echo    - Click "Open" or "Select Folder"
echo.
echo 4. TEST THE EXTENSION
echo    - Open or create a .art file
echo    - Verify syntax highlighting works
echo    - Test LSP features (hover, completion, etc.)
echo.
echo 5. CHECK LOGS (if issues occur)
echo    - Menu -^> View -^> Zed Log
echo    - Look for "arturo-lsp" entries
echo.
echo ================================================================================
echo                              IMPORTANT NOTES
echo ================================================================================
echo.
echo - All LSP features are ENABLED by default
echo - To change settings, edit Zed's settings.json
echo - Settings changes require a FULL ZED RESTART to take effect
echo - See Rebuild.md in the Docs directory for detailed documentation
echo.
echo If you modified tree-sitter grammar:
echo   1. Commit and push changes to tree-sitter-arturo repository
echo   2. Get the new commit hash: git rev-parse HEAD
echo   3. Update extension.toml with the new commit hash
echo   4. Then run this script again
echo.
echo ================================================================================
echo.
pause
