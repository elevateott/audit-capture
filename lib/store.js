// lib/store.js
// IndexedDB persistence for a session. The MV3 service worker can be killed
// after ~30s idle, so NOTHING that must survive lives only in worker memory.
// Every capture path appends here; on Stop, lib/package.js reads it all back.
//
// Loaded into the service worker via importScripts() — exposes self.AuditStore.

(function () {
  'use strict';

  const DB_NAME = 'audit-capture';
  const DB_VERSION = 2;

  // Stores:
  //   frames    keyPath 'name'        { name, dataUrl, t, route, reason }
  //   timeline  autoIncrement         { t, route, type, ref }   (the keystone join)
  //   steps     autoIncrement         recorder.json step objects
  //   narration autoIncrement         { line }                  (one MARK/voice per row)
  //   console   autoIncrement         { t, route, level, message }  (level: error|warning)
  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('frames')) {
          db.createObjectStore('frames', { keyPath: 'name' });
        }
        if (!db.objectStoreNames.contains('timeline')) {
          db.createObjectStore('timeline', { autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('steps')) {
          db.createObjectStore('steps', { autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('narration')) {
          db.createObjectStore('narration', { autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('console')) {
          db.createObjectStore('console', { autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function tx(db, storeName, mode) {
    return db.transaction(storeName, mode).objectStore(storeName);
  }

  function reqToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function put(storeName, value) {
    const db = await open();
    try {
      return await reqToPromise(tx(db, storeName, 'readwrite').put(value));
    } finally {
      db.close();
    }
  }

  async function getAll(storeName) {
    const db = await open();
    try {
      return await reqToPromise(tx(db, storeName, 'readonly').getAll());
    } finally {
      db.close();
    }
  }

  async function count(storeName) {
    const db = await open();
    try {
      return await reqToPromise(tx(db, storeName, 'readonly').count());
    } finally {
      db.close();
    }
  }

  // Wipe all stores — called on session Start so each package is clean.
  async function clearAll() {
    const db = await open();
    try {
      const names = ['frames', 'timeline', 'steps', 'narration', 'console'];
      await Promise.all(
        names.map((n) => reqToPromise(tx(db, n, 'readwrite').clear()))
      );
    } finally {
      db.close();
    }
  }

  const api = { put, getAll, count, clearAll };
  if (typeof self !== 'undefined') self.AuditStore = api;
  // Test seam: no-op in the worker (no `module`), lets Node import for unit tests.
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
