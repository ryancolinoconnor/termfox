// node --test tests/   (pure helpers from TilefoxCore.sys.mjs; no Firefox needed)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCombo, comboToString, comboMatches, comboToHotkey, comboToOriginalKey, resolveKeyMap,
  splitActionFor, layoutRects, findNeighbour, fuzzy, isEditable, installPaintHook,
  createFileLogger, KEY_PREFS, DEFAULT_KEYS,
} from "../profile/chrome/JS/tilefox/TilefoxCore.sys.mjs";

const ev = (key, mods = {}, code) => ({
  key, code: code ?? (key.length === 1 ? "Key" + key.toUpperCase() : key),
  ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods,
});
const ctrl = { ctrlKey: true };

// ---- key mapping (Ryan 2026-10-08: Ctrl+Y = right, Ctrl+H = below)

test("defaults: Ctrl+Y splits right, Ctrl+H splits down", () => {
  assert.equal(DEFAULT_KEYS.splitRight, "Ctrl+Y");
  assert.equal(DEFAULT_KEYS.splitDown, "Ctrl+H");
  const km = resolveKeyMap(() => "");
  assert.equal(splitActionFor(km, ev("y", ctrl)), "split-row"); // row = side by side
  assert.equal(splitActionFor(km, ev("h", ctrl)), "split-col"); // col = stacked
  assert.equal(splitActionFor(km, ev("h", { ctrlKey: true, shiftKey: true })), null);
  assert.equal(splitActionFor(km, ev("h")), null);
  assert.deepEqual(km.problems, []);
});

test("split-row puts the new pane to the right, split-col below", () => {
  const right = layoutRects({ dir: "row", a: { tab: "A" }, b: { tab: "B" }, ratio: 0.5 });
  assert.deepEqual(right.get("B"), { x: 50, y: 0, w: 50, h: 100 });
  const down = layoutRects({ dir: "col", a: { tab: "A" }, b: { tab: "B" }, ratio: 0.5 });
  assert.deepEqual(down.get("B"), { x: 0, y: 50, w: 100, h: 50 });
});

test("prefs flip the mapping without code changes", () => {
  const prefs = { [KEY_PREFS.splitRight]: "Ctrl+H", [KEY_PREFS.splitDown]: "ctrl + y" };
  const km = resolveKeyMap(n => prefs[n] || "");
  assert.equal(splitActionFor(km, ev("h", ctrl)), "split-row");
  assert.equal(splitActionFor(km, ev("y", ctrl)), "split-col");
});

test("bad pref values fall back to defaults and are reported", () => {
  const km = resolveKeyMap(n => (n === KEY_PREFS.splitDown ? "Ctrl+Banana" : ""));
  assert.equal(comboToString(km.splitDown), "Ctrl+H");
  assert.equal(km.problems.length, 1);
  assert.match(km.problems[0], /tilefox\.keys\.splitDown/);
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
