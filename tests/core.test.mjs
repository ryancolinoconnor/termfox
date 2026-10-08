// node --test tests/   (pure helpers from TermfoxCore.sys.mjs; no Firefox needed)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCombo, comboToString, comboMatches, comboToHotkey, comboToOriginalKey, resolveKeyMap,
  bindingFor, actionFor, routeChromeKey, routeContentKey, prefixActionFor, keyPref, KEYMAP,
  layoutRects, findNeighbour, fuzzy, isEditable, installPaintHook, createFileLogger,
  WindowSet, serializeLayout, deserializeLayout, autoWindowName, parseTabValue, PREFIX_KEYS,
  PressLedger, routeChromeKey as routeChrome,
  formatError, formatLine, sanitizeLogText, redactText, validateActorMessage, routeActorMessage, RateLimiter,
  CONTENT_ACTIONS, LOG_ARG_MAX, LOG_LINE_MAX,
} from "../profile/chrome/JS/termfox/TermfoxCore.sys.mjs";

const ev = (key, mods = {}, code) => ({
  key, code: code ?? (key.length === 1 ? "Key" + key.toUpperCase() : key),
  ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods,
});
const ctrl = { ctrlKey: true };

const alt = { altKey: true };
const km = resolveKeyMap(() => "");
const b = (key, mods, code) => bindingFor(km, ev(key, mods, code));

// ---- key map: mirrors ~/.tmux.conf (KEYMAP-SPEC.md, 2026-10-08)

test("default key map mirrors tmux.conf", () => {
  assert.deepEqual(km.problems, []);
  const table = Object.fromEntries(km.bindings.map(x => [comboToString(x.combo), `${x.action}/${x.typing}`]));
  assert.deepEqual(table, {
    "Ctrl+Y": "split-row/pass", // C-y split-window -h, vim-aware
    "Ctrl+H": "split-col/pass", // C-h split-window -v, vim-aware
    "Alt+Y": "split-row/take", // M-y split-window -h (last M-y binding in tmux.conf)
    "Alt+H": "split-col/take", // M-h split-window -v (last M-h binding)
    "Ctrl+ArrowLeft": "focus-left/pass", "Ctrl+ArrowRight": "focus-right/pass",
    "Ctrl+ArrowUp": "focus-up/pass", "Ctrl+ArrowDown": "focus-down/pass",
    "Alt+ArrowLeft": "focus-left/take", "Alt+ArrowRight": "focus-right/take",
    "Alt+ArrowUp": "focus-up/take", "Alt+ArrowDown": "focus-down/take",
    "Ctrl+A": "prefix/pass", // prefix C-a, only when not typing
    "Ctrl+Space": "prefix/take", // always-on alias
    "Ctrl+Shift+P": "palette/take",
    "Ctrl+Alt+Shift+K": "kill/take",
    "Alt+L": "last-window/take", // quick key for prefix l
    ...Object.fromEntries([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => [`Alt+${n}`, `select-window-${n}/take`])),
  });
});

test("key events resolve to the right binding (exact modifiers)", () => {
  assert.equal(b("y", ctrl).action, "split-row");
  assert.equal(b("h", ctrl).action, "split-col");
  assert.equal(b("y", alt).action, "split-row");
  assert.equal(b("h", alt).typing, "take");
  assert.equal(b("ArrowLeft", ctrl).action, "focus-left");
  assert.equal(b("ArrowDown", alt).action, "focus-down");
  assert.equal(b("a", ctrl).action, "prefix");
  assert.equal(b(" ", ctrl, "Space").action, "prefix");
  assert.equal(b("ArrowLeft", { ctrlKey: true, shiftKey: true }), null); // select word stays native
  assert.equal(b("h", { ctrlKey: true, shiftKey: true }), null);
  assert.equal(b("a", { ctrlKey: true, altKey: true }), null);
  assert.equal(b("h"), null);
  assert.equal(actionFor(km, ev("y", alt)), "split-row");
});

// ctx helpers for the chrome-side router
const content = (extra = {}) => ({ inContent: true, actorAlive: true, chromeEditable: false, layoutVisible: true, ...extra });
const chrome = (extra = {}) => ({ inContent: false, actorAlive: false, chromeEditable: false, layoutVisible: true, ...extra });
const v = (r) => r.verdict;

test("Ctrl+Y / Ctrl+H: split when not typing, pass through when typing", () => {
  for (const key of ["y", "h"]) {
    const x = b(key, ctrl);
    assert.equal(v(routeChromeKey(x, content())), "defer"); // content actor checks the field
    assert.equal(v(routeContentKey(x, { editable: true, isPane: true })), "pass");
    assert.equal(v(routeContentKey(x, { editable: false, isPane: false })), "take"); // splits from a plain tab too
    assert.equal(v(routeChromeKey(x, chrome({ chromeEditable: true }))), "pass"); // URL bar
    assert.equal(v(routeChromeKey(x, chrome())), "take");
    assert.equal(v(routeChromeKey(x, content({ actorAlive: false }))), "take"); // fallback
  }
});

