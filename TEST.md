# tilefox spike: test checklist (about 2 hours, Windows 11)

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
- [ ] Netflix plays **inside a pane**: Ctrl+H, open Netflix in the new pane, play; the other pane keeps rendering
- [ ] Fullscreen (F or double-click) on Netflix in a pane fills the screen; Esc returns to the panes

## 3. Split keys, ~10 min

- [ ] Ctrl+H on a normal page: a new pane opens on the **right** and the History sidebar does **not** open
- [ ] Ctrl+Y: the current pane splits **downward** (new pane below)
- [ ] Ctrl+H while typing in a textarea or Gmail compose box still splits (by design) and types no letter
- [ ] Ctrl+H while the URL bar is focused splits and does not open History
- [ ] Three or more panes: Ctrl+H, then Ctrl+Y, then Ctrl+H. Every pane renders and none goes blank
- [ ] The focused pane has a blue frame, and clicking another pane moves the frame
- [ ] Ctrl+Space then **x** "unpanes" the focused tab: it stays open as a normal tab and the remaining panes reflow
- [ ] Closing a pane's tab (Ctrl+W) reflows the remaining panes, and with one left the layout disappears
- [ ] Selecting a non-pane tab in the tab strip hides the layout, and selecting a pane's tab brings it back

## 4. Ctrl+Arrow: focus vs word-jump, ~20 min (have 2+ panes open)

Word-jump must still work (the caret moves by a word and focus stays in the field):
- [ ] Gmail compose body
- [ ] Gmail "To" field (input)
- [ ] A plain `<textarea>` (for example a GitHub issue comment box)
- [ ] A contenteditable document (Google Docs, or Notion)
- [ ] The URL bar (Ctrl+L, then Ctrl+Left/Right)
- [ ] Ctrl+Shift+Left still selects a word in all of the above

Focus moves to the neighbouring pane:
- [ ] Ctrl+Left/Right/Up/Down on a normal page (click on page text first, not in a field) moves the blue frame in that direction
- [ ] The same inside a cross-origin iframe (for example click inside an embedded YouTube video's area on a news page, then Ctrl+Right)
- [ ] With no pane in that direction, nothing happens and nothing breaks

## 5. Prefix fallback and palette, ~10 min

- [ ] Ctrl+Space shows the hint bar, and **h**, **y** and the arrows then work like Ctrl+H/Y/arrows. Esc cancels, and it closes by itself after ~2.5 s
- [ ] Ctrl+Shift+P opens the palette (note: this replaces Firefox's "New private window" key; use the menu instead)
- [ ] Ctrl+Space then **p** also opens the palette
- [ ] Typing a fuzzy query (for example `gml` for Gmail) filters tabs, ↑/↓ moves and Enter jumps there. Panes are marked ▣1, ▣2…
- [ ] Tabs from a second window are listed, and Enter switches to that window

## 6. Vimium in both panes, ~15 min

In each pane (click it first):
- [ ] `f` shows link hints **in the focused pane only**, and typing a hint opens the link
- [ ] `j`/`k` scroll the focused pane
- [ ] `/` opens Vimium find, and Enter/Esc work
- [ ] After `f`, the other pane is not affected
- [ ] Typing in a text field doesn't trigger Vimium (insert mode still works)

## 7. Undo/redo and editors, ~10 min

- [ ] Ctrl+Z undoes in a textarea, Gmail compose and Google Docs
- [ ] **Ctrl+Shift+Z** redoes in each of these. Ctrl+Y no longer redoes (it splits; this is expected)
- [ ] Ctrl+Z/Ctrl+Shift+Z in the URL bar

## 8. IME (only if you use one), ~5 min

- [ ] While composing (the underlined candidate text is visible), Ctrl+Arrow does not move pane focus or break the composition
- [ ] Note: if your IME uses Ctrl+Space to switch input language, Windows takes that key first, so use Ctrl+Shift+P for the palette

## 9. Kill switch, ~5 min

- [ ] Ctrl+Alt+Shift+K: a "tilefox disabled" bar appears, panes dissolve into normal tabs, Ctrl+H opens **History** again and Ctrl+Y redoes again
- [ ] Ctrl+Left on a page does nothing special while disabled
- [ ] Ctrl+Alt+Shift+K again re-enables it (Ctrl+H splits)
- [ ] `about:config` → `tilefox.enabled` = false gives the same result as the key
- [ ] Total off switch: `about:config` → `userChromeJS.enabled` = false, then restart. Nothing from tilefox or the loader runs

## 10. Uninstall, ~5 min

- [ ] Close Firefox, run `uninstall.ps1`, and type YES to delete the spike profile
- [ ] `C:\Program Files\Mozilla Firefox\config.js` is gone, and `defaults\pref\config-prefs.js` is gone
- [ ] Your normal profile opens fine and `about:profiles` no longer lists tilefox-spike

## How to collect logs

- **Browser Console** (where all tilefox output goes): Ctrl+Shift+J in the spike profile. Filter on `tilefox`. Errors from our scripts start with `[tilefox]`. Loader errors mention `fx-autoconfig` or `boot.sys.mjs`. Right-click → "Copy all Messages" (or "Save all Messages to File") and paste into a note.
- **Content-side errors** (TilefoxChild, which runs inside page processes): these appear in the same Browser Console. Make sure the console's "Show Content Messages" option (gear icon) is ticked.
- **Did the loader load?** Menu bar (Alt) → Tools → userScripts lists `tilefox.uc.mjs` and `tilefox_actor.sys.mjs`. If it's empty, the program-folder files are missing or the startup cache is stale. Use `about:support` → "Clear startup cache…".
- **Firefox version and DRM state**: `about:support` (Version; Media → "Widevine") and `about:addons` → Plugins.
- **When something fails**: note the checklist line, the site, the exact keys, and what happened instead. Attach the console text.
