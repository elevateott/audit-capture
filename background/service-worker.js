// background/service-worker.js
// Phase 1 orchestrator: owns the session, captures frames, appends the
// timeline, and writes the zip on Stop.
//
// LIFECYCLE: this worker is killed after ~30s idle. So:
//   - The capture interval is driven by content/recorder.js (NOT here, NOT
//     chrome.alarms which has a 30s floor). Each tick is a message that wakes us.
//   - Session state lives in chrome.storage.session + IndexedDB, never only in
//     worker memory. Every handler rehydrates what it needs.

// Classic (non-module) worker, so importScripts is available.
importScripts(
  chrome.runtime.getURL('lib/scope.js'),
  chrome.runtime.getURL('lib/jszip.min.js'),
  chrome.runtime.getURL('lib/store.js'),
  chrome.runtime.getURL('lib/package.js'),
  chrome.runtime.getURL('lib/debugger-tap.js')
);

const DEFAULT_INTERVAL_MS = 5000;
const SESSION_KEY = 'session';

// Best-effort current SPA route, fed by inbound content-script messages. The
// debugger tap has no DOM of its own, so it borrows this for console rows.
let lastRoute = '/';

// ---- session meta (small, lives in chrome.storage.session) -----------------

async function getSession() {
  const o = await chrome.storage.session.get(SESSION_KEY);
  return o[SESSION_KEY] || null;
}

async function setSession(s) {
  await chrome.storage.session.set({ [SESSION_KEY]: s });
}

async function clearSession() {
  await chrome.storage.session.remove(SESSION_KEY);
}

// ---- frame capture ---------------------------------------------------------

async function captureFrame(windowId, route, reason) {
  const session = await getSession();
  if (!session || !session.active) return;

  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
      format: 'jpeg',
      quality: 80,
    });
  } catch (e) {
    // Rate-limit or permission hiccup — skip this tick, don't crash the session.
    console.warn('[audit] captureVisibleTab failed:', e && e.message);
    return;
  }

  const t = Date.now();
  const name = self.AuditPackage.stamp(new Date(t)) + '.jpeg';

  await self.AuditStore.put('frames', {
    name,
    dataUrl,
    t,
    route,
    reason: reason || 'interval',
  });
  await appendTimeline({ t, route, type: 'frame', ref: name });

  session.frameCount = (session.frameCount || 0) + 1;
  session.lastFrame = name;
  await setSession(session);
}

// ---- timeline (the keystone) ----------------------------------------------

async function appendTimeline(entry) {
  await self.AuditStore.put('timeline', entry);
}

// ---- recorder spine --------------------------------------------------------

async function appendStep(step) {
  await self.AuditStore.put('steps', step);
}

// ---- MARK ------------------------------------------------------------------

async function addMark(text, route) {
  const session = await getSession();
  if (!session || !session.active) return null;
  const t = Date.now();

  // The worker assigns the id now, so strip any leading id the operator still
  // typed (habit, or dictation reading the old placeholder) to avoid a double
  // prefix like "MARK 001 — MARK 7 — ...". Matches "MARK <n> — " / "- " / "– ".
  const body = String(text || '').replace(/^\s*MARK\s+\d+\s*[—–-]\s*/i, '');

  // Sequential, zero-padded, regex-extractable id (MARK 001, 002, ...). Persisted
  // in session state so it survives the worker dying between marks.
  const n = (session.markCount || 0) + 1;
  const id = String(n).padStart(3, '0');
  session.markCount = n;
  await setSession(session);

  const line =
    '[' + self.AuditPackage.clock(t) + '] (' + (route || '/') + ') MARK ' + id + ' — ' + body;
  await self.AuditStore.put('narration', { line, t });
  await appendTimeline({
    t,
    route: route || '/',
    type: 'mark',
    ref: session.lastFrame || null,
  });
  return id;
}

// ---- console tap (chrome.debugger, swappable — see lib/debugger-tap.js) -----

