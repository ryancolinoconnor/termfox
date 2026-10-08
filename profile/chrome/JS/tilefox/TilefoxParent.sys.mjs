/* tilefox parent-side actor: forwards actions, hellos and log lines from content to the window. */

import { getLogger } from "./TilefoxCore.sys.mjs";

export class TilefoxParent extends JSWindowActorParent {
  receiveMessage(message) {
    const log = getLogger();
    try {
      // browsingContext.top.embedderElement is the <browser> in the chrome window.
      const browser = this.browsingContext?.top?.embedderElement;
      const win = browser?.ownerGlobal;
      switch (message.name) {
        case "Tilefox:Log":
          log.log(`[content bid=${browser?.browserId}]`, String(message.data?.msg));
          break;
        case "Tilefox:Hello":
          win?.Tilefox?.onActorHello(browser, message.data);
          break;
        case "Tilefox:Action":
          if (win?.Tilefox) {
            win.Tilefox.onActorAction(message.data, browser);
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
