/* tilefox core: pure helpers shared by the window script, the actors and the node tests.
 *
 * No Firefox globals at module top level, so `node --test` can import this file.
 * In Firefox it is loaded once per process with
 *   ChromeUtils.importESModule("chrome://userscripts/content/tilefox/TilefoxCore.sys.mjs")
 * so the file logger below is a single queue shared by every browser window.
 */

// ---------------------------------------------------------------- key combos

const NAMED_KEYS = {
  space: " ",
  left: "ArrowLeft", arrowleft: "ArrowLeft",
  right: "ArrowRight", arrowright: "ArrowRight",
  up: "ArrowUp", arrowup: "ArrowUp",
  down: "ArrowDown", arrowdown: "ArrowDown",
  enter: "Enter", tab: "Tab", escape: "Escape", esc: "Escape",
};

/**
 * "Ctrl+Shift+Y" -> {ctrl, alt, shift, meta, key: "y"}. Returns null if unparseable.
 * Accepts + or space as separator; "accel"/"control" mean Ctrl.
 */
export function parseCombo(str) {
  if (typeof str !== "string") {
    return null;
  }
  const parts = str.trim().split(/\s*\+\s*|\s+/).filter(Boolean);
  if (!parts.length) {
    return null;
  }
  const combo = { ctrl: false, alt: false, shift: false, meta: false, key: "" };
  for (const [i, raw] of parts.entries()) {
    const p = raw.toLowerCase();
    const last = i === parts.length - 1;
    if (!last && (p === "ctrl" || p === "control" || p === "accel")) {
      combo.ctrl = true;
    } else if (!last && p === "alt") {
      combo.alt = true;
    } else if (!last && p === "shift") {
      combo.shift = true;
    } else if (!last && (p === "meta" || p === "win" || p === "cmd")) {
      combo.meta = true;
    } else if (last) {
      if (raw.length === 1) {
        combo.key = raw.toLowerCase();
      } else if (NAMED_KEYS[p]) {
        combo.key = NAMED_KEYS[p];
      } else if (/^f([1-9]|1[0-2])$/.test(p)) {
        combo.key = p.toUpperCase();
      } else {
        return null;
      }
    } else {
      return null;
    }
  }
  return combo.key ? combo : null;
}

export function comboToString(c) {
  if (!c) {
    return "(none)";
  }
  const mods = [c.ctrl && "Ctrl", c.alt && "Alt", c.shift && "Shift", c.meta && "Meta"].filter(Boolean);
  const key = c.key === " " ? "Space" : c.key.length === 1 ? c.key.toUpperCase() : c.key;
  return [...mods, key].join("+");
}

/** Does a KeyboardEvent-like object ({key, code, ctrlKey, ...}) match the combo? */
export function comboMatches(c, ev) {
  if (!c || !ev) {
    return false;
  }
  if (!!ev.ctrlKey !== c.ctrl || !!ev.altKey !== c.alt || !!ev.shiftKey !== c.shift || !!ev.metaKey !== c.meta) {
    return false;
  }
  if (c.key.length === 1 && /[a-z0-9]/.test(c.key)) {
    // Letters/digits: match the physical key too (layout or IME may change ev.key).
    const code = /[a-z]/.test(c.key) ? "Key" + c.key.toUpperCase() : "Digit" + c.key;
    return (ev.key || "").toLowerCase() === c.key || ev.code === code;
  }
  if (c.key === " ") {
    return ev.key === " " || ev.code === "Space";
  }
  return ev.key === c.key;
}

/** fx-autoconfig Hotkeys.define() arguments for a combo. */
export function comboToHotkey(c) {
  const modifiers = [c.ctrl && "ctrl", c.alt && "alt", c.shift && "shift", c.meta && "meta"].filter(Boolean).join(" ");
  const vk = { " ": "VK_SPACE", ArrowLeft: "VK_LEFT", ArrowRight: "VK_RIGHT", ArrowUp: "VK_UP", ArrowDown: "VK_DOWN",
    Enter: "VK_RETURN", Tab: "VK_TAB", Escape: "VK_ESCAPE" };
  let key;
  if (vk[c.key]) {
    key = vk[c.key];
  } else if (c.key.length === 1) {
    key = c.key.toUpperCase();
  } else {
    key = c.key; // F1-F12
  }
  return { modifiers, key };
}

/** Matcher for Firefox's own <key> elements that a combo replaces: {key|keycode, mods}. */
export function comboToOriginalKey(c) {
  const mods = normMods([c.ctrl && "accel", c.alt && "alt", c.shift && "shift", c.meta && "meta"].filter(Boolean).join(","));
  const h = comboToHotkey(c);
  return h.key.startsWith("VK_") ? { keycode: h.key, mods } : { key: c.key.length === 1 ? c.key : h.key, mods };
}

export function normMods(s) {
  return (s || "")
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(m => (m === "control" ? "accel" : m)) // accel == Ctrl on Windows/Linux
    .sort()
    .join(",");
}

