// node --test tests/*.test.mjs
// Runs the real termfox.uc.mjs against a fake gBrowser + SessionStore (no Firefox): tmux windows
// (new / select / last / kill / close-last-tab / persistence). The fake follows Firefox 157's
// rules that matter here: hideTab refuses the selected and pinned tabs, and a closed selected
// tab blurs to its successor first, else to a visible tab (Tabbrowser._findTabToBlurTo).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as Core from "../profile/chrome/JS/termfox/TermfoxCore.sys.mjs";

const FakePBU = { isWindowPrivate: w => !!w.isPrivate };
const SRC = readFileSync(new URL("../profile/chrome/JS/termfox.uc.mjs", import.meta.url), "utf8");
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
function fakeFirefox({ saved = null, tabDelay = 0, switchDelay = 1, switchEvents = ["TabSwitched", "TabSwitchDone"], userPrefs = {}, isPrivate = false, otherWindows = [] } = {}) {
  const prefs = new Map(Object.entries(userPrefs));
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
      this._switching = t;
      emit(tcListeners, "TabSelect", t);
      setTimeout(() => {
        if (this._sel === t) {
          this._switching = null;
          this._switched = switchEvents.includes("TabSwitchDone") ? null : t; // finish() destroys the switcher
          for (const type of switchEvents) { emit(winListeners, type, win, type === "TabSwitched" ? { tab: t } : undefined); }
        }
      }, switchDelay);
    },
    get selectedBrowser() { return this._sel?.linkedBrowser; },
    // AsyncTabSwitcher: alive from the selection until finish(); a test can replace it.
    _switching: null, _switched: null, _switcherOverride: undefined,
    get _switcher() {
      if (this._switcherOverride !== undefined) { return this._switcherOverride; }
      const t = this._switching || this._switched;
      return t ? { requestedTab: t, switchInProgress: !!this._switching, STATE_LOADED: 1, getTabState: () => (this._switching ? 0 : 1) } : null;
    },
    set _switcher(v) { this._switcherOverride = v; },
    get visibleTabs() { return this.tabs.filter(t => !t.hidden && !t.closing); },
    tabContainer: { addEventListener(t, f) { (tcListeners[t] ||= []).push(f); } },
    tabpanels: el("tabpanels"),
    addTrustedTab(url, { label } = {}) {
      const n = nextTab++;
      const tab = { id: n, label: label || `tab${n}`, hidden: false, pinned: false, closing: false, selected: false,
        successor: null, linkedPanel: tabDelay ? null : `panel${n}`,
        linkedBrowser: { browserId: n, currentURI: { host: label ? `${label}.example.com` : "" }, focus() {}, docShellIsActive: false } };
      this.tabs.push(tab);
      if (tabDelay) { setTimeout(() => { tab.linkedPanel = `panel${n}`; emit(tcListeners, "TabBrowserInserted", tab); }, tabDelay); }
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
    isPrivate, document: doc, gBrowser: gb, SessionStore, FirefoxViewHandler: { tab: null }, BROWSER_NEW_TAB_URL: "about:newtab",
    gURLBar: { select() {} }, focus() {}, setTimeout, clearTimeout, performance,
    addEventListener(t, f) { (winListeners[t] ||= []).push(f); },
    UC_API: { Windows: { waitWindowLoading: async () => {} }, Notifications: { show: async () => {} } },
  };
  // Tabs that existed before termfox started (and their saved values, as SessionStore restores them).
  for (const t of saved?.tabs || []) {
    const tab = gb.addTrustedTab("x", { label: t.label });
    tab.hidden = !!t.hidden;
    if (t.value) { tabValues.set(tab, { [t.key || Core.TAB_VALUE]: t.value }); }
  }
  if (!gb.tabs.length) { gb.addTrustedTab("x", { label: "mail" }); }
  gb.selectedTab = gb.tabs[saved?.selected ?? 0];
  const Services = {
    prefs: {
      getBoolPref: (n, d) => (prefs.has(n) ? prefs.get(n) : d), setBoolPref: (n, v) => prefs.set(n, v),
      getStringPref: (n, d) => (prefs.has(n) ? prefs.get(n) : d), prefHasUserValue: n => prefs.has(n),
      getIntPref: (n, d) => (prefs.has(n) ? prefs.get(n) : d), setIntPref: (n, v) => prefs.set(n, v), setStringPref: (n, v) => prefs.set(n, v),
      getChildList: prefix => [...prefs.keys()].filter(n => n.startsWith(prefix)),
      PREF_STRING: 32, PREF_INT: 64, PREF_BOOL: 128,
      getPrefType: n => ({ boolean: 128, number: 64, string: 32 })[typeof prefs.get(n)] || 0,
      addObserver() {}, removeObserver() {},
    },
    appinfo: { version: "157.0.1" },
    wm: { getEnumerator: () => [win, ...otherWindows] },
    ppmm: { sharedData: { set() {}, flush() {} } },
  };
  const ctx = vm.createContext({ window: win, Services, ChromeUtils: { importESModule: url => (url.includes("PrivateBrowsingUtils") ? { PrivateBrowsingUtils: FakePBU } : Core) }, UC_API: win.UC_API, console, Date, Math, JSON, Promise });
  return { win, gb, ctx, prefs, tabValues, winValues, saved: () => ({ win: { ...winValues } }) };
}

