// Calm Desk renderer: consent -> setup -> guided session -> summary.
//
// Import rule: only '@smartspectra/node-sdk/renderer' and '/messages' belong in
// the renderer. The package root pulls in the native FFI layer and must never be
// imported here.

import {
  SmartSpectraSDK,
  breathingMetrics,
  cardioMetrics,
  faceMetrics,
  ProcessingStatus,
} from '@smartspectra/node-sdk/renderer';
import { decodeMetrics } from '@smartspectra/node-sdk/messages';

import { MetricsTracker, normalizedLast } from './lib/metrics.mjs';
import { pacerState, summarize, buildExport } from './lib/session.mjs';
import { validationInfo, errorInfo, startFailureInfo } from './lib/validation.mjs';
import { SimulatedSmartSpectra } from './lib/simulator.mjs';

// The breathing-movement trace is unitless and its sign convention isn't
// documented, so the glow shows "how far through your own recent range" the
// newest sample is. If a live test shows the glow moving opposite to your
// chest, flip this to -1.
const TRACE_POLARITY = 1;

const INHALE_MS = 5000;
const EXHALE_MS = 5000;

const $ = (id) => document.getElementById(id);

const state = {
  config: null,
  sdk: null,
  tracker: null,
  wantExpression: false,
  processing: null,
  validation: { ok: false, text: '' },
  screen: 'consent',
  sessionStart: 0,
  sessionMs: 120000,
  ended: false,
  raf: 0,
  endTimer: 0,
  lastTileUpdate: 0,
  glow: 0.5,
  summary: null,
  retry: null,
  halted: false,
};

/* ---------- small UI helpers ---------- */

function showScreen(name) {
  state.screen = name;
  for (const el of document.querySelectorAll('.screen')) el.hidden = el.id !== `screen-${name}`;
}

function setCameraPill(on) {
  $('pill-camera').dataset.on = String(on);
  $('pill-camera-text').textContent = on ? 'Camera on' : 'Camera off';
}

function showBanner(text, retry = null) {
  $('banner-text').textContent = text;
  state.retry = retry;
  $('banner-retry').hidden = !retry;
  $('banner').hidden = false;
}

function hideBanner() {
  $('banner').hidden = true;
  state.retry = null;
}

function fmtClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function updateConsentGate() {
  const configured = state.config && (state.config.simulate || state.config.hasKey);
  $('btn-start-camera').disabled = !($('opt-consent').checked && configured);
}

/* ---------- SDK lifecycle ---------- */

function createSdk() {
  // Ask the SDK only for the signal groups the app actually shows.
  const requestedMetrics = [...breathingMetrics, ...cardioMetrics, ...(state.wantExpression ? faceMetrics : [])];
  const options = {
    apiKey: state.config.apiKey,
    requestedMetrics,
    enableTelemetry: state.config.telemetry,
  };
  return state.config.simulate ? new SimulatedSmartSpectra(options) : new SmartSpectraSDK(options);
}

function updateBeginButton() {
  const ready = state.processing === ProcessingStatus.kRunning && state.validation.ok;
  $('btn-begin').disabled = !ready;
}

function wireSdk(sdk) {
  sdk.on('streamAvailable', (stream) => {
    const video = $('preview');
    video.srcObject = stream;
    video.play().catch(() => {});
  });

  sdk.on('processingStatus', (status) => {
    state.processing = status;
    updateBeginButton();
  });

  sdk.on('validationStatus', (code, _ts, hint) => {
    state.validation = validationInfo(code, hint);
    if (state.screen === 'setup') $('setup-hint').textContent = state.validation.text;
    if (state.screen === 'session') {
      const el = $('session-hint');
      el.hidden = state.validation.ok;
      el.textContent = state.validation.ok ? '' : state.validation.text;
    }
    updateBeginButton();
  });

  sdk.on('metrics', (buf) => {
    try {
      state.tracker.ingest(decodeMetrics(buf));
    } catch (err) {
      console.warn('Could not decode a metrics packet:', err);
    }
  });

  sdk.on('error', (code, message, retryable) => {
    const info = errorInfo(code, message);
    const canRetry = info.retryable && retryable !== false;
    handleSdkError(info.text, canRetry);
  });
}

/**
 * A consent-first app must not leave the camera running once it has failed, so
 * every SDK error turns the camera off straight away. The SDK can emit several
 * error events for one failure; only the first one is acted on.
 */
