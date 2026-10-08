/* tilefox parent-side actor: forwards actions, hellos and log lines from content to the window. */

import { getLogger, instanceCount, instanceForBrowser } from "./TilefoxCore.sys.mjs";

// Logged once per session: how the old `ownerGlobal.Tilefox` lookup compares with the registry.
let diagnosed = false;

function describeOwner(browser, inst) {
  let win = null;
  try { win = browser?.ownerGlobal; } catch (e) {}
  const out = {
    ownerGlobal: win ? typeof win : String(win),
    sameAsInstanceWin: !!inst && win === inst.win,
    hasTilefoxProp: (() => { try { return !!win?.Tilefox; } catch (e) { return `throws ${e}`; } })(),
    instances: instanceCount(),
  };
  try {
    /* global Cu */
    if (typeof Cu !== "undefined" && win) {
      out.xray = Cu.isXrayWrapper(win);
    }
  } catch (e) {}
  try { out.doc = browser?.ownerDocument?.documentURI; } catch (e) {}
  return JSON.stringify(out);
}

export class TilefoxParent extends JSWindowActorParent {
  receiveMessage(message) {
    const log = getLogger();
    try {
      // browsingContext.top.embedderElement is the <browser> in the chrome window.
      const browser = this.browsingContext?.top?.embedderElement;
      if (message.name === "Tilefox:Log") {
        log.log(`[content bid=${browser?.browserId}]`, String(message.data?.msg));
        return;
      }
      const t = instanceForBrowser(browser);
      if (!diagnosed && (message.name === "Tilefox:Hello" || message.name === "Tilefox:Action")) {
        let direct = null;
        try { direct = browser?.ownerGlobal?.Tilefox; } catch (e) {}
        if (!t || direct !== t) {
          diagnosed = true;
          log.warn("actor: window lookup", t ? "found via registry, ownerGlobal.Tilefox did not match" : "failed", describeOwner(browser, t));
        }
      }
      switch (message.name) {
        case "Tilefox:Hello":
          if (t) {
            t.onActorHello(browser, message.data);
          } else {
            log.warn(`actor hello from browser ${browser?.browserId} but no Tilefox in its window`);
          }
          break;
        case "Tilefox:Action":
          if (t) {
            t.onActorAction(message.data, browser);
          } else {
            log.warn("actor action but no Tilefox in window", JSON.stringify(message.data));
          }
          break;
      }
    } catch (e) {
      log.error("actor parent error", e);
    }
  }
}
