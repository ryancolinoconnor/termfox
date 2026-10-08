// node --test tests/*.test.mjs
// Runs the real tilefox.uc.mjs against a fake gBrowser + SessionStore (no Firefox): tmux windows
// (new / select / last / kill / close-last-tab / persistence). The fake follows Firefox 157's
// rules that matter here: hideTab refuses the selected and pinned tabs, and a closed selected
// tab blurs to its successor first, else to a visible tab (Tabbrowser._findTabToBlurTo).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as Core from "../profile/chrome/JS/tilefox/TilefoxCore.sys.mjs";

const SRC = readFileSync(new URL("../profile/chrome/JS/tilefox.uc.mjs", import.meta.url), "utf8");
const tick = () => new Promise(r => setTimeout(r, 5));

function el(tag = "div") {
  const listeners = {};
  return {
    localName: tag, children: [], dataset: {}, style: { setProperty() {}, removeProperty() {} }, hidden: false, state: "closed",
    attrs: {}, classList: { add() {}, remove() {} },
    setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; },
    toggleAttribute(k, on) { if (on) { this.attrs[k] = ""; } else { delete this.attrs[k]; } },
    append(...c) { this.children.push(...c); }, replaceChildren(...c) { this.children = c; },
    addEventListener(t, f) { (listeners[t] ||= []).push(f); }, getBoundingClientRect: () => ({ width: 1000 }),
    openPopup() { this.state = "open"; }, hidePopup() { this.state = "closed"; }, focus() {}, select() {},
    get firstChild() { return this.children[0]; },
    closest: () => null, get textContent() { return this._t || ""; }, set textContent(v) { this._t = v; },
  };
}

function fakeFirefox({ saved = null } = {}) {
  const prefs = new Map();
  const tcListeners = {};
  const winListeners = {};
  const emit = (map, type, target, detail) => (map[type] || []).forEach(f => f({ target, detail }));
  let nextTab = 0;
  const tabValues = new Map(); // tab -> {key: value}
  const winValues = { ...(saved?.win || {}) };
  const gb = {
    tabs: [],
    _sel: null,
    get selectedTab() { return this._sel; },
    set selectedTab(t) {
      if (!t || t === this._sel) { return; }
      if (this._sel) { this._sel.selected = false; }
      this._sel = t; t.selected = true;
      emit(tcListeners, "TabSelect", t);
    },
    get selectedBrowser() { return this._sel?.linkedBrowser; },
    get visibleTabs() { return this.tabs.filter(t => !t.hidden && !t.closing); },
    tabContainer: { addEventListener(t, f) { (tcListeners[t] ||= []).push(f); } },
    tabpanels: el("tabpanels"),
    addTrustedTab(url, { label } = {}) {
      const n = nextTab++;
      const tab = { id: n, label: label || `tab${n}`, hidden: false, pinned: false, closing: false, selected: false,
        successor: null, linkedPanel: `panel${n}`,
        linkedBrowser: { browserId: n, currentURI: { host: label ? `${label}.example.com` : "" }, focus() {}, docShellIsActive: false } };
      this.tabs.push(tab);
      emit(tcListeners, "TabOpen", tab);
      return tab;
    },
    hideTab(t) { if (!t.hidden && !t.pinned && !t.selected && !t.closing) { t.hidden = true; } },
    showTab(t) { t.hidden = false; },
    setSuccessor(t, s) { t.successor = s; },
    getTabForBrowser(b) { return this.tabs.find(t => t.linkedBrowser === b); },
    removeTab(t) {
      if (t.selected) {
        const vis = this.visibleTabs.filter(x => x !== t);
        this.selectedTab = t.successor && !t.successor.closing ? t.successor : vis[0];
      }
      t.closing = true;
      emit(tcListeners, "TabClose", t);
      this.tabs.splice(this.tabs.indexOf(t), 1);
    },
    removeTabs(ts) { ts.forEach(t => this.removeTab(t)); },
  };
  const doc = {
    els: {}, getElementById(id) { return this.els[id] || (id === "navigator-toolbox" ? (this.els[id] = el()) : null); },
    createXULElement: el, createElementNS: (ns, t) => el(t), querySelectorAll: () => [], documentElement: el(),
  };
  const SessionStore = {
    promiseAllWindowsRestored: Promise.resolve(),
    getCustomWindowValue: (w, k) => winValues[k] || "",
    setCustomWindowValue: (w, k, v) => { winValues[k] = v; },
    getCustomTabValue: (t, k) => tabValues.get(t)?.[k] || "",
    setCustomTabValue: (t, k, v) => { tabValues.set(t, { ...tabValues.get(t), [k]: v }); },
  };
  const win = {
    document: doc, gBrowser: gb, SessionStore, FirefoxViewHandler: { tab: null }, BROWSER_NEW_TAB_URL: "about:newtab",
    gURLBar: { select() {} }, focus() {}, setTimeout, clearTimeout,
    addEventListener(t, f) { (winListeners[t] ||= []).push(f); },
    UC_API: { Windows: { waitWindowLoading: async () => {} }, Notifications: { show: async () => {} } },
  };
  // Tabs that existed before tilefox started (and their saved values, as SessionStore restores them).
  for (const t of saved?.tabs || []) {
    const tab = gb.addTrustedTab("x", { label: t.label });
    tab.hidden = !!t.hidden;
    if (t.value) { tabValues.set(tab, { [Core.TAB_VALUE]: t.value }); }
  }
  if (!gb.tabs.length) { gb.addTrustedTab("x", { label: "mail" }); }
  gb.selectedTab = gb.tabs[saved?.selected ?? 0];
  const Services = {
    prefs: {
      getBoolPref: (n, d) => (prefs.has(n) ? prefs.get(n) : d), setBoolPref: (n, v) => prefs.set(n, v),
      getStringPref: (n, d) => (prefs.has(n) ? prefs.get(n) : d), prefHasUserValue: n => prefs.has(n),
      addObserver() {}, removeObserver() {},
    },
    appinfo: { version: "157.0.1" },
    wm: { getEnumerator: () => [win] },
    ppmm: { sharedData: { set() {}, flush() {} } },
  };
  const ctx = vm.createContext({ window: win, Services, ChromeUtils: { importESModule: () => Core }, UC_API: win.UC_API, console, Date, Math, JSON, Promise });
  return { win, gb, ctx, tabValues, winValues, saved: () => ({ win: { ...winValues } }) };
}

