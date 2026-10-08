# Install termfox (Windows, about 5 minutes)

termfox adds tmux-style tiling, windows and keyboard navigation to normal Firefox. It runs in its own Firefox profile, so your regular Firefox is untouched.

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
| Ctrl+Alt+Shift+K | Kill switch (turn termfox off or on) |

Installed before 2026-10-08, when this was called tilefox? Your profile is `tilefox-spike` and keeps working.
`launch-termfox.cmd` uses it, and `uninstall.ps1` removes it. See README, "Renamed from tilefox".

## Uninstall
```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```
This removes exactly what was installed and asks before deleting the profile.

It's an early prototype: if something breaks, `%APPDATA%\Mozilla\Firefox\Profiles\termfox\termfox.log` has the details.
