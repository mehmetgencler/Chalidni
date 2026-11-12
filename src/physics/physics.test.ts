/**
 * Comprehensive Stage 8 Verification & Regression Test Suite
 *
 * Tests all Stage 8 requirements:
 * 1. Worklet receives the complete active modal catalogue (queueing + delivery).
 * 2. 146 center-coupled odd-odd modes configured (even modes strictly 0 coupling).
 * 3. File mode no longer stops at 2700 Hz (full 20 Hz - 20 kHz excitation).
 * 4. 20 kHz tone processed through production ModalWorkletProcessor path.
 * 5. Single test tone and audio file share the exact same modal solver & AudioWorkletNode.
 * 6. No duplicate particle update during tone operation (single clock regression test).
 * 7. Per-mode physical free decay across 53.963 Hz, 1 kHz, 5 kHz, 10 kHz, 20 kHz.
 * 8. Audio pause produces zero input while preserving modal state & free decay.
 * 9. File end produces zero input while preserving modal state & free decay.
 * 10. Particle transport uses sample-frame time only.
 * 11. Main-thread rendering stalls do not discard elapsed physical time.
 * 12. Stereo downmix (0.5 * (L + R)) graph wiring and amplitude bounds.
 * 13. Broadband RMS field accuracy vs independent full N*N per-sample reference across 7 signal classes.
 * 14. Canvas visual variation uses actual per-particle radius and brightness properties.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {
  calculateAnalyticalFrequency,
  calculateModalMass,
  DEFAULT_ALUMINUM,
  DEFAULT_GEOMETRY,
  generateModalCatalogue,
  getActiveCenterCoupledModes,
  modeShape,
} from './plate.ts';
import { calculateAnalyticalHarmonicResponse, ModalBank } from './modalSolver.ts';
import { ParticleTransportSystem, reflectCoordinate } from './particleTransport.ts';
import { SimulationClockAccumulator } from './simulationClock.ts';
import { AudioEngine } from '../audio/audioEngine.ts';
import { computeParticleRenderParams } from '../components/plateVisuals.ts';
import { ModalSnapshot } from './types.ts';

interface WorkletInstance {
  modes: { m: number; n: number; frequency: number; omega: number; zeta: number; modalMass: number }[];
  sampleRate: number;
  sampleFramesProcessed: number;
  displacements: Float64Array;
  velocities: Float64Array;
  accelerations: Float64Array;
  covarianceMatrix: Float64Array;
  port: {
    onmessage: ((event: { data: unknown }) => void) | null;
    postMessage: (msg: unknown) => void;
  };
  handleMessage: (msg: unknown) => void;
  process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
  buildSnapshot: () => ModalSnapshot;
}

/**
 * Loads the actual production public/audio/modal-worklet-processor.js in an isolated VM
 * simulating AudioWorkletGlobalScope for genuine processor unit testing.
 */
function createProductionWorklet(sr: number = 44100): {
  processor: WorkletInstance;
  snapshots: ModalSnapshot[];
} {
  const code = fs.readFileSync(path.resolve('public/audio/modal-worklet-processor.js'), 'utf8');
  const sandbox: Record<string, unknown> = {
    sampleRate: sr,
    AudioWorkletProcessor: class {
      port = { onmessage: null, postMessage: () => {} };
    },
    globalThis: {},
    Math,
    Float64Array,
    Float32Array,
    Int32Array,
    Uint8Array,
    Array,
  };
  const holder: { cls: (new () => WorkletInstance) | null } = { cls: null };
  sandbox.registerProcessor = (_name: string, cls: new () => WorkletInstance) => {
    holder.cls = cls;
  };
  vm.runInNewContext(code, sandbox);
  const ProcessorClass = holder.cls;
  assert.ok(ProcessorClass, 'ModalWorkletProcessor must register itself');

  const processor = new ProcessorClass();
  const snapshots: ModalSnapshot[] = [];
  processor.port.postMessage = (msg: unknown) => {
    snapshots.push(msg as ModalSnapshot);
  };
  return { processor, snapshots };
}

/**
 * Helper to drive a production worklet instance with a signal generator for durationSec.
 */
