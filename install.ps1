<#
.SYNOPSIS
  termfox day-1 spike installer (Windows, Firefox Release).

.DESCRIPTION
  1. Finds your Firefox Release install folder.
  2. Downloads fx-autoconfig at a PINNED commit and checks the SHA-256 of every file.
  3. Asks for admin (UAC) ONLY to write two files into the Firefox program folder:
       <Firefox>\config.js
       <Firefox>\defaults\pref\config-prefs.js
  4. Creates a NEW profile "termfox" (firefox.exe -CreateProfile) and puts the
     loader files + termfox scripts in that profile's chrome\ folder.
  5. Writes a manifest so uninstall.ps1 removes exactly what was added.

  It never touches any other profile. Close ALL Firefox windows first.

  TRUST MODEL (read SECURITY.md): the two program-folder files turn on a privileged script loader
  for EVERY profile of this Firefox install. It runs code only from a profile that has
  chrome\utils\chrome.manifest (only the termfox profile, unless something else adds one), and that
  code has full browser privileges. If you want the loader confined, install a separate copy of
  Firefox under Program Files just for termfox and pass it with -FirefoxDir.
  fx-autoconfig: https://github.com/MrOtherGuy/fx-autoconfig#install

  Safety (security audit M4/L1, 2026-10-08): the admin step checks the Firefox folder itself (under
  Program Files, firefox.exe, no junctions), reads each staged file into memory, checks its SHA-256
  against the hash hard-coded here, and writes exactly those bytes to a NEW file (never replacing
  one). The manifest is written as a journal BEFORE the admin step, and a half-done admin step
  rolls back what it wrote.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1
