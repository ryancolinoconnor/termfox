# Keymap spec: mirror Ryan's ~/.tmux.conf (2026-10-08)

Source: /home/ryano/.tmux.conf. Where a key is bound twice, the last binding wins.

| Key | tmux | tilefox behaviour |
|---|---|---|
| Ctrl+Y | split-window -h (passes through in vim) | new pane to the RIGHT. Passes through to the page when focus is in an editable field |
| Ctrl+H | split-window -v (passes through in vim) | new pane BELOW. Passes through when focus is in an editable field |
| Alt+Y | split-window -h | new pane RIGHT, always (even while typing) |
| Alt+H | split-window -v | new pane BELOW, always |
| Ctrl+Left/Right/Up/Down | select-pane L/R/U/D (passes through in vim) | focus the pane in that direction. Passes through when focus is in an editable field (so word-jump works) |
| Alt+Left/Right/Up/Down | select-pane L/R/U/D | focus the pane in that direction, ALWAYS. Suppresses Firefox's Alt+Left/Right Back/Forward; use Vimium H/L or the toolbar for those |
| Prefix | C-a | Ctrl+A acts as the prefix only when focus is NOT in an editable field (select-all still works while typing). Ctrl+Space is an always-on alias |
| prefix r | reload config | reload the tilefox scripts and config, then show a brief "Reloaded" toast |
| prefix f | find-window | palette (moved from prefix p on 2026-10-08, because tmux's p is previous-window) |
| mouse on | click a pane to focus it | click a pane to focus it |

Implement this as one keymap table that prefs can override. Document it in README and TEST.md as "mirrors your tmux.conf". Log every key decision to tilefox.log.

## Windows (added 2026-10-08)

tmux windows inside one Firefox window. tmux.conf doesn't rebind any window key, so these are tmux's defaults
(base-index 0, no renumber-windows). Each window is a named group of tabs with its own pane layout.

| Key | tmux default | tilefox behaviour |
|---|---|---|
| prefix c | new-window | new window with one new tab (URL bar focused) |
| prefix n / p | next-window / previous-window | next / previous window by index, wrapping |
| prefix l | last-window | back to the previous window; press again to toggle |
| prefix 0-9 | select-window -t N | window N; "can't find window: N" if there's none |
| prefix , | rename-window | small input; empty = automatic name (first label of the tab's host) |
| prefix w | choose-tree -w | fuzzy list of windows |
| prefix & | kill-window (confirm y/n) | closes the window's tabs after y. The only window can't be killed |
| Alt+L | (tilefox quick key) | last-window, no prefix. Pref `tilefox.keys.lastWindow` |
| Alt+0 ... Alt+9 | (tilefox quick key) | select-window N, no prefix. Prefs `tilefox.keys.selectWindow0` ... `selectWindow9`. Free on Windows: Firefox 157 binds Alt+1..9 to tabs only on Linux (`NUM_SELECT_TAB_MODIFIER`, browser-sets.inc.xhtml); on Windows its tab keys are Ctrl+1..9, which stay Firefox's |
| status line | status on | `0:mail  1:dev*  2:docs-` under the toolbars, `*` current, `-` last. Click to switch. Pref `tilefox.statusbar` (bool) |
| palette | | lists `window:name` entries as well as panes and tabs |
