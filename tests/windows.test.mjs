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

// asyncTabs: a new tab's panel appears `tabDelay` ms after addTrustedTab, and every tab switch
// finishes `switchDelay` ms after selection, like AsyncTabSwitcher. switchEvents: which events the
// finished switch sends. Firefox 157 with live panes sends TabSwitched ({detail: {tab}}) but its
// TabSwitchDone (switcher finish()) can stay out (live log 2026-10-08 18:57).
function fakeFirefox({ saved = null, tabDelay = 0, switchDelay = 1, switchEvents = ["TabSwitched", "TabSwitchDone"] } = {}) {
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
      setTimeout(() => {
        if (this._sel === t) {
          for (const type of switchEvents) { emit(winListeners, type, win, type === "TabSwitched" ? { tab: t } : undefined); }
        }
      }, switchDelay);
    },
    get selectedBrowser() { return this._sel?.linkedBrowser; },
    get visibleTabs() { return this.tabs.filter(t => !t.hidden && !t.closing); },
    tabContainer: { addEventListener(t, f) { (tcListeners[t] ||= []).push(f); } },
    tabpanels: el("tabpanels"),
    addTrustedTab(url, { label } = {}) {
      const n = nextTab++;
      const tab = { id: n, label: label || `tab${n}`, hidden: false, pinned: false, closing: false, selected: false,
        successor: null, linkedPanel: tabDelay ? null : `panel${n}`,
        linkedBrowser: { browserId: n, currentURI: { host: label ? `${label}.example.com` : "" }, focus() {}, docShellIsActive: false } };
      this.tabs.push(tab);
      if (tabDelay) { setTimeout(() => { tab.linkedPanel = `panel${n}`; }, tabDelay); }
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
  const run = async a => { await T.runAction(a, "test"); await tick(); };
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

// ---- splits are serialized and one press makes one pane (Ryan 2026-10-08: "Ctrl+H twice
// in quick succession kinda breaks it")

const shape = n => (n.tab ? n.tab.label : `${n.dir}(${shape(n.a)},${shape(n.b)})`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function settled(T) {
  // Content echoes queue more jobs after a delay; wait until the queue stays empty.
  for (let i = 0; i < 50; i++) {
    await T.idle();
    await sleep(20);
    if (!T.queue.pending) { return; }
  }
  throw new Error("queue never drained");
}
function keyEvent(key, mods, target, { repeat = false } = {}) {
  const e = { key, code: "Key" + key.toUpperCase(), ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods,
    repeat, target, composedTarget: target, prevented: false, isComposing: false };
  e.preventDefault = () => { e.prevented = true; };
  e.stopPropagation = () => {};
  return e;
}
const browserEl = tab => Object.assign(tab.linkedBrowser, { localName: "browser", closest: () => null });

test("stress: 5 back-to-back splits with async tabs run one at a time into one clean tree", silence(async () => {
  const f = await boot({ tabDelay: 15, switchDelay: 20 });
  const starts = [];
  const split = f.T.split.bind(f.T);
  f.T.split = dir => {
    const sel = f.gb.selectedTab;
    starts.push({ sel: sel.label, panel: !!sel.linkedPanel, switched: f.T.switchedTo === sel });
    return split(dir);
  };
  for (let i = 0; i < 5; i++) {
    f.T.runAction("split-col", "test"); // no await: all five fired at once
  }
  assert.equal(f.T.queue.pending, 5);
  await settled(f.T);
  assert.equal(shape(f.T.root), "col(mail,col(tab1,col(tab2,col(tab3,col(tab4,tab5)))))");
  assert.deepEqual(starts.map(s => s.sel), ["mail", "tab1", "tab2", "tab3", "tab4"]);
  // each split started only after the previous new tab had its panel and its tab switch finished
  assert.ok(starts.slice(1).every(s => s.panel && s.switched), JSON.stringify(starts));
  assert.equal(f.gb.selectedTab.label, "tab5");
  assert.equal(f.gb.tabs.length, 6);
  const area = [...f.T.rects().values()].reduce((s, r) => s + r.w * r.h, 0);
  assert.ok(Math.abs(area - 100 * 100) < 1e-6, "panes tile the whole window");
}));

test("stress: 5 presses through every key path (keydown, XUL key, content echo, repeats) make exactly 5 panes", silence(async () => {
  const f = await boot({ tabDelay: 10, switchDelay: 15 });
  const T = f.T;
  const mail = browserEl(f.gb.tabs[0]);
  const ctrlH = (opts) => T.onChromeKeydown(keyEvent("h", { ctrlKey: true }, mail, opts));
  const altH = (opts) => { T.onChromeKeydown(keyEvent("h", { altKey: true }, mail, opts)); T.onHotkey("split-col"); };
  const echo = (ms, via = "content") => setTimeout(() => T.onActorAction({ action: "split-col", via }, mail), ms);

  ctrlH(); // 1: content actor not seen yet -> chrome fallback takes it
  echo(2); //    ...and the page saw the key too: duplicate, ignored
  T.onActorHello(mail, { where: "https://mail" });
  ctrlH(); // 2: deferred to the content actor; its echo arrives after presses 3 and 4
  echo(12);
  altH(); // 3: keydown listener takes it; the reserved XUL key fires too: ignored
  altH({ repeat: true }); // held Alt+H: swallowed, and its XUL key too
  ctrlH({ repeat: true }); // held Ctrl+H: content swallows repeats, no echo
  altH(); // 4
  ctrlH(); // 5: deferred, echo arrives late
  echo(25);
  echo(30, "content-fallback"); // an "always" key echo for press 4 that reached content: ignored

  await sleep(40);
  await settled(T);
  assert.equal(T.paneTabs().length, 6, shape(T.root));
  assert.equal(shape(T.root), "col(mail,col(tab1,col(tab2,col(tab3,col(tab4,tab5)))))");
  assert.equal(f.gb.selectedTab.label, "tab5");
}));

test("a fast second Ctrl+H from the old pane's page still splits (echo arrives after the new tab is selected)", silence(async () => {
  const f = await boot({ switchDelay: 30 });
  const T = f.T;
  const mail = browserEl(f.gb.tabs[0]);
  T.onActorHello(mail, {});
  T.onChromeKeydown(keyEvent("h", { ctrlKey: true }, mail));
  T.onActorAction({ action: "split-col", via: "content" }, mail);
  await sleep(5); // first split has selected tab1, but focus is still in mail's page
  T.onChromeKeydown(keyEvent("h", { ctrlKey: true }, mail));
  T.onActorAction({ action: "split-col", via: "content" }, mail); // used to be dropped: "non-selected browser"
  await settled(T);
  assert.equal(shape(T.root), "col(mail,col(tab1,tab2))");
}));

test("Ctrl+H in an empty URL bar splits; with text in it, it passes through", silence(async () => {
  const f = await boot();
  const T = f.T;
  const urlbar = { localName: "input", id: "urlbar-input", value: "", closest: () => null };
  f.win.document.activeElement = urlbar;
  const e1 = keyEvent("h", { ctrlKey: true }, urlbar);
  T.onChromeKeydown(e1);
  await settled(T);
  assert.ok(e1.prevented);
  assert.equal(T.paneTabs().length, 2);
  urlbar.value = "github.com/ryan";
  const e2 = keyEvent("h", { ctrlKey: true }, urlbar);
  T.onChromeKeydown(e2);
  await settled(T);
  assert.ok(!e2.prevented, "typing in the URL bar keeps Firefox's Ctrl+H");
  assert.equal(T.paneTabs().length, 2);
}));

test("a stuck action can't wedge the queue", silence(async () => {
  const f = await boot();
  f.T.queue.timeoutMs = 30;
  f.T.runAction("split-col", "test");
  f.T.split = () => new Promise(() => {}); // never settles
  f.T.runAction("split-col", "test");
  const after = f.T.runAction("new-window", "test");
  await after;
  assert.equal(f.T.ws.windows.length, 2);
}));

// ---- parent actor -> window instance (live bug 2026-10-08: "actor action but no Tilefox in window")

// Shaped like Firefox 157: TilefoxParent gets the <browser> from browsingContext.top.embedderElement,
// and browser.ownerGlobal is not an object on which the window script's `window.Tilefox` shows up.
globalThis.JSWindowActorParent ??= class {};
const { TilefoxParent } = await import("../profile/chrome/JS/tilefox/TilefoxParent.sys.mjs");
function actorFor(browser) {
  const a = new TilefoxParent();
  a.browsingContext = { browserId: browser.browserId, top: { embedderElement: browser } };
  a.browsingContext.top.top = a.browsingContext.top;
  return a;
}
const send = (actor, name, data) => actor.receiveMessage({ name, data });
async function captureWarnings(fn) {
  const warns = [];
  const w = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  try { await fn(); } finally { console.warn = w; }
  return warns;
}

test("parent actor finds the window when ownerGlobal.Tilefox is not visible (157): hello + Ctrl+A prefix from a page", silence(async () => {
  const f = await boot();
  const T = f.T;
  const page = browserEl(f.gb.tabs[0]);
  page.ownerGlobal = { document: f.win.document }; // a different object: no Tilefox property on it
  assert.equal(page.ownerGlobal.Tilefox, undefined, "the old lookup (ownerGlobal.Tilefox) fails here");
  const actor = actorFor(page);
  const warns = await captureWarnings(async () => {
    send(actor, "Tilefox:Hello", { where: "https://example.com" });
    assert.ok(T.actorBrowsers.has(page), "hello registers, so the window lets content decide typing");
    // Ctrl+A on <body>: the window defers to the actor, the actor says prefix.
    T.onChromeKeydown(keyEvent("a", { ctrlKey: true }, page));
    send(actor, "Tilefox:Action", { action: "prefix", via: "content" });
    await settled(T);
  });
  assert.equal(T.panel.state, "open", "prefix panel opened from a content-routed Ctrl+A");
  assert.ok(!warns.some(w => w.includes("no Tilefox in window")), warns.join("\n"));
}));

test("parent actor resolves via ownerGlobal when it is the window, and each window gets its own actions", silence(async () => {
  const a = await boot();
  const b = await boot();
  const pa = browserEl(a.gb.tabs[0]);
  pa.ownerGlobal = a.win;
  const pb = browserEl(b.gb.tabs[0]);
  pb.ownerGlobal = { other: true };
  send(actorFor(pa), "Tilefox:Hello", {});
  send(actorFor(pb), "Tilefox:Hello", {});
  assert.ok(a.T.actorBrowsers.has(pa) && !a.T.actorBrowsers.has(pb));
  assert.ok(b.T.actorBrowsers.has(pb) && !b.T.actorBrowsers.has(pa));
  send(actorFor(pb), "Tilefox:Action", { action: "split-col", via: "content" });
  await settled(b.T);
  await settled(a.T);
  assert.equal(b.T.paneTabs().length, 2);
  assert.equal(a.T.paneTabs().length, 0);
}));

test("parent actor still warns for a browser no tilefox window owns", silence(async () => {
  await boot();
  const stray = { browserId: 999, ownerGlobal: {}, localName: "browser" };
  const warns = await captureWarnings(() => send(actorFor(stray), "Tilefox:Action", { action: "prefix", via: "content" }));
  assert.ok(warns.some(w => w.includes("actor action but no Tilefox in window")), warns.join("\n"));
}));

// ---- tab switch wait (live: "split: no TabSwitchDone after 1500 ms" on every split/focus)

test("split settles on TabSwitched when TabSwitchDone never comes (157 with live panes)", silence(async () => {
  const f = await boot({ switchDelay: 20, switchEvents: ["TabSwitched"] });
  const t0 = Date.now();
  await f.T.runAction("split-col", "test");
  await f.T.runAction("split-row", "test");
  await f.T.runAction("focus-up", "test");
  await f.T.idle();
  assert.equal(f.T.paneTabs().length, 3);
  assert.ok(Date.now() - t0 < 1000, `no 1.5 s fallback waits (took ${Date.now() - t0} ms)`);
}));

test("split settles from the switcher state when no event comes at all", silence(async () => {
  const f = await boot({ switchDelay: 5, switchEvents: [] });
  // AsyncTabSwitcher after maybeFinishTabSwitch(): requested tab loaded, switch no longer in progress.
  Object.defineProperty(f.gb, "_switcher", { get() {
    return { requestedTab: f.gb.selectedTab, switchInProgress: false, STATE_LOADED: 1, getTabState: () => 1 };
  } });
  const t0 = Date.now();
  await f.T.runAction("split-col", "test");
  await f.T.idle();
  assert.equal(f.T.paneTabs().length, 2);
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
}));

test("split still waits while the switcher is mid-switch, then gives up after switchWaitMs", silence(async () => {
  const f = await boot({ switchDelay: 5, switchEvents: [] });
  f.gb._switcher = { requestedTab: null, switchInProgress: true, STATE_LOADED: 1, getTabState: () => 0 };
  f.T.switchWaitMs = 60;
  const t0 = Date.now();
  await f.T.runAction("split-col", "test");
  await f.T.idle();
  assert.ok(Date.now() - t0 >= 55, "waited for the fallback timeout");
  assert.equal(f.T.paneTabs().length, 2);
}));
