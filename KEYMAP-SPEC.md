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
| prefix p | (n/a) | palette |
| mouse on | click a pane to focus it | click a pane to focus it |

Implement this as one keymap table that prefs can override. Document it in README and TEST.md as "mirrors your tmux.conf". Log every key decision to tilefox.log.
