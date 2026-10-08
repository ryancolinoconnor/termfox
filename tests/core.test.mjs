// node --test tests/   (pure helpers from TilefoxCore.sys.mjs; no Firefox needed)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCombo, comboToString, comboMatches, comboToHotkey, comboToOriginalKey, resolveKeyMap,
  bindingFor, actionFor, routeChromeKey, routeContentKey, prefixActionFor, keyPref, KEYMAP,
  layoutRects, findNeighbour, fuzzy, isEditable, installPaintHook, createFileLogger,
} from "../profile/chrome/JS/tilefox/TilefoxCore.sys.mjs";

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
  assert.equal(prefixActionFor(ev("p")), "palette");
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
  assert.equal(keyPref("splitRight"), "tilefox.keys.splitRight"); // pref names from the first spike still work
});

test("bad pref values fall back to defaults; clashes are reported", () => {
  const k = resolveKeyMap(n => (n === keyPref("splitDown") ? "Ctrl+Banana" : ""));
  assert.equal(comboToString(bindingFor(k, ev("h", ctrl)).combo), "Ctrl+H");
  assert.equal(k.problems.length, 1);
  assert.match(k.problems[0], /tilefox\.keys\.splitDown/);
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
  assert.equal(findNeighbour(r, "A", "left"), null);
  assert.equal(findNeighbour(r, "missing", "left"), null);
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
    writeUTF8: async (p, text, { mode }) => { files.set(p, (mode === "append" ? files.get(p) || "" : "") + text); },
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
  const text = io.files.get("/prof/tilefox.log");
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
  assert.ok(io.files.has("/p/tilefox.log.1"));
  assert.ok(new TextEncoder().encode(io.files.get("/p/tilefox.log")).length <= 200);
  assert.match(io.files.get("/p/tilefox.log"), /line 9/);
});
