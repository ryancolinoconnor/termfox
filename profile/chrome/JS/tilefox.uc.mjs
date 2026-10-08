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
 * KEYS
 * - Primary path: one capture-phase keydown listener on the chrome window. It sees every key
 *   before Firefox's <key> handlers and before the event is forwarded to web content, and logs
 *   each decision. Split keys come from prefs tilefox.keys.splitRight (default Ctrl+Y, pane to
 *   the right) and tilefox.keys.splitDown (default Ctrl+H, pane below).
 * - Secondary path: the same keys as fx-autoconfig Hotkeys (reserved="true", original <key>s
 *   disabled). runAction() dedupes, so a key handled by both paths runs once.
 *   https://github.com/MrOtherGuy/fx-autoconfig#hotkeys
 * - Ctrl+Arrow: decided in the content process by TilefoxChild (editable check) when that
 *   browser's actor has said hello; otherwise, and for chrome focus, decided here.
 */

const Core = ChromeUtils.importESModule("chrome://userscripts/content/tilefox/TilefoxCore.sys.mjs");
const PREF_ENABLED = "tilefox.enabled";
const PREF_KEYS_BRANCH = "tilefox.keys.";
const logger = Core.getLogger();
const LOG = (...a) => logger.log(...a);
const ERR = (...a) => logger.error(...a);

// Fixed keys (not configurable in the spike).
const FIXED = {
  prefix: Core.parseCombo("Ctrl+Space"),
  palette: Core.parseCombo("Ctrl+Shift+P"),
  kill: Core.parseCombo("Ctrl+Alt+Shift+K"),
};
const ARROW_DIRS = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };

// Original Firefox <key> elements that our bindings replace (computed from the key map).
// Matched by key + normalized modifiers instead of id, because ids/labels move between releases.
//   Ctrl+H        key_gotoHistory   (history sidebar)    browser/base/content/browser-sets.inc.xhtml
//   Ctrl+Y        key_redo          (Windows redo)       browser/base/content/browser-sets.inc.xhtml
//   Ctrl+Shift+P  key_privatebrowsing (new private window)
function overriddenKeys(keyMap) {
  return [keyMap.splitRight, keyMap.splitDown, FIXED.palette, FIXED.prefix].map(Core.comboToOriginalKey);
}

