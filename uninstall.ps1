<#
.SYNOPSIS
  Removes what termfox install.ps1 added, using its manifest
  (%LOCALAPPDATA%\termfox\install-manifest.json, or %LOCALAPPDATA%\tilefox\install-manifest.json for an
  install made before the rename to termfox, whose profile is "tilefox-spike"):
    - <Firefox>\config.js and <Firefox>\defaults\pref\config-prefs.js (only files the installer
      created, and only if they are byte-identical to the fx-autoconfig files termfox installs). Directly,
      with no UAC prompt, if you can write to that Firefox folder (a per-user Firefox); else as admin.
    - the "termfox" (or old "tilefox-spike") profile: its [ProfileN] entry in profiles.ini and its folders
    - the manifest folder (kept, listing what is left, if anything could not be removed)
  Other profiles are never touched. Close ALL Firefox windows first.

  This is termfox's real off switch: pausing (Ctrl+Alt+Shift+K) leaves the privileged scripts loaded.

  Safety (security audit H2, 2026-10-08): the manifest lives in a folder any program running as you
  can edit, so it is treated as untrusted. Its schema is checked; the profile folders must be exactly
  <AppData>\Mozilla\Firefox\Profiles\<name> (and the Local twin) with no junctions; the elevated step
  reads no manifest at all: it finds the Firefox folder itself and only ever deletes the two fixed
  files above, only when their SHA-256 matches the hashes hard-coded in this script. The direct
  (no-admin) step uses the manifest's Firefox folder only after the same folder checks as install
  (Program Files or %LOCALAPPDATA%, firefox.exe, no junctions) and deletes under the same rules; it
  runs as you, so it can do nothing a program running as you couldn't already.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
  powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -KeepProfile   # keep the spike profile, remove the mod
