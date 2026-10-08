@echo off
rem Starts Firefox with the tilefox-spike profile. -no-remote lets it run next to your normal Firefox.
rem -purgecaches drops the startup cache so freshly copied tilefox scripts always load.
set "FF=%ProgramFiles%\Mozilla Firefox\firefox.exe"
if not exist "%FF%" set "FF=%ProgramFiles(x86)%\Mozilla Firefox\firefox.exe"
if not exist "%FF%" (
  echo Could not find firefox.exe. Edit FF in this file.
  pause
  exit /b 1
)
start "" "%FF%" -P tilefox-spike -no-remote -purgecaches
