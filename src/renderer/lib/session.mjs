// Pure helpers for the guided session: the breathing pacer and the end-of-session
// summary. No DOM, no SDK.

export const DEFAULT_SESSION_SECONDS = 120;

// Minimum change we are willing to call a "change". These are the accuracy
// bounds the SDK documents for a reading to count as stable (heart rate +/-3 bpm,
// breathing rate +/-1 br/min, HRV +/-5 ms), so differences smaller than the
// measurement error are reported as "about the same".
export const ACCURACY = Object.freeze({ pulse: 3, breath: 1, hrv: 5 });

export const MIN_POINTS_PER_SEGMENT = 3;

/**
 * Pacer position for a simple inhale/exhale loop.
 * `scale` is eased 0..1 (0 = fully exhaled, 1 = fully inhaled).
 */
export function pacerState(elapsedMs, { inhaleMs = 5000, exhaleMs = 5000 } = {}) {
  const cycle = inhaleMs + exhaleMs;
  const t = ((elapsedMs % cycle) + cycle) % cycle;
  if (t < inhaleMs) {
    const progress = t / inhaleMs;
    return { phase: 'inhale', progress, scale: 0.5 - 0.5 * Math.cos(Math.PI * progress) };
  }
  const progress = (t - inhaleMs) / exhaleMs;
  return { phase: 'exhale', progress, scale: 0.5 + 0.5 * Math.cos(Math.PI * progress) };
}

function mean(list) {
  if (!list.length) return null;
  let sum = 0;
  for (const x of list) sum += x;
  return sum / list.length;
}

function summarizeSignal(points, totalSec, accuracy) {
  const stable = points.filter((p) => p.stable && Number.isFinite(p.value));
  const first = stable.filter((p) => p.t < totalSec / 3).map((p) => p.value);
  const last = stable.filter((p) => p.t >= (2 * totalSec) / 3).map((p) => p.value);
  const out = {
    mean: mean(stable.map((p) => p.value)),
    stableCount: stable.length,
    totalCount: points.length,
    first: null,
    last: null,
    delta: null,
    direction: null,
  };
  if (first.length >= MIN_POINTS_PER_SEGMENT && last.length >= MIN_POINTS_PER_SEGMENT) {
    out.first = mean(first);
    out.last = mean(last);
    out.delta = out.last - out.first;
    out.direction = Math.abs(out.delta) <= accuracy ? 'steady' : out.delta < 0 ? 'lower' : 'higher';
  }
  return out;
}

/**
 * @param {{pulse: object[], breath: object[], hrv: object[]}} history
 *        entries are {t (seconds into the session), value, confidence, stable}
 * @param {number} durationSec how long the session actually ran
 */
export function summarize(history, durationSec) {
  return {
    durationSec,
    pulse: summarizeSignal(history.pulse || [], durationSec, ACCURACY.pulse),
    breath: summarizeSignal(history.breath || [], durationSec, ACCURACY.breath),
    hrv: summarizeSignal(history.hrv || [], durationSec, ACCURACY.hrv),
  };
}

/**
 * The only thing Calm Desk can write to disk, and only when the person clicks
 * Save. It holds aggregate numbers: no video, no waveforms, no expression data.
 */
export function buildExport(summary, { simulated = false, now = new Date() } = {}) {
  const round = (x, d = 1) => (x === null || x === undefined ? null : Number(x.toFixed(d)));
  const signal = (s) => ({
    mean: round(s.mean),
    firstThird: round(s.first),
    lastThird: round(s.last),
    change: round(s.delta),
    direction: s.direction,
    stableReadings: s.stableCount,
  });
  return {
    app: 'Calm Desk',
    schema: 1,
    createdAt: now.toISOString(),
    simulatedSignals: !!simulated,
    sessionSeconds: Math.round(summary.durationSec),
    pulseRateBpm: signal(summary.pulse),
    breathingRateBrPerMin: signal(summary.breath),
    hrvRmssdMs: signal(summary.hrv),
    notes: [
      'Wellness reflection only. Not a medical measurement, diagnosis or advice.',
      'Contains aggregate numbers only: no video, waveforms or facial-expression data.',
    ],
  };
}
