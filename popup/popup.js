// popup/popup.js — Start/Stop UI. All real work happens in the service worker.

const startBtn = document.getElementById('start');
const stopBtn = document.getElementById('stop');
const statusEl = document.getElementById('status');

function setStatus(text) { statusEl.textContent = text; }

function render(session) {
  const active = !!(session && session.active);
  startBtn.disabled = active;
  stopBtn.disabled = !active;
  if (active) {
    setStatus('Recording… ' + (session.frameCount || 0) + ' frame(s)');
  } else {
    setStatus('Idle.');
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

// Reflect current state when the popup opens.
(async () => {
  const r = await send({ type: 'session:status' });
  render(r && r.ok ? r.session : null);
})();