#>
[CmdletBinding()]
param(
    [string]$FirefoxDir = "",
    [string]$ProfileName = "termfox",
    [switch]$Force,
    # Internal: used by the elevated child process. Checked, never trusted.
    [switch]$ElevatedProgramCopy,
    [string]$StagingDir = "",
    [string]$ResultFile = ""
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------- shared safety helpers
# (same block in install.ps1 and uninstall.ps1; each script must run on its own)
#
# The two program-folder files termfox ever writes, and the only bytes it accepts for them
# (fx-autoconfig dfdab5684faffc112b76ccb1d8cab7f75da0102c). The elevated steps use these
# constants and never take a path or a hash from the manifest or the command line.
$ProgramTargets = @(
    @{ Key = "configJs";    Rel = "config.js";                     Src = "program/config.js";                     Sha = "80dc421264a3ea04275e1724b7b57234f89254e9582a6c17e9a911b65c3aa6d7" },
    @{ Key = "configPrefs"; Rel = "defaults\pref\config-prefs.js"; Src = "program/defaults/pref/config-prefs.js"; Sha = "6bfd2ed139d18ff5178e0fc62a3b4058540ddbeba3adc912c0d69edb70c17ece" }
)

function Get-Sha256([string]$path) { return (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant() }
function Get-BytesSha256([byte[]]$bytes) {
    $h = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($h.ComputeHash($bytes)) -replace '-', '').ToLowerInvariant() } finally { $h.Dispose() }
}
function Get-FullPath([string]$p) { return [IO.Path]::GetFullPath($p).TrimEnd('\') }
# Is $path strictly inside $root (after canonicalizing both)?
function Test-Under([string]$root, [string]$path) {
    return (Get-FullPath $path).StartsWith((Get-FullPath $root) + '\', [StringComparison]::OrdinalIgnoreCase)
}
function Test-ReparsePoint([string]$path) {
    $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    return [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
}
# $path and every existing folder between it and $root (inclusive) must be plain: no junction or symlink.
function Assert-NoReparse([string]$root, [string]$path) {
    $rootFull = Get-FullPath $root
    $p = Get-FullPath $path
    if (($p -ine $rootFull) -and -not (Test-Under $rootFull $p)) { throw "path escapes ${rootFull}: $p" }
    while ($true) {
        if ((Test-Path -LiteralPath $p) -and (Test-ReparsePoint $p)) { throw "refusing junction/symlink: $p" }
        if ($p -ieq $rootFull) { break }
        $p = Get-FullPath (Split-Path -Parent $p)
    }
}
# Admin-only folders a Firefox install may live in.
function Get-ProtectedRoots {
    $roots = @()
    foreach ($v in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramW6432)) { if ($v) { $roots += (Get-FullPath $v) } }
    return @($roots | Select-Object -Unique)
}
# HKLM only: HKCU can be changed by any program running as you.
function Get-RegisteredFirefoxDirs {
    $out = @()
    foreach ($root in @("HKLM:\SOFTWARE\Mozilla\Mozilla Firefox", "HKLM:\SOFTWARE\WOW6432Node\Mozilla\Mozilla Firefox")) {
        try {
            $cur = (Get-ItemProperty -LiteralPath $root -ErrorAction Stop).CurrentVersion
            if ($cur) {
                $main = Get-ItemProperty -LiteralPath "$root\$cur\Main" -ErrorAction Stop
                if ($main.'Install Directory') { $out += $main.'Install Directory' }
            }
        } catch { }
    }
    try {
        $ap = (Get-ItemProperty -LiteralPath "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\firefox.exe" -ErrorAction Stop).'(default)'
        if ($ap) { $out += (Split-Path -Parent $ap.Trim('"')) }
    } catch { }
    if ($env:ProgramFiles) { $out += (Join-Path $env:ProgramFiles "Mozilla Firefox") }
    return $out
}
# A Firefox folder the elevated step may touch: under Program Files (admin-only), no junction or
# symlink on the way down, firefox.exe present.
function Test-TrustedFirefoxDir([string]$dir) {
    if (-not $dir) { return $false }
    try {
        $full = Get-FullPath $dir
        $root = Get-ProtectedRoots | Where-Object { Test-Under $_ $full } | Select-Object -First 1
        if (-not $root) { return $false }
        if (-not (Test-Path -LiteralPath (Join-Path $full "firefox.exe") -PathType Leaf)) { return $false }
        Assert-NoReparse $root $full
        return $true
    } catch { return $false }
}
# The elevated step's own answer to "which Firefox": the hint only if it passes the checks above
# (an invalid hint is an error, never silently replaced), else the registered install.
function Resolve-TrustedFirefoxDir([string]$hint) {
    if ($hint) {
        if (Test-TrustedFirefoxDir $hint) { return (Get-FullPath $hint) }
        throw "not a trusted Firefox folder (must be under Program Files, contain firefox.exe, no junctions): $hint"
    }
    foreach ($c in Get-RegisteredFirefoxDirs) { if (Test-TrustedFirefoxDir $c) { return (Get-FullPath $c) } }
    throw "no Firefox install found under Program Files"
}
# One of the two fixed destinations, checked: inside the Firefox folder, no junction on the way.
function Get-ProgramTargetPath([string]$ffDir, $t) {
    $dst = Get-FullPath (Join-Path $ffDir $t.Rel)
    if (-not (Test-Under $ffDir $dst)) { throw "path escape: $dst" }
    Assert-NoReparse $ffDir $dst
    return $dst
}
# Write exactly these bytes to a NEW file (fails if anything already exists there).
function Write-NewFile([string]$path, [byte[]]$bytes) {
    $fs = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $fs.Write($bytes, 0, $bytes.Length); $fs.Flush($true) } finally { $fs.Dispose() }
}
# The elevated step only writes its result to a fresh %TEMP%\termfox-result-<32 hex>.json.
function Assert-ResultFile([string]$path) {
    $full = Get-FullPath $path
    if ((Split-Path -Leaf $full) -notmatch '^termfox-result-[0-9a-f]{32}\.json$') { throw "unexpected result file name" }
    $dir = Split-Path -Parent $full
    if (-not (Test-Path -LiteralPath $dir -PathType Container) -or (Test-ReparsePoint $dir)) { throw "bad result folder" }
    if (Test-Path -LiteralPath $full) { throw "result file already exists" }
    return $full
}
function New-ResultFilePath { return (Join-Path $env:TEMP ("termfox-result-" + [guid]::NewGuid().ToString("N") + ".json")) }

# ---------------------------------------------------------------- pinned loader
$FxacCommit = "dfdab5684faffc112b76ccb1d8cab7f75da0102c"   # fx-autoconfig master, 2026-07-23, loader 0.10.16
$FxacBase   = "https://raw.githubusercontent.com/MrOtherGuy/fx-autoconfig/$FxacCommit"
$ProgramFiles = @($ProgramTargets | ForEach-Object { @{ Src = $_.Src; Dst = $_.Rel; Sha = $_.Sha } })
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

# Read a staged file once, check the bytes in memory, return them (what gets written is what was hashed).
function Read-VerifiedBytes([string]$path, [string]$sha) {
    if (Test-ReparsePoint $path) { throw "staged file is a junction/symlink: $path" }
    $bytes = [IO.File]::ReadAllBytes($path)
    if ((Get-BytesSha256 $bytes) -ne $sha) { throw "SHA-256 mismatch for staged $path" }
    return ,$bytes
}

# ================================================================ elevated child
# Runs as admin. Writes ONLY the two fixed program files, from verified in-memory bytes, to new
# files in a Firefox folder it checked itself. On a failure it removes what it wrote in this run.
if ($ElevatedProgramCopy) {
    try { $ResultFile = Assert-ResultFile $ResultFile } catch { Write-Host "ERROR: $_" -ForegroundColor Red; Start-Sleep -Seconds 5; exit 1 }
    $written = @()
    $rolledBack = @()
    try {
        $ff = Resolve-TrustedFirefoxDir $FirefoxDir
        $stage = Get-FullPath $StagingDir
        foreach ($t in $ProgramTargets) {
            $dst = Get-ProgramTargetPath $ff $t
            if (Test-Path -LiteralPath $dst) {
                if ((Test-Path -LiteralPath $dst -PathType Leaf) -and (Get-Sha256 $dst) -eq $t.Sha) {
                    Write-Host "    exists (identical, left as is)  $dst"
                    $written += @{ Path = $dst; Created = $false }
                    continue
                }
                throw "$dst already exists with different content (another autoconfig?). Not overwriting."
            }
            $src = Join-Path $stage $t.Rel
            if (-not (Test-Under $stage $src)) { throw "staging path escape: $src" }
            $bytes = Read-VerifiedBytes $src $t.Sha
            $dir = Split-Path -Parent $dst
            if (-not (Test-Path -LiteralPath $dir -PathType Container)) { throw "missing folder $dir (not a normal Firefox install?)" }
            Write-NewFile $dst $bytes
            $written += @{ Path = $dst; Created = $true }
            Write-Wrote $dst
        }
        Write-NewFile $ResultFile ([Text.Encoding]::UTF8.GetBytes((@{ ok = $true; files = $written; firefoxDir = $ff } | ConvertTo-Json -Depth 5)))
        exit 0
    } catch {
        $err = "$_"
        # Roll back: remove files this run created, if they still hold exactly what was written.
        foreach ($w in $written) {
            if (-not $w.Created) { continue }
            try {
                $t = $ProgramTargets | Where-Object { $w.Path -like ("*\" + $_.Rel) } | Select-Object -First 1
                if ($t -and (Get-Sha256 $w.Path) -eq $t.Sha) { Remove-Item -LiteralPath $w.Path -Force; $rolledBack += $w.Path }
            } catch { }
        }
        $left = @($written | Where-Object { $_.Created -and $rolledBack -notcontains $_.Path })
        Write-NewFile $ResultFile ([Text.Encoding]::UTF8.GetBytes((@{ ok = $false; error = $err; files = $left; rolledBack = $rolledBack } | ConvertTo-Json -Depth 5)))
        Write-Host "ERROR: $err" -ForegroundColor Red
        Start-Sleep -Seconds 5
        exit 1
    }
}

# ================================================================ main (runs as you)
Write-Host ""
Write-Host "termfox spike installer" -ForegroundColor White
Write-Host "  fx-autoconfig pinned at $FxacCommit"
Write-Host ""
Write-Host "  termfox runs privileged code inside Firefox. The loader it installs applies to every profile" -ForegroundColor Yellow
Write-Host "  of the Firefox you install it into. Read SECURITY.md first; for the most isolation, use a" -ForegroundColor Yellow
Write-Host "  separate Firefox install under Program Files and pass it with -FirefoxDir." -ForegroundColor Yellow
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
    foreach ($c in Get-RegisteredFirefoxDirs) {
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
if (-not (Test-TrustedFirefoxDir $FirefoxDir)) {
    Fail "$FirefoxDir must be under Program Files (admin-only) with no junctions; termfox won't install a loader elsewhere."
}
$FirefoxDir = Get-FullPath $FirefoxDir
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
$preexisting = @{}
foreach ($t in $ProgramTargets) {
    $p = Join-Path $FirefoxDir $t.Rel
    if (Test-Path -LiteralPath $p) {
        if ((Get-Sha256 $p) -ne $t.Sha) { Fail "$p already exists and is not fx-autoconfig $FxacCommit. Not touching it." }
        $preexisting[$t.Key] = $true
    }
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
foreach ($p in @("JS\termfox.uc.mjs", "JS\termfox_actor.sys.mjs", "JS\termfox\TermfoxChild.sys.mjs", "JS\termfox\TermfoxParent.sys.mjs", "JS\termfox\TermfoxCore.sys.mjs", "CSS\termfox.uc.css")) {
    if (-not (Test-Path -LiteralPath (Join-Path $OurChrome $p))) { Fail "Missing $OurChrome\$p (run install.ps1 from the termfox folder)." }
}

# ---------------------------------------------------------------- profile path checks (before any write)
if ($ProfileName -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') { Fail "Profile name may use letters, digits, . _ - only." }
$ProfilesRoot = Join-Path $env:APPDATA "Mozilla\Firefox"
$ProfilesIni  = Join-Path $ProfilesRoot "profiles.ini"
$ProfileDir   = Join-Path $ProfilesRoot "Profiles\$ProfileName"
if (Test-Path -LiteralPath $ProfileDir) { Fail "$ProfileDir already exists. Not touching it." }
if ((Test-Path -LiteralPath $ProfilesIni) -and (Select-String -LiteralPath $ProfilesIni -Pattern "^Name=$([regex]::Escape($ProfileName))\s*$" -Quiet)) {
    Fail "A profile named '$ProfileName' already exists in $ProfilesIni. Not touching it."
}

# ---------------------------------------------------------------- journal, then the elevated step
# The manifest is written BEFORE the admin step and lists both program files it may create
# ("Created": true unless already there, identical). uninstall.ps1 deletes a listed file only if it
# holds exactly the fx-autoconfig bytes, so a journal entry for a file never written is harmless.
New-Item -ItemType Directory -Path $ManifestDir -Force | Out-Null
$manifest = [ordered]@{
    tool = "termfox"; installedAt = (Get-Date).ToString("s"); fxacCommit = $FxacCommit
    firefoxDir = $FirefoxDir; firefoxVersion = $version
    programFiles = @($ProgramTargets | ForEach-Object { [ordered]@{ Path = (Join-Path $FirefoxDir $_.Rel); Created = -not $preexisting[$_.Key]; State = "pending" } })
    profileName = $ProfileName; profileDir = $ProfileDir
    profileLocalDir = (Join-Path $env:LOCALAPPDATA "Mozilla\Firefox\Profiles\$ProfileName")
    profileCreated = $false
}
function Save-Manifest { $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $ManifestPath -Encoding UTF8 }
Save-Manifest
Write-Wrote "$ManifestPath  (journal)"

Write-Step "Admin step: write 2 files into the Firefox program folder"
Write-Host "    These files will be written (UAC prompt next):"
foreach ($f in $ProgramFiles) { Write-Host "      $(Join-Path $FirefoxDir $f.Dst)" }
$resultFile = New-ResultFilePath
$argList = @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$($MyInvocation.MyCommand.Path)`"",
    "-ElevatedProgramCopy", "-FirefoxDir", "`"$FirefoxDir`"", "-StagingDir", "`"$Staging`"", "-ResultFile", "`"$resultFile`""
)
try {
    $proc = Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList $argList -Wait -PassThru
} catch {
    Remove-Item -LiteralPath $ManifestDir -Recurse -Force
    Fail "Admin prompt was cancelled. Nothing was installed."
}
if (-not (Test-Path -LiteralPath $resultFile)) {
    Fail "Admin step produced no result (exit $($proc.ExitCode)). The journal at $ManifestPath is kept; run uninstall.ps1 to clean up."
}
$elev = Get-Content -LiteralPath $resultFile -Raw | ConvertFrom-Json
Remove-Item -LiteralPath $resultFile -Force
if (-not $elev.ok) {
    $left = @($elev.files | Where-Object { $_ })
    if ($left.Count -eq 0) {
        Remove-Item -LiteralPath $ManifestDir -Recurse -Force
        Fail "Admin step failed: $($elev.error). It rolled back what it wrote; nothing was installed."
    }
    $manifest.programFiles = @($left | ForEach-Object { [ordered]@{ Path = $_.Path; Created = $true; State = "written" } })
    Save-Manifest
    Fail "Admin step failed: $($elev.error). Could not roll back: $(($left | ForEach-Object { $_.Path }) -join ', '). Run uninstall.ps1."
}
foreach ($w in $elev.files) { if ($w.Created) { Write-Wrote $w.Path } else { Write-Host "    exists (identical)  $($w.Path)" } }
$manifest.firefoxDir = $elev.firefoxDir
$manifest.programFiles = @($elev.files | ForEach-Object { [ordered]@{ Path = $_.Path; Created = [bool]$_.Created; State = "written" } })
Save-Manifest

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
    # Re-checked at write time: the bytes written are the bytes whose hash was checked.
    Write-NewFile $dst (Read-VerifiedBytes (Join-Path $Staging $f.Dst) $f.Sha)
    $profileFiles += $dst; Write-Wrote $dst
}
Get-ChildItem -LiteralPath $OurChrome -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($OurChrome.Length).TrimStart('\')
    $dst = Join-Path (Join-Path $ProfileDir "chrome") $rel
    New-Item -ItemType Directory -Path (Split-Path -Parent $dst) -Force | Out-Null
    Write-NewFile $dst ([IO.File]::ReadAllBytes($_.FullName))
    $profileFiles += $dst; Write-Wrote $dst
}
# user.js applies only to this profile. It deliberately does NOT set termfox.enabled: a pause
# (Ctrl+Alt+Shift+K) must survive a restart.
$userJs = Join-Path $ProfileDir "user.js"
@(
    '// termfox spike profile prefs (this profile only)',
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
Write-Host "Your normal profile is not changed, but the loader is now active for this whole Firefox install;"
Write-Host "see SECURITY.md. To remove termfox completely, run uninstall.ps1 (pausing is not an off switch)."
exit 0