// ---------------------------------------------------------------- key map (mirrors ~/.tmux.conf)

/*
 * One table, mirroring Ryan's ~/.tmux.conf (KEYMAP-SPEC.md, 2026-10-08; last binding wins there).
 *   typing: "pass" = like tmux's vim-aware `if-shell "$is_vim" "send-keys ..."`: when focus is in an
 *                    editable field the key goes to the page/field untouched (no Firefox key is
 *                    disabled, so Ctrl+Y redo, Ctrl+H history and Ctrl+A select-all still work there).
 *           "take" = like a plain `bind -n`: always tilefox, even while typing. The Firefox <key>s on
 *                    that combo are disabled while tilefox is enabled.
 *   noActor: what to do with a "pass" key aimed at web content whose content actor never said hello
 *            (so nobody can check editability): "take" (default) or "pass".
 * Every combo can be overridden with the string pref tilefox.keys.<id> ("none" unbinds it).
 */
export const KEYMAP = [
  { id: "splitRight",       combo: "Ctrl+Y",     action: "split-row",   typing: "pass", tmux: "C-y split-window -h (vim-aware)" },
  { id: "splitDown",        combo: "Ctrl+H",     action: "split-col",   typing: "pass", tmux: "C-h split-window -v (vim-aware)" },
  { id: "splitRightAlways", combo: "Alt+Y",      action: "split-row",   typing: "take", tmux: "M-y split-window -h" },
  { id: "splitDownAlways",  combo: "Alt+H",      action: "split-col",   typing: "take", tmux: "M-h split-window -v" },
  { id: "focusLeft",        combo: "Ctrl+Left",  action: "focus-left",  typing: "pass", tmux: "C-Left select-pane -L (vim-aware)" },
  { id: "focusRight",       combo: "Ctrl+Right", action: "focus-right", typing: "pass", tmux: "C-Right select-pane -R (vim-aware)" },
  { id: "focusUp",          combo: "Ctrl+Up",    action: "focus-up",    typing: "pass", tmux: "C-Up select-pane -U (vim-aware)" },
  { id: "focusDown",        combo: "Ctrl+Down",  action: "focus-down",  typing: "pass", tmux: "C-Down select-pane -D (vim-aware)" },
  { id: "focusLeftAlways",  combo: "Alt+Left",   action: "focus-left",  typing: "take", tmux: "M-Left select-pane -L" },
  { id: "focusRightAlways", combo: "Alt+Right",  action: "focus-right", typing: "take", tmux: "M-Right select-pane -R" },
  { id: "focusUpAlways",    combo: "Alt+Up",     action: "focus-up",    typing: "take", tmux: "M-Up select-pane -U" },
  { id: "focusDownAlways",  combo: "Alt+Down",   action: "focus-down",  typing: "take", tmux: "M-Down select-pane -D" },
  { id: "prefix",           combo: "Ctrl+A",     action: "prefix",      typing: "pass", noActor: "pass", tmux: "prefix C-a" },
  { id: "prefixAlways",     combo: "Ctrl+Space", action: "prefix",      typing: "take", tmux: "(tilefox alias for the prefix)" },
  { id: "palette",          combo: "Ctrl+Shift+P", action: "palette",   typing: "take", tmux: "(tilefox only)" },
  { id: "kill",             combo: "Ctrl+Alt+Shift+K", action: "kill",  typing: "take", tmux: "(tilefox only)" },
  // Windows (tmux windows inside one Firefox window). No-prefix quick keys; the tmux defaults
  // are on the prefix (PREFIX_KEYS). Alt+digits are free on Windows: Firefox 157 binds tab
  // selection to Alt+1..9 only on Linux (XP_GNOME), elsewhere to Ctrl+1..9 (browser-sets.inc.xhtml).
  { id: "lastWindow",       combo: "Alt+L",      action: "last-window", typing: "take", tmux: "(quick key for prefix l, last-window)" },
  ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => (
    { id: `selectWindow${n}`, combo: `Alt+${n}`, action: `select-window-${n}`, typing: "take", tmux: `(quick key for prefix ${n}, select-window -t ${n})` })),
];

// After the prefix (tmux: C-a <key>). Letters match with or without Ctrl still held.
// Window keys are tmux's defaults (Ryan's tmux.conf doesn't rebind them): c n p l 0-9 , w &.
// tmux's p is previous-window, so the palette moved to f (tmux find-window).
export const PREFIX_KEYS = {
  y: "split-row", h: "split-col", r: "reload", f: "palette", x: "unpane",
  ArrowLeft: "focus-left", ArrowRight: "focus-right", ArrowUp: "focus-up", ArrowDown: "focus-down",
  c: "new-window", n: "next-window", p: "previous-window", l: "last-window",
  ",": "rename-window", w: "choose-window", "&": "kill-window",
  ...Object.fromEntries([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => [String(n), `select-window-${n}`])),
};