async function startConsoleTap(tabId, since) {
  if (tabId == null) return;
  try {
    await self.AuditDebuggerTap.attach({
      tabId,
      since,
      getRoute: () => lastRoute,
      onEvent: (row) => {
        // Fire-and-forget; a dropped console row must never break capture.
        self.AuditStore.put('console', row).catch(() => {});
        // Keystone: every capture path also appends a timeline entry.
        appendTimeline({
          t: row.t,
          route: row.route,
          type: 'console',
          ref: null,
        }).catch(() => {});
      },
      onNetwork: (row) => {
        // Failed requests only (see lib/debugger-tap.js). Same fire-and-forget +
        // keystone-timeline pattern as console rows.
        self.AuditStore.put('network', row).catch(() => {});
        appendTimeline({
          t: row.t,
          route: row.route,
          type: 'network',
          ref: null,
        }).catch(() => {});
      },
    });
  } catch (e) {
    // Debugger may be unavailable (another client attached, restricted page).
    console.warn('[audit] console tap attach failed:', e && e.message);
  }
}

async function stopConsoleTap(tabId) {
  if (tabId == null) return;
  try {
    await self.AuditDebuggerTap.detach({ tabId });
  } catch (e) {
    /* already detached; ignore */
  }
}

// ---- multi-tab tap follow ---------------------------------------------------
// An audit can span tabs (open the storefront in a new tab while the CMS session
// runs). The tap FOLLOWS the audit: attach to each in-scope tab as it becomes the
// focused tab, and detach everything on stop. The set of attached tabs lives in
// session state (not worker memory) so it survives a worker restart mid-session.

async function ensureTapForTab(tabId) {
  if (tabId == null) return;
  const session = await getSession();
  if (!session || !session.active) return;

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (e) {
    return; // tab vanished between the event and now.
  }
  // Only http(s) pages we're allowed to audit — never chrome://, restricted, or
  // denylisted hosts (same scope gate the recorder uses).
  if (!tab || !tab.url || !self.AuditScope.inScope(tab.url)) return;

  const attached = session.attachedTabs || [];
  if (attached.includes(tabId)) return; // already tapped — don't stack listeners.

  // since = now drops the pre-attach events Chrome replays on attach.
  await startConsoleTap(tabId, Date.now());

  attached.push(tabId);
  session.attachedTabs = attached;
  await setSession(session);
}

// Drop a tab from the follow-list when it closes or the debugger detaches out
// from under us. The tap's own onDetach already cleaned its listeners; this just
// keeps session.attachedTabs honest so stop doesn't try to detach a dead tab.
async function forgetTab(tabId) {
  if (tabId == null) return;
  const session = await getSession();
  if (!session || !session.active) return;
  const attached = session.attachedTabs || [];
  const i = attached.indexOf(tabId);
  if (i < 0) return;
  attached.splice(i, 1);
  session.attachedTabs = attached;
  await setSession(session);
}

// ---- session control -------------------------------------------------------

async function startSession(tab) {
  await self.AuditStore.clearAll();
  const session = {
    active: true,
    startedAt: Date.now(),
    title: (tab && tab.title) || 'audit',
    intervalMs: DEFAULT_INTERVAL_MS,
    frameCount: 0,
    markCount: 0,
    lastFrame: null,
    windowId: tab ? tab.windowId : chrome.windows.WINDOW_ID_CURRENT,
    tabId: tab ? tab.id : null,
  };
  await setSession(session);

  // Attach the console tap (Phase 2). Shows the "is being debugged" banner.
  // `since` drops pre-session events Chrome replays on attach.
  await startConsoleTap(session.tabId, session.startedAt);
  // Seed the follow-list with the start tab; onActivated/onUpdated add the rest.
  session.attachedTabs = session.tabId != null ? [session.tabId] : [];
  await setSession(session);

  // First step: setViewport, so recording.json matches DevTools Recorder shape.
  await appendStep({ type: 'setViewport', title: session.title });

  if (tab && tab.id != null) {
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'recorder:start',
        intervalMs: session.intervalMs,
      });
    } catch (e) {
      // Content script not injected on this page (host not in matches, or the
      // tab predates install). Tell the popup so it can surface it.
      console.warn('[audit] could not start recorder on tab:', e && e.message);
    }
  }
  return session;
}

