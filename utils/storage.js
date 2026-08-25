/**
 * storage.js
 * Small wrapper around chrome.storage.local for persisting per-site column
 * configurations. Shared between the popup and the content script, so it is
 * written as a plain script that attaches a single global (WSStorage)
 * instead of using ES modules.
 *
 * Data shape stored under key `ws_state::<hostname>`:
 * {
 *   containerSelector: string|null, // CSS selector matching each repeating
 *                                    // "card"/"row" on the page, or null if
 *                                    // the page only has a single record.
 *   columns: [
 *     {
 *       id: string,               // stable id, e.g. "col_1699999999999_ab12"
 *       name: string,             // user-facing column name
 *       relativeSelector: string, // selector resolved from the container
 *                                 // (or from the document when
 *                                 // containerSelector is null)
 *       attribute: 'text'|'href'|'src'
 *     }
 *   ]
 * }
 */
(function (root) {
  'use strict';

  function keyForHostname(hostname) {
    return 'ws_state::' + hostname;
  }

  function emptyState() {
    return { containerSelector: null, columns: [] };
  }

  function getState(hostname) {
    var key = keyForHostname(hostname);
    return new Promise(function (resolve) {
      chrome.storage.local.get([key], function (result) {
        var state = result && result[key];
        if (!state || typeof state !== 'object') {
          resolve(emptyState());
          return;
        }
        if (!Array.isArray(state.columns)) state.columns = [];
        if (typeof state.containerSelector !== 'string') state.containerSelector = null;
        resolve(state);
      });
    });
  }

  function setState(hostname, state) {
    var key = keyForHostname(hostname);
    var data = {};
    data[key] = state;
    return new Promise(function (resolve) {
      chrome.storage.local.set(data, function () {
        resolve();
      });
    });
  }

  function clearState(hostname) {
    var key = keyForHostname(hostname);
    return new Promise(function (resolve) {
      chrome.storage.local.remove([key], function () {
        resolve();
      });
    });
  }

  function makeColumnId() {
    return 'col_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }

  root.WSStorage = {
    getState: getState,
    setState: setState,
    clearState: clearState,
    emptyState: emptyState,
    makeColumnId: makeColumnId
  };
})(typeof window !== 'undefined' ? window : globalThis);