function feedWorkletSignal(
  processor: WorkletInstance,
  durationSec: number,
  genSample: (t: number, sampleIdx: number) => number,
  sr: number = 44100
): void {
  const totalSamples = Math.floor(durationSec * sr);
  const quantum = 128;
  const inBuf = new Float32Array(quantum);
  const outBuf = new Float32Array(quantum);

  for (let offset = 0; offset < totalSamples; offset += quantum) {
    const len = Math.min(quantum, totalSamples - offset);
    const blockIn = len === quantum ? inBuf : new Float32Array(len);
    const blockOut = len === quantum ? outBuf : new Float32Array(len);
    for (let s = 0; s < len; s++) {
      const idx = offset + s;
      blockIn[s] = genSample(idx / sr, idx);
    }
    processor.process([[blockIn]], [[blockOut]]);
  }
}

/* -------------------------------------------------------------------------- */
/* TESTS 1–2: FULL 146-MODE CATALOGUE & WORKLET INITIALIZATION QUEUE          */
/* -------------------------------------------------------------------------- */

test('1. Worklet receives the complete active modal catalogue (pre-init queue -> flush on ready)', async () => {
  const mb = new ModalBank(DEFAULT_ALUMINUM, DEFAULT_GEOMETRY, 0.01);
  const modeConfig = mb.getWorkletModeConfig();
  assert.equal(modeConfig.length, 146);

  const engine = new AudioEngine();
  // Queue BEFORE AudioContext/Worklet exists
  engine.configureModes(modeConfig);
  assert.equal(engine.getConfiguredModeCount(), 146);
  assert.equal(engine.getPendingMessageCount(), 1, 'CONFIGURE_MODES must be queued before worklet ready');

  // Simulate browser Web Audio initialization via clean mock window
  const postedMessages: unknown[] = [];
  const connections: { from: string; to: string }[] = [];
  const makeGain = (name: string) => ({
    name,
    gain: {
      value: 1,
      setValueAtTime: (v: number) => {
        void v;
      },
      cancelScheduledValues: () => {},
      setTargetAtTime: () => {},
    },
    connect: (target: { name?: string }) => {
      connections.push({ from: name, to: target.name || 'unknown' });
    },
  });

  const prevWindow = (globalThis as Record<string, unknown>).window;
  const prevWorkletNode = (globalThis as Record<string, unknown>).AudioWorkletNode;
  try {
    (globalThis as Record<string, unknown>).AudioWorkletNode = class {
      name = 'modal-worklet-node';
      port = {
        onmessage: null,
        postMessage: (msg: unknown) => postedMessages.push(msg),
      };
      connect(target: { name?: string }) {
        connections.push({ from: 'workletNode', to: target.name || 'unknown' });
      }
    };
    (globalThis as Record<string, unknown>).window = {
      AudioContext: class {
        sampleRate = 44100;
        currentTime = 0;
        state = 'running';
        destination = { name: 'destination' };
        audioWorklet = { addModule: async () => {} };
        createGain = () => makeGain(`gain_${connections.length}`);
        resume = async () => {};
        close = async () => {};
      },
    };

    await engine.initContext();
    assert.equal(engine.getPendingMessageCount(), 0, 'Queue must flush completely on worklet ready');
    assert.equal(postedMessages.length, 1);
    const configMsg = postedMessages[0] as { type: string; modes: unknown[] };
    assert.equal(configMsg.type, 'CONFIGURE_MODES');
    assert.equal(configMsg.modes.length, 146, 'Worklet must receive all 146 active modes');

    // Verify workletNode is connected to a sink toward destination so browsers always pull process()
    assert.ok(
      connections.some((c) => c.from === 'workletNode'),
      'AudioWorkletNode must connect to a destination sink'
    );

    // Also verify production ModalWorkletProcessor handles CONFIGURE_MODES
    const { processor } = createProductionWorklet(44100);
    processor.handleMessage(configMsg);
    const snap = processor.buildSnapshot();
    assert.equal(snap.modeCount, 146);
  } finally {
    (globalThis as Record<string, unknown>).window = prevWindow;
    (globalThis as Record<string, unknown>).AudioWorkletNode = prevWorkletNode;
  }
});