test("Alt+Y / Alt+H always split, even while typing", () => {
  for (const key of ["y", "h"]) {
    const x = b(key, alt);
    assert.equal(v(routeChromeKey(x, content())), "take");
    assert.equal(v(routeChromeKey(x, chrome({ chromeEditable: true }))), "take");
    assert.equal(v(routeContentKey(x, { editable: true, isPane: true })), "take");
  }
});

test("Ctrl+Arrow selects a pane, passes through when typing or with no layout", () => {
  const x = b("ArrowRight", ctrl);
  assert.equal(v(routeChromeKey(x, content())), "defer");
  assert.equal(v(routeContentKey(x, { editable: true, isPane: true })), "pass"); // word-jump
  assert.equal(v(routeContentKey(x, { editable: false, isPane: true })), "take");
  assert.equal(v(routeContentKey(x, { editable: false, isPane: false })), "pass");
  assert.equal(v(routeChromeKey(x, chrome({ chromeEditable: true }))), "pass");
  assert.equal(v(routeChromeKey(x, chrome({ layoutVisible: false }))), "pass");
});

test("Alt+Arrow always selects a pane (Back/Forward suppressed)", () => {
  const x = b("ArrowLeft", alt);
  assert.equal(v(routeChromeKey(x, content())), "take");
  assert.equal(v(routeChromeKey(x, chrome({ chromeEditable: true }))), "take");
  assert.equal(v(routeChromeKey(x, chrome({ layoutVisible: false }))), "take");
  assert.deepEqual(comboToOriginalKey(x.combo), { keycode: "VK_LEFT", mods: "alt" }); // goBackKb
});

test("Ctrl+A is the prefix only when not typing; Ctrl+Space always", () => {
  const a = b("a", ctrl);
  assert.equal(v(routeChromeKey(a, content())), "defer");
  assert.equal(v(routeContentKey(a, { editable: true, isPane: false })), "pass"); // select all
  assert.equal(v(routeContentKey(a, { editable: false, isPane: false })), "take");
  assert.equal(v(routeChromeKey(a, chrome({ chromeEditable: true }))), "pass");
  assert.equal(v(routeChromeKey(a, content({ actorAlive: false }))), "pass"); // can't check: keep select-all
  const sp = b(" ", ctrl, "Space");
  assert.equal(v(routeChromeKey(sp, chrome({ chromeEditable: true }))), "take");
  assert.equal(v(routeChromeKey(sp, content())), "take");
});

test("prefix keys: y h arrows r p x, with or without Ctrl held", () => {
  assert.equal(prefixActionFor(ev("r")), "reload");
  assert.equal(prefixActionFor(ev("r", ctrl)), "reload");
  assert.equal(prefixActionFor(ev("R", { shiftKey: true })), "reload");
  assert.equal(prefixActionFor(ev("y")), "split-row");
  assert.equal(prefixActionFor(ev("\b", ctrl, "KeyH")), "split-col"); // Ctrl+H as backspace char
  assert.equal(prefixActionFor(ev("ArrowUp")), "focus-up");
  assert.equal(prefixActionFor(ev("p")), "previous-window"); // tmux default; palette moved to f
  assert.equal(prefixActionFor(ev("f")), "palette");
  assert.equal(prefixActionFor(ev("x")), "unpane");
  assert.equal(prefixActionFor(ev("Control")), null);
  assert.equal(prefixActionFor(ev("q")), null);
});

test("prefs override the table: rebind, swap, unbind", () => {
  const prefs = { [keyPref("splitRight")]: "Ctrl+H", [keyPref("splitDown")]: "ctrl + y", [keyPref("prefix")]: "none" };
  const k = resolveKeyMap(n => prefs[n] || "");
  assert.deepEqual(k.problems, []);
  assert.equal(actionFor(k, ev("h", ctrl)), "split-row");
  assert.equal(actionFor(k, ev("y", ctrl)), "split-col");
  assert.equal(actionFor(k, ev("a", ctrl)), null);
  assert.equal(actionFor(k, ev(" ", ctrl, "Space")), "prefix");
  assert.equal(keyPref("splitRight"), "termfox.keys.splitRight"); // pref names from the first spike still work
});

test("bad pref values fall back to defaults; clashes are reported", () => {
  const k = resolveKeyMap(n => (n === keyPref("splitDown") ? "Ctrl+Banana" : ""));
  assert.equal(comboToString(bindingFor(k, ev("h", ctrl)).combo), "Ctrl+H");
  assert.equal(k.problems.length, 1);
  assert.match(k.problems[0], /termfox\.keys\.splitDown/);
  const clash = resolveKeyMap(n => (n === keyPref("palette") ? "Ctrl+Y" : ""));
  assert.equal(actionFor(clash, ev("y", ctrl)), "split-row"); // table order wins
  assert.match(clash.problems[0], /palette and splitRight are both Ctrl\+Y/);
});

test("every table entry parses and has a tmux note", () => {
  for (const d of KEYMAP) {
    assert.ok(parseCombo(d.combo), d.combo);
    assert.ok(["pass", "take"].includes(d.typing), d.id);
    assert.ok(d.tmux, d.id);
  }
});

