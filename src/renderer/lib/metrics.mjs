// Turns decoded SmartSpectra `Metrics` messages into the small set of values
// Calm Desk displays, plus bounded rolling buffers for the charts.
//
// Design notes
// - We don't know (and don't want to depend on) whether each 'metrics' packet
//   carries only new points or a cumulative history, so every series dedupes by
//   the sample's own timestamp and only accepts points newer than the last one.
// - Everything here is pure and has no SDK/Electron imports, so it is unit-tested
//   in plain Node (see test/metrics.test.mjs).

export const EXPRESSION_LABELS = Object.freeze({
  1: 'Angry',
  2: 'Contempt',
  3: 'Disgust',
  4: 'Fear',
  5: 'Happy',
  6: 'Neutral',
  7: 'Sad',
  8: 'Surprise',
});

/** protobufjs int64 fields can arrive as number, Long or null. */
export function toNumber(v) {
  if (v === null || v === undefined) return NaN;
  if (typeof v === 'number') return v;
  if (typeof v.toNumber === 'function') return v.toNumber();
  return Number(v);
}

/**
 * Rolling buffer of numeric samples. Accepts a point only if its timestamp is
 * newer than the last accepted one (points without a usable timestamp are
 * always accepted).
 */
export class Series {
  constructor(maxPoints = 900) {
    this.maxPoints = maxPoints;
    this.values = [];
    this.lastTs = -Infinity;
  }

  /** @returns {boolean} whether the point was new and stored */
  push(ts, value) {
    if (!Number.isFinite(value)) return false;
    if (Number.isFinite(ts) && ts > 0) {
      if (ts <= this.lastTs) return false;
      this.lastTs = ts;
    }
    this.values.push(value);
    if (this.values.length > this.maxPoints) this.values.shift();
    return true;
  }

  last() {
    return this.values.length ? this.values[this.values.length - 1] : null;
  }

  clear() {
    this.values = [];
    this.lastTs = -Infinity;
  }
}

/**
 * Position of the newest sample within the recent range of the series, 0..1.
 * The traces are unitless, so we normalise against what we've just seen.
 * Returns 0.5 while there isn't enough range to say anything.
 */
export function normalizedLast(series, window = 150) {
  const v = series.values;
  if (v.length < 8) return 0.5;
  const slice = v.length > window ? v.slice(v.length - window) : v;
  let min = Infinity;
  let max = -Infinity;
  for (const x of slice) {
    if (x < min) min = x;
    if (x > max) max = x;
  }
  if (!(max - min > 1e-9)) return 0.5;
  return (slice[slice.length - 1] - min) / (max - min);
}

function newPoints(list, lastTs) {
  // Keep only points newer than lastTs, in order. Points lacking a timestamp
  // are treated as new.
  const out = [];
  if (!list) return out;
  for (const p of list) {
    const ts = toNumber(p && p.timestamp);
    if (!Number.isFinite(ts) || ts <= 0 || ts > lastTs) out.push({ p, ts });
  }
  return out;
}

export class MetricsTracker {
  /** @param {{ now?: () => number }} [opts] injectable clock (ms) for tests */
  constructor({ now = () => performance.now() } = {}) {
    this.now = now;
    this.breathTrace = new Series(900);
    this.pulseWave = new Series(900);
    this.latest = { pulse: null, breath: null, hrv: null, expression: null };
    this.history = { pulse: [], breath: [], hrv: [] };
    this.recording = false;
    this.recordStart = 0;
    this._lastTs = { pulse: -Infinity, breath: -Infinity, hrv: -Infinity, expression: -Infinity };
  }

  startRecording() {
    this.history = { pulse: [], breath: [], hrv: [] };
    this.recording = true;
    this.recordStart = this.now();
  }

  stopRecording() {
    this.recording = false;
  }

  /** Drops every value we hold. Called on Finish/Discard so nothing lingers. */
  clearAll() {
    this.breathTrace.clear();
    this.pulseWave.clear();
    this.latest = { pulse: null, breath: null, hrv: null, expression: null };
    this.history = { pulse: [], breath: [], hrv: [] };
    this.recording = false;
    this._lastTs = { pulse: -Infinity, breath: -Infinity, hrv: -Infinity, expression: -Infinity };
  }

  _record(kind, value, confidence, stable) {
    if (!this.recording) return;
    this.history[kind].push({
      t: (this.now() - this.recordStart) / 1000,
      value,
      confidence,
      stable: !!stable,
    });
  }

  _ingestRate(kind, list) {
    for (const { p, ts } of newPoints(list, this._lastTs[kind])) {
      const value = toNumber(p.value);
      if (!Number.isFinite(value)) continue;
      if (Number.isFinite(ts) && ts > 0) this._lastTs[kind] = ts;
      const confidence = Number.isFinite(p.confidence) ? p.confidence : null;
      this.latest[kind] = { value, confidence, stable: !!p.stable };
      this._record(kind, value, confidence, p.stable);
    }
  }

  /** @param {object} decoded a decoded presage.smartspectra.Metrics message */
  ingest(decoded) {
    if (!decoded) return;
    const breathing = decoded.breathing;
    const cardio = decoded.cardio;
    const face = decoded.face;

    this._ingestRate('breath', breathing && breathing.rate);
    this._ingestRate('pulse', cardio && cardio.pulseRate);

    // HRV: report RMSSD (ms) as the headline value.
    for (const { p, ts } of newPoints(cardio && cardio.hrv, this._lastTs.hrv)) {
      const rmssd = toNumber(p.rmssd);
      if (!Number.isFinite(rmssd) || rmssd <= 0) continue;
      if (Number.isFinite(ts) && ts > 0) this._lastTs.hrv = ts;
      const confidence = Number.isFinite(p.confidence) ? p.confidence : null;
      this.latest.hrv = {
        value: rmssd,
        sdnn: Number.isFinite(p.sdnn) ? p.sdnn : null,
        confidence,
        stable: !!p.stable,
      };
      this._record('hrv', rmssd, confidence, p.stable);
    }

    // Waveforms for the charts.
    if (breathing && breathing.upperTrace) {
      for (const p of breathing.upperTrace) this.breathTrace.push(toNumber(p.timestamp), toNumber(p.value));
    }
    if (cardio && cardio.arterialPressureTrace) {
      for (const p of cardio.arterialPressureTrace) this.pulseWave.push(toNumber(p.timestamp), toNumber(p.value));
    }

    // Expression (only present if the person opted in and we requested it).
    const exprList = face && face.expression;
    for (const { p, ts } of newPoints(exprList, this._lastTs.expression)) {
      const scores = (p.scores || [])
        .map((s) => ({ type: s.type, label: EXPRESSION_LABELS[s.type] || null, confidence: s.confidence }))
        .filter((s) => s.label && Number.isFinite(s.confidence))
        .sort((a, b) => b.confidence - a.confidence);
      if (!scores.length) continue;
      if (Number.isFinite(ts) && ts > 0) this._lastTs.expression = ts;
      this.latest.expression = { top: scores[0], scores, stable: !!p.stable };
    }
  }
}
