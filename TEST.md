# tilefox spike: test checklist (about 2 hours, Windows 11)

The keys mirror your `~/.tmux.conf` (README → "What it does", spec in KEYMAP-SPEC.md). Every key decision is in `<profile>\tilefox.log`.

Tick `[x]` for pass and write **FAIL** plus a note for a fail. Work top to bottom: section 0 must pass before you install anything.

Record your Firefox version (`about:support` → Version): __________

## 0. DRM baseline BEFORE installing (fresh profile, no mod), ~15 min

Close all Firefox windows, then in PowerShell:

```powershell
& "C:\Program Files\Mozilla Firefox\firefox.exe" -CreateProfile "drm-baseline $env:APPDATA\Mozilla\Firefox\Profiles\drm-baseline"
& "C:\Program Files\Mozilla Firefox\firefox.exe" -P drm-baseline -no-remote
```

- [ ] `about:addons` → Plugins lists **Widevine Content Decryption Module provided by Google Inc.** (it can take a minute to download on first run)
- [ ] Netflix: a title plays video and sound for 30 s
- [ ] Spotify web (open.spotify.com): a track plays for 30 s
- [ ] (optional) Disney+ or Prime Video plays

If this section fails, stop: it is a Firefox/Windows problem, not tilefox. Afterwards remove the baseline profile in `about:profiles` (Remove → Delete Files), from a Firefox window running a different profile.

## 1. Install, ~10 min

- [ ] `install.ps1` ran without errors, and the UAC prompt listed exactly `config.js` and `defaults\pref\config-prefs.js`
- [ ] Launch with `launch-tilefox.cmd`. The window opens on the **tilefox-spike** profile (`about:profiles` shows it as "This is the profile in use")
- [ ] Browser Console (Ctrl+Shift+J) shows `[tilefox] JSWindowActor registered` and `[tilefox] ready in window; enabled = true`
- [ ] Your normal Firefox profile still opens as before (`firefox.exe` without `-P`) and does not show the `[tilefox]` lines

Then install from AMO into the spike profile: **Vimium**, plus uBlock Origin and your password manager if you want the daily-driver feel.

## 2. DRM AFTER installing, ~10 min (in the tilefox-spike profile)

- [ ] Widevine is listed in `about:addons` → Plugins
- [ ] Netflix plays (single tab, no panes)
- [ ] Spotify web plays (single tab)
- [ ] Netflix plays **inside a pane**: Ctrl+Y, open Netflix in the new pane, play; the other pane keeps rendering
- [ ] Fullscreen (F or double-click) on Netflix in a pane fills the screen; Esc returns to the panes

## 3. Split keys, ~10 min (keymap mirrors your tmux.conf, see README)

- [ ] Ctrl+Y on a normal page (click page text first): a new pane opens on the **right** (side by side)
- [ ] Ctrl+H: the current pane splits **downward** (new pane below) and the History sidebar does **not** open
- [ ] Ctrl+H while typing in a textarea or Gmail compose box does **not** split (passes through, like vim in tmux)
- [ ] Ctrl+Y while typing in a textarea redoes (type, Ctrl+Z, Ctrl+Y) and does not split
- [ ] Alt+Y while typing in a textarea splits **right**; Alt+H while typing splits **below**. No letter is typed and the Help menu does not open
- [ ] Ctrl+H while the URL bar has text in it passes through (Firefox may open History there; that is the pass-through). Alt+H there splits
- [ ] Ctrl+H in an **empty** URL bar (a fresh pane) splits
- [ ] Ctrl+H pressed twice fast makes exactly **3** panes; Alt+H x5 fast makes 6. Holding Ctrl+H or Alt+H makes **one** new pane, not many. `tilefox.log` shows `split col` once per press and `swallowed (key repeat ...)` / `ignored: ...` lines for the extra paths
- [ ] Three or more panes: Ctrl+Y, then Ctrl+H, then Alt+Y. Every pane renders and none goes blank
- [ ] The focused pane has a blue frame, and clicking another pane moves the frame
- [ ] Ctrl+A (on page text) then **x** "unpanes" the focused tab: it stays open as a normal tab and the remaining panes reflow
- [ ] Closing a pane's tab (Ctrl+W) reflows the remaining panes, and with one left the layout disappears
- [ ] Selecting a non-pane tab in the tab strip hides the layout, and selecting a pane's tab brings it back

