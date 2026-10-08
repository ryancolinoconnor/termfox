/* tilefox content-side key router (runs in the content process, one actor per frame).
 *
 * Why this exists: in e10s Firefox a keydown aimed at web content is handled in the
 * content process. Chrome code cannot synchronously see whether the focused element
 * inside a remote page (or a cross-origin, out-of-process iframe) is editable. So this
 * actor makes the decision where the focus actually lives:
 *   - a "pass when typing" key (Ctrl+Y, Ctrl+H, Ctrl+A, Ctrl+Arrow; see KEYMAP in
 *     TilefoxCore) in an editable element -> do nothing, the page/field gets it (word-jump,
 *     select-all, redo...). Like tmux's vim-aware `send-keys`.
 *   - the same key elsewhere -> eat it and ask the parent to run the action
 *     (Ctrl+Arrow only when this tab is a tilefox pane)
 *   - "always" keys (Alt+Y/H, Alt+Arrow, Ctrl+Space...) -> fallback only. The chrome window's
 *     capture keydown listener normally takes them before content sees them.
 * On every top-level pageshow it says hello, so the parent knows this browser has a working
 * actor (otherwise the window handles Ctrl+Arrow itself). Decisions are sent to the parent
 * as "Tilefox:Log" because the content sandbox can't write the profile's tilefox.log.
 *
 * JSWindowActor docs: https://firefox-source-docs.mozilla.org/dom/ipc/jsactors.html
 * Services.cpmm.sharedData (SharedMap, parent -> child state):
 *   https://searchfox.org/mozilla-central/source/dom/ipc/SharedMap.h
 */

import { bindingFor, comboToString, isEditable, resolveKeyMap, routeContentKey } from "./TilefoxCore.sys.mjs";

export { isEditable };

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
    if (!event.ctrlKey && !event.altKey) {
      return;
    }
    if (!Services.prefs.getBoolPref("tilefox.enabled", true)) {
      return;
    }

    const keyMap = resolveKeyMap(name => Services.prefs.getStringPref(name, ""));
    const b = bindingFor(keyMap, event);
    if (!b || b.action === "kill") {
      return;
    }

    const panes = Services.cpmm.sharedData.get("tilefox:paneBrowserIds");
    const browserId = this.browsingContext?.browserId;
    const doc = this.document;
    const el = deepActiveElement(doc);
    const { verdict, why } = routeContentKey(b, {
      editable: isEditable(el, doc),
      isPane: !!(panes && browserId && panes.includes(browserId)),
    });
    const key = comboToString(b.combo);
    if (verdict === "pass") {
      this.log(`content: ${key} on <${el?.localName || "none"}> -> pass through (${why})`);
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    this.log(`content: ${key} on <${el?.localName || "none"}> -> ${b.action} (${why})`);
    this.sendAsyncMessage("Tilefox:Action", { action: b.action, via: b.typing === "take" ? "content-fallback" : "content" });
  }

  receiveMessage() {}
}
