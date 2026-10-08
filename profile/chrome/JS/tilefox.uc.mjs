// ==UserScript==
// @name           tilefox
// @description    Day-1 spike: tmux/i3-style panes inside one Firefox window.
// @version        0.1.0-spike
// ==/UserScript==

/*
 * Runs once per browser window (fx-autoconfig window-scoped ES module, *.uc.mjs):
 *   https://github.com/MrOtherGuy/fx-autoconfig#usage
 * Pinned loader commit: dfdab5684faffc112b76ccb1d8cab7f75da0102c (loader @version 0.10.16)
 * Target: Firefox Release 158 (mozilla-firefox/firefox, branch "release", checked 2026-10-08).
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
 * - Ctrl+H / Ctrl+Y / Ctrl+Space / Ctrl+Shift+P / Ctrl+Alt+Shift+K: fx-autoconfig Hotkeys
 *   (reserved="true" so web content can't swallow them; original <key>s disabled).
 *   https://github.com/MrOtherGuy/fx-autoconfig#hotkeys
 *   reserved keys: https://searchfox.org/mozilla-central/source/dom/events/GlobalKeyListener.cpp (IsReservedKey)
 * - Ctrl+Arrow: decided in the content process by TilefoxChild (editable check), and here
 *   for chrome focus (URL bar etc.). No <key> element is used for arrows.
 */

const PREF_ENABLED = "tilefox.enabled";
const LOG = (...a) => console.log("[tilefox]", ...a);
const ERR = (...a) => console.error("[tilefox]", ...a);

// Original Firefox <key> elements that our bindings replace. Matched by key + normalized
// modifiers instead of id, because ids/labels move between releases.
//   Ctrl+H        key_gotoHistory   (history sidebar)    browser/base/content/browser-sets.inc.xhtml
//   Ctrl+Y        key_redo          (Windows redo)       toolkit/content/editMenuKeys.inc.xhtml
//   Ctrl+Shift+P  key_privatebrowsing (new private window)
const OVERRIDDEN = [
  { key: "h", mods: "accel" },
  { key: "y", mods: "accel" },
  { key: "p", mods: "accel,shift" },
  { keycode: "VK_SPACE", mods: "accel" },
];