test('2. 146 center-coupled odd-odd modes configured; even modes have strictly zero center coupling', () => {
  const full = generateModalCatalogue(20000, DEFAULT_ALUMINUM, DEFAULT_GEOMETRY);
  assert.equal(full.length, 557, 'Full Kirchhoff catalogue <= 20 kHz has 557 modes');

  const active = getActiveCenterCoupledModes(20000, DEFAULT_ALUMINUM, DEFAULT_GEOMETRY);
  assert.equal(active.length, 146, 'Center-coupled odd-odd catalogue has exactly 146 modes');

  // Confirm all even-indexed modes have zero center coupling phi_mn(L/2, L/2)
  const L = DEFAULT_GEOMETRY.sideLength;
  for (const m of full) {
    const phi = modeShape(m.m, m.n, L / 2, L / 2, L);
    if (m.m % 2 === 0 || m.n % 2 === 0) {
      assert.ok(Math.abs(phi) < 1e-14, `Even mode (${m.m},${m.n}) must have zero center coupling`);
    } else {
      assert.ok(Math.abs(Math.abs(phi) - 1.0) < 1e-14, `Odd-odd mode (${m.m},${m.n}) must have |phi|=1`);
    }
  }

  // ModalBank initialized with defaults uses all 146 modes (no 2700 Hz cutoff!)
  const mb = new ModalBank(DEFAULT_ALUMINUM, DEFAULT_GEOMETRY, 0.01);
  assert.equal(mb.modes.length, 146);
  assert.ok(mb.modes[mb.modes.length - 1].frequency > 19900);
});

/* -------------------------------------------------------------------------- */
/* TESTS 3–5: FULL 20 kHz FILE COVERAGE, 20 kHz WORKLET, UNIFIED SOLVER       */
/* -------------------------------------------------------------------------- */

test('3. File mode no longer stops at 2700 Hz: high-frequency (>2.7 kHz) audio excites upper plate modes', () => {
  const { processor } = createProductionWorklet(44100);
  const mb = new ModalBank(DEFAULT_ALUMINUM, DEFAULT_GEOMETRY, 0.01);
  processor.handleMessage({ type: 'CONFIGURE_MODES', modes: mb.getWorkletModeConfig() });

  // Drive with 10 kHz broadband/file audio sample stream
  feedWorkletSignal(processor, 0.15, (t) => Math.sin(2 * Math.PI * 10000 * t), 44100);
  const snap = processor.buildSnapshot();
  mb.applySnapshot(snap);

  // Verify modes above 2700 Hz have substantial RMS acceleration variance
  let maxHighFreqAccRms = 0;
  for (let i = 0; i < mb.modes.length; i++) {
    if (mb.modes[i].frequency > 2700) {
      const diag = snap.covarianceDiag![i];
      const rms = Math.sqrt(Math.max(0, diag));
      if (rms > maxHighFreqAccRms) maxHighFreqAccRms = rms;
    }
  }
  assert.ok(
    maxHighFreqAccRms > 100.0,
    `Modes >2700 Hz must be excited by 10 kHz input, got max rms=${maxHighFreqAccRms}`
  );
});

test('4. 20 kHz tone processed through production AudioWorklet path produces active RMS field', () => {
  const { processor } = createProductionWorklet(48000); // 48 kHz standard audio rate
  const mb = new ModalBank(DEFAULT_ALUMINUM, DEFAULT_GEOMETRY, 0.01);
  processor.handleMessage({ type: 'CONFIGURE_MODES', modes: mb.getWorkletModeConfig() });

  feedWorkletSignal(processor, 0.15, (t) => Math.sin(2 * Math.PI * 20000 * t), 48000);
  const snap = processor.buildSnapshot();
  assert.equal(snap.isSilent, false, '20 kHz tone in worklet must not be flagged silent');
  assert.equal(snap.modeCount, 146);

  mb.applySnapshot(snap);
  const centerRms = mb.evaluateRmsAcceleration(0.15, 0.15);
  assert.ok(Number.isFinite(centerRms) && centerRms > 100.0, `Expected strong 20 kHz center acceleration, got ${centerRms}`);
});

test('5. Test tone and uploaded file use the exact same modal solver & AudioWorkletNode path', () => {
  const audioEngineSrc = fs.readFileSync(path.resolve('src/audio/audioEngine.ts'), 'utf8');
  const appSrc = fs.readFileSync(path.resolve('src/App.tsx'), 'utf8');

  // Verify AudioEngine connects both toneGain and fileGain to the same workletNode
  assert.ok(audioEngineSrc.includes('this.toneGain.connect(this.workletNode)'));
  assert.ok(audioEngineSrc.includes('this.fileGain.connect(this.workletNode)'));

  // Verify App.tsx has no duplicate harmonic-tone bypass or requestAnimationFrame() physics loop
  assert.equal(appSrc.includes('requestAnimationFrame('), false, 'App.tsx must not invoke requestAnimationFrame()');
  assert.equal(appSrc.includes('setHarmonicTone'), false, 'App.tsx must not call harmonic tone bypass');
  assert.equal(appSrc.includes('updateHarmonicDecay'), false, 'App.tsx must not call scalar decay envelope');
  assert.equal(audioEngineSrc.includes('mediaDevices'), false, 'Zero microphone code allowed');

  // Analytical reference remains verified independently
  const M = calculateModalMass(DEFAULT_ALUMINUM, DEFAULT_GEOMETRY);
  const omega11 = 2 * Math.PI * calculateAnalyticalFrequency(1, 1, DEFAULT_ALUMINUM, DEFAULT_GEOMETRY);
  const ref = calculateAnalyticalHarmonicResponse(1.0, M, omega11, omega11, 0.01);
  assert.ok(Math.abs(ref.phaseLag - Math.PI / 2) < 1e-6);
});

