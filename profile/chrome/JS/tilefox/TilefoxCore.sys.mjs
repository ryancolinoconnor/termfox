/* tilefox core: pure helpers shared by the window script, the actors and the node tests.
 *
 * No Firefox globals at module top level, so `node --test` can import this file.
 * In Firefox it is loaded once per process with
 *   ChromeUtils.importESModule("chrome://userscripts/content/tilefox/TilefoxCore.sys.mjs")
 * so the file logger below is a single queue shared by every browser window.
 */

// ---------------------------------------------------------------- key combos

// Configurable through about:config (string prefs). Ryan, 2026-10-08: Ctrl+Y = right, Ctrl+H = below.
export const KEY_PREFS = {
  splitRight: "tilefox.keys.splitRight",
  splitDown: "tilefox.keys.splitDown",
};
export const DEFAULT_KEYS = {
  splitRight: "Ctrl+Y",
  splitDown: "Ctrl+H",
};

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

/**
 * Resolve the configured split keys. getPref(name) returns the string pref or "".
 * Bad values fall back to the defaults and are reported in `problems`.
 */
export function resolveKeyMap(getPref) {
  const out = { problems: [] };
  for (const name of Object.keys(DEFAULT_KEYS)) {
    const raw = (getPref(KEY_PREFS[name]) || "").trim();
    let combo = raw ? parseCombo(raw) : null;
    if (raw && !combo) {
      out.problems.push(`${KEY_PREFS[name]}="${raw}" is not a valid key; using ${DEFAULT_KEYS[name]}`);
    }
    if (!combo) {
      combo = parseCombo(DEFAULT_KEYS[name]);
    }
    out[name] = combo;
  }
  if (comboToString(out.splitRight) === comboToString(out.splitDown)) {
    out.problems.push(`splitRight and splitDown are both ${comboToString(out.splitRight)}; splitDown wins`);
  }
  return out;
}

// split-row = new pane to the RIGHT (side by side); split-col = new pane BELOW.
export const SPLIT_ACTIONS = { splitRight: "split-row", splitDown: "split-col" };

/** Which split action (if any) a keydown triggers. */
export function splitActionFor(keyMap, ev) {
  if (comboMatches(keyMap.splitDown, ev)) {
    return SPLIT_ACTIONS.splitDown;
  }
  if (comboMatches(keyMap.splitRight, ev)) {
    return SPLIT_ACTIONS.splitRight;
  }
  return null;
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
export function findNeighbour(rects, current, dir) {
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
 * Writes are serialized through one promise chain; failures go to the console only.
 */
export function createFileLogger({ io, dir, joinPath, maxBytes = LOG_MAX_BYTES, consoleObj = console, now = () => new Date() }) {
  const path = joinPath(dir, LOG_FILE);
  const rotated = joinPath(dir, LOG_FILE + ".1");
  let chain = Promise.resolve();
  let size = null; // bytes, learned from stat on first write

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
      await io.writeUTF8(path, line, { mode: "append" });
      size += bytes;
    }).catch(e => consoleObj.error("[tilefox] log write failed", e));
    return chain;
  }

  return {
    path,
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
  } else {
    sharedLogger = {
      path: null,
      log: (...a) => console.log("[tilefox]", ...a),
      warn: (...a) => console.warn("[tilefox]", ...a),
      error: (...a) => console.error("[tilefox]", ...a),
      flush: () => Promise.resolve(),
    };
  }
  return sharedLogger;
}
