// ==UserScript==
// @name           termfox actor registration
// @description    Registers the Termfox JSWindowActor once per browser session (background module).
// ==/UserScript==

// fx-autoconfig loads *.sys.mjs files in chrome/JS once at startup as background modules:
//   https://github.com/MrOtherGuy/fx-autoconfig#backgroundmodule
// Files in sub-folders (chrome/JS/termfox/) are NOT auto-loaded; they are only reached
// through the chrome://userscripts/content/ mapping in chrome/utils/chrome.manifest.
//
// We use the stable ChromeUtils.registerWindowActor API rather than fx-autoconfig's
// Experimental.WindowActors (that needs userChromeJS.experimental.enabled).
//   https://firefox-source-docs.mozilla.org/dom/ipc/jsactors.html
//   https://searchfox.org/mozilla-central/source/dom/chrome-webidl/ChromeUtils.webidl (registerWindowActor)

const { getLogger, migrateLegacyPrefs } = ChromeUtils.importESModule("chrome://userscripts/content/termfox/TermfoxCore.sys.mjs");
const log = getLogger();

// Renamed from tilefox (2026-10-08): copy user-set tilefox.* prefs to termfox.* once.
try {
  const copied = migrateLegacyPrefs(Services.prefs);
  if (copied.length) {
    log.log("prefs: copied from tilefox.*:", copied.join(", "));
  }
} catch (e) {
  log.error("prefs: tilefox.* migration failed", e);
}

try {
  log.log(`startup: Firefox ${Services.appinfo.version}`); // no profile path in the log
  ChromeUtils.registerWindowActor("Termfox", {
    parent: {
      esModuleURI: "chrome://userscripts/content/termfox/TermfoxParent.sys.mjs",
    },
    child: {
      esModuleURI: "chrome://userscripts/content/termfox/TermfoxChild.sys.mjs",
      events: {
        // capture: run before the page's own handlers, so a page cannot swallow
        // Ctrl+Arrow before we've checked editability. We still bail out in editables.
        keydown: { capture: true },
        // creates the actor on every page load so it can report that it is alive
        pageshow: {},
      },
    },
    allFrames: true,                 // cross-origin / out-of-process iframes get their own actor
    messageManagerGroups: ["browsers"], // tab browsers only (not sidebars / devtools)
  });
  log.log("JSWindowActor registered");
} catch (e) {
  // NotSupportedError if already registered (e.g. module reloaded) - harmless.
  log.error("registerWindowActor failed", e);
}

export {};