## 4. Ctrl+Arrow and Alt+Arrow: focus vs word-jump, ~20 min (have 2+ panes open)

Ctrl+Left/Right word-jump must still work (the caret moves by a word and focus stays in the field):
- [ ] Gmail compose body
- [ ] Gmail "To" field (input)
- [ ] A plain `<textarea>` (for example a GitHub issue comment box)
- [ ] A contenteditable document (Google Docs, or Notion)
- [ ] The URL bar (Ctrl+L, then Ctrl+Left/Right)
- [ ] Ctrl+Shift+Left still selects a word in all of the above

Focus moves to the neighbouring pane:
- [ ] Ctrl+Left/Right/Up/Down on a normal page (click on page text first, not in a field) moves the blue frame in that direction
- [ ] The same inside a cross-origin iframe (for example click inside an embedded YouTube video's area on a news page, then Ctrl+Right)
- [ ] Alt+Left/Right/Up/Down moves the frame **even while the caret is in a textarea or the URL bar**
- [ ] Alt+Left does **not** go Back and Alt+Right does not go Forward (Vimium `H`/`L` still do)
- [ ] With no pane in that direction, nothing happens and nothing breaks

## 5. Prefix, reload and palette, ~10 min

- [ ] Ctrl+A on page text (not in a field) shows the hint bar; **y** (right), **h** (down) and the arrows then work like Ctrl+Y/H/arrows. Esc cancels, and it closes by itself after ~2.5 s
- [ ] Ctrl+A inside a textarea or the URL bar selects all text (no hint bar)
- [ ] Ctrl+Space shows the hint bar even while typing in a textarea
- [ ] Prefix then **r** shows a short "tilefox: Reloaded" message, and `tilefox.log` has a `reload done` line
- [ ] Set `about:config` → `tilefox.keys.splitRight` = `Ctrl+U`, then prefix r: Ctrl+U now splits right. Reset the pref afterwards
- [ ] Ctrl+Shift+P opens the palette (note: this replaces Firefox's "New private window" key; use the menu instead)
- [ ] Prefix then **f** also opens the palette (prefix **p** is now previous-window, as in tmux)
- [ ] Typing a fuzzy query (for example `gml` for Gmail) filters tabs, ↑/↓ moves and Enter jumps there. Panes are marked ▣1, ▣2…
- [ ] Tabs from a second window are listed, and Enter switches to that window

## 5b. Windows (tmux windows), ~15 min

Prefix = Ctrl+A on page text, or Ctrl+Space anywhere.
- [ ] A status line under the toolbars reads `0:<site>*`
- [ ] Split the window (Ctrl+Y). Prefix **c**: a new window with one new tab, the URL bar is focused, the first window's tabs disappear from the tab strip, and the status line reads `0:...-  1:...*`
- [ ] Open a page and a link in a new tab (middle-click): both tabs stay in window 1
- [ ] **Alt+L** goes back to window 0 **instantly**: its split comes back exactly, and no page reloads (a playing video keeps playing, a half-typed form keeps its text)
- [ ] **Alt+L** again toggles to window 1. Prefix **l** does the same
- [ ] Prefix **n** / **p** step through windows; prefix **0** / **1** and **Alt+0** / **Alt+1** jump straight there; prefix **7** says "can't find window: 7"
- [ ] Alt+1 on Windows doesn't also switch tab (Firefox's tab keys are Ctrl+1…9 there) and opens no menu
- [ ] Prefix **,** opens a small input: type `dev`, Enter, and the status line shows `1:dev*`. An empty name goes back to the automatic name
- [ ] Prefix **w** lists windows; Enter switches. Ctrl+Shift+P lists `window:dev` entries plus tabs from hidden windows marked `[1:dev]`, and Enter on one switches there
- [ ] Clicking a status-line entry switches to that window
- [ ] Close every tab of window 1 with Ctrl+W: window 1 disappears and you land on window 0
- [ ] Prefix **&** asks `kill-window ...? (y/n)`; **n** cancels, **y** closes that window's tabs. With one window left it refuses
- [ ] Ctrl+N: the new Firefox window has its own status line `0:...*`, and its windows don't touch the first Firefox window's
- [ ] Restart Firefox (with "Open previous windows and tabs" on in Settings): the same windows, names, tabs and splits come back, on the same current window
- [ ] Ctrl+Alt+Shift+K shows all tabs and hides the status line; again restores the windows
- [ ] `about:config` → `tilefox.statusbar` = false hides the status line
- [ ] `tilefox.log` has `window -> ...`, `new window` and `windows restored` lines

## 6. Vimium in both panes, ~15 min

In each pane (click it first):
- [ ] `f` shows link hints **in the focused pane only**, and typing a hint opens the link
- [ ] `j`/`k` scroll the focused pane
- [ ] `/` opens Vimium find, and Enter/Esc work
- [ ] After `f`, the other pane is not affected
- [ ] Typing in a text field doesn't trigger Vimium (insert mode still works)

## 7. Undo/redo and editors, ~10 min

- [ ] Ctrl+Z undoes in a textarea, Gmail compose and Google Docs
- [ ] **Ctrl+Shift+Z** redoes in each of these, and so does **Ctrl+Y** (it passes through while typing)
- [ ] Ctrl+Z/Ctrl+Shift+Z in the URL bar

## 8. IME (only if you use one), ~5 min

- [ ] While composing (the underlined candidate text is visible), Ctrl+Arrow does not move pane focus or break the composition
- [ ] Note: if your IME uses Ctrl+Space to switch input language, Windows takes that key first, so use Ctrl+A (outside fields) as the prefix

## 9. Kill switch, ~5 min

- [ ] Ctrl+Alt+Shift+K: a "tilefox disabled" bar appears, panes dissolve into normal tabs, Ctrl+H opens **History** again, Ctrl+A selects the page and Alt+Left goes Back
- [ ] Ctrl+Left and Alt+Y on a page do nothing special while disabled
- [ ] Ctrl+Alt+Shift+K again re-enables it (Ctrl+H splits)
- [ ] `about:config` → `tilefox.enabled` = false gives the same result as the key
- [ ] Total off switch: `about:config` → `userChromeJS.enabled` = false, then restart. Nothing from tilefox or the loader runs

## 10. Uninstall, ~5 min

- [ ] Close Firefox, run `uninstall.ps1`, and type YES to delete the spike profile
- [ ] `C:\Program Files\Mozilla Firefox\config.js` is gone, and `defaults\pref\config-prefs.js` is gone
- [ ] Your normal profile opens fine and `about:profiles` no longer lists tilefox-spike

## How to collect logs

- **tilefox.log** is in the profile folder (`%APPDATA%\Mozilla\Firefox\Profiles\tilefox-spike\tilefox.log`). The Browser Console prints its path at startup (`[tilefox] file log: ...`). If it can't be written, the console shows `CANNOT WRITE LOG FILE` and the window shows a notification bar.

- **Browser Console** (where all tilefox output goes): Ctrl+Shift+J in the spike profile. Filter on `tilefox`. Errors from our scripts start with `[tilefox]`. Loader errors mention `fx-autoconfig` or `boot.sys.mjs`. Right-click → "Copy all Messages" (or "Save all Messages to File") and paste into a note.
- **Content-side errors** (TilefoxChild, which runs inside page processes): these appear in the same Browser Console. Make sure the console's "Show Content Messages" option (gear icon) is ticked.
- **Did the loader load?** Menu bar (Alt) → Tools → userScripts lists `tilefox.uc.mjs` and `tilefox_actor.sys.mjs`. If it's empty, the program-folder files are missing or the startup cache is stale. Use `about:support` → "Clear startup cache…".
- **Firefox version and DRM state**: `about:support` (Version; Media → "Widevine") and `about:addons` → Plugins.
- **When something fails**: note the checklist line, the site, the exact keys, and what happened instead. Attach the console text.
