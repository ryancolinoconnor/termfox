// ==UserScript==
// @name           tilefox
// @description    Day-1 spike: tmux/i3-style panes inside one Firefox window.
// @version        0.1.0-spike
// ==/UserScript==

/*
 * Runs once per browser window (fx-autoconfig window-scoped ES module, *.uc.mjs):
 *   https://github.com/MrOtherGuy/fx-autoconfig#usage
 * Pinned loader commit: dfdab5684faffc112b76ccb1d8cab7f75da0102c (loader @version 0.10.16)
 * Target: Firefox Release 157.0.1 and 158+ (checked against tag FIREFOX_157_0_1_RELEASE, 2026-10-08).
 * Everything that touches Firefox internals is feature-detected and logged to <profile>/tilefox.log.
 *
 * HOW PANES WORK (riskiest part, read this first)
 * - Every pane is a real tab. We never reparent <browser> elements (reparenting would
 *   destroy and reload the page). Instead, every pane's existing <tabpanel> child of
 *   #tabbrowser-tabpanels is made visible and absolutely positioned with % insets.
 *   Hidden deck panels use -moz-subtree-hidden-only-visually; tilefox.uc.css overrides it.
 *   https://searchfox.org/mozilla-central/source/toolkit/content/xul.css  ("deck, tabpanels & stack")
 * - Firefox only paints the selected tab. AsyncTabSwitcher keeps a background browser
 *   painting only if shouldDeactivateDocShell() is false, i.e. if it is in
 *   gBrowser.splitViewBrowsers (Firefox's own 2-pane Split View). We shadow that getter on
 *   this window's gBrowser instance so it returns native split browsers + our panes.
 *   https://searchfox.org/mozilla-central/source/browser/components/tabbrowser/AsyncTabSwitcher.sys.mjs (shouldDeactivateDocShell)
 *   https://searchfox.org/mozilla-central/source/browser/components/tabbrowser/Tabbrowser.sys.mjs (splitViewBrowsers, showSplitViewPanels)
 * - Focusing / clicking a pane selects its tab, the same way native split view does
 *   (MozTabpanels.handleEvent in toolkit/content/widgets/tabbox.js).
 * - The selected tab is the focused pane. If you select a tab that is not in the layout,
 *   the layout is hidden (suspended) and comes back when you select one of its tabs.
 *
 * WINDOWS (tmux windows inside this Firefox window; model = Core.WindowSet)
 * - Every tab belongs to exactly one tilefox window (ws.owner). Each window has its own pane
 *   layout (window.root). Switching windows shows that window's tabs with gBrowser.showTab(),
 *   selects its remembered tab, and hides every other window's tabs with gBrowser.hideTab()
 *   (the same API extensions use; Tabbrowser.sys.mjs in 157). Nothing reloads: hidden tabs keep
 *   their browsers. Firefox's native tab groups (also in 157) were not used: a collapsed group
 *   still shows its label in the tab strip and can't hold a pane layout.
 * - Pinned tabs can't be hidden (hideTab refuses), so they show in every window.
 * - New tabs (links, Ctrl+T, splits) join the current window (TabOpen). Selecting a tab of
 *   another window (palette, Firefox picking a tab after a close) switches to that window.
 * - Persisted with SessionStore: window value "tilefox-windows" (names, indices, layouts by tab
 *   uid, current/last) and tab value "tilefox-tab" ({w, u}); re-read on SSWindowRestored and
 *   promiseAllWindowsRestored, and per tab on SSTabRestoring (undo close tab).
 * - Each Firefox window (Ctrl+N) has its own TilefoxWindow, so its own windows and status bar.
 *
 * KEYS (mirror ~/.tmux.conf; the table is Core.KEYMAP, overridable with tilefox.keys.<id> prefs)
 * - Primary path: one capture-phase keydown listener on the chrome window. It sees every key
 *   before Firefox's <key> handlers and before the event is forwarded to web content, and logs
 *   each decision (Core.routeChromeKey).
 * - "Always" keys (Alt+Y/H, Alt+Arrow, Ctrl+Space, Ctrl+Shift+P, kill) are taken here. They are
 *   also fx-autoconfig Hotkeys (reserved="true", original <key>s disabled) as a secondary path;
 *   Core.PressLedger matches each path to the press it came from, so one press runs once.
 *   https://github.com/MrOtherGuy/fx-autoconfig#hotkeys
 * - "Pass when typing" keys (Ctrl+Y/H, Ctrl+Arrow, Ctrl+A) aimed at web content are decided in
 *   the content process by TilefoxChild (editable check) when that browser's actor has said
 *   hello; otherwise, and for chrome focus, decided here. Their Firefox <key>s stay enabled, so
 *   a passed-through key still does its normal job (redo, history, select all, word-jump); a
 *   taken key is preventDefault()ed, which stops the XUL <key> from firing.
 */

const Core = ChromeUtils.importESModule("chrome://userscripts/content/tilefox/TilefoxCore.sys.mjs");
const PREF_ENABLED = "tilefox.enabled";
const PREF_STATUSBAR = "tilefox.statusbar";
const PREF_KEYS_BRANCH = Core.KEY_PREF_BRANCH;
const logger = Core.getLogger();
const LOG = (...a) => logger.log(...a);
const ERR = (...a) => logger.error(...a);

// The TilefoxWindow of a Firefox window. Core's registry is the source of truth (the parent actor
// and fx-autoconfig's hotkey commands run in other modules); window.Tilefox is kept for debugging.
const tilefoxOf = w => Core.instanceForWindow(w) ?? w?.Tilefox ?? null;

const ARROW_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);
const SCRIPT_FILES = ["tilefox.uc.mjs", "tilefox_actor.sys.mjs"];
const STYLE_FILE = "tilefox.uc.css";

// Original Firefox <key> elements that our "always" bindings replace (computed from the key map).
// Matched by key + normalized modifiers instead of id, because ids/labels move between releases.
//   Alt+Left/Right  goBackKb / goForwardKb (Back / Forward)  browser/base/content/browser-sets.inc.xhtml
//   Ctrl+Shift+P    key_privatebrowsing (new private window)
// "Pass when typing" keys (Ctrl+Y redo, Ctrl+H history, Ctrl+A select all) are NOT disabled, so
// they keep working when tilefox passes them through.
function overriddenKeys(keyMap) {
  return keyMap.bindings.filter(b => b.typing === "take" && b.action !== "kill").map(b => Core.comboToOriginalKey(b.combo));
}

class TilefoxWindow {
  constructor(win) {
    this.win = win;
    this.doc = win.document;
    this.gBrowser = win.gBrowser;
    // Windows: each has its own layout tree ({tab} leaf | {dir:"row"|"col", a, b, ratio}).
    this.ws = new Core.WindowSet();
    this.ws.add();
    this.uids = new WeakMap(); // tab -> stable uid (persisted in the tab value)
    this.restored = false; // true once SessionStore data has been read; persist only after that
    this.layoutId = null; // temporarily point `root` at another window's layout
    this.suppressed = []; // original <key> elements we disabled
    this.ourKeyIds = [];
    this.wiredBrowsers = new WeakSet();
    // One press -> one action, run one at a time (Core.PressLedger / Core.ActionQueue).
    this.presses = new Core.PressLedger();
    this.queue = new Core.ActionQueue({
      onError: (e, label) => ERR(`action ${label} failed`, e),
      setTimer: (f, ms) => this.win.setTimeout(f, ms),
      clearTimer: id => this.win.clearTimeout(id),
    });
    this.switchWaitMs = 1500; // fallback only: longest wait for a tab switch (logged as a miss if hit)
    this.waiters = new Set(); // waitFor() checks, re-run on every tab / tab-switch event
    this.timing = null; // the running action's Core.ActionTiming
    this.latencies = []; // last 50 finished timings (debugging: Tilefox.latencies in the Browser Console)
    this.actorBrowsers = new WeakSet(); // browsers whose content actor has said hello
    this.paintPath = "none";
    this.loadKeyMap();
    this.panel = null;
    this.paletteItems = [];
    this.paletteIndex = 0;
  }

  get enabled() {
    return Services.prefs.getBoolPref(PREF_ENABLED, true);
  }

