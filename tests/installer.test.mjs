// install.ps1 and uninstall.ps1 each carry the same "shared safety helpers" block (each script must
// run on its own). This keeps the two copies identical. The behaviour of the no-admin path is
// checked on Windows by tests/installer-selftest.ps1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("..", import.meta.url);
const START = "# ---------------------------------------------------------------- shared safety helpers";
const END = "# ---------------------------------------------------------------- end of shared safety helpers";
function sharedBlock(name) {
  const s = readFileSync(new URL(name, root), "utf8").replace(/\r\n/g, "\n");
  const a = s.indexOf(START), b = s.indexOf(END);
  assert.ok(a >= 0 && b > a, `${name}: shared helper markers`);
  return s.slice(a, b);
}

test("install.ps1 and uninstall.ps1 share an identical safety-helper block", () => {
  assert.equal(sharedBlock("install.ps1"), sharedBlock("uninstall.ps1"));
});

test("elevated steps stay Program Files + HKLM only; direct path also allows %LOCALAPPDATA%", () => {
  const b = sharedBlock("install.ps1");
  const reg = b.slice(b.indexOf("function Get-RegisteredFirefoxDirs"), b.indexOf("function Test-TrustedFirefoxDir"));
  assert.ok(!reg.includes("HKCU"), "Get-RegisteredFirefoxDirs must not read HKCU");
  const trusted = b.slice(b.indexOf("function Test-TrustedFirefoxDir"), b.indexOf("function Resolve-TrustedFirefoxDir"));
  assert.ok(trusted.includes("Get-ProtectedRoots") && !trusted.includes("Get-UserRoots"));
  const usable = b.slice(b.indexOf("function Get-FirefoxDirProblem"), b.indexOf("function Test-CanCreateFile"));
  assert.ok(usable.includes("Get-UserRoots") && usable.includes("WindowsApps") && usable.includes("Assert-NoReparse"));
});

test("both program-folder steps write/delete only via the fixed targets", () => {
  for (const [name, fn] of [["install.ps1", "Install-ProgramTargets"], ["uninstall.ps1", "Remove-ProgramTargets"]]) {
    const s = readFileSync(new URL(name, root), "utf8");
    const body = s.slice(s.indexOf(`function ${fn}(`), s.indexOf("# ================================================================ elevated child"));
    assert.ok(body.includes("foreach ($t in $ProgramTargets)") && body.includes("Get-ProgramTargetPath $ff $t"), `${name}: ${fn}`);
    if (fn === "Install-ProgramTargets") assert.ok(body.includes("Read-VerifiedBytes") && body.includes("Write-NewFile"));
    else assert.ok(body.includes("(Get-Sha256 $dst) -ne $t.Sha"));
  }
});
