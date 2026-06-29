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
  if (!session || !session.active) return;
  const t = Date.now();
  const line =
    '[' + self.AuditPackage.clock(t) + '] (' + (route || '/') + ') ' + text;
  await self.AuditStore.put('narration', { line, t });
  await appendTimeline({
    t,
    route: route || '/',
    type: 'mark',
    ref: session.lastFrame || null,
  });
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

// ---- session control -------------------------------------------------------

async function startSession(tab) {
  await self.AuditStore.clearAll();
  const session = {
    active: true,
    startedAt: Date.now(),
    title: (tab && tab.title) || 'audit',
    intervalMs: DEFAULT_INTERVAL_MS,
    frameCount: 0,
    lastFrame: null,
    windowId: tab ? tab.windowId : chrome.windows.WINDOW_ID_CURRENT,
    tabId: tab ? tab.id : null,
  };
  await setSession(session);

  // Attach the console tap (Phase 2). Shows the "is being debugged" banner.
  // `since` drops pre-session events Chrome replays on attach.
  await startConsoleTap(session.tabId, session.startedAt);

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

  // Detach the console tap so the debugger banner clears.
  await stopConsoleTap(session.tabId);

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
        await addMark(msg.text, route);
        sendResponse({ ok: true });
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
    await chrome.tabs.sendMessage(tab.id, { type: 'recorder:mark-prompt' });
    await clearBadge(); // success: the on-page prompt is the feedback
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
