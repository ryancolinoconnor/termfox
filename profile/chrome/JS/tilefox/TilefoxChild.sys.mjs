/* tilefox content-side key router (runs in the content process, one actor per frame).
 *
 * Why this exists: in e10s Firefox a keydown aimed at web content is handled in the
 * content process. Chrome code cannot synchronously see whether the focused element
 * inside a remote page (or a cross-origin, out-of-process iframe) is editable. So this
 * actor makes the decision where the focus actually lives:
 *   - Ctrl+Arrow in an editable element  -> do nothing (native word-jump runs)
 *   - Ctrl+Arrow elsewhere, and this tab is a tilefox pane -> eat the key, ask the parent
 *     to move pane focus
 *   - Ctrl+H / Ctrl+Y -> fallback only. The chrome <key> elements are declared
 *     reserved="true", so normally content never sees these keys. If it does, we route them.
 *
 * JSWindowActor docs: https://firefox-source-docs.mozilla.org/dom/ipc/jsactors.html
 * Actor options (allFrames, events, messageManagerGroups):
 *   https://searchfox.org/mozilla-central/source/dom/chrome-webidl/JSWindowActor.webidl
 * Services.cpmm.sharedData (SharedMap, parent -> child state):
 *   https://searchfox.org/mozilla-central/source/dom/ipc/SharedMap.h
 */

const ARROWS = {
  ArrowLeft: "focus-left",
  ArrowRight: "focus-right",
  ArrowUp: "focus-up",
  ArrowDown: "focus-down",
};

const TEXT_INPUT_TYPES = new Set([
  "text", "search", "url", "tel", "email", "password", "number",
  "date", "datetime-local", "month", "time", "week", "",
]);

function deepActiveElement(doc) {
  let el = doc.activeElement;
  // Walk into open shadow roots (web components often host the real input).
  while (el && el.shadowRoot && el.shadowRoot.activeElement) {
    el = el.shadowRoot.activeElement;
  }
  return el;
}

export function isEditable(el, doc) {
  if (doc && doc.designMode === "on") {
    return true;
  }
  if (!el) {
    return false;
  }
  const tag = el.localName;
  if (tag === "textarea") {
    return !el.readOnly && !el.disabled;
  }
  if (tag === "input") {
    const type = (el.getAttribute("type") || "").toLowerCase();
    return TEXT_INPUT_TYPES.has(type) && !el.readOnly && !el.disabled;
  }
  if (tag === "select") {
    return true; // arrows mean something there too
  }
  if (el.isContentEditable) {
    return true;
  }
  // ARIA widgets that take arrow keys (custom editors, comboboxes, sliders...).
  const role = el.getAttribute?.("role");
  if (role && /^(textbox|combobox|searchbox|spinbutton|slider|grid|tree|listbox|menu|menubar|tablist)$/.test(role)) {
    return true;
  }
  return false;
}

export class TilefoxChild extends JSWindowActorChild {
  handleEvent(event) {
    if (event.type !== "keydown" || event.defaultPrevented || event.isComposing) {
      return;
    }
    if (!Services.prefs.getBoolPref("tilefox.enabled", true)) {
      return;
    }
    if (!event.ctrlKey || event.altKey || event.metaKey) {
      return;
    }

    // Ctrl+H / Ctrl+Y fallback (see header). Shift excluded so Ctrl+Shift+Y etc. are untouched.
    if (!event.shiftKey && (event.code === "KeyH" || event.code === "KeyY")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.sendAsyncMessage("Tilefox:Action", {
        action: event.code === "KeyH" ? "split-row" : "split-col",
        via: "content-fallback",
      });
      return;
    }

    const action = ARROWS[event.key];
    if (!action || event.shiftKey) {
      return; // Ctrl+Shift+Arrow = select word: always native
    }

    // Only steal Ctrl+Arrow when this tab is currently a tilefox pane.
    const panes = Services.cpmm.sharedData.get("tilefox:paneBrowserIds");
    const browserId = this.browsingContext?.browserId;
    if (!panes || !browserId || !panes.includes(browserId)) {
      return;
    }

    const doc = this.document;
    if (isEditable(deepActiveElement(doc), doc)) {
      return; // native word-jump
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    this.sendAsyncMessage("Tilefox:Action", { action, via: "content" });
  }

  receiveMessage() {}
}
