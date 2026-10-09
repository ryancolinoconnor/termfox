<#
  Windows self-test for the no-admin (direct) loader path of install.ps1 / uninstall.ps1.
  Runs the scripts' own functions (loaded from their AST; the scripts' main code never runs) against
  a FAKE per-user Firefox folder under %LOCALAPPDATA%\termfox-selftest-*, with the real pinned
  fx-autoconfig bytes. Never touches a real Firefox, profile, or manifest; needs no admin.
    powershell -ExecutionPolicy Bypass -File .\tests\installer-selftest.ps1
#>
Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
function Import-ScriptFunctions([string]$name) {
    $ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $RepoRoot $name), [ref]$null, [ref]$null)
    foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Parent -eq $ast.EndBlock }, $false)) {
        . ([scriptblock]::Create($fn.Extent.Text))
    }
    $pt = $ast.EndBlock.Statements | Where-Object { $_.Extent.Text -like '$ProgramTargets = @(*' } | Select-Object -First 1
    . ([scriptblock]::Create($pt.Extent.Text))
}
$script:fails = 0
function Check([string]$name, [bool]$ok) { if ($ok) { Write-Host "PASS $name" } else { Write-Host "FAIL $name" -ForegroundColor Red; $script:fails++ } }

$root = Join-Path $env:LOCALAPPDATA ("termfox-selftest-" + [guid]::NewGuid().ToString("N"))
$ff = Join-Path $root "Mozilla Firefox"
$stage = Join-Path $root "stage"
try {
    . Import-ScriptFunctions "install.ps1"
    function Write-Wrote([string]$p) { Write-Host "    wrote  $p" }
    New-Item -ItemType Directory -Path (Join-Path $ff "defaults\pref"), (Join-Path $stage "defaults\pref") -Force | Out-Null
    [IO.File]::WriteAllBytes((Join-Path $ff "firefox.exe"), [byte[]]@(77, 90))
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $base = "https://raw.githubusercontent.com/MrOtherGuy/fx-autoconfig/dfdab5684faffc112b76ccb1d8cab7f75da0102c"
    foreach ($t in $ProgramTargets) { Invoke-WebRequest -UseBasicParsing -Uri "$base/$($t.Src)" -OutFile (Join-Path $stage $t.Rel) }

    Write-Host "--- detection on this machine (read-only)"
    $Candidates = [ordered]@{}
    Find-FirefoxCandidates
    foreach ($c in $Candidates.Values) { Write-Host ("    {0} [{1}] {2}" -f $c.Dir, ($c.Sources -join ', '), $c.Problem) }

    Write-Host "--- install, fake per-user Firefox"
    Check "per-user dir usable" ($null -eq (Get-FirefoxDirProblem $ff))
    Check "per-user dir writable -> no UAC" (Test-CanWriteProgramTargets $ff)
    Check "no probe files left" (@(Get-ChildItem -LiteralPath $ff -Recurse -Force -Filter ".termfox-write-test-*").Count -eq 0)
    Check "per-user dir NOT accepted by elevated step" (-not (Test-TrustedFirefoxDir $ff))
    Check "WindowsApps rejected" ((Get-FirefoxDirProblem (Join-Path $env:LOCALAPPDATA "Microsoft\WindowsApps")) -ne $null)
    Check "outside allowed roots rejected" ((Get-FirefoxDirProblem $env:SystemRoot) -ne $null)

    $r = Install-ProgramTargets $ff $stage
    Check "direct install ok" ($r.ok)
    Check "config.js hash" ((Get-Sha256 (Join-Path $ff "config.js")) -eq $ProgramTargets[0].Sha)
    Check "config-prefs.js hash" ((Get-Sha256 (Join-Path $ff "defaults\pref\config-prefs.js")) -eq $ProgramTargets[1].Sha)
    Check "both Created" (@($r.files | Where-Object { $_.Created }).Count -eq 2)
    $r2 = Install-ProgramTargets $ff $stage
    Check "re-run: identical files left, not Created" ($r2.ok -and @($r2.files | Where-Object { $_.Created }).Count -eq 0)

    # rollback: config.js gets written, then config-prefs.js exists with other bytes -> config.js removed
    Remove-Item (Join-Path $ff "config.js"), (Join-Path $ff "defaults\pref\config-prefs.js")
    [IO.File]::WriteAllText((Join-Path $ff "defaults\pref\config-prefs.js"), "other")
    $r3 = Install-ProgramTargets $ff $stage
    Check "conflict -> fails" (-not $r3.ok)
    Check "conflict -> config.js rolled back" (-not (Test-Path (Join-Path $ff "config.js")) -and @($r3.rolledBack).Count -eq 1 -and @($r3.files).Count -eq 0)
    Check "conflict -> foreign file untouched" ((Get-Content (Join-Path $ff "defaults\pref\config-prefs.js") -Raw) -eq "other")
    Remove-Item (Join-Path $ff "defaults\pref\config-prefs.js")

    # tampered staging bytes are refused
    $bad = Join-Path $root "badstage"; Copy-Item $stage $bad -Recurse
    Add-Content (Join-Path $bad "config.js") "//x"
    $r4 = Install-ProgramTargets $ff $bad
    Check "tampered staged file refused, nothing left" ((-not $r4.ok) -and -not (Test-Path (Join-Path $ff "config.js")))

    # junction on the destination path is refused (junctions need no admin)
    Rename-Item (Join-Path $ff "defaults") "defaults-real"
    New-Item -ItemType Junction -Path (Join-Path $ff "defaults") -Target (Join-Path $ff "defaults-real") | Out-Null
    $r5 = Install-ProgramTargets $ff $stage
    Check "junction under Firefox dir refused" ((-not $r5.ok) -and "$($r5.error)" -like "*junction*" -and -not (Test-Path (Join-Path $ff "config.js")))
    Check "junction -> not writable-direct either" (-not (Test-CanWriteProgramTargets $ff))
    [IO.Directory]::Delete((Join-Path $ff "defaults")); Rename-Item (Join-Path $ff "defaults-real") "defaults"

    # Firefox folder itself reached through a junction
    $j = Join-Path $root "ff-link"
    New-Item -ItemType Junction -Path $j -Target $ff | Out-Null
    Check "junctioned Firefox dir rejected" ((Get-FirefoxDirProblem $j) -like "*junction*")
    [IO.Directory]::Delete($j)

    # command-line parsing for the default-browser lookup
    Check "cmd parse quoted" ((Get-FirefoxDirFromCommand '"C:\Program Files\Mozilla Firefox\firefox.exe" -osint -url "%1"') -eq "C:\Program Files\Mozilla Firefox")
    Check "cmd parse other exe ignored" ($null -eq (Get-FirefoxDirFromCommand '"C:\x\chrome.exe" "%1"'))

    # leave a real install for the uninstall test
    $r6 = Install-ProgramTargets $ff $stage
    Check "final install ok" ($r6.ok)

    Write-Host "--- uninstall"
    . Import-ScriptFunctions "uninstall.ps1"
    Check "uninstall sees per-user dir as direct" (($null -eq (Get-FirefoxDirProblem $ff)) -and (Test-CanWriteProgramTargets $ff))
    # changed config.js is kept, unchanged prefs removed
    Add-Content (Join-Path $ff "config.js") "//edited"
    $r = Remove-ProgramTargets $ff $true $true
    Check "edited config.js KEPT" ($r.ok -and @($r.kept) -contains "configJs" -and (Test-Path (Join-Path $ff "config.js")))
    Check "unchanged prefs removed" (@($r.removed) -contains "configPrefs" -and -not (Test-Path (Join-Path $ff "defaults\pref\config-prefs.js")))
    $r2 = Remove-ProgramTargets $ff $false $true
    Check "already gone is ok" ($r2.ok -and @($r2.removed) -contains "configPrefs")
    Check "per-user dir rejected by elevated resolver" ($(try { Resolve-TrustedFirefoxDir $ff; $false } catch { $true }))
} catch { Write-Host "FAIL exception: $_ (line $($_.InvocationInfo.ScriptLineNumber))" -ForegroundColor Red; $script:fails++ }
finally { if (Test-Path -LiteralPath $root) { [IO.Directory]::Delete($root, $true) } }
Check "selftest folder cleaned" (-not (Test-Path -LiteralPath $root))
Write-Host "failures: $script:fails"
exit [int]($script:fails -gt 0)