export const KEY_PREF_BRANCH = "tilefox.keys.";
export const keyPref = id => KEY_PREF_BRANCH + id;

/**
 * KEYMAP + prefs -> {bindings: [{id, combo, action, typing, noActor, tmux}], problems: [...]}.
 * getPref(name) returns the string pref or "". Bad values fall back to the default and are
 * reported; "none" unbinds. Two bindings on one combo: the first in the table wins (reported).
 */
export function resolveKeyMap(getPref, table = KEYMAP) {
  const bindings = [];
  const problems = [];
  const seen = new Map();
  for (const def of table) {
    const raw = (getPref(keyPref(def.id)) || "").trim();
    if (raw.toLowerCase() === "none") {
      continue;
    }
    let combo = raw ? parseCombo(raw) : null;
    if (raw && !combo) {
      problems.push(`${keyPref(def.id)}="${raw}" is not a valid key; using ${def.combo}`);
    }
    combo ||= parseCombo(def.combo);
    const name = comboToString(combo);
    if (seen.has(name)) {
      problems.push(`${def.id} and ${seen.get(name)} are both ${name}; ${seen.get(name)} wins`);
      continue;
    }
    seen.set(name, def.id);
    bindings.push({ ...def, combo, noActor: def.noActor || "take" });
  }
  return { bindings, problems };
}

/** The binding a keydown matches, or null. */
export function bindingFor(keyMap, ev) {
  return keyMap.bindings.find(b => comboMatches(b.combo, ev)) || null;
}

/** Which action (if any) a keydown triggers, ignoring typing state. */
export function actionFor(keyMap, ev) {
  return bindingFor(keyMap, ev)?.action || null;
}

export function describeKeyMap(keyMap) {
  return keyMap.bindings.map(b => `${comboToString(b.combo)}=${b.action}${b.typing === "pass" ? "(pass when typing)" : ""}`).join(", ");
}

const isFocusAction = a => a.startsWith("focus-");

/**
 * Chrome-window decision for a matched binding. ctx:
 *   inContent      the keydown is headed into a <browser> (web content)
 *   actorAlive     that browser's content actor has said hello (it can check editability)
 *   chromeEditable focus is in a chrome text field (URL bar, search bar, palette input)
 *   chromeFieldEmpty that field holds no text
 *   layoutVisible  a pane layout is on screen
 * Returns {verdict: "take"|"pass"|"defer", why}. "defer" = let the content actor decide.
 */
export function routeChromeKey(b, ctx) {
  if (b.typing === "take") {
    return { verdict: "take", why: "always-on binding" };
  }
  if (isFocusAction(b.action) && !ctx.layoutVisible) {
    return { verdict: "pass", why: "no pane layout on screen" };
  }
  if (ctx.inContent) {
    if (ctx.actorAlive) {
      return { verdict: "defer", why: "content actor checks for an editable field" };
    }
    return b.noActor === "pass"
      ? { verdict: "pass", why: "no content actor seen, cannot check typing; passing through" }
      : { verdict: "take", why: "chrome fallback: no content actor seen" };
  }
  if (ctx.chromeEditable && !ctx.chromeFieldEmpty) {
    return { verdict: "pass", why: "typing in a chrome text field" };
  }
  if (ctx.chromeEditable) {
    // A fresh pane's about:newtab focuses its empty URL bar; Ctrl+H there must split again,
    // not open the History sidebar. An empty field has nothing to word-jump or redo.
    return { verdict: "take", why: "chrome text field is empty" };
  }
  return { verdict: "take", why: "not typing" };
}

/**
 * Content-actor decision for a matched binding. ctx: {editable, isPane}.
 * "take" bindings normally never reach content (chrome took them); here they are a fallback.
 */
export function routeContentKey(b, ctx) {
  if (b.typing === "take") {
    return { verdict: "take", why: "always-on binding reached content (chrome listener missed it)" };
  }
  if (isFocusAction(b.action) && !ctx.isPane) {
    return { verdict: "pass", why: "this tab is not a pane" };
  }
  if (ctx.editable) {
    return { verdict: "pass", why: "typing in an editable field" };
  }
  return { verdict: "take", why: "not typing" };
}

/** Prefix-mode key -> action (tmux: C-a <key>). Modifier-only presses return null. */
export function prefixActionFor(ev) {
  if (["Control", "Shift", "Alt", "Meta"].includes(ev.key)) {
    return null;
  }
  return PREFIX_KEYS[ev.key] || PREFIX_KEYS[(ev.key || "").toLowerCase()]
    || (/^Key[A-Z]$/.test(ev.code || "") ? PREFIX_KEYS[ev.code.slice(3).toLowerCase()] : undefined)
    || (/^(Digit|Numpad)[0-9]$/.test(ev.code || "") && !ev.shiftKey ? PREFIX_KEYS[ev.code.slice(-1)] : undefined) || null;
}

