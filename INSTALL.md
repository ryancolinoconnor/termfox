# Install termfox (Windows, about 5 minutes)

termfox adds tmux-style tiling, windows and keyboard navigation to normal Firefox. It runs in its own Firefox profile.

## Before you install: the trust model
termfox is a privileged experiment, not a normal add-on. Read [SECURITY.md](SECURITY.md). In short:
- Its scripts run with **full browser privileges**. Code at that level could read passwords, cookies and your files. termfox's own code doesn't, but you are trusting every file it installs. Only install a copy whose source you trust.
- The admin step adds a script loader to the **whole Firefox install**, not only the termfox profile. It runs scripts only from a profile set up for it, but anything that can write to one of your profiles could use it.
- **For the most caution, use a separate Firefox install for termfox**: install a second Firefox under `C:\Program Files\` and pass it with `-FirefoxDir`. Your everyday Firefox then has no loader at all.
- What the scripts do: `install.ps1` downloads a pinned, hash-checked loader, creates a new profile, and writes two fixed files into the Firefox folder, asking for admin **only** if that folder needs it. `uninstall.ps1` deletes those two files (only if they are unchanged), again with admin only if needed, then removes the profile if you type YES. Windows elevates the script file itself, so unzip it somewhere only you use and check it before clicking Yes.

## 1. Install Firefox (the regular Release version, not the Microsoft Store one)
```powershell
winget install --id Mozilla.Firefox -e
```
Open Firefox once, then close it.

### No admin rights?
Install Firefox just for your account:
1. Download the Firefox installer from <https://www.mozilla.org/firefox/new/> (not the Microsoft Store).
2. Run it. When Windows asks for an administrator password, close that prompt (or click **No**). The installer
   carries on without admin and puts Firefox in `C:\Users\<you>\AppData\Local\Mozilla Firefox`.
3. Open that Firefox once, then close it.

Then termfox's installer needs **no admin either**: it finds the per-user Firefox, sees it can write there, and
writes its two loader files directly, with no UAC prompt. If you also have a Firefox in `C:\Program Files`, the
installer picks the one on PATH or your default browser and says which; to choose, pass
`-FirefoxDir "$env:LOCALAPPDATA\Mozilla Firefox"`. A per-user loader can be changed by any program running as
you; see [SECURITY.md](SECURITY.md) (it's the same trust you already give your profile).

## 2. Get termfox
On GitHub: **Code → Download ZIP**, then unzip it (e.g. to `C:\termfox`).
Or, with git: `git clone https://github.com/ryancolinoconnor/termfox C:\termfox`

## 3. Install
In a normal PowerShell window (not as admin):
```powershell
cd C:\termfox
powershell -ExecutionPolicy Bypass -File .\install.ps1
```
It prints every Firefox it found and which one it uses. For a Firefox in `C:\Program Files`, click **Yes** on the admin prompt; it only writes two small loader files into the Firefox folder and prints exactly what it writes. For a per-user Firefox there's no prompt. Everything else goes into a new Firefox profile called `termfox`.
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
| Alt+Enter or prefix `b` | Hide / show the top bar (tabs, address bar, bookmarks). Ctrl+L or the mouse at the top edge peeks. In the address bar Alt+Enter still opens in a new tab |
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
