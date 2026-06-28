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
    // Ask the content script to prompt for MARK text on the page.
    if (tab && tab.id != null) {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'recorder:mark-prompt' });
      } catch (e) {
        /* no content script here */
      }
    }
  }
});

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}