async function boot(opts) {
  const ff = fakeFirefox(opts);
  const quietLog = console.log; const quietErr = console.error; const quietWarn = console.warn;
  console.log = console.error = console.warn = () => {};
  try {
    vm.runInContext(SRC, ff.ctx, { filename: "termfox.uc.mjs" });
    await tick(); await tick();
  } finally {
    console.log = quietLog; console.error = quietErr; console.warn = quietWarn;
  }
  const T = ff.win.Termfox;
  assert.ok(T, "termfox booted");
  const run = async a => { await T.runAction(a, "test"); await tick(); };
  const visible = () => ff.gb.tabs.filter(t => !t.hidden).map(t => t.label);
  return { ...ff, T, run, visible, status: () => T.statusText() };
}

const silence = fn => async (...args) => {
  const l = console.log; const e = console.error; const w = console.warn;
  console.log = console.error = console.warn = () => {};
  try { await fn(...args); } finally { console.log = l; console.error = e; console.warn = w; }
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
  f.ctx.Services.prefs.setBoolPref("termfox.enabled", false);
  f.T.onEnabledChanged();
  assert.deepEqual(f.visible().sort(), ["mail", "tab1"]);
  f.ctx.Services.prefs.setBoolPref("termfox.enabled", true);
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
function keyEvent(key, mods, target, { repeat = false, timeStamp = performance.now(), isTrusted = true } = {}) {
  const code = key.startsWith("Arrow") ? key : "Key" + key.toUpperCase();
  const e = { key, code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods,
    repeat, target, composedTarget: target, prevented: false, isComposing: false, timeStamp, isTrusted };
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

// ---- parent actor -> window instance (live bug 2026-10-08: "actor action but no Termfox in window")

// Shaped like Firefox 157: TermfoxParent gets the <browser> from browsingContext.top.embedderElement,
// and browser.ownerGlobal is not an object on which the window script's `window.Termfox` shows up.
globalThis.JSWindowActorParent ??= class {};
// TermfoxParent asks PrivateBrowsingUtils whether the sender's browser is private.
globalThis.ChromeUtils ??= { importESModule: () => ({ PrivateBrowsingUtils: { isBrowserPrivate: br => !!br.isPrivate } }) };
const { TermfoxParent } = await import("../profile/chrome/JS/termfox/TermfoxParent.sys.mjs");
function actorFor(browser) {
  const a = new TermfoxParent();
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

test("parent actor finds the window when ownerGlobal.Termfox is not visible (157): hello + Ctrl+A prefix from a page", silence(async () => {
  const f = await boot();
  const T = f.T;
  const page = browserEl(f.gb.tabs[0]);
  page.ownerGlobal = { document: f.win.document }; // a different object: no Termfox property on it
  assert.equal(page.ownerGlobal.Termfox, undefined, "the old lookup (ownerGlobal.Termfox) fails here");
  const actor = actorFor(page);
  const warns = await captureWarnings(async () => {
    send(actor, "Termfox:Hello", {});
    assert.ok(T.actorBrowsers.has(page), "hello registers, so the window lets content decide typing");
    // Ctrl+A on <body>: the window defers to the actor, the actor says prefix.
    T.onChromeKeydown(keyEvent("a", { ctrlKey: true }, page));
    send(actor, "Termfox:Action", { action: "prefix", via: "content", t: Date.now() });
    await settled(T);
  });
  assert.equal(T.panel.state, "open", "prefix panel opened from a content-routed Ctrl+A");
  assert.ok(!warns.some(w => w.includes("no Termfox in window")), warns.join("\n"));
}));

test("parent actor resolves via ownerGlobal when it is the window, and each window gets its own actions", silence(async () => {
  const a = await boot();
  const b = await boot();
  const pa = browserEl(a.gb.tabs[0]);
  pa.ownerGlobal = a.win;
  const pb = browserEl(b.gb.tabs[0]);
  pb.ownerGlobal = { other: true };
  send(actorFor(pa), "Termfox:Hello", {});
  send(actorFor(pb), "Termfox:Hello", {});
  assert.ok(a.T.actorBrowsers.has(pa) && !a.T.actorBrowsers.has(pb));
  assert.ok(b.T.actorBrowsers.has(pb) && !b.T.actorBrowsers.has(pa));
  b.T.onChromeKeydown(keyEvent("h", { ctrlKey: true }, pb)); // the trusted press the action spends
  send(actorFor(pb), "Termfox:Action", { action: "split-col", via: "content", t: Date.now() });
  await settled(b.T);
  await settled(a.T);
  assert.equal(b.T.paneTabs().length, 2);
  assert.equal(a.T.paneTabs().length, 0);
}));

test("parent actor still warns for a browser no termfox window owns", silence(async () => {
  await boot();
  const stray = { browserId: 999, ownerGlobal: {}, localName: "browser" };
  const warns = await captureWarnings(() => send(actorFor(stray), "Termfox:Action", { action: "prefix", via: "content", t: Date.now() }));
  assert.ok(warns.some(w => w.includes("but no termfox in its window")), warns.join("\n"));
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

// ---- latency (Ryan 2026-10-08: "feels a bit slow"): keydown -> layout applied -> focus settled

// Alt+H, Alt+Y, then focus moves, each pressed as a real keydown (timeStamp = press time).
async function pressSequence(f) {
  const T = f.T;
  const page = browserEl(f.gb.tabs[0]);
  const keys = [["h", { altKey: true }], ["y", { altKey: true }], ["ArrowUp", { altKey: true }], ["ArrowDown", { altKey: true }],
    ["ArrowLeft", { altKey: true }], ["ArrowRight", { altKey: true }]];
  for (const [k, mods] of keys) {
    T.onChromeKeydown(keyEvent(k, mods, f.gb.selectedTab.linkedBrowser.localName ? f.gb.selectedTab.linkedBrowser : page));
    await T.idle();
  }
  return [...T.latencies.slice(-keys.length)]; // copy into this realm (T lives in a vm context)
}

test("latency: splits and focus moves end on tab events (no timeout fallback) within 50 ms of the key", silence(async t => {
  // switchDelay = how long the fake Firefox takes to finish a tab switch (TabSwitched).
  for (const switchDelay of [0, 8, 16, 30]) {
    const f = await boot({ switchDelay, switchEvents: ["TabSwitched"] });
    const timings = await pressSequence(f);
    assert.deepEqual(timings.map(x => x.action), ["split-col", "split-row", "focus-up", "focus-down", "focus-left", "focus-right"]);
    for (const x of timings) {
      assert.deepEqual([...x.fallbacks], [], x.describe());
      assert.ok(x.layout != null && x.switch != null && x.layout <= x.switch && x.switch <= x.total, x.describe());
      // termfox's own share: key -> panes moved, plus switch event -> done. The rest is the
      // (fake) Firefox tab switch, whose node timer can run late when the machine is busy.
      const own = x.layout + (x.total - x.switch);
      assert.ok(own < 20, `termfox overhead ${own.toFixed(1)} ms: ${x.describe()}`);
    }
    t.diagnostic(`switch ${switchDelay} ms: ` + timings.map(x =>
      `${x.action} ${x.total.toFixed(1)} (layout ${x.layout.toFixed(1)}, switch event ${x.switch.toFixed(1)})`).join(", "));
  }
}));

test("latency: no polling or fixed-delay timers in the split / focus hot path", silence(async () => {
  const f = await boot({ switchDelay: 10, tabDelay: 5, switchEvents: ["TabSwitched"] });
  const timers = [];
  const real = f.win.setTimeout;
  f.win.setTimeout = (fn, ms) => { timers.push(ms); return real(fn, ms); };
  await pressSequence(f);
  // Allowed: the queue's stuck-job guard (4000), the switch fallback (switchWaitMs) and the
  // SessionStore write debounce (150), none of which an action waits on unless something is stuck.
  const short = timers.filter(ms => !(ms >= 150));
  assert.deepEqual(short, [], `short timers scheduled: ${timers.join(", ")}`);
  assert.ok(f.T.latencies.slice(-6).every(x => !x.fallbacks.length));
}));

test("latency: a content-routed key counts from the page's keydown, and a stalled switch is flagged", silence(async () => {
  const f = await boot({ switchDelay: 5, switchEvents: ["TabSwitched"] });
  const T = f.T;
  const page = browserEl(f.gb.tabs[0]);
  T.onActorHello(page, {});
  const pressed = T.now() - 12; // the content process saw the key 12 ms ago
  T.onChromeKeydown(keyEvent("h", { ctrlKey: true }, page));
  T.onActorAction({ action: "split-col", via: "content", t: pressed }, page);
  await settled(T);
  const x = T.latencies.at(-1);
  assert.equal(x.action, "split-col");
  assert.ok(x.total >= 12, x.describe());
  // a timestamp from the future (clock skew) is clamped to now
  T.onChromeKeydown(keyEvent("h", { ctrlKey: true }, f.gb.selectedTab.linkedBrowser));
  T.onActorAction({ action: "split-col", via: "content", t: T.now() + 60000 }, browserEl(f.gb.selectedTab));
  await settled(T);
  assert.ok(T.latencies.at(-1).total < 50, T.latencies.at(-1).describe());

  // Firefox never reports the switch done: the fallback timeout ends the wait and is flagged.
  const g = await boot({ switchDelay: 5, switchEvents: [] });
  g.gb._switcher = { requestedTab: null, switchInProgress: true, STATE_LOADED: 1, getTabState: () => 0 };
  g.T.switchWaitMs = 40;
  await g.T.runAction("split-row", "test");
  const stalled = g.T.latencies.at(-1);
  assert.deepEqual([...stalled.fallbacks], ["tab switch"]);
  assert.ok(stalled.slow);
  assert.match(stalled.describe(), /^split-row done in \d+ ms: layout applied \d+ ms, focus settled \d+ ms \(queue wait \d+ ms, tab switch \d+ ms, via test\) - FALLBACK TIMEOUT HIT: tab switch$/);
}));

test("ActionTiming formats the log line and flags slow actions", () => {
  let now = 1000;
  const x = new Core.ActionTiming("split-col", "keydown", 1000, () => now);
  now = 1002; x.mark("layout");
  now = 1035; x.mark("switch");
  now = 1037; x.mark("focus");
  assert.equal(x.describe(), "split-col done in 37 ms: layout applied 2 ms, focus settled 37 ms (queue wait 0 ms, tab switch 35 ms, via keydown)");
  assert.ok(!x.slow);
  now = 1080; x.mark("focus");
  assert.ok(x.slow);
  assert.match(x.describe(), /over the 50 ms target$/);
});

// ---- renamed from tilefox (2026-10-08): old prefs and saved windows carry over

test("tilefox.* user prefs are copied to termfox.* once; termfox.* values already set win", silence(async () => {
  const f = await boot({ userPrefs: {
    "tilefox.enabled": true, "tilefox.statusbar": false, "tilefox.keys.splitRight": "Alt+V",
    "termfox.keys.splitDown": "Alt+S", "tilefox.keys.splitDown": "Alt+X",
  } });
  const p = f.prefs;
  assert.equal(p.get("termfox.statusbar"), false);
  assert.equal(p.get("termfox.keys.splitRight"), "Alt+V");
  assert.equal(p.get("termfox.keys.splitDown"), "Alt+S", "an existing termfox pref is not overwritten");
  assert.equal(p.get(Core.PREF_MIGRATED), true);
  assert.equal(f.T.statusBar.hidden, true, "the copied statusbar pref is in effect");
  // once only: a later change to the old pref (user.js) is not copied again
  p.set("tilefox.statusbar", true);
  assert.deepEqual([...Core.migrateLegacyPrefs(f.ctx.Services.prefs)], []);
  assert.equal(p.get("termfox.statusbar"), false);
}));

test("windows saved under the tilefox SessionStore names are restored after the rename", silence(async () => {
  const f = await boot();
  await f.run("split-row");
  f.T.renameWindow("inbox");
  await f.run("new-window");
  f.T.renameWindow("dev");
  await f.run("last-window");
  f.T.persistNow();
  // As saved by tilefox: same JSON, old keys.
  const saved = {
    win: { [Core.LEGACY_WINDOWS_VALUE]: f.winValues[Core.WINDOWS_VALUE] },
    tabs: f.gb.tabs.map(t => ({ label: t.label, hidden: t.hidden, key: Core.LEGACY_TAB_VALUE, value: f.tabValues.get(t)?.[Core.TAB_VALUE] })),
    selected: f.gb.tabs.indexOf(f.gb.selectedTab),
  };
  const g = await boot({ saved });
  assert.equal(g.status(), "0:inbox*  1:dev-");
  assert.equal(g.T.paneTabs().length, 2);
  assert.deepEqual(g.visible(), ["mail", "tab1"]);
  assert.ok(g.winValues[Core.WINDOWS_VALUE], "re-saved under the termfox name");
}));

// ---- security hardening (audit 2026-10-08)

async function captureLog(fn) {
  const lines = [];
  const l = console.log; const w = console.warn; const e = console.error;
  console.log = console.warn = console.error = (...a) => lines.push(a.join(" "));
  try { await fn(); } finally { console.log = l; console.warn = w; console.error = e; }
  return lines;
}

test("M2: private and normal Firefox windows never list each other in the palette", silence(async () => {
  const priv = await boot({ isPrivate: true });
  priv.gb.selectedTab.label = "secret-private-tab";
  const normal = await boot({ otherWindows: [priv.win] });
  const labels = normal.T.allItems().map(i => i.label).join(" | ");
  assert.ok(!labels.includes("secret-private-tab"), labels);
  assert.ok(labels.includes("mail"));
  const priv2 = await boot({ isPrivate: true, otherWindows: [normal.win, priv.win] });
  const pl = priv2.T.allItems().map(i => i.label).join(" | ");
  assert.ok(pl.includes("secret-private-tab"), "private windows see each other");
  assert.equal(priv2.T.allItems().filter(i => i.win === normal.win).length, 0, "but not normal windows");
}));

test("M2: a private window keeps its windows in memory only and logs nothing", silence(async () => {
  const lines = await captureLog(async () => {
    const f = await boot({ isPrivate: true });
    await f.run("split-row");
    await f.run("new-window");
    f.T.renameWindow("private-name");
    f.T.persistNow();
    assert.equal(Object.keys(f.winValues).length, 0, "no SessionStore window value");
    assert.equal(f.tabValues.size, 0, "no SessionStore tab values");
    assert.equal(f.T.ws.get(f.T.ws.current).name, "private-name", "still named in memory");
  });
  assert.deepEqual(lines.filter(l => l.includes("[termfox]")), []);
}));

test("M1: the log never contains window names, typed prefix keys, confirm keys or hosts", silence(async () => {
  let f;
  const panelKey = key => {
    const e = keyEvent(key, {}, null);
    e.stopPropagation = () => {};
    f.T.onPanelKey(e);
  };
  const lines = await captureLog(async () => {
    f = await boot({ saved: { tabs: [{ label: "bank" }] } });
    f.T.renameWindow("hunter2-name");
    await f.run("new-window");
    await f.run("last-window");
    f.T.openPanel("prefix");
    panelKey("q"); // not a prefix key: cancel
    f.T.openPanel("confirm");
    panelKey("z"); // not y: cancel
    await f.run("kill-window");
    f.T.killWindow();
    f.T.restoreFromSession("test");
    await f.T.idle();
  });
  const text = lines.join("\n");
  assert.match(text, /prefix -> cancel/);
  for (const leak of ["hunter2-name", "bank.example.com", "bank", "prefix key", "confirm: z", "code Key"]) {
    assert.ok(!text.includes(leak), `${leak} in the log:\n${text}`);
  }
}));

test("M3: untrusted (synthetic) key events are ignored by the chrome listener and the panel", silence(async () => {
  const f = await boot();
  const e = keyEvent("h", { altKey: true }, null, { isTrusted: false });
  f.T.onChromeKeydown(e);
  await f.T.idle();
  assert.equal(e.prevented, false);
  assert.equal(f.T.paneTabs().length, 0);
  f.T.openPanel("prefix");
  f.T.onPanelKey(keyEvent("y", {}, null, { isTrusted: false }));
  await f.T.idle();
  assert.equal(f.T.paneTabs().length, 0);
}));

test("M3: a content action with no trusted press for that browser is refused", silence(async () => {
  const f = await boot();
  const page = browserEl(f.gb.tabs[0]);
  f.T.onActorHello(page);
  f.T.onActorAction({ action: "split-col", via: "content", t: Date.now() }, page);
  f.T.onActorAction({ action: "kill", via: "content", t: Date.now() }, page);
  await f.T.idle();
  assert.equal(f.T.paneTabs().length, 0);
  assert.equal(f.ctx.Services.prefs.getBoolPref("termfox.enabled", true), true, "content can't pause termfox");
}));

test("M5: paused = no key handling, no actions, no logging; the pause key resumes and reconciles tabs", silence(async () => {
  let f;
  const pauseKey = () => keyEvent("k", { ctrlKey: true, altKey: true, shiftKey: true }, null);
  const lines = await captureLog(async () => {
    f = await boot();
    await f.run("new-window"); // window 1
  });
  assert.ok(lines.some(l => l.includes("[termfox]")), "logs while running");
  const page = browserEl(f.gb.selectedTab);
  f.T.onActorHello(page);
  const toggle = async () => { f.T.onChromeKeydown(pauseKey()); await f.T.idle(); f.T.onEnabledChanged(); };
  await toggle();
  assert.equal(f.ctx.Services.prefs.getBoolPref("termfox.enabled", true), false, "paused");
  const pausedLines = await captureLog(async () => {
    const e = keyEvent("h", { altKey: true }, page);
    f.T.onChromeKeydown(e);
    assert.equal(e.prevented, false, "Alt+H goes to Firefox while paused");
    f.T.onActorAction({ action: "split-col", via: "content", t: Date.now() }, page);
    await f.T.runAction("split-row", "test");
    f.gb.addTrustedTab("x", { label: "opened-while-paused" });
    f.gb.removeTab(f.gb.tabs.find(t => t.label === "mail"));
    await tick();
  });
  assert.equal(f.T.paneTabs().length, 0);
  assert.deepEqual(pausedLines.filter(l => l.includes("[termfox]")), [], "nothing logged while paused");
  assert.equal(f.T.ws.ownerOf(f.gb.tabs.find(t => t.label === "opened-while-paused")), null, "no bookkeeping while paused");
  await toggle();
  assert.equal(f.ctx.Services.prefs.getBoolPref("termfox.enabled", false), true, "resumed");
  const added = f.gb.tabs.find(t => t.label === "opened-while-paused");
  assert.ok(f.T.ws.ownerOf(added), "a tab opened while paused joins a window on resume");
  assert.equal(f.T.ws.windows.length, 1, "window 0 lost its only tab while paused: gone on resume");
}));