  // The layout of the current tilefox window (or of layoutId while withLayoutOf runs).
  get root() {
    return this.ws.get(this.layoutId ?? this.ws.current)?.root ?? null;
  }

  set root(v) {
    const w = this.ws.get(this.layoutId ?? this.ws.current);
    if (w) {
      w.root = v;
    }
  }

  withLayoutOf(id, fn) {
    const saved = this.layoutId;
    this.layoutId = id;
    try {
      return fn();
    } finally {
      this.layoutId = saved;
    }
  }

  // ---------------------------------------------------------------- setup
  loadKeyMap() {
    this.keyMap = Core.resolveKeyMap(name => Services.prefs.getStringPref(name, ""));
    for (const p of this.keyMap.problems) {
      ERR("key config:", p);
    }
    LOG("key map (mirrors ~/.tmux.conf):", Core.describeKeyMap(this.keyMap));
  }

  init() {
    LOG(`window init: Firefox ${Services.appinfo.version}, enabled = ${this.enabled}`);
    this.setupBackgroundPainting();
    this.defineHotkeys();
    this.buildPanel();

    this.buildStatusBar();
    logger.setOnWriteError((e, path) => this.notify(`tilefox: cannot write ${path} (${e?.message || e}). Details in the Browser Console (Ctrl+Shift+J).`));

    const tc = this.gBrowser.tabContainer;
    for (const tab of this.gBrowser.tabs) {
      this.adopt(tab);
    }
    this._onSelect = () => this.safe(() => { this.onTabSelect(); this.wake(); });
    this._onClose = e => this.safe(() => this.onTabClose(e.target));
    tc.addEventListener("TabSelect", this._onSelect);
    tc.addEventListener("TabClose", this._onClose);
    tc.addEventListener("TabOpen", e => this.safe(() => this.onTabOpen(e.target)));
    // A tab's <browser> and panel exist (Tabbrowser._insertBrowser): wakes settle()'s panel wait.
    tc.addEventListener("TabBrowserInserted", () => this.safe(() => this.wake()));
    tc.addEventListener("TabPinned", () => this.safe(() => this.applyVisibility()));
    tc.addEventListener("TabUnpinned", () => this.safe(() => this.applyVisibility()));
    tc.addEventListener("TabAttrModified", e => {
      if (e.detail?.changed?.includes("label")) {
        this.safe(() => this.updateStatus());
      }
    });
    tc.addEventListener("SSTabRestoring", e => this.safe(() => this.onTabRestoring(e.target)));
    this.win.addEventListener("SSWindowRestored", () => this.safe(() => this.restoreFromSession("SSWindowRestored")));
    const SS = this.win.SessionStore;
    Promise.resolve(SS?.promiseAllWindowsRestored).then(
      () => this.safe(() => this.restoreFromSession("promiseAllWindowsRestored")),
      e => ERR("promiseAllWindowsRestored", e));
    this.win.addEventListener("TabSwitchDone", () => this.safe(() => this.onSwitchDone()));
    this.win.addEventListener("TabSwitched", e => this.safe(() => this.onSwitched(e.detail?.tab)));
    // Chrome-focus Ctrl+Arrow (URL bar, toolbar). Content focus is TilefoxChild's job.
    this.win.addEventListener("keydown", e => this.safe(() => this.onChromeKeydown(e)), true);
    this.win.addEventListener("unload", () => { this.unloading = true; this.dissolve(); }, { once: true });

    this.prefObserver = { observe: () => this.safe(() => this.onEnabledChanged()) };
    Services.prefs.addObserver(PREF_ENABLED, this.prefObserver);
    // Key prefs apply live to the keydown listener; the secondary <key> elements need a restart.
    this.keysObserver = { observe: () => this.safe(() => { this.loadKeyMap(); this.applyKeyState(); }) };
    Services.prefs.addObserver(PREF_KEYS_BRANCH, this.keysObserver);
    this.statusObserver = { observe: () => this.safe(() => this.updateStatus()) };
    Services.prefs.addObserver(PREF_STATUSBAR, this.statusObserver);
    this.win.addEventListener("unload", () => {
      Services.prefs.removeObserver(PREF_ENABLED, this.prefObserver);
      Services.prefs.removeObserver(PREF_KEYS_BRANCH, this.keysObserver);
      Services.prefs.removeObserver(PREF_STATUSBAR, this.statusObserver);
    }, { once: true });

    if (!Services.prefs.prefHasUserValue(PREF_ENABLED)) {
      Services.prefs.setBoolPref(PREF_ENABLED, true);
    }
    LOG("ready in window; enabled =", this.enabled, "; background-pane painting path =", this.paintPath);
  }

  safe(fn) {
    try {
      return fn();
    } catch (e) {
      ERR("caught", e);
    }
    return undefined;
  }

  // Background panes must keep painting. Firefox only paints the selected tab unless
  // AsyncTabSwitcher.shouldDeactivateDocShell(browser) is false. Paths, best first:
  //  1. "native-splitViewBrowsers": shadow gBrowser.splitViewBrowsers (Firefox's own Split View
  //     list, read by shouldDeactivateDocShell). Present in 157.0.1 and 158.
  //  2. "switcher-patch": wrap gBrowser._getSwitcher() and patch each switcher's
  //     shouldDeactivateDocShell (for a release without splitViewBrowsers).
  //  3. "docshell-only": after every tab switch, force docShellIsActive/renderLayers back on.
  // activatePaneBrowsers() (path 3) always runs too, as a safety net.
  setupBackgroundPainting() {
    this.paintPath = Core.installPaintHook(this.gBrowser, () => this.activePaneBrowsers(), msg => LOG("feature:", msg));
    LOG("background-pane painting path:", this.paintPath);
  }

  defineHotkeys() {
    const H = this.win.UC_API?.Hotkeys;
    if (!H) {
      ERR("hotkeys: UC_API.Hotkeys missing; only the keydown listener will handle keys");
      return;
    }
    // Only "always" keys: a reserved <key> would fire before content could pass a key through.
    const defs = this.keyMap.bindings
      .filter(b => b.typing === "take")
      .map(b => ({ id: b.action === "kill" ? "tilefox-kill" : `tilefox-${b.id}`, combo: b.combo, action: b.action }));
    for (const d of defs) {
      const hk = Core.comboToHotkey(d.combo);
      try {
        const def = H.define({
          id: d.id,
          modifiers: hk.modifiers,
          key: hk.key,
          reserved: true,
          command: win => tilefoxOf(win)?.onHotkey(d.action),
        });
        // Kill switch stays live even when disabled, so it can toggle back on.
        Promise.resolve(def.attachToWindow(this.win, { suppressOriginal: d.action !== "kill" })).then(
          () => LOG(`hotkey ${d.id} (${Core.comboToString(d.combo)} -> ${d.action}) attached`),
          e => ERR(`hotkey ${d.id} attach failed`, e));
        if (d.action !== "kill") {
          this.ourKeyIds.push(d.id);
        }
      } catch (e) {
        ERR(`hotkey ${d.id} (${hk.modifiers} ${hk.key}) define failed`, e);
      }
    }

    // attachToWindow is async (waits for window load). Do our own robust suppression after it.
    // Run twice: Fluent fills in <key key="..."> attributes during localization.
    this.win.setTimeout(() => this.safe(() => this.applyKeyState()), 500);
    this.win.setTimeout(() => this.safe(() => { this.applyKeyState(); this.logKeyReport(); }), 3000);
  }

  logKeyReport() {
    for (const id of [...this.ourKeyIds, "tilefox-kill"]) {
      const el = this.doc.getElementById(id);
      LOG(`key check: #${id}`, el ? `present key=${el.getAttribute("key") || el.getAttribute("keycode")} modifiers=${el.getAttribute("modifiers")} disabled=${el.getAttribute("disabled") || "no"}` : "MISSING");
    }
    // Any other enabled <key> still bound to one of our combos would compete with ours.
    const rivals = this.findOriginalKeys().filter(k => k.getAttribute("disabled") !== "true");
    LOG("key check: enabled Firefox keys on our combos:", rivals.map(k => k.id || "(no id)").join(", ") || "none");
  }