async function handleSdkError(text, canRetry) {
  if (state.halted) return;
  state.halted = true;

  if (state.screen === 'session') {
    await endSession(); // camera off, shows whatever was gathered so far
    showBanner(text);
    return;
  }

  if (!canRetry) {
    await teardown();
    showScreen('consent');
    showBanner(text);
    return;
  }

  // Retryable: stay on the setup screen, camera off, with a Try again button.
  const sdk = state.sdk;
  if (sdk) {
    try { await sdk.stop(); } catch { /* already stopped */ }
  }
  $('preview').srcObject = null;
  setCameraPill(false);
  $('btn-begin').disabled = true;
  $('setup-hint').textContent = 'Camera stopped. Try again when you are ready.';
  showBanner(text, retrySdk);
}

async function retrySdk() {
  hideBanner();
  try {
    await state.sdk.reset();
    state.halted = false;
    state.validation = { ok: false, text: 'Starting camera…' };
    $('setup-hint').textContent = 'Starting camera…';
    await state.sdk.start();
    setCameraPill(!state.config.simulate);
  } catch (err) {
    state.halted = true;
    const info = startFailureInfo(err);
    showBanner(info.text, info.retryable ? retrySdk : null);
  }
}

async function startCamera() {
  hideBanner();
  state.halted = false;
  state.wantExpression = $('opt-expression').checked;
  state.tracker = new MetricsTracker();
  state.processing = null;
  state.validation = { ok: false, text: 'Starting camera…' };

  const sdk = createSdk();
  state.sdk = sdk;
  wireSdk(sdk);

  $('setup-hint').textContent = 'Starting camera…';
  $('btn-begin').disabled = true;
  const minutes = state.sessionMs / 60000;
  $('btn-begin').textContent = Number.isInteger(minutes)
    ? `Begin ${minutes}-minute session`
    : `Begin ${fmtClock(state.sessionMs)} session`;
  $('preview').hidden = state.config.simulate;
  $('preview-sim').hidden = !state.config.simulate;
  $('tile-expression').hidden = !state.wantExpression;
  showScreen('setup');

  try {
    await sdk.start();
    setCameraPill(!state.config.simulate);
  } catch (err) {
    teardown();
    showScreen('consent');
    const info = startFailureInfo(err);
    showBanner(info.text);
  }
}

/** Stops the camera and releases the SDK. Safe to call more than once. */
async function teardown() {
  cancelAnimationFrame(state.raf);
  clearInterval(state.endTimer);
  const sdk = state.sdk;
  state.sdk = null;
  state.processing = null;
  if (sdk) {
    try { await sdk.stop(); } catch { /* already stopped */ }
    try { sdk.destroy(); } catch { /* already destroyed */ }
  }
  const video = $('preview');
  video.srcObject = null;
  setCameraPill(false);
}

/* ---------- session ---------- */

function beginSession() {
  state.ended = false;
  state.glow = 0.5;
  state.tracker.startRecording();
  state.sessionStart = performance.now();
  state.lastTileUpdate = 0;
  $('session-hint').hidden = true;
  showScreen('session');
  state.endTimer = setInterval(checkEnd, 500);
  state.raf = requestAnimationFrame(frame);
}

function checkEnd() {
  if (state.ended) return;
  if (performance.now() - state.sessionStart >= state.sessionMs) endSession();
}

async function endSession() {
  if (state.ended) return;
  state.ended = true;
  cancelAnimationFrame(state.raf);
  clearInterval(state.endTimer);

  const elapsedSec = Math.min((performance.now() - state.sessionStart) / 1000, state.sessionMs / 1000);
  state.tracker.stopRecording();
  state.summary = summarize(state.tracker.history, elapsedSec);

  await teardown(); // camera off before we show anything
  renderSummary(state.summary);
  showScreen('summary');
}

function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h, dpr };
}

