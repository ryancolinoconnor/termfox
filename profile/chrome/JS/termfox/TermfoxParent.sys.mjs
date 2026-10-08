/* termfox parent-side actor: checks and forwards actions, hellos and log events from content.
 *
 * Everything a content process sends is untrusted (security audit M3, 2026-10-08). Core's
 * routeActorMessage() enforces the schema (validateActorMessage: allowlisted actions, never
 * "kill", allowed `via`, finite timestamp, no free text), rate-limits log events and rejection
 * warnings per browser, and the window only runs an action that spends a trusted press the
 * parent saw for that browser (PressLedger.content). Private-browsing contexts are never
 * logged to disk. Nothing happens while termfox is paused.
 */

import { getLogger, instanceForBrowser, isEnabled, limiterFor, routeActorMessage } from "./TermfoxCore.sys.mjs";

// Fail closed: if privacy can't be determined, treat the context as private (no disk log).
function isPrivate(actor, browser) {
  try {
    if (actor.browsingContext?.originAttributes?.privateBrowsingId > 0) {
      return true;
    }
    /* global ChromeUtils */
    const { PrivateBrowsingUtils } = ChromeUtils.importESModule("resource://gre/modules/PrivateBrowsingUtils.sys.mjs");
    return !!browser && PrivateBrowsingUtils.isBrowserPrivate(browser);
  } catch (e) {
    return true;
  }
}

export class TermfoxParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (!isEnabled()) {
      return; // paused: no actor activity
    }
    const log = getLogger();
    let browser = null;
    try {
      // browsingContext.top.embedderElement is the <browser> in the chrome window.
      browser = this.browsingContext?.top?.embedderElement ?? null;
      routeActorMessage({
        name: message.name,
        data: message.data,
        browser,
        priv: isPrivate(this, browser),
        inst: instanceForBrowser(browser),
        log,
        limiter: limiterFor(browser),
      });
    } catch (e) {
      if (!isPrivate(this, browser)) {
        log.error("actor parent error", e);
      }
    }
  }
}
