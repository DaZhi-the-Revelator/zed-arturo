@echo off
:: install.bat — Build and install the Arturo Jupyter kernel on Windows
setlocal

echo [arturo-kernel] Building release binary...
cargo build --release
if errorlevel 1 (
    echo [arturo-kernel] Build failed.
    exit /b 1
)

:: Copy binary to %USERPROFILE%\.cargo\bin (already on PATH for Rust users)
echo [arturo-kernel] Installing binary to %USERPROFILE%\.cargo\bin\arturo-kernel.exe
copy /Y "target\release\arturo-kernel.exe" "%USERPROFILE%\.cargo\bin\arturo-kernel.exe"
if errorlevel 1 (
    echo [arturo-kernel] Failed to copy binary.
    echo Make sure %%USERPROFILE%%\.cargo\bin is on your PATH.
    exit /b 1
)

:: Install kernelspec
set KERNELSPEC_DIR=%APPDATA%\jupyter\kernels\arturo
echo [arturo-kernel] Installing kernelspec to %KERNELSPEC_DIR%
if not exist "%KERNELSPEC_DIR%" mkdir "%KERNELSPEC_DIR%"
copy /Y "kernelspec\kernel.json" "%KERNELSPEC_DIR%\kernel.json"

echo.
echo [arturo-kernel] Installation complete!
echo.
echo To verify, run:
echo   jupyter kernelspec list
echo.
echo Then in Zed, open a .art file and press Ctrl+Shift+Enter.
echo Run "repl: refresh kernelspecs" in Zed command palette if Arturo does not appear.
