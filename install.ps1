<#
.SYNOPSIS
  termfox day-1 spike installer (Windows, Firefox Release).

.DESCRIPTION
  1. Finds your Firefox Release install folder: per-machine (Program Files), per-user
     (%LOCALAPPDATA%\Mozilla Firefox), or wherever the registry (HKCU/HKLM) or PATH points. With
     several, it uses -FirefoxDir, else the one on PATH, else your default browser, and says which.
  2. Downloads fx-autoconfig at a PINNED commit and checks the SHA-256 of every file.
  3. Writes two files into the Firefox program folder:
       <Firefox>\config.js
       <Firefox>\defaults\pref\config-prefs.js
     If you can write there (a per-user Firefox), directly, with no UAC prompt. Otherwise it asks
     for admin (UAC) for exactly this step.
  4. Creates a NEW profile "termfox" (firefox.exe -CreateProfile) and puts the
     loader files + termfox scripts in that profile's chrome\ folder.
  5. Writes a manifest so uninstall.ps1 removes exactly what was added.

  It never touches any other profile. Close ALL Firefox windows first.

  TRUST MODEL (read SECURITY.md): the two program-folder files turn on a privileged script loader
  for EVERY profile of this Firefox install. It runs code only from a profile that has
  chrome\utils\chrome.manifest (only the termfox profile, unless something else adds one), and that
  code has full browser privileges. If you want the loader confined, install a separate copy of
  Firefox under Program Files just for termfox and pass it with -FirefoxDir.
  A per-user Firefox folder can be changed by any program running as you, like your profile.
  fx-autoconfig: https://github.com/MrOtherGuy/fx-autoconfig#install

  Safety (security audit M4/L1, 2026-10-08): the program-folder step, direct or elevated, checks the
  Firefox folder (firefox.exe, no junctions; the elevated one accepts Program Files only and finds it
  itself), reads each staged file into memory, checks its SHA-256 against the hash hard-coded here,
  and writes exactly those bytes to a NEW file at a fixed path (never replacing one). The manifest
  is written as a journal BEFORE that step, and a half-done step rolls back what it wrote.

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
# Admin-only folders a Firefox install may live in (the only ones the elevated step accepts).
function Get-ProtectedRoots {
    $roots = @()
    foreach ($v in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramW6432)) { if ($v) { $roots += (Get-FullPath $v) } }
    return @($roots | Select-Object -Unique)
}
# For the elevated step: HKLM only, because HKCU can be changed by any program running as you.
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
# Per-user Firefox installs: the Firefox installer run without admin puts Firefox in
# %LOCALAPPDATA%\Mozilla Firefox. Any program running as you can change these (like your profile).
function Get-UserRoots {
    if ($env:LOCALAPPDATA) { return @(Get-FullPath $env:LOCALAPPDATA) }
    return @()
}
# Why termfox won't put the loader in $dir ($null = it may): it must be under Program Files or
# %LOCALAPPDATA% (not the Store's WindowsApps), hold a real firefox.exe, no junction/symlink on the way.
function Get-FirefoxDirProblem([string]$dir) {
    if (-not $dir) { return "no folder given" }
    try {
        $full = Get-FullPath $dir
        if ($full.StartsWith('\\')) { return "network path" }
        if ($full -like "*\WindowsApps" -or $full -like "*\WindowsApps\*") { return "Microsoft Store (MSIX) Firefox: its program folder is read-only; install Firefox from mozilla.org" }
        $exe = Join-Path $full "firefox.exe"
        if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { return "no firefox.exe" }
        $root = @(@(Get-ProtectedRoots) + @(Get-UserRoots)) | Where-Object { Test-Under $_ $full } | Select-Object -First 1
        if (-not $root) { return "not under Program Files or %LOCALAPPDATA%" }
        Assert-NoReparse $root $full
        if (Test-ReparsePoint $exe) { return "firefox.exe is a link" }
        return $null
    } catch { return "$_" }
}
# Can this account create (and delete) a file in $dir? Tested with a real temp file, not by reading
# ACLs: inherited ACEs, group membership and controlled-folder access make guessing unreliable.
function Test-CanCreateFile([string]$dir) {
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { return $false }
    $probe = Join-Path $dir (".termfox-write-test-" + [guid]::NewGuid().ToString("N") + ".tmp")
    try { Write-NewFile $probe ([byte[]]@()) } catch { return $false }
    try { Remove-Item -LiteralPath $probe -Force; return $true }
    catch { Write-Host "    could not delete write test file $probe (delete it by hand)" -ForegroundColor Yellow; return $false }
}
# True when both fixed destinations' folders are writable without admin, so no UAC prompt is needed.
function Test-CanWriteProgramTargets([string]$ffDir) {
    try {
        foreach ($t in $ProgramTargets) {
            if (-not (Test-CanCreateFile (Split-Path -Parent (Get-ProgramTargetPath $ffDir $t)))) { return $false }
        }
        return $true
    } catch { return $false }
}
# ---------------------------------------------------------------- end of shared safety helpers

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

