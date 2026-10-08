<#
.SYNOPSIS
  Removes exactly what tilefox install.ps1 added, using its manifest
  (%LOCALAPPDATA%\tilefox\install-manifest.json):
    - <Firefox>\config.js and <Firefox>\defaults\pref\config-prefs.js (admin; only files the
      installer created, and only if they are still byte-identical to what it wrote)
    - the "tilefox-spike" profile: its [ProfileN] entry in profiles.ini and its folders
    - the manifest folder
  Other profiles are never touched. Close ALL Firefox windows first.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
  powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -KeepProfile   # keep the spike profile, remove the mod
#>
[CmdletBinding()]
param(
    [switch]$KeepProfile,
    [switch]$Yes,
    # Internal: used by the elevated child process.
    [switch]$ElevatedProgramRemove,
    [string]$ManifestFile = "",
    [string]$ResultFile = ""
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$ManifestDir  = Join-Path $env:LOCALAPPDATA "tilefox"
$ManifestPath = Join-Path $ManifestDir "install-manifest.json"

function Write-Step([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Removed([string]$path) { Write-Host "    removed  $path" -ForegroundColor Green }
function Fail([string]$msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }
function Get-Sha256([string]$path) { return (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant() }

# ================================================================ elevated child
if ($ElevatedProgramRemove) {
    $log = @()
    try {
        $m = Get-Content -LiteralPath $ManifestFile -Raw | ConvertFrom-Json
        foreach ($f in $m.programFiles) {
            if (-not $f.Created) { $log += "kept (existed before install): $($f.Path)"; continue }
            if (-not (Test-Path -LiteralPath $f.Path)) { $log += "already gone: $($f.Path)"; continue }
            if ((Get-Sha256 $f.Path) -ne $f.Sha) { $log += "KEPT (modified since install, check by hand): $($f.Path)"; continue }
            Remove-Item -LiteralPath $f.Path -Force
            $log += "removed: $($f.Path)"
            $hasCreatedDir = $f.PSObject.Properties.Name -contains "CreatedDir"
            if ($hasCreatedDir -and $f.CreatedDir) {
                $d = Split-Path -Parent $f.Path
                if ((Test-Path -LiteralPath $d) -and -not (Get-ChildItem -LiteralPath $d -Force)) {
                    Remove-Item -LiteralPath $d -Force; $log += "removed empty dir: $d"
                }
            }
        }
        @{ ok = $true; log = $log } | ConvertTo-Json | Set-Content -LiteralPath $ResultFile -Encoding UTF8
        exit 0
    } catch {
        @{ ok = $false; error = "$_"; log = $log } | ConvertTo-Json | Set-Content -LiteralPath $ResultFile -Encoding UTF8
        exit 1
    }
}

# ================================================================ main
if (-not (Test-Path -LiteralPath $ManifestPath)) { Fail "No install manifest at $ManifestPath; nothing to uninstall." }
if (Get-Process -Name firefox -ErrorAction SilentlyContinue) { Fail "Firefox is running. Close ALL Firefox windows and run again." }
$m = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
$hasProp = { param($o, $n) $o.PSObject.Properties.Name -contains $n }

# ---------------------------------------------------------------- profile
if ($m.profileCreated -and -not $KeepProfile) {
    Write-Step "Removing the '$($m.profileName)' profile"
    Write-Host "    This deletes $($m.profileDir) (bookmarks, logins and history made in the spike profile)."
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
        $profDirFull = [IO.Path]::GetFullPath($m.profileDir)
        $iniDir = Split-Path -Parent $ini
        $target = $null
        foreach ($s in $sections) {
            if ($s.Name -notmatch '^Profile\d+$') { continue }
            $name = ($s.Lines | Where-Object { $_ -match '^Name=' } | Select-Object -First 1)
            $path = ($s.Lines | Where-Object { $_ -match '^Path=' } | Select-Object -First 1)
            $rel  = ($s.Lines | Where-Object { $_ -match '^IsRelative=1' } | Select-Object -First 1)
            if (-not $name -or -not $path) { continue }
            $p = $path.Substring(5)
            $full = if ($rel) { [IO.Path]::GetFullPath((Join-Path $iniDir ($p -replace '/', '\'))) } else { [IO.Path]::GetFullPath($p) }
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
            $backup = Join-Path $env:TEMP ("profiles.ini.before-tilefox-uninstall." + (Get-Date -Format "yyyyMMdd-HHmmss"))
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
        foreach ($d in @($m.profileDir, $m.profileLocalDir)) {
            if ($d -and (Test-Path -LiteralPath $d)) {
                if ((Split-Path -Leaf $d) -ne $m.profileName) { Write-Host "    skipping unexpected path $d" -ForegroundColor Yellow; continue }
                Remove-Item -LiteralPath $d -Recurse -Force
                Write-Removed $d
            }
        }
    }
}
if ($KeepProfile -and $m.profileCreated) {
    # Keep the profile but take the mod out of it.
    Write-Step "Keeping the profile; removing tilefox + loader files from it"
    if (& $hasProp $m "profileFiles") {
        foreach ($f in $m.profileFiles) { if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force; Write-Removed $f } }
    }
    foreach ($d in @("chrome\JS\tilefox", "chrome\JS", "chrome\CSS", "chrome\utils", "chrome")) {
        $full = Join-Path $m.profileDir $d
        if ((Test-Path -LiteralPath $full) -and -not (Get-ChildItem -LiteralPath $full -Force)) { Remove-Item -LiteralPath $full -Force; Write-Removed $full }
    }
}

# ---------------------------------------------------------------- program folder (admin)
$toRemove = @($m.programFiles | Where-Object { $_.Created })
if ($toRemove.Count -gt 0) {
    Write-Step "Admin step: remove files from the Firefox program folder"
    foreach ($f in $toRemove) { Write-Host "      $($f.Path)" }
    $resultFile = Join-Path $env:TEMP ("tilefox-uninstall-" + [guid]::NewGuid().ToString("N") + ".json")
    $argList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$($MyInvocation.MyCommand.Path)`"",
                 "-ElevatedProgramRemove", "-ManifestFile", "`"$ManifestPath`"", "-ResultFile", "`"$resultFile`"")
    try { Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList $argList -Wait | Out-Null }
    catch { Fail "Admin prompt cancelled. Program files left in place; the manifest is kept so you can re-run." }
    if (-not (Test-Path -LiteralPath $resultFile)) { Fail "Admin step produced no result. Manifest kept; re-run uninstall.ps1." }
    $r = Get-Content -LiteralPath $resultFile -Raw | ConvertFrom-Json
    Remove-Item -LiteralPath $resultFile -Force
    foreach ($l in $r.log) { Write-Host "    $l" }
    if (-not $r.ok) { Fail "Admin step failed: $($r.error). Manifest kept; re-run uninstall.ps1." }
}

# ---------------------------------------------------------------- manifest
if ($KeepProfile -and $m.profileCreated) {
    Write-Host "Profile kept at $($m.profileDir). Remove it later from about:profiles if you want."
}
Remove-Item -LiteralPath $ManifestDir -Recurse -Force
Write-Removed $ManifestDir
Write-Host ""
Write-Host "tilefox uninstalled." -ForegroundColor White
exit 0
