// content/recorder.js
// In-page half of Phase 1: drives the capture interval (the worker can't —
// it dies when idle), records the click spine, and hosts the floating overlay
// + MARK input. Runs in the isolated world; AuditSelector is provided by
// lib/selector.js, listed before this file in the manifest.
//
// All it does is POST messages to the service worker; the worker owns state.

(function () {
  'use strict';

  let intervalId = null;
  let active = false;
  let currentIntervalMs = 5000; // last interval, so the annotator can resume it.

  const route = () => location.pathname + location.search;

  function send(type, extra) {
    try {
      chrome.runtime.sendMessage(Object.assign({ type, route: route() }, extra));
    } catch (e) {
      // Worker may be respawning; a dropped tick is acceptable.
    }
  }

  // ---- capture interval ----------------------------------------------------

  function startTicking(intervalMs) {
    stopTicking();
    currentIntervalMs = intervalMs || currentIntervalMs;
    intervalId = setInterval(() => send('capture', { reason: 'interval' }), currentIntervalMs);
  }
  function stopTicking() {
    if (intervalId != null) clearInterval(intervalId);
    intervalId = null;
  }

  // Foreground-only ticking. chrome.tabs.captureVisibleTab always grabs the
  // FOCUSED tab, so a background tab's interval would screenshot whatever tab is
  // visible and mislabel the frame with this tab's route. Only tick while we are
  // the visible tab; the visibilitychange listener flips us as focus moves.
  function applyTickingForVisibility() {
    if (active && document.visibilityState === 'visible') startTicking(currentIntervalMs);
    else stopTicking();
  }
  // Registered once, for the lifetime of the page (cheap no-op while inactive).
  document.addEventListener('visibilitychange', applyTickingForVisibility);

  // ---- click spine ---------------------------------------------------------

  // Our own overlay/MARK input live in the page; never record interactions
  // with them as part of the audited app.
  const AUDIT_UI = '#__audit_capture_overlay__, #__audit_mark_input__, #__audit_annotator__';
  const isOwnUi = (el) => !!(el && el.closest && el.closest(AUDIT_UI));

  function onClick(e) {
    if (!active) return;
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (isOwnUi(target)) return;
    const sel = window.AuditSelector ? window.AuditSelector.cssPath(target) : '';
    send('step', { step: { type: 'click', selectors: [[sel]] } });
    send('capture', { reason: 'click' });
  }

  function onChange(e) {
    if (!active) return;
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (isOwnUi(target)) return;
    const sel = window.AuditSelector ? window.AuditSelector.cssPath(target) : '';
    const value = 'value' in target ? String(target.value) : undefined;
    send('step', { step: { type: 'change', selectors: [[sel]], value } });
  }

  let lastRoute = route();
  function onNav() {
    if (!active) return;
    const r = route();
    if (r === lastRoute) return;
    lastRoute = r;
    send('step', { step: { type: 'navigate', url: location.href } });
  }

  // ---- MARK ----------------------------------------------------------------

  // Returns true only if the MARK input was actually shown -- i.e. the recorder
  // is active AND this page is in scope. The worker uses the return value to flash
  // an error badge instead of failing silently when a MARK lands nowhere.
  function promptMark() {
    if (!active) return false;
    if (!(window.AuditScope && window.AuditScope.inScope(location.href))) return false;
    showMarkInput();
    return true;
  }

  function submitMark(text) {
    const trimmed = (text || '').trim();
    if (!trimmed) return;
    // Contract: 'MARK <id> — <what you see>, <verdict>'. We pass the typed text
    // through verbatim; the worker stamps time + route.
    send('mark', { text: trimmed });
    setCounter(); // refresh shown route etc.
    showToast('MARK saved');
  }

  // Brief visible confirmation so the operator gets feedback without hunting for
  // the tiny input. Fixed-position, high z-index like the overlay; auto-dismiss.
  function showToast(text) {
    const toast = document.createElement('div');
    toast.className = '__audit_toast__';
    toast.textContent = text;
    toast.style.cssText = [
      'position:fixed', 'z-index:2147483647', 'bottom:104px', 'right:16px',
      'background:#1e7a34', 'color:#fff', 'font:12px/1.4 system-ui,sans-serif',
      'padding:8px 12px', 'border-radius:8px',
      'box-shadow:0 2px 12px rgba(0,0,0,.4)', 'user-select:none',
    ].join(';');
    document.documentElement.appendChild(toast);
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 1500);
  }

  // ---- overlay UI ----------------------------------------------------------

  let overlay = null;
  let counterEl = null;

  function buildOverlay() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.id = '__audit_capture_overlay__';
    overlay.style.cssText = [
      'position:fixed', 'z-index:2147483647', 'bottom:16px', 'right:16px',
      'background:#1e1e22', 'color:#eee', 'font:12px/1.4 system-ui,sans-serif',
      'padding:8px 10px', 'border-radius:8px', 'box-shadow:0 2px 12px rgba(0,0,0,.4)',
      'display:flex', 'gap:8px', 'align-items:center', 'user-select:none',
    ].join(';');

    const dot = document.createElement('span');
    dot.textContent = '● REC';
    dot.style.cssText = 'color:#dc3434;font-weight:600';

    counterEl = document.createElement('span');
    counterEl.style.cssText = 'opacity:.8';

    const markBtn = document.createElement('button');
    markBtn.textContent = 'MARK';
    markBtn.style.cssText =
      'background:#3a3a40;color:#fff;border:0;border-radius:5px;padding:3px 8px;cursor:pointer;font:inherit';
    markBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      showMarkInput();
    });

    const annotateBtn = document.createElement('button');
    annotateBtn.id = '__audit_annotate__';
    annotateBtn.textContent = 'Annotate';
    annotateBtn.style.cssText =
      'background:#3a3a40;color:#fff;border:0;border-radius:5px;padding:3px 8px;cursor:pointer;font:inherit';
    annotateBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      chrome.runtime.sendMessage({ type: 'annotate:capture', route: route() }, (resp) => {
        if (chrome.runtime.lastError) return;
        if (!resp || !resp.dataUrl) return;
        openAnnotator(resp.dataUrl);
      });
    });

    overlay.appendChild(dot);
    overlay.appendChild(counterEl);
    overlay.appendChild(markBtn);
    overlay.appendChild(annotateBtn);
    document.documentElement.appendChild(overlay);
    setCounter();
  }

  function removeOverlay() {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
    counterEl = null;
  }

  function setCounter() {
    if (counterEl) counterEl.textContent = route();
  }

  // Minimal inline MARK input (avoids window.prompt, which some pages block).
  function showMarkInput() {
    const existing = document.getElementById('__audit_mark_input__');
    if (existing) { existing.focus(); return; }
    const wrap = document.createElement('div');
    wrap.id = '__audit_mark_input__';
    wrap.style.cssText = [
      'position:fixed', 'z-index:2147483647', 'bottom:60px', 'right:16px',
      'background:#1e1e22', 'padding:8px', 'border-radius:8px',
      'box-shadow:0 2px 12px rgba(0,0,0,.4)', 'display:flex', 'gap:6px',
    ].join(';');
    // A textarea (not a single-line input) so dictated speech is readable and
    // scrollable: fixed max-height, scrolls rather than growing without bound.
    const input = document.createElement('textarea');
    input.rows = 3;
    input.placeholder = "What's wrong + your call — e.g. featured image missing, verdict: bug";
    input.style.cssText =
      'width:320px;max-height:6em;overflow-y:auto;resize:none;' +
      'font:12px system-ui,sans-serif;padding:5px 7px;border:1px solid #444;border-radius:5px;background:#111;color:#fff';
    input.addEventListener('keydown', (ev) => {
      // Enter submits; Shift+Enter inserts a newline.
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        submitMark(input.value);
        close();
      }
      if (ev.key === 'Escape') close();
    });

    // Dictation: fill the MARK input via Web Speech. Lives inside
    // #__audit_mark_input__, so isOwnUi already keeps its clicks off the spine.
    const mic = document.createElement('button');
    mic.id = '__audit_mark_mic__';
    mic.textContent = '🎤';
    mic.title = 'Dictate';
    mic.style.cssText =
      'background:#3a3a40;color:#fff;border:0;border-radius:5px;padding:5px 8px;cursor:pointer;font:inherit';
    // Toggle a single recognizer: first click starts, second stops. Held in a
    // closure var so we never spawn a second recognizer over the first.
    let rec = null;
    mic.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (rec) { rec.stop(); return; } // already listening -> stop.
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) return; // graceful no-op when the browser lacks Web Speech.
      rec = new SR();
      rec.lang = 'en-US';
      rec.continuous = true; // a pause must not end dictation.
      rec.interimResults = true;
      rec.onresult = (e) => {
        let t = '';
        for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
        input.value = t;
        input.scrollTop = input.scrollHeight; // keep the newest words in view.
      };
      rec.onend = () => {
        rec = null;
        mic.removeAttribute('data-recording');
        mic.textContent = '🎤';
        mic.style.background = '#3a3a40';
      };
      mic.setAttribute('data-recording', 'true');
      mic.textContent = '● Listening';
      mic.style.background = '#dc3434';
      try { rec.start(); } catch (e) { /* already started / not allowed */ }
    });

    // Save: same effect as Enter (submitMark guards empty/whitespace). Lives
    // inside #__audit_mark_input__, so isOwnUi keeps its click off the spine.
    const saveBtn = document.createElement('button');
    saveBtn.id = '__audit_mark_save__';
    saveBtn.textContent = 'Save';
    saveBtn.style.cssText =
      'background:#1e7a34;color:#fff;border:0;border-radius:5px;padding:5px 10px;cursor:pointer;font:inherit';
    saveBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      submitMark(input.value);
      close();
    });

    function close() { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); }
    wrap.appendChild(input);
    wrap.appendChild(mic);
    wrap.appendChild(saveBtn);
    document.documentElement.appendChild(wrap);
    input.focus();
  }

  // ---- annotator -----------------------------------------------------------

  // Full-viewport overlay showing the captured screenshot on a <canvas> with a
  // pen/arrow/circle toolbar. Save exports the canvas to a PNG and ships it as an
  // 'annotation' message. While it's open we pause the capture interval so an
  // interval frame doesn't screenshot the drawing surface itself.
  function openAnnotator(dataUrl) {
    const existing = document.getElementById('__audit_annotator__');
    if (existing) return; // one at a time.

    stopTicking(); // don't let interval frames shoot the overlay.

    const box = document.createElement('div');
    box.id = '__audit_annotator__';
    box.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:2147483647',
      'background:rgba(0,0,0,.75)', 'display:flex', 'flex-direction:column',
      'align-items:center', 'justify-content:center', 'gap:8px',
    ].join(';');

    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'max-width:96vw;max-height:84vh;background:#fff;cursor:crosshair;box-shadow:0 4px 24px rgba(0,0,0,.6)';
    // willReadFrequently: the shape-preview path snapshots the canvas via
    // getImageData on every mousemove, so flag it for fast readbacks (and to
    // silence the Canvas2D advisory, which would otherwise leak into console.txt).
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    // Draw the screenshot in once it loads; canvas pixels match the image.
    const img = new Image();
    img.onload = () => {
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      if (ctx) ctx.drawImage(img, 0, 0);
    };
    img.src = dataUrl;

    let tool = 'pen';
    const toolbar = document.createElement('div');
    toolbar.style.cssText = [
      'display:flex', 'gap:6px', 'background:#1e1e22', 'padding:8px',
      'border-radius:8px', 'box-shadow:0 2px 12px rgba(0,0,0,.4)',
    ].join(';');
    const mkBtn = (label, cssExtra) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText =
        'background:#3a3a40;color:#fff;border:0;border-radius:5px;padding:4px 10px;cursor:pointer;font:12px system-ui,sans-serif' +
        (cssExtra || '');
      return b;
    };
    const tools = [['pen', 'Pen'], ['arrow', 'Arrow'], ['circle', 'Circle']];
    const toolBtns = {};
    for (const [key, label] of tools) {
      const b = mkBtn(label);
      if (key === tool) b.style.background = '#1e7a34';
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        tool = key;
        for (const k of Object.keys(toolBtns)) toolBtns[k].style.background = '#3a3a40';
        b.style.background = '#1e7a34';
      });
      toolBtns[key] = b;
      toolbar.appendChild(b);
    }
    const saveBtn = mkBtn('Save', ';background:#1e7a34');
    const cancelBtn = mkBtn('Cancel');
    toolbar.appendChild(saveBtn);
    toolbar.appendChild(cancelBtn);

    // ---- drawing ----
    let drawing = false;
    let startX = 0;
    let startY = 0;
    let snapshot = null; // canvas state at mousedown, for live shape preview.

    // Translate a mouse event to canvas pixel coords (canvas is CSS-scaled).
    const pos = (e) => {
      const r = canvas.getBoundingClientRect();
      return {
        x: (e.clientX - r.left) * (canvas.width / r.width),
        y: (e.clientY - r.top) * (canvas.height / r.height),
      };
    };

    const drawArrow = (x1, y1, x2, y2) => {
      const head = 12;
      const ang = Math.atan2(y2 - y1, x2 - x1);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.lineTo(x2 - head * Math.cos(ang - Math.PI / 6), y2 - head * Math.sin(ang - Math.PI / 6));
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - head * Math.cos(ang + Math.PI / 6), y2 - head * Math.sin(ang + Math.PI / 6));
      ctx.stroke();
    };

    canvas.addEventListener('mousedown', (e) => {
      if (!ctx) return;
      drawing = true;
      const p = pos(e);
      startX = p.x; startY = p.y;
      ctx.strokeStyle = '#e0245e';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      if (tool === 'pen') { ctx.beginPath(); ctx.moveTo(startX, startY); }
      else { snapshot = ctx.getImageData(0, 0, canvas.width, canvas.height); }
    });
    canvas.addEventListener('mousemove', (e) => {
      if (!drawing || !ctx) return;
      const p = pos(e);
      if (tool === 'pen') {
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      } else {
        if (snapshot) ctx.putImageData(snapshot, 0, 0); // redraw base for preview.
        if (tool === 'arrow') drawArrow(startX, startY, p.x, p.y);
        else if (tool === 'circle') {
          const rx = Math.abs(p.x - startX) / 2;
          const ry = Math.abs(p.y - startY) / 2;
          ctx.beginPath();
          ctx.ellipse(startX + (p.x - startX) / 2, startY + (p.y - startY) / 2, rx, ry, 0, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    });
    const endDraw = () => { drawing = false; snapshot = null; };
    canvas.addEventListener('mouseup', endDraw);
    canvas.addEventListener('mouseleave', endDraw);

    // ---- save / cancel ----
    function close() {
      if (box.parentNode) box.parentNode.removeChild(box);
      document.removeEventListener('keydown', onKey, true);
      applyTickingForVisibility(); // resume interval capture, but only if foreground.
    }
    function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
    document.addEventListener('keydown', onKey, true);

    saveBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      let png;
      try { png = canvas.toDataURL('image/png'); } catch (e) { png = null; }
      if (png) send('annotation', { dataUrl: png });
      close();
    });
    cancelBtn.addEventListener('click', (ev) => { ev.stopPropagation(); close(); });

    box.appendChild(toolbar);
    box.appendChild(canvas);
    document.documentElement.appendChild(box);
  }

  // ---- enable / disable ----------------------------------------------------

  function enable(intervalMs) {
    if (active) return;
    active = true;
    currentIntervalMs = intervalMs || currentIntervalMs;
    lastRoute = route();
    document.addEventListener('click', onClick, true);
    document.addEventListener('change', onChange, true);
    window.addEventListener('popstate', onNav);
    window.addEventListener('hashchange', onNav);
    // Foreground-only: tick now if we are the visible tab, else wait for focus.
    applyTickingForVisibility();
    buildOverlay();
    sendEnvironment();
  }

  // One-time context header captured at session start (PRD §4.7). `custom` is the
  // per-project extractor hook and ships EMPTY so no target-app context leaks into
  // the generic core.
  function sendEnvironment() {
    const env = {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      dpr: window.devicePixelRatio,
      zoom: window.visualViewport ? window.visualViewport.scale : 1,
      ua: navigator.userAgent,
      host: location.host,
      url: location.href,
      capturedAt: new Date().toISOString(),
      custom: {},
    };
    send('environment', { env });
  }

  function disable() {
    active = false;
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('change', onChange, true);
    window.removeEventListener('popstate', onNav);
    window.removeEventListener('hashchange', onNav);
    stopTicking();
    removeOverlay();
    // Dismiss an open MARK input so it doesn't linger after the session ends.
    const markInput = document.getElementById('__audit_mark_input__');
    if (markInput && markInput.parentNode) markInput.parentNode.removeChild(markInput);
  }

  // ---- worker -> content messages ------------------------------------------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg && msg.type) {
      case 'recorder:start':
        // Only self-enable on in-scope pages (a denylisted host stays dark even
        // if the worker broadcasts a start).
        if (window.AuditScope && window.AuditScope.inScope(location.href)) {
          enable(msg.intervalMs);
        }
        sendResponse({ ok: true });
        break;
      case 'recorder:stop':
        disable();
        sendResponse({ ok: true });
        break;
      case 'recorder:mark-prompt': {
        const shown = promptMark();
        sendResponse({ ok: true, shown });
        break;
      }
      default:
        sendResponse({ ok: false });
    }
    return true;
  });

  // If the page reloads/navigates mid-session, ask the worker whether a session
  // is active and resume ticking (the worker is the source of truth).
  chrome.runtime.sendMessage({ type: 'session:status' }, (resp) => {
    if (chrome.runtime.lastError) return;
    if (resp && resp.ok && resp.session && resp.session.active) {
      // A live session resumes capture only on in-scope pages -- otherwise every
      // tab you focus during a session would greedily start recording.
      if (window.AuditScope && window.AuditScope.inScope(location.href)) {
        enable(resp.session.intervalMs);
      }
    }
  });
})();