  findOriginalKeys() {
    const out = [];
    const overridden = overriddenKeys(this.keyMap);
    for (const k of this.doc.querySelectorAll("key")) {
      if (k.closest("#ucKeySet")) {
        continue;
      }
      const mods = Core.normMods(k.getAttribute("modifiers"));
      const key = (k.getAttribute("key") || "").toLowerCase();
      const keycode = k.getAttribute("keycode") || "";
      if (overridden.some(o => o.mods === mods && (o.key ? o.key === key : o.keycode === keycode))) {
        out.push(k);
      }
    }
    return out;
  }

  applyKeyState() {
    const on = this.enabled;
    if (on) {
      for (const k of this.findOriginalKeys()) {
        if (k.getAttribute("disabled") !== "true") {
          k.setAttribute("disabled", "true");
          if (!this.suppressed.includes(k)) {
            this.suppressed.push(k);
          }
        }
      }
    } else {
      for (const k of this.suppressed) {
        k.removeAttribute("disabled");
      }
      // fx-autoconfig's suppressOriginal also disabled these; re-enable them too.
      for (const k of this.findOriginalKeys()) {
        k.removeAttribute("disabled");
      }
    }
    for (const id of this.ourKeyIds) {
      const el = this.doc.getElementById(id);
      if (!el) {
        continue;
      }
      if (on) {
        el.removeAttribute("disabled");
      } else {
        el.setAttribute("disabled", "true");
      }
    }
    // Most originals are already disabled by fx-autoconfig's suppressOriginal, so list what is
    // disabled now rather than only what this call disabled (the old line was always empty).
    const originals = on ? this.findOriginalKeys().filter(k => k.getAttribute("disabled") === "true") : [];
    LOG("keys", on ? "active" : "released", "- originals suppressed:",
      originals.map(k => k.id || k.getAttribute("key")).join(", ") || "none found");
  }

  // ---------------------------------------------------------------- actions
  // Every action goes through one queue: a split finishes (tab exists, layout applied, tab
  // switch done) before the next split, close or focus move starts. Returns the job's promise.
  // t0: when the key was pressed (epoch ms, see now()); defaults to now.
  runAction(action, via, t0 = this.now()) {
    if (action === "kill") {
      LOG("action kill via", via);
      return Promise.resolve(this.safe(() => this.toggleKillSwitch())); // never waits behind a stuck job
    }
    LOG("action", action, "via", via, this.queue.pending ? `(queued behind ${this.queue.pending})` : "");
    return this.queue.push(action, () => this.timed(action, via, t0));
  }

  // Runs one action and logs "split-col done in 37 ms: layout applied 2 ms, focus settled 37 ms ...",
  // all measured from the key press. Over Core.LATENCY_TARGET_MS or any fallback hit -> warning.
  async timed(action, via, t0) {
    const t = new Core.ActionTiming(action, via, t0, () => this.now());
    this.timing = t;
    try {
      await this.doAction(action, via);
    } finally {
      if (this.timing === t) {
        this.timing = null;
      }
      t.mark("focus");
      this.latencies.push(t);
      if (this.latencies.length > 50) {
        this.latencies.shift();
      }
      (t.slow ? logger.warn : logger.log).call(logger, t.describe());
      // The layout reaches the screen on the next refresh tick; log when that frame starts.
      // Off the hot path: the queue has already moved on.
      if (t.layout != null && typeof this.win.requestAnimationFrame === "function") {
        this.win.requestAnimationFrame(() => LOG(`${action}: next frame ${Math.round(this.now() - t0)} ms after the key`));
      }
    }
  }

  // Epoch ms with sub-ms precision, comparable across processes (the content actor sends the
  // same clock). Falls back to Date.now() when the window has no performance object.
  now() {
    const p = this.win.performance;
    return p && p.timeOrigin ? p.timeOrigin + p.now() : Date.now();
  }

  // When a key event happened, from its timeStamp (ms since this window's timeOrigin), so the
  // time before our listener ran is counted too. Implausible values fall back to now().
  eventTime(e) {
    const p = this.win.performance;
    const now = this.now();
    const t = p && p.timeOrigin && e?.timeStamp > 0 ? p.timeOrigin + e.timeStamp : now;
    return t <= now && now - t < 10000 ? t : now;
  }

  idle() {
    return this.queue.idle();
  }

  onHotkey(action) {
    const r = this.presses.xulKey(action);
    if (!r.run) {
      LOG(`xul-key ${action} - ignored: ${r.why}`);
      return;
    }
    this.runAction(action, "xul-key");
  }

  doAction(action, via) {
    if (!this.enabled) {
      LOG("action", action, "via", via, "- tilefox disabled, ignored");
      return undefined;
    }
    switch (action) {
      case "split-row": return this.split("row");
      case "split-col": return this.split("col");
      case "focus-left":
      case "focus-right":
      case "focus-up":
      case "focus-down": return this.moveFocus(action.slice(6));
      case "unpane": return this.unpane(this.gBrowser.selectedTab);
      case "prefix": return this.openPanel("prefix");
      case "reload": return this.reload();
      case "palette": return this.openPanel("palette");
      case "new-window": return this.newWindow();
      case "next-window": return this.selectWindow(this.ws.step(1));
      case "previous-window": return this.selectWindow(this.ws.step(-1));
      case "last-window": return this.lastWindow();
      case "choose-window": return this.openPanel("windows");
      case "rename-window": return this.openPanel("rename");
      case "kill-window": return this.openPanel("confirm");
    }
    if (action.startsWith("select-window-")) {
      return this.selectIndex(Number(action.slice(14)));
    }
    return undefined;
  }

  onActorAction(data, browser) {
    // The content echo can arrive after the press's split already selected a new tab, so it
    // is matched to its press, not to the selected browser (that check dropped fast presses).
    const id = browser?.browserId ?? null;
    if (!browser || !this.gBrowser.getTabForBrowser(browser)) {
      LOG("actor action", data.action, "from a browser not in this window - ignored");
      return;
    }
    const r = this.presses.content(data.action, id, data.via);
    if (!r.run) {
      LOG(`actor action ${data.action} from browser ${id} - ignored: ${r.why}`);
      return;
    }
    LOG(`actor action ${data.action} from browser ${id}: ${r.why}`);
    // data.t: the content keydown's time (same epoch clock as now()); clamped against skew.
    const now = this.now();
    const t0 = typeof data.t === "number" && data.t <= now && now - data.t < 10000 ? data.t : now;
    this.runAction(data.action, data.via, t0);
  }

  onActorHello(browser, data) {
    if (!browser || this.actorBrowsers.has(browser)) {
      return;
    }
    this.actorBrowsers.add(browser);
    LOG(`content actor alive in browser ${browser.browserId} (${data?.where || "?"})`);
  }

  toggleKillSwitch() {
    const next = !this.enabled;
    Services.prefs.setBoolPref(PREF_ENABLED, next);
    this.win.UC_API.Notifications.show({
      label: next
        ? "tilefox enabled"
        : "tilefox disabled: Firefox keys restored, panes dissolved. Ctrl+Alt+Shift+K turns it back on.",
      type: "tilefox-kill",
      priority: next ? "info" : "warning",
      window: this.win,
    }).catch(() => {});
  }

  onEnabledChanged() {
    if (!this.enabled) {
      this.closePanel();
      this.dissolve();
    }
    // Disabled: every tab is shown. Enabled again: only the current window's tabs.
    this.applyVisibility();
    this.updateStatus();
    this.applyKeyState();
  }

  // ---------------------------------------------------------------- windows
  isManaged(tab) {
    return !!tab && !tab.closing && tab !== this.win.FirefoxViewHandler?.tab;
  }

  uidOf(tab) {
    let u = this.uids.get(tab);
    if (!u) {
      u = Core.randomId();
      this.uids.set(tab, u);
    }
    return u;
  }

  liveTabs() {
    return [...this.gBrowser.tabs].filter(t => this.isManaged(t));
  }

  tabsOf(id) {
    return this.ws.tabsOf(id, this.liveTabs());
  }

  // Give an unowned tab to the current window.
  adopt(tab) {
    if (this.isManaged(tab) && !this.ws.ownerOf(tab)) {
      this.ws.assign(tab, this.ws.current);
      this.writeTabValue(tab);
    }
  }

  onTabOpen(tab) {
    if (!this.ws.get(this.ws.current)) {
      this.ws.current = this.ws.add().id;
    }
    this.adopt(tab);
    this.guardLastTab();
    this.updateStatus();
  }

