@echo off
echo ============================================
echo Building with EMBEDDED bundle.js
echo ============================================
echo.

echo [1/5] Building language server bundle...
cd language-server
call npm install
call npm run build
if %errorlevel% neq 0 (
    echo ERROR: npm build failed
    pause
    exit /b 1
)
cd ..
echo Γ£ô Bundle created at root: bundle.js
echo.

echo [2/5] Verifying bundle exists...
if not exist "bundle.js" (
    echo ERROR: bundle.js not created!
    pause
    exit /b 1
)
for %%A in (bundle.js) do echo   Size: %%~zA bytes
echo Γ£ô Bundle verified
echo.

echo [3/5] Installing embedded lib.rs...
cd src
if exist lib.rs.backup del lib.rs.backup
copy lib.rs lib.rs.backup
copy lib-embedded.rs lib.rs
cd ..
echo Γ£ô Embedded version installed
echo.

echo [4/5] Building extension (bundle.js will be embedded)...
cargo build --release
if %errorlevel% neq 0 (
    echo ERROR: Cargo build failed
    echo.
    echo NOTE: If you get an error about bundle.js not found,
    echo make sure bundle.js exists in the root directory.
    pause
    exit /b 1
)
echo Γ£ô Extension built with embedded bundle!
echo.

echo [5/5] Cleaning up...
set ZED_EXT=C:\Users\virgil\AppData\Local\Zed\extensions\work\arturo
if exist "%ZED_EXT%" (
    rmdir /s /q "%ZED_EXT%"
    echo Γ£ô Old Zed installation removed
) else (
    echo Γ£ô No old installation to remove
)
echo.

echo ============================================
echo Build Complete!
echo ============================================
echo.
echo The language server bundle is now EMBEDDED in extension.wasm
echo This means:
echo   Γ£ô No need to copy bundle.js manually
echo   Γ£ô Works immediately after installing in Zed
echo   Γ£ô Bundle is extracted to temp directory at runtime
echo.
echo Extension size:
for %%A in (extension.wasm) do echo   %%~zA bytes
echo.
echo Next steps:
echo   1. Close Zed completely
echo   2. Reopen Zed
echo   3. Ctrl+Shift+P ΓåÆ zed: install dev extension
echo   4. Browse to: %CD%
echo   5. Install and test!
echo.
echo No manual copying needed! Everything is self-contained.
echo.
pause