async function boot(opts) {
  const ff = fakeFirefox(opts);
  const quietLog = console.log; const quietErr = console.error; const quietWarn = console.warn;
  console.log = console.error = console.warn = () => {};
  try {
    vm.runInContext(SRC, ff.ctx, { filename: "tilefox.uc.mjs" });
    await tick(); await tick();
  } finally {
    console.log = quietLog; console.error = quietErr; console.warn = quietWarn;
  }
  const T = ff.win.Tilefox;
  assert.ok(T, "tilefox booted");
  const run = async a => { T.lastAction = { name: "", t: 0 }; T.runAction(a, "test"); await tick(); };
  const visible = () => ff.gb.tabs.filter(t => !t.hidden).map(t => t.label);
  return { ...ff, T, run, visible, status: () => T.statusText() };
}

const silence = fn => async () => {
  const l = console.log; const e = console.error; const w = console.warn;
  console.log = console.error = console.warn = () => {};
  try { await fn(); } finally { console.log = l; console.error = e; console.warn = w; }
};

test("c / l / n / p / digits switch windows by hiding tabs, no reloads", silence(async () => {
  const f = await boot();
  assert.equal(f.status(), "0:mail*");
  await f.run("new-window");
  assert.equal(f.T.ws.windows.length, 2);
  assert.deepEqual(f.visible(), ["tab1"]); // window 1 shows only its new tab; mail is hidden
  f.gb.selectedTab.label = "dev"; f.gb.selectedTab.linkedBrowser.currentURI.host = "dev.example.com";
  assert.equal(f.status(), "0:mail-  1:dev*");
  await f.run("last-window");
  assert.deepEqual(f.visible(), ["mail"]);
  assert.equal(f.gb.selectedTab.label, "mail");
  assert.equal(f.status(), "0:mail*  1:dev-");
  await f.run("last-window"); // toggle back
  assert.equal(f.gb.selectedTab.label, "dev");
  await f.run("next-window");
  assert.equal(f.gb.selectedTab.label, "mail");
  await f.run("previous-window");
  assert.equal(f.gb.selectedTab.label, "dev");
  await f.run("select-window-0");
  assert.equal(f.gb.selectedTab.label, "mail");
  await f.run("select-window-7"); // no such window: stays
  assert.equal(f.gb.selectedTab.label, "mail");
}));