  // Firefox picks the next tab after a close among VISIBLE tabs only (Tabbrowser
  // _findTabToBlurTo), but it tries tab.successor first. So when the current window is down to
  // one tab, its successor is the last window's tab: closing it lands there, like tmux.
  guardLastTab() {
    const gb = this.gBrowser;
    if (this.guarded && this.guarded.tab.successor === this.guarded.fallback && !this.guarded.tab.closing) {
      gb.setSuccessor(this.guarded.tab, null);
    }
    this.guarded = null;
    if (!this.enabled || typeof gb.setSuccessor !== "function") {
      return;
    }
    const mine = this.tabsOf(this.ws.current).filter(t => !t.pinned);
    if (mine.length !== 1 || mine[0].successor) {
      return;
    }
    const otherId = this.ws.get(this.ws.last) ? this.ws.last : this.ws.windows.find(w => w.id !== this.ws.current)?.id;
    const other = this.ws.get(otherId);
    const members = other ? this.tabsOf(other.id) : [];
    const fallback = members.includes(other?.active) ? other.active : members[0];
    if (fallback) {
      gb.setSuccessor(mine[0], fallback);
      this.guarded = { tab: mine[0], fallback };
    }
  }

  onTabSelect() {
    const tab = this.gBrowser.selectedTab;
    this.switchedTo = null; // a new switch starts; switchShown() waits for its own signal
    const owner = this.ws.ownerOf(tab);
    if (this.enabled && !this.switching && owner && owner !== this.ws.current && !tab.pinned) {
      // Deferred: this can run inside Firefox's tab removal (blur to the guard's successor).
      this.win.setTimeout(() => this.safe(() => {
        if (this.gBrowser.selectedTab === tab && this.ws.ownerOf(tab) === owner && owner !== this.ws.current) {
          LOG(`selected a tab of window ${this.ws.get(owner)?.index}: switching to it`);
          this.selectWindow(owner, { tab });
        }
      }), 0);
      return;
    }
    const w = this.ws.get(owner);
    if (w && owner === this.ws.current) {
      w.active = tab;
    }
    this.apply();
  }

  // Undo close tab / restored tabs: rejoin their old window if it still exists.
  onTabRestoring(tab) {
    if (!this.restored || !this.isManaged(tab)) {
      return;
    }
    const v = Core.parseTabValue(this.win.SessionStore.getCustomTabValue(tab, Core.TAB_VALUE));
    if (v) {
      const clash = this.liveTabs().some(t => t !== tab && this.uids.get(t) === v.u); // duplicated tab
      this.uids.set(tab, clash ? Core.randomId() : v.u);
      if (v.w && this.ws.get(v.w)) {
        this.ws.assign(tab, v.w);
      }
    }
    this.adopt(tab);
    this.writeTabValue(tab);
    this.applyVisibility();
    this.updateStatus();
  }

  // Rebuild the windows from SessionStore (startup, Ctrl+Shift+N "reopen closed window", restore session).
  restoreFromSession(why) {
    const SS = this.win.SessionStore;
    if (!SS || this.unloading) {
      return;
    }
    let data = null;
    try {
      data = JSON.parse(SS.getCustomWindowValue(this.win, Core.WINDOWS_VALUE) || "null");
    } catch (e) {
      ERR("windows: bad saved window value, starting fresh", e);
    }
    const values = new Map();
    const seen = new Set();
    for (const tab of this.liveTabs()) {
      const v = Core.parseTabValue(SS.getCustomTabValue(tab, Core.TAB_VALUE));
      if (v && !seen.has(v.u)) {
        seen.add(v.u);
        this.uids.set(tab, v.u);
        values.set(tab, v);
      }
    }
    if (data?.windows?.length) {
      for (const t of this.paneTabs()) {
        this.clearPanel(t);
      }
      const byUid = new Map([...values].map(([tab, v]) => [v.u, tab]));
      const ws = Core.WindowSet.fromJSON(data, u => byUid.get(u) || null);
      if (ws.windows.length) {
        for (const tab of this.liveTabs()) {
          const w = values.get(tab)?.w;
          ws.assign(tab, ws.get(w) ? w : ws.current);
        }
        // Windows whose tabs are all gone are dropped.
        for (const w of [...ws.windows]) {
          if (!ws.tabsOf(w.id, this.liveTabs()).length && ws.windows.length > 1) {
            ws.remove(w.id);
          }
        }
        this.ws = ws;
      }
    }
    // What's on screen wins: the restored selected tab decides the current window.
    const selOwner = this.ws.ownerOf(this.gBrowser.selectedTab);
    if (selOwner && selOwner !== this.ws.current) {
      this.ws.select(selOwner);
    }
    this.restored = true;
    for (const tab of this.liveTabs()) {
      this.writeTabValue(tab);
    }
    this.applyVisibility();
    this.apply();
    this.persistNow();
    LOG(`windows restored (${why}): ${this.ws.windows.length} window(s): ${this.statusText()}`);
  }

  writeTabValue(tab) {
    if (!this.restored || this.unloading) {
      return;
    }
    try {
      this.win.SessionStore.setCustomTabValue(tab, Core.TAB_VALUE, JSON.stringify({ w: this.ws.ownerOf(tab), u: this.uidOf(tab) }));
    } catch (e) {
      ERR("windows: setCustomTabValue failed", e);
    }
  }

  persist() {
    if (!this.restored || this.unloading) {
      return;
    }
    this.win.clearTimeout(this.persistTimer);
    this.persistTimer = this.win.setTimeout(() => this.safe(() => this.persistNow()), 150);
  }

  persistNow() {
    if (!this.restored || this.unloading) {
      return;
    }
    try {
      this.win.SessionStore.setCustomWindowValue(this.win, Core.WINDOWS_VALUE, JSON.stringify(this.ws.toJSON(t => this.uidOf(t))));
    } catch (e) {
      ERR("windows: setCustomWindowValue failed", e);
    }
  }

  // Show the current window's tabs (and pinned ones), hide the rest. Disabled: show everything.
  applyVisibility() {
    const gb = this.gBrowser;
    const selOwner = this.ws.ownerOf(gb.selectedTab);
    if (this.enabled && selOwner && selOwner !== this.ws.current && !gb.selectedTab.pinned) {
      this.ws.select(selOwner);
    }
    for (const tab of this.liveTabs()) {
      const owner = this.ws.ownerOf(tab);
      if (!this.enabled || !owner || owner === this.ws.current || tab.pinned) {
        if (tab.hidden && !this.win.SessionStore?.getCustomTabValue(tab, "hiddenBy")) {
          gb.showTab(tab); // never un-hide a tab an extension hid
        }
      } else if (!tab.hidden && !tab.selected) {
        gb.hideTab(tab);
      }
    }
  }

  // tmux select-window: instant, nothing reloads (tabs are only shown/hidden).
  selectWindow(id, { tab = null, newTab = false } = {}) {
    const gb = this.gBrowser;
    const w = this.ws.get(id);
    if (!w) {
      return;
    }
    const prev = this.ws.current;
    const before = gb.selectedTab;
    this.switching = true;
    let target;
    try {
      if (prev !== id) {
        // Park the old window's panes: plain hidden tabs until we come back.
        const old = this.ws.get(prev);
        if (old && this.ws.ownerOf(gb.selectedTab) === prev) {
          old.active = gb.selectedTab;
        }
        this.withLayoutOf(prev, () => {
          for (const t of this.paneTabs()) {
            this.clearPanel(t);
          }
        });
        this.ws.select(id);
      }
      let members = this.tabsOf(id);
      if (!members.length) {
        // TabOpen gives it to the (new) current window.
        gb.addTrustedTab(this.win.BROWSER_NEW_TAB_URL || "about:newtab");
        members = this.tabsOf(id);
        newTab = true;
      }
      target = tab && members.includes(tab) ? tab : members.includes(w.active) ? w.active : members[0];
      for (const t of members) {
        gb.showTab(t);
      }
      gb.selectedTab = target;
      w.active = target;
      this.applyVisibility();
      for (const t of this.liveTabs()) {
        const b = t.linkedBrowser;
        if (t.hidden && b?.docShellIsActive) {
          try { b.docShellIsActive = false; } catch (e) {}
        }
      }
    } finally {
      this.switching = false;
    }
    this.apply();
    LOG(`window ${prev === id ? "stays" : "->"} ${w.index}:${this.nameOf(w)} (${this.tabsOf(id).length} tab(s)); ${this.statusText()}`);
    // Focus once the tab switch is done (an event, not a timer); at once if the tab didn't change.
    const focus = () => this.safe(() => {
      if (gb.selectedTab !== target) {
        return;
      }
      if (newTab) {
        this.win.gURLBar?.select();
      } else {
        gb.selectedBrowser?.focus();
      }
    });
    if (target === before) {
      focus();
      return undefined;
    }
    return this.settle(target, "window").then(focus);
  }

