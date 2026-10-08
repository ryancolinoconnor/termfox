# termfox (day-1 spike)

tmux/i3-style panes inside **official Firefox Release** on Windows. This is not a fork: it adds privileged
"chrome" scripts through [fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig), so you keep
Mozilla's binaries, updates, Sync, AMO extensions and Widevine DRM. Vimium is installed unchanged from AMO.

This spike answers one question: **do the keys, panes, typing and DRM all survive together?** Run
[TEST.md](TEST.md) to find out.

## What it does

The default keymap **mirrors your `~/.tmux.conf`** (spec: [KEYMAP-SPEC.md](KEYMAP-SPEC.md); where tmux.conf binds
a key twice, the last binding wins). tmux's "vim-aware" keys become "typing-aware": when the focus is in a text
field, editor, URL bar, select or similar, the key goes to the page instead, just as tmux sends it on to vim.

| Key | tmux.conf | termfox |
|---|---|---|
| **Ctrl+Y** | `C-y` split-window -h (vim-aware) | New pane to the **right**. While typing, passes through (Ctrl+Y = redo there). |
| **Ctrl+H** | `C-h` split-window -v (vim-aware) | New pane **below**. While typing, passes through. An *empty* text field (such as the URL bar of a fresh pane) doesn't count as typing, so Ctrl+H twice makes three panes. |
| **Alt+Y** | `M-y` split-window -h | New pane to the **right**, always, even while typing. |
| **Alt+H** | `M-h` split-window -v | New pane **below**, always. |
| **Ctrl+←/→/↑/↓** | `C-Left`… select-pane (vim-aware) | Focus the pane in that direction, wrapping at the edge like tmux (Up from the top pane goes to the bottom pane in that column, the leftmost one on a tie). While typing, passes through (word-jump). Only when a pane layout is on screen. |
| **Alt+←/→/↑/↓** | `M-Left`… select-pane | Focus the pane in that direction (wrapping like tmux), **always**. This replaces Firefox's Alt+Left/Right Back/Forward: use Vimium `H`/`L` or the toolbar. |
| **Ctrl+A** | prefix `C-a` | Prefix, only when **not** typing (Ctrl+A select-all still works in fields). |
| **Ctrl+Space** | (alias) | Prefix, always (also while typing). |
| prefix then `y` / `h` / arrows | | Split right / split down / move focus |
| prefix then `r` | `bind r source-file` | Reload: re-reads the keymap prefs and the stylesheet in every window, shows "Reloaded". |
| prefix then `f` / `x` | `f` find-window | Palette / unpane (turn the focused pane back into a normal tab). Esc cancels. (`p` is now previous-window, as in tmux.) |
| prefix then `c` `n` `p` `l` `0`–`9` `,` `w` `&` | tmux defaults | **Windows** (below): new, next, previous, last, select by index, rename, list, kill. |
| **Alt+L** / **Alt+0…9** | | Last window / select window N, no prefix. |
| **Ctrl+Shift+P** | | Fuzzy palette over termfox windows (`window:name`), panes (▣) and tabs in all windows. Replaces "New private window" (use the menu). |
| **Ctrl+Alt+Shift+K** | | Kill switch: toggles `termfox.enabled`. Off means panes dissolve and Firefox's keys come back. |
| mouse | `mouse on` | Click a pane to focus it. |

- Every pane is a **real tab**, so extensions, Vimium, logins and DRM work in it as usual. Closing a pane's
  tab, or "unpaning" it (prefix then x), turns it back into a normal tab.
- The focused pane (the selected tab) has a blue frame.
- Selecting a tab that isn't in the layout hides the layout, and selecting one of its tabs brings it back.

### Windows (tmux windows)

Each termfox window is a named group of tabs with its own pane layout, like a tmux window in a session.
Switching windows hides the other windows' tabs with `gBrowser.hideTab()` and shows this window's tabs with
`gBrowser.showTab()`, then reselects the tab you were on, so the layout comes back exactly and nothing
reloads. (Firefox 157's native tab groups weren't used: a collapsed group still shows in the tab strip and can't
hold a layout.) A status line under the toolbars reads `0:mail  1:dev*  2:docs-` (`*` current, `-` last);
click an entry to switch, or set `termfox.statusbar` = false to hide it.

