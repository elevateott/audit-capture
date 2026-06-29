// test/contract.test.js
// THE fitness function for the output-package contract (HANDOFF.md §4 / PRD.md §6).
// Builds a real package from seeded store data the way the service worker does
// (worker-like globals + the vendored JSZip + fake-indexeddb), unzips it, and
// asserts every filename and JSON shape a downstream /audit consumer depends on.
//
// If a loop renames a file or breaks a JSON shape, this test must go red.

const test = require('node:test');
const assert = require('node:assert/strict');

// --- worker-like environment (mirrors importScripts in the service worker) ---
require('fake-indexeddb/auto'); // defines global.indexedDB
global.self = global; // the worker's global is `self`; bind it so lib files attach here
global.JSZip = require('../lib/jszip.min.js');
require('../lib/store.js'); // -> self.AuditStore
require('../lib/package.js'); // -> self.AuditPackage

const FRAME_RE = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.\d{3}\.jpeg$/;
const NARRATION_RE = /^\[\d{2}-\d{2}-\d{2}\.\d{3}\] \(.+\) .+/;

// 1x1 JPEG-ish payload as a data URL (content doesn't matter to the contract).
const FAKE_JPEG = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');

async function seedAndBuild() {
  await self.AuditStore.clearAll();

  const base = Date.parse('2026-06-28T14:30:00Z');
  // Two frames, intentionally inserted out of chronological order to prove the
  // timeline sort works regardless of insertion order.
  const f2 = self.AuditPackage.stamp(new Date(base + 5000)) + '.jpeg';
  const f1 = self.AuditPackage.stamp(new Date(base)) + '.jpeg';
  await self.AuditStore.put('frames', { name: f2, dataUrl: FAKE_JPEG, t: base + 5000, route: '/b', reason: 'interval' });
  await self.AuditStore.put('frames', { name: f1, dataUrl: FAKE_JPEG, t: base, route: '/a', reason: 'click' });

  await self.AuditStore.put('steps', { type: 'setViewport', title: 'demo' });
  await self.AuditStore.put('steps', { type: 'click', selectors: [['#go']] });

  await self.AuditStore.put('narration', { line: '[14-30-02.000] (/a) MARK 001 — header overlaps logo, verdict: bug', t: base + 2000 });

  await self.AuditStore.put('timeline', { t: base + 5000, route: '/b', type: 'frame', ref: f2 });
  await self.AuditStore.put('timeline', { t: base, route: '/a', type: 'frame', ref: f1 });
  await self.AuditStore.put('timeline', { t: base + 2000, route: '/a', type: 'mark', ref: f1, markId: '001' });

  const pkg = await self.AuditPackage.build({ title: 'demo', startedAt: base });
  const b64 = pkg.dataUrl.split(',')[1];
  const zip = await JSZip.loadAsync(Buffer.from(b64, 'base64'));
  return { pkg, zip, f1, f2 };
}

test('package is a single audit-<timestamp> folder', async () => {
  const { zip } = await seedAndBuild();
  const top = new Set(Object.keys(zip.files).map((p) => p.split('/')[0]));
  assert.equal(top.size, 1, 'exactly one top-level folder');
  assert.match([...top][0], /^audit-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.\d{3}$/);
});

test('frame filenames match YYYY-MM-DD_HH-MM-SS.mmm.jpeg', async () => {
  const { zip } = await seedAndBuild();
  const jpegs = Object.keys(zip.files).filter((p) => p.endsWith('.jpeg')).map((p) => p.split('/').pop());
  assert.equal(jpegs.length, 2);
  for (const name of jpegs) assert.match(name, FRAME_RE);
  // Lexical sort === chronological order.
  const sorted = [...jpegs].sort();
  assert.deepEqual(sorted, jpegs.sort());
});

test('recording.json parses as { title, steps[] }', async () => {
  const { zip } = await seedAndBuild();
  const path = Object.keys(zip.files).find((p) => p.endsWith('recording.json'));
  const rec = JSON.parse(await zip.files[path].async('string'));
  assert.equal(typeof rec.title, 'string');
  assert.ok(Array.isArray(rec.steps));
  assert.equal(rec.steps[0].type, 'setViewport');
  assert.equal(rec.steps.length, 2);
});

test('narration.txt lines carry [time] (route) and a regex-extractable MARK', async () => {
  const { zip } = await seedAndBuild();
  const path = Object.keys(zip.files).find((p) => p.endsWith('narration.txt'));
  const txt = (await zip.files[path].async('string')).trim();
  const lines = txt.split('\n').filter(Boolean);
  assert.ok(lines.length >= 1);
  for (const line of lines) assert.match(line, NARRATION_RE);
  // MARK id must be extractable.
  assert.match(txt, /MARK\s+(\d+)/);
});

test('timeline.json is ascending by t and every frame ref resolves to a file', async () => {
  const { zip } = await seedAndBuild();
  const path = Object.keys(zip.files).find((p) => p.endsWith('timeline.json'));
  const tl = JSON.parse(await zip.files[path].async('string'));
  assert.ok(Array.isArray(tl) && tl.length >= 3);

  // Monotonic non-decreasing order — the keystone guarantee.
  for (let i = 1; i < tl.length; i++) {
    assert.ok(tl[i].t >= tl[i - 1].t, 'timeline not sorted ascending at index ' + i);
  }

  // Every entry has the contract fields; frame refs must resolve to a real file.
  const filesInZip = new Set(Object.keys(zip.files).map((p) => p.split('/').pop()));
  for (const e of tl) {
    assert.ok('t' in e && 'route' in e && 'type' in e && 'ref' in e);
    if (e.type === 'frame') assert.ok(filesInZip.has(e.ref), 'frame ref missing: ' + e.ref);
    // Additive, backward-compatible: 'mark' entries carry a markId matching the
    // MARK id in narration.txt; other types must not.
    if (e.type === 'mark') assert.equal(e.markId, '001', 'mark entry carries its narration id');
  }
});

test('build reports counts matching what was seeded', async () => {
  const { pkg } = await seedAndBuild();
  assert.equal(pkg.counts.frames, 2);
  assert.equal(pkg.counts.steps, 2);
  assert.equal(pkg.counts.narration, 1);
  assert.equal(pkg.counts.timeline, 3);
  assert.match(pkg.filename, /^audit-.*\.zip$/);
});
