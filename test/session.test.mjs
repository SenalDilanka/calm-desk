import test from 'node:test';
import assert from 'node:assert/strict';
import { pacerState, summarize, buildExport, ACCURACY, DEFAULT_SESSION_SECONDS } from '../src/renderer/lib/session.mjs';
import { validationInfo, errorInfo, startFailureInfo } from '../src/renderer/lib/validation.mjs';

const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

test('default session is two minutes', () => {
  assert.equal(DEFAULT_SESSION_SECONDS, 120);
});

test('pacer starts exhaled, peaks at the inhale/exhale boundary, wraps each cycle', () => {
  const start = pacerState(0);
  assert.equal(start.phase, 'inhale');
  approx(start.scale, 0);

  const mid = pacerState(2500);
  assert.equal(mid.phase, 'inhale');
  approx(mid.scale, 0.5);

  const top = pacerState(5000);
  assert.equal(top.phase, 'exhale');
  approx(top.scale, 1);

  const bottom = pacerState(9999.999999);
  assert.equal(bottom.phase, 'exhale');
  assert.ok(bottom.scale < 0.001);

  approx(pacerState(10000).scale, pacerState(0).scale);
  approx(pacerState(-2500).scale, pacerState(7500).scale);
});

test('pacer supports asymmetric timing', () => {
  const p = pacerState(4000, { inhaleMs: 4000, exhaleMs: 6000 });
  assert.equal(p.phase, 'exhale');
  approx(p.scale, 1);
});

function series(valueAt, { stable = true, every = 5, total = 120 } = {}) {
  const out = [];
  for (let t = 0; t < total; t += every) out.push({ t, value: valueAt(t), confidence: 70, stable });
  return out;
}

test('summary reports first-third vs last-third change beyond measurement error', () => {
  const s = summarize({
    pulse: series((t) => (t < 40 ? 80 : t >= 80 ? 72 : 76)),
    breath: series(() => 6),
    hrv: series((t) => (t < 40 ? 30 : t >= 80 ? 45 : 38)),
  }, 120);
  approx(s.pulse.first, 80);
  approx(s.pulse.last, 72);
  assert.equal(s.pulse.direction, 'lower');
  assert.equal(s.breath.direction, 'steady');
  assert.equal(s.hrv.direction, 'higher');
});

test('changes within the documented accuracy are reported as steady', () => {
  const small = ACCURACY.pulse - 0.5;
  const s = summarize({
    pulse: series((t) => (t < 40 ? 70 : t >= 80 ? 70 - small : 70)),
    breath: [], hrv: [],
  }, 120);
  assert.equal(s.pulse.direction, 'steady');
});

test('unstable readings are ignored and thin data yields no comparison', () => {
  const unstable = summarize({ pulse: series(() => 90, { stable: false }), breath: [], hrv: [] }, 120);
  assert.equal(unstable.pulse.mean, null);
  assert.equal(unstable.pulse.direction, null);
  assert.equal(unstable.pulse.totalCount > 0, true);

  const thin = summarize({
    pulse: [{ t: 1, value: 70, stable: true }, { t: 118, value: 60, stable: true }],
    breath: [], hrv: [],
  }, 120);
  assert.equal(thin.pulse.delta, null, 'needs several stable readings in both segments');
  assert.equal(thin.pulse.stableCount, 2);
});

test('export contains aggregate numbers only', () => {
  const summary = summarize({
    pulse: series(() => 71.234), breath: series(() => 6.04), hrv: series(() => 40.5),
  }, 120);
  const out = buildExport(summary, { simulated: true, now: new Date('2026-11-07T00:00:00Z') });
  assert.equal(out.simulatedSignals, true);
  assert.equal(out.createdAt, '2026-11-07T00:00:00.000Z');
  assert.equal(out.sessionSeconds, 120);
  assert.equal(out.pulseRateBpm.mean, 71.2);
  assert.deepEqual(Object.keys(out).sort(), [
    'app', 'breathingRateBrPerMin', 'createdAt', 'hrvRmssdMs', 'notes',
    'pulseRateBpm', 'schema', 'sessionSeconds', 'simulatedSignals',
  ]);
  const text = JSON.stringify(out).toLowerCase();
  for (const banned of ['trace', 'wave', 'expression', 'frame', 'video', 'image']) {
    // "notes" mentions these words in a negation, so check keys only.
    assert.ok(!Object.keys(out).some((k) => k.toLowerCase().includes(banned)), `key mentions ${banned}`);
  }
  assert.ok(text.includes('not a medical'));
});

test('validation guidance covers the common cases and falls back gracefully', () => {
  assert.equal(validationInfo(0).ok, true);
  assert.equal(validationInfo(1).ok, false);
  assert.match(validationInfo(5).text, /dark/i);
  assert.equal(validationInfo(99, 'Custom hint').text, 'Custom hint');
  assert.equal(validationInfo(99).text, 'Getting ready…');
});

test('error mapping: auth and credit errors are not retryable', () => {
  assert.equal(errorInfo(2).retryable, false);
  assert.equal(errorInfo(4).retryable, false);
  assert.equal(errorInfo(5).retryable, true);
  assert.match(errorInfo(2).text, /API key/);
  assert.equal(errorInfo(123, 'boom').text, 'boom');
});

test('camera start failures give actionable guidance', () => {
  assert.match(startFailureInfo({ name: 'NotAllowedError' }).text, /blocked/i);
  assert.match(startFailureInfo({ name: 'NotFoundError' }).text, /No camera/i);
  assert.match(startFailureInfo({ name: 'NotReadableError' }).text, /busy/i);
  assert.equal(startFailureInfo({ code: 2, message: 'x' }).retryable, false);
});