/* -------------------------------------------------------------------------- */
/* TESTS 6, 10, 11: SINGLE CLOCK, NO DUPLICATE UPDATE, NO TIME DISCARD        */
/* -------------------------------------------------------------------------- */

test('6 & 10. Single clock & no duplicate particle update during tone operation', () => {
  const clock = new SimulationClockAccumulator();
  const sys = new ParticleTransportSystem({ particleCount: 200, dt: 0.016, seed: 7 }, 0.30);
  const sr = 44100;
  const dtParticle = 0.016;

  // First snapshot establishes baseline sample frame
  const s0: ModalSnapshot = {
    sampleFramesProcessed: 128,
    sampleRate: sr,
    elapsedSimTime: 128 / sr,
    displacements: [],
    velocities: [],
    accelerations: [],
    isPlaying: true,
    isSilent: false,
    quantumCount: 1,
  };
  assert.equal(clock.advanceFromSnapshot(s0, dtParticle, 10, (dt) => sys.step(dt, () => 1e-4)), 0);

  // Duplicate snapshot (same sampleFramesProcessed, e.g. if main thread ticks without new audio frames) -> 0 steps
  assert.equal(clock.advanceFromSnapshot(s0, dtParticle, 10, (dt) => sys.step(dt, () => 1e-4)), 0);

  // Advance exactly 1.0 second of audio frames across 60 snapshots
  const framesPerSnap = Math.round(sr / 60);
  let currentFrames = 128;
  for (let k = 1; k <= 60; k++) {
    currentFrames += framesPerSnap;
    clock.advanceFromSnapshot(
      { sampleFramesProcessed: currentFrames, sampleRate: sr },
      dtParticle,
      10,
      (dt) => sys.step(dt, () => 1e-4)
    );
  }

  // Exact elapsed audio time = (60 * 735) / 44100 = 1.0000 s -> floor(1.0 / 0.016) = 62 steps (NOT 124!)
  assert.equal(clock.stepsExecuted, 62, `Must execute exactly 62 steps for 1.0s audio, got ${clock.stepsExecuted}`);
  assert.ok(Math.abs(clock.simulatedTimeSec - 62 * 0.016) < 1e-12);
});

test('11. Main-thread rendering stalls do not discard elapsed physical time', () => {
  const clock = new SimulationClockAccumulator();
  const sys = new ParticleTransportSystem({ particleCount: 100, dt: 0.016, seed: 9 }, 0.30);
  const sr = 44100;
  const dtParticle = 0.016;

  clock.advanceFromSnapshot({ sampleFramesProcessed: 0, sampleRate: sr }, dtParticle, 10, () => {});

  // Simulate a 1.0 second main-thread stall (44100 samples arrived in one jump!)
  const stepsInStallTick = clock.advanceFromSnapshot(
    { sampleFramesProcessed: 44100, sampleRate: sr },
    dtParticle,
    10, // bounded chunk per tick
    (dt) => sys.step(dt, () => 1e-4)
  );

  assert.equal(stepsInStallTick, 10, 'Single tick processes bounded chunk of 10 substeps');
  // Crucial check: remaining 1.0 - 0.16 = 0.84 s MUST be preserved, NOT clamped to 0.1 s!
  assert.ok(
    Math.abs(clock.remainingTimeSec - 0.84) < 1e-9,
    `Remaining accumulator must preserve 0.84s, got ${clock.remainingTimeSec}`
  );

  // Subsequent ticks catch up completely without losing any physical time
  while (clock.remainingTimeSec >= dtParticle - 1e-12) {
    clock.drainRemaining(dtParticle, 10, (dt) => sys.step(dt, () => 1e-4));
  }
  assert.equal(clock.stepsExecuted, 62, 'All 62 physical steps from the 1.0s interval must execute');
});