# Writes ONLY the two fixed program files into $ff, from verified in-memory bytes, to new files.
# On a failure it removes what it wrote in this call. Used by the elevated child and, when you can
# write to the Firefox folder yourself, directly (no UAC). Returns the result record.
function Install-ProgramTargets([string]$ff, [string]$stage) {
    $written = @()
    $rolledBack = @()
    try {
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
        return @{ ok = $true; files = $written; firefoxDir = $ff }
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
        return @{ ok = $false; error = $err; files = $left; rolledBack = $rolledBack }
    }
}

# ================================================================ elevated child
# Runs as admin. Checks the Firefox folder itself (Program Files only, HKLM only), then writes the
# two fixed files as above.
if ($ElevatedProgramCopy) {
    try { $ResultFile = Assert-ResultFile $ResultFile } catch { Write-Host "ERROR: $_" -ForegroundColor Red; Start-Sleep -Seconds 5; exit 1 }
    try { $res = Install-ProgramTargets (Resolve-TrustedFirefoxDir $FirefoxDir) (Get-FullPath $StagingDir) }
    catch { $res = @{ ok = $false; error = "$_"; files = @(); rolledBack = @() } }
    Write-NewFile $ResultFile ([Text.Encoding]::UTF8.GetBytes(($res | ConvertTo-Json -Depth 5)))
    if ($res.ok) { exit 0 }
    Write-Host "ERROR: $($res.error)" -ForegroundColor Red
    Start-Sleep -Seconds 5
    exit 1
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
# Every install we can see: per-machine (Program Files), per-user (%LOCALAPPDATA%), and whatever the
# registry (HKCU and HKLM) or PATH points to. Keyed by folder; each remembers where it was seen.
$Candidates = [ordered]@{}
function Add-FirefoxCandidate([string]$dir, [string]$source) {
    if (-not $dir) { return }
    try { $full = Get-FullPath ([Environment]::ExpandEnvironmentVariables($dir.Trim().Trim('"'))) } catch { return }
    if (-not (Test-Path -LiteralPath (Join-Path $full "firefox.exe") -PathType Leaf)) { return }
    $k = $full.ToLowerInvariant()
    if (-not $Candidates.Contains($k)) {
        $Candidates[$k] = [pscustomobject]@{ Dir = $full; Sources = (New-Object System.Collections.ArrayList); Problem = (Get-FirefoxDirProblem $full) }
    }
    if ($Candidates[$k].Sources -notcontains $source) { [void]$Candidates[$k].Sources.Add($source) }
}
# Folder of firefox.exe in a command line such as "C:\...\firefox.exe" -osint -url "%1".
function Get-FirefoxDirFromCommand([string]$cmd) {
    if (-not $cmd) { return $null }
    $c = [Environment]::ExpandEnvironmentVariables($cmd.Trim())
    if ($c.StartsWith('"')) { $end = $c.IndexOf('"', 1); if ($end -lt 2) { return $null }; $exe = $c.Substring(1, $end - 1) }
    else { $i = $c.ToLowerInvariant().IndexOf(".exe"); if ($i -lt 0) { return $null }; $exe = $c.Substring(0, $i + 4) }
    if ((Split-Path -Leaf $exe) -ine "firefox.exe") { return $null }
    return (Split-Path -Parent $exe)
}
function Find-FirefoxCandidates {
    $onPath = Get-Command firefox.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($onPath) { Add-FirefoxCandidate (Split-Path -Parent $onPath.Path) "on PATH" }
    try {
        $progId = (Get-ItemProperty -LiteralPath "HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice" -ErrorAction Stop).ProgId
        if ($progId -like "FirefoxURL*") {
            $cmd = (Get-ItemProperty -LiteralPath "Registry::HKEY_CLASSES_ROOT\$progId\shell\open\command" -ErrorAction Stop).'(default)'
            Add-FirefoxCandidate (Get-FirefoxDirFromCommand $cmd) "default browser"
        }
    } catch { }
    foreach ($hive in @("HKCU", "HKLM")) {
        try {
            $ap = (Get-ItemProperty -LiteralPath "${hive}:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\firefox.exe" -ErrorAction Stop).'(default)'
            if ($ap) { Add-FirefoxCandidate (Split-Path -Parent $ap.Trim('"')) "App Paths ($hive)" }
        } catch { }
    }
    foreach ($key in @("HKCU:\SOFTWARE\Mozilla\Mozilla Firefox", "HKLM:\SOFTWARE\Mozilla\Mozilla Firefox", "HKLM:\SOFTWARE\WOW6432Node\Mozilla\Mozilla Firefox")) {
        try {
            $cur = (Get-ItemProperty -LiteralPath $key -ErrorAction Stop).CurrentVersion
            if ($cur) { Add-FirefoxCandidate (Get-ItemProperty -LiteralPath "$key\$cur\Main" -ErrorAction Stop).'Install Directory' "registry $($key.Substring(0, 4))" }
        } catch { }
    }
    foreach ($v in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) { if ($v) { Add-FirefoxCandidate (Join-Path $v "Mozilla Firefox") "per-machine default folder" } }
    if ($env:LOCALAPPDATA) { Add-FirefoxCandidate (Join-Path $env:LOCALAPPDATA "Mozilla Firefox") "per-user default folder" }
}
Find-FirefoxCandidates
$all = @($Candidates.Values)
foreach ($c in $all) {
    $note = if ($c.Problem) { "  -- can't use: $($c.Problem)" } else { "" }
    Write-Host "    found  $($c.Dir)  [$($c.Sources -join ', ')]$note"
}
$usable = @($all | Where-Object { -not $_.Problem })
if ($FirefoxDir) {
    $problem = Get-FirefoxDirProblem $FirefoxDir
    if ($problem) { Fail "-FirefoxDir $FirefoxDir can't be used: $problem." }
    $FirefoxDir = Get-FullPath $FirefoxDir
    $why = "you passed -FirefoxDir"
} else {
    $pick = $null; $why = ""
    foreach ($rule in @(@("on PATH", "it is the firefox.exe on PATH"), @("default browser", "it is your default browser"))) {
        if (-not $pick) {
            $pick = $usable | Where-Object { $_.Sources -contains $rule[0] } | Select-Object -First 1
            if ($pick) { $why = $rule[1] }
        }
    }
    if (-not $pick -and $usable.Count -gt 0) { $pick = $usable[0]; $why = "first one found (none is on PATH or your default browser)" }
    if (-not $pick) {
        if ($all.Count -eq 0) { Fail "Could not find firefox.exe. Install Firefox from mozilla.org (see INSTALL.md), or pass -FirefoxDir." }
        Fail "No usable Firefox Release found (see above). Install Firefox from mozilla.org, or pass -FirefoxDir."
    }
    $FirefoxDir = $pick.Dir
}
Write-Host "    using  $FirefoxDir  (because $why)" -ForegroundColor White
if (-not $PSBoundParameters.ContainsKey("FirefoxDir") -and $usable.Count -gt 1) {
    Write-Host "    Several Firefox installs found. To use another one, re-run with -FirefoxDir `"<folder>`"." -ForegroundColor Yellow
}
$FirefoxExe = Join-Path $FirefoxDir "firefox.exe"
$channel = "unknown"
$channelFile = Join-Path $FirefoxDir "defaults\pref\channel-prefs.js"
if (Test-Path -LiteralPath $channelFile) {
    $m = Select-String -LiteralPath $channelFile -Pattern 'app\.update\.channel",\s*"([^"]+)"' | Select-Object -First 1
    if ($m) { $channel = $m.Matches[0].Groups[1].Value }
}
$version = (Get-Item -LiteralPath $FirefoxExe).VersionInfo.ProductVersion
Write-Host "    version: $version   channel: $channel"
if ($channel -ne "release" -and -not $Force) {
    Fail "Expected the 'release' channel, found '$channel'. Re-run with -Force if this is intended."
}
# Admin only when needed: if you can create files in both destination folders (a per-user install
# in %LOCALAPPDATA%, or an already elevated window), write them directly with no UAC prompt.
$DirectWrite = Test-CanWriteProgramTargets $FirefoxDir
if ($DirectWrite) {
    Write-Host "    you can write to this Firefox folder: no admin prompt needed"
} elseif (Test-TrustedFirefoxDir $FirefoxDir) {
    Write-Host "    this Firefox folder needs admin to change: one UAC prompt later"
} else {
    Fail "You can't write to $FirefoxDir, and it is not under Program Files, so the admin step won't touch it either."
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

# ---------------------------------------------------------------- journal, then the program-folder step
# The manifest is written BEFORE the program-folder step (direct or admin) and lists both program files it may create
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
    programWriteMode = $(if ($DirectWrite) { "direct" } else { "elevated" })
}
function Save-Manifest { $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $ManifestPath -Encoding UTF8 }
Save-Manifest
Write-Wrote "$ManifestPath  (journal)"

if ($DirectWrite) {
    $StepName = "Loader step"
    Write-Step "Loader step: write 2 files into the Firefox program folder (no admin needed)"
    # Same checks the elevated child makes, re-made right before writing (folder may have changed).
    $problem = Get-FirefoxDirProblem $FirefoxDir
    if ($problem) { $elev = @{ ok = $false; error = $problem; files = @() } }
    else { $elev = Install-ProgramTargets $FirefoxDir $Staging }
} else {
    $StepName = "Admin step"
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
}
if (-not $elev.ok) {
    $left = @($elev.files | Where-Object { $_ })
    if ($left.Count -eq 0) {
        Remove-Item -LiteralPath $ManifestDir -Recurse -Force
        Fail "$StepName failed: $($elev.error). It rolled back what it wrote; nothing was installed."
    }
    $manifest.programFiles = @($left | ForEach-Object { [ordered]@{ Path = $_.Path; Created = $true; State = "written" } })
    Save-Manifest
    Fail "$StepName failed: $($elev.error). Could not roll back: $(($left | ForEach-Object { $_.Path }) -join ', '). Run uninstall.ps1."
}
# (the direct write already printed each file; the elevated child printed in its own window)
if (-not $DirectWrite) { foreach ($w in $elev.files) { if ($w.Created) { Write-Wrote $w.Path } else { Write-Host "    exists (identical)  $($w.Path)" } } }
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
