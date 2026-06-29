// lib/scope.js
// Single source of truth for "should we capture on this page?" Loaded by BOTH
// halves of the extension -- the service worker (importScripts -> self.AuditScope)
// and the content script (manifest -> window.AuditScope) -- so the worker and the
// recorder can never disagree about what is in scope. ASCII-only and
// dependency-free on purpose.
//
// Scope model: capture on ANY http(s) site EXCEPT a static denylist. The denylist
// is edge config (a code edit), NOT a runtime toggle, and ships empty.

(function () {
  'use strict';

  // Hosts to never capture. An entry matches the host exactly OR any subdomain
  // of it: 'mail.google.com' blocks mail.google.com and inbox.mail.google.com,
  // but NOT notmail.google.com. Ships empty.
  var AUDIT_DENYLIST = []; // e.g. 'mail.google.com'

  function inScope(url) {
    var parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      return false; // unparseable -> never capture.
    }
    // Only the web. chrome://, file://, about:, devtools://, etc. are out.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    var host = parsed.hostname;
    for (var i = 0; i < AUDIT_DENYLIST.length; i++) {
      var entry = AUDIT_DENYLIST[i];
      if (host === entry || host.endsWith('.' + entry)) return false;
    }
    return true;
  }

  // DENYLIST is the SAME array reference inScope closes over, so edge config (and
  // tests) can mutate it in place and inScope sees the change.
  var api = { inScope: inScope, DENYLIST: AUDIT_DENYLIST };

  // Worker global is `self`; page/content-script global is `window` (in a page
  // self === window, so the worker branch also covers the content script).
  if (typeof self !== 'undefined') self.AuditScope = api;
  else if (typeof window !== 'undefined') window.AuditScope = api;
  // Test seam: lets Node require() this for unit tests (no-op in the browser).
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
