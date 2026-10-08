/* termfox content-side key router (runs in the content process, one actor per frame).
 *
 * Why this exists: in e10s Firefox a keydown aimed at web content is handled in the
 * content process. Chrome code cannot synchronously see whether the focused element
 * inside a remote page (or a cross-origin, out-of-process iframe) is editable. So this
 * actor makes the decision where the focus actually lives (trusted events only, nothing while paused):
 *   - a "pass when typing" key (Ctrl+Y, Ctrl+H, Ctrl+A, Ctrl+Arrow; see KEYMAP in
 *     TermfoxCore) in an editable element -> do nothing, the page/field gets it (word-jump,
 *     select-all, redo...). Like tmux's vim-aware `send-keys`. An EMPTY editable (an
 *     autofocused prompt box) doesn't count as typing, like the chrome URL bar; password
 *     fields always count as typing.
 *   - the same key elsewhere -> eat it and ask the parent to run the action
 *     (Ctrl+Arrow only when this tab is a termfox pane)
 *   - "always" keys (Alt+Y/H, Alt+Arrow, Ctrl+Space...) -> fallback only. The chrome window's
 *     capture keydown listener normally takes them before content sees them.
 * On every top-level pageshow it says hello, so the parent knows this browser has a working
 * actor (otherwise the window handles Ctrl+Arrow itself). Decisions are sent to the parent
 * as "Termfox:Log" fixed event codes (no free text), because the content sandbox can't write
 * the profile's termfox.log. The parent treats every message from here as untrusted.
 *
 * JSWindowActor docs: https://firefox-source-docs.mozilla.org/dom/ipc/jsactors.html
 * Services.cpmm.sharedData (SharedMap, parent -> child state):
 *   https://searchfox.org/mozilla-central/source/dom/ipc/SharedMap.h
 */

import { bindingFor, isEditable, isEmptyEditable, resolveKeyMap, routeContentKey } from "./TermfoxCore.sys.mjs";

export { isEditable };

function deepActiveElement(doc) {
  let el = doc.activeElement;
  // Walk into open shadow roots (web components often host the real input).
  while (el && el.shadowRoot && el.shadowRoot.activeElement) {
    el = el.shadowRoot.activeElement;
  }
  return el;
}

const enabled = () => Services.prefs.getBoolPref("termfox.enabled", true); // false = paused

export class TermfoxChild extends JSWindowActorChild {
  // Fixed event codes only (TermfoxCore.CONTENT_LOG_EVENTS): no element names, keys or page text
  // cross into the parent's log. The parent validates and rate-limits these.
  logEvent(ev, action) {
    try {
      this.sendAsyncMessage("Termfox:Log", action ? { ev, action } : { ev });
    } catch (e) {}
  }

  handleEvent(event) {
    try {
      this.onEvent(event);
    } catch (e) {
      this.logEvent("error");
    }
  }

  // The parent asks again after a pause: say hello if this is a top-level document.
  receiveMessage(message) {
    if (message.name === "Termfox:Ping" && enabled() && this.browsingContext === this.browsingContext?.top) {
      this.sendAsyncMessage("Termfox:Hello", {});
    }
  }

  onEvent(event) {
    // Synthetic events (dispatchEvent from a page) never drive termfox; paused = no activity.
    if (!event.isTrusted || !enabled()) {
      return;
    }
    if (event.type === "pageshow") {
      if (this.browsingContext === this.browsingContext?.top) {
        // No origin or URL: the parent only needs to know an actor is alive in this browser.
        this.sendAsyncMessage("Termfox:Hello", {});
      }
      return;
    }
    if (event.type !== "keydown" || event.defaultPrevented || event.isComposing) {
      return;
    }
    if (!event.ctrlKey && !event.altKey) {
      return;
    }

    const keyMap = resolveKeyMap(name => Services.prefs.getStringPref(name, ""));
    const b = bindingFor(keyMap, event);
    if (!b || b.action === "kill") {
      return;
    }

    const panes = Services.cpmm.sharedData.get("termfox:paneBrowserIds");
    const browserId = this.browsingContext?.browserId;
    const doc = this.document;
    const el = deepActiveElement(doc);
    const isPane = !!(panes && browserId && panes.includes(browserId));
    const editable = isEditable(el, doc);
    // Booleans only: the field's text never leaves isEmptyEditable.
    const fieldEmpty = editable && isEmptyEditable(el, doc);
    const { verdict } = routeContentKey(b, { editable, fieldEmpty, isPane });
    if (verdict === "pass") {
      this.logEvent(b.action.startsWith("focus-") && !isPane ? "pass-not-pane" : "pass-typing", b.action);
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.repeat && !b.action.startsWith("focus-")) {
      // A held key: only arrows repeat (tmux bind -r); a held Ctrl+H must not add panes.
      this.logEvent("repeat", b.action);
      return;
    }
    this.logEvent("take", b.action);
    // t: when the key was pressed, on the epoch clock the window uses (timeOrigin + timeStamp), so
    // the parent's latency line includes the content -> parent hop.
    let t = Date.now();
    try {
      const perf = this.contentWindow?.performance;
      if (perf?.timeOrigin && event.timeStamp > 0) {
        t = perf.timeOrigin + event.timeStamp;
      }
    } catch (e) {}
    this.sendAsyncMessage("Termfox:Action", { action: b.action, via: b.typing === "take" ? "content-fallback" : "content", t });
  }
}
