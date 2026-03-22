@echo off
setlocal enabledelayedexpansion

:: -- MCP Servers - Installer (Windows) -----------------------
:: Installs: orchestrator, image-gen, unity-mcp
:: Target:   %USERPROFILE%\.mcp-servers\<name>\

set SCRIPT_DIR=%~dp0
set MCP_HOME=%USERPROFILE%\.mcp-servers

echo.
echo ===================================================
echo      MCP Servers - Installer [Windows]
echo ===================================================
echo.

if not "%~1"=="" (
    if /i "%~1"=="--help" goto :help
    if /i "%~1"=="-h" goto :help
    echo [error] Unexpected argument: %~1
    echo [error] Unity project installation moved into the unity_install_package MCP tool.
    exit /b 1
)

echo [info]  Checking prerequisites...

where node >nul 2>&1
if errorlevel 1 (
    echo [error] Node.js is not installed. Install from https://nodejs.org
    exit /b 1
)
for /f "tokens=1 delims=v" %%V in ('node -v') do set NODE_VER=%%V
for /f "tokens=2 delims=v" %%A in ('node -v') do (
    for /f "tokens=1 delims=." %%B in ("%%A") do set NODE_MAJOR=%%B
)
if !NODE_MAJOR! LSS 18 (
    echo [error] Node.js 18+ required. Found: !NODE_VER!
    exit /b 1
)
echo [ok]    Node.js

where npm >nul 2>&1
if errorlevel 1 (
    echo [error] npm is not installed
    exit /b 1
)
echo [ok]    npm

set ORCH_SRC=%SCRIPT_DIR%orchestrator
set ORCH_DST=%MCP_HOME%\orchestrator
if not exist "%ORCH_SRC%\" (
    echo [warn]  Orchestrator source not found - skipping
    goto :install_imagegen
)
set ORCH_SKIP_SYNC=
if exist "%ORCH_DST%" (
    for /f "delims=" %%I in ('powershell -NoProfile -Command "$src = (Resolve-Path -LiteralPath '%ORCH_SRC%').ProviderPath.TrimEnd('\\'); $dstPath = '%ORCH_DST%'; if (Test-Path -LiteralPath $dstPath) { $dst = (Resolve-Path -LiteralPath $dstPath).ProviderPath.TrimEnd('\\'); if ($src.ToLowerInvariant() -eq $dst.ToLowerInvariant()) { 'same' } }"') do set ORCH_SKIP_SYNC=%%I
)
echo [info]  Installing orchestrator to %ORCH_DST% ...
if /i "!ORCH_SKIP_SYNC!"=="same" (
    echo [info]  orchestrator target already resolves to source - skipping file sync
) else (
    if not exist "%ORCH_DST%" mkdir "%ORCH_DST%"
    robocopy "%ORCH_SRC%" "%ORCH_DST%" /MIR /XD node_modules dist /XF package-lock.json /NFL /NDL /NJH /NJS /NC /NS >nul 2>&1
)
pushd "%ORCH_DST%"
echo [info]  Installing npm dependencies...
call npm install --silent >nul 2>&1
popd
echo [ok]    orchestrator installed

:install_imagegen

set IMGGEN_SRC=%SCRIPT_DIR%image-gen
set IMGGEN_DST=%MCP_HOME%\image-gen
if not exist "%IMGGEN_SRC%\" (
    echo [warn]  image-gen source not found - skipping
    goto :install_unitymcp
)
set IMGGEN_SKIP_SYNC=
if exist "%IMGGEN_DST%" (
    for /f "delims=" %%I in ('powershell -NoProfile -Command "$src = (Resolve-Path -LiteralPath '%IMGGEN_SRC%').ProviderPath.TrimEnd('\\'); $dstPath = '%IMGGEN_DST%'; if (Test-Path -LiteralPath $dstPath) { $dst = (Resolve-Path -LiteralPath $dstPath).ProviderPath.TrimEnd('\\'); if ($src.ToLowerInvariant() -eq $dst.ToLowerInvariant()) { 'same' } }"') do set IMGGEN_SKIP_SYNC=%%I
)
echo [info]  Installing image-gen to %IMGGEN_DST% ...
if /i "!IMGGEN_SKIP_SYNC!"=="same" (
    echo [info]  image-gen target already resolves to source - skipping file sync
) else (
    if not exist "%IMGGEN_DST%" mkdir "%IMGGEN_DST%"
    robocopy "%IMGGEN_SRC%" "%IMGGEN_DST%" /MIR /XD node_modules dist /XF package-lock.json /NFL /NDL /NJH /NJS /NC /NS >nul 2>&1
)
pushd "%IMGGEN_DST%"
echo [info]  Installing npm dependencies...
call npm install --silent >nul 2>&1
popd
echo [ok]    image-gen installed

:install_unitymcp

set UNITY_SRC=%SCRIPT_DIR%unity-mcp
set UNITY_DST=%MCP_HOME%\unity-mcp
if not exist "%UNITY_SRC%\" (
    echo [warn]  unity-mcp source not found - skipping
    goto :summary
)
set UNITY_SKIP_SYNC=
if exist "%UNITY_DST%" (
    for /f "delims=" %%I in ('powershell -NoProfile -Command "$src = (Resolve-Path -LiteralPath '%UNITY_SRC%').ProviderPath.TrimEnd('\\'); $dstPath = '%UNITY_DST%'; if (Test-Path -LiteralPath $dstPath) { $dst = (Resolve-Path -LiteralPath $dstPath).ProviderPath.TrimEnd('\\'); if ($src.ToLowerInvariant() -eq $dst.ToLowerInvariant()) { 'same' } }"') do set UNITY_SKIP_SYNC=%%I
)
echo [info]  Installing unity-mcp to %UNITY_DST% ...
if /i "!UNITY_SKIP_SYNC!"=="same" (
    echo [info]  unity-mcp target already resolves to source - skipping file sync
) else (
    if not exist "%UNITY_DST%" mkdir "%UNITY_DST%"
    robocopy "%UNITY_SRC%" "%UNITY_DST%" /MIR /XD node_modules dist /XF package-lock.json /NFL /NDL /NJH /NJS /NC /NS >nul 2>&1
)
pushd "%UNITY_DST%"
echo [info]  Installing npm dependencies...
call npm install --silent >nul 2>&1
popd
echo [ok]    unity-mcp installed

:summary

echo.
echo ===================================================
echo   Installation complete!
echo ===================================================
echo.
echo   Installed:
echo     Orchestrator: %MCP_HOME%\orchestrator
echo     Image Gen:    %MCP_HOME%\image-gen
echo     Unity MCP:    %MCP_HOME%\unity-mcp
echo.
echo   Next steps:
echo     1. Add MCP servers to your VS Code mcp.json (see INSTALL.md)
echo     2. For image-gen: set OPENAI_API_KEY and/or GEMINI_API_KEY, or LOCAL_SD_URL for local generation
echo     3. For Unity projects: call unity_get_status and unity_install_package from the unity-mcp server
echo.

endlocal
exit /b 0

:help
echo Usage: install.bat
echo.
echo Installs all MCP servers to %%USERPROFILE%%\.mcp-servers\.
echo Unity project installation now happens through the unity_get_status and unity_install_package MCP tools.
endlocal
exit /b 0