  newWindow() {
    const w = this.ws.add();
    LOG(`new window ${w.index}`);
    return this.selectWindow(w.id, { newTab: true });
  }

  lastWindow() {
    if (!this.ws.get(this.ws.last)) {
      this.toast("no last window");
      return undefined;
    }
    return this.selectWindow(this.ws.last);
  }

  selectIndex(i) {
    const w = this.ws.byIndex(i);
    if (!w) {
      this.toast(`can't find window: ${i}`); // tmux's message
      return undefined;
    }
    return this.selectWindow(w.id);
  }

  renameWindow(name) {
    const w = this.ws.get(this.ws.current);
    if (!w) {
      return;
    }
    name = name.trim().slice(0, 32);
    w.name = name;
    w.auto = !name; // empty name: back to automatic naming
    LOG(`rename window ${w.index} -> ${name || "(automatic)"}`);
    this.updateStatus();
    this.persist();
  }

  killWindow(id = this.ws.current) {
    const w = this.ws.get(id);
    if (!w) {
      return;
    }
    if (this.ws.windows.length === 1) {
      this.toast("only one window: close the Firefox window instead (Ctrl+Shift+W)", 2500);
      return;
    }
    const tabs = this.tabsOf(id).filter(t => !t.pinned);
    LOG(`kill window ${w.index}:${this.nameOf(w)} (${tabs.length} tab(s))`);
    if (id === this.ws.current) {
      this.selectWindow(this.ws.get(this.ws.last) && this.ws.last !== id ? this.ws.last : this.ws.step(1));
    }
    this.withLayoutOf(id, () => {
      for (const t of this.paneTabs()) {
        this.clearPanel(t);
      }
    });
    this.ws.remove(id); // before closing, so TabClose doesn't treat it as an emptied window
    if (tabs.length) {
      this.gBrowser.removeTabs(tabs, { animate: false });
    }
    this.updateStatus();
    this.persist();
  }

  nameOf(w) {
    if (!w.auto) {
      return w.name;
    }
    const tab = w.id === this.ws.current && this.ws.ownerOf(this.gBrowser.selectedTab) === w.id
      ? this.gBrowser.selectedTab
      : (w.active && !w.active.closing ? w.active : this.tabsOf(w.id)[0]);
    let host = "";
    try { host = tab?.linkedBrowser?.currentURI?.host || ""; } catch (e) {}
    return Core.autoWindowName(host, tab?.label);
  }

  statusText() {
    for (const w of this.ws.windows) {
      if (w.auto) {
        w.name = this.nameOf(w);
      }
    }
    return this.ws.status();
  }

  // tmux status line (toggle with the tilefox.statusbar pref). Sits under the toolbars.
  buildStatusBar() {
    const HTML = "http://www.w3.org/1999/xhtml";
    const bar = this.doc.createElementNS(HTML, "div");
    bar.id = "tilefox-status";
    const toolbox = this.doc.getElementById("navigator-toolbox");
    (toolbox || this.doc.getElementById("browser")?.parentNode)?.append(bar);
    bar.addEventListener("click", e => this.safe(() => {
      const id = e.target?.closest?.("[data-wid]")?.dataset.wid;
      if (id) {
        this.selectWindow(id);
      }
    }));
    this.statusBar = bar;
  }

  updateStatus() {
    const bar = this.statusBar;
    if (!bar) {
      return;
    }
    const show = this.enabled && Services.prefs.getBoolPref(PREF_STATUSBAR, true);
    bar.hidden = !show;
    if (!show) {
      return;
    }
    this.statusText(); // refresh automatic names
    const HTML = "http://www.w3.org/1999/xhtml";
    bar.replaceChildren(...this.ws.windows.map(w => {
      const span = this.doc.createElementNS(HTML, "span");
      const flag = w.id === this.ws.current ? "*" : w.id === this.ws.last ? "-" : "";
      span.textContent = `${w.index}:${w.name}${flag}`;
      span.dataset.wid = w.id;
      span.className = "tilefox-win" + (flag === "*" ? " current" : "");
      span.title = `${this.tabsOf(w.id).length} tab(s). Click, or Alt+${w.index} / prefix ${w.index}`;
      return span;
    }));
  }

  // ---------------------------------------------------------------- layout tree
  leaves(node = this.root, out = []) {
    if (!node) {
      return out;
    }
    if (node.tab) {
      out.push(node);
    } else {
      this.leaves(node.a, out);
      this.leaves(node.b, out);
    }
    return out;
  }

  paneTabs() {
    return this.leaves().map(l => l.tab);
  }

  isPane(tab) {
    return this.paneTabs().includes(tab);
  }

  layoutVisible() {
    return !!this.root && this.isPane(this.gBrowser.selectedTab);
  }

  activePaneBrowsers() {
    return this.layoutVisible() ? this.paneTabs().map(t => t.linkedBrowser).filter(Boolean) : [];
  }

  // Replace node `target` (by identity) with `replacement` in the tree.
  replaceNode(target, replacement, node = this.root, parent = null, side = null) {
    if (!node) {
      return false;
    }
    if (node === target) {
      if (!parent) {
        this.root = replacement;
      } else {
        parent[side] = replacement;
      }
      return true;
    }
    if (node.tab) {
      return false;
    }
    return this.replaceNode(target, replacement, node.a, node, "a")
      || this.replaceNode(target, replacement, node.b, node, "b");
  }

  findParent(target, node = this.root) {
    if (!node || node.tab) {
      return null;
    }
    if (node.a === target || node.b === target) {
      return node;
    }
    return this.findParent(target, node.a) || this.findParent(target, node.b);
  }

  split(dir) {
    const gb = this.gBrowser;
    const sel = gb.selectedTab;
    if (sel.splitview) {
      this.notify("tilefox: this tab is in Firefox's own Split View. Unsplit it first (tab context menu).");
      return;
    }
    if (!this.root || !this.isPane(sel)) {
      // One layout per window in this spike: splitting a non-pane tab starts a fresh layout.
      this.dissolve();
      this.root = { tab: sel };
    }
    const leaf = this.leaves().find(l => l.tab === sel);
    const newTab = gb.addTrustedTab("about:newtab", { relatedToCurrent: true, ownerTab: sel });
    const newLeaf = { tab: newTab };
    this.replaceNode(leaf, { dir, a: leaf, b: newLeaf, ratio: 0.5 });
    LOG(`split ${dir}: pane ${this.paneTabs().indexOf(sel) + 1} -> new pane ${this.paneTabs().indexOf(newTab) + 1} of ${this.paneTabs().length}`);
    gb.selectedTab = newTab; // fires TabSelect -> apply()
    this.apply();
    return this.settle(newTab, "split");
  }

  // Resolves once `tab` has its panel, the tab switch to it is done (switchShown) and the
  // layout is applied again. Each wait gives up after switchWaitMs, logging which step stalled;
  // that fallback should never fire, and the action's timing line flags it if it does.
  async settle(tab, why) {
    const gb = this.gBrowser;
    if (!(await this.waitFor(() => tab.closing || (tab.linkedPanel && tab.linkedBrowser)))) {
      this.timing?.fallback("panel");
      LOG(`${why}: new tab still has no panel after ${this.switchWaitMs} ms; continuing`);
    }
    if (gb.selectedTab === tab && !tab.closing && !(await this.switchDone(tab))) {
      this.timing?.fallback("tab switch");
      LOG(`${why}: tab switch not finished (no TabSwitched) after ${this.switchWaitMs} ms; continuing`);
    }
    this.timing?.mark("switch");
    this.apply();
  }