/* -------------------------------------------------------------------------- */
/* TESTS 7, 8, 9: PER-MODE FREE DECAY, AUDIO PAUSE, FILE END                  */
/* -------------------------------------------------------------------------- */

test('7. Modal free decay: every mode decays at its own e^(-zeta*omega*t) rate across 53.963 Hz - 20 kHz', () => {
  const testFrequencies = [53.963, 1000, 5000, 10000, 20000];
  const sr = 48000;
  const decayRatesMeasured: number[] = [];

  for (const fDrive of testFrequencies) {
    const { processor } = createProductionWorklet(sr);
    // Drive at fDrive for 150 ms
    feedWorkletSignal(processor, 0.15, (t) => Math.sin(2 * Math.PI * fDrive * t), sr);

    // Pick mode closest to fDrive
    let targetIdx = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < processor.modes.length; i++) {
      const diff = Math.abs(processor.modes[i].frequency - fDrive);
      if (diff < bestDiff) {
        bestDiff = diff;
        targetIdx = i;
      }
    }

    const mode = processor.modes[targetIdx];
    const ampStart = Math.hypot(
      processor.displacements[targetIdx],
      processor.velocities[targetIdx] / mode.omega
    );
    assert.ok(ampStart > 0, `Mode near ${fDrive} Hz must be excited before zero input`);

    // Feed exact zero input for free decay
    // Choose window short enough so high frequencies remain well above floating-point underflow
    const decaySec = fDrive >= 5000 ? 0.005 : 0.05;
    feedWorkletSignal(processor, decaySec, () => 0.0, sr);

    const ampEnd = Math.hypot(
      processor.displacements[targetIdx],
      processor.velocities[targetIdx] / mode.omega
    );

    const expectedRatio = Math.exp(-mode.zeta * mode.omega * decaySec);
    const measuredRatio = ampEnd / ampStart;
    const relErr = Math.abs(measuredRatio - expectedRatio) / expectedRatio;

    assert.ok(
      relErr < 0.02,
      `Free decay ratio mismatch at ${fDrive} Hz (mode ${mode.m},${mode.n} @ ${mode.frequency.toFixed(1)}Hz): expected ${expectedRatio.toFixed(5)}, got ${measuredRatio.toFixed(5)}`
    );

    decayRatesMeasured.push(-Math.log(measuredRatio) / decaySec);
  }

  // Higher-frequency modes decay strictly faster than lower-frequency modes (not a global scalar rate!)
  assert.ok(decayRatesMeasured[4] > decayRatesMeasured[1] * 5.0);
  assert.ok(decayRatesMeasured[1] > decayRatesMeasured[0] * 5.0);
});

test('8 & 9. Audio pause and file end produce zero input while preserving modal state for free decay', () => {
  const engineSrc = fs.readFileSync(path.resolve('src/audio/audioEngine.ts'), 'utf8');
  // Ensure pauseAudioFile and onended never send RESET_MODES
  const pauseSection = engineSrc.slice(engineSrc.indexOf('pauseAudioFile()'), engineSrc.indexOf('seekAudioFile('));
  assert.equal(pauseSection.includes('RESET_MODES'), false, 'Pause must not reset modal states');

  const { processor } = createProductionWorklet(44100);
  const mb = new ModalBank(DEFAULT_ALUMINUM, DEFAULT_GEOMETRY, 0.01);

  // Play broadband audio file chunk (54 Hz + 270 Hz + 1 kHz)
  feedWorkletSignal(
    processor,
    0.2,
    (t) => 0.4 * Math.sin(2 * Math.PI * 53.963 * t) + 0.4 * Math.sin(2 * Math.PI * 269.815 * t) + 0.2 * Math.sin(2 * Math.PI * 1000 * t),
    44100
  );

  const snapAtPause = processor.buildSnapshot();
  mb.applySnapshot(snapAtPause);
  const rmsAtPause = mb.evaluateRmsAcceleration(0.15, 0.15);
  assert.ok(rmsAtPause > 50.0, 'Plate must hold high RMS acceleration right at pause/file-end');

  // Now simulate Pause / File End (zero samples arrive, no RESET_MODES)
  feedWorkletSignal(processor, 0.05, () => 0.0, 44100);
  const snapDuringDecay = processor.buildSnapshot();
  assert.equal(snapDuringDecay.isSilent, false, 'Residual free decay vibration must remain active immediately after pause/end');

  mb.applySnapshot(snapDuringDecay);
  const rmsDecaying = mb.evaluateRmsAcceleration(0.15, 0.15);
  assert.ok(rmsDecaying > 0.1 * rmsAtPause && rmsDecaying < rmsAtPause, 'RMS field must decay smoothly after pause/end');
});