function normMods(s) {
  return (s || "")
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(m => (m === "control" ? "accel" : m)) // accel == Ctrl on Windows/Linux
    .sort()
    .join(",");
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
    this.panel = null;
    this.paletteItems = [];
    this.paletteIndex = 0;
  }

  get enabled() {
    return Services.prefs.getBoolPref(PREF_ENABLED, true);
  }

  // ---------------------------------------------------------------- setup
  init() {
    this.patchSplitViewBrowsers();
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
    this.win.addEventListener("unload", () => Services.prefs.removeObserver(PREF_ENABLED, this.prefObserver), { once: true });

    if (!Services.prefs.prefHasUserValue(PREF_ENABLED)) {
      Services.prefs.setBoolPref(PREF_ENABLED, true);
    }
    LOG("ready in window; enabled =", this.enabled);
  }

  safe(fn) {
    try {
      return fn();
    } catch (e) {
      ERR(e);
    }
    return undefined;
  }

  patchSplitViewBrowsers() {
    const gb = this.gBrowser;
    let proto = Object.getPrototypeOf(gb);
    let desc = null;
    while (proto && !desc) {
      desc = Object.getOwnPropertyDescriptor(proto, "splitViewBrowsers");
      proto = Object.getPrototypeOf(proto);
    }
    if (!desc?.get) {
      ERR("gBrowser.splitViewBrowsers not found: background panes will NOT paint on this Firefox version");
      return;
    }
    const nativeGet = desc.get;
    const self = this;
    Object.defineProperty(gb, "splitViewBrowsers", {
      configurable: true,
      get() {
        const list = nativeGet.call(this);
        for (const b of self.activePaneBrowsers()) {
          if (!list.includes(b)) {
            list.push(b);
          }
        }
        return list;
      },
    });
  }

  defineHotkeys() {
    const H = this.win.UC_API.Hotkeys;
    const defs = [
      { id: "tilefox-split-row", modifiers: "ctrl", key: "H", action: "split-row" },
      { id: "tilefox-split-col", modifiers: "ctrl", key: "Y", action: "split-col" },
      { id: "tilefox-prefix", modifiers: "ctrl", key: "VK_SPACE", action: "prefix" },
      { id: "tilefox-palette", modifiers: "ctrl shift", key: "P", action: "palette" },
    ];
    for (const d of defs) {
      H.define({
        id: d.id,
        modifiers: d.modifiers,
        key: d.key,
        reserved: true,
        command: win => win.Tilefox?.runAction(d.action, "hotkey"),
      }).attachToWindow(this.win, { suppressOriginal: true });
      this.ourKeyIds.push(d.id);
    }
    // Kill switch stays live even when disabled, so it can toggle back on.
    H.define({
      id: "tilefox-kill",
      modifiers: "ctrl alt shift",
      key: "K",
      reserved: true,
      command: win => win.Tilefox?.toggleKillSwitch(),
    }).attachToWindow(this.win);

    // attachToWindow is async (waits for window load). Do our own robust suppression after it.
    // Run twice: Fluent fills in <key key="..."> attributes during localization.
    this.win.setTimeout(() => this.safe(() => this.applyKeyState()), 500);
    this.win.setTimeout(() => this.safe(() => this.applyKeyState()), 3000);
  }

  findOriginalKeys() {
    const out = [];
    for (const k of this.doc.querySelectorAll("key")) {
      if (k.closest("#ucKeySet")) {
        continue;
      }
      const mods = normMods(k.getAttribute("modifiers"));
      const key = (k.getAttribute("key") || "").toLowerCase();
      const keycode = k.getAttribute("keycode") || "";
      if (OVERRIDDEN.some(o => o.mods === mods && (o.key ? o.key === key : o.keycode === keycode))) {
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
      if (!this.enabled) {
        return;
      }
      // Dedupe: the reserved chrome key and the content fallback can both fire on one press.
      const now = Date.now();
      if (action === this.lastAction.name && now - this.lastAction.t < 250) {
        return;
      }
      this.lastAction = { name: action, t: now };
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
      return;
    }
    this.runAction(data.action, data.via);
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
  rects(node = this.root, x = 0, y = 0, w = 100, h = 100, out = new Map()) {
    if (!node) {
      return out;
    }
    if (node.tab) {
      out.set(node.tab, { x, y, w, h });
      return out;
    }
    if (node.dir === "row") {
      const wa = w * node.ratio;
      this.rects(node.a, x, y, wa, h, out);
      this.rects(node.b, x + wa, y, w - wa, h, out);
    } else {
      const ha = h * node.ratio;
      this.rects(node.a, x, y, w, ha, out);
      this.rects(node.b, x, y + ha, w, h - ha, out);
    }
    return out;
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
    for (const b of this.activePaneBrowsers()) {
      if (!b.docShellIsActive) {
        b.docShellIsActive = true;
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
      return;
    }
    const rects = this.rects();
    const cur = rects.get(this.gBrowser.selectedTab);
    if (!cur) {
      return;
    }
    const eps = 0.01;
    let best = null;
    let bestScore = Infinity;
    for (const [tab, r] of rects) {
      if (tab === this.gBrowser.selectedTab) {
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
    if (best) {
      this.gBrowser.selectedTab = best;
      this.win.setTimeout(() => best.linkedBrowser?.focus(), 0);
    }
  }

  onChromeKeydown(e) {
    if (!this.enabled || !e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) {
      return;
    }
    const map = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
    const dir = map[e.key];
    if (!dir || !this.layoutVisible()) {
      return;
    }
    const t = e.composedTarget || e.target;
    // Keys headed into web content arrive here first with the <browser> as target;
    // TilefoxChild decides for those (it can see the focused element in the page).
    if (t?.localName === "browser" || t?.closest?.("browser")) {
      return;
    }
    if (this.panel?.state === "open") {
      return;
    }
    if (this.chromeEditable(t)) {
      return; // URL bar / search box: native word-jump
    }
    e.preventDefault();
    e.stopPropagation();
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
      this.hint.textContent = "tilefox  h: split right   y: split down   arrows: move   p: palette   x: unpane   Esc";
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
        h: "split-row", y: "split-col", p: "palette", x: "unpane",
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

  static fuzzy(q, text) {
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

  renderPalette() {
    const q = this.input.value.trim();
    const scored = this.allItems()
      .map(it => ({ it, s: TilefoxWindow.fuzzy(q, it.text) }))
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
  // gBrowser is not safe to touch until the window has finished loading:
  // https://github.com/MrOtherGuy/fx-autoconfig#startup-error
  UC_API.Windows.waitWindowLoading(win).then(start, e => ERR("waitWindowLoading", e));
})();