function drawPacer(pacer, glow) {
  const canvas = $('pacer');
  const { ctx, w, h } = fitCanvas(canvas);
  const cx = w / 2;
  const cy = h / 2;
  const maxR = Math.min(w, h) / 2 - 14;
  const minR = maxR * 0.5;
  const radius = (n) => minR + (maxR - minR) * n;

  // Track
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.beginPath();
  ctx.arc(cx, cy, maxR, 0, Math.PI * 2);
  ctx.stroke();

  // Your own breathing movement (warm glow)
  ctx.save();
  ctx.shadowColor = 'rgba(255, 212, 154, 0.85)';
  ctx.shadowBlur = maxR * 0.18;
  ctx.strokeStyle = 'rgba(255, 212, 154, 0.8)';
  ctx.lineWidth = maxR * 0.045;
  ctx.beginPath();
  ctx.arc(cx, cy, radius(glow), 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  // Guide ring
  const gr = radius(pacer.scale);
  const fill = ctx.createRadialGradient(cx, cy, gr * 0.1, cx, cy, gr);
  fill.addColorStop(0, 'rgba(95,212,196,0.05)');
  fill.addColorStop(1, 'rgba(95,212,196,0.22)');
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(cx, cy, gr, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#5fd4c4';
  ctx.lineWidth = maxR * 0.02;
  ctx.stroke();
}

function drawTrace(canvasId, values, color) {
  const { ctx, w, h, dpr } = fitCanvas($(canvasId));
  const points = values.slice(-200);
  if (points.length < 2) return;
  let min = Infinity;
  let max = -Infinity;
  for (const v of points) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min > 1e-9 ? max - min : 1;
  const pad = 8 * dpr;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2 * dpr;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  points.forEach((v, i) => {
    const x = (i / (points.length - 1)) * w;
    const y = h - pad - ((v - min) / range) * (h - 2 * pad);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function setTile(tileId, valueId, subId, reading, { digits = 0, waiting }) {
  const tile = $(tileId);
  if (!reading) {
    $(valueId).textContent = '--';
    $(subId).textContent = waiting;
    tile.classList.add('dim');
    return;
  }
  $(valueId).textContent = reading.value.toFixed(digits);
  tile.classList.toggle('dim', !reading.stable);
  $(subId).textContent = reading.stable
    ? reading.confidence === null ? 'Steady' : `Steady · confidence ${Math.round(reading.confidence)}%`
    : 'Settling…';
}

function updateTiles() {
  const { latest } = state.tracker;
  setTile('tile-pulse', 'v-pulse', 's-pulse', latest.pulse, { waiting: 'Waiting for signal…' });
  setTile('tile-breath', 'v-breath', 's-breath', latest.breath, { digits: 1, waiting: 'Waiting for signal…' });
  setTile('tile-hrv', 'v-hrv', 's-hrv', latest.hrv, { waiting: 'Needs about a minute…' });
  if (state.wantExpression) {
    const e = latest.expression;
    $('v-expression').textContent = e ? e.top.label : '--';
    $('s-expression').textContent = e ? `${Math.round(e.top.confidence)}%${e.stable ? '' : ' · settling'}` : 'Waiting for signal…';
    $('tile-expression').classList.toggle('dim', !e || !e.stable);
  }
}

function frame(now) {
  if (state.ended) return;
  const elapsed = now - state.sessionStart;
  const pacer = pacerState(elapsed, { inhaleMs: INHALE_MS, exhaleMs: EXHALE_MS });

  const raw = normalizedLast(state.tracker.breathTrace);
  const target = TRACE_POLARITY === 1 ? raw : 1 - raw;
  state.glow += (target - state.glow) * 0.12; // ease so the glow doesn't flicker

  $('pacer-phase').textContent = pacer.phase === 'inhale' ? 'Breathe in' : 'Breathe out';
  $('pacer-time').textContent = fmtClock(state.sessionMs - elapsed);
  drawPacer(pacer, state.glow);
  drawTrace('chart-breath', state.tracker.breathTrace.values, '#ffd49a');
  drawTrace('chart-pulse', state.tracker.pulseWave.values, '#5fd4c4');

  if (now - state.lastTileUpdate > 250) {
    state.lastTileUpdate = now;
    updateTiles();
  }
  state.raf = requestAnimationFrame(frame);
}

/* ---------- summary ---------- */

function describeChange(s, unit, digits = 0) {
  if (s.direction === null) return 'Not enough steady readings to compare the start and end.';
  if (s.direction === 'steady') return 'About the same from start to end.';
  const amount = Math.abs(s.delta).toFixed(digits);
  return `${s.direction === 'lower' ? 'Lower' : 'Higher'} by about ${amount} ${unit} toward the end.`;
}

function summaryCard(title, s, unit, digits, changeUnit) {
  const card = document.createElement('div');
  card.className = 'sum-card';
  const label = document.createElement('div');
  label.className = 'tile-label';
  label.textContent = title;
  const value = document.createElement('div');
  value.className = 'tile-value';
  const num = document.createElement('span');
  num.textContent = s.mean === null ? '--' : s.mean.toFixed(digits);
  const u = document.createElement('span');
  u.className = 'unit';
  u.textContent = s.mean === null ? '' : unit;
  value.append(num, u);
  const note = document.createElement('p');
  note.textContent = s.mean === null ? 'Not enough steady readings this time.' : describeChange(s, changeUnit, digits);
  card.append(label, value, note);
  return card;
}

function renderSummary(summary) {
  const secs = Math.round(summary.durationSec);
  const any = summary.pulse.mean !== null || summary.breath.mean !== null || summary.hrv.mean !== null;
  $('summary-lede').textContent = any
    ? `You followed the guide for ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}. Averages below use only steady readings.${state.config.simulate ? ' These are simulated numbers.' : ''}`
    : "We didn't get enough steady readings this time. Soft light on your face and sitting still usually help.";

  const grid = $('summary-grid');
  grid.replaceChildren(
    summaryCard('Pulse', summary.pulse, 'bpm', 0, 'bpm'),
    summaryCard('Breathing', summary.breath, 'per min', 1, 'breaths/min'),
    summaryCard('HRV (RMSSD)', summary.hrv, 'ms', 0, 'ms'),
  );
  $('save-status').textContent = '';
}

async function saveSummary() {
  if (!state.summary) return;
  const payload = buildExport(state.summary, { simulated: state.config.simulate });
  try {
    const result = await window.calmDesk.saveSummary(JSON.stringify(payload, null, 2));
    $('save-status').textContent = result.saved ? `Saved to ${result.path}` : 'Not saved.';
  } catch (err) {
    $('save-status').textContent = 'Could not save the file.';
    console.warn(err);
  }
}

function finish() {
  if (state.tracker) state.tracker.clearAll();
  state.tracker = null;
  state.summary = null;
  $('summary-grid').replaceChildren();
  $('summary-lede').textContent = '';
  $('save-status').textContent = '';
  $('opt-consent').checked = false;
  $('opt-expression').checked = false;
  updateConsentGate();
  hideBanner();
  showScreen('consent');
}

/* ---------- boot ---------- */

async function init() {
  state.config = await window.calmDesk.getConfig();
  state.sessionMs = state.config.sessionSeconds * 1000;

  $('pill-sim').hidden = !state.config.simulate;
  $('telemetry-note').textContent = state.config.telemetry
    ? 'SDK usage telemetry: on (you opted in via SMARTSPECTRA_TELEMETRY=1).'
    : 'SDK usage telemetry: off. Calm Desk keeps it disabled unless you opt in.';

  if (!state.config.simulate && !state.config.hasKey) {
    $('config-note').textContent =
      'No API key found. Add SMARTSPECTRA_API_KEY to a .env file (see .env.example), or run with --simulate to explore the app with synthetic signals.';
  } else if (state.config.simulate) {
    $('config-note').textContent = 'Simulation mode: no camera is used and the numbers are synthetic.';
  }

  $('opt-consent').addEventListener('change', updateConsentGate);
  $('btn-start-camera').addEventListener('click', startCamera);
  $('btn-begin').addEventListener('click', beginSession);
  $('btn-stop-setup').addEventListener('click', async () => {
    await teardown();
    showScreen('consent');
  });
  $('btn-end').addEventListener('click', endSession);
  $('btn-save').addEventListener('click', saveSummary);
  $('btn-finish').addEventListener('click', finish);
  $('banner-close').addEventListener('click', hideBanner);
  $('banner-retry').addEventListener('click', () => {
    const fn = state.retry;
    if (fn) fn();
  });

  // Never leave the camera running if the window goes away.
  window.addEventListener('pagehide', () => {
    if (state.sdk) {
      try { state.sdk.destroy(); } catch { /* ignore */ }
    }
  });

  updateConsentGate();
  showScreen('consent');
}

init().catch((err) => {
  console.error('Calm Desk failed to initialise:', err);
  showBanner('Something went wrong starting the app. Check the console for details.');
});