async function stopSession() {
  const session = await getSession();
  if (!session) return { ok: false, error: 'no active session' };

  // Tell the recorder to stop ticking/listening.
  if (session.tabId != null) {
    try {
      await chrome.tabs.sendMessage(session.tabId, { type: 'recorder:stop' });
    } catch (e) {
      /* tab may be gone; ignore */
    }
  }

  // Detach the tap from EVERY tab we attached to during the audit, so each
  // debugger banner clears — not just the tab the session started on. Fall back
  // to the start tab for sessions persisted before attachedTabs existed.
  const attached = session.attachedTabs ||
    (session.tabId != null ? [session.tabId] : []);
  for (const tabId of attached) {
    await stopConsoleTap(tabId);
  }
  session.attachedTabs = [];

  session.active = false;
  await setSession(session);

  let pkg;
  try {
    pkg = await self.AuditPackage.build({
      title: session.title,
      startedAt: session.startedAt,
    });
  } catch (e) {
    console.error('[audit] package build failed:', e);
    return { ok: false, error: 'package build failed: ' + (e && e.message) };
  }

  try {
    await chrome.downloads.download({
      url: pkg.dataUrl,
      filename: pkg.filename,
      saveAs: false,
    });
  } catch (e) {
    console.error('[audit] download failed:', e);
    return { ok: false, error: 'download failed: ' + (e && e.message) };
  }

  await clearSession();
  return { ok: true, filename: pkg.filename, counts: pkg.counts };
}

// ---- message + command routing --------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const route = (msg && msg.route) || '/';
    if (msg && msg.route) lastRoute = msg.route;
    const windowId = sender.tab ? sender.tab.windowId : undefined;

    switch (msg && msg.type) {
      case 'session:start': {
        const tab = sender.tab || (await getActiveTab());
        const s = await startSession(tab);
        sendResponse({ ok: true, session: s });
        break;
      }
      case 'session:stop': {
        const r = await stopSession();
        sendResponse(r);
        break;
      }
      case 'session:status': {
        sendResponse({ ok: true, session: await getSession() });
        break;
      }
      case 'capture': {
        await captureFrame(windowId, route, msg.reason);
        sendResponse({ ok: true });
        break;
      }
      case 'step': {
        await appendStep(msg.step);
        await appendTimeline({
          t: Date.now(),
          route,
          type: 'click',
          ref: null,
        });
        sendResponse({ ok: true });
        break;
      }
      case 'mark': {
        const id = await addMark(msg.text, route);
        sendResponse({ ok: true, id });
        break;
      }
      case 'environment': {
        // One-time context header, NOT a timed event — store it, but do NOT
        // append a timeline entry (unlike console/network).
        await self.AuditStore.put('environment', msg.env);
        sendResponse({ ok: true });
        break;
      }
      case 'annotate:capture': {
        // Snapshot the visible tab as a PNG for the operator to draw on. The
        // content script opens the annotator with this dataUrl.
        try {
          const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
            format: 'png',
          });
          sendResponse({ ok: true, dataUrl });
        } catch (e) {
          sendResponse({ ok: false, error: e && e.message });
        }
        break;
      }
      case 'annotation': {
        // The saved drawing. Store it as a '*_annotated.png' frame + a timeline
        // entry, but only while a session is active.
        const session = await getSession();
        if (!session || !session.active) {
          sendResponse({ ok: false, error: 'no active session' });
          break;
        }
        const t = Date.now();
        const name = self.AuditPackage.stamp(new Date(t)) + '_annotated.png';
        await self.AuditStore.put('annotations', {
          name,
          dataUrl: msg.dataUrl,
          t,
          route,
        });
        await appendTimeline({ t, route, type: 'annotation', ref: name });
        sendResponse({ ok: true, name });
        break;
      }
      default:
        sendResponse({ ok: false, error: 'unknown message type' });
    }
  })();
  return true; // keep the message channel open for the async response
});

