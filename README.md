# tilefox (day-1 spike)

tmux/i3-style panes inside **official Firefox Release** on Windows. This is not a fork: it adds privileged
"chrome" scripts through [fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig), so you keep
Mozilla's binaries, updates, Sync, AMO extensions and Widevine DRM. Vimium is installed unchanged from AMO.

This spike answers one question: **do the keys, panes, typing and DRM all survive together?** Run
[TEST.md](TEST.md) to find out.

## What it does

| Key | Action |
|---|---|
| **Ctrl+H** | Split the focused pane: a new pane opens to the **right** (tmux `split-window -h`). Replaces "History sidebar". |
| **Ctrl+Y** | Split the focused pane: a new pane opens **below**. Replaces Ctrl+Y redo (use **Ctrl+Shift+Z**). |
| **Ctrl+←/→/↑/↓** | Move focus to the neighbouring pane, **only** when the focus is not in a text field, editor, URL bar, select or similar. Otherwise the normal word-jump happens. |
| **Ctrl+Space**, then `h` `y` arrows `p` `x` | Prefix mode: the same actions without the Ctrl combos (`x` = unpane, `p` = palette). Esc cancels. |
| **Ctrl+Shift+P** | Fuzzy palette over panes (▣) and tabs in all windows. Replaces "New private window" (use the menu). |
| **Ctrl+Alt+Shift+K** | Kill switch: toggles `tilefox.enabled`. Off means panes dissolve and Firefox's keys come back. |

- Every pane is a **real tab**, so extensions, Vimium, logins and DRM work in it as usual. Closing a pane's
  tab, or "unpaning" it (Ctrl+Space then x), turns it back into a normal tab.
- The focused pane (the selected tab) has a blue frame. Clicking a pane focuses it.
- Selecting a tab that isn't in the layout hides the layout, and selecting one of its tabs brings it back.

## Install (Windows)

1. Close all Firefox windows.
2. Open **PowerShell (not as admin)** in this folder and run:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install.ps1
   ```
   It will:
   - find Firefox Release (or pass `-FirefoxDir "C:\Program Files\Mozilla Firefox"`)
   - download fx-autoconfig at pinned commit `dfdab56` and check every file's SHA-256
   - ask for **admin once (UAC)** to write exactly two files: `<Firefox>\config.js` and
     `<Firefox>\defaults\pref\config-prefs.js`. It refuses if a different autoconfig is already there.
   - create a **new** profile `tilefox-spike` (`%APPDATA%\Mozilla\Firefox\Profiles\tilefox-spike`) and put the
     loader and our scripts in its `chrome\` folder. It touches no other profile.
   - write a manifest to `%LOCALAPPDATA%\tilefox\install-manifest.json` for the uninstaller
3. Start it with **`launch-tilefox.cmd`**, which runs `firefox.exe -P tilefox-spike -no-remote`. It can run next to your
   normal Firefox.
4. In the spike profile, install Vimium from AMO, then work through `TEST.md`.

The two program-folder files are read by every profile of this Firefox install. `config.js` only loads
scripts for a profile that has `chrome\utils\chrome.manifest`, and only the spike profile has one. It does set
`general.config.sandbox_enabled=false` as a default pref for the install, which fx-autoconfig needs on Release.

## Uninstall

Close Firefox, then:
```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1            # asks before deleting the spike profile
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -KeepProfile   # remove the mod, keep the profile
```
It removes only what the manifest lists, and program files only if they are byte-identical to what was
installed. Before editing `profiles.ini` it backs the file up to `%TEMP%`.

## Updating the scripts (after an edit)

Close Firefox, copy the changed files from `profile\chrome\` into
`%APPDATA%\Mozilla\Firefox\Profiles\tilefox-spike\chrome\`, start Firefox, then run `about:support` →
**Clear startup cache…**. A full `uninstall.ps1` and `install.ps1` also works.

## Files

```
install.ps1 / uninstall.ps1 / launch-tilefox.cmd
profile/chrome/JS/tilefox.uc.mjs                  per-window script: layout, keys, palette, kill switch
profile/chrome/JS/tilefox_actor.sys.mjs           registers the JSWindowActor once per session
profile/chrome/JS/tilefox/TilefoxChild.sys.mjs    content process: is the focus editable? routes Ctrl+Arrow
profile/chrome/JS/tilefox/TilefoxParent.sys.mjs   forwards actor messages to the window
profile/chrome/CSS/tilefox.uc.css                 pane geometry, focus frame, palette
```

## Known limits (spike)

- **Not persisted.** Layouts are lost on restart. There's one layout per window, and splitting a tab outside it
  starts a new layout.
- **No resizing.** Every split is 50/50 and there are no splitters yet.
- **Firefox-internal APIs.** Panes rely on Firefox 158 internals: shadowing `gBrowser.splitViewBrowsers` so
  background panes keep painting, plus the `#tabbrowser-tabpanels` deck CSS. A Firefox update can break this, and
  the kill switch is the escape hatch. Smoke-test after each Firefox update.
- **Firefox's own Split View** (tab context menu → Split View) and tilefox panes don't mix. Tilefox refuses to
  split a tab that's already in a native split.
- **Ctrl+Y** is no longer redo anywhere; use Ctrl+Shift+Z. **Ctrl+H** no longer opens History; use Ctrl+Shift+H
  (Library). **Ctrl+Shift+P** no longer opens a private window; use the menu.
- **Pages that use Ctrl+Arrow** themselves on non-editable content (some slide decks, games) lose it while
  that tab is a pane. Only panes are affected.
- **Ctrl+Space** may be taken by your Windows IME or input-language switcher before Firefox sees it. Use
  Ctrl+Shift+P instead.
- **Privileged pages** (`about:preferences`, `about:addons`) inside a pane: Ctrl+Arrow there falls through to
  chrome handling and may not move focus. Use Ctrl+Space then an arrow key.
- **Security note:** profile scripts run with full browser privileges. Only run reviewed, versioned
  code from this folder.
- **Untested.** None of this has run in Firefox yet; it was written and statically checked from Linux. See the
  "verified vs assumed" notes in the commit log and `TEST.md`.

## References used

- fx-autoconfig docs (hotkeys, scripts, styles): https://github.com/MrOtherGuy/fx-autoconfig
- Firefox Release source (branch `release`, v158): https://github.com/mozilla-firefox/firefox/tree/release
  - `browser/components/tabbrowser/AsyncTabSwitcher.sys.mjs` (`shouldDeactivateDocShell`)
  - `browser/components/tabbrowser/Tabbrowser.sys.mjs` (`splitViewBrowsers`, `showSplitViewPanels`, `addTrustedTab`)
  - `toolkit/content/widgets/tabbox.js` (split-view panel click/focus handling)
  - `toolkit/content/xul.css` (tabpanels deck)
  - `browser/base/content/browser-sets.inc.xhtml`, `toolkit/content/editMenuKeys.inc.xhtml` (original keys)
- JSWindowActors: https://firefox-source-docs.mozilla.org/dom/ipc/jsactors.html
