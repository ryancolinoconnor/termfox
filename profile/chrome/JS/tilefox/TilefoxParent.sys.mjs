/* tilefox parent-side actor: forwards actions from content to the owning browser window. */

export class TilefoxParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (message.name !== "Tilefox:Action") {
      return;
    }
    try {
      // browsingContext.top.embedderElement is the <browser> in the chrome window.
      const browser = this.browsingContext?.top?.embedderElement;
      const win = browser?.ownerGlobal;
      if (win?.Tilefox) {
        win.Tilefox.onActorAction(message.data, browser);
      }
    } catch (e) {
      console.error("[tilefox] actor parent error", e);
    }
  }
}