  // Resolves true as soon as cond() holds. No polling: cond is re-checked on every tab event
  // that can change it (wake(): TabSwitched, TabSwitchDone, TabSelect, TabBrowserInserted,
  // TabClose). Resolves false after switchWaitMs if none of them made it true.
  waitFor(cond) {
    if (cond()) {
      return Promise.resolve(true);
    }
    return new Promise(resolve => {
      let timer = null;
      const finish = ok => {
        this.waiters.delete(check);
        this.win.clearTimeout(timer);
        resolve(ok);
      };
      const check = () => {
        if (cond()) {
          finish(true);
        }
      };
      this.waiters.add(check);
      timer = this.win.setTimeout(() => finish(!!cond()), this.switchWaitMs);
    });
  }

  wake() {
    for (const check of [...this.waiters]) {
      this.safe(check);
    }
  }

  // Is the switch to `tab` finished? Firefox 157 AsyncTabSwitcher dispatches "TabSwitched"
  // ({detail: {tab}}) from maybeFinishTabSwitch() once the requested tab is painted, and
  // "TabSwitchDone" only from finish(), when every background tab has settled. With live panes
  // finish() is late or never comes (the 18:57 log: every split/focus waited the full 1.5 s).
  // Both are dispatched through gBrowser.dispatchEvent -> tabpanels and bubble to the window.
  // The switcher state is also read directly, because requestTab() of the tab that is already
  // requested starts no switch and sends no event.
  //   browser/components/tabbrowser/AsyncTabSwitcher.sys.mjs (FIREFOX_157_0_1_RELEASE)
  switchShown(tab) {
    const gb = this.gBrowser;
    if (gb.selectedTab !== tab || tab.closing) {
      return false;
    }
    if (this.switchedTo === tab) {
      return true;
    }
    const sw = gb._switcher;
    if (!sw) {
      // No switch running: done if the browser is active (finish() destroyed the switcher).
      return !!tab.linkedBrowser?.docShellIsActive;
    }
    return sw.requestedTab === tab && !sw.switchInProgress
      && (typeof sw.getTabState !== "function" || sw.getTabState(tab) === sw.STATE_LOADED);
  }

  // Also ends when another tab gets selected meanwhile: there is nothing left to wait for.
  switchDone(tab) {
    return this.waitFor(() => this.gBrowser.selectedTab !== tab || tab.closing || this.switchShown(tab));
  }

  onSwitched(tab) {
    if (tab && tab === this.gBrowser.selectedTab) {
      this.switchedTo = tab;
    }
    this.wake();
  }

  onSwitchDone() {
    this.switchedTo = this.gBrowser.selectedTab;
    this.activatePaneBrowsers();
    this.wake();
  }

  unpane(tab) {
    const leaf = this.leaves().find(l => l.tab === tab);
    if (!leaf) {
      return;
    }
    this.removeLeaf(leaf);
    if (this.root && this.gBrowser.selectedTab === tab) {
      // keep the layout on screen: focus the first remaining pane
      this.gBrowser.selectedTab = this.leaves()[0].tab;
    }
    this.apply();
    return this.settle(this.gBrowser.selectedTab, "unpane");
  }

  removeLeaf(leaf) {
    this.clearPanel(leaf.tab);
    const parent = this.findParent(leaf);
    if (!parent) {
      this.root = null;
    } else {
      const sibling = parent.a === leaf ? parent.b : parent.a;
      this.replaceNode(parent, sibling);
    }
    if (this.root && this.root.tab) {
      // a single pane is just a tab
      this.clearPanel(this.root.tab);
      this.root = null;
    }
  }

  onTabClose(tab) {
    if (this.unloading) {
      return;
    }
    const owner = this.ws.ownerOf(tab);
    const leaf = owner && this.withLayoutOf(owner, () => this.leaves().find(l => l.tab === tab));
    if (leaf) {
      this.withLayoutOf(owner, () => this.removeLeaf(leaf));
    }
    this.ws.unassign(tab);
    // tmux: closing a window's last tab kills the window and goes to the last one.
    if (owner && this.ws.get(owner) && !this.tabsOf(owner).filter(t => t !== tab).length) {
      const wasCurrent = owner === this.ws.current;
      LOG(`window ${this.ws.get(owner).index} closed its last tab: window gone`);
      this.ws.remove(owner);
      if (!this.ws.windows.length) {
        this.ws.add(); // the Firefox window lives on (closeWindowWithLastTab = false)
      }
      if (wasCurrent) {
        const next = this.ws.current;
        this.win.setTimeout(() => this.safe(() => this.selectWindow(next)), 0);
      }
    }
    this.wake(); // a wait on this tab ends (cond checks tab.closing)
    // Defer: the closing tab's replacement selection happens after TabClose.
    this.win.setTimeout(() => this.safe(() => this.apply()), 0);
  }

  dissolve() {
    for (const leaf of this.leaves()) {
      this.clearPanel(leaf.tab);
      const b = leaf.tab.linkedBrowser;
      if (b && leaf.tab !== this.gBrowser.selectedTab) {
        try { b.docShellIsActive = false; } catch (e) {}
      }
    }
    this.root = null;
    this.apply();
  }

  // ---------------------------------------------------------------- rendering
  rects() {
    return Core.layoutRects(this.root);
  }

  panelOf(tab) {
    return tab?.linkedPanel ? this.doc.getElementById(tab.linkedPanel) : null;
  }

  clearPanel(tab) {
    const p = this.panelOf(tab);
    if (!p) {
      return;
    }
    p.classList.remove("tilefox-pane");
    for (const prop of ["--tf-left", "--tf-top", "--tf-width", "--tf-height"]) {
      p.style.removeProperty(prop);
    }
  }

  apply() {
    const tabpanels = this.gBrowser.tabpanels;
    const visible = this.enabled && this.layoutVisible();
    tabpanels.toggleAttribute("tilefox", visible);
    const rects = this.rects();
    for (const [tab, r] of rects) {
      const p = this.panelOf(tab);
      if (!p) {
        continue;
      }
      p.classList.add("tilefox-pane");
      // Only take effect under #tabbrowser-tabpanels[tilefox] (see tilefox.uc.css).
      p.style.setProperty("--tf-left", r.x + "%");
      p.style.setProperty("--tf-top", r.y + "%");
      p.style.setProperty("--tf-width", r.w + "%");
      p.style.setProperty("--tf-height", r.h + "%");
      this.wireBrowser(tab.linkedBrowser);
    }
    this.publishPaneIds();
    if (visible) {
      this.activatePaneBrowsers();
    }
    if (this.timing && this.timing.layout == null) {
      this.timing.mark("layout"); // the first apply() of the action is when the panes move
    }
    this.guardLastTab();
    this.updateStatus();
    this.persist();
  }

  activatePaneBrowsers() {
    // Mirrors Tabbrowser.showSplitViewPanels(): docShellIsActive = true paints the browser.
    // renderLayers is what AsyncTabSwitcher toggles for remote browsers; restore it too.
    for (const b of this.activePaneBrowsers()) {
      try {
        if (!b.docShellIsActive) {
          b.docShellIsActive = true;
        }
        if ("renderLayers" in b && !b.renderLayers) {
          b.renderLayers = true;
        }
      } catch (e) {
        ERR("activate pane browser failed", e);
      }
    }
  }

  publishPaneIds() {
    // Tell content processes which browsers are panes (TilefoxChild reads this).
    // Union across all windows, because sharedData is global.
    const ids = [];
    for (const w of Services.wm.getEnumerator("navigator:browser")) {
      for (const b of tilefoxOf(w)?.activePaneBrowsers() || []) {
        if (b.browserId) {
          ids.push(b.browserId);
        }
      }
    }
    Services.ppmm.sharedData.set("tilefox:paneBrowserIds", ids);
    Services.ppmm.sharedData.flush();
  }

  wireBrowser(browser) {
    if (!browser || this.wiredBrowsers.has(browser)) {
      return;
    }
    this.wiredBrowsers.add(browser);
    const select = () => this.safe(() => {
      const tab = this.gBrowser.getTabForBrowser(browser);
      if (this.enabled && tab && this.layoutVisible() && this.isPane(tab) && tab !== this.gBrowser.selectedTab) {
        this.gBrowser.selectedTab = tab;
      }
    });
    browser.addEventListener("focus", select);
    const container = browser.closest(".browserContainer");
    container?.addEventListener("mousedown", select, true);
    container?.addEventListener("click", select, true);
  }

