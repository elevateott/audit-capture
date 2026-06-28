// test/manifest.test.js
// Guards the manifest invariants a loop could silently break — most importantly
// the README's rule that host_permissions and content_scripts.matches stay in
// sync (a mismatch means the content script silently never injects on a host).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));

test('manifest is MV3 with the expected entry points', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(typeof manifest.version, 'string');
  assert.equal(manifest.background.service_worker, 'background/service-worker.js');
  assert.equal(manifest.action.default_popup, 'popup/popup.html');
});

test('every file the manifest references exists', () => {
  const refs = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...manifest.content_scripts[0].js,
    ...Object.values(manifest.icons),
  ];
  for (const r of refs) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', r)), 'missing file referenced by manifest: ' + r);
  }
});

test('host_permissions and content_scripts.matches are in sync', () => {
  const hosts = [...manifest.host_permissions].sort();
  const matches = [...manifest.content_scripts[0].matches].sort();
  assert.deepEqual(matches, hosts, 'content_scripts.matches must equal host_permissions');
});

test('content script loads selector before recorder', () => {
  const js = manifest.content_scripts[0].js;
  assert.ok(js.indexOf('lib/selector.js') < js.indexOf('content/recorder.js'),
    'selector.js must be listed before recorder.js so AuditSelector exists');
});

test('declares the hotkey commands', () => {
  assert.ok(manifest.commands['toggle-session']);
  assert.ok(manifest.commands['mark']);
});