// ---------------------------------------------------------------- one press, one action

/**
 * One key press can reach tilefox by up to three paths: the chrome window's capture keydown
 * listener (always first), the reserved XUL <key> of an fx-autoconfig Hotkey (same dispatch,
 * after the listener), and the content actor (async IPC, which can arrive after later presses).
 * The ledger records what the keydown listener decided for each press, and each echo from the
 * other paths is matched to its press. This replaces a 250 ms "same action" window, which
 * dropped a fast second press and ran a slow content echo twice.
 */
export class PressLedger {
  constructor({ now = () => Date.now(), ttlMs = 3000 } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.presses = [];
    this.seq = 0;
  }

  /** verdict: "take" (chrome ran it) | "defer" (content actor decides) | "pass". */
  record({ action, verdict, browserId = null, repeat = false }) {
    this.prune();
    const p = { seq: ++this.seq, action, verdict, browserId, repeat, t: this.now(), matched: false, xulSeen: false };
    this.presses.push(p);
    return p;
  }

  prune() {
    const cut = this.now() - this.ttlMs;
    this.presses = this.presses.filter(p => p.t >= cut);
  }

  /** The reserved XUL <key> fired. It runs in the same dispatch as the keydown listener. */
  xulKey(action) {
    const p = this.presses[this.presses.length - 1];
    if (p && p.action === action && !p.xulSeen && (p.verdict === "take" || p.repeat)) {
      p.xulSeen = true;
      return { run: false, why: p.repeat ? `key repeat of press #${p.seq}` : `press #${p.seq} already ran from the keydown listener` };
    }
    return { run: true, why: "the keydown listener did not see this press" };
  }

  /** A content actor asks for an action. via: "content" (pass-when-typing key) | "content-fallback". */
  content(action, browserId, via) {
    this.prune();
    const open = this.presses.filter(p => !p.matched && !p.repeat && p.action === action);
    if (via === "content-fallback") {
      const taken = open.find(p => p.verdict === "take");
      if (taken) {
        taken.matched = true;
        return { run: false, why: `duplicate of press #${taken.seq} (chrome already ran it)` };
      }
      return { run: true, why: "the chrome listener missed this press" };
    }
    const deferred = open.find(p => p.verdict === "defer" && p.browserId === browserId);
    if (deferred) {
      deferred.matched = true;
      return { run: true, why: `press #${deferred.seq} was deferred to content` };
    }
    const taken = open.find(p => p.verdict === "take" && p.browserId === browserId);
    if (taken) {
      taken.matched = true;
      return { run: false, why: `duplicate of press #${taken.seq} (the chrome fallback already ran it)` };
    }
    return { run: true, why: "no chrome record of this press" };
  }
}

/**
 * Runs actions one at a time. A job may be async (a split waits for its tab and the tab switch);
 * the next job starts only when it settles, or after timeoutMs so one stuck job can't wedge keys.
 */
export class ActionQueue {
  constructor({ timeoutMs = 4000, onError = () => {}, setTimer, clearTimer } = {}) {
    this.timeoutMs = timeoutMs;
    this.onError = onError;
    this.setTimer = setTimer || ((f, ms) => setTimeout(f, ms));
    this.clearTimer = clearTimer || (id => clearTimeout(id));
    this.tail = Promise.resolve();
    this.pending = 0;
  }

  push(label, fn) {
    this.pending++;
    const run = async () => {
      let timer;
      try {
        await Promise.race([
          Promise.resolve().then(fn),
          new Promise((_, reject) => {
            timer = this.setTimer(() => reject(new Error(`${label} still running after ${this.timeoutMs} ms; moving on`)), this.timeoutMs);
          }),
        ]);
      } catch (e) {
        try { this.onError(e, label); } catch (e2) {}
      } finally {
        this.clearTimer(timer);
        this.pending--;
      }
    };
    this.tail = this.tail.then(run);
    return this.tail;
  }

  /** Resolves when every queued job has finished. */
  idle() {
    return this.tail;
  }
}

// ---------------------------------------------------------------- layout geometry

/** Layout tree ({tab} leaf | {dir:"row"|"col", a, b, ratio}) -> Map(tab -> {x,y,w,h} in %). */
export function layoutRects(node, x = 0, y = 0, w = 100, h = 100, out = new Map()) {
  if (!node) {
    return out;
  }
  if (node.tab) {
    out.set(node.tab, { x, y, w, h });
    return out;
  }
  if (node.dir === "row") {
    const wa = w * node.ratio;
    layoutRects(node.a, x, y, wa, h, out);
    layoutRects(node.b, x + wa, y, w - wa, h, out);
  } else {
    const ha = h * node.ratio;
    layoutRects(node.a, x, y, w, ha, out);
    layoutRects(node.b, x, y + ha, w, h - ha, out);
  }
  return out;
}