test("new tabs (links, Ctrl+T, splits) join the current window; each window keeps its own layout", silence(async () => {
  const f = await boot();
  await f.run("split-row"); // window 0: mail | tab1
  assert.equal(f.T.paneTabs().length, 2);
  await f.run("new-window"); // window 1
  assert.equal(f.T.paneTabs().length, 0); // window 1 has no layout
  const link = f.gb.addTrustedTab("https://x", { label: "linked" });
  assert.equal(f.T.ws.ownerOf(link), f.T.ws.current);
  await f.run("last-window");
  assert.equal(f.T.paneTabs().length, 2); // window 0's split came back
  assert.equal(f.T.layoutVisible(), true);
  assert.deepEqual(f.visible(), ["mail", "tab1"]);
}));

test("closing a window's last tab kills the window and lands on the last window", silence(async () => {
  const f = await boot();
  await f.run("new-window");
  const only = f.gb.selectedTab;
  assert.equal(only.successor?.label, "mail"); // guard: Firefox blurs to the successor first
  f.gb.removeTab(only);
  await tick();
  assert.equal(f.T.ws.windows.length, 1);
  assert.equal(f.gb.selectedTab.label, "mail");
  assert.deepEqual(f.visible(), ["mail"]);
}));

test("& kills the window and its tabs; the only window can't be killed", silence(async () => {
  const f = await boot();
  await f.run("kill-window");
  f.T.killWindow(); // what "y" does
  assert.equal(f.T.ws.windows.length, 1);
  await f.run("new-window");
  f.gb.addTrustedTab("x", { label: "extra" });
  f.T.killWindow();
  await tick();
  assert.equal(f.T.ws.windows.length, 1);
  assert.deepEqual(f.gb.tabs.map(t => t.label), ["mail"]);
  assert.equal(f.gb.selectedTab.label, "mail");
}));

test("rename, then names, membership and layouts survive a restart via SessionStore values", silence(async () => {
  const f = await boot();
  await f.run("split-row"); // window 0: mail | tab1
  f.T.renameWindow("inbox");
  await f.run("new-window"); // window 1 (tab2)
  f.T.renameWindow("dev");
  await f.run("last-window");
  f.T.persistNow();
  // "Restart": same tabs with their saved values and hidden state, saved window value.
  const saved = {
    win: { ...f.winValues },
    tabs: f.gb.tabs.map(t => ({ label: t.label, hidden: t.hidden, value: f.tabValues.get(t)?.[Core.TAB_VALUE] })),
    selected: f.gb.tabs.indexOf(f.gb.selectedTab),
  };
  const g = await boot({ saved });
  assert.equal(g.status(), "0:inbox*  1:dev-");
  assert.equal(g.T.paneTabs().length, 2);
  assert.deepEqual(g.visible(), ["mail", "tab1"]);
  await g.run("last-window");
  assert.deepEqual(g.visible(), ["tab2"]);
  assert.equal(g.status(), "0:inbox-  1:dev*");
}));

test("kill switch shows every tab; turning it back on hides other windows again", silence(async () => {
  const f = await boot();
  await f.run("new-window");
  f.ctx.Services.prefs.setBoolPref("tilefox.enabled", false);
  f.T.onEnabledChanged();
  assert.deepEqual(f.visible().sort(), ["mail", "tab1"]);
  f.ctx.Services.prefs.setBoolPref("tilefox.enabled", true);
  f.T.onEnabledChanged();
  assert.deepEqual(f.visible(), ["tab1"]);
}));

test("palette lists windows as window:name and jumps into hidden windows", silence(async () => {
  const f = await boot();
  await f.run("new-window");
  const items = f.T.allItems();
  assert.ok(items.some(i => i.label === "window:mail"));
  const mailTab = items.find(i => i.tab?.label === "mail");
  assert.match(mailTab.label, /^\[0:mail\] mail/);
  f.T.jumpTo(mailTab);
  await tick();
  assert.equal(f.gb.selectedTab.label, "mail");
  assert.deepEqual(f.visible(), ["mail"]);
  assert.ok(f.T.allItems(true).every(i => i.wid)); // prefix w: windows only
}));
