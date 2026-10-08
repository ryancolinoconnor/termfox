<#
.SYNOPSIS
  termfox day-1 spike installer (Windows, Firefox Release).

.DESCRIPTION
  1. Finds your Firefox Release install folder.
  2. Downloads fx-autoconfig at a PINNED commit and checks the SHA-256 of every file.
  3. Asks for admin (UAC) ONLY to copy two files into the Firefox program folder:
       <Firefox>\config.js
       <Firefox>\defaults\pref\config-prefs.js
  4. Creates a NEW profile "termfox" (firefox.exe -CreateProfile) and puts the
     loader files + termfox scripts in that profile's chrome\ folder.
  5. Writes a manifest so uninstall.ps1 removes exactly what was added.

  It never touches any other profile. Close ALL Firefox windows first.

  Note: the two program-folder files are read by every profile of this Firefox install,
  but config.js does nothing unless a profile has chrome\utils\chrome.manifest, which
  only the termfox profile has.
  fx-autoconfig: https://github.com/MrOtherGuy/fx-autoconfig#install

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1
#>
[CmdletBinding()]
param(
    [string]$FirefoxDir = "",
    [string]$ProfileName = "termfox",
    [switch]$Force,
    # Internal: used by the elevated child process. Do not pass by hand.
    [switch]$ElevatedProgramCopy,
    [string]$StagingDir = "",
    [string]$ResultFile = ""
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------- pinned loader
$FxacCommit = "dfdab5684faffc112b76ccb1d8cab7f75da0102c"   # fx-autoconfig master, 2026-07-23, loader 0.10.16
$FxacBase   = "https://raw.githubusercontent.com/MrOtherGuy/fx-autoconfig/$FxacCommit"
$ProgramFiles = @(
    @{ Src = "program/config.js";                    Dst = "config.js";                     Sha = "80dc421264a3ea04275e1724b7b57234f89254e9582a6c17e9a911b65c3aa6d7" },
    @{ Src = "program/defaults/pref/config-prefs.js"; Dst = "defaults\pref\config-prefs.js"; Sha = "6bfd2ed139d18ff5178e0fc62a3b4058540ddbeba3adc912c0d69edb70c17ece" }
)
$ProfileLoaderFiles = @(
    @{ Src = "profile/chrome/utils/boot.sys.mjs";    Dst = "chrome\utils\boot.sys.mjs";    Sha = "1f0b37d765c7b10b963a465a62a420059e334a18b6b48bd8c09059837e676106" },
    @{ Src = "profile/chrome/utils/chrome.manifest"; Dst = "chrome\utils\chrome.manifest"; Sha = "d80557b7bdd46f91f0d249f25f1bf66ed83f8c9e620cd0c9334029e4826924d0" },
    @{ Src = "profile/chrome/utils/fs.sys.mjs";      Dst = "chrome\utils\fs.sys.mjs";      Sha = "1d6302c5484dc914e43685740937f1d89908099f835e53f532338822c31b08af" },
    @{ Src = "profile/chrome/utils/module_loader.mjs"; Dst = "chrome\utils\module_loader.mjs"; Sha = "e7fca8757159751df080e5cbfcd27b508d98c5cdfd6434ea14247832418d1f63" },
    @{ Src = "profile/chrome/utils/uc_api.sys.mjs";  Dst = "chrome\utils\uc_api.sys.mjs";  Sha = "dc7547aecbaac67da94b54e353f8e306a0ca01b2a461e106cc88c63a2e210cac" },
    @{ Src = "profile/chrome/utils/utils.sys.mjs";   Dst = "chrome\utils\utils.sys.mjs";   Sha = "3fb7c9799864ee01428722939f324acea1e6065cb63a9298e7bbc59e5adbd96a" }
)

$ScriptRoot  = Split-Path -Parent $MyInvocation.MyCommand.Path
$ManifestDir = Join-Path $env:LOCALAPPDATA "termfox"
$ManifestPath = Join-Path $ManifestDir "install-manifest.json"
# Installs made before the rename (2026-10-08) kept their manifest here (profile "tilefox-spike").
$LegacyManifestPath = Join-Path $env:LOCALAPPDATA "tilefox\install-manifest.json"

function Write-Step([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Wrote([string]$path) { Write-Host "    wrote  $path" -ForegroundColor Green }
function Fail([string]$msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

function Test-IsAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-Sha256([string]$path) { return (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant() }

# ================================================================ elevated child
# Runs as admin. Copies ONLY the two program files from the verified staging dir.
if ($ElevatedProgramCopy) {
    $written = @()
    try {
        foreach ($f in $ProgramFiles) {
            $src = Join-Path $StagingDir $f.Dst
            $dst = Join-Path $FirefoxDir $f.Dst
            if ((Get-Sha256 $src) -ne $f.Sha) { throw "staging file hash changed: $src" }
            if (Test-Path -LiteralPath $dst) {
                if ((Get-Sha256 $dst) -eq $f.Sha) {
                    Write-Host "    exists (identical, left as is)  $dst"
                    $written += @{ Path = $dst; Sha = $f.Sha; Created = $false }
                    continue
                }
                throw "$dst already exists with different content (another autoconfig?). Not overwriting."
            }
            $dir = Split-Path -Parent $dst
            $createdDir = $false
            if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null; $createdDir = $true }
            Copy-Item -LiteralPath $src -Destination $dst
            Write-Wrote $dst
            $written += @{ Path = $dst; Sha = $f.Sha; Created = $true; CreatedDir = $createdDir }
        }
        @{ ok = $true; files = $written } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ResultFile -Encoding UTF8
        exit 0
    } catch {
        @{ ok = $false; error = "$_"; files = $written } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ResultFile -Encoding UTF8
        Write-Host "ERROR: $_" -ForegroundColor Red
        Start-Sleep -Seconds 5
        exit 1
    }
}

# ================================================================ main (runs as you)
Write-Host ""
Write-Host "termfox spike installer" -ForegroundColor White
Write-Host "  fx-autoconfig pinned at $FxacCommit"
Write-Host ""

if (Test-IsAdmin) {
    Write-Host "WARNING: this window is already elevated. The new profile will be created for the" -ForegroundColor Yellow
    Write-Host "         elevated user ($env:USERNAME). Prefer a normal PowerShell window." -ForegroundColor Yellow
}

foreach ($mp in @($ManifestPath, $LegacyManifestPath)) {
    if (Test-Path -LiteralPath $mp) {
        Fail "Already installed (manifest at $mp). Run uninstall.ps1 first, or see README 'Updating the scripts'."
    }
}

# ---------------------------------------------------------------- Firefox must be closed
if (Get-Process -Name firefox -ErrorAction SilentlyContinue) {
    Fail "Firefox is running. Close ALL Firefox windows (check the tray) and run again."
}

# ---------------------------------------------------------------- find Firefox Release
Write-Step "Finding Firefox Release"
function Find-FirefoxDir {
    $candidates = @()
    foreach ($root in @("HKLM:\SOFTWARE\Mozilla\Mozilla Firefox", "HKLM:\SOFTWARE\WOW6432Node\Mozilla\Mozilla Firefox", "HKCU:\SOFTWARE\Mozilla\Mozilla Firefox")) {
        try {
            $cur = (Get-ItemProperty -LiteralPath $root -ErrorAction Stop).CurrentVersion
            if ($cur) {
                $main = Get-ItemProperty -LiteralPath "$root\$cur\Main" -ErrorAction Stop
                if ($main.'Install Directory') { $candidates += $main.'Install Directory' }
            }
        } catch { }
    }
    try {
        $ap = (Get-ItemProperty -LiteralPath "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\firefox.exe" -ErrorAction Stop).'(default)'
        if ($ap) { $candidates += (Split-Path -Parent $ap.Trim('"')) }
    } catch { }
    $candidates += "$env:ProgramFiles\Mozilla Firefox"
    foreach ($c in $candidates) {
        if ($c -and (Test-Path -LiteralPath (Join-Path $c "firefox.exe"))) { return (Resolve-Path -LiteralPath $c).Path }
    }
    return $null
}
if (-not $FirefoxDir) { $FirefoxDir = Find-FirefoxDir }
if (-not $FirefoxDir -or -not (Test-Path -LiteralPath (Join-Path $FirefoxDir "firefox.exe"))) {
    Fail "Could not find firefox.exe. Pass it explicitly: -FirefoxDir 'C:\Program Files\Mozilla Firefox'"
}
if ($FirefoxDir -like "*\WindowsApps\*") {
    Fail "This is the Microsoft Store (MSIX) Firefox; its program folder is read-only. Install Firefox from mozilla.org."
}
$FirefoxExe = Join-Path $FirefoxDir "firefox.exe"
$channel = "unknown"
$channelFile = Join-Path $FirefoxDir "defaults\pref\channel-prefs.js"
if (Test-Path -LiteralPath $channelFile) {
    $m = Select-String -LiteralPath $channelFile -Pattern 'app\.update\.channel",\s*"([^"]+)"' | Select-Object -First 1
    if ($m) { $channel = $m.Matches[0].Groups[1].Value }
}
$version = (Get-Item -LiteralPath $FirefoxExe).VersionInfo.ProductVersion
Write-Host "    Firefox: $FirefoxDir"
Write-Host "    version: $version   channel: $channel"
if ($channel -ne "release" -and -not $Force) {
    Fail "Expected the 'release' channel, found '$channel'. Re-run with -Force if this is intended."
}

# Refuse to clobber an existing autoconfig (e.g. an enterprise or other mod setup).
$existingCfg = Join-Path $FirefoxDir "config.js"
if ((Test-Path -LiteralPath $existingCfg) -and ((Get-Sha256 $existingCfg) -ne $ProgramFiles[0].Sha)) {
    Fail "$existingCfg already exists and is not fx-autoconfig $FxacCommit. Not touching it."
}
Get-ChildItem -LiteralPath (Join-Path $FirefoxDir "defaults\pref") -Filter *.js -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.Name -ne "channel-prefs.js" -and $_.Name -ne "config-prefs.js" -and (Select-String -LiteralPath $_.FullName -Pattern "general\.config\.filename" -Quiet)) {
        Fail "$($_.FullName) already sets general.config.filename (another autoconfig). Not touching it."
    }
}

# ---------------------------------------------------------------- download + verify
Write-Step "Downloading fx-autoconfig ($FxacCommit) and checking SHA-256"
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$Staging = Join-Path $env:TEMP ("termfox-install-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $Staging | Out-Null
foreach ($f in ($ProgramFiles + $ProfileLoaderFiles)) {
    $out = Join-Path $Staging $f.Dst
    $dir = Split-Path -Parent $out
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    Invoke-WebRequest -UseBasicParsing -Uri "$FxacBase/$($f.Src)" -OutFile $out
    $h = Get-Sha256 $out
    if ($h -ne $f.Sha) { Fail "SHA-256 mismatch for $($f.Src): got $h, expected $($f.Sha)" }
    Write-Host "    ok  $($f.Src)"
}

# Our own scripts ship next to this installer.
$OurChrome = Join-Path $ScriptRoot "profile\chrome"
foreach ($p in @("JS\termfox.uc.mjs", "JS\termfox_actor.sys.mjs", "JS\termfox\TermfoxChild.sys.mjs", "JS\termfox\TermfoxParent.sys.mjs", "CSS\termfox.uc.css")) {
    if (-not (Test-Path -LiteralPath (Join-Path $OurChrome $p))) { Fail "Missing $OurChrome\$p (run install.ps1 from the termfox folder)." }
}

# ---------------------------------------------------------------- profile path checks (before any write)
$ProfilesRoot = Join-Path $env:APPDATA "Mozilla\Firefox"
$ProfilesIni  = Join-Path $ProfilesRoot "profiles.ini"
$ProfileDir   = Join-Path $ProfilesRoot "Profiles\$ProfileName"
if (Test-Path -LiteralPath $ProfileDir) { Fail "$ProfileDir already exists. Not touching it." }
if ((Test-Path -LiteralPath $ProfilesIni) -and (Select-String -LiteralPath $ProfilesIni -Pattern "^Name=$([regex]::Escape($ProfileName))\s*$" -Quiet)) {
    Fail "A profile named '$ProfileName' already exists in $ProfilesIni. Not touching it."
}

# ---------------------------------------------------------------- elevated: program folder
Write-Step "Admin step: copy 2 files into the Firefox program folder"
Write-Host "    These files will be written (UAC prompt next):"
foreach ($f in $ProgramFiles) { Write-Host "      $(Join-Path $FirefoxDir $f.Dst)" }
$resultFile = Join-Path $Staging "elevated-result.json"
$argList = @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$($MyInvocation.MyCommand.Path)`"",
    "-ElevatedProgramCopy", "-FirefoxDir", "`"$FirefoxDir`"", "-StagingDir", "`"$Staging`"", "-ResultFile", "`"$resultFile`""
)
try {
    $proc = Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList $argList -Wait -PassThru
} catch {
    Fail "Admin prompt was cancelled. Nothing was installed."
}
if (-not (Test-Path -LiteralPath $resultFile)) { Fail "Admin step produced no result (exit $($proc.ExitCode)). Nothing else was changed." }
$elev = Get-Content -LiteralPath $resultFile -Raw | ConvertFrom-Json
foreach ($w in $elev.files) { if ($w.Created) { Write-Wrote $w.Path } else { Write-Host "    exists (identical)  $($w.Path)" } }
if (-not $elev.ok) { Fail "Admin step failed: $($elev.error). Files listed above (if any) were written; run uninstall.ps1 after fixing." }

# Manifest is written as soon as anything exists, so uninstall can always clean up.
New-Item -ItemType Directory -Path $ManifestDir -Force | Out-Null
$manifest = [ordered]@{
    tool = "termfox"; installedAt = (Get-Date).ToString("s"); fxacCommit = $FxacCommit
    firefoxDir = $FirefoxDir; firefoxVersion = $version
    programFiles = @($elev.files); profileName = $ProfileName; profileDir = $ProfileDir
    profileLocalDir = (Join-Path $env:LOCALAPPDATA "Mozilla\Firefox\Profiles\$ProfileName")
    profileCreated = $false
}
function Save-Manifest { $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $ManifestPath -Encoding UTF8 }
Save-Manifest
Write-Wrote $ManifestPath

# ---------------------------------------------------------------- create the profile
Write-Step "Creating NEW profile '$ProfileName'"
$iniBackup = $null
if (Test-Path -LiteralPath $ProfilesIni) {
    $iniBackup = Join-Path $ManifestDir ("profiles.ini.before-install." + (Get-Date -Format "yyyyMMdd-HHmmss"))
    Copy-Item -LiteralPath $ProfilesIni -Destination $iniBackup
    Write-Host "    backup of profiles.ini: $iniBackup"
}
# firefox -CreateProfile "<name> <path>" creates the profile and exits without opening a window.
# https://wiki.mozilla.org/Firefox/CommandLineOptions#-CreateProfile_.22profile_name_profile_dir.22
$p = Start-Process -FilePath $FirefoxExe -ArgumentList @("-CreateProfile", "`"$ProfileName $ProfileDir`"") -Wait -PassThru
if (-not (Test-Path -LiteralPath $ProfileDir)) { Fail "firefox -CreateProfile did not create $ProfileDir (exit $($p.ExitCode))." }
$manifest.profileCreated = $true
$manifest.profilesIniBackup = $iniBackup
Save-Manifest
Write-Wrote "$ProfileDir  (new profile; registered in $ProfilesIni)"

# ---------------------------------------------------------------- profile files
Write-Step "Copying loader + termfox scripts into the new profile only"
$profileFiles = @()
foreach ($f in $ProfileLoaderFiles) {
    $dst = Join-Path $ProfileDir $f.Dst
    New-Item -ItemType Directory -Path (Split-Path -Parent $dst) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $Staging $f.Dst) -Destination $dst
    $profileFiles += $dst; Write-Wrote $dst
}
Get-ChildItem -LiteralPath $OurChrome -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($OurChrome.Length).TrimStart('\')
    $dst = Join-Path (Join-Path $ProfileDir "chrome") $rel
    New-Item -ItemType Directory -Path (Split-Path -Parent $dst) -Force | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $dst
    $profileFiles += $dst; Write-Wrote $dst
}
# user.js applies only to this profile.
$userJs = Join-Path $ProfileDir "user.js"
@(
    '// termfox spike profile prefs (this profile only)',
    'user_pref("termfox.enabled", true);',
    '// Lets the Browser Console (Ctrl+Shift+J) evaluate chrome JS while debugging the spike.',
    'user_pref("devtools.chrome.enabled", true);'
    # DRM prefs deliberately left at Firefox defaults so the DRM test is honest.
) | Set-Content -LiteralPath $userJs -Encoding ASCII
$profileFiles += $userJs; Write-Wrote $userJs
$manifest.profileFiles = $profileFiles
Save-Manifest

Remove-Item -LiteralPath $Staging -Recurse -Force

Write-Host ""
Write-Host "Installed. Start the spike profile with:" -ForegroundColor White
Write-Host "  & `"$FirefoxExe`" -P $ProfileName -no-remote"
Write-Host "or double-click launch-termfox.cmd in this folder."
Write-Host "Your normal Firefox profile is unchanged and still opens as usual."
exit 0
