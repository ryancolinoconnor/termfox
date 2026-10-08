# Install termfox (Windows, about 5 minutes)

termfox adds tmux-style tiling, windows and keyboard navigation to normal Firefox. It runs in its own Firefox profile.

## Before you install: the trust model
termfox is a privileged experiment, not a normal add-on. Read [SECURITY.md](SECURITY.md). In short:
- Its scripts run with **full browser privileges**. Code at that level could read passwords, cookies and your files. termfox's own code doesn't, but you are trusting every file it installs. Only install a copy whose source you trust.
- The admin step adds a script loader to the **whole Firefox install**, not only the termfox profile. It runs scripts only from a profile set up for it, but anything that can write to one of your profiles could use it.
- **For the most caution, use a separate Firefox install for termfox**: install a second Firefox under `C:\Program Files\` and pass it with `-FirefoxDir`. Your everyday Firefox then has no loader at all.
- What the scripts do: `install.ps1` downloads a pinned, hash-checked loader, creates a new profile, and uses admin **only** to write two fixed files into the Firefox folder. `uninstall.ps1` uses admin **only** to delete those two files (and only if they are unchanged), then removes the profile if you type YES. Windows elevates the script file itself, so unzip it somewhere only you use and check it before clicking Yes.

## 1. Install Firefox (the regular Release version, not the Microsoft Store one)
```powershell
winget install --id Mozilla.Firefox -e
```
Open Firefox once, then close it.

## 2. Get termfox
On GitHub: **Code → Download ZIP**, then unzip it (e.g. to `C:\termfox`).
Or, with git: `git clone https://github.com/ryancolinoconnor/termfox C:\termfox`

## 3. Install
In a normal PowerShell window (not as admin):
```powershell
cd C:\termfox
powershell -ExecutionPolicy Bypass -File .\install.ps1
```
Click **Yes** on the admin prompt. It only writes two small loader files into the Firefox folder and prints exactly what it writes. Everything else goes into a new Firefox profile called `termfox`.
Dedicated Firefox install: `powershell -ExecutionPolicy Bypass -File .\install.ps1 -FirefoxDir "C:\Program Files\Firefox termfox"`.

## 4. Launch
Double-click `launch-termfox.cmd`. Optional: install **Vimium** from addons.mozilla.org in that window.

## Keys (prefix = Ctrl+A when not typing, or Ctrl+Space anywhere)
| Keys | What it does |
|---|---|
| Ctrl+Y / Ctrl+H | New pane right / below (normal Ctrl+Y/H while typing) |
| Alt+Y / Alt+H | New pane right / below, always |
| Ctrl+arrows | Move between panes (word-jump while typing); wraps at the edges |
| Alt+arrows | Move between panes, always |
| prefix `c` / `l` / `n` / `p` / `0`–`9` | New window / last window / next / previous / jump |
| prefix `,` / `w` / `&` | Rename / list / close window |
| Alt+L, Alt+0–9 | Last window / jump to a window |
| prefix `f` or Ctrl+Shift+P | Fuzzy palette |
| prefix `x` | Turn a pane back into a normal tab |
| prefix `L` (Shift+L) | Delete termfox's log files |
| Ctrl+Alt+Shift+K | Pause / resume (not an off switch; see below) |

Installed before 2026-10-08, when this was called tilefox? Your profile is `tilefox-spike` and keeps working.
`launch-termfox.cmd` uses it, and `uninstall.ps1` removes it. See README, "Renamed from tilefox".

## Uninstall
```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```
This removes exactly what was installed and asks before deleting the profile. **Uninstalling is the real off switch.** Pausing (Ctrl+Alt+Shift+K) leaves the privileged scripts loaded.

It's an early prototype. To capture a diagnostic log, set `about:config` → `termfox.debugLog` = `true`. The log goes to `%APPDATA%\Mozilla\Firefox\Profiles\termfox\termfox.log` and contains only action names, outcomes and timings. It's off by default.