chrome.commands.onCommand.addListener(async (command) => {
  const tab = await getActiveTab();
  if (command === 'toggle-session') {
    const s = await getSession();
    if (s && s.active) await stopSession();
    else await startSession(tab);
  } else if (command === 'mark') {
    await handleMarkCommand(tab);
  }
});

// ---- tab follow listeners ---------------------------------------------------
// These fire even while the worker is asleep — Chrome wakes it to deliver them,
// so the tap can attach to a tab the operator focuses long after Start. All are
// fire-and-forget; ensureTapForTab/forgetTab no-op when no session is active.

chrome.tabs.onActivated.addListener((activeInfo) => {
  ensureTapForTab(activeInfo.tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // 'complete' covers both a navigation within an attached tab and a brand-new
  // tab finishing its first load; earlier statuses lack a settled URL.
  if (changeInfo.status === 'complete') ensureTapForTab(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  forgetTab(tabId);
});

chrome.debugger.onDetach.addListener((source) => {
  // DevTools opened on the tab, the tab crashed, etc. The tap's own onDetach
  // handler already removed its listeners; just keep our follow-list honest.
  if (source && source.tabId != null) forgetTab(source.tabId);
});

// MARK is the capture surface used most, so a swallowed keypress is the worst
// silent failure in the tool. Every failure path here is made VISIBLE on the
// toolbar badge instead of being dropped into a catch block.
// (ASCII-only on purpose: badge glyphs render everywhere and avoid encoding
// surprises in tooling.)
async function handleMarkCommand(tab) {
  const session = await getSession();
  if (!session || !session.active) {
    // Nothing to anchor a MARK to; do not open a prompt that goes nowhere.
    await flashBadge('!', '#e67e22'); // amber: "start a session first"
    return;
  }
  if (!tab || tab.id == null) {
    await flashBadge('X', '#c0392b'); // red X: could not reach a page
    return;
  }
  try {
    const resp = await chrome.tabs.sendMessage(tab.id, { type: 'recorder:mark-prompt' });
    if (!resp || !resp.shown) {
      // The content script is present but declined to show the input (out of
      // scope, or not recording on this tab). The MARK would land nowhere, so
      // surface it instead of letting the keypress vanish.
      await flashBadge('X', '#c0392b'); // red X
    } else {
      await clearBadge(); // success: the on-page prompt is the feedback
    }
  } catch (e) {
    // No content script on this tab: its host is not in the manifest allowlist
    // (Phase 1 = localhost/127.0.0.1 only) or it is a restricted page. This is
    // the exact case that previously failed silently.
    console.warn(
      '[audit] MARK undelivered - no recorder on this tab:',
      e && e.message
    );
    await flashBadge('X', '#c0392b'); // red X
  }
}

// Brief toolbar-badge flash for MARK feedback. Uses the action API, which needs
// no extra permission. Guarded so a missing chrome.action (e.g. in tests) is a
// no-op rather than a throw. Self-clears; if the worker is killed first the
// badge just lingers harmlessly until the next MARK.
let badgeClearTimer = null;
async function flashBadge(text, color) {
  if (!chrome.action) return;
  try {
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setBadgeText({ text });
    if (badgeClearTimer) clearTimeout(badgeClearTimer);
    badgeClearTimer = setTimeout(() => {
      if (chrome.action) chrome.action.setBadgeText({ text: '' });
      badgeClearTimer = null;
    }, 2500);
  } catch (_) {
    /* action API hiccup; nothing else to do */
  }
}

async function clearBadge() {
  if (!chrome.action) return;
  try {
    if (badgeClearTimer) {
      clearTimeout(badgeClearTimer);
      badgeClearTimer = null;
    }
    await chrome.action.setBadgeText({ text: '' });
  } catch (_) {
    /* ignore */
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

// end of service-worker.js