class TilefoxWindow {
  constructor(win) {
    this.win = win;
    this.doc = win.document;
    this.gBrowser = win.gBrowser;
    this.root = null; // layout tree: {tab} leaf | {dir:"row"|"col", a, b, ratio}
    this.suppressed = []; // original <key> elements we disabled
    this.ourKeyIds = [];
    this.wiredBrowsers = new WeakSet();
    this.lastAction = { name: "", t: 0 };
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

  // ---------------------------------------------------------------- setup
  loadKeyMap() {
    this.keyMap = Core.resolveKeyMap(name => Services.prefs.getStringPref(name, ""));
    for (const p of this.keyMap.problems) {
      ERR("key config:", p);
    }
    LOG(`key map: split right = ${Core.comboToString(this.keyMap.splitRight)}, split down = ${Core.comboToString(this.keyMap.splitDown)}`);
  }

  init() {
    LOG(`window init: Firefox ${Services.appinfo.version}, enabled = ${this.enabled}`);
    this.setupBackgroundPainting();
    this.defineHotkeys();
    this.buildPanel();

    const tc = this.gBrowser.tabContainer;
    this._onSelect = () => this.safe(() => this.apply());
    this._onClose = e => this.safe(() => this.onTabClose(e.target));
    tc.addEventListener("TabSelect", this._onSelect);
    tc.addEventListener("TabClose", this._onClose);
    this.win.addEventListener("TabSwitchDone", () => this.safe(() => this.activatePaneBrowsers()));
    // Chrome-focus Ctrl+Arrow (URL bar, toolbar). Content focus is TilefoxChild's job.
    this.win.addEventListener("keydown", e => this.safe(() => this.onChromeKeydown(e)), true);
    this.win.addEventListener("unload", () => this.dissolve(), { once: true });

    this.prefObserver = { observe: () => this.safe(() => this.onEnabledChanged()) };
    Services.prefs.addObserver(PREF_ENABLED, this.prefObserver);
    // Key prefs apply live to the keydown listener; the secondary <key> elements need a restart.
    this.keysObserver = { observe: () => this.safe(() => { this.loadKeyMap(); this.applyKeyState(); }) };
    Services.prefs.addObserver(PREF_KEYS_BRANCH, this.keysObserver);
    this.win.addEventListener("unload", () => {
      Services.prefs.removeObserver(PREF_ENABLED, this.prefObserver);
      Services.prefs.removeObserver(PREF_KEYS_BRANCH, this.keysObserver);
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
    const defs = [
      { id: "tilefox-split-right", combo: this.keyMap.splitRight, action: "split-row" },
      { id: "tilefox-split-down", combo: this.keyMap.splitDown, action: "split-col" },
      { id: "tilefox-prefix", combo: FIXED.prefix, action: "prefix" },
      { id: "tilefox-palette", combo: FIXED.palette, action: "palette" },
      { id: "tilefox-kill", combo: FIXED.kill, action: "kill" },
    ];
    for (const d of defs) {
      const hk = Core.comboToHotkey(d.combo);
      try {
        const def = H.define({
          id: d.id,
          modifiers: hk.modifiers,
          key: hk.key,
          reserved: true,
          command: win => win.Tilefox?.runAction(d.action, "xul-key"),
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
    LOG("keys", on ? "active" : "released", "- originals suppressed:",
      this.suppressed.map(k => k.id || k.getAttribute("key")).join(", "));
  }

  // ---------------------------------------------------------------- actions
  runAction(action, via) {
    return this.safe(() => {
      // Dedupe: the keydown listener, the <key> and the content fallback can all fire on one press.
      const now = Date.now();
      if (action === this.lastAction.name && now - this.lastAction.t < 250) {
        LOG("action", action, "via", via, "- duplicate, ignored");
        return;
      }
      this.lastAction = { name: action, t: now };
      if (action === "kill") {
        LOG("action kill via", via);
        return this.toggleKillSwitch();
      }
      if (!this.enabled) {
        LOG("action", action, "via", via, "- tilefox disabled, ignored");
        return;
      }
      LOG("action", action, "via", via);
      switch (action) {
        case "split-row": return this.split("row");
        case "split-col": return this.split("col");
        case "focus-left":
        case "focus-right":
        case "focus-up":
        case "focus-down": return this.moveFocus(action.slice(6));
        case "unpane": return this.unpane(this.gBrowser.selectedTab);
        case "prefix": return this.openPanel("prefix");
        case "palette": return this.openPanel("palette");
      }
      return undefined;
    });
  }

  onActorAction(data, browser) {
    // Only act if the message comes from this window's currently selected browser.
    if (browser !== this.gBrowser.selectedBrowser) {
      LOG("actor action", data.action, "from a non-selected browser - ignored");
      return;
    }
    this.runAction(data.action, data.via);
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
    this.applyKeyState();
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
    gb.selectedTab = newTab; // fires TabSelect -> apply()
    this.apply();
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
    const leaf = this.leaves().find(l => l.tab === tab);
    if (leaf) {
      this.removeLeaf(leaf);
      // Defer: the closing tab's replacement selection happens after TabClose.
      this.win.setTimeout(() => this.safe(() => this.apply()), 0);
    }
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
      for (const b of w.Tilefox?.activePaneBrowsers() || []) {
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
      LOG("focus", dir, "- no neighbour in that direction");
      return;
    }
    LOG("focus", dir, "-> pane", this.paneTabs().indexOf(best) + 1);
    this.gBrowser.selectedTab = best;
    this.win.setTimeout(() => best.linkedBrowser?.focus(), 0);
  }

  // Capture-phase keydown on the chrome window: runs before Firefox's <key> handlers and
  // before the event is forwarded to web content.
  onChromeKeydown(e) {
    if (!e.ctrlKey || (e.repeat && !ARROW_DIRS[e.key])) {
      return;
    }
    const keyName = `${e.ctrlKey ? "Ctrl+" : ""}${e.altKey ? "Alt+" : ""}${e.shiftKey ? "Shift+" : ""}${e.metaKey ? "Meta+" : ""}${e.key}`;
    const t = e.composedTarget || e.target;
    const where = t?.localName === "browser" ? `browser ${t.browserId}` : `<${t?.localName || "?"}${t?.id ? "#" + t.id : ""}>`;
    const take = action => {
      e.preventDefault();
      e.stopPropagation();
      LOG(`key ${keyName} (code ${e.code}) at ${where} -> ${action}`);
      this.runAction(action, "keydown");
    };

    if (Core.comboMatches(FIXED.kill, e)) {
      return take("kill");
    }
    if (!this.enabled) {
      return;
    }
    const split = Core.splitActionFor(this.keyMap, e);
    if (split) {
      return take(split);
    }
    if (Core.comboMatches(FIXED.palette, e)) {
      return take("palette");
    }
    if (Core.comboMatches(FIXED.prefix, e)) {
      return take("prefix");
    }

    const dir = ARROW_DIRS[e.key];
    if (!dir || e.altKey || e.metaKey || e.shiftKey) {
      return;
    }
    const decide = msg => LOG(`key ${keyName} at ${where} -> ${msg}`);
    if (!this.layoutVisible()) {
      return decide("native (no pane layout on screen)");
    }
    if (this.panel?.state === "open") {
      return decide("native (tilefox panel open)");
    }
    // Keys headed into web content arrive here first with the <browser> as target.
    // TilefoxChild decides for those (it can see the focused element in the page), but only
    // if that browser's actor is known to be alive; otherwise we decide here.
    const browser = t?.localName === "browser" ? t : t?.closest?.("browser");
    if (browser) {
      if (this.actorBrowsers.has(browser)) {
        return decide("deferred to content actor (editable check in page)");
      }
      e.preventDefault();
      e.stopPropagation();
      decide(`focus-${dir} (chrome fallback: no content actor seen for browser ${browser.browserId})`);
      return this.runAction("focus-" + dir, "chrome-fallback");
    }
    if (this.chromeEditable(t)) {
      return decide("native word-jump (focus is in a chrome text field, e.g. the URL bar)");
    }
    e.preventDefault();
    e.stopPropagation();
    decide("focus-" + dir);
    this.runAction("focus-" + dir, "chrome");
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
    this.mode = mode;
    this.restoreFocusOnHide = true;
    this.panel.setAttribute("mode", mode);
    this.input.value = "";
    if (mode === "prefix") {
      this.hint.textContent = "tilefox  y: split right   h: split down   arrows: move   p: palette   x: unpane   Esc";
      this.prefixTimer = this.win.setTimeout(() => this.closePanel(), 2500);
    } else {
      this.hint.textContent = "Panes (▣) and tabs. Enter: jump, Esc: close";
      this.renderPalette();
    }
    const anchor = this.gBrowser.tabpanels;
    const width = mode === "prefix" ? 640 : 560;
    const x = Math.max(0, (anchor.getBoundingClientRect().width - width) / 2);
    this.panel.openPopup(anchor, "overlap", x, 40, false, false);
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
      const k = e.key;
      const map = {
        y: "split-row", h: "split-col", p: "palette", x: "unpane",
        ArrowLeft: "focus-left", ArrowRight: "focus-right", ArrowUp: "focus-up", ArrowDown: "focus-down",
      };
      const action = map[k] || map[k.toLowerCase?.()];
      if (["Control", "Shift", "Alt", "Meta"].includes(k)) {
        return; // modifier still held from Ctrl+Space
      }
      if (action === "palette") {
        // switch mode in place (re-opening a panel that is still hiding is unreliable)
        this.win.clearTimeout(this.prefixTimer);
        this.mode = "palette";
        this.panel.setAttribute("mode", "palette");
        this.hint.textContent = "Panes (▣) and tabs. Enter: jump, Esc: close";
        this.renderPalette();
        return;
      }
      this.closePanel(!action || action === "unpane");
      if (action) {
        this.runAction(action, "prefix");
      }
      return;
    }
    // palette
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

  allItems() {
    const items = [];
    for (const w of Services.wm.getEnumerator("navigator:browser")) {
      const t = w.Tilefox;
      const panes = t ? t.paneTabs() : [];
      for (const tab of w.gBrowser.tabs) {
        if (tab.hidden || tab.closing) {
          continue;
        }
        const pane = panes.indexOf(tab);
        let host = "";
        try { host = tab.linkedBrowser?.currentURI?.host || ""; } catch (e) {}
        items.push({
          win: w,
          tab,
          pane: pane >= 0 ? pane + 1 : 0,
          text: `${tab.label} ${host}`,
          label: tab.label || "(untitled)",
          host,
          other: w !== this.win,
        });
      }
    }
    // Panes of this window first, then this window's tabs, then other windows.
    return items.sort((a, b) => (a.other - b.other) || ((b.pane > 0) - (a.pane > 0)));
  }

  renderPalette() {
    const q = this.input.value.trim();
    const scored = this.allItems()
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
      li.textContent = `${it.pane ? "▣" + it.pane + " " : ""}${it.label}${it.host ? "  · " + it.host : ""}${it.other ? "  (other window)" : ""}`;
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
    item.win.gBrowser.selectedTab = item.tab;
    item.win.focus();
    item.win.setTimeout(() => item.tab.linkedBrowser?.focus(), 0);
  }

  notify(label) {
    this.win.UC_API.Notifications.show({ label, type: "tilefox", priority: "info", window: this.win }).catch(() => {});
  }
}

// ---------------------------------------------------------------- boot
(function boot() {
  const win = window;
  if (win.Tilefox) {
    return;
  }
  const start = () => {
    try {
      const t = new TilefoxWindow(win);
      win.Tilefox = t;
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
