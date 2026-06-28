// test/selector.test.js
// Unit tests for lib/selector.js cssPath, run against a jsdom DOM.
// Verifies the preference order: #id > [data-*] > tag + :nth-of-type chain.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
global.window = dom.window;
global.document = dom.window.document;
global.Node = dom.window.Node;
global.Element = dom.window.Element;
global.CSS = dom.window.CSS;

const { cssPath } = require('../lib/selector.js');

function frag(html) {
  document.body.innerHTML = html;
}

test('prefers #id and stops there', () => {
  frag('<div><button id="go">x</button></div>');
  assert.equal(cssPath(document.getElementById('go')), '#go');
});

test('prefers a data-* hook when no id', () => {
  frag('<div><span data-testid="title">t</span></div>');
  const el = document.querySelector('[data-testid]');
  assert.match(cssPath(el), /span\[data-testid="title"\]/);
});

test('falls back to :nth-of-type among same-tag siblings', () => {
  frag('<ul><li>a</li><li>b</li><li>c</li></ul>');
  const third = document.querySelectorAll('li')[2];
  assert.match(cssPath(third), /li:nth-of-type\(3\)/);
});

test('anchors the path on the nearest id ancestor', () => {
  frag('<section id="panel"><div><a>link</a></div></section>');
  const a = document.querySelector('a');
  const path = cssPath(a);
  assert.ok(path.startsWith('#panel'), 'should start at #panel, got: ' + path);
  assert.ok(path.includes('a'), 'should include the anchor element');
});

test('returns empty string for non-elements', () => {
  assert.equal(cssPath(null), '');
  assert.equal(cssPath(document.createTextNode('x')), '');
});
