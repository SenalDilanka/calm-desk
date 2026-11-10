'use strict';

// Main-process application logic for Calm Desk. Kept separate from main.js so
// scripts/smoke.cjs can start the very same app in a test harness.

const { app, BrowserWindow, ipcMain, dialog, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const MAX_SUMMARY_BYTES = 64 * 1024;

/** Minimal KEY=VALUE parser so we don't need a dotenv dependency. */
function parseEnvFile(file) {
  const out = {};
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function loadConfig(argv = process.argv) {
  const fileEnv = parseEnvFile(path.join(ROOT, '.env'));
  const get = (key) => (process.env[key] !== undefined ? process.env[key] : fileEnv[key] || '');

  const secArg = argv.find((a) => a.startsWith('--session-seconds='));
  let sessionSeconds = secArg ? Number(secArg.split('=')[1]) : 120;
  if (!Number.isFinite(sessionSeconds)) sessionSeconds = 120;
  sessionSeconds = Math.min(600, Math.max(10, Math.round(sessionSeconds)));

  return {
    apiKey: get('SMARTSPECTRA_API_KEY').trim(),
    simulate: argv.includes('--simulate'),
    // Calm Desk keeps optional SDK telemetry off unless the person opts in.
    telemetry: get('SMARTSPECTRA_TELEMETRY').trim() === '1',
    sessionSeconds,
  };
}

function isOwnPage(url) {
  return typeof url === 'string' && url.startsWith('file://');
}

/** Camera (video only) for our own bundled page. Everything else is denied. */
function registerPermissions() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const url = (details && details.requestingUrl) || (webContents && webContents.getURL()) || '';
    const types = (details && details.mediaTypes) || [];
    const videoOnly = types.length > 0 && types.every((t) => t === 'video');
    callback(permission === 'media' && videoOnly && isOwnPage(url));
  });
  ses.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    return permission === 'media' && isOwnPage(requestingOrigin || (webContents && webContents.getURL()));
  });
}

let ipcRegistered = false;

function registerIpc(getWindow, config) {
  if (ipcRegistered) return;
  ipcRegistered = true;

  const assertSender = (event) => {
    const win = getWindow();
    if (!win || event.sender !== win.webContents) throw new Error('Untrusted IPC sender');
    return win;
  };

  ipcMain.handle('calmdesk:get-config', (event) => {
    assertSender(event);
    return {
      hasKey: Boolean(config.apiKey),
      // The key is only handed to our own bundled page, never to remote content.
      apiKey: config.simulate ? '' : config.apiKey,
      simulate: config.simulate,
      telemetry: config.telemetry,
      sessionSeconds: config.sessionSeconds,
    };
  });

  // The only code path that writes anything to disk, and only after the person
  // picks a location in a native save dialog.
  ipcMain.handle('calmdesk:save-summary', async (event, json) => {
    const win = assertSender(event);
    if (typeof json !== 'string' || json.length > MAX_SUMMARY_BYTES) throw new Error('Invalid summary');
    JSON.parse(json); // must be valid JSON

    const stamp = new Date().toISOString().slice(0, 10);
    const result = await dialog.showSaveDialog(win, {
      title: 'Save session summary',
      defaultPath: `calm-desk-summary-${stamp}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { saved: false };
    await fs.promises.writeFile(result.filePath, json, 'utf8');
    return { saved: true, path: result.filePath };
  });
}

function createWindow(config, { show = true } = {}) {
  const win = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 880,
    minHeight: 640,
    show,
    title: 'Calm Desk',
    backgroundColor: '#0b1a22',
    webPreferences: {
      preload: path.join(DIST, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  if (!config.simulate) {
    // Lazy so that --simulate also works on platforms the native runtime doesn't cover.
    const { bindSmartSpectraIpc } = require('@smartspectra/node-sdk/main');
    bindSmartSpectraIpc(win);
  }

  win.loadFile(path.join(DIST, 'index.html'));
  return win;
}

async function start({ show = true } = {}) {
  await app.whenReady();
  const config = loadConfig();
  registerPermissions();

  let win = null;
  registerIpc(() => win, config);
  win = createWindow(config, { show });

  app.on('window-all-closed', () => app.quit());
  return { win, config };
}

module.exports = { start, loadConfig, parseEnvFile };