/** Nearest pane in direction dir ("left"|"right"|"up"|"down") from `current`, or null. */
export function findNeighbour(rects, current, dir, { wrap = true } = {}) {
  const cur = rects.get(current);
  if (!cur) {
    return null;
  }
  const eps = 0.01;
  let best = null;
  let bestScore = Infinity;
  for (const [tab, r] of rects) {
    if (tab === current) {
      continue;
    }
    let gap;
    let overlap;
    if (dir === "left" || dir === "right") {
      gap = dir === "left" ? cur.x - (r.x + r.w) : r.x - (cur.x + cur.w);
      overlap = Math.min(cur.y + cur.h, r.y + r.h) - Math.max(cur.y, r.y);
    } else {
      gap = dir === "up" ? cur.y - (r.y + r.h) : r.y - (cur.y + cur.h);
      overlap = Math.min(cur.x + cur.w, r.x + r.w) - Math.max(cur.x, r.x);
    }
    if (gap < -eps || overlap <= eps) {
      continue;
    }
    const score = gap * 1000 - overlap; // nearest first, then most-overlapping
    if (score < bestScore) {
      bestScore = score;
      best = tab;
    }
  }
  return best ?? (wrap ? wrapNeighbour(rects, current, cur, dir) : null);
}

// tmux select-pane wraps at the layout edge: Up from the top row goes to the bottom
// row, and so on. Candidates touch the opposite edge; pick the most overlap with the
// current pane's column (up/down) or row (left/right), ties to the leftmost/topmost.
function wrapNeighbour(rects, current, cur, dir) {
  const eps = 0.01;
  const all = [...rects.values()];
  const edge = {
    up: Math.max(...all.map(r => r.y + r.h)),
    down: Math.min(...all.map(r => r.y)),
    left: Math.max(...all.map(r => r.x + r.w)),
    right: Math.min(...all.map(r => r.x)),
  }[dir];
  let best = null;
  let bestOverlap = eps;
  let bestPos = Infinity;
  for (const [tab, r] of rects) {
    if (tab === current) {
      continue;
    }
    const horizontal = dir === "left" || dir === "right";
    const side = { up: r.y + r.h, down: r.y, left: r.x + r.w, right: r.x }[dir];
    if (Math.abs(side - edge) > eps) {
      continue;
    }
    const overlap = horizontal
      ? Math.min(cur.y + cur.h, r.y + r.h) - Math.max(cur.y, r.y)
      : Math.min(cur.x + cur.w, r.x + r.w) - Math.max(cur.x, r.x);
    // Ties (equal overlap) go to the leftmost pane when wrapping up/down, the topmost
    // when wrapping left/right (Ryan, 2026-10-08: "Ctrl+Up at the top should go to the bottom... on the left").
    const pos = horizontal ? r.y : r.x;
    if (overlap <= eps) {
      continue;
    }
    if (overlap > bestOverlap + eps || (Math.abs(overlap - bestOverlap) <= eps && pos < bestPos)) {
      bestOverlap = overlap;
      bestPos = pos;
      best = tab;
    }
  }
  return best;
}

export function fuzzy(q, text) {
  if (!q) {
    return 1;
  }
  q = q.toLowerCase();
  text = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let streak = 0;
  for (const ch of q) {
    const idx = text.indexOf(ch, ti);
    if (idx < 0) {
      return 0;
    }
    streak = idx === ti ? streak + 1 : 0;
    const wordStart = idx === 0 || /[\s\-_./:]/.test(text[idx - 1]);
    score += 1 + streak * 2 + (wordStart ? 3 : 0);
    ti = idx + 1;
  }
  return score;
}

// ---------------------------------------------------------------- windows (tmux windows)

export const WINDOWS_VALUE = "tilefox-windows"; // SessionStore window value: the WindowSet as JSON
export const TAB_VALUE = "tilefox-tab";         // SessionStore tab value: {w: window id, u: tab uid}

export const randomId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

/** Layout tree -> plain JSON with tab uids ({t} | {d, r, a, b}). */
export function serializeLayout(node, uidOf) {
  if (!node) {
    return null;
  }
  if (node.tab) {
    return { t: uidOf(node.tab) };
  }
  return { d: node.dir, r: node.ratio, a: serializeLayout(node.a, uidOf), b: serializeLayout(node.b, uidOf) };
}

/** JSON -> layout tree. Missing tabs drop out and their sibling takes their place. */
export function deserializeLayout(obj, tabOf) {
  if (!obj || typeof obj !== "object") {
    return null;
  }
  if ("t" in obj) {
    const tab = tabOf(obj.t);
    return tab ? { tab } : null;
  }
  const a = deserializeLayout(obj.a, tabOf);
  const b = deserializeLayout(obj.b, tabOf);
  if (!a || !b) {
    return a || b;
  }
  return { dir: obj.d === "col" ? "col" : "row", a, b, ratio: typeof obj.r === "number" ? obj.r : 0.5 };
}

