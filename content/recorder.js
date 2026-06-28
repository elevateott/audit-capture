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
    intervalId = setInterval(() => send('capture', { reason: 'interval' }), intervalMs || 5000);
  }
  function stopTicking() {
    if (intervalId != null) clearInterval(intervalId);
    intervalId = null;
  }

  // ---- click spine ---------------------------------------------------------

  // Our own overlay/MARK input live in the page; never record interactions
  // with them as part of the audited app.
  const AUDIT_UI = '#__audit_capture_overlay__, #__audit_mark_input__';
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

  function promptMark() {
    if (!active) return;
    showMarkInput();
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

    overlay.appendChild(dot);
    overlay.appendChild(counterEl);
    overlay.appendChild(markBtn);
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
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'MARK 001 — what you see, verdict';
    input.style.cssText =
      'width:320px;font:12px system-ui,sans-serif;padding:5px 7px;border:1px solid #444;border-radius:5px;background:#111;color:#fff';
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { submitMark(input.value); close(); }
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
    mic.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) return; // graceful no-op when the browser lacks Web Speech.
      const rec = new SR();
      rec.lang = 'en-US';
      rec.interimResults = true;
      rec.onresult = (e) => {
        let t = '';
        for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
        input.value = t;
      };
      try { rec.start(); } catch (e) { /* already started / not allowed */ }
    });

    function close() { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); }
    wrap.appendChild(input);
    wrap.appendChild(mic);
    document.documentElement.appendChild(wrap);
    input.focus();
  }

  // ---- enable / disable ----------------------------------------------------

  function enable(intervalMs) {
    if (active) return;
    active = true;
    lastRoute = route();
    document.addEventListener('click', onClick, true);
    document.addEventListener('change', onChange, true);
    window.addEventListener('popstate', onNav);
    window.addEventListener('hashchange', onNav);
    startTicking(intervalMs);
    buildOverlay();
  }

  function disable() {
    active = false;
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('change', onChange, true);
    window.removeEventListener('popstate', onNav);
    window.removeEventListener('hashchange', onNav);
    stopTicking();
    removeOverlay();
  }

  // ---- worker -> content messages ------------------------------------------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg && msg.type) {
      case 'recorder:start':
        enable(msg.intervalMs);
        sendResponse({ ok: true });
        break;
      case 'recorder:stop':
        disable();
        sendResponse({ ok: true });
        break;
      case 'recorder:mark-prompt':
        promptMark();
        sendResponse({ ok: true });
        break;
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
      enable(resp.session.intervalMs);
    }
  });
})();
