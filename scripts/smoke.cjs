'use strict';

// End-to-end smoke test: starts the real app (simulation mode) in a hidden
// window, drives the UI through consent -> setup -> session -> summary -> save ->
// finish, takes screenshots, and checks what happened on screen and on disk.
//
//   xvfb-run -a electron scripts/smoke.cjs --no-sandbox --simulate --session-seconds=30 --out=/some/dir
//
// (`npm run smoke` does this with defaults.)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, dialog } = require('electron');
const { start } = require('../src/app.js');

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const outDir = arg('out', fs.mkdtempSync(path.join(os.tmpdir(), 'calm-desk-smoke-')));
fs.mkdirSync(outDir, { recursive: true });
const savePath = path.join(outDir, 'saved-summary.json');

// Replace the native save dialog (it would block a headless run).
let dialogCalls = 0;
dialog.showSaveDialog = async () => {
  dialogCalls += 1;
  return { canceled: false, filePath: savePath };
};

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // The window must be shown (Xvfb provides a virtual display): a hidden window
  // paints lazily, so screenshots of it can lag behind the DOM.
  const { win, config } = await start({ show: true });
  const wc = win.webContents;
  const consoleLines = [];
  // Electron passes either a details object (newer) or (event, level, message, ...) (legacy).
  wc.on('console-message', (...args) => {
    const first = args[0];
    const e = first && typeof first.message === 'string' ? first : { level: args[1], message: args[2] };
    consoleLines.push(`[${e.level}] ${e.message}`);
  });

  const js = (code) => wc.executeJavaScript(code, true);
  const waitFor = async (code, label, timeoutMs = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (await js(code)) return true;
      await sleep(150);
    }
    throw new Error(`Timed out waiting for: ${label}`);
  };
  const shot = async (name) => {
    await sleep(500); // let the compositor paint the new screen before capturing
    const img = await wc.capturePage();
    fs.writeFileSync(path.join(outDir, name), img.toPNG());
  };
  const visible = (id) => `!document.getElementById('${id}').hidden`;

  await new Promise((resolve) => wc.once('did-finish-load', resolve));

  // 1. Consent gate
  await waitFor(visible('screen-consent'), 'consent screen');
  check('starts on the consent screen with the camera off',
    (await js("document.getElementById('pill-camera').dataset.on")) === 'false');
  check('simulation banner is shown', await js(visible('pill-sim')));
  check('start button is disabled until consent is ticked',
    await js("document.getElementById('btn-start-camera').disabled"));
  check('telemetry is reported as off by default',
    /telemetry: off/i.test(await js("document.getElementById('telemetry-note').textContent")));
  await shot('1-consent.png');

  await js("(() => { const c = document.getElementById('opt-consent'); c.checked = true; c.dispatchEvent(new Event('change')); })()");
  check('start button enables after consent',
    !(await js("document.getElementById('btn-start-camera').disabled")));
  await js("document.getElementById('opt-expression').checked = true");

  // 2. Setup
  await js("document.getElementById('btn-start-camera').click()");
  await waitFor(visible('screen-setup'), 'setup screen');
  await waitFor("!document.getElementById('btn-begin').disabled", 'begin button to enable', 15000);
  check('setup shows friendly guidance once validation passes',
    /looking good/i.test(await js("document.getElementById('setup-hint').textContent")));
  check('begin button label reflects session length',
    /Begin 0:\d\d session|Begin \d+-minute session/.test(await js("document.getElementById('btn-begin').textContent")));
  await shot('2-setup.png');

  // 3. Session
  await js("document.getElementById('btn-begin').click()");
  await waitFor(visible('screen-session'), 'session screen');
  check('expression tile is visible because it was opted into', await js(visible('tile-expression')));
  const midMs = Math.max(8000, Math.min(14000, config.sessionSeconds * 500));
  await sleep(midMs);
  const tiles = await js(`({
    pulse: document.getElementById('v-pulse').textContent,
    breath: document.getElementById('v-breath').textContent,
    hrv: document.getElementById('v-hrv').textContent,
    expr: document.getElementById('v-expression').textContent,
    phase: document.getElementById('pacer-phase').textContent,
    time: document.getElementById('pacer-time').textContent,
  })`);
  check('live pulse value reached the UI', /^\d+$/.test(tiles.pulse), JSON.stringify(tiles));
  check('live breathing rate reached the UI', /^\d+\.\d$/.test(tiles.breath));
  check('expression reached the UI', /^[A-Z][a-z]+$/.test(tiles.expr), tiles.expr);
  check('pacer text is running', /Breathe (in|out)/.test(tiles.phase) && /^\d+:\d\d$/.test(tiles.time));
  await shot('3-session.png');

  // 4. Summary (session ends on its own)
  await waitFor(visible('screen-summary'), 'summary screen', (config.sessionSeconds + 15) * 1000);
  check('camera indicator is off on the summary screen',
    (await js("document.getElementById('pill-camera').dataset.on")) === 'false');
  const cards = await js("document.querySelectorAll('#summary-grid .sum-card').length");
  check('summary shows three signal cards', cards === 3);
  await shot('4-summary.png');
  check('nothing has been written before the person chooses Save',
    !fs.existsSync(savePath) && dialogCalls === 0);

  // 5. Save (explicit) and verify the file holds aggregates only
  await js("document.getElementById('btn-save').click()");
  await waitFor(`document.getElementById('save-status').textContent.startsWith('Saved')`, 'save confirmation', 5000);
  const saved = JSON.parse(fs.readFileSync(savePath, 'utf8'));
  check('saved file is aggregate-only and marked simulated',
    saved.simulatedSignals === true && !('trace' in saved) && typeof saved.pulseRateBpm === 'object',
    Object.keys(saved).join(','));
  check('saved file carries the not-medical note', saved.notes.some((n) => /not a medical/i.test(n)));

  // 6. Finish discards and returns to a clean consent screen
  await js("document.getElementById('btn-finish').click()");
  await waitFor(visible('screen-consent'), 'return to consent');
  check('finish clears the summary and un-ticks consent',
    (await js("document.getElementById('summary-grid').children.length")) === 0
    && !(await js("document.getElementById('opt-consent').checked")));
  await shot('5-after-finish.png');

  const problems = consoleLines.filter((l) => /^\[(2|error)\]/i.test(l) || /Refused|violat|Uncaught/i.test(l));
  check('no console errors or CSP violations', problems.length === 0, problems.slice(0, 3).join(' | '));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed. Output: ${outDir}`);
  fs.writeFileSync(path.join(outDir, 'smoke-results.json'), JSON.stringify({ results, consoleLines }, null, 2));
  app.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('SMOKE ERROR:', err);
  app.exit(2);
});
