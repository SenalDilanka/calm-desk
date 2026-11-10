'use strict';

// Exercises the REAL SmartSpectra integration (no simulator) as far as is
// possible without a valid API key or a real face:
//   native runtime loads in the main process -> sandboxed preload bridge ->
//   renderer SDK opens a (Chromium fake) camera -> blob Web Worker (CSP) ->
//   frames reach the main-process SDK -> SDK contacts Presage to authorize.
// With a dummy key the expected end state is a friendly authorization error.
//
//   SMARTSPECTRA_API_KEY=dummy xvfb-run -a electron scripts/smoke-real.cjs \
//     --no-sandbox --disable-gpu --use-fake-device-for-media-stream --out=/some/dir
//
// This reports observations rather than a strict pass/fail for the final step,
// because the outcome depends on network policy and on Presage's service.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');
const { start } = require('../src/app.js');

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const outDir = arg('out', fs.mkdtempSync(path.join(os.tmpdir(), 'calm-desk-real-')));
fs.mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { win, config } = await start({ show: true });
  if (config.simulate) throw new Error('Run this without --simulate');
  if (!config.apiKey) throw new Error('Set SMARTSPECTRA_API_KEY (a dummy value is fine)');

  const wc = win.webContents;
  const consoleLines = [];
  wc.on('console-message', (...args) => {
    const first = args[0];
    const e = first && typeof first.message === 'string' ? first : { level: args[1], message: args[2] };
    consoleLines.push(`[${e.level}] ${e.message}`);
  });
  const js = (code) => wc.executeJavaScript(code, true);
  const shot = async (name) => {
    await sleep(500);
    fs.writeFileSync(path.join(outDir, name), (await wc.capturePage()).toPNG());
  };

  await new Promise((resolve) => wc.once('did-finish-load', resolve));
  await sleep(500);

  const observations = {};
  observations.bridgeExposed = await js("typeof window.calmDesk === 'object' && typeof window.calmDesk.getConfig === 'function'");
  observations.sdkPreloadBridgeExposed = await js(
    "Object.keys(window).filter((k) => /smartspectra/i.test(k)).join(',') || '(none found by name)'",
  );

  await js("(() => { const c = document.getElementById('opt-consent'); c.checked = true; c.dispatchEvent(new Event('change')); })()");
  observations.startEnabledAfterConsent = !(await js("document.getElementById('btn-start-camera').disabled"));
  await js("document.getElementById('btn-start-camera').click()");

  // Wait for a settled outcome: an error banner, or the begin button enabling.
  const t0 = Date.now();
  let outcome = 'timeout';
  while (Date.now() - t0 < 45000) {
    const snap = await js(`({
      banner: !document.getElementById('banner').hidden ? document.getElementById('banner-text').textContent : '',
      beginEnabled: !document.getElementById('btn-begin').disabled,
      screen: [...document.querySelectorAll('.screen')].find((s) => !s.hidden)?.id,
      hint: document.getElementById('setup-hint').textContent,
    })`);
    observations.last = snap;
    if (snap.banner) { outcome = 'error-banner'; break; }
    if (snap.beginEnabled) { outcome = 'ready'; break; }
    await sleep(300);
  }
  observations.outcome = outcome;
  observations.secondsToOutcome = Math.round((Date.now() - t0) / 100) / 10;
  observations.previewVideoSizeAtOutcome = await js("document.getElementById('preview').videoWidth + 'x' + document.getElementById('preview').videoHeight");

  // Give the app a moment to react to an error, then confirm the camera is really off.
  await sleep(3000);
  observations.afterError = await js(`({
    cameraPill: document.getElementById('pill-camera').dataset.on,
    previewHasStream: !!document.getElementById('preview').srcObject,
    retryButtonVisible: !document.getElementById('banner-retry').hidden,
    screen: [...document.querySelectorAll('.screen')].find((s) => !s.hidden)?.id,
    hint: document.getElementById('setup-hint').textContent,
  })`);
  await shot('real-outcome.png');

  observations.cspViolations = consoleLines.filter((l) => /Content Security Policy|Refused to/i.test(l));
  observations.consoleErrors = consoleLines.filter((l) => /^\[(2|error)\]/i.test(l)).slice(0, 8);

  console.log(JSON.stringify(observations, null, 2));
  fs.writeFileSync(path.join(outDir, 'real-observations.json'), JSON.stringify({ observations, consoleLines }, null, 2));
  app.exit(0);
}

main().catch((err) => {
  console.error('SMOKE-REAL ERROR:', err);
  app.exit(2);
});
