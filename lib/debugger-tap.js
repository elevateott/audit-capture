// lib/debugger-tap.js
// Phase 2 console capture via chrome.debugger (BUILD-GUIDE §3, Option A).
// Attaches the DevTools Protocol to the audited tab and forwards console
// errors/warnings to a sink. Network capture is a separate surface and is NOT
// done here.
//
// SWAPPABLE BY DESIGN: this module knows nothing about IndexedDB or routes. The
// caller passes attach({ tabId, getRoute, onEvent }); to switch to the
// content-script monkeypatch (Option B) you replace this file and keep the same
// attach/detach shape. The "...is being debugged" banner this triggers on the
// tab is expected for a deliberate audit — note it, don't treat it as a defect.
//
// Loaded into the service worker via importScripts() — exposes self.AuditDebuggerTap.

(function () {
  'use strict';

  // DevTools console types / Log levels we keep, normalized to the store's
  // contract level ('error' | 'warning'). Everything else (log/info/debug) is
  // dropped — the audit only cares about errors and warnings.
  function normalizeLevel(raw) {
    if (raw === 'error') return 'error';
    if (raw === 'warning' || raw === 'warn') return 'warning';
    return null;
  }

  // Runtime.consoleAPICalled args are RemoteObjects; render each to a string.
  function renderArg(arg) {
    if (!arg) return '';
    if ('value' in arg && arg.value !== undefined) return String(arg.value);
    if (arg.description != null) return String(arg.description);
    if (arg.unserializableValue != null) return String(arg.unserializableValue);
    return arg.type || '';
  }

  // One live attachment. Keyed by tabId so detach() can find its listener.
  const attachments = new Map();

  // attach({ tabId, getRoute, onEvent, onNetwork })
  //   getRoute() -> current SPA route string (best-effort; caller owns it).
  //   onEvent({ t, route, level, message }) -> console sink (store.put('console', ...)).
  //   onNetwork({ t, route, method, url, status }) -> failed-request sink. status is
  //     the HTTP code (>=400) or a network-level error string (loadingFailed.errorText).
  async function attach(opts) {
    const tabId = opts && opts.tabId;
    const getRoute = (opts && opts.getRoute) || (() => '/');
    const onEvent = (opts && opts.onEvent) || (() => {});
    const onNetwork = (opts && opts.onNetwork) || (() => {});
    // Drop events older than this (pre-session events Chrome replays on attach).
    const since = (opts && opts.since) != null ? opts.since : -Infinity;
    if (tabId == null) throw new Error('debugger-tap: tabId is required');

    // Already attached to this tab (e.g. a session restarted without a clean
    // stop)? Tear the old one down first so we don't stack duplicate listeners.
    if (attachments.has(tabId)) await detach({ tabId });

    const target = { tabId };

    // requestId -> { method, url } from requestWillBeSent, so responseReceived /
    // loadingFailed (which lack the request line) can be correlated back.
    const pending = new Map();

    const onDetached = (source) => {
      // Tab closed or another client (real DevTools) took over — clean up.
      if (source && source.tabId === tabId) detach({ tabId });
    };

    // Emit a failed-request row, correlating method/url by requestId.
    const emitNetwork = (requestId, status, fallbackUrl, t) => {
      if (t == null) t = Date.now();
      if (t < since) {
        pending.delete(requestId);
        return; // pre-session replayed request — drop it.
      }
      const req = pending.get(requestId) || {};
      pending.delete(requestId);
      onNetwork({
        t,
        route: getRoute(),
        method: req.method || '',
        url: req.url || fallbackUrl || '',
        status,
      });
    };

    const onCdpEvent = (source, method, params) => {
      if (!source || source.tabId !== tabId) return;

      // ---- network (failed requests only) ----
      if (method === 'Network.requestWillBeSent') {
        const r = params.request || {};
        pending.set(params.requestId, { method: r.method, url: r.url });
        return;
      }
      if (method === 'Network.responseReceived') {
        const resp = params.response || {};
        if (resp.status < 400) {
          pending.delete(params.requestId); // 2xx/3xx — not an error.
          return;
        }
        emitNetwork(params.requestId, resp.status, resp.url, params.timestamp);
        return;
      }
      if (method === 'Network.loadingFailed') {
        emitNetwork(params.requestId, params.errorText, null, params.timestamp);
        return;
      }

      let level = null;
      let message = '';
      // Each event carries its own timestamp; use it so rows sort correctly.
      // Fall back to Date.now() only when the event omits one.
      let t;

      if (method === 'Runtime.consoleAPICalled') {
        level = normalizeLevel(params.type);
        if (!level) return;
        message = (params.args || []).map(renderArg).join(' ');
        t = params.timestamp;
      } else if (method === 'Log.entryAdded') {
        const entry = params.entry || {};
        level = normalizeLevel(entry.level);
        if (!level) return;
        message = entry.text || '';
        t = entry.timestamp;
      } else if (method === 'Runtime.exceptionThrown') {
        // Uncaught JS errors — the classic red error on screen. Runtime.enable
        // already delivers these; no extra sendCommand needed.
        const details = params.exceptionDetails || {};
        level = 'error';
        message =
          (details.exception && details.exception.description) ||
          details.text ||
          '';
        t = params.timestamp;
      } else {
        return;
      }

      if (t == null) t = Date.now();
      if (t < since) return; // pre-session replayed event — drop it.
      onEvent({ t, route: getRoute(), level, message });
    };

    chrome.debugger.onEvent.addListener(onCdpEvent);
    chrome.debugger.onDetach.addListener(onDetached);
    attachments.set(tabId, { onCdpEvent, onDetached });

    try {
      await chrome.debugger.attach(target, '1.3');
    } catch (e) {
      // Attach failed (another client already attached, restricted page). Undo
      // the listener/record registration so nothing dangles, then rethrow.
      chrome.debugger.onEvent.removeListener(onCdpEvent);
      chrome.debugger.onDetach.removeListener(onDetached);
      attachments.delete(tabId);
      throw e;
    }
    // Two complementary sources: consoleAPICalled catches console.error/warn;
    // Log.entryAdded catches the browser's own errors (network, CSP, etc.).
    await chrome.debugger.sendCommand(target, 'Runtime.enable');
    await chrome.debugger.sendCommand(target, 'Log.enable');
    // Network domain: lets us catch failed requests (4xx/5xx + loadingFailed).
    await chrome.debugger.sendCommand(target, 'Network.enable');
  }

  async function detach(opts) {
    const tabId = opts && opts.tabId;

    // Remove our listeners if we have a record. After a worker respawn the map
    // is empty but the tab may still be debugged, so we ALWAYS attempt the
    // detach below — that's what clears the "is being debugged" banner.
    const a = attachments.get(tabId);
    if (a) {
      attachments.delete(tabId);
      chrome.debugger.onEvent.removeListener(a.onCdpEvent);
      chrome.debugger.onDetach.removeListener(a.onDetached);
    }

    try {
      await chrome.debugger.detach({ tabId });
    } catch (e) {
      // Already gone (tab closed, or onDetach fired first) — nothing to do.
    }
  }

  const api = { attach, detach };
  if (typeof self !== 'undefined') self.AuditDebuggerTap = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
