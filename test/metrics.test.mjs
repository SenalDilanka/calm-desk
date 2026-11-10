import test from 'node:test';
import assert from 'node:assert/strict';
import sdkMessages from '@smartspectra/node-sdk/messages';
import { MetricsTracker, Series, normalizedLast, toNumber } from '../src/renderer/lib/metrics.mjs';

const { Metrics, decodeMetrics } = sdkMessages;

// Round-trips through the real generated protobuf classes, like the live SDK does.
function packet(obj) {
  return decodeMetrics(Metrics.encode(Metrics.create(obj)).finish());
}

function clock() {
  let t = 0;
  const fn = () => t;
  fn.set = (v) => { t = v; };
  return fn;
}

test('toNumber handles numbers, Long-like objects and nullish values', () => {
  assert.equal(toNumber(5), 5);
  assert.equal(toNumber({ toNumber: () => 42 }), 42);
  assert.ok(Number.isNaN(toNumber(null)));
  assert.ok(Number.isNaN(toNumber(undefined)));
});

test('Series dedupes by timestamp and is bounded', () => {
  const s = new Series(3);
  assert.equal(s.push(10, 1), true);
  assert.equal(s.push(10, 2), false, 'same timestamp rejected');
  assert.equal(s.push(9, 3), false, 'older timestamp rejected');
  assert.equal(s.push(11, 4), true);
  s.push(12, 5);
  s.push(13, 6);
  assert.deepEqual(s.values, [4, 5, 6]);
  assert.equal(s.push(14, NaN), false, 'non-finite rejected');
});

test('normalizedLast returns 0.5 with too little data or no range', () => {
  const s = new Series();
  assert.equal(normalizedLast(s), 0.5);
  for (let i = 0; i < 20; i++) s.push(i + 1, 3);
  assert.equal(normalizedLast(s), 0.5);
});

test('normalizedLast places the newest sample within the recent range', () => {
  const s = new Series();
  for (let i = 0; i < 20; i++) s.push(i + 1, i % 2 ? 10 : 0);
  s.push(100, 10);
  assert.equal(normalizedLast(s), 1);
  s.push(101, 0);
  assert.equal(normalizedLast(s), 0);
});

test('ingest extracts pulse, breathing, HRV and traces from a decoded packet', () => {
  const tr = new MetricsTracker({ now: clock() });
  tr.ingest(packet({
    breathing: {
      rate: [{ value: 6.2, stable: true, confidence: 70, timestamp: 1000 }],
      upperTrace: [{ value: 0.1, timestamp: 1000 }, { value: 0.4, timestamp: 1001 }],
    },
    cardio: {
      pulseRate: [{ value: 71, stable: true, confidence: 80, timestamp: 1000 }],
      arterialPressureTrace: [{ value: 0.7, confidence: 80, timestamp: 1000 }],
      hrv: [{ rmssd: 41.5, sdnn: 50, confidence: 60, stable: true, timestamp: 1000 }],
    },
  }));
  // The protobuf fields are 32-bit floats, so compare with a tolerance (6.2 -> 6.1999998).
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-4, `${a} !~ ${b}`);
  near(tr.latest.pulse.value, 71);
  near(tr.latest.pulse.confidence, 80);
  assert.equal(tr.latest.pulse.stable, true);
  near(tr.latest.breath.value, 6.2);
  near(tr.latest.breath.confidence, 70);
  near(tr.latest.hrv.value, 41.5);
  assert.equal(tr.latest.hrv.sdnn, 50);
  assert.equal(tr.latest.expression, null);
  assert.equal(tr.breathTrace.values.length, 2);
  assert.equal(tr.pulseWave.values.length, 1);
});

test('cumulative packets do not duplicate points', () => {
  const tr = new MetricsTracker({ now: clock() });
  const first = { cardio: { pulseRate: [{ value: 70, stable: true, confidence: 50, timestamp: 100 }] }, breathing: { upperTrace: [{ value: 1, timestamp: 100 }] } };
  const second = {
    cardio: { pulseRate: [{ value: 70, stable: true, confidence: 50, timestamp: 100 }, { value: 72, stable: true, confidence: 55, timestamp: 200 }] },
    breathing: { upperTrace: [{ value: 1, timestamp: 100 }, { value: 2, timestamp: 200 }] },
  };
  tr.startRecording();
  tr.ingest(packet(first));
  tr.ingest(packet(second));
  assert.equal(tr.latest.pulse.value, 72);
  assert.equal(tr.history.pulse.length, 2, 'each distinct reading recorded once');
  assert.deepEqual(tr.breathTrace.values, [1, 2]);
});

test('history only records while recording and uses session-relative seconds', () => {
  const now = clock();
  const tr = new MetricsTracker({ now });
  tr.ingest(packet({ cardio: { pulseRate: [{ value: 80, stable: true, confidence: 50, timestamp: 1 }] } }));
  assert.equal(tr.history.pulse.length, 0, 'not recording yet');

  now.set(5000);
  tr.startRecording();
  now.set(7500);
  tr.ingest(packet({ cardio: { pulseRate: [{ value: 75, stable: false, confidence: 20, timestamp: 2 }] } }));
  assert.equal(tr.history.pulse.length, 1);
  assert.equal(tr.history.pulse[0].t, 2.5);
  assert.equal(tr.history.pulse[0].stable, false);

  tr.stopRecording();
  tr.ingest(packet({ cardio: { pulseRate: [{ value: 74, stable: true, confidence: 50, timestamp: 3 }] } }));
  assert.equal(tr.history.pulse.length, 1, 'recording stopped');
  assert.equal(tr.latest.pulse.value, 74, 'live value still updates');
});

test('expression picks the top-scoring labelled expression and sorts scores', () => {
  const tr = new MetricsTracker({ now: clock() });
  tr.ingest(packet({
    face: { expression: [{ stable: true, timestamp: 10, scores: [{ type: 6, confidence: 20 }, { type: 5, confidence: 70 }, { type: 0, confidence: 99 }] }] },
  }));
  assert.equal(tr.latest.expression.top.label, 'Happy');
  assert.equal(tr.latest.expression.scores.length, 2, 'unspecified type dropped');
  assert.equal(tr.latest.expression.scores[1].label, 'Neutral');
});

test('empty and partial packets are harmless', () => {
  const tr = new MetricsTracker({ now: clock() });
  tr.ingest(null);
  tr.ingest(packet({}));
  tr.ingest(packet({ cardio: { hrv: [{ rmssd: 0, timestamp: 5 }] } }));
  assert.equal(tr.latest.hrv, null, 'zero RMSSD is not a reading');
  assert.equal(tr.latest.pulse, null);
});

test('clearAll drops every value held', () => {
  const tr = new MetricsTracker({ now: clock() });
  tr.startRecording();
  tr.ingest(packet({
    breathing: { upperTrace: [{ value: 1, timestamp: 1 }] },
    cardio: { pulseRate: [{ value: 70, stable: true, confidence: 50, timestamp: 1 }] },
  }));
  tr.clearAll();
  assert.equal(tr.latest.pulse, null);
  assert.equal(tr.history.pulse.length, 0);
  assert.equal(tr.breathTrace.values.length, 0);
  assert.equal(tr.recording, false);
  // And it accepts the same timestamps again afterwards (dedupe state was reset).
  tr.ingest(packet({ cardio: { pulseRate: [{ value: 69, stable: true, confidence: 50, timestamp: 1 }] } }));
  assert.equal(tr.latest.pulse.value, 69);
});
