// test/format.test.js
// Pure-function tests for the time formatting that the filename + narration
// contracts depend on. These run without any browser globals.

const test = require('node:test');
const assert = require('node:assert/strict');

global.self = global;
global.JSZip = require('../lib/jszip.min.js'); // package.js references JSZip at load
require('../lib/package.js');
const { stamp, clock } = self.AuditPackage;

test('stamp() formats as YYYY-MM-DD_HH-MM-SS.mmm (local time)', () => {
  const d = new Date(2026, 5, 28, 9, 4, 7, 30); // local: 2026-06-28 09:04:07.030
  assert.equal(stamp(d), '2026-06-28_09-04-07.030');
});

test('stamp() zero-pads milliseconds to 3 digits', () => {
  const d = new Date(2026, 0, 1, 0, 0, 0, 5);
  assert.match(stamp(d), /\.005$/);
});

test('clock() formats as HH-MM-SS.mmm', () => {
  const d = new Date(2026, 5, 28, 14, 30, 2, 100);
  assert.equal(clock(d.getTime()), '14-30-02.100');
});

test('stamp() is lexically sortable into chronological order', () => {
  const a = stamp(new Date(2026, 5, 28, 9, 0, 0, 0));
  const b = stamp(new Date(2026, 5, 28, 9, 0, 0, 500));
  const c = stamp(new Date(2026, 5, 28, 9, 0, 1, 0));
  assert.deepEqual([c, a, b].sort(), [a, b, c]);
});
