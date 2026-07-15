// test/popup.test.js
// Popup harness — loads the real popup/popup.js under jsdom with a mocked
// chrome, and pins the cold-open contract:
//
//   * Opening the popup must NOT message the service worker. The popup paints
//     from chrome.storage.session directly (the worker's 'session' key). A
//     session:status round-trip would block first paint on a cold worker start —
//     whole seconds on network-backed profiles (AVD/FSLogix) — while the storage
//     read is served by the browser process with no worker involved.
//   * Guards: an active session renders Recording + Stop enabled; no session
//     renders Idle; a Start click still messages the worker (session:start).
//
// If a future change reintroduces a worker round-trip on open, the sent.length
// assertions here go red. That is the point — fix the popup, not this file.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const POPUP = path.resolve(__dirname, '..', 'popup', 'popup.js');

// Timers: the popup starts a 1s elapsed ticker when a session is active. Stub
// them so an active-session test doesn't keep the process alive.
global.setInterval = () => 1;
global.clearInterval = () => {};

// Fresh DOM + chrome per scenario; popup.js caches element refs at load, so it
// must be re-required against the new globals each time.
function freshPopup({ sessionValue, respond } = {}) {
  const dom = new JSDOM(
    '<!doctype html><html><body>' +
      '<button id="start">Start session</button>' +
      '<button id="stop" disabled>Stop &amp; export</button>' +
      '<div id="elapsed"></div>' +
      '<div id="status">Idle.</div>' +
      '</body></html>',
    { url: 'chrome-extension://test/popup/popup.html' }
  );
  global.window = dom.window;
  global.document = dom.window.document;

  const sent = [];
  global.chrome = {
    runtime: {
      sendMessage: (msg, cb) => {
        sent.push(msg);
        if (typeof cb === 'function') cb(respond ? respond(msg) : { ok: true });
      },
    },
    storage: {
      session: {
        get: async (key) => (sessionValue ? { [key]: sessionValue } : {}),
      },
    },
  };

  delete require.cache[POPUP];
  require(POPUP);
  return { dom, sent };
}

const tick = () => new Promise((r) => setImmediate(r));

test('open with an active session: renders Recording from storage, worker NOT woken', async () => {
  const { dom, sent } = freshPopup({
    sessionValue: { active: true, frameCount: 3, startedAt: Date.now() - 65000 },
  });
  await tick();
  const doc = dom.window.document;
  assert.match(doc.getElementById('status').textContent, /Recording/);
  assert.equal(doc.getElementById('start').disabled, true);
  assert.equal(doc.getElementById('stop').disabled, false);
  assert.match(doc.getElementById('elapsed').textContent, /^01:0[56]$/);
  assert.equal(sent.length, 0, 'popup open must not message the worker');
});

test('open with no session: renders Idle, worker NOT woken', async () => {
  const { dom, sent } = freshPopup({});
  await tick();
  const doc = dom.window.document;
  assert.match(doc.getElementById('status').textContent, /Idle/);
  assert.equal(doc.getElementById('start').disabled, false);
  assert.equal(doc.getElementById('stop').disabled, true);
  assert.equal(sent.length, 0, 'popup open must not message the worker');
});

test('Start click still messages the worker (session:start)', async () => {
  const { dom, sent } = freshPopup({
    respond: (msg) =>
      msg && msg.type === 'session:start'
        ? { ok: true, session: { active: true, frameCount: 0, startedAt: Date.now() } }
        : { ok: true },
  });
  await tick();
  dom.window.document.getElementById('start').click();
  await tick();
  assert.deepEqual(sent.map((m) => m.type), ['session:start']);
  assert.equal(dom.window.document.getElementById('stop').disabled, false);
});