test("split-row puts the new pane to the right, split-col below", () => {
  const right = layoutRects({ dir: "row", a: { tab: "A" }, b: { tab: "B" }, ratio: 0.5 });
  assert.deepEqual(right.get("B"), { x: 50, y: 0, w: 50, h: 100 });
  const down = layoutRects({ dir: "col", a: { tab: "A" }, b: { tab: "B" }, ratio: 0.5 });
  assert.deepEqual(down.get("B"), { x: 0, y: 50, w: 100, h: 50 });
});

test("letters match by physical key code too (layout / IME changes ev.key)", () => {
  const c = parseCombo("Ctrl+H");
  assert.ok(comboMatches(c, ev("\b", ctrl, "KeyH"))); // Windows Ctrl+H can surface as backspace char
  assert.ok(comboMatches(c, ev("H", ctrl)));
  assert.ok(!comboMatches(c, ev("h", { ctrlKey: true, altKey: true })));
});

test("parseCombo / comboToString / hotkey args", () => {
  assert.deepEqual(parseCombo("Ctrl+Shift+P"), { ctrl: true, alt: false, shift: true, meta: false, key: "p" });
  assert.equal(parseCombo("Ctrl+"), null);
  assert.equal(parseCombo("Shift+Ctrl"), null);
  assert.equal(comboToString(parseCombo("accel space")), "Ctrl+Space");
  assert.ok(comboMatches(parseCombo("Ctrl+Space"), ev(" ", ctrl, "Space")));
  assert.deepEqual(comboToHotkey(parseCombo("Ctrl+H")), { modifiers: "ctrl", key: "H" });
  assert.deepEqual(comboToHotkey(parseCombo("Ctrl+Alt+Shift+K")), { modifiers: "ctrl alt shift", key: "K" });
  assert.deepEqual(comboToHotkey(parseCombo("Ctrl+Space")), { modifiers: "ctrl", key: "VK_SPACE" });
  assert.deepEqual(comboToOriginalKey(parseCombo("Ctrl+H")), { key: "h", mods: "accel" });
  assert.deepEqual(comboToOriginalKey(parseCombo("Ctrl+Shift+P")), { key: "p", mods: "accel,shift" });
  assert.deepEqual(comboToOriginalKey(parseCombo("Ctrl+Space")), { keycode: "VK_SPACE", mods: "accel" });
  assert.deepEqual(comboToHotkey(parseCombo("Alt+Left")), { modifiers: "alt", key: "VK_LEFT" });
  assert.deepEqual(comboToHotkey(parseCombo("Alt+Y")), { modifiers: "alt", key: "Y" });
});

// ---- focus navigation geometry

test("neighbour lookup in a 3-pane layout", () => {
  // A | (B over C)
  const tree = { dir: "row", ratio: 0.5, a: { tab: "A" }, b: { dir: "col", ratio: 0.5, a: { tab: "B" }, b: { tab: "C" } } };
  const r = layoutRects(tree);
  assert.equal(findNeighbour(r, "A", "right"), "B"); // B and C tie on gap; B listed first
  assert.equal(findNeighbour(r, "B", "down"), "C");
  assert.equal(findNeighbour(r, "C", "up"), "B");
  assert.equal(findNeighbour(r, "C", "left"), "A");
  assert.equal(findNeighbour(r, "A", "left", { wrap: false }), null);
  assert.equal(findNeighbour(r, "missing", "left"), null);
});

test("wrap ties go leftmost (up/down) and topmost (left/right)", () => {
  // Full-width top pane T over a bottom row split evenly: L | R. Ctrl+Up from T -> bottom-left.
  const t = { dir: "col", ratio: 0.5, a: { tab: "T" }, b: { dir: "row", ratio: 0.5, a: { tab: "L" }, b: { tab: "R" } } };
  const r = layoutRects(t);
  assert.equal(findNeighbour(r, "T", "up"), "L");
  // Same with R listed first in the map, so the pick doesn't depend on order
  const rev = new Map([...r].reverse());
  assert.equal(findNeighbour(rev, "T", "up"), "L");
  // Mirror: bottom-full B under a top row L | R; Ctrl+Down from B -> top-left
  const t2 = { dir: "col", ratio: 0.5, a: { dir: "row", ratio: 0.5, a: { tab: "L" }, b: { tab: "R" } }, b: { tab: "B" } };
  assert.equal(findNeighbour(new Map([...layoutRects(t2)].reverse()), "B", "down"), "L");
  // Full-height left pane F beside a right column U over D: Ctrl+Left from F -> top-right (U)
  const t3 = { dir: "row", ratio: 0.5, a: { tab: "F" }, b: { dir: "col", ratio: 0.5, a: { tab: "U" }, b: { tab: "D" } } };
  assert.equal(findNeighbour(new Map([...layoutRects(t3)].reverse()), "F", "left"), "U");
  // Clear overlap winner still beats the tie-break: L 30% | R 70% under T -> R
  const t4 = { dir: "col", ratio: 0.5, a: { tab: "T" }, b: { dir: "row", ratio: 0.3, a: { tab: "L" }, b: { tab: "R" } } };
  assert.equal(findNeighbour(layoutRects(t4), "T", "up"), "R");
});

