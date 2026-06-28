// lib/selector.js
// Stable-ish CSS path generator for the recorder click spine.
// Goal: good enough to identify the element in a ticket, NOT a bulletproof locator.
// Preference order: #id  >  [data-*]  >  tag + :nth-of-type chain.
//
// Loaded as a content-script file (NOT a module) BEFORE content/recorder.js,
// so it shares the isolated-world scope and exposes window.AuditSelector.

(function () {
  'use strict';

  function escapeIdent(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    // Minimal fallback if CSS.escape is unavailable.
    return String(value).replace(/([^a-zA-Z0-9_-])/g, '\\$1');
  }

  // Returns a single segment for one element: tag, plus #id or a [data-*] hook
  // if present, else an :nth-of-type to disambiguate among siblings.
  function segment(el) {
    const tag = el.tagName.toLowerCase();

    if (el.id) {
      return '#' + escapeIdent(el.id);
    }

    // Prefer a data-* attribute as a stable hook.
    for (const attr of el.attributes) {
      if (attr.name.startsWith('data-') && attr.value) {
        return tag + '[' + attr.name + '="' + cssAttrValue(attr.value) + '"]';
      }
    }

    // Fall back to nth-of-type among same-tag siblings.
    const parent = el.parentElement;
    if (!parent) return tag;
    const sameTag = Array.prototype.filter.call(
      parent.children,
      (c) => c.tagName === el.tagName
    );
    if (sameTag.length === 1) return tag;
    const index = sameTag.indexOf(el) + 1;
    return tag + ':nth-of-type(' + index + ')';
  }

  function cssAttrValue(value) {
    return String(value).replace(/(["\\])/g, '\\$1');
  }

  // Builds a path from the nearest #id ancestor (or <body>) down to el.
  function cssPath(el) {
    if (!(el instanceof Element)) return '';
    const parts = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE) {
      const seg = segment(node);
      parts.unshift(seg);
      // Stop early once we anchor on an id — it's unique enough.
      if (seg.charAt(0) === '#') break;
      if (node.tagName === 'BODY' || node.tagName === 'HTML') break;
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  const api = { cssPath };
  if (typeof window !== 'undefined') window.AuditSelector = api;
  // Test seam: no-op in the browser (no `module`), lets Node import for unit tests.
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