/** tmux automatic-rename stand-in: first host label ("mail.google.com" -> "mail"), else the tab title. */
export function autoWindowName(host, label) {
  const h = (host || "").replace(/^www\d*\./, "");
  const name = h ? h.split(".")[0] : (label || "").trim();
  return (name || "new").slice(0, 16);
}

/**
 * The tmux windows of one Firefox window. Tabs are opaque keys, so node tests can use strings.
 * A window: {id, index, name, auto, root, active}. root = pane layout tree (or null),
 * active = the tab to show when switching back. Indices start at 0 (tmux base-index 0) and
 * stay put when another window is killed (tmux default, no renumber-windows).
 */
export class WindowSet {
  constructor({ newId = randomId } = {}) {
    this.windows = [];
    this.current = null;
    this.last = null;
    this.owner = new Map(); // tab -> window id
    this.newId = newId;
  }

  get(id) {
    return this.windows.find(w => w.id === id) || null;
  }

  byIndex(i) {
    return this.windows.find(w => w.index === i) || null;
  }

  freeIndex() {
    let i = 0;
    while (this.byIndex(i)) {
      i++;
    }
    return i;
  }

  add({ id, index, name = "", root = null } = {}) {
    const w = { id: id ?? this.newId(), index: index ?? this.freeIndex(), name, auto: !name, root, active: null };
    this.windows.push(w);
    this.windows.sort((a, b) => a.index - b.index);
    this.current ??= w.id;
    return w;
  }

  /** Make id current; the previous current becomes "last" (tmux last-window). */
  select(id) {
    if (!this.get(id) || id === this.current) {
      return false;
    }
    if (this.get(this.current)) {
      this.last = this.current;
    }
    this.current = id;
    return true;
  }

  /** Remove a window (its tabs lose their owner). If it was current, last (else next) takes over. */
  remove(id) {
    const i = this.windows.findIndex(w => w.id === id);
    if (i < 0) {
      return this.current;
    }
    this.windows.splice(i, 1);
    for (const [tab, w] of this.owner) {
      if (w === id) {
        this.owner.delete(tab);
      }
    }
    if (this.current === id) {
      this.current = this.get(this.last)?.id ?? (this.windows[i] || this.windows[i - 1] || null)?.id ?? null;
      this.last = null;
    } else if (this.last === id) {
      this.last = null;
    }
    return this.current;
  }

  /** Next (+1) / previous (-1) window by index, wrapping (tmux next-window / previous-window). */
  step(dir) {
    const n = this.windows.length;
    if (!n) {
      return null;
    }
    const i = this.windows.findIndex(w => w.id === this.current);
    return this.windows[((i < 0 ? 0 : i) + dir + n) % n].id;
  }

  assign(tab, id) {
    this.owner.set(tab, id);
  }

  unassign(tab) {
    this.owner.delete(tab);
  }

  ownerOf(tab) {
    return this.owner.get(tab) ?? null;
  }

  tabsOf(id, allTabs) {
    return allTabs.filter(t => this.owner.get(t) === id);
  }

  /** tmux status line: "0:mail  1:dev*  2:docs-" (* current, - last). */
  status() {
    return this.windows.map(w => `${w.index}:${w.name}${w.id === this.current ? "*" : w.id === this.last ? "-" : ""}`).join("  ");
  }

  toJSON(uidOf) {
    return {
      v: 1,
      current: this.current,
      last: this.last,
      windows: this.windows.map(w => ({
        id: w.id, index: w.index, name: w.auto ? "" : w.name,
        layout: serializeLayout(w.root, uidOf), active: w.active ? uidOf(w.active) : null,
      })),
    };
  }

  /** Rebuild from toJSON() output. tabOf(uid) -> live tab or null. Tab ownership is restored separately. */
  static fromJSON(data, tabOf, opts) {
    const ws = new WindowSet(opts);
    const used = new Set();
    for (const w of Array.isArray(data?.windows) ? data.windows : []) {
      if (typeof w?.id !== "string" || ws.get(w.id)) {
        continue;
      }
      const index = Number.isInteger(w.index) && w.index >= 0 && !used.has(w.index) ? w.index : undefined;
      const nw = ws.add({ id: w.id, index, name: typeof w.name === "string" ? w.name : "" });
      used.add(nw.index);
      const root = deserializeLayout(w.layout, tabOf);
      nw.root = root && !root.tab ? root : null; // a single pane is just a tab
      nw.active = w.active ? tabOf(w.active) : null;
    }
    ws.current = ws.get(data?.current) ? data.current : (ws.windows[0]?.id ?? null);
    ws.last = ws.get(data?.last) && data.last !== ws.current ? data.last : null;
    return ws;
  }
}