test("findNeighbour wraps at the layout edge like tmux", () => {
  // A | (B over C)
  const t1 = { dir: "row", ratio: 0.5, a: { tab: "A" }, b: { dir: "col", ratio: 0.5, a: { tab: "B" }, b: { tab: "C" } } };
  const r1 = layoutRects(t1);
  assert.equal(findNeighbour(r1, "B", "up"), "C"); // top wraps to bottom, same column
  assert.equal(findNeighbour(r1, "C", "down"), "B"); // bottom wraps to top
  assert.equal(findNeighbour(r1, "B", "right"), "A"); // right edge wraps to left, same row
  assert.equal(findNeighbour(r1, "C", "right"), "A");
  assert.equal(findNeighbour(r1, "A", "up"), null); // A spans the column; nothing else in it
  assert.equal(findNeighbour(r1, "A", "down"), null);

  // (A over B) | C with A taller: C right wraps to whichever left pane overlaps C's row most
  const t2 = { dir: "row", ratio: 0.5, a: { dir: "col", ratio: 0.7, a: { tab: "A" }, b: { tab: "B" } }, b: { tab: "C" } };
  const r2 = layoutRects(t2);
  assert.equal(findNeighbour(r2, "C", "right"), "A"); // A overlaps 70% of C's row, B 30%

  // Top: wide T spanning both columns. Bottom: L (30%) | R (70%).
  // Down from R (bottom row) wraps to T, the only pane on the top edge.
  const t3 = { dir: "col", ratio: 0.5, a: { tab: "T" }, b: { dir: "row", ratio: 0.3, a: { tab: "L" }, b: { tab: "R" } } };
  const r3 = layoutRects(t3);
  assert.equal(findNeighbour(r3, "R", "down"), "T");
  assert.equal(findNeighbour(r3, "T", "up"), "R"); // T wraps to the bottom pane overlapping its column most (R 70% > L 30%)
  assert.equal(findNeighbour(r3, "L", "left"), "R"); // left edge wraps to right, same row

  // 3 rows: up from the top pane goes to the bottom one, not the middle
  const t4 = { dir: "col", ratio: 0.33, a: { tab: "X" }, b: { dir: "col", ratio: 0.5, a: { tab: "Y" }, b: { tab: "Z" } } };
  const r4 = layoutRects(t4);
  assert.equal(findNeighbour(r4, "X", "up"), "Z");
  assert.equal(findNeighbour(r4, "Z", "down"), "X");

  // single pane: no wrap target
  assert.equal(findNeighbour(layoutRects({ tab: "S" }), "S", "up"), null);
});

test("fuzzy", () => {
  assert.ok(fuzzy("nf", "Netflix netflix.com") > 0);
  assert.equal(fuzzy("zz", "Netflix"), 0);
  assert.equal(fuzzy("", "x"), 1);
});

test("isEditable", () => {
  const el = (localName, attrs = {}, extra = {}) => ({ localName, getAttribute: n => attrs[n] ?? null, ...extra });
  assert.ok(isEditable(el("input", { type: "text" })));
  assert.ok(!isEditable(el("input", { type: "checkbox" })));
  assert.ok(!isEditable(el("textarea", {}, { readOnly: true })));
  assert.ok(isEditable(el("div", {}, { isContentEditable: true })));
  assert.ok(isEditable(el("div", { role: "textbox" })));
  assert.ok(!isEditable(el("div")));
  assert.ok(isEditable(null, { designMode: "on" }));
});

// ---- background painting: Firefox 157.0.1 / 158 / fallbacks

