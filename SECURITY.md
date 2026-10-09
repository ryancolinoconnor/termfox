# termfox security notes

termfox is a **privileged experiment**, not a normal Firefox add-on. Read this before installing it, and before
recommending it to anyone. Last reviewed 2026-10-08 (external audit of commit 80f511e; fixes in the commits
after it).

## What you are trusting

- **The scripts run with full browser privileges.** termfox is loaded by
  [fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig), not by Firefox's add-on system. Its code is not
  sandboxed or reviewed by Mozilla. Code at that level *could* read saved passwords, cookies, history and any
  file your Windows account can read, and send them anywhere. termfox's own code does none of that: it has no
  network code and reads no passwords, cookies or credential files. But you are trusting every file in the
  profile's `chrome\` folder, so only install a copy whose source you trust.
- **The loader is install-wide.** The admin step writes `config.js` and `defaults\pref\config-prefs.js` into
  the Firefox program folder. That loader runs for **every profile of that Firefox install**. It executes
  scripts only from a profile that also has `chrome\utils\chrome.manifest` (a fresh install creates one, in the
  `termfox` profile only). Anything that can write to one of your profiles can add that file plus scripts and
  get privileged code running there. "Your other profiles are not changed" is true. "Your other profiles are
  not affected" is not.
- **For the most caution, use a dedicated Firefox install.** Install a second copy of Firefox Release under
  `C:\Program Files\` (for example `C:\Program Files\Firefox termfox`) and run
  `install.ps1 -FirefoxDir "C:\Program Files\Firefox termfox"`. Your everyday Firefox then has no loader at all.
  A dedicated per-user install works too (run the Firefox installer without admin and choose a separate folder
  under `%LOCALAPPDATA%`), with the caveat in the next point.
- **A per-user Firefox (no-admin install) is protected only by your Windows account.** Firefox installed without
  admin lives in `%LOCALAPPDATA%\Mozilla Firefox`, and termfox's two loader files go there too. Any program
  running as you can change or replace them, and can replace `firefox.exe` itself. Under Program Files those
  files need admin to change; per-user they don't. That isn't a new hole: the same programs can already write
  to your profile's `chrome\` folder, which the loader runs with full privileges, so the trust model is the
  same (anything running as you is trusted). But "the loader can only be changed by an admin" is **not** true
  for a per-user install. The installer accepts Firefox folders only under Program Files or `%LOCALAPPDATA%`
  (never the Microsoft Store's `WindowsApps`), with no junctions or symlinks on the way.

## What the install scripts can do

- `install.ps1` runs as you. It downloads fx-autoconfig at a pinned commit and checks every file's SHA-256,
  creates a new profile and copies the scripts into it. It then writes exactly the two program-folder files
  above. It first tests whether you can create files in both destination folders by really writing (and
  deleting) a temp file. If you can (a per-user Firefox), it writes them itself with **no UAC prompt**. If not,
  it asks for admin (UAC) **once**, for this step only. Either way it uses the same checks: fixed destination
  paths, no junctions or symlinks, each downloaded file read into memory and checked against hashes hard-coded
  in the script, exactly those bytes written to a new file (never replacing an existing file), a journal
  written before the step, and a rollback of what it wrote if anything fails. The elevated step finds and
  checks the Firefox folder itself and accepts only Program Files (HKLM only, never HKCU).
- `uninstall.ps1` deletes those two files, directly if you can write to that Firefox folder, otherwise with
  admin once. The elevated step reads no manifest. It finds the Firefox folder itself (Program Files only) and
  deletes at most those two files, and only if their bytes are exactly the fx-autoconfig files termfox
  installs. The direct step takes the folder from the manifest, but only after the same folder checks as the
  installer, and deletes under the same rules; it runs as you, so it can't do anything a program running as you
  couldn't already. Profile cleanup is limited to
  `%APPDATA%\Mozilla\Firefox\Profiles\<name>` and its `%LOCALAPPDATA%` twin, never follows junctions, and
  asks before deleting the profile. If something can't be removed, it keeps the manifest, lists what is
  left, and exits with an error.
- **The admin prompt (when there is one) runs the script file itself.** Windows elevates `install.ps1`/`uninstall.ps1` from the folder
  you unzipped them to. If something on your PC changed that file first, the admin step runs the changed
  version, and none of the checks above help. Unzip to a folder only you use. Check the release's hash through
  a channel you trust, and read the script before clicking Yes. Signing a separate small helper would fix this.
  That hasn't been done yet.

## Privacy

- **Diagnostic log is off by default.** `about:config` → `termfox.debugLog` = `true` turns on
  `<profile>\termfox.log`. Even then it records only action names, outcomes (taken / passed / why) and
  timings. It never records the keys you type, page addresses or hosts, tab titles, window names, or the text
  of errors (errors keep their type and a stack with strings and paths removed). Prefix, then **Shift+L**,
  deletes `termfox.log`, `termfox.log.1` and any old `tilefox.log`.
- **Private windows.** Nothing from a private window is written to the log. Its termfox windows (names and
  layouts) stay in memory only. Private and normal windows never show each other's tabs in the palette.
- **Window names you type are saved** with the session (Firefox SessionStore) so they survive a restart, like
  tab titles. Don't type secrets into the rename box.
- Older versions (before these fixes) logged prefix keys, window names and page hosts. Delete old logs with
  prefix **Shift+L**, or delete `termfox.log*` / `tilefox.log*` from the profile folder.

## Pause is not an off switch

**Ctrl+Alt+Shift+K pauses termfox.** Panes dissolve, Firefox's own keys come back, and logging, key routing and
content-actor messages stop. The scripts are still loaded with their privileges, though. Pausing can't revoke
privileges from code that is already running. The pause survives a restart (the installer no longer sets
`termfox.enabled` in `user.js`).

**The real off switch is `uninstall.ps1`** (or `-KeepProfile` to keep the profile but remove the mod), then
restart Firefox. For a quick, temporary stop without uninstalling, set `about:config` →
`userChromeJS.enabled` = `false` and restart. The loader is still installed, but it loads nothing.

## Content boundary

Web pages can't call termfox directly. Each tab's content-side actor sends only fixed messages to the browser
(Hello, a few allow-listed actions, fixed log codes). The browser side checks each message against a strict
schema and never accepts "pause" from a page. An action runs only if the browser itself saw a real key press
for that same tab and action in the last 3 seconds, so a hijacked page process can't make termfox act on its
own. Synthetic key events (`isTrusted = false`) are ignored everywhere. These checks are unit-tested. They
haven't yet been tested against cross-origin iframes and synthetic events in a real Firefox.

## Sharing termfox

Share the source (a release zip or the repository), never your profile folder, `termfox.log`, the install
manifest or `profiles.ini` backups. Old git revisions of this repository contain a personal home-folder path
in `KEYMAP-SPEC.md` (now replaced with `~/.tmux.conf`). History was not rewritten.

## Reporting a problem

Open a GitHub issue without sensitive details, or contact the maintainer privately for anything exploitable.