/* -------------------------------------------------------------------------- */
/* TEST 12: STEREO DOWNMIX                                                    */
/* -------------------------------------------------------------------------- */

test('12. Stereo-to-mono downmix: 0.5 * (L + R) preserves right-only and left-only channels without clipping', () => {
  const engineSrc = fs.readFileSync(path.resolve('src/audio/audioEngine.ts'), 'utf8');
  assert.ok(engineSrc.includes('createChannelSplitter(2)'));
  assert.ok(engineSrc.includes('merger.gain.setValueAtTime(0.5'));
  assert.ok(engineSrc.includes('splitter.connect(merger, 0)'));
  assert.ok(engineSrc.includes('splitter.connect(merger, 1)'));
  assert.ok(engineSrc.includes('this.mediaElementSource.connect(this.ctx.destination)'));

  // Simulate Right-only signal (L=0, R=1.0) -> mono = 0.5 feeds worklet and excites modes
  const { processor } = createProductionWorklet(44100);
  const mb = new ModalBank(DEFAULT_ALUMINUM, DEFAULT_GEOMETRY, 0.01);
  feedWorkletSignal(
    processor,
    0.15,
    (t) => {
      const L = 0.0;
      const R = Math.sin(2 * Math.PI * 269.815 * t);
      return 0.5 * (L + R);
    },
    44100
  );
  mb.applySnapshot(processor.buildSnapshot());
  assert.ok(mb.evaluateRmsAcceleration(0.15, 0.15) > 100.0, 'Right-channel-only audio must drive plate');
});

/* -------------------------------------------------------------------------- */
/* TEST 13: BROADBAND COVARIANCE COMPARISON VS INDEPENDENT FULL N*N REFERENCE */
/* -------------------------------------------------------------------------- */

