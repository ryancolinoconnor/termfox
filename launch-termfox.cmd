@echo off
rem Starts Firefox with the termfox profile. -no-remote lets it run next to your normal Firefox.
rem -purgecaches drops the startup cache so freshly copied termfox scripts always load.
rem Installs made before the rename (2026-10-08) use the profile "tilefox-spike"; that one is used
rem when there is no "termfox" profile.
rem Uses the Firefox that has the termfox loader (config.js): per-machine (Program Files) or per-user
rem (%LOCALAPPDATA%\Mozilla Firefox, the no-admin install). Installed with -FirefoxDir elsewhere? Edit FF.
set "FF="
for %%D in ("%ProgramFiles%\Mozilla Firefox" "%ProgramFiles(x86)%\Mozilla Firefox" "%LOCALAPPDATA%\Mozilla Firefox") do (
  if not defined FF if exist "%%~D\config.js" if exist "%%~D\firefox.exe" set "FF=%%~D\firefox.exe"
)
for %%D in ("%ProgramFiles%\Mozilla Firefox" "%ProgramFiles(x86)%\Mozilla Firefox" "%LOCALAPPDATA%\Mozilla Firefox") do (
  if not defined FF if exist "%%~D\firefox.exe" set "FF=%%~D\firefox.exe"
)
if not defined FF (
  echo Could not find firefox.exe. Edit FF in this file.
  pause
  exit /b 1
)
set "PROFILES=%APPDATA%\Mozilla\Firefox\Profiles"
set "PROFILE="
if exist "%PROFILES%\termfox\" set "PROFILE=termfox"
if not defined PROFILE if exist "%PROFILES%\tilefox-spike\" set "PROFILE=tilefox-spike"
if not defined PROFILE (
  echo No termfox profile found in %PROFILES%. Run install.ps1 first.
  pause
  exit /b 1
)
start "" "%FF%" -P %PROFILE% -no-remote -purgecaches