  // ---------------------------------------------------------------- focus movement
  moveFocus(dir) {
    if (!this.layoutVisible()) {
      LOG("focus", dir, "- no pane layout on screen");
      return;
    }
    const best = Core.findNeighbour(this.rects(), this.gBrowser.selectedTab, dir);
    if (!best) {
      LOG("focus", dir, "- no other pane to move to");
      return;
    }
    LOG("focus", dir, "-> pane", this.paneTabs().indexOf(best) + 1);
    this.gBrowser.selectedTab = best;
    return this.settle(best, "focus").then(() => {
      if (this.gBrowser.selectedTab === best) {
        best.linkedBrowser?.focus();
      }
    });
  }

  // Capture-phase keydown on the chrome window: runs before Firefox's <key> handlers and
  // before the event is forwarded to web content.
  onChromeKeydown(e) {
    if (!e.ctrlKey && !e.altKey) {
      return;
    }
    const b = Core.bindingFor(this.keyMap, e);
    if (!b) {
      return;
    }
    // A held key: arrows keep moving focus (tmux bind -r); any other key must not add panes.
    // Repeats are still taken (preventDefault) so Firefox's own Ctrl+H / Alt+H don't fire.
    const repeat = e.repeat && !ARROW_KEYS.has(e.key);
    const keyName = Core.comboToString(b.combo);
    const t = e.composedTarget || e.target;
    const where = t?.localName === "browser" ? `browser ${t.browserId}` : `<${t?.localName || "?"}${t?.id ? "#" + t.id : ""}>`;
    const decide = msg => LOG(`key ${keyName} (code ${e.code}${repeat ? ", repeat" : ""}) at ${where} -> ${msg}`);
    const browser = t?.localName === "browser" ? t : t?.closest?.("browser");
    const browserId = browser?.browserId ?? null;
    const take = (why, via = "keydown") => {
      e.preventDefault();
      e.stopPropagation();
      this.presses.record({ action: b.action, verdict: "take", browserId, repeat });
      if (repeat) {
        return decide(`swallowed (key repeat; ${why})`);
      }
      decide(`${b.action} (${why})`);
      this.runAction(b.action, via, this.eventTime(e));
    };

    if (b.action === "kill") {
      return take("kill switch");
    }
    if (!this.enabled) {
      return decide("pass through (tilefox disabled)");
    }
    const chromeEditable = !browser && this.chromeEditable(t);
    const { verdict, why } = Core.routeChromeKey(b, {
      inContent: !!browser,
      actorAlive: !!browser && this.actorBrowsers.has(browser),
      chromeEditable,
      chromeFieldEmpty: chromeEditable && this.chromeFieldEmpty(),
      layoutVisible: this.layoutVisible(),
    });
    if (verdict === "take") {
      return take(why, browser && b.typing === "pass" ? "chrome-fallback" : "keydown");
    }
    if (verdict === "defer") {
      this.presses.record({ action: b.action, verdict: "defer", browserId, repeat });
    }
    decide(verdict === "defer" ? `deferred to content actor (${why})` : `pass through (${why})`);
  }

  chromeFieldEmpty() {
    const el = this.doc.activeElement?.shadowRoot?.activeElement || this.doc.activeElement;
    return !!el && (el.localName === "input" || el.localName === "textarea") && el.value === "";
  }

  chromeEditable(t) {
    const el = this.doc.activeElement?.shadowRoot?.activeElement || this.doc.activeElement || t;
    if (!el) {
      return false;
    }
    if (el.localName === "input" || el.localName === "textarea" || el.isContentEditable) {
      return true;
    }
    return !!el.closest?.("#urlbar, #searchbar, moz-input-box");
  }

  // ---------------------------------------------------------------- prefix + palette panel
  buildPanel() {
    const doc = this.doc;
    const HTML = "http://www.w3.org/1999/xhtml";
    const panel = doc.createXULElement("panel");
    panel.id = "tilefox-panel";
    panel.setAttribute("noautofocus", "true");
    panel.setAttribute("consumeoutsideclicks", "false");
    const box = doc.createElementNS(HTML, "div");
    box.className = "tilefox-box";
    const hint = doc.createElementNS(HTML, "div");
    hint.className = "tilefox-hint";
    const input = doc.createElementNS(HTML, "input");
    input.className = "tilefox-input";
    input.setAttribute("placeholder", "jump to pane / tab...");
    const list = doc.createElementNS(HTML, "ul");
    list.className = "tilefox-list";
    box.append(hint, input, list);
    panel.append(box);
    (doc.getElementById("mainPopupSet") || doc.documentElement).append(panel);
    this.panel = panel;
    this.hint = hint;
    this.input = input;
    this.list = list;

    input.addEventListener("keydown", e => this.safe(() => this.onPanelKey(e)));
    input.addEventListener("input", () => this.safe(() => this.renderPalette()));
    panel.addEventListener("popupshown", () => input.focus());
    panel.addEventListener("popuphidden", () => {
      this.prefixTimer && this.win.clearTimeout(this.prefixTimer);
      if (this.restoreFocusOnHide) {
        this.gBrowser.selectedBrowser?.focus();
      }
    });
  }

  openPanel(mode) {
    if (this.panel.state === "open") {
      this.closePanel(false);
    }
    this.restoreFocusOnHide = true;
    this.setMode(mode);
    if (mode === "prefix") {
      this.prefixTimer = this.win.setTimeout(() => this.closePanel(), 2500);
    }
    const anchor = this.gBrowser.tabpanels;
    const width = mode === "prefix" ? 640 : 560;
    const x = Math.max(0, (anchor.getBoundingClientRect().width - width) / 2);
    this.panel.openPopup(anchor, "overlap", x, 40, false, false);
  }

  setMode(mode) {
    this.mode = mode;
    this.panel.setAttribute("mode", mode);
    this.input.value = "";
    const cur = this.ws.get(this.ws.current);
    switch (mode) {
      case "prefix":
        this.hint.textContent = "tilefox  y/h: split  arrows: move  x: unpane  |  c: new window  n/p: next/prev  l: last  0-9  ,: rename  w: windows  &: kill  |  f: palette  r: reload  Esc";
        break;
      case "rename":
        this.hint.textContent = `(rename-window) ${cur?.index}: Enter to save, empty = automatic name, Esc to cancel`;
        this.input.value = cur && !cur.auto ? cur.name : "";
        this.input.setAttribute("placeholder", cur ? this.nameOf(cur) : "");
        this.input.select();
        break;
      case "confirm":
        this.confirmId = this.ws.current;
        this.hint.textContent = `kill-window ${cur?.index}:${cur ? this.nameOf(cur) : "?"} and close its ${this.tabsOf(this.ws.current).filter(t => !t.pinned).length} tab(s)? (y/n)`;
        break;
      case "windows":
        this.hint.textContent = "Windows. Enter: switch, Esc: close";
        this.input.setAttribute("placeholder", "window...");
        this.renderPalette();
        break;
      default:
        this.hint.textContent = "Windows, panes (▣) and tabs. Enter: jump, Esc: close";
        this.input.setAttribute("placeholder", "jump to window / pane / tab...");
        this.renderPalette();
    }
  }

  closePanel(restore = true) {
    this.restoreFocusOnHide = restore;
    if (this.panel && this.panel.state !== "closed") {
      this.panel.hidePopup();
    }
  }

  onPanelKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      this.closePanel();
      return;
    }
    if (this.mode === "prefix") {
      e.preventDefault();
      e.stopPropagation();
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) {
        return; // modifier still held from Ctrl+A / Ctrl+Space
      }
      const action = Core.prefixActionFor(e);
      LOG(`prefix key ${e.key} (code ${e.code}) -> ${action || "cancel"}`);
      const inPlace = { palette: "palette", "choose-window": "windows", "rename-window": "rename", "kill-window": "confirm" }[action];
      if (inPlace && this.enabled) {
        // switch mode in place (re-opening a panel that is still hiding is unreliable)
        this.win.clearTimeout(this.prefixTimer);
        this.setMode(inPlace);
        return;
      }
      this.closePanel(!action || action === "unpane" || action === "reload");
      if (action) {
        this.runAction(action, "prefix");
      }
      return;
    }
    if (this.mode === "confirm") {
      e.preventDefault();
      e.stopPropagation();
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) {
        return;
      }
      const yes = e.key === "y" || e.key === "Y";
      LOG(`kill-window confirm: ${e.key} -> ${yes ? "kill" : "cancel"}`);
      this.closePanel(!yes);
      if (yes) {
        this.killWindow(this.confirmId);
      }
      return;
    }
    if (this.mode === "rename") {
      if (e.key === "Enter") {
        e.preventDefault();
        const name = this.input.value;
        this.closePanel();
        this.renameWindow(name);
      }
      return;
    }
    // palette / window list
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = this.paletteItems.length;
      if (n) {
        this.paletteIndex = (this.paletteIndex + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
        this.highlight();
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = this.paletteItems[this.paletteIndex];
      this.closePanel(false);
      if (item) {
        this.jumpTo(item);
      }
    }
  }

  // rank: 0 panes of the current window, 1 tilefox windows, 2 tabs of the current window,
  // 3 tabs of other tilefox windows, 4+ anything in other Firefox windows.
  allItems(windowsOnly = false) {
    const items = [];
    for (const w of Services.wm.getEnumerator("navigator:browser")) {
      const t = tilefoxOf(w);
      const other = w !== this.win;
      for (const tw of t?.ws.windows || []) {
        const name = t.nameOf(tw);
        const n = t.tabsOf(tw.id).length;
        items.push({
          win: w, wid: tw.id, rank: other ? 5 : 1,
          text: `window:${name} ${tw.index}`,
          label: `window:${name}`,
          host: `#${tw.index}, ${n} tab${n === 1 ? "" : "s"}${tw.id === t.ws.current ? ", current" : ""}`,
          other,
        });
      }
      if (windowsOnly) {
        continue;
      }
      const panes = t ? t.paneTabs() : [];
      for (const tab of w.gBrowser.tabs) {
        const owner = t?.ws.ownerOf(tab);
        if (tab.closing || (tab.hidden && !owner)) {
          continue; // hidden by an extension / Firefox View
        }
        const pane = panes.indexOf(tab);
        const elsewhere = owner && owner !== t.ws.current;
        const tw = elsewhere ? t.ws.get(owner) : null;
        let host = "";
        try { host = tab.linkedBrowser?.currentURI?.host || ""; } catch (e) {}
        items.push({
          win: w,
          tab,
          pane: pane >= 0 ? pane + 1 : 0,
          rank: (other ? 4 : 0) + (pane >= 0 ? 0 : elsewhere ? 3 : 2),
          text: `${tab.label} ${host}${tw ? " " + t.nameOf(tw) : ""}`,
          label: `${tw ? `[${tw.index}:${t.nameOf(tw)}] ` : ""}${tab.label || "(untitled)"}`,
          host,
          other,
        });
      }
    }
    return items.sort((a, b) => a.rank - b.rank);
  }

  renderPalette() {
    const q = this.input.value.trim();
    const scored = this.allItems(this.mode === "windows")
      .map(it => ({ it, s: Core.fuzzy(q, it.text) }))
      .filter(x => x.s > 0);
    if (q) {
      scored.sort((a, b) => b.s - a.s);
    }
    this.paletteItems = scored.slice(0, 30).map(x => x.it);
    this.paletteIndex = 0;
    this.list.replaceChildren();
    const HTML = "http://www.w3.org/1999/xhtml";
    this.paletteItems.forEach((it, i) => {
      const li = this.doc.createElementNS(HTML, "li");
      li.textContent = `${it.pane ? "▣" + it.pane + " " : ""}${it.label}${it.host ? "  · " + it.host : ""}${it.other ? "  (other Firefox window)" : ""}`;
      li.addEventListener("mousedown", ev => {
        ev.preventDefault();
        this.closePanel(false);
        this.jumpTo(it);
      });
      if (i === 0) {
        li.setAttribute("selected", "true");
      }
      this.list.append(li);
    });
  }

  highlight() {
    [...this.list.children].forEach((li, i) => li.toggleAttribute("selected", i === this.paletteIndex));
    this.list.children[this.paletteIndex]?.scrollIntoView({ block: "nearest" });
  }

  jumpTo(item) {
    const t = tilefoxOf(item.win);
    item.win.focus();
    if (item.wid) {
      t?.selectWindow(item.wid);
      return;
    }
    const owner = t?.ws.ownerOf(item.tab);
    if (owner && owner !== t.ws.current) {
      t.selectWindow(owner, { tab: item.tab });
      return;
    }
    item.win.gBrowser.selectedTab = item.tab;
    item.win.setTimeout(() => item.tab.linkedBrowser?.focus(), 0);
  }

  // prefix r (tmux: `bind r source-file ~/.tmux.conf; display-message "Reloaded"`).
  // Re-reads the key map and re-applies key state + layout in every window, re-registers the
  // stylesheet from disk, and marks the startup cache stale so edited .mjs files load on the
  // next restart (running ES modules can't be swapped out in place).
  reload() {
    LOG("reload requested");
    let css = false;
    try {
      css = !!this.win.UC_API?.Scripts?.reloadStyleSheet(STYLE_FILE);
    } catch (e) {
      ERR("reload: stylesheet", e);
    }
    let windows = 0;
    for (const w of Services.wm.getEnumerator("navigator:browser")) {
      const t = tilefoxOf(w);
      t?.safe(() => {
        t.loadKeyMap();
        t.applyKeyState();
        t.apply();
        windows++;
      });
    }
    try {
      Services.appinfo.invalidateCachesOnRestart();
    } catch (e) {
      ERR("reload: invalidateCachesOnRestart", e);
    }
    const problems = this.keyMap.problems.length;
    LOG(`reload done: key map + layout in ${windows} window(s), css ${css ? "reloaded" : "NOT reloaded"}, startup cache cleared on next restart (${SCRIPT_FILES.join(", ")} edits apply after restart)`);
    this.toast(problems ? `Reloaded (${problems} key config problem(s), see tilefox.log)` : "Reloaded");
  }

  // Brief self-closing message (tmux display-message). Its own panel, so it never takes focus
  // and never races the prefix panel that is still hiding.
  toast(text, ms = 1500) {
    const doc = this.doc;
    if (!this.toastPanel) {
      const panel = doc.createXULElement("panel");
      panel.id = "tilefox-toast";
      panel.setAttribute("noautofocus", "true");
      panel.setAttribute("consumeoutsideclicks", "false");
      const box = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
      box.className = "tilefox-box";
      panel.append(box);
      (doc.getElementById("mainPopupSet") || doc.documentElement).append(panel);
      this.toastPanel = panel;
    }
    this.toastPanel.firstChild.textContent = `tilefox: ${text}`;
    this.win.clearTimeout(this.toastTimer);
    if (this.toastPanel.state === "closed") {
      const anchor = this.gBrowser.tabpanels;
      const x = Math.max(0, (anchor.getBoundingClientRect().width - 320) / 2);
      this.toastPanel.openPopup(anchor, "overlap", x, 40, false, false);
    }
    this.toastTimer = this.win.setTimeout(() => this.toastPanel.hidePopup(), ms);
  }

  notify(label) {
    this.win.UC_API.Notifications.show({ label, type: "tilefox", priority: "info", window: this.win }).catch(() => {});
  }
}

// ---------------------------------------------------------------- boot
(function boot() {
  const win = window;
  if (tilefoxOf(win)) {
    return;
  }
  const start = () => {
    try {
      const t = new TilefoxWindow(win);
      win.Tilefox = t;
      const unregister = Core.registerInstance(t);
      win.addEventListener("unload", unregister, { once: true });
      t.init();
    } catch (e) {
      ERR("init failed", e);
    }
  };
  win.addEventListener("error", e => {
    if (String(e.filename || "").includes("tilefox")) {
      ERR("uncaught", e.error || e.message, `${e.filename}:${e.lineno}`);
    }
  });
  // gBrowser is not safe to touch until the window has finished loading:
  // https://github.com/MrOtherGuy/fx-autoconfig#startup-error
  UC_API.Windows.waitWindowLoading(win).then(start, e => ERR("waitWindowLoading", e));
})();