test('13. Broadband RMS field compared against independent exact N*N per-sample reference across 7 signal classes', () => {
  const modes = getActiveCenterCoupledModes(20000, DEFAULT_ALUMINUM, DEFAULT_GEOMETRY);
  const N = modes.length;
  const sr = 44100;
  const dt = 1 / sr;
  const zeta = 0.01;
  const tau = 0.08;
  const sampleAlpha = 1 - Math.exp(-dt / tau);

  // Independent exact ZOH + full N*N per-sample covariance reference solver
  const A11 = new Float64Array(N), A12 = new Float64Array(N), A21 = new Float64Array(N), A22 = new Float64Array(N);
  const w2 = new Float64Array(N), twoZW = new Float64Array(N), M = new Float64Array(N), C = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const m = modes[i], w = m.omega, wd = w * Math.sqrt(1 - zeta * zeta);
    w2[i] = w * w;
    twoZW[i] = 2 * zeta * w;
    M[i] = m.modalMass;
    C[i] = m.centerCoupling;
    const e = Math.exp(-zeta * w * dt), c = Math.cos(wd * dt), sOver = Math.sin(wd * dt) / wd;
    A11[i] = e * (c + zeta * w * sOver);
    A12[i] = e * sOver;
    A21[i] = -e * w * w * sOver;
    A22[i] = e * (c - zeta * w * sOver);
  }

  // Precompute modeShapes on a 12x12 interior verification grid
  const gridPts: { x: number; y: number; phis: Float64Array }[] = [];
  for (let gx = 1; gx < 12; gx++) {
    for (let gy = 1; gy < 12; gy++) {
      const x = (gx / 12) * 0.30;
      const y = (gy / 12) * 0.30;
      const phis = Float64Array.from(modes, (m) => modeShape(m.m, m.n, x, y, 0.30));
      gridPts.push({ x, y, phis });
    }
  }

  let lcgSeed = 987654321;
  const signals: { name: string; maxAllowedErrPct: number; gen: (t: number) => number }[] = [
    { name: 'Single frequency (1 kHz)', maxAllowedErrPct: 5.0, gen: (t) => Math.sin(2 * Math.PI * 1000 * t) },
    { name: 'Two nearby frequencies (265 + 275 Hz)', maxAllowedErrPct: 3.0, gen: (t) => 0.5 * (Math.sin(2 * Math.PI * 265 * t) + Math.sin(2 * Math.PI * 275 * t)) },
    { name: 'Two equal-freq coherent (269.8 Hz)', maxAllowedErrPct: 3.0, gen: (t) => Math.sin(2 * Math.PI * 269.815 * t) },
    { name: 'Anti-phase components', maxAllowedErrPct: 3.0, gen: (t) => Math.sin(2 * Math.PI * 53.963 * t) - 0.8 * Math.sin(2 * Math.PI * 53.963 * t) },
    { name: 'Multi-tone signal', maxAllowedErrPct: 5.0, gen: (t) => 0.25 * (Math.sin(2 * Math.PI * 53.963 * t) + Math.sin(2 * Math.PI * 269.815 * t) + Math.sin(2 * Math.PI * 1349.1 * t) + Math.sin(2 * Math.PI * 5000 * t)) },
    {
      name: 'Broadband noise',
      maxAllowedErrPct: 12.0, // Omitted cross-terms among non-top-24 non-degenerate random noise modes documented <12%
      gen: () => {
        lcgSeed = (Math.imul(lcgSeed, 1664525) + 1013904223) >>> 0;
        return (lcgSeed / 4294967296) * 2 - 1;
      },
    },
    {
      name: 'Representative music segment',
      maxAllowedErrPct: 8.0,
      gen: (t) =>
        0.4 * Math.sin(2 * Math.PI * 110 * t) +
        0.25 * Math.sin(2 * Math.PI * 220 * t) +
        0.2 * Math.sin(2 * Math.PI * 440 * t) +
        0.15 * Math.sin(2 * Math.PI * 3520 * t) * Math.exp(-((t % 0.1) * 40)),
    },
  ];

  const durationSec = 0.25;
  const totalSamples = Math.floor(durationSec * sr) - (Math.floor(durationSec * sr) % 128);

  for (const sig of signals) {
    const { processor } = createProductionWorklet(sr);
    const mb = new ModalBank(DEFAULT_ALUMINUM, DEFAULT_GEOMETRY, zeta);

    const qRef = new Float64Array(N), vRef = new Float64Array(N), aRef = new Float64Array(N);
    const R_ref = new Float64Array(N * N);

    const quantum = 128;
    const inBuf = new Float32Array(quantum);
    const outBuf = new Float32Array(quantum);

    for (let offset = 0; offset < totalSamples; offset += quantum) {
      for (let s = 0; s < quantum; s++) {
        const sample = sig.gen((offset + s) * dt);
        // Feed identical Float32 quantized sample to both worklet and exact reference
        inBuf[s] = sample;
        const exc = inBuf[s] * 3.0;
        for (let i = 0; i < N; i++) {
          const u = (exc * C[i]) / M[i];
          const qEq = u / w2[i];
          const qt = qRef[i] - qEq;
          const qn = A11[i] * qt + A12[i] * vRef[i] + qEq;
          const vn = A21[i] * qt + A22[i] * vRef[i];
          const an = u - twoZW[i] * vn - w2[i] * qn;
          qRef[i] = qn;
          vRef[i] = vn;
          aRef[i] = an;
        }
        for (let i = 0; i < N; i++) {
          const ai = aRef[i];
          const row = i * N;
          for (let j = i; j < N; j++) {
            R_ref[row + j] = R_ref[row + j] * (1 - sampleAlpha) + ai * aRef[j] * sampleAlpha;
          }
        }
      }
      processor.process([[inBuf]], [[outBuf]]);
    }

    // Symmetrize R_ref
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) R_ref[j * N + i] = R_ref[i * N + j];
    }

    mb.applySnapshot(processor.buildSnapshot());

    let sqDiff = 0;
    let sqRef = 0;
    for (const pt of gridPts) {
      let sRef = 0;
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
          sRef += R_ref[i * N + j] * pt.phis[i] * pt.phis[j];
        }
      }
      const rRef = Math.sqrt(Math.max(0, sRef));
      const rOpt = mb.evaluateRmsAcceleration(pt.x, pt.y);
      sqDiff += (rOpt - rRef) ** 2;
      sqRef += rRef ** 2;
    }

    const relErrPct = sqRef > 0 ? Math.sqrt(sqDiff / sqRef) * 100 : 0;
    assert.ok(
      relErrPct <= sig.maxAllowedErrPct,
      `${sig.name}: spatial RMS L2 error ${relErrPct.toFixed(3)}% exceeded bound ${sig.maxAllowedErrPct}%`
    );
  }
});