test("157/158: splitViewBrowsers getter is shadowed per instance and includes panes", () => {
  class Tabbrowser {
    #active = ["native"];
    get splitViewBrowsers() { return [...this.#active]; }
  }
  const gb = new Tabbrowser();
  const other = new Tabbrowser();
  const panes = ["p1", "p2"];
  assert.equal(installPaintHook(gb, () => panes), "native-splitViewBrowsers");
  assert.deepEqual(gb.splitViewBrowsers, ["native", "p1", "p2"]);
  assert.deepEqual(gb.splitViewBrowsers, ["native", "p1", "p2"]); // no accumulation across calls
  assert.deepEqual(other.splitViewBrowsers, ["native"]); // other windows untouched
});

test("no splitViewBrowsers: switcher's shouldDeactivateDocShell is patched", () => {
  const sw = { shouldDeactivateDocShell: b => b !== "printpreview" };
  const gb = { _getSwitcher: () => sw };
  const notes = [];
  assert.equal(installPaintHook(gb, () => ["p1"], m => notes.push(m)), "switcher-patch");
  const s = gb._getSwitcher();
  assert.equal(s.shouldDeactivateDocShell("p1"), false);
  assert.equal(s.shouldDeactivateDocShell("other"), true);
  assert.equal(s.shouldDeactivateDocShell("printpreview"), false);
  gb._getSwitcher(); // patching twice must not double-wrap
  assert.equal(s.shouldDeactivateDocShell("other"), true);
  assert.equal(notes.length, 1);
});

test("neither hook: docshell-only path", () => {
  assert.equal(installPaintHook({}, () => []), "docshell-only");
});

// ---- file log

function fakeIO() {
  const files = new Map();
  return {
    files,
    exists: async p => files.has(p),
    stat: async p => ({ size: new TextEncoder().encode(files.get(p)).length }),
    move: async (a, b) => { files.set(b, files.get(a)); files.delete(a); },
    // Like IOUtils: "append" refuses to create a missing file, "appendOrCreate" creates it.
    writeUTF8: async (p, text, { mode }) => {
      if (mode === "append" && !files.has(p)) {
        throw new Error(`NotFoundError: Could not open the file at ${p} to append`);
      }
      files.set(p, (mode === "append" || mode === "appendOrCreate" ? files.get(p) || "" : "") + text);
    },
  };
}
const quiet = { log() {}, warn() {}, error() {} };

test("logger appends lines with errors and stacks", async () => {
  const io = fakeIO();
  const log = createFileLogger({ io, dir: "/prof", joinPath: (...p) => p.join("/"), consoleObj: quiet });
  log.log("startup", { v: "157.0.1" });
  const e = new Error("boom");
  log.error("caught", e);
  await log.flush();
  const text = io.files.get("/prof/termfox.log");
  assert.match(text, /INFO startup {"v":"157.0.1"}/);
  assert.match(text, /ERROR caught Error: boom\n[\s\S]*core\.test\.mjs/);
});

test("logger rotates at maxBytes", async () => {
  const io = fakeIO();
  const log = createFileLogger({ io, dir: "/p", joinPath: (...p) => p.join("/"), maxBytes: 200, consoleObj: quiet });
  for (let i = 0; i < 10; i++) {
    log.log("line", i, "x".repeat(40));
  }
  await log.flush();
  assert.ok(io.files.has("/p/termfox.log.1"));
  assert.ok(new TextEncoder().encode(io.files.get("/p/termfox.log")).length <= 200);
  assert.match(io.files.get("/p/termfox.log"), /line 9/);
});

test("logger creates the file on first write (regression: IOUtils 'append' never creates it)", async () => {
  const io = fakeIO();
  const log = createFileLogger({ io, dir: "/fresh", joinPath: (...p) => p.join("/"), consoleObj: quiet });
  log.log("first line");
  await log.flush();
  assert.match(io.files.get("/fresh/termfox.log"), /INFO first line/);
  assert.equal(log.failures, 0);
});

test("logger surfaces write failures to the console and the window, once", async () => {
  const errors = [];
  const seen = [];
  const io = { ...fakeIO(), writeUTF8: async () => { throw new Error("NotAllowedError: denied"); } };
  const log = createFileLogger({
    io, dir: "/ro", joinPath: (...p) => p.join("/"),
    consoleObj: { log() {}, warn() {}, error: (...a) => errors.push(a.map(String).join(" ")) },
  });
  log.setOnWriteError((e, path) => seen.push(path));
  log.log("a");
  log.log("b");
  await log.flush();
  assert.equal(log.failures, 2);
  assert.match(String(log.lastError), /denied/);
  assert.equal(errors.filter(e => e.includes("cannot write the log file")).length, 1);
  assert.ok(!errors.some(e => e.includes("/ro")), "no profile path on the console");
  assert.deepEqual(seen, ["/ro/termfox.log"]);
});

// ---- windows (tmux windows inside one Firefox window)

test("window prefix keys are tmux's defaults", () => {
  assert.equal(prefixActionFor(ev("c")), "new-window");
  assert.equal(prefixActionFor(ev("n")), "next-window");
  assert.equal(prefixActionFor(ev("p")), "previous-window");
  assert.equal(prefixActionFor(ev("l")), "last-window");
  assert.equal(prefixActionFor(ev("w")), "choose-window");
  assert.equal(prefixActionFor(ev(",", {}, "Comma")), "rename-window");
  assert.equal(prefixActionFor(ev("&", { shiftKey: true }, "Digit7")), "kill-window");
  assert.equal(prefixActionFor(ev("0", {}, "Digit0")), "select-window-0");
  assert.equal(prefixActionFor(ev("7", {}, "Digit7")), "select-window-7");
  assert.equal(prefixActionFor(ev("3", {}, "Numpad3")), "select-window-3");
  assert.equal(prefixActionFor(ev("c", ctrl)), "new-window"); // Ctrl still held from Ctrl+A
  assert.equal(Object.keys(PREFIX_KEYS).filter(k => /^[0-9]$/.test(k)).length, 10);
});

test("Alt+L and Alt+digits pick windows without the prefix; prefs can rebind them", () => {
  assert.equal(b("l", alt).action, "last-window");
  assert.equal(b("3", alt, "Digit3").action, "select-window-3");
  assert.equal(b("3", ctrl, "Digit3"), null); // Ctrl+3 stays Firefox's tab key on Windows
  const k = resolveKeyMap(n => ({ [keyPref("lastWindow")]: "Alt+B", [keyPref("selectWindow9")]: "none" })[n] || "");
  assert.equal(bindingFor(k, ev("b", alt)).action, "last-window");
  assert.equal(bindingFor(k, ev("l", alt)), null);
  assert.equal(bindingFor(k, ev("9", alt, "Digit9")), null);
});

const seq = () => { let i = 0; return () => `w${i++}`; };

test("WindowSet: new, select, last, next/previous, index lookup", () => {
  const ws = new WindowSet({ newId: seq() });
  const w0 = ws.add();
  const w1 = ws.add();
  const w2 = ws.add({ name: "docs" });
  assert.deepEqual([w0.index, w1.index, w2.index], [0, 1, 2]);
  assert.equal(ws.current, "w0");
  ws.select("w1");
  assert.equal(ws.last, "w0");
  ws.select(ws.last); // prefix l toggles back and forth
  assert.deepEqual([ws.current, ws.last], ["w0", "w1"]);
  ws.select(ws.last);
  assert.deepEqual([ws.current, ws.last], ["w1", "w0"]);
  assert.equal(ws.step(1), "w2");
  ws.select("w2");
  assert.equal(ws.step(1), "w0"); // wraps
  assert.equal(ws.step(-1), "w1");
  assert.equal(ws.byIndex(2).id, "w2");
  assert.equal(ws.byIndex(5), null);
  assert.equal(ws.select("w2"), false); // already current: last unchanged
  assert.equal(ws.last, "w1");
});

test("WindowSet: status line marks current * and last -", () => {
  const ws = new WindowSet({ newId: seq() });
  ws.add({ name: "mail" });
  ws.add({ name: "dev" });
  ws.add({ name: "docs" });
  ws.select("w1");
  assert.equal(ws.status(), "0:mail-  1:dev*  2:docs");
});

test("WindowSet: killing keeps indices (no renumber) and falls back to last", () => {
  const ws = new WindowSet({ newId: seq() });
  ws.add(); ws.add(); ws.add();
  ws.select("w2");
  ws.select("w1");
  ws.assign("tabA", "w1");
  assert.equal(ws.remove("w1"), "w2"); // current killed -> last
  assert.equal(ws.ownerOf("tabA"), null);
  assert.equal(ws.last, null);
  assert.deepEqual(ws.windows.map(w => w.index), [0, 2]);
  assert.equal(ws.add().index, 1); // lowest free index, like tmux
  ws.remove("w2"); // no last: the neighbour by index takes over
  assert.equal(ws.current, "w3");
});

test("WindowSet: tab membership", () => {
  const ws = new WindowSet({ newId: seq() });
  ws.add(); ws.add();
  ws.assign("a", "w0"); ws.assign("b", "w1"); ws.assign("c", "w0");
  assert.deepEqual(ws.tabsOf("w0", ["a", "b", "c", "d"]), ["a", "c"]);
  ws.unassign("a");
  assert.deepEqual(ws.tabsOf("w0", ["a", "b", "c"]), ["c"]);
});

test("layouts serialize by tab uid and drop closed tabs", () => {
  const root = { dir: "row", ratio: 0.5, a: { tab: "A" }, b: { dir: "col", ratio: 0.5, a: { tab: "B" }, b: { tab: "C" } } };
  const json = serializeLayout(root, t => "u" + t);
  assert.deepEqual(json, { d: "row", r: 0.5, a: { t: "uA" }, b: { d: "col", r: 0.5, a: { t: "uB" }, b: { t: "uC" } } });
  const all = { uA: "A", uB: "B", uC: "C" };
  assert.deepEqual(deserializeLayout(JSON.parse(JSON.stringify(json)), u => all[u] || null), root);
  // C was closed while Firefox was down: B takes the whole right half
  assert.deepEqual(deserializeLayout(json, u => ({ uA: "A", uB: "B" })[u] || null),
    { dir: "row", ratio: 0.5, a: { tab: "A" }, b: { tab: "B" } });
  assert.equal(deserializeLayout(null, () => null), null);
});

test("WindowSet round-trips through JSON (SessionStore window value)", () => {
  const ws = new WindowSet({ newId: seq() });
  const w0 = ws.add({ name: "mail" });
  const w1 = ws.add();
  w1.root = { dir: "row", ratio: 0.5, a: { tab: "A" }, b: { tab: "B" } };
  w1.active = "B";
  w0.active = "M";
  ws.select("w1");
  const uid = t => "u" + t;
  const data = JSON.parse(JSON.stringify(ws.toJSON(uid)));
  const back = WindowSet.fromJSON(data, u => ({ uA: "A", uB: "B", uM: "M" })[u] || null);
  assert.deepEqual([back.current, back.last], ["w1", "w0"]);
  assert.equal(back.status(), "0:mail-  1:*"); // auto names are filled in by the window script
  assert.deepEqual(back.get("w1").root, w1.root);
  assert.equal(back.get("w1").active, "B");
  assert.equal(back.get("w0").name, "mail");
  assert.equal(back.get("w1").auto, true); // auto-named windows keep following their tab
  // garbage in -> empty set, no throw
  assert.equal(WindowSet.fromJSON({ windows: [{}, null, { id: 3 }] }, () => null).windows.length, 0);
});

test("auto window names and tab values", () => {
  assert.equal(autoWindowName("mail.google.com", "Inbox"), "mail");
  assert.equal(autoWindowName("www.github.com", "x"), "github");
  assert.equal(autoWindowName("", "New Tab"), "New Tab");
  assert.equal(autoWindowName("", ""), "new");
  assert.deepEqual(parseTabValue('{"w":"w1","u":"abc"}'), { w: "w1", u: "abc" });
  assert.equal(parseTabValue("not json"), null);
  assert.equal(parseTabValue(""), null);
});

// ---- one press, one action

test("PressLedger matches each echo to its own press", () => {
  let t = 0;
  const L = new PressLedger({ now: () => t, ttlMs: 3000 });
  // keydown took it; the reserved XUL key fires in the same dispatch: ignored, once
  L.record({ action: "split-col", verdict: "take" });
  assert.equal(L.xulKey("split-col").run, false);
  assert.equal(L.xulKey("split-col").run, true); // a second XUL fire is a press the listener missed
  // two quick deferred presses: both echoes run, in order, even after the selection moved
  L.record({ action: "split-col", verdict: "defer", browserId: 7 });
  L.record({ action: "split-col", verdict: "defer", browserId: 7 });
  assert.equal(L.content("split-col", 7, "content").run, true);
  assert.equal(L.content("split-col", 7, "content").run, true);
  // chrome fallback took it and the page saw it too
  L.record({ action: "split-row", verdict: "take", browserId: 9 });
  assert.equal(L.content("split-row", 9, "content").run, false);
  // repeats never match an echo; XUL repeat is swallowed
  L.record({ action: "split-col", verdict: "take", repeat: true });
  assert.equal(L.xulKey("split-col").run, false);
  // records expire; with no live record of a trusted press, content can't run anything
  L.record({ action: "split-row", verdict: "defer", browserId: 4 });
  t += 5000;
  assert.equal(L.content("split-row", 4, "content").run, false);
});

test("empty chrome text field: Ctrl+H/Y/Arrow are taken, not passed", () => {
  const ctrlH = b("h", ctrl);
  assert.equal(routeChrome(ctrlH, { chromeEditable: true, chromeFieldEmpty: false, layoutVisible: true }).verdict, "pass");
  assert.equal(routeChrome(ctrlH, { chromeEditable: true, chromeFieldEmpty: true, layoutVisible: true }).verdict, "take");
});

// ---- security hardening (audit 2026-10-08)

function fakeIOWithRemove() {
  const io = fakeIO();
  io.remove = async p => { io.files.delete(p); };
  return io;
}

test("M1: file logging is off unless enabled; private contexts never reach the disk", async () => {
  const io = fakeIOWithRemove();
  let debug = false;
  const log = createFileLogger({ io, dir: "/p", joinPath: (...p) => p.join("/"), consoleObj: quiet, fileEnabled: () => debug });
  log.log("split-col done in 3 ms");
  await log.flush();
  assert.equal(io.files.size, 0, "termfox.debugLog defaults to off: nothing on disk");
  debug = true;
  log.forContext({ private: true }).log("from a private window");
  log.forContext({ private: false }).log("normal");
  await log.flush();
  const text = io.files.get("/p/termfox.log");
  assert.match(text, /INFO normal/);
  assert.doesNotMatch(text, /private window/);
});

test("M1: log strings are sanitized and bounded; errors keep only redacted message and stack frames", () => {
  assert.equal(sanitizeLogText("a\nb\rc\u0007d\u2028e"), "a?b?c?d?e");
  assert.equal(sanitizeLogText("x".repeat(1000)).length, LOG_ARG_MAX + 1);
  const line = formatLine("INFO", ["y".repeat(LOG_ARG_MAX), "z".repeat(LOG_ARG_MAX), ..."0123456789".split("").map(() => "w".repeat(LOG_ARG_MAX))], new Date(0));
  assert.ok(line.length < LOG_LINE_MAX + 60);
  assert.equal(line.split("\n").length, 2, "one line, no injected newlines");
  const e = new Error('Could not open C:\\Users\\someone\\AppData\\termfox.log for "hunter2" at https://mail.example.com/inbox?x=1 me@example.com 4111111111111111');
  e.stack = "write@chrome://userscripts/content/termfox/TermfoxCore.sys.mjs:10:5\nevil\"payload@file:///C:/Users/someone/secret/thing.js:1:2\n@https://bank.example/app.js:3:4";
  const out = formatError(e);
  for (const leak of ["someone", "hunter2", "mail.example.com", "me@example.com", "4111111111111111", "bank.example", "payload"]) {
    assert.ok(!out.includes(leak), `${leak} leaked: ${out}`);
  }
  assert.match(out, /chrome:\/\/userscripts\/content\/termfox\/TermfoxCore\.sys\.mjs:10:5/);
  assert.match(out, /thing\.js:1:2/);
  assert.equal(redactText("open /home/someone/x and 'quoted'"), "open <path> and <str>");
});

test("M1: clear log removes termfox and pre-rename tilefox log files", async () => {
  const io = fakeIOWithRemove();
  for (const f of ["termfox.log", "termfox.log.1", "tilefox.log", "other.txt"]) { io.files.set("/p/" + f, "x"); }
  const log = createFileLogger({ io, dir: "/p", joinPath: (...p) => p.join("/"), consoleObj: quiet });
  const removed = await log.clear();
  assert.deepEqual(removed.sort(), ["termfox.log", "termfox.log.1", "tilefox.log"]);
  assert.deepEqual([...io.files.keys()], ["/p/other.txt"]);
});

test("M3: actor schema: allowlisted actions, never kill, known via, finite t, no extra or free-text fields", () => {
  const ok = (n, d) => validateActorMessage(n, d).ok;
  assert.ok(ok("Termfox:Action", { action: "split-col", via: "content", t: 1 }));
  assert.ok(ok("Termfox:Action", { action: "select-window-3", via: "content-fallback", t: 1 }));
  assert.ok(!CONTENT_ACTIONS.has("kill"));
  assert.equal(validateActorMessage("Termfox:Action", { action: "kill", via: "content", t: 1 }).why, "kill is chrome-only");
  for (const bad of [
    { action: "reload", via: "content", t: 1 }, // prefix-only, not a content key
    { action: "clear-log", via: "content", t: 1 },
    { action: "x".repeat(5000), via: "content", t: 1 },
    { action: "split-col", via: "keydown", t: 1 },
    { action: "split-col", via: "content", t: NaN },
    { action: "split-col", via: "content", t: Infinity },
    { action: "split-col", via: "content", t: "1" },
    { action: "split-col", via: "content" },
    { action: "split-col", via: "content", t: 1, extra: true },
    { action: ["split-col"], via: "content", t: 1 },
  ]) {
    assert.ok(!ok("Termfox:Action", bad), JSON.stringify(bad).slice(0, 80));
  }
  assert.ok(!ok("Termfox:Action", "split-col"));
  assert.ok(ok("Termfox:Hello", {}));
  assert.ok(!ok("Termfox:Hello", { where: "https://example.com" }), "no origin in hello");
  assert.ok(ok("Termfox:Log", { ev: "take", action: "split-col" }));
  assert.ok(!ok("Termfox:Log", { msg: "free text\nINJECTED" }));
  assert.ok(!ok("Termfox:Log", { ev: "anything" }));
  assert.ok(!ok("Termfox:Eval", {}));
});

test("M3: routeActorMessage never hands kill or malformed actions to the window, and rate-limits logging", () => {
  const calls = [];
  const inst = { onActorAction: (d) => calls.push(["action", d]), onActorHello: () => calls.push(["hello"]) };
  const lines = [];
  const log = { forContext: () => ({ log: m => lines.push(m), warn: m => lines.push(m), error: m => lines.push(m) }) };
  let t = 0;
  const limiter = new RateLimiter({ burst: 3, perSec: 1, now: () => t });
  const browser = { browserId: 5 };
  const route = (name, data, priv = false) => routeActorMessage({ name, data, browser, priv, inst, log, limiter });
  assert.equal(route("Termfox:Action", { action: "kill", via: "content", t: 1 }), "rejected");
  assert.equal(route("Termfox:Action", { action: "split-col", via: "content", t: 1, x: 1 }), "rejected");
  assert.equal(calls.length, 0);
  assert.equal(route("Termfox:Action", { action: "split-col", via: "content", t: 1 }), "action");
  assert.deepEqual(calls[0], ["action", { action: "split-col", via: "content", t: 1 }]);
  t += 10000; // the two rejection warnings above used tokens too; refill
  lines.length = 0;
  for (let i = 0; i < 50; i++) { route("Termfox:Log", { ev: "take" }); }
  assert.equal(lines.length, 3, "a flood of log events is cut to the burst");
  t += 2000;
  route("Termfox:Log", { ev: "take" });
  assert.equal(lines.length, 4, "refills over time");
  lines.length = 0;
  t += 10000;
  route("Termfox:Log", { ev: "take" }, true);
  route("Termfox:Action", { action: "kill" }, true);
  assert.equal(lines.length, 0, "private contexts log nothing");
});

test("M3: content can only spend a trusted press the parent saw, for the same browser and action", () => {
  const L = new PressLedger({ now: () => 0 });
  assert.equal(L.content("split-col", 7, "content").run, false, "no press: refused");
  assert.equal(L.content("split-col", 7, "content-fallback").run, false);
  L.record({ action: "split-col", verdict: "defer", browserId: 7 });
  assert.equal(L.content("split-col", 8, "content").run, false, "another browser can't spend it");
  assert.equal(L.content("split-row", 7, "content").run, false, "another action can't spend it");
  assert.equal(L.content("split-col", 7, "content").run, true);
  assert.equal(L.content("split-col", 7, "content").run, false, "spent once");
  L.record({ action: "prefix", verdict: "pass", browserId: 7 }); // chrome couldn't check typing
  assert.equal(L.content("prefix", 7, "content-fallback").run, false);
  assert.equal(L.content("prefix", 7, "content").run, true, "the actor may take a passed press");
  L.record({ action: "palette", verdict: "take", browserId: null }); // chrome focus, no browser
  assert.equal(L.content("palette", null, "content-fallback").run, false);
});
