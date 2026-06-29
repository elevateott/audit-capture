// test/scope.test.js
// Unit tests for lib/scope.js -- the shared in-scope check used by both the
// worker and the content script. No DOM/chrome needed: scope.js exports an api
// object via the module test seam.

const test = require('node:test');
const assert = require('node:assert/strict');

const scope = require('../lib/scope.js');

test('http and https pages are in scope', () => {
  assert.equal(scope.inScope('http://example.com/'), true);
  assert.equal(scope.inScope('https://staging.elevateott.com/admin/x?y=1'), true);
});

test('non-http(s) schemes are out of scope', () => {
  assert.equal(scope.inScope('chrome://extensions'), false);
  assert.equal(scope.inScope('file:///c:/page.html'), false);
  assert.equal(scope.inScope('about:blank'), false);
  assert.equal(scope.inScope('devtools://devtools/bundled/x.html'), false);
});

test('garbage / empty input is out of scope (never throws)', () => {
  assert.equal(scope.inScope('not a url'), false);
  assert.equal(scope.inScope(''), false);
});

test('a denylisted host and its subdomains are out of scope', () => {
  // The shipped denylist is empty; DENYLIST is the same array reference inScope
  // reads, so push a host in for the test then restore it.
  scope.DENYLIST.push('mail.google.com');
  try {
    assert.equal(scope.inScope('https://mail.google.com/'), false, 'exact host blocked');
    assert.equal(scope.inScope('https://inbox.mail.google.com/'), false, 'subdomain blocked');
    assert.equal(scope.inScope('https://notmail.google.com/'), true, 'lookalike NOT blocked');
    assert.equal(scope.inScope('https://example.com/'), true, 'unrelated host allowed');
  } finally {
    scope.DENYLIST.length = 0;
  }
});

test('the shipped denylist is empty (edge config, not a default block)', () => {
  assert.deepEqual(scope.DENYLIST, []);
});
