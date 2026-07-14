// lib/package.js
// Assembles the output-package contract (HANDOFF.md §4 / PRD.md §6) from the
// IndexedDB stores and zips it. PHASE 1 emits: frames, recording.json,
// narration.txt, timeline.json. (console.txt, network-errors.txt,
// environment.json, voice clips, *_annotated.png come in Phase 2/3.)
//
// !! The filenames and JSON shapes below are a HARD CONTRACT consumed by the
// !! downstream /audit step. Do not rename casually — a rename breaks consumers.
//
// Loaded into the service worker via importScripts() after store.js — exposes
// self.AuditPackage. build() requires global JSZip, which the worker loads
// lazily (ensureJSZip) right before calling build(), so JSZip need not be
// present when THIS file is evaluated — only when build() runs.

(function () {
  'use strict';

  // 'YYYY-MM-DD_HH-MM-SS.mmm' in LOCAL time — matches Auto Screen Capture so
  // lexical sort === chronological order.
  function stamp(d) {
    d = d || new Date();
    const p = (n, w) => String(n).padStart(w || 2, '0');
    return (
      d.getFullYear() +
      '-' + p(d.getMonth() + 1) +
      '-' + p(d.getDate()) +
      '_' + p(d.getHours()) +
      '-' + p(d.getMinutes()) +
      '-' + p(d.getSeconds()) +
      '.' + p(d.getMilliseconds(), 3)
    );
  }

  // 'HH-MM-SS.mmm' for narration lines.
  function clock(t) {
    const d = new Date(t);
    const p = (n, w) => String(n).padStart(w || 2, '0');
    return (
      p(d.getHours()) + '-' + p(d.getMinutes()) + '-' + p(d.getSeconds()) +
      '.' + p(d.getMilliseconds(), 3)
    );
  }

  function dataUrlToUint8(dataUrl) {
    const base64 = dataUrl.split(',')[1] || '';
    const bin = atob(base64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // recording.json in DevTools Recorder shape: { title, steps:[...] }.
  function buildRecording(title, steps) {
    return JSON.stringify({ title: title, steps: steps }, null, 2);
  }

  // narration.txt: one line per MARK/voice — '[HH-MM-SS.mmm] (/route) <text>'.
  function buildNarration(rows) {
    return rows.map((r) => r.line).join('\n') + (rows.length ? '\n' : '');
  }

  // console.txt: one line per console row, sorted ascending by t —
  // '[HH-MM-SS.mmm] (/route) LEVEL: message' (LEVEL is the level upper-cased).
  function buildConsole(rows) {
    const sorted = rows.slice().sort((a, b) => a.t - b.t);
    return (
      sorted
        .map(
          (r) =>
            '[' + clock(r.t) + '] (' + r.route + ') ' +
            String(r.level).toUpperCase() + ': ' + r.message
        )
        .join('\n') + (sorted.length ? '\n' : '')
    );
  }

  // network-errors.txt: one line per failed request, sorted ascending by t —
  // '[HH-MM-SS.mmm] (/route) METHOD STATUS URL' (STATUS is an HTTP code or a
  // network-level error string, e.g. net::ERR_NAME_NOT_RESOLVED).
  function buildNetwork(rows) {
    const sorted = rows.slice().sort((a, b) => a.t - b.t);
    return (
      sorted
        .map(
          (r) =>
            '[' + clock(r.t) + '] (' + r.route + ') ' +
            r.method + ' ' + r.status + ' ' + r.url
        )
        .join('\n') + (sorted.length ? '\n' : '')
    );
  }

  // timeline.json: ordered join of every event — { t, route, type, ref }.
  function buildTimeline(entries) {
    const sorted = entries.slice().sort((a, b) => a.t - b.t);
    return JSON.stringify(sorted, null, 2);
  }

  // Returns { filename, dataUrl } for chrome.downloads.download.
  // (Service workers can't use URL.createObjectURL for downloads reliably, so
  // we hand chrome a base64 data: URL of the zip.)
  async function build(opts) {
    const title = (opts && opts.title) || 'audit';
    const folder = 'audit-' + stamp(new Date(opts && opts.startedAt));

    const [frames, timeline, steps, narration, consoleRows, networkRows, envRows, annotations] =
      await Promise.all([
        self.AuditStore.getAll('frames'),
        self.AuditStore.getAll('timeline'),
        self.AuditStore.getAll('steps'),
        self.AuditStore.getAll('narration'),
        self.AuditStore.getAll('console'),
        self.AuditStore.getAll('network'),
        self.AuditStore.getAll('environment'),
        self.AuditStore.getAll('annotations'),
      ]);

    const zip = new JSZip();
    const root = zip.folder(folder);

    // Frames — filename IS the capture time.
    for (const f of frames) {
      root.file(f.name, dataUrlToUint8(f.dataUrl));
    }

    // Operator-drawn annotations — emitted under their own '*_annotated.png' name
    // (the /audit step classifies these as screenshot frames).
    for (const a of annotations) {
      root.file(a.name, dataUrlToUint8(a.dataUrl));
    }

    root.file('recording.json', buildRecording(title, steps));
    root.file('narration.txt', buildNarration(narration));
    root.file('console.txt', buildConsole(consoleRows));
    root.file('network-errors.txt', buildNetwork(networkRows));
    // environment.json: one-time context header. The single stored record, or {}.
    root.file('environment.json', JSON.stringify(envRows[0] || {}, null, 2));
    root.file('timeline.json', buildTimeline(timeline));

    const base64 = await zip.generateAsync({ type: 'base64' });
    return {
      filename: folder + '.zip',
      dataUrl: 'data:application/zip;base64,' + base64,
      counts: {
        frames: frames.length,
        steps: steps.length,
        narration: narration.length,
        console: consoleRows.length,
        network: networkRows.length,
        timeline: timeline.length,
      },
    };
  }

  const api = { build, stamp, clock };
  if (typeof self !== 'undefined') self.AuditPackage = api;
  // Test seam: no-op in the worker (no `module`), lets Node import for unit tests.
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
