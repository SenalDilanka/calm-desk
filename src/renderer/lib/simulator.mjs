// Development-only stand-in for the SmartSpectra renderer SDK.
//
// It exposes the same small surface Calm Desk uses (on/start/stop/reset/destroy)
// and emits *real protobuf-encoded* Metrics buffers built with the SDK's own
// generated message classes, so the app's decode and extraction path is the same
// as with a live camera. The UI always shows a "Simulated signals" banner while
// this is active. These numbers are synthetic and are never a measurement.

import { Metrics } from '@smartspectra/node-sdk/messages';

const TICK_MS = 250;
const SAMPLES_PER_TICK = 5; // 20 Hz waveforms
const SAMPLE_STEP_US = 50_000;

export class SimulatedSmartSpectra {
  constructor(options = {}) {
    this.options = options;
    this.handlers = {};
    this.timer = null;
    this.startedAt = 0;
    this.processingStatus = 1; // kIdle
  }

  on(event, cb) {
    this.handlers[event] = cb;
    return this;
  }

  _emit(event, ...args) {
    const cb = this.handlers[event];
    if (cb) cb(...args);
  }

  async start() {
    if (this.timer) return;
    this.startedAt = Date.now();
    this._setStatus(2); // kStarting
    setTimeout(() => {
      if (!this.timer) return;
      this._setStatus(3); // kRunning
    }, 600);
    this.timer = setInterval(() => this._tick(), TICK_MS);
    // A short "getting ready" phase makes the setup screen behave like the real thing.
    this._emit('validationStatus', 10, 0, 'Camera is adjusting');
    setTimeout(() => this._emit('validationStatus', 0, 0, ''), 1200);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this._setStatus(1); // kIdle
  }

  async reset() {
    await this.stop();
  }

  destroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.handlers = {};
  }

  async requestInsight() {
    return 0; // Calm Desk never requests AI insights; present only for interface parity.
  }

  _setStatus(s) {
    this.processingStatus = s;
    this._emit('processingStatus', s);
  }

  _tick() {
    const elapsed = (Date.now() - this.startedAt) / 1000;
    const nowUs = Date.now() * 1000;
    const wantsFace = Array.isArray(this.options.requestedMetrics) && this.options.requestedMetrics.includes(14);

    // Breathing around 6 breaths/min with a little noise; pulse drifting down slowly.
    const breathHz = 0.1;
    const upperTrace = [];
    const wave = [];
    for (let i = 0; i < SAMPLES_PER_TICK; i++) {
      const ts = nowUs - (SAMPLES_PER_TICK - 1 - i) * SAMPLE_STEP_US;
      const t = elapsed - (SAMPLES_PER_TICK - 1 - i) * 0.05;
      const noise = (Math.sin(t * 7.3) + Math.sin(t * 3.1)) * 0.04;
      upperTrace.push({ value: Math.sin(2 * Math.PI * breathHz * t - 0.6) + noise, stable: elapsed > 8, timestamp: ts });
      wave.push({
        value: Math.sin(2 * Math.PI * 1.15 * t) + 0.3 * Math.sin(2 * Math.PI * 2.3 * t),
        stable: elapsed > 6,
        confidence: 80,
        timestamp: ts,
      });
    }

    const settle = Math.min(1, elapsed / 15);
    const pulseValue = 74 - 6 * Math.min(1, elapsed / 110) + Math.sin(elapsed * 0.9) * 1.2;
    const breathValue = 6.3 + Math.sin(elapsed * 0.5) * 0.3;

    const message = {
      breathing: {
        upperTrace,
        rate: [{ value: breathValue, stable: elapsed > 10, confidence: 30 + 55 * settle, timestamp: nowUs }],
      },
      cardio: {
        arterialPressureTrace: wave,
        pulseRate: [{ value: pulseValue, stable: elapsed > 8, confidence: 25 + 60 * settle, timestamp: nowUs }],
        hrv:
          elapsed > 25
            ? [
                {
                  rmssd: 38 + 9 * Math.min(1, (elapsed - 25) / 80) + Math.sin(elapsed) * 1.5,
                  sdnn: 46,
                  meanNn: 810,
                  confidence: 55 + 20 * settle,
                  stable: true,
                  timestamp: nowUs,
                },
              ]
            : [],
      },
    };

    if (wantsFace) {
      const happy = 30 + 25 * Math.max(0, Math.sin(elapsed * 0.2));
      message.face = {
        expression: [
          {
            stable: elapsed > 5,
            timestamp: nowUs,
            scores: [
              { type: 6, confidence: 100 - happy - 5 },
              { type: 5, confidence: happy },
              { type: 8, confidence: 5 },
            ],
          },
        ],
      };
    }

    const encoded = Metrics.encode(Metrics.create(message)).finish();
    this._emit('metrics', encoded, nowUs);
  }
}
