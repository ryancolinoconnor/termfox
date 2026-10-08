/* tilefox content-side key router (runs in the content process, one actor per frame).
 *
 * Why this exists: in e10s Firefox a keydown aimed at web content is handled in the
 * content process. Chrome code cannot synchronously see whether the focused element
 * inside a remote page (or a cross-origin, out-of-process iframe) is editable. So this
 * actor makes the decision where the focus actually lives:
 *   - Ctrl+Arrow in an editable element  -> do nothing (native word-jump runs)
 *   - Ctrl+Arrow elsewhere, and this tab is a tilefox pane -> eat the key, ask the parent
 *     to move pane focus
 *   - split keys (tilefox.keys.splitRight / splitDown) -> fallback only. The chrome window's
 *     capture keydown listener normally handles them before content sees them.
 * On every top-level pageshow it says hello, so the parent knows this browser has a working
 * actor (otherwise the window handles Ctrl+Arrow itself). Decisions are sent to the parent
 * as "Tilefox:Log" because the content sandbox can't write the profile's tilefox.log.
 *
 * JSWindowActor docs: https://firefox-source-docs.mozilla.org/dom/ipc/jsactors.html
 * Services.cpmm.sharedData (SharedMap, parent -> child state):
 *   https://searchfox.org/mozilla-central/source/dom/ipc/SharedMap.h
 */

import { isEditable, resolveKeyMap, splitActionFor } from "./TilefoxCore.sys.mjs";

export { isEditable };

const ARROWS = {
  ArrowLeft: "focus-left",
  ArrowRight: "focus-right",
  ArrowUp: "focus-up",
  ArrowDown: "focus-down",
};

function deepActiveElement(doc) {
  let el = doc.activeElement;
  // Walk into open shadow roots (web components often host the real input).
  while (el && el.shadowRoot && el.shadowRoot.activeElement) {
    el = el.shadowRoot.activeElement;
  }
  return el;
}

export class TilefoxChild extends JSWindowActorChild {
  log(msg) {
    try {
      this.sendAsyncMessage("Tilefox:Log", { msg });
    } catch (e) {}
  }

  handleEvent(event) {
    try {
      this.onEvent(event);
    } catch (e) {
      this.log(`child error: ${e}\n${e?.stack || ""}`);
    }
  }

  onEvent(event) {
    if (event.type === "pageshow") {
      if (this.browsingContext === this.browsingContext?.top) {
        let where = "";
        try { where = this.document.location.protocol + "//" + this.document.location.host; } catch (e) {}
        this.sendAsyncMessage("Tilefox:Hello", { where });
      }
      return;
    }
    if (event.type !== "keydown" || event.defaultPrevented || event.isComposing) {
      return;
    }
    if (!event.ctrlKey) {
      return;
    }
    if (!Services.prefs.getBoolPref("tilefox.enabled", true)) {
      return;
    }

    const keyMap = resolveKeyMap(name => Services.prefs.getStringPref(name, ""));
    const split = splitActionFor(keyMap, event);
    if (split) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.log(`content: ${event.code} reached content (chrome listener missed it) -> ${split}`);
      this.sendAsyncMessage("Tilefox:Action", { action: split, via: "content-fallback" });
      return;
    }

    const action = ARROWS[event.key];
    if (!action || event.shiftKey || event.altKey || event.metaKey) {
      return; // Ctrl+Shift+Arrow = select word: always native
    }

    // Only steal Ctrl+Arrow when this tab is currently a tilefox pane.
    const panes = Services.cpmm.sharedData.get("tilefox:paneBrowserIds");
    const browserId = this.browsingContext?.browserId;
    if (!panes || !browserId || !panes.includes(browserId)) {
      this.log(`content: ${event.key} ignored, browser ${browserId} is not a pane (panes: ${JSON.stringify(panes || [])})`);
      return;
    }

    const doc = this.document;
    const el = deepActiveElement(doc);
    if (isEditable(el, doc)) {
      this.log(`content: ${event.key} in editable <${el?.localName}> -> native word-jump`);
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    this.log(`content: ${event.key} on <${el?.localName || "none"}> -> ${action}`);
    this.sendAsyncMessage("Tilefox:Action", { action, via: "content" });
  }

  receiveMessage() {}
}