- New tabs (links, Ctrl+T, splits) join the current window. Closing a window's last tab kills that window and
  goes to the last one, like tmux.
- Pinned tabs can't be hidden, so they show in every window.
- Windows persist across restarts in SessionStore (`setCustomWindowValue` "termfox-windows" for names, indices
  and layouts; `setCustomTabValue` "termfox-tab" for each tab's window). Reopening a closed tab puts it back in
  its old window.
- Every Firefox window (Ctrl+N) has its own set of termfox windows and its own status line.
- The kill switch shows every tab; turning termfox back on hides the other windows again.

### Changing keys

The table lives in one place (`KEYMAP` in `TermfoxCore.sys.mjs`). Override any entry with a string pref in
`about:config`, `termfox.keys.<id>`, for example `termfox.keys.splitRight` = `Ctrl+H`, or `none` to unbind it.
Ids: `splitRight`, `splitDown`, `splitRightAlways`, `splitDownAlways`, `focusLeft|Right|Up|Down`,
`focusLeftAlways|RightAlways|UpAlways|DownAlways`, `prefix`, `prefixAlways`, `palette`, `kill`, `lastWindow`,
`selectWindow0` … `selectWindow9`. The keydown listener
picks changes up at once (or press prefix then r). Restart for the menu-style `<key>` fallback of the "always"
keys to follow. Bad values fall back to the default and are logged.

## Debug log

Every `[termfox]` line (plus caught errors with stacks) is also appended to
`%APPDATA%\Mozilla\Firefox\Profiles\termfox\termfox.log` (rotates to `termfox.log.1` at 1 MB).
The Browser Console prints `[termfox] file log: <path>` at startup. If a write fails, the console shows
`[termfox] CANNOT WRITE LOG FILE <path>` with the error, and the window shows a notification bar once.
(Before 2026-10-08 no log was ever created: the writer used IOUtils mode `"append"`, which refuses to create a
missing file. It now uses `"appendOrCreate"`.)
At startup it records the Firefox version, the background-pane painting path
(`native-splitViewBrowsers`, `switcher-patch` or `docshell-only`), the key map, each hotkey's
registration and the actor registration. Every key press that matches the keymap is logged with its decision
(taken, passed through and why, or deferred to the page), and content actors log their typing checks through the
parent. Prefix keys and reloads are logged too.

Every action logs its latency, measured from the key press (the keydown's own timestamp; for keys the page
decides, the content process's timestamp):
`split-col done in 37 ms: layout applied 1 ms, focus settled 37 ms (queue wait 0 ms, tab switch 36 ms, via keydown)`.
"Layout applied" is when the pane styles are set; "next frame N ms after the key" (a second line) is when that
layout goes to the screen. "Focus settled" is when Firefox reports the tab switch done (TabSwitched or the switcher's
state) and focus has moved. Over 50 ms the line is a WARN; `FALLBACK TIMEOUT HIT` means a wait ran out (1.5 s)
instead of ending on a Firefox event. No step polls or sleeps: the waits end on tab events. The last 50 timings are
in `Termfox.latencies` (Browser Console, in a window's context).

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
   - create a **new** profile `termfox` (`%APPDATA%\Mozilla\Firefox\Profiles\termfox`) and put the
     loader and our scripts in its `chrome\` folder. It touches no other profile.
   - write a manifest to `%LOCALAPPDATA%\termfox\install-manifest.json` for the uninstaller
3. Start it with **`launch-termfox.cmd`**, which runs `firefox.exe -P termfox -no-remote`. It can run next to your
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

Run `node --test tests/*.test.mjs`, copy the changed files from `profile\chrome\` into
`%APPDATA%\Mozilla\Firefox\Profiles\termfox\chrome\` (`...\tilefox-spike\chrome\` for an install made
before the rename), then restart Firefox with `launch-termfox.cmd`
(it passes `-purgecaches`, so the startup cache never serves old scripts). Fully quit Firefox first: if it is
still running, the new scripts don't load and no `termfox.log` appears (2026-10-08: a session started at 14:02
was still running the day-1 scripts, which had no file log). Prefix then r applies key prefs and
the stylesheet live and marks the startup cache stale, but edited `.mjs` files only load after a restart
(running modules can't be swapped in place). A full `uninstall.ps1` and `install.ps1` also works.

## Renamed from tilefox (2026-10-08)

The project was called **tilefox** until 2026-10-08. Installs made before the rename keep working:
- Their profile is called `tilefox-spike`. `launch-termfox.cmd` uses the `termfox` profile if there is
  one, else `tilefox-spike`. New installs create `termfox`.
- `uninstall.ps1` also finds the old manifest (`%LOCALAPPDATA%\tilefox\install-manifest.json`) and removes
  both the old and the new script names.
- On first start, user-set `tilefox.*` prefs (`enabled`, `statusbar`, `keys.*`) are copied once to
  `termfox.*` (logged as `prefs: copied from tilefox.*`). Change the `termfox.*` ones from then on.
  The old profile's `user.js` still sets `tilefox.enabled`, which now does nothing.
- Windows and layouts saved under the old SessionStore names (`tilefox-windows`, `tilefox-tab`) are read
  when the new ones are missing, then saved under the new names.
- The log is now `termfox.log`. An old `tilefox.log` in the profile is left as it was.
- To update an old install, copy `profile\chrome\` over the profile's `chrome\` folder and delete
  `chrome\JS\tilefox.uc.mjs`, `chrome\JS\tilefox_actor.sys.mjs`, `chrome\JS\tilefox\` and
  `chrome\CSS\tilefox.uc.css`. Otherwise both versions load.

## Files

```
install.ps1 / uninstall.ps1 / launch-termfox.cmd
profile/chrome/JS/termfox.uc.mjs                  per-window script: layout, keys, palette, kill switch
profile/chrome/JS/termfox_actor.sys.mjs           registers the JSWindowActor once per session
profile/chrome/JS/termfox/TermfoxChild.sys.mjs    content process: is the focus editable? routes Ctrl+Arrow
profile/chrome/JS/termfox/TermfoxParent.sys.mjs   forwards actor messages/log lines to the window
profile/chrome/JS/termfox/TermfoxCore.sys.mjs     pure helpers: key map, geometry, paint hook, file log
tests/core.test.mjs                               node --test tests/*.test.mjs (pure helpers)
tests/windows.test.mjs                            runs termfox.uc.mjs against a fake gBrowser + SessionStore
profile/chrome/CSS/termfox.uc.css                 pane geometry, focus frame, palette
```

## Known limits (spike)

- **One layout per termfox window.** Splitting a tab outside it starts a new layout for that window. Windows and
  layouts persist across restarts; see "Windows".
- **No resizing.** Every split is 50/50 and there are no splitters yet.
- **Firefox-internal APIs.** Panes rely on Firefox internals (present in 157.0.1 and 158): shadowing
  `gBrowser.splitViewBrowsers` so background panes keep painting, plus the `#tabbrowser-tabpanels` deck CSS.
  If `splitViewBrowsers` disappears it falls back to patching the tab switcher, then to re-activating pane
  browsers after each tab switch; `termfox.log` says which path is in use. A Firefox update can break this, and
  the kill switch is the escape hatch. Smoke-test after each Firefox update.
- **Firefox's own Split View** (tab context menu → Split View) and termfox panes don't mix. Termfox refuses to
  split a tab that's already in a native split.
- **Outside text fields**, Ctrl+Y splits instead of redo, Ctrl+H splits instead of opening History (use
  Ctrl+Shift+H, Library) and Ctrl+A opens the prefix instead of selecting the whole page. Inside fields they keep
  their normal jobs. **Alt+Left/Right** never go Back/Forward; **Alt+Up/Down** no longer open the URL-bar
  dropdown. **Ctrl+Shift+P** no longer opens a private window; use the menu.
- **Typing check needs the content actor.** If a page's actor never reported in (logged as "no content actor
  seen"), Ctrl+Y/H/Arrow there act as if you were not typing, and Ctrl+A passes through. Use Alt+Y/H/arrows.
- **Pages that use Ctrl+Arrow** themselves on non-editable content (some slide decks, games) lose it while
  that tab is a pane. Only panes are affected.
- **Ctrl+Space** may be taken by your Windows IME or input-language switcher before Firefox sees it. Use
  Ctrl+A (outside fields) as the prefix, or Ctrl+Shift+P for the palette.
- **Privileged pages** (`about:preferences`, `about:addons`) inside a pane: Ctrl+Arrow there falls through to
  chrome handling and may not move focus. Use Alt+arrows.
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
