'use strict';

// Bundled by scripts/build.mjs into dist/preload.js so it can run with
// `sandbox: true` (a sandboxed preload may only require 'electron' and a few
// built-ins, so the SDK's preload bridge is inlined rather than resolved from
// node_modules at runtime).

const { contextBridge, ipcRenderer } = require('electron');

// SmartSpectra bridge: hands the renderer-side SDK its MessagePort to the main process.
require('@smartspectra/node-sdk/preload');

contextBridge.exposeInMainWorld('calmDesk', {
  getConfig: () => ipcRenderer.invoke('calmdesk:get-config'),
  saveSummary: (json) => ipcRenderer.invoke('calmdesk:save-summary', json),
});