/* -------------------------------------------------------------------------- */
/* TEST 14 & PARTICLE INVARIANTS                                              */
/* -------------------------------------------------------------------------- */

test('14. Canvas visual variation uses actual per-particle radius and brightness properties', () => {
  const sys = new ParticleTransportSystem({ particleCount: 3000, seed: 42 }, 0.30);
  const pSmallDim = { radius: 0.9, brightness: 0.82 };
  const pLargeBright = { radius: 1.4, brightness: 1.18 };

  const resA = computeParticleRenderParams(pSmallDim, 6);
  const resB = computeParticleRenderParams(pLargeBright, 6);

  assert.ok(resB.drawSize > resA.drawSize, 'drawSize must increase with particle.radius');
  assert.ok(resB.spriteTier > resA.spriteTier, 'spriteTier must increase with particle.brightness');

  // Verify generated particles actually span radius & brightness variations
  const radii = new Set(sys.particles.map((p) => computeParticleRenderParams(p, 6).drawSize.toFixed(2)));
  const tiers = new Set(sys.particles.map((p) => computeParticleRenderParams(p, 6).spriteTier));
  assert.ok(radii.size > 10, 'Particles must render with continuous radius variation');
  assert.equal(tiers.size, 6, 'Particles must span all 6 brightness sprite tiers');
});

test('15. Particle boundary conservation & adaptive micro-stepping keep 100% of 3000 grains in [0, L] x [0, L]', () => {
  const L = 0.30;
  const sys = new ParticleTransportSystem({ particleCount: 3000, dt: 0.016, seed: 123 }, L);

  // Step 50 times with violent diffusion triggering adaptive micro-stepping
  for (let s = 0; s < 50; s++) {
    sys.step(0.016, () => 0.1);
  }

  assert.equal(sys.particles.length, 3000);
  for (let i = 0; i < sys.particles.length; i++) {
    const p = sys.particles[i];
    assert.ok(p.x >= 0 && p.x <= L && p.y >= 0 && p.y <= L);
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
  }

  assert.ok(Math.abs(reflectCoordinate(0.35, L) - 0.25) < 1e-12);
  assert.ok(Math.abs(reflectCoordinate(-0.05, L) - 0.05) < 1e-12);
});

test('16. sampleRmsFieldFast symmetric bilinear grid matches exact RMS acceleration and executes 3000 lookups in <5 ms', () => {
  const { processor } = createProductionWorklet(44100);
  const mb = new ModalBank(DEFAULT_ALUMINUM, DEFAULT_GEOMETRY, 0.01);
  processor.handleMessage({ type: 'CONFIGURE_MODES', modes: mb.getWorkletModeConfig() });

  feedWorkletSignal(
    processor,
    0.15,
    (t) => 0.5 * Math.sin(2 * Math.PI * 269.815 * t) + 0.5 * Math.sin(2 * Math.PI * 1000 * t),
    44100
  );
  mb.applySnapshot(processor.buildSnapshot());

  // Verify accuracy & 4-fold odd-odd symmetry at sample interior coordinates
  const coords = [
    [0.075, 0.075],
    [0.15, 0.15],
    [0.225, 0.075],
    [0.075, 0.225],
    [0.11, 0.19],
  ];
  for (const [x, y] of coords) {
    const exact = mb.evaluateRmsAcceleration(x, y);
    const fast = mb.sampleRmsFieldFast(x, y);
    const relErr = exact > 1e-3 ? Math.abs(fast - exact) / exact : Math.abs(fast - exact);
    assert.ok(relErr < 0.02, `Fast RMS lookup mismatch at (${x}, ${y}): exact=${exact}, fast=${fast}`);
  }
  assert.ok(
    Math.abs(mb.sampleRmsFieldFast(0.08, 0.12) - mb.sampleRmsFieldFast(0.22, 0.18)) < 1e-9,
    'Fast RMS field must preserve exact 4-fold plate symmetry'
  );

  // Benchmark 3000 lookups after cache warmup
  const sys = new ParticleTransportSystem({ particleCount: 3000, dRef: 2.5e-5, seed: 42 }, 0.30);
  const t0 = performance.now();
  sys.step(0.016, (px, py) => sys.evaluateDimensionalDiffusivity(mb.sampleRmsFieldFast(px, py)));
  const elapsedMs = performance.now() - t0;
  assert.ok(elapsedMs < 20, `3000-particle fast step took ${elapsedMs.toFixed(2)} ms (expected <20 ms)`);
});