#>
[CmdletBinding()]
param(
    [switch]$KeepProfile,
    [switch]$Yes,
    # Internal: used by the elevated child process. Checked, never trusted.
    [switch]$ElevatedProgramRemove,
    [string]$FirefoxDirHint = "",
    [switch]$RemoveConfigJs,
    [switch]$RemoveConfigPrefs,
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

$ManifestDir  = Join-Path $env:LOCALAPPDATA "termfox"
$ManifestPath = Join-Path $ManifestDir "install-manifest.json"
if (-not $ElevatedProgramRemove -and -not (Test-Path -LiteralPath $ManifestPath)) {
    # Install made before the rename (2026-10-08): same manifest format, old folder.
    $legacyDir = Join-Path $env:LOCALAPPDATA "tilefox"
    if (Test-Path -LiteralPath (Join-Path $legacyDir "install-manifest.json")) {
        $ManifestDir  = $legacyDir
        $ManifestPath = Join-Path $legacyDir "install-manifest.json"
    }
}
# Our script files under <profile>\chrome, old and new names. The manifest of an install made before
# the rename lists only the old names, but the renamed scripts may have been copied in since.
$OurChromeFiles = @(
    "JS\termfox.uc.mjs", "JS\termfox_actor.sys.mjs", "CSS\termfox.uc.css",
    "JS\termfox\TermfoxChild.sys.mjs", "JS\termfox\TermfoxParent.sys.mjs", "JS\termfox\TermfoxCore.sys.mjs",
    "JS\tilefox.uc.mjs", "JS\tilefox_actor.sys.mjs", "CSS\tilefox.uc.css",
    "JS\tilefox\TilefoxChild.sys.mjs", "JS\tilefox\TilefoxParent.sys.mjs", "JS\tilefox\TilefoxCore.sys.mjs"
)
# Lines an installer wrote to user.js (current and older versions). -KeepProfile removes only these.
$OurUserJsLines = @(
    '// termfox spike profile prefs (this profile only)',
    '// tilefox spike profile prefs (this profile only)',
    'user_pref("termfox.enabled", true);',
    'user_pref("tilefox.enabled", true);',
    '// Lets the Browser Console (Ctrl+Shift+J) evaluate chrome JS while debugging the spike.',
    'user_pref("devtools.chrome.enabled", true);'
)

function Write-Step([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Removed([string]$path) { Write-Host "    removed  $path" -ForegroundColor Green }
function Fail([string]$msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

# Deletes at most the two fixed program files in $ff, and only when their bytes are the fx-autoconfig
# files termfox installs (hard-coded hashes). Used by the elevated child and, when you can write to
# the Firefox folder yourself, directly (no UAC). Returns the result record.
function Remove-ProgramTargets([string]$ff, [bool]$removeJs, [bool]$removePrefs) {
    $log = @(); $kept = @(); $removed = @()
    try {
        foreach ($t in $ProgramTargets) {
            $want = if ($t.Key -eq "configJs") { $removeJs } else { $removePrefs }
            if (-not $want) { continue }
            $dst = Get-ProgramTargetPath $ff $t
            if (-not (Test-Path -LiteralPath $dst)) { $log += "already gone: $dst"; $removed += $t.Key; continue }
            if (-not (Test-Path -LiteralPath $dst -PathType Leaf) -or (Get-Sha256 $dst) -ne $t.Sha) {
                $log += "KEPT (not the file termfox installed; check by hand): $dst"; $kept += $t.Key; continue
            }
            Remove-Item -LiteralPath $dst -Force
            $log += "removed: $dst"; $removed += $t.Key
        }
        return @{ ok = $true; log = $log; kept = $kept; removed = $removed; firefoxDir = $ff }
    } catch {
        return @{ ok = $false; error = "$_"; log = $log; kept = $kept; removed = $removed }
    }
}

# ================================================================ elevated child
# Runs as admin. Reads no manifest: finds the Firefox folder itself (Program Files only, HKLM only).
if ($ElevatedProgramRemove) {
    try { $ResultFile = Assert-ResultFile $ResultFile } catch { Write-Host "ERROR: $_" -ForegroundColor Red; Start-Sleep -Seconds 5; exit 1 }
    try { $res = Remove-ProgramTargets (Resolve-TrustedFirefoxDir $FirefoxDirHint) $RemoveConfigJs.IsPresent $RemoveConfigPrefs.IsPresent }
    catch { $res = @{ ok = $false; error = "$_"; log = @(); kept = @(); removed = @() } }
    Write-NewFile $ResultFile ([Text.Encoding]::UTF8.GetBytes(($res | ConvertTo-Json -Depth 4)))
    if ($res.ok) { exit 0 }
    Write-Host "ERROR: $($res.error)" -ForegroundColor Red
    Start-Sleep -Seconds 5
    exit 1
}

# ================================================================ manifest (untrusted input)
function Assert-Manifest($m) {
    $names = @($m.PSObject.Properties.Name)
    foreach ($req in @("tool", "programFiles", "profileName", "profileDir", "profileCreated")) {
        if ($names -notcontains $req) { throw "manifest has no '$req'" }
    }
    if (@("termfox", "tilefox-spike", "tilefox") -notcontains $m.tool) { throw "manifest is not a termfox manifest" }
    if ($m.profileName -isnot [string] -or $m.profileName -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') { throw "bad profileName" }
    if ($m.profileDir -isnot [string]) { throw "bad profileDir" }
    if ($m.profileCreated -isnot [bool]) { throw "bad profileCreated" }
    if ($names -contains "profileLocalDir" -and $null -ne $m.profileLocalDir -and $m.profileLocalDir -isnot [string]) { throw "bad profileLocalDir" }
    if ($names -contains "firefoxDir" -and $null -ne $m.firefoxDir -and $m.firefoxDir -isnot [string]) { throw "bad firefoxDir" }
    foreach ($f in @($m.programFiles)) {
        if ($null -eq $f) { continue }
        $fn = @($f.PSObject.Properties.Name)
        if ($fn -notcontains "Path" -or $f.Path -isnot [string] -or $fn -notcontains "Created" -or $f.Created -isnot [bool]) { throw "bad programFiles entry" }
        if (-not ($f.Path -like "*\config.js" -or $f.Path -like "*\defaults\pref\config-prefs.js")) { throw "unexpected program file in manifest: $($f.Path)" }
    }
    if ($names -contains "profileFiles") { foreach ($p in @($m.profileFiles)) { if ($null -ne $p -and $p -isnot [string]) { throw "bad profileFiles entry" } } }
}

if (-not (Test-Path -LiteralPath $ManifestPath)) { Fail "No install manifest at $ManifestPath; nothing to uninstall." }
if (Get-Process -Name firefox -ErrorAction SilentlyContinue) { Fail "Firefox is running. Close ALL Firefox windows and run again." }
try {
    $m = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
    Assert-Manifest $m
} catch { Fail "The manifest at $ManifestPath is not valid ($_). Nothing was changed; remove termfox by hand (see SECURITY.md)." }
$hasProp = { param($o, $n) $o.PSObject.Properties.Name -contains $n }

# The only profile folders this script will ever delete: exactly <Profiles root>\<profileName>.
$AppDataRoot = Get-FullPath $env:APPDATA
$LocalRoot = Get-FullPath $env:LOCALAPPDATA
$ProfileDir = Join-Path (Join-Path $AppDataRoot "Mozilla\Firefox\Profiles") $m.profileName
$ProfileLocalDir = Join-Path (Join-Path $LocalRoot "Mozilla\Firefox\Profiles") $m.profileName
if ((Get-FullPath $m.profileDir) -ine $ProfileDir) { Fail "Manifest profileDir is not $ProfileDir. Refusing to touch it." }
if ((& $hasProp $m "profileLocalDir") -and $m.profileLocalDir -and (Get-FullPath $m.profileLocalDir) -ine $ProfileLocalDir) {
    Fail "Manifest profileLocalDir is not $ProfileLocalDir. Refusing to touch it."
}
# Remove one file inside the profile: confined to it, no junction on the way.
function Remove-ProfileFile([string]$f) {
    if (-not (Test-Under $ProfileDir $f)) { Write-Host "    skipping path outside the profile: $f" -ForegroundColor Yellow; return }
    if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { return }
    try { Assert-NoReparse $ProfileDir $f } catch { Write-Host "    skipping: $_" -ForegroundColor Yellow; return }
    Remove-Item -LiteralPath $f -Force
    Write-Removed $f
}
# Delete a profile folder. [IO.Directory]::Delete does not follow junctions/symlinks inside it.
function Remove-ProfileFolder([string]$d, [string]$root) {
    if (-not (Test-Path -LiteralPath $d)) { return $true }
    try { Assert-NoReparse $root $d } catch { Write-Host "    NOT removed: $_" -ForegroundColor Yellow; return $false }
    try { [IO.Directory]::Delete($d, $true); Write-Removed $d; return $true }
    catch { Write-Host "    could not remove ${d}: $($_.Exception.Message)" -ForegroundColor Yellow; return $false }
}
$leftovers = @()

# ---------------------------------------------------------------- profile
if ($m.profileCreated -and -not $KeepProfile) {
    Write-Step "Removing the '$($m.profileName)' profile"
    Write-Host "    This deletes $ProfileDir (bookmarks, logins and history made in the spike profile)."
    if (-not $Yes) {
        $ans = Read-Host "    Type YES to delete the spike profile (anything else keeps it)"
        if ($ans -ne "YES") { $KeepProfile = $true; Write-Host "    keeping the profile" }
    }
}
if ($m.profileCreated -and -not $KeepProfile) {
    $ini = Join-Path $env:APPDATA "Mozilla\Firefox\profiles.ini"
    if (Test-Path -LiteralPath $ini) {
        $lines = [IO.File]::ReadAllLines($ini)
        # Split into sections, keeping order.
        $sections = New-Object System.Collections.ArrayList
        $cur = $null
        foreach ($l in $lines) {
            if ($l -match '^\s*\[(.+)\]\s*$') { $cur = @{ Name = $Matches[1]; Lines = (New-Object System.Collections.ArrayList) }; [void]$sections.Add($cur) }
            elseif ($cur) { [void]$cur.Lines.Add($l) }
            else { $cur = @{ Name = ""; Lines = (New-Object System.Collections.ArrayList) }; [void]$cur.Lines.Add($l); [void]$sections.Add($cur) }
        }
        $profDirFull = $ProfileDir
        $iniDir = Split-Path -Parent $ini
        $target = $null
        foreach ($s in $sections) {
            if ($s.Name -notmatch '^Profile\d+$') { continue }
            $name = ($s.Lines | Where-Object { $_ -match '^Name=' } | Select-Object -First 1)
            $path = ($s.Lines | Where-Object { $_ -match '^Path=' } | Select-Object -First 1)
            $rel  = ($s.Lines | Where-Object { $_ -match '^IsRelative=1' } | Select-Object -First 1)
            if (-not $name -or -not $path) { continue }
            $p = $path.Substring(5)
            $full = if ($rel) { Get-FullPath (Join-Path $iniDir ($p -replace '/', '\')) } else { Get-FullPath $p }
            if ($name.Substring(5) -eq $m.profileName -and $full -ieq $profDirFull) { $target = $s }
        }
        # Refuse if Firefox made our profile an install's default (only happens if it was the only profile).
        $defaultHit = $false
        foreach ($s in $sections) {
            if ($s.Name -like 'Install*') {
                foreach ($l in $s.Lines) {
                    if ($l -match '^Default=(.+)$') {
                        $v = $Matches[1]
                        if ($v -match 'Profiles[/\\]' + [regex]::Escape($m.profileName) + '$' -or $v -ieq $profDirFull) { $defaultHit = $true }
                    }
                }
            }
        }
        if ($defaultHit) {
            Write-Host "    The spike profile is the DEFAULT profile of a Firefox install, so profiles.ini is left alone." -ForegroundColor Yellow
            Write-Host "    Open about:profiles in Firefox, make another profile the default, then run uninstall.ps1 again." -ForegroundColor Yellow
            $KeepProfile = $true
        } elseif ($target) {
            $backup = Join-Path $env:TEMP ("profiles.ini.before-termfox-uninstall." + (Get-Date -Format "yyyyMMdd-HHmmss"))
            Copy-Item -LiteralPath $ini -Destination $backup
            Write-Host "    backup of profiles.ini: $backup"
            [void]$sections.Remove($target)
            # Firefox reads Profile0, Profile1, ... and stops at the first gap, so renumber.
            $i = 0
            foreach ($s in $sections) { if ($s.Name -match '^Profile\d+$') { $s.Name = "Profile$i"; $i++ } }
            $out = New-Object System.Collections.ArrayList
            foreach ($s in $sections) {
                if ($s.Name) { [void]$out.Add("[$($s.Name)]") }
                foreach ($l in $s.Lines) { [void]$out.Add($l) }
            }
            [IO.File]::WriteAllLines($ini, [string[]]$out, (New-Object Text.UTF8Encoding($false)))
            Write-Host "    removed [$($target.Name)] Name=$($m.profileName) from $ini" -ForegroundColor Green
        } else {
            Write-Host "    no profiles.ini entry for $($m.profileName) at $profDirFull (already removed?)"
        }
    }
    if (-not $KeepProfile) {
        if (-not (Remove-ProfileFolder $ProfileDir $AppDataRoot)) { $leftovers += $ProfileDir }
        if (-not (Remove-ProfileFolder $ProfileLocalDir $LocalRoot)) { $leftovers += $ProfileLocalDir }
    }
}
if ($KeepProfile -and $m.profileCreated) {
    # Keep the profile but take the mod out of it.
    Write-Step "Keeping the profile; removing termfox + loader files from it"
    $userJs = Join-Path $ProfileDir "user.js"
    if (& $hasProp $m "profileFiles") {
        foreach ($f in @($m.profileFiles)) { if ($f -and ((Get-FullPath $f) -ine $userJs)) { Remove-ProfileFile $f } }
    }
    foreach ($rel in $OurChromeFiles) { Remove-ProfileFile (Join-Path (Join-Path $ProfileDir "chrome") $rel) }
    # user.js: remove only the lines an installer wrote; keep the file if you added anything.
    if ((Test-Path -LiteralPath $userJs -PathType Leaf) -and -not (Test-ReparsePoint $userJs)) {
        $rest = @([IO.File]::ReadAllLines($userJs) | Where-Object { $OurUserJsLines -notcontains $_.Trim() })
        if (-not ($rest | Where-Object { $_.Trim() })) { Remove-ProfileFile $userJs }
        else { [IO.File]::WriteAllLines($userJs, [string[]]$rest); Write-Host "    removed termfox lines from $userJs (kept your own)" -ForegroundColor Green }
    }
    foreach ($d in @("chrome\JS\termfox", "chrome\JS\tilefox", "chrome\JS", "chrome\CSS", "chrome\utils", "chrome")) {
        $full = Join-Path $ProfileDir $d
        if ((Test-Path -LiteralPath $full -PathType Container) -and -not (Test-ReparsePoint $full) -and -not (Get-ChildItem -LiteralPath $full -Force)) {
            Remove-Item -LiteralPath $full -Force; Write-Removed $full
        }
    }
    Write-Host "    Left in the kept profile (yours to delete): termfox.log / tilefox.log if any, the" -ForegroundColor Yellow
    Write-Host "    devtools.chrome.enabled setting in prefs.js, and termfox window names in its session." -ForegroundColor Yellow
}

# ---------------------------------------------------------------- program folder (direct or admin)
# The manifest only says WHICH of the two fixed files the installer created (and, for the direct
# path, the folder); the elevated step decides everything else for itself.
$want = @{}
foreach ($f in @($m.programFiles)) {
    if ($null -eq $f -or -not $f.Created) { continue }
    if ($f.Path -like "*\defaults\pref\config-prefs.js") { $want.configPrefs = $true } elseif ($f.Path -like "*\config.js") { $want.configJs = $true }
}
$retained = @()
if ($want.Count -gt 0) {
    # Admin only when needed: the folder from the manifest is used directly only if it passes the same
    # checks as at install AND you can really create files there (a per-user Firefox). Else UAC.
    $hint = if ((& $hasProp $m "firefoxDir") -and $m.firefoxDir) { $m.firefoxDir } else { "" }
    $direct = [bool]($hint -and -not (Get-FirefoxDirProblem $hint) -and (Test-CanWriteProgramTargets $hint))
    if ($direct) {
        $StepName = "Loader step"
        Write-Step "Loader step: remove termfox's files from the Firefox program folder (no admin needed)"
        $r = Remove-ProgramTargets (Get-FullPath $hint) ([bool]$want.configJs) ([bool]$want.configPrefs)
    } else {
        $StepName = "Admin step"
        Write-Step "Admin step: remove termfox's files from the Firefox program folder"
        $resultFile = New-ResultFilePath
        $argList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$($MyInvocation.MyCommand.Path)`"",
                     "-ElevatedProgramRemove", "-ResultFile", "`"$resultFile`"")
        if ((& $hasProp $m "firefoxDir") -and $m.firefoxDir) { $argList += @("-FirefoxDirHint", "`"$($m.firefoxDir)`"") }
        if ($want.configJs) { $argList += "-RemoveConfigJs" }
        if ($want.configPrefs) { $argList += "-RemoveConfigPrefs" }
        try { Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList $argList -Wait | Out-Null }
        catch { Fail "Admin prompt cancelled. Program files left in place; the manifest is kept so you can re-run." }
        if (-not (Test-Path -LiteralPath $resultFile)) { Fail "Admin step produced no result. Manifest kept; re-run uninstall.ps1." }
        $r = Get-Content -LiteralPath $resultFile -Raw | ConvertFrom-Json
        Remove-Item -LiteralPath $resultFile -Force
    }
    foreach ($l in @($r.log)) { if ($l) { Write-Host "    $l" } }
    if (-not $r.ok) { Fail "$StepName failed: $($r.error). Manifest kept; re-run uninstall.ps1." }
    $retained = @($m.programFiles | Where-Object { $_ -and $_.Created -and (
        ($_.Path -like "*\defaults\pref\config-prefs.js" -and @($r.kept) -contains "configPrefs") -or
        ($_.Path -like "*\config.js" -and -not ($_.Path -like "*\defaults\pref\config-prefs.js") -and @($r.kept) -contains "configJs")) })
}

# ---------------------------------------------------------------- manifest
if ($KeepProfile -and $m.profileCreated) {
    Write-Host "Profile kept at $ProfileDir. Remove it later from about:profiles if you want."
}
if ($retained.Count -gt 0 -or $leftovers.Count -gt 0) {
    # Something is still on disk: keep a manifest that lists exactly that, so a re-run can finish.
    $m.programFiles = @($retained)
    if ($leftovers.Count -eq 0 -and -not $KeepProfile) { $m.profileCreated = $false }
    $m | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $ManifestPath -Encoding UTF8
    Write-Host ""
    Write-Host "NOT fully uninstalled. Still on disk:" -ForegroundColor Yellow
    foreach ($f in $retained) { Write-Host "    $($f.Path)  (changed since install; the Firefox-wide loader may still be active)" -ForegroundColor Yellow }
    foreach ($d in $leftovers) { Write-Host "    $d" -ForegroundColor Yellow }
    Write-Host "Manifest kept at $ManifestPath; fix the above and run uninstall.ps1 again." -ForegroundColor Yellow
    exit 1
}
if ((Test-Path -LiteralPath $ManifestDir) -and -not (Test-ReparsePoint $ManifestDir)) {
    [IO.Directory]::Delete($ManifestDir, $true)
    Write-Removed $ManifestDir
}
Write-Host ""
Write-Host "termfox uninstalled." -ForegroundColor White
exit 0
