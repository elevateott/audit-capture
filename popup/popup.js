// popup/popup.js — Start/Stop UI. All real work happens in the service worker.

const startBtn = document.getElementById('start');
const stopBtn = document.getElementById('stop');
const statusEl = document.getElementById('status');
const elapsedEl = document.getElementById('elapsed');

function setStatus(text) { statusEl.textContent = text; }

// Live mm:ss from the worker's session.startedAt. Cosmetic only — if startedAt
// is missing show nothing rather than NaN. The popup ticks it itself (1s) while
// open; the worker owns the authoritative count (the toolbar badge in minutes).
let elapsedTimer = null;
let startedAt = null;

function fmtElapsed(ms) {
  const total = Math.floor(ms / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return mm + ':' + ss;
}

function paintElapsed() {
  if (startedAt == null) { elapsedEl.textContent = ''; return; }
  elapsedEl.textContent = fmtElapsed(Date.now() - startedAt);
}

function stopElapsed() {
  if (elapsedTimer != null) { clearInterval(elapsedTimer); elapsedTimer = null; }
  startedAt = null;
  elapsedEl.textContent = '';
}

function render(session) {
  const active = !!(session && session.active);
  startBtn.disabled = active;
  stopBtn.disabled = !active;
  if (active) {
    setStatus('Recording… ' + (session.frameCount || 0) + ' frame(s) ');
    startedAt = typeof session.startedAt === 'number' ? session.startedAt : null;
    paintElapsed();
    if (elapsedTimer == null && startedAt != null) {
      elapsedTimer = setInterval(paintElapsed, 1000);
    }
  } else {
    setStatus('Idle.');
    stopElapsed();
  }
}

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(resp);
    });
  });
}

startBtn.addEventListener('click', async () => {
  setStatus('Starting…');
  const r = await send({ type: 'session:start' });
  if (!r || !r.ok) { setStatus('Error: ' + (r && r.error)); return; }
  render(r.session);
});

stopBtn.addEventListener('click', async () => {
  setStatus('Building package…');
  const r = await send({ type: 'session:stop' });
  if (!r || !r.ok) { setStatus('Error: ' + (r && r.error)); return; }
  const c = r.counts || {};
  setStatus('Saved ' + r.filename + ' — ' + (c.frames || 0) + ' frames, ' + (c.timeline || 0) + ' events.');
  render(null);
});

// Stop the ticker when the popup closes so it doesn't leak across reopens.
window.addEventListener('pagehide', stopElapsed);

// Reflect current state when the popup opens. Read the worker's session record
// straight from chrome.storage.session — the same 'session' key
// background/service-worker.js owns — instead of a session:status round-trip.
// A status message would block first paint on a COLD service-worker start
// (re-read + re-parse of every importScripts file), which costs whole seconds
// on network-backed profiles (AVD/FSLogix). The storage read is served by the
// browser process, so opening the popup wakes no worker at all. Extension pages
// are trusted contexts — no setAccessLevel needed. The worker KEEPS its
// session:status handler: content/recorder.js still uses it to self-resume.
(async () => {
  const o = await chrome.storage.session.get('session');
  render(o && o.session ? o.session : null);
})();
