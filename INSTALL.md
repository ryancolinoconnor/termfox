# Install tilefox (Windows, about 5 minutes)

tilefox adds tmux-style tiling, windows and keyboard navigation to normal Firefox. It runs in its own Firefox profile, so your regular Firefox is untouched.

## 1. Install Firefox (the regular Release version, not the Microsoft Store one)
```powershell
winget install --id Mozilla.Firefox -e
```
Open Firefox once, then close it.

## 2. Get tilefox
On GitHub: **Code → Download ZIP**, then unzip it (e.g. to `C:\tilefox`).
Or, with git: `git clone https://github.com/ryancolinoconnor/tilefox C:\tilefox`

## 3. Install
In a normal PowerShell window (not as admin):
```powershell
cd C:\tilefox
powershell -ExecutionPolicy Bypass -File .\install.ps1
```
Click **Yes** on the admin prompt. It only writes two small loader files into the Firefox folder and prints exactly what it writes. Everything else goes into a new Firefox profile called `tilefox-spike`.

## 4. Launch
Double-click `launch-tilefox.cmd`. Optional: install **Vimium** from addons.mozilla.org in that window.

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
| Ctrl+Alt+Shift+K | Kill switch (turn tilefox off or on) |

## Uninstall
```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```
This removes exactly what was installed and asks before deleting the profile.

It's an early prototype: if something breaks, `%APPDATA%\Mozilla\Firefox\Profiles\tilefox-spike\tilefox.log` has the details.