/** Parse a TAB_VALUE string -> {w, u} or null. */
export function parseTabValue(str) {
  try {
    const v = JSON.parse(str || "null");
    return v && typeof v.u === "string" ? { w: typeof v.w === "string" ? v.w : null, u: v.u } : null;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------- background-pane painting

/**
 * Keep background pane browsers active (painting). Firefox only paints the selected tab
 * unless AsyncTabSwitcher.shouldDeactivateDocShell(browser) is false. Paths, best first:
 *  1. "native-splitViewBrowsers": shadow gBrowser.splitViewBrowsers (Firefox's own Split View
 *     list, read by shouldDeactivateDocShell). Present in 157.0.1 and 158.
 *     https://searchfox.org/firefox-release/source/browser/components/tabbrowser/AsyncTabSwitcher.sys.mjs (shouldDeactivateDocShell)
 *  2. "switcher-patch": wrap gBrowser._getSwitcher() and patch each switcher's
 *     shouldDeactivateDocShell (a release without splitViewBrowsers).
 *  3. "docshell-only": nothing to hook; the window re-activates pane browsers after every
 *     tab switch (TabSwitchDone), which it does on every path as a safety net.
 * getPaneBrowsers() returns the browsers to keep active. Returns the path name.
 */
export function installPaintHook(gb, getPaneBrowsers, note = () => {}) {
  let proto = Object.getPrototypeOf(gb);
  let desc = null;
  while (proto && !desc) {
    desc = Object.getOwnPropertyDescriptor(proto, "splitViewBrowsers");
    proto = Object.getPrototypeOf(proto);
  }
  if (desc?.get) {
    const nativeGet = desc.get;
    Object.defineProperty(gb, "splitViewBrowsers", {
      configurable: true,
      get() {
        const list = [...nativeGet.call(this)];
        for (const b of getPaneBrowsers()) {
          if (!list.includes(b)) {
            list.push(b);
          }
        }
        return list;
      },
    });
    return "native-splitViewBrowsers";
  }
  note("gBrowser.splitViewBrowsers missing, trying _getSwitcher");

  if (typeof gb._getSwitcher === "function") {
    const native = gb._getSwitcher;
    gb._getSwitcher = function (...args) {
      const sw = native.apply(this, args);
      if (sw && !sw.__tilefox && typeof sw.shouldDeactivateDocShell === "function") {
        const orig = sw.shouldDeactivateDocShell;
        sw.shouldDeactivateDocShell = function (browser) {
          return getPaneBrowsers().includes(browser) ? false : orig.call(this, browser);
        };
        sw.__tilefox = true;
      }
      return sw;
    };
    return "switcher-patch";
  }
  note("gBrowser._getSwitcher missing too");
  return "docshell-only";
}

// ---------------------------------------------------------------- editability (content side)

const TEXT_INPUT_TYPES = new Set([
  "text", "search", "url", "tel", "email", "password", "number",
  "date", "datetime-local", "month", "time", "week", "",
]);

export function isEditable(el, doc) {
  if (doc && doc.designMode === "on") {
    return true;
  }
  if (!el) {
    return false;
  }
  const tag = el.localName;
  if (tag === "textarea") {
    return !el.readOnly && !el.disabled;
  }
  if (tag === "input") {
    const type = (el.getAttribute("type") || "").toLowerCase();
    return TEXT_INPUT_TYPES.has(type) && !el.readOnly && !el.disabled;
  }
  if (tag === "select") {
    return true; // arrows mean something there too
  }
  if (el.isContentEditable) {
    return true;
  }
  // ARIA widgets that take arrow keys (custom editors, comboboxes, sliders...).
  const role = el.getAttribute?.("role");
  if (role && /^(textbox|combobox|searchbox|spinbutton|slider|grid|tree|listbox|menu|menubar|tablist)$/.test(role)) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- file log

export const LOG_FILE = "tilefox.log";
export const LOG_MAX_BYTES = 1024 * 1024;

export function formatArg(a) {
  if (a instanceof Error || (a && typeof a === "object" && "stack" in a && "message" in a)) {
    return `${a.name || "Error"}: ${a.message}${a.stack ? "\n" + String(a.stack).trimEnd() : ""}`;
  }
  if (typeof a === "string") {
    return a;
  }
  try {
    return JSON.stringify(a);
  } catch (e) {
    return String(a);
  }
}

/**
 * Append-only log file with one rotation (tilefox.log -> tilefox.log.1 above maxBytes).
 * io: {writeUTF8(path, text, {mode}), stat(path) -> {size}, move(from, to), exists(path)} (IOUtils subset).
 * Writes are serialized through one promise chain.
 *
 * Mode must be "appendOrCreate". IOUtils' "append" refuses to create a missing file
 * (dom/chrome-webidl/IOUtils.webidl, WriteMode), so with "append" the very first write failed and
 * no tilefox.log ever appeared (the bug up to 2026-10-08). A failed write is now reported loudly
 * to the Browser Console (the first one with the path, then every 50th) and kept in
 * logger.lastError, and onWriteError(e, path) is called once so the window can show it.
 */
export function createFileLogger({ io, dir, joinPath, maxBytes = LOG_MAX_BYTES, consoleObj = console, now = () => new Date(), onWriteError = () => {} }) {
  const path = joinPath(dir, LOG_FILE);
  const rotated = joinPath(dir, LOG_FILE + ".1");
  let chain = Promise.resolve();
  let size = null; // bytes, learned from stat on first write
  let failures = 0;
  const state = { lastError: null, failures: 0 };

  async function rotateIfNeeded(adding) {
    if (size === null) {
      try {
        size = (await io.exists(path)) ? (await io.stat(path)).size : 0;
      } catch (e) {
        size = 0;
      }
    }
    if (size + adding > maxBytes) {
      await io.move(path, rotated, { noOverwrite: false });
      size = 0;
    }
  }

  function write(level, args) {
    const line = `${now().toISOString()} ${level} ${args.map(formatArg).join(" ")}\n`;
    chain = chain.then(async () => {
      const bytes = new TextEncoder().encode(line).length;
      await rotateIfNeeded(bytes);
      await io.writeUTF8(path, line, { mode: "appendOrCreate" });
      size += bytes;
    }).catch(e => {
      failures++;
      state.failures = failures;
      state.lastError = e;
      size = null; // re-stat next time
      if (failures === 1 || failures % 50 === 0) {
        consoleObj.error(`[tilefox] CANNOT WRITE LOG FILE ${path} (failure #${failures}):`, e);
      }
      if (failures === 1) {
        try { onWriteError(e, path); } catch (e2) {}
      }
    });
    return chain;
  }

  return {
    path,
    get lastError() { return state.lastError; },
    get failures() { return state.failures; },
    setOnWriteError(fn) { onWriteError = fn; if (state.lastError) { try { fn(state.lastError, path); } catch (e) {} } },
    log: (...a) => {
      consoleObj.log("[tilefox]", ...a);
      return write("INFO", a);
    },
    warn: (...a) => {
      consoleObj.warn("[tilefox]", ...a);
      return write("WARN", a);
    },
    error: (...a) => {
      consoleObj.error("[tilefox]", ...a);
      return write("ERROR", a);
    },
    flush: () => chain,
  };
}

// ---------------------------------------------------------------- window instances

/*
 * One TilefoxWindow per Firefox window registers here. This module is a shared system module,
 * so the window script and TilefoxParent (the parent actor) get the same registry. The actor
 * used to read `browser.ownerGlobal.Tilefox`. On Firefox 157 that came back empty although the
 * window script had set `window.Tilefox`, so every content-routed action and hello was dropped
 * (log: "actor action but no Tilefox in window"). The registry doesn't depend on a window
 * property being visible across compartments. It also matches by browser element, so it keeps
 * working when `ownerGlobal` is not the same object the window script saw.
 */
const instances = new Set();

/** Registers a window instance ({win, gBrowser}). Returns the unregister function. */
export function registerInstance(inst) {
  instances.add(inst);
  return () => instances.delete(inst);
}

export function instanceForWindow(win) {
  for (const i of instances) {
    if (win && i.win === win) {
      return i;
    }
  }
  return null;
}

/** The instance whose window holds this <browser> (by ownerGlobal, else by tab lookup). */
export function instanceForBrowser(browser) {
  if (!browser) {
    return null;
  }
  let owner = null;
  try { owner = browser.ownerGlobal; } catch (e) {}
  const byWin = instanceForWindow(owner);
  if (byWin) {
    return byWin;
  }
  for (const i of instances) {
    try {
      if (i.gBrowser?.getTabForBrowser(browser)) {
        return i;
      }
    } catch (e) {}
  }
  return null;
}

export const instanceCount = () => instances.size;

// Process-wide logger for Firefox. Content processes can't write the profile, so actors
// forward their lines to the parent ("Tilefox:Log") instead of using this.
let sharedLogger = null;
export function getLogger() {
  if (sharedLogger) {
    return sharedLogger;
  }
  /* global IOUtils, PathUtils, Services */
  const parentProcess = typeof Services !== "undefined"
    && Services.appinfo?.processType === Services.appinfo?.PROCESS_TYPE_DEFAULT;
  if (parentProcess && typeof IOUtils !== "undefined" && typeof PathUtils !== "undefined") {
    sharedLogger = createFileLogger({
      io: IOUtils,
      dir: PathUtils.profileDir,
      joinPath: (...p) => PathUtils.join(...p),
    });
    console.log(`[tilefox] file log: ${sharedLogger.path}`);
  } else {
    sharedLogger = {
      path: null,
      log: (...a) => console.log("[tilefox]", ...a),
      warn: (...a) => console.warn("[tilefox]", ...a),
      error: (...a) => console.error("[tilefox]", ...a),
      flush: () => Promise.resolve(),
      lastError: null,
      failures: 0,
      setOnWriteError() {},
    };
  }
  return sharedLogger;
}
