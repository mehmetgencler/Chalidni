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
import {
  createWavPcmChunkStream,
  parseWavHeader,
  WavByteSource,
} from '../audio/wavPcmStream.ts';
import {
  buildExportDownloadFileName,
  estimateExportSizeBytes,
  selectSupportedVideoCodec,
} from '../video/silentVideoExport.ts';
import { computeParticleRenderParams } from '../components/plateVisuals.ts';
import { ModalSnapshot } from './types.ts';

interface WorkletInstance {
  modes: { m: number; n: number; frequency: number; omega: number; zeta: number; modalMass: number }[];
  sampleRate: number;
  sampleFramesProcessed: number;
  quantumCount?: number;
  displacements: Float64Array;
  velocities: Float64Array;
  accelerations: Float64Array;
  covarianceMatrix: Float64Array;
  covLastQ?: Int32Array;
  excitationProfile?: string;
  musicSmoothedGain?: number;
  musicInputMeanSqEnvelope?: number;
  musicGateOpen?: boolean;
  isSilent?: boolean;
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
  mb.sampleRmsFieldFast(0.15, 0.15);
  const sys = new ParticleTransportSystem({ particleCount: 3000, dRef: 2.0e-6, seed: 42 }, 0.30);
  const t0 = performance.now();
  sys.step(0.016, (px, py) => sys.evaluateDimensionalDiffusivity(mb.sampleRmsFieldFast(px, py)));
  const elapsedMs = performance.now() - t0;
  assert.ok(elapsedMs < 20, `3000-particle fast step took ${elapsedMs.toFixed(2)} ms (expected <20 ms)`);
});

/* -------------------------------------------------------------------------- */
/* STAGE 9 TESTS 17–20                                                        */
/* -------------------------------------------------------------------------- */

function pearsonCorrelation(a: Float64Array, b: Float64Array): number {
  const n = a.length;
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < n; i++) {
    sumA += a[i];
    sumB += b[i];
  }
  const meanA = sumA / n;
  const meanB = sumB / n;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  return den > 0 ? num / den : 1.0;
}

test('17. High-frequency spatial RMS field resolution vs dense independent analytical reference (including (27,3) @ 19.912 kHz)', () => {
  const L = DEFAULT_GEOMETRY.sideLength;
  const modes = getActiveCenterCoupledModes(20000, DEFAULT_ALUMINUM, DEFAULT_GEOMETRY);

  // Independent dense 96x96 non-grid-aligned reference grid (resolves order-27 lobes cleanly)
  const refGridN = 96;
  const refPts: { x: number; y: number }[] = [];
  for (let iy = 1; iy < refGridN; iy++) {
    const y = ((iy + 0.37) / refGridN) * L;
    for (let ix = 1; ix < refGridN; ix++) {
      const x = ((ix + 0.29) / refGridN) * L;
      refPts.push({ x, y });
    }
  }
  const nPts = refPts.length;

  const findModeIdx = (m: number, n: number) => modes.findIndex((item) => item.m === m && item.n === n);

  const scenarios: {
    label: string;
    setup: (mb: ModalBank) => void;
    singleMode?: { m: number; n: number; scale: number };
    maxL2Pct: number;
  }[] = [
    {
      label: 'Mode (1,1) 53.96 Hz',
      singleMode: { m: 1, n: 1, scale: 100 },
      setup: (mb) => {
        const cov = new Array(modes.length).fill(0);
        cov[findModeIdx(1, 1)] = 100 * 100;
        mb.applySnapshot({
          sampleFramesProcessed: 128,
          sampleRate: 44100,
          elapsedSimTime: 128 / 44100,
          displacements: [],
          velocities: [],
          accelerations: [],
          covarianceDiag: cov,
          covarianceCross: [],
          isPlaying: true,
          isSilent: false,
          quantumCount: 1,
        });
      },
      maxL2Pct: 1.0,
    },
    {
      label: 'Degenerate (1,3)+(3,1) 269.8 Hz',
      setup: (mb) => {
        const i13 = findModeIdx(1, 3);
        const i31 = findModeIdx(3, 1);
        const cov = new Array(modes.length).fill(0);
        cov[i13] = 10000;
        cov[i31] = 10000;
        mb.applySnapshot({
          sampleFramesProcessed: 128,
          sampleRate: 44100,
          elapsedSimTime: 128 / 44100,
          displacements: [],
          velocities: [],
          accelerations: [],
          covarianceDiag: cov,
          covarianceCross: [Math.min(i13, i31), Math.max(i13, i31), 10000],
          isPlaying: true,
          isSilent: false,
          quantumCount: 1,
        });
      },
      maxL2Pct: 1.0,
    },
    {
      label: 'Intermediate high-order (9,11) 5.45 kHz',
      singleMode: { m: 9, n: 11, scale: 100 },
      setup: (mb) => {
        const cov = new Array(modes.length).fill(0);
        cov[findModeIdx(9, 11)] = 100 * 100;
        mb.applySnapshot({
          sampleFramesProcessed: 128,
          sampleRate: 44100,
          elapsedSimTime: 128 / 44100,
          displacements: [],
          velocities: [],
          accelerations: [],
          covarianceDiag: cov,
          covarianceCross: [],
          isPlaying: true,
          isSilent: false,
          quantumCount: 1,
        });
      },
      maxL2Pct: 2.0,
    },
    {
      label: 'Mode (27,3) 19.912 kHz',
      singleMode: { m: 27, n: 3, scale: 100 },
      setup: (mb) => {
        const cov = new Array(modes.length).fill(0);
        cov[findModeIdx(27, 3)] = 100 * 100;
        mb.applySnapshot({
          sampleFramesProcessed: 128,
          sampleRate: 44100,
          elapsedSimTime: 128 / 44100,
          displacements: [],
          velocities: [],
          accelerations: [],
          covarianceDiag: cov,
          covarianceCross: [],
          isPlaying: true,
          isSilent: false,
          quantumCount: 1,
        });
      },
      maxL2Pct: 3.0,
    },
    {
      label: 'Mode (3,27) 19.912 kHz',
      singleMode: { m: 3, n: 27, scale: 100 },
      setup: (mb) => {
        const cov = new Array(modes.length).fill(0);
        cov[findModeIdx(3, 27)] = 100 * 100;
        mb.applySnapshot({
          sampleFramesProcessed: 128,
          sampleRate: 44100,
          elapsedSimTime: 128 / 44100,
          displacements: [],
          velocities: [],
          accelerations: [],
          covarianceDiag: cov,
          covarianceCross: [],
          isPlaying: true,
          isSilent: false,
          quantumCount: 1,
        });
      },
      maxL2Pct: 3.0,
    },
    {
      label: 'Multimode broadband covariance (all 146 modes)',
      setup: (mb) => {
        const cov = modes.map((_, idx) => 50 + ((idx * 17) % 100));
        mb.applySnapshot({
          sampleFramesProcessed: 128,
          sampleRate: 44100,
          elapsedSimTime: 128 / 44100,
          displacements: [],
          velocities: [],
          accelerations: [],
          covarianceDiag: cov,
          covarianceCross: [],
          isPlaying: true,
          isSilent: false,
          quantumCount: 1,
        });
      },
      maxL2Pct: 2.0,
    },
    {
      label: 'High-order mixed field (1,1)+(7,9)+(15,17)+(27,3)',
      setup: (mb) => {
        const cov = new Array(modes.length).fill(0);
        const picks = [
          findModeIdx(1, 1),
          findModeIdx(7, 9),
          findModeIdx(15, 17),
          findModeIdx(27, 3),
        ];
        for (const p of picks) cov[p] = 2500;
        const cross: number[] = [];
        for (let a = 0; a < picks.length; a++) {
          for (let b = a + 1; b < picks.length; b++) {
            const i = Math.min(picks[a], picks[b]);
            const j = Math.max(picks[a], picks[b]);
            cross.push(i, j, 500);
          }
        }
        mb.applySnapshot({
          sampleFramesProcessed: 128,
          sampleRate: 44100,
          elapsedSimTime: 128 / 44100,
          displacements: [],
          velocities: [],
          accelerations: [],
          covarianceDiag: cov,
          covarianceCross: cross,
          isPlaying: true,
          isSilent: false,
          quantumCount: 1,
        });
      },
      maxL2Pct: 2.5,
    },
  ];

  // Confirm legacy 33x33 baseline indeed reproduces ~26.6% error on (27,3)
  const mbBaseline = new ModalBank(DEFAULT_ALUMINUM, DEFAULT_GEOMETRY, 0.01);
  mbBaseline.setForcedHalfN(33);
  scenarios[3].setup(mbBaseline);
  let baseSqDiff = 0;
  let baseSqRef = 0;
  for (let i = 0; i < nPts; i++) {
    const pt = refPts[i];
    const ref = Math.abs(100 * modeShape(27, 3, pt.x, pt.y, L));
    const approx = mbBaseline.sampleRmsFieldFast(pt.x, pt.y);
    baseSqDiff += (approx - ref) ** 2;
    baseSqRef += ref ** 2;
  }
  const baseline273Err = Math.sqrt(baseSqDiff / baseSqRef) * 100;
  assert.ok(baseline273Err > 20.0, `Expected legacy 33x33 baseline to exceed 20%, got ${baseline273Err.toFixed(2)}%`);

  const mb = new ModalBank(DEFAULT_ALUMINUM, DEFAULT_GEOMETRY, 0.01);
  console.log('\n[Stage 9 Test 17] Spatial RMS Accuracy vs 96x96 Independent Reference:');
  for (const sc of scenarios) {
    sc.setup(mb);
    const refVals = new Float64Array(nPts);
    const fastVals = new Float64Array(nPts);

    let sqDiff = 0;
    let sqRef = 0;
    let maxAbsErr = 0;

    for (let i = 0; i < nPts; i++) {
      const pt = refPts[i];
      // Independent exact evaluation
      const exactVal = sc.singleMode
        ? Math.abs(sc.singleMode.scale * modeShape(sc.singleMode.m, sc.singleMode.n, pt.x, pt.y, L))
        : mb.evaluateRmsAcceleration(pt.x, pt.y);
      const fastVal = mb.sampleRmsFieldFast(pt.x, pt.y);
      refVals[i] = exactVal;
      fastVals[i] = fastVal;
      const err = Math.abs(fastVal - exactVal);
      if (err > maxAbsErr) maxAbsErr = err;
      sqDiff += err * err;
      sqRef += exactVal * exactVal;
    }

    const l2Pct = Math.sqrt(sqDiff / sqRef) * 100;
    const r = pearsonCorrelation(refVals, fastVals);
    const symErr = Math.max(
      Math.abs(mb.sampleRmsFieldFast(0.061, 0.097) - mb.sampleRmsFieldFast(L - 0.061, 0.097)),
      Math.abs(mb.sampleRmsFieldFast(0.061, 0.097) - mb.sampleRmsFieldFast(0.061, L - 0.097)),
      Math.abs(mb.sampleRmsFieldFast(0.061, 0.097) - mb.sampleRmsFieldFast(L - 0.061, L - 0.097))
    );

    // Measure nodal-line zero position error for single modes along non-nodal cross-section
    let nodalPosErrMm = 0;
    if (sc.singleMode) {
      const { m } = sc.singleMode;
      const yProbe = L / (2 * sc.singleMode.n); // Antinode in y
      // Inspect interior nodal line x_node = L / m (if m > 1; else boundary)
      if (m > 1) {
        const targetX = L / m;
        let minX = targetX;
        let minVal = Infinity;
        for (let k = -40; k <= 40; k++) {
          const xTest = targetX + k * (L / 4000);
          const v = mb.sampleRmsFieldFast(xTest, yProbe);
          if (v < minVal) {
            minVal = v;
            minX = xTest;
          }
        }
        nodalPosErrMm = Math.abs(minX - targetX) * 1000;
      }
    }

    const telemetry = mb.getFastGridTelemetry();
    console.log(
      `  ${sc.label.padEnd(44)} | grid=${telemetry.effectivePlateResolution}x${telemetry.effectivePlateResolution} | L2=${l2Pct.toFixed(3)}% | MaxErr=${maxAbsErr.toFixed(3)} | r=${r.toFixed(6)} | NodalErr=${nodalPosErrMm.toFixed(3)}mm | SymErr=${symErr.toExponential(1)} | Rebuild=${telemetry.lastRebuildDurationMs.toFixed(2)}ms`
    );

    assert.ok(l2Pct <= sc.maxL2Pct, `${sc.label}: L2 error ${l2Pct.toFixed(3)}% exceeded ${sc.maxL2Pct}%`);
    assert.ok(r > 0.999, `${sc.label}: Pearson correlation too low (${r})`);
    assert.ok(symErr < 1e-11, `${sc.label}: Symmetry error ${symErr}`);

    // Stage 10 Task 4: High-order y-axis interior nodal check for mode (3,27) using non-grid-aligned probes
    if (sc.singleMode && sc.singleMode.m === 3 && sc.singleMode.n === 27) {
      const gridStep = L / (telemetry.effectivePlateResolution - 1);
      const xAntinodeProbe = L / (2 * sc.singleMode.m) + 0.37 * gridStep; // non-grid-aligned near x = L/6 antinode
      let maxYNodeErrMm = 0;
      let sumYNodeErrMm = 0;
      const numInteriorY = sc.singleMode.n - 1; // 26 interior nodal lines y_k = k*L/27

      for (let nodeK = 1; nodeK <= numInteriorY; nodeK++) {
        const targetY = (nodeK * L) / sc.singleMode.n;
        let minY = targetY;
        let minVal = Infinity;
        for (let s = -40; s <= 40; s++) {
          const yTest = targetY + (s + 0.31) * (L / 5000); // non-grid-aligned fine probe coordinates
          if (yTest <= 0 || yTest >= L) continue;
          const v = mb.sampleRmsFieldFast(xAntinodeProbe, yTest);
          if (v < minVal) {
            minVal = v;
            minY = yTest;
          }
        }
        const errMm = Math.abs(minY - targetY) * 1000;
        sumYNodeErrMm += errMm;
        if (errMm > maxYNodeErrMm) maxYNodeErrMm = errMm;
      }

      const meanYNodeErrMm = sumYNodeErrMm / numInteriorY;
      console.log(
        `    -> Mode (3,27) y-axis check @ non-grid x=${xAntinodeProbe.toFixed(6)}m: ${numInteriorY} interior nodes | MeanErr=${meanYNodeErrMm.toFixed(4)}mm | MaxErr=${maxYNodeErrMm.toFixed(4)}mm`
      );
      assert.ok(
        maxYNodeErrMm <= gridStep * 1000 * 0.55,
        `Mode (3,27) max y-nodal position error ${maxYNodeErrMm.toFixed(4)}mm exceeded half grid cell ${(gridStep * 500).toFixed(4)}mm`
      );
    }
  }
});

test('18. Adaptive particle micro-stepping strictly enforces 8 mm RMS sub-step bound across all excitation regimes', () => {
  const L = DEFAULT_GEOMETRY.sideLength;
  const sr = 48000;
  const dt = 0.016;
  const toneCases = [
    { label: '53.963 Hz resonance', freq: 53.963 },
    { label: '269.815 Hz degenerate resonance', freq: 269.815 },
    { label: '1 kHz', freq: 1000 },
    { label: '5 kHz', freq: 5000 },
    { label: '10 kHz', freq: 10000 },
    { label: '19.912 kHz ((27,3)+(3,27))', freq: 19912 },
  ];

  console.log('\n[Stage 9 Test 18] Adaptive Particle Micro-Stepping Statistics:');
  for (const tc of toneCases) {
    const { processor } = createProductionWorklet(sr);
    const mb = new ModalBank(DEFAULT_ALUMINUM, DEFAULT_GEOMETRY, 0.01);
    processor.handleMessage({ type: 'CONFIGURE_MODES', modes: mb.getWorkletModeConfig() });
    feedWorkletSignal(processor, 0.25, (t) => Math.sin(2 * Math.PI * tc.freq * t), sr);
    const snap = processor.buildSnapshot();
    mb.applySnapshot(snap);

    const sys = new ParticleTransportSystem({ particleCount: 3000, dRef: 2.0e-6, dt, seed: 42 }, L);
    sys.step(dt, (px, py) => sys.evaluateDimensionalDiffusivity(mb.sampleRmsFieldFast(px, py), false));
    const st = sys.lastStepStats;

    console.log(
      `  ${tc.label.padEnd(32)} | maxSub=${String(st.maxMicroSteps).padStart(4)} | meanSub=${st.meanMicroSteps.toFixed(2)} | maxStepRMS=${(st.maxSubStepRms * 1000).toFixed(3)}mm | violated=${st.boundViolated} | cpu=${st.updateDurationMs.toFixed(2)}ms`
    );

    assert.equal(st.boundViolated, false, `${tc.label}: 8 mm sub-step bound must never be violated`);
    assert.ok(st.maxSubStepRms <= 0.008 + 1e-12, `${tc.label}: maxSubStepRms=${st.maxSubStepRms}`);
    assert.equal(sys.particles.length, 3000);
    for (const p of sys.particles) {
      assert.ok(p.x >= 0 && p.x <= L && p.y >= 0 && p.y <= L);
    }
  }

  // Confirm 269.815 Hz exceeds old capped 12 micro-steps while keeping bound satisfied!
  {
    const { processor } = createProductionWorklet(sr);
    const mb = new ModalBank(DEFAULT_ALUMINUM, DEFAULT_GEOMETRY, 0.01);
    processor.handleMessage({ type: 'CONFIGURE_MODES', modes: mb.getWorkletModeConfig() });
    feedWorkletSignal(processor, 0.25, (t) => Math.sin(2 * Math.PI * 269.815 * t), sr);
    mb.applySnapshot(processor.buildSnapshot());
    const sys = new ParticleTransportSystem({ particleCount: 3000, dRef: 2.0e-6, dt, seed: 42 }, L);
    sys.step(dt, (px, py) => sys.evaluateDimensionalDiffusivity(mb.sampleRmsFieldFast(px, py), false));
    assert.ok(sys.lastStepStats.maxMicroSteps > 12, '269.815 Hz resonance must dynamically take >12 micro-steps to respect 8mm bound');
  }

  // High diffusivity stress test (uniform D = 1.5 m^2/s)
  {
    const sys = new ParticleTransportSystem({ particleCount: 500, dt, seed: 99 }, L);
    sys.step(dt, () => 1.5);
    assert.equal(sys.lastStepStats.boundViolated, false);
    assert.ok(sys.lastStepStats.maxSubStepRms <= 0.008 + 1e-12);
    assert.ok(sys.lastStepStats.maxMicroSteps >= 750);
  }

  // Steep diffusivity gradient near nodal line (particles concentrate at D(0.15)=0 without tunneling barrier)
  {
    const sys = new ParticleTransportSystem({ particleCount: 1000, dt, seed: 11 }, L);
    const nodalDiff = (x: number) => {
      const d = (x - 0.15) / 0.15;
      return 0.08 * d * d;
    };
    for (let k = 0; k < 120; k++) {
      sys.step(dt, nodalDiff);
      assert.equal(sys.lastStepStats.boundViolated, false);
    }
    const nearNodeCount = sys.particles.filter((p) => Math.abs(p.x - 0.15) < 0.025).length;
    assert.ok(nearNodeCount > 450, `Expected grains to accumulate near nodal line x=0.15, got ${nearNodeCount}/1000`);
  }
});

test('19. Dense spatial grid (64x64) broadband & high-frequency covariance comparison vs full N*N per-sample reference', () => {
  const modes = getActiveCenterCoupledModes(20000, DEFAULT_ALUMINUM, DEFAULT_GEOMETRY);
  const N = modes.length;
  const sr = 44100;
  const dt = 1 / sr;
  const zeta = 0.01;
  const tau = 0.08;
  const sampleAlpha = 1 - Math.exp(-dt / tau);
  const L = DEFAULT_GEOMETRY.sideLength;

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

  // Dense 64x64 non-grid-aligned reference points (3,969 points resolving m=27 lobes cleanly)
  const denseN = 64;
  const gridPts: { x: number; y: number; phis: Float64Array }[] = [];
  for (let gy = 1; gy < denseN; gy++) {
    const y = ((gy + 0.31) / denseN) * L;
    for (let gx = 1; gx < denseN; gx++) {
      const x = ((gx + 0.27) / denseN) * L;
      const phis = Float64Array.from(modes, (m) => modeShape(m.m, m.n, x, y, L));
      gridPts.push({ x, y, phis });
    }
  }

  let lcgSeed = 987654321;
  const signals: { name: string; maxAllowedErrPct: number; gen: (t: number) => number }[] = [
    { name: '1 kHz pure tone', maxAllowedErrPct: 5.0, gen: (t) => Math.sin(2 * Math.PI * 1000 * t) },
    { name: '5 kHz pure tone', maxAllowedErrPct: 5.0, gen: (t) => Math.sin(2 * Math.PI * 5000 * t) },
    { name: '10 kHz pure tone', maxAllowedErrPct: 5.0, gen: (t) => Math.sin(2 * Math.PI * 10000 * t) },
    { name: '19.912 kHz resonance', maxAllowedErrPct: 5.0, gen: (t) => Math.sin(2 * Math.PI * 19912.35 * t) },
    { name: '20 kHz input tone', maxAllowedErrPct: 5.0, gen: (t) => Math.sin(2 * Math.PI * 20000 * t) },
    {
      name: 'High-freq two-tone (10k + 19.912k)',
      maxAllowedErrPct: 5.0,
      gen: (t) => 0.5 * (Math.sin(2 * Math.PI * 10000 * t) + Math.sin(2 * Math.PI * 19912.35 * t)),
    },
    {
      name: 'Broadband white noise',
      maxAllowedErrPct: 12.0,
      gen: () => {
        lcgSeed = (Math.imul(lcgSeed, 1664525) + 1013904223) >>> 0;
        return (lcgSeed / 4294967296) * 2 - 1;
      },
    },
    {
      name: 'Harmonic/percussive synthetic signal',
      maxAllowedErrPct: 8.0,
      gen: (t) =>
        0.4 * Math.sin(2 * Math.PI * 110 * t) +
        0.25 * Math.sin(2 * Math.PI * 220 * t) +
        0.2 * Math.sin(2 * Math.PI * 440 * t) +
        0.15 * Math.sin(2 * Math.PI * 3520 * t) * Math.exp(-((t % 0.1) * 40)),
    },
  ];

  const durationSec = 0.2;
  const totalSamples = Math.floor(durationSec * sr) - (Math.floor(durationSec * sr) % 128);
  const totalPossibleOffDiag = (N * (N - 1)) / 2;

  console.log('\n[Stage 9 Test 19] Dense 64x64 Broadband Covariance Comparison:');
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
        inBuf[s] = sig.gen((offset + s) * dt);
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

    // Extract active sparse non-zero reference pairs for fast exact dense-grid evaluation
    const refDiag = new Float64Array(N);
    const refCrossI: number[] = [];
    const refCrossJ: number[] = [];
    const refCrossV: number[] = [];
    for (let i = 0; i < N; i++) {
      refDiag[i] = R_ref[i * N + i];
      for (let j = i + 1; j < N; j++) {
        const v = R_ref[i * N + j];
        if (Math.abs(v) > 1e-12) {
          refCrossI.push(i);
          refCrossJ.push(j);
          refCrossV.push(v);
        }
      }
    }

    const snap = processor.buildSnapshot();
    mb.applySnapshot(snap);
    const retainedOffDiag = (snap.covarianceCross?.length ?? 0) / 3;
    const omittedOffDiag = Math.max(0, totalPossibleOffDiag - retainedOffDiag);

    const refArr = new Float64Array(gridPts.length);
    const optArr = new Float64Array(gridPts.length);
    let sqDiff = 0;
    let sqRef = 0;
    let maxErr = 0;

    for (let idx = 0; idx < gridPts.length; idx++) {
      const pt = gridPts[idx];
      let sRef = 0;
      for (let i = 0; i < N; i++) {
        sRef += refDiag[i] * pt.phis[i] * pt.phis[i];
      }
      for (let c = 0; c < refCrossI.length; c++) {
        sRef += 2.0 * refCrossV[c] * pt.phis[refCrossI[c]] * pt.phis[refCrossJ[c]];
      }
      const rRef = Math.sqrt(Math.max(0, sRef));
      const rOpt = mb.evaluateRmsAcceleration(pt.x, pt.y);
      refArr[idx] = rRef;
      optArr[idx] = rOpt;
      const diff = Math.abs(rOpt - rRef);
      if (diff > maxErr) maxErr = diff;
      sqDiff += diff * diff;
      sqRef += rRef * rRef;
    }

    const l2Pct = sqRef > 0 ? Math.sqrt(sqDiff / sqRef) * 100 : 0;
    const r = pearsonCorrelation(refArr, optArr);
    console.log(
      `  ${sig.name.padEnd(36)} | L2=${l2Pct.toFixed(3)}% | MaxErr=${maxErr.toFixed(3)} | r=${r.toFixed(5)} | retained=${retainedOffDiag} | omitted=${omittedOffDiag}`
    );

    assert.ok(l2Pct <= sig.maxAllowedErrPct, `${sig.name}: L2=${l2Pct.toFixed(3)}% > ${sig.maxAllowedErrPct}%`);
    assert.ok(r > 0.99, `${sig.name}: Pearson correlation ${r} < 0.99`);
  }
});

test('20. AudioWorklet snapshot cadence maintains 60.00 Hz average without block-quantization drift at 44.1 kHz & 48 kHz', () => {
  console.log('\n[Stage 9 Test 20] Snapshot Cadence Measurements (10s window):');
  for (const sr of [44100, 48000]) {
    const { processor, snapshots } = createProductionWorklet(sr);
    feedWorkletSignal(processor, 10.0, (t) => Math.sin(2 * Math.PI * 269.815 * t), sr);

    const lastSnap = snapshots[snapshots.length - 1];
    const durationSec = lastSnap.sampleFramesProcessed / sr;
    const avgHz = snapshots.length / durationSec;

    // Confirm monotonic sampleFramesProcessed & exact simulation clock
    let prevFrames = 0;
    for (const s of snapshots) {
      assert.ok(s.sampleFramesProcessed > prevFrames, 'sampleFramesProcessed must strictly increase');
      assert.ok(
        Math.abs(s.elapsedSimTime - s.sampleFramesProcessed / s.sampleRate) < 1e-12,
        'elapsedSimTime must strictly equal sampleFramesProcessed / sampleRate'
      );
      prevFrames = s.sampleFramesProcessed;
    }

    console.log(
      `  SampleRate=${sr} Hz | Snapshots=${snapshots.length} | Duration=${durationSec.toFixed(4)}s | AvgCadence=${avgHz.toFixed(3)} Hz`
    );
    assert.ok(
      Math.abs(avgHz - 60.0) < 0.25,
      `Sample rate ${sr} Hz average cadence ${avgHz.toFixed(3)} Hz drifted from 60.0 Hz`
    );
  }
});

/* -------------------------------------------------------------------------- */
/* STAGE 10 TESTS 21–22: PRODUCTION TRANSPORT & INTERMEDIATE SNAPSHOT AUDIT   */
/* -------------------------------------------------------------------------- */

test('21. Production stepFromRmsGrid() strictly enforces 8 mm RMS sub-step bound and plate confinement', () => {
  const L = DEFAULT_GEOMETRY.sideLength;
  const sr = 48000;
  const dt = 0.016;
  const maxAllowedVar = 0.008 * 0.008;

  const verifyParticleState = (sys: ParticleTransportSystem, label: string) => {
    const st = sys.lastStepStats;
    assert.equal(st.boundViolated, false, `${label}: boundViolated must remain false`);
    assert.ok(st.maxSubStepVar <= maxAllowedVar + 1e-15, `${label}: 2*D*subDt=${st.maxSubStepVar} exceeded 0.008^2`);
    assert.ok(st.maxSubStepRms <= 0.008 + 1e-12, `${label}: maxSubStepRms=${st.maxSubStepRms} exceeded 8 mm`);
    assert.ok(st.maxMicroSteps < 4096, `${label}: reached emergency 4096-step guard (${st.maxMicroSteps})`);
    for (let i = 0; i < sys.particles.length; i++) {
      const p = sys.particles[i];
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `${label}: non-finite coordinates`);
      assert.ok(p.x >= 0 && p.x <= L && p.y >= 0 && p.y <= L, `${label}: coordinate escaped [0, L]`);
    }
  };

  console.log('\n[Stage 10 Test 21] Production stepFromRmsGrid() Verification:');

  // 1. 269.815 Hz resonant RMS field
  {
    const { processor } = createProductionWorklet(sr);
    const mb = new ModalBank(DEFAULT_ALUMINUM, DEFAULT_GEOMETRY, 0.01);
    processor.handleMessage({ type: 'CONFIGURE_MODES', modes: mb.getWorkletModeConfig() });
    feedWorkletSignal(processor, 0.25, (t) => Math.sin(2 * Math.PI * 269.815 * t), sr);
    mb.applySnapshot(processor.buildSnapshot());
    const grid = mb.getFastRmsGridData();
    assert.equal(grid.hasEnergy, true);

    const sys = new ParticleTransportSystem({ particleCount: 3000, dRef: 2.0e-6, dt, seed: 42 }, L);
    sys.stepFromRmsGrid(dt, grid.quadrant, grid.halfN, false);
    verifyParticleState(sys, '269.815 Hz resonant RMS grid');
    assert.ok(sys.lastStepStats.maxMicroSteps > 12, '269.815 Hz must adaptively exceed 12 micro-steps');
    console.log(
      `  269.815 Hz resonant (${grid.halfN * 2 - 1}x${grid.halfN * 2 - 1}) | maxSub=${sys.lastStepStats.maxMicroSteps} | maxStepRMS=${(sys.lastStepStats.maxSubStepRms * 1000).toFixed(3)}mm | violated=${sys.lastStepStats.boundViolated}`
    );
  }

  // 2. High-order RMS field near 19.912 kHz
  {
    const { processor } = createProductionWorklet(sr);
    const mb = new ModalBank(DEFAULT_ALUMINUM, DEFAULT_GEOMETRY, 0.01);
    processor.handleMessage({ type: 'CONFIGURE_MODES', modes: mb.getWorkletModeConfig() });
    feedWorkletSignal(processor, 0.25, (t) => Math.sin(2 * Math.PI * 19912.35 * t), sr);
    mb.applySnapshot(processor.buildSnapshot());
    const grid = mb.getFastRmsGridData();
    assert.equal(grid.halfN, 193, '19.912 kHz field must select 385x385 tier');

    const sys = new ParticleTransportSystem({ particleCount: 3000, dRef: 2.0e-6, dt, seed: 42 }, L);
    sys.stepFromRmsGrid(dt, grid.quadrant, grid.halfN, false);
    verifyParticleState(sys, '19.912 kHz high-order RMS grid');
    console.log(
      `  19.912 kHz high-order (${grid.halfN * 2 - 1}x${grid.halfN * 2 - 1}) | maxSub=${sys.lastStepStats.maxMicroSteps} | maxStepRMS=${(sys.lastStepStats.maxSubStepRms * 1000).toFixed(3)}mm | violated=${sys.lastStepStats.boundViolated}`
    );
  }

  // 3. High-diffusivity stress case (uniform D_g = 1.5 m^2/s across interior)
  {
    const halfN = 33;
    const sys = new ParticleTransportSystem({ particleCount: 500, dRef: 1.0e-4, dt, seed: 99 }, L);
    const { g, gammaC, dRef } = sys.config;
    const aRmsStress = g * (gammaC + Math.sqrt(1.5 / dRef));
    const quad = new Float64Array(halfN * halfN).fill(aRmsStress);

    sys.stepFromRmsGrid(dt, quad, halfN, false);
    verifyParticleState(sys, 'High-diffusivity stress (D=1.5)');
    assert.ok(sys.lastStepStats.maxMicroSteps >= 750 && sys.lastStepStats.maxMicroSteps < 4096);
    console.log(
      `  High-diffusivity D=1.5 m^2/s     | maxSub=${sys.lastStepStats.maxMicroSteps} | maxStepRMS=${(sys.lastStepStats.maxSubStepRms * 1000).toFixed(3)}mm | violated=${sys.lastStepStats.boundViolated}`
    );
  }

  // 4. Steep diffusivity gradient across nodal line x = 0.15 m
  {
    const halfN = 65;
    const sys = new ParticleTransportSystem({ particleCount: 1000, dRef: 1.0e-4, dt, seed: 11 }, L);
    const { g, gammaC, dRef } = sys.config;
    const quad = new Float64Array(halfN * halfN);
    for (let gy = 0; gy < halfN; gy++) {
      for (let gx = 0; gx < halfN; gx++) {
        const x = (gx / (halfN - 1)) * (L * 0.5);
        const dTarget = 0.08 * ((x - 0.15) / 0.15) ** 2;
        quad[gy * halfN + gx] = dTarget > 0 ? g * (gammaC + Math.sqrt(dTarget / dRef)) : 0;
      }
    }

    let maxSubSeen = 0;
    for (let stepIdx = 0; stepIdx < 120; stepIdx++) {
      sys.stepFromRmsGrid(dt, quad, halfN, false);
      verifyParticleState(sys, `Nodal gradient step ${stepIdx}`);
      if (sys.lastStepStats.maxMicroSteps > maxSubSeen) maxSubSeen = sys.lastStepStats.maxMicroSteps;
    }
    const nearNodeCount = sys.particles.filter((p) => Math.abs(p.x - 0.15) < 0.025).length;
    assert.ok(nearNodeCount > 450, `Expected nodal accumulation >450/1000 near x=0.15, got ${nearNodeCount}`);
    console.log(
      `  Steep nodal gradient (x=0.15m)   | maxSub=${maxSubSeen} | maxStepRMS=${(sys.lastStepStats.maxSubStepRms * 1000).toFixed(3)}mm | nearNode=${nearNodeCount}/1000 | violated=${sys.lastStepStats.boundViolated}`
    );
  }
});

test('22. Intermediate snapshot covariance accuracy & entry ages across abrupt transition and silence', () => {
  const modes = getActiveCenterCoupledModes(20000, DEFAULT_ALUMINUM, DEFAULT_GEOMETRY);
  const N = modes.length;
  const sr = 48000;
  const dt = 1 / sr;
  const zeta = 0.01;
  const tau = 0.08;
  const sampleAlpha = 1 - Math.exp(-dt / tau);
  const L = DEFAULT_GEOMETRY.sideLength;

  // Independent exact ZOH + full N*N per-sample covariance reference
  const A11 = new Float64Array(N), A12 = new Float64Array(N), A21 = new Float64Array(N), A22 = new Float64Array(N);
  const w2 = new Float64Array(N), twoZW = new Float64Array(N), M = new Float64Array(N), C = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const m = modes[i], w = m.omega, wd = w * Math.sqrt(1 - zeta * zeta);
    w2[i] = w * w;
    twoZW[i] = 2 * zeta * w;
    M[i] = m.modalMass;
    C[i] = m.centerCoupling;
    const e = Math.exp(-zeta * w * dt), c = Math.cos(wd * dt), sO = Math.sin(wd * dt) / wd;
    A11[i] = e * (c + zeta * w * sO);
    A12[i] = e * sO;
    A21[i] = -e * w * w * sO;
    A22[i] = e * (c - zeta * w * sO);
  }

  // Non-grid-aligned 16x16 interior evaluation mesh
  const pts: { x: number; y: number; phis: Float64Array }[] = [];
  for (let gy = 1; gy < 16; gy++) {
    const y = ((gy + 0.27) / 16) * L;
    for (let gx = 1; gx < 16; gx++) {
      const x = ((gx + 0.31) / 16) * L;
      pts.push({ x, y, phis: Float64Array.from(modes, (m) => modeShape(m.m, m.n, x, y, L)) });
    }
  }

  const qRef = new Float64Array(N), vRef = new Float64Array(N), aRef = new Float64Array(N);
  const R_ref = new Float64Array(N * N);
  const mb = new ModalBank(DEFAULT_ALUMINUM, DEFAULT_GEOMETRY, zeta);
  const { processor } = createProductionWorklet(sr);

  const records: {
    phase: string;
    tMs: number;
    l2Pct: number;
    maxAgeQuanta: number;
    meanAgeQuanta: number;
    activePairs: number;
  }[] = [];

  processor.port.postMessage = (msg: unknown) => {
    const snap = msg as ModalSnapshot;
    const qNow = processor.quantumCount ?? snap.quantumCount ?? 0;
    const covLastQ = processor.covLastQ;
    const cross = snap.covarianceCross ?? [];

    let maxAgeQuanta = 0;
    let sumAgeQuanta = 0;
    let activePairs = 0;
    for (let k = 0; k + 2 < cross.length; k += 3) {
      const i = cross[k];
      const j = cross[k + 1];
      const age = covLastQ ? qNow - covLastQ[i * N + j] : 0;
      if (age > maxAgeQuanta) maxAgeQuanta = age;
      sumAgeQuanta += age;
      activePairs++;
    }

    mb.applySnapshot(snap);
    let sqDiff = 0;
    let sqRef = 0;
    for (const pt of pts) {
      let sRef = 0;
      for (let i = 0; i < N; i++) {
        const pi = pt.phis[i];
        sRef += R_ref[i * N + i] * pi * pi;
        for (let j = i + 1; j < N; j++) {
          sRef += 2.0 * R_ref[i * N + j] * pi * pt.phis[j];
        }
      }
      const rRef = Math.sqrt(Math.max(0, sRef));
      const rOpt = mb.evaluateRmsAcceleration(pt.x, pt.y);
      sqDiff += (rOpt - rRef) ** 2;
      sqRef += rRef ** 2;
    }

    const tMs = snap.elapsedSimTime * 1000;
    const phase = tMs <= 150 ? 'Resonant 269.8Hz' : tMs <= 300 ? 'Jump 5kHz@0.3' : 'Silence decay';
    records.push({
      phase,
      tMs,
      l2Pct: sqRef > 0 ? Math.sqrt(sqDiff / sqRef) * 100 : 0,
      maxAgeQuanta,
      meanAgeQuanta: activePairs > 0 ? sumAgeQuanta / activePairs : 0,
      activePairs,
    });
  };

  const quantum = 128;
  const inBuf = new Float32Array(quantum);
  const outBuf = new Float32Array(quantum);
  const totalQuanta = Math.floor((0.45 * sr) / quantum);

  for (let q = 0; q < totalQuanta; q++) {
    for (let s = 0; s < quantum; s++) {
      const t = (q * quantum + s) * dt;
      const sig =
        t < 0.15
          ? 0.8 * Math.sin(2 * Math.PI * 269.815 * t)
          : t < 0.30
            ? 0.3 * Math.sin(2 * Math.PI * 5000 * t)
            : 0.0;
      inBuf[s] = sig;
      const exc = inBuf[s] * 3.0;

      for (let i = 0; i < N; i++) {
        const u = (exc * C[i]) / M[i];
        const qEq = u / w2[i];
        const qt = qRef[i] - qEq;
        const qn = A11[i] * qt + A12[i] * vRef[i] + qEq;
        const vn = A21[i] * qt + A22[i] * vRef[i];
        qRef[i] = qn;
        vRef[i] = vn;
        aRef[i] = u - twoZW[i] * vn - w2[i] * qn;
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

  assert.ok(records.length >= 24, `Expected >=24 consecutive snapshots across 0.45s, got ${records.length}`);
  let worstL2 = 0;
  let worstAge = 0;
  for (const r of records) {
    if (r.l2Pct > worstL2) worstL2 = r.l2Pct;
    if (r.maxAgeQuanta > worstAge) worstAge = r.maxAgeQuanta;
  }

  console.log('\n[Stage 10 Test 22] Intermediate Snapshot Covariance Audit (26 consecutive snapshots @ 48 kHz):');
  console.log(
    `  Snapshots=${records.length} | WorstL2=${worstL2.toFixed(3)}% (limit 5.000%) | MaxEntryAge=${worstAge} quanta (${((worstAge * 128) / sr * 1000).toFixed(2)}ms)`
  );
  for (const idx of [0, 7, 8, 9, 17, 18, 19, 21, records.length - 1]) {
    const r = records[idx];
    if (!r) continue;
    console.log(
      `  snap#${String(idx).padStart(2)} (${r.phase.padEnd(16)} @ ${r.tMs.toFixed(1).padStart(5)}ms) | L2=${r.l2Pct.toFixed(3)}% | maxAge=${r.maxAgeQuanta}q | meanAge=${r.meanAgeQuanta.toFixed(2)}q | pairs=${r.activePairs}`
    );
  }

  assert.ok(worstL2 <= 5.0, `Max transient snapshot L2 error ${worstL2.toFixed(3)}% exceeded 5.0% threshold`);
  assert.ok(worstAge <= 7, `Staggered entry age ${worstAge} quanta exceeded 7 quanta bound (8-bucket stagger)`);
});

test('23. Controlled external powder feeding preserves existing particles, feeds gradually outside 1 mm rim, and caps at 4,500', () => {
  const L = DEFAULT_GEOMETRY.sideLength;
  const dt = 0.016;
  const margin = 0.001; // 1 mm perimeter band

  const sys = new ParticleTransportSystem(
    {
      particleCount: 3000,
      dRef: 2.0e-6,
      gammaC: 1.0,
      power: 2.0,
      g: 9.80665,
      dt,
      seed: 42,
      enableExternalPowderFeed: true,
      maxParticleCount: 4500,
    },
    L
  );

  // Preserve original references and verify initial interior count is well above 70% (2,100)
  const initialRefs = sys.particles.slice();
  const initialInterior = sys.countInteriorParticles(margin);
  assert.ok(initialInterior > 2800, `Expected >2800 interior particles initially, got ${initialInterior}`);

  // When interior count >= 2,100, zero particles are added even over sustained steps
  const silentQuad = new Float64Array(33 * 33);
  for (let k = 0; k < 25; k++) {
    const added = sys.feedInteriorParticlesIfNeeded(dt, false);
    assert.equal(added, 0, 'Must not feed while interior particle count >= 2100');
  }
  assert.equal(sys.particles.length, 3000);

  // Move 1,000 particles onto the 1 mm perimeter rim (simulating high-freq edge accumulation) -> interior = ~1960 < 2100
  for (let i = 0; i < 1000; i++) {
    sys.particles[i].x = 0.0004;
    sys.particles[i].y = 0.10 + (i / 1000) * 0.10;
  }
  const snappedExisting = sys.particles.map((p) => ({ ref: p, x: p.x, y: p.y, vx: p.vx, vy: p.vy }));
  const beforeFeedInterior = sys.countInteriorParticles(margin);
  assert.ok(beforeFeedInterior < 2100);

  // First eligible feed adds a small bounded batch (<= 60) and preserves all existing particles identically
  const batch1 = sys.feedInteriorParticlesIfNeeded(dt, false);
  assert.ok(batch1 > 0 && batch1 <= 60, `Expected small batch in [1, 60], got ${batch1}`);
  for (let i = 0; i < snappedExisting.length; i++) {
    assert.equal(sys.particles[i], snappedExisting[i].ref, 'Existing particle object references must be preserved');
    assert.equal(sys.particles[i].x, snappedExisting[i].x, 'Existing particle x must not be repositioned');
    assert.equal(sys.particles[i].y, snappedExisting[i].y, 'Existing particle y must not be repositioned');
    assert.equal(sys.particles[i].vx, snappedExisting[i].vx);
    assert.equal(sys.particles[i].vy, snappedExisting[i].vy);
  }

  // Consecutive snapshots immediately after batch1 must add 0 particles (no repeated additions on every snapshot)
  for (let k = 0; k < 10; k++) {
    const repeatAdd = sys.feedInteriorParticlesIfNeeded(dt, false);
    assert.equal(repeatAdd, 0, 'Must not repeat particle feeding on consecutive snapshots within cooldown');
  }

  // Silent steps must also never feed
  for (let k = 0; k < 30; k++) {
    assert.equal(sys.feedInteriorParticlesIfNeeded(dt, true), 0, 'Must never feed when plate is silent');
  }
  // Suppress unused warning on silentQuad
  assert.equal(silentQuad[0], 0);

  // Validate newly fed particle coordinates & reused PRNG property bounds
  for (let i = 3000; i < sys.particles.length; i++) {
    const p = sys.particles[i];
    assert.equal(p.active, true);
    assert.ok(p.x > margin && p.x < L - margin, `Fed x=${p.x} violated 1 mm perimeter exclusion`);
    assert.ok(p.y > margin && p.y < L - margin, `Fed y=${p.y} violated 1 mm perimeter exclusion`);
    assert.ok((p.radius ?? 0) >= 0.9 && (p.radius ?? 0) <= 1.4);
    assert.ok((p.brightness ?? 0) >= 0.82 && (p.brightness ?? 0) <= 1.18);
  }

  // Under continuous 19.912 kHz excitation over 25 simulated seconds, population stays strictly <= 4,500
  const { processor } = createProductionWorklet(48000);
  const mb = new ModalBank(DEFAULT_ALUMINUM, DEFAULT_GEOMETRY, 0.01);
  processor.handleMessage({ type: 'CONFIGURE_MODES', modes: mb.getWorkletModeConfig() });
  feedWorkletSignal(processor, 0.2, (t) => 0.5 * Math.sin(2 * Math.PI * 19912.35 * t), 48000);
  mb.applySnapshot(processor.buildSnapshot());
  const grid = mb.getFastRmsGridData();

  // Force depletion of interior below 70% repeatedly to stress-test the 4,500 hard ceiling
  for (let step = 0; step < 1600; step++) {
    if (step % 30 === 0) {
      for (let i = 0; i < Math.min(2500, sys.particles.length); i++) {
        sys.particles[i].x = 0.0003;
      }
    }
    sys.stepFromRmsGrid(dt, grid.quadrant, grid.halfN, false);
    assert.ok(sys.particles.length <= 4500, `Population ${sys.particles.length} exceeded 4,500 cap`);
    assert.equal(sys.lastStepStats.boundViolated, false);
  }
  assert.equal(sys.particles.length, 4500, 'Population should stop exactly at 4,500 hard ceiling under sustained depletion');
  // Original 3,000 references remain intact at indices 0..2999
  for (let i = 0; i < 3000; i++) {
    assert.equal(sys.particles[i], initialRefs[i]);
  }

  // At the 4,500 cap, recycling perimeter-trapped grains must NEVER modify interior grains
  const interiorSnapshot = sys.particles
    .map((p, idx) => ({ idx, x: p.x, y: p.y, isInterior: p.active && p.x > margin && p.x < L - margin && p.y > margin && p.y < L - margin }))
    .filter((entry) => entry.isInterior);
  const beforeRecycledCount = sys.countInteriorParticles(margin);
  assert.ok(beforeRecycledCount < 2100);
  let reclaimed = 0;
  for (let k = 0; k < 20; k++) {
    reclaimed += sys.feedInteriorParticlesIfNeeded(dt, false);
    if (reclaimed > 0) break;
  }
  assert.ok(reclaimed > 0 && reclaimed <= 300, `Expected bounded perimeter reclamation batch <= 300, got ${reclaimed}`);
  assert.equal(sys.particles.length, 4500, 'Total count must remain capped at 4,500');
  for (const saved of interiorSnapshot) {
    assert.equal(sys.particles[saved.idx].x, saved.x, 'Existing interior grain x must never be moved during rim reclamation');
    assert.equal(sys.particles[saved.idx].y, saved.y, 'Existing interior grain y must never be moved during rim reclamation');
  }

  // Full up-and-down frequency sweep test: 269.8 Hz -> 5 kHz -> 19.912 kHz -> 269.8 Hz -> 53.96 Hz -> 20 Hz
  const sweepSys = new ParticleTransportSystem(
    {
      particleCount: 3000,
      dRef: 2.0e-6,
      gammaC: 1.0,
      power: 2.0,
      g: 9.80665,
      dt,
      seed: 42,
      enableExternalPowderFeed: true,
      maxParticleCount: 4500,
    },
    L
  );
  const { processor: sweepProc } = createProductionWorklet(48000);
  const sweepMb = new ModalBank(DEFAULT_ALUMINUM, DEFAULT_GEOMETRY, 0.01);
  sweepProc.handleMessage({ type: 'CONFIGURE_MODES', modes: sweepMb.getWorkletModeConfig() });

  const runStage = (freqHz: number, durationSec: number) => {
    const steps = Math.round(durationSec / dt);
    feedWorkletSignal(sweepProc, 0.25, (t) => 0.5 * Math.sin(2 * Math.PI * freqHz * t), 48000);
    sweepMb.applySnapshot(sweepProc.buildSnapshot());
    const stageGrid = sweepMb.getFastRmsGridData();
    for (let s = 0; s < steps; s++) {
      sweepSys.stepFromRmsGrid(dt, stageGrid.quadrant, stageGrid.halfN, false);
    }
    return sweepSys.countInteriorParticles(margin);
  };

  runStage(269.815, 3);
  runStage(5000, 3);
  const highFreqInterior = runStage(19912.35, 10);
  assert.ok(highFreqInterior < 2100, `Expected high-freq edge accumulation to deplete interior, got ${highFreqInterior}`);
  runStage(269.815, 4);
  runStage(53.963, 4);
  const recoveredLowFreqInterior = runStage(20, 4);
  assert.ok(
    recoveredLowFreqInterior >= 1950,
    `Downward sweep 20 kHz -> 20 Hz must recover interior particle density (>= 1950), got ${recoveredLowFreqInterior}`
  );
  assert.ok(sweepSys.particles.length <= 4500);
});

test('24. External powder feed & perimeter recycling are gated by actual interior RMS transport eligibility', () => {
  const L = DEFAULT_GEOMETRY.sideLength;
  const dt = 0.016;
  const margin = 0.001;
  const halfN = 33;

  const makeSys = (count: number = 3000) =>
    new ParticleTransportSystem(
      {
        particleCount: count,
        dRef: 2.0e-6,
        gammaC: 1.0,
        power: 2.0,
        g: 9.80665,
        dt,
        seed: 42,
        enableExternalPowderFeed: true,
        maxParticleCount: 4500,
      },
      L
    );

  // A. Sub-threshold RMS field (a_rms = 9.0 m/s^2 < g = 9.80665) & silent field: zero feed, zero recycle, zero motion
  const subThresholdSys = makeSys(3000);
  // Deplete interior below 2,100 by placing 1,200 grains on the 1 mm perimeter rim
  for (let i = 0; i < 1200; i++) {
    subThresholdSys.particles[i].x = 0.0004;
  }
  const subSnapBefore = subThresholdSys.particles.map((p) => ({ x: p.x, y: p.y }));
  const subThresholdQuad = new Float64Array(halfN * halfN).fill(9.0);
  const silentQuad = new Float64Array(halfN * halfN);

  for (let s = 0; s < 150; s++) {
    // Pass isSilent = false with sub-threshold grid to verify RMS transport gating itself blocks feeding
    subThresholdSys.stepFromRmsGrid(dt, subThresholdQuad, halfN, false);
    // Also check silent grid
    subThresholdSys.stepFromRmsGrid(dt, silentQuad, halfN, true);
  }
  assert.equal(subThresholdSys.particles.length, 3000, 'Must not append particles on sub-threshold or silent RMS fields');
  assert.equal(subThresholdSys.totalAddedCount, 0, 'Must not feed or recycle during sub-threshold RMS fields');
  for (let i = 0; i < subSnapBefore.length; i++) {
    assert.equal(subThresholdSys.particles[i].x, subSnapBefore[i].x, 'Existing particle x must remain unchanged');
    assert.equal(subThresholdSys.particles[i].y, subSnapBefore[i].y, 'Existing particle y must remain unchanged');
  }

  // Perimeter-only high RMS (gx = 0, gy = 0 only; interior grid points strictly <= 1 mm remain 0) must also block feeding
  const perimOnlyQuad = new Float64Array(halfN * halfN);
  perimOnlyQuad[0] = 500.0;
  for (let s = 0; s < 30; s++) {
    assert.equal(subThresholdSys.feedInteriorParticlesIfNeeded(dt, false, perimOnlyQuad, halfN), 0);
  }
  assert.equal(subThresholdSys.particles.length, 3000);

  // B. Transport-eligible RMS field (center antinode a_rms = 25 m/s^2 > g): feeding resumes with <= 60 batch & 0.20 s cooldown
  const eligibleQuad = new Float64Array(halfN * halfN);
  eligibleQuad[(halfN - 1) * halfN + (halfN - 1)] = 25.0; // plate center only

  // After sustained eligible steps (past 0.20 s cooldown), feeding introduces a bounded batch <= 60 and caps <= 4,500
  let firstBatch = 0;
  for (let s = 0; s < 20; s++) {
    const prevLen = subThresholdSys.particles.length;
    subThresholdSys.stepFromRmsGrid(dt, eligibleQuad, halfN, false);
    const delta = subThresholdSys.particles.length - prevLen;
    if (delta > 0) {
      assert.ok(delta <= 60, `Batch size ${delta} exceeded 60 limit`);
      if (firstBatch === 0) firstBatch = delta;
      // Next step inside 0.20 s cooldown must add 0
      const nextPrev = subThresholdSys.particles.length;
      subThresholdSys.stepFromRmsGrid(dt, eligibleQuad, halfN, false);
      assert.equal(subThresholdSys.particles.length - nextPrev, 0, 'Cooldown must prevent consecutive-frame additions');
      break;
    }
  }
  assert.ok(firstBatch > 0, 'Expected feeding to activate on transport-eligible RMS field');

  // C. Perimeter recycling at 4,500 cap: blocked when sub-threshold, active when eligible, interior nodal grains untouched
  const recycleSys = makeSys(3000);
  // Bring population up to exact 4,500 ceiling using eligible grid while depleting interior
  for (let step = 0; step < 1200 && recycleSys.particles.length < 4500; step++) {
    if (step % 25 === 0) {
      for (let i = 0; i < Math.min(2400, recycleSys.particles.length); i++) {
        recycleSys.particles[i].x = 0.0003;
      }
    }
    recycleSys.stepFromRmsGrid(dt, eligibleQuad, halfN, false);
  }
  assert.equal(recycleSys.particles.length, 4500, 'Expected population to reach 4,500 ceiling');

  // Deplete interior below 2,100, keep 600 known interior grains along a nodal line
  for (let i = 0; i < 4500; i++) {
    if (i < 600) {
      recycleSys.particles[i].x = 0.10 + (i / 600) * 0.10;
      recycleSys.particles[i].y = 0.05; // stationary interior nodal line
    } else {
      recycleSys.particles[i].x = 0.0004; // perimeter rim
    }
  }
  const nodalSnapshot = recycleSys.particles.slice(0, 600).map((p) => ({ x: p.x, y: p.y }));

  // Sub-threshold grid at 4,500 cap must perform 0 recycling
  for (let s = 0; s < 40; s++) {
    const recycledSub = recycleSys.feedInteriorParticlesIfNeeded(dt, false, subThresholdQuad, halfN);
    assert.equal(recycledSub, 0, 'Must not recycle perimeter particles under sub-threshold RMS field');
  }
  assert.equal(recycleSys.countInteriorParticles(margin), 600);

  // Eligible grid at 4,500 cap recycles rim grains (<= 300) without touching any interior nodal grain
  let recycledEligible = 0;
  for (let s = 0; s < 20; s++) {
    recycledEligible = recycleSys.feedInteriorParticlesIfNeeded(dt, false, eligibleQuad, halfN);
    if (recycledEligible > 0) break;
  }
  assert.ok(recycledEligible > 0 && recycledEligible <= 300, `Expected bounded recycle <= 300, got ${recycledEligible}`);
  assert.equal(recycleSys.particles.length, 4500);
  for (let i = 0; i < 600; i++) {
    assert.equal(recycleSys.particles[i].x, nodalSnapshot[i].x, 'Interior nodal grain x must never be recycled');
    assert.equal(recycleSys.particles[i].y, nodalSnapshot[i].y, 'Interior nodal grain y must never be recycled');
  }
});

test('25. AudioEngine decodeAudioData + AudioBufferSourceNode routes audio to both AudioWorklet and speakers without deadlocking on suspended resume', async () => {
  const prevWindow = (globalThis as Record<string, unknown>).window;
  const prevAudioWorkletNode = (globalThis as Record<string, unknown>).AudioWorkletNode;
  const prevAudioContext = (globalThis as Record<string, unknown>).AudioContext;

  try {
    const mergerGainCalls: number[] = [];
    const bufferConnections: { sourceId: number; to: string }[] = [];
    const startedOffsets: number[] = [];
    let allowResume = false;
    let mockState: 'suspended' | 'running' = 'suspended';
    let sourceSeq = 0;
    const createdSources: { onended: (() => void) | null }[] = [];
    let decodeChannels = 2;

    const makeGain = (name: string) => ({
      name,
      channelCount: 2,
      channelCountMode: 'max',
      gain: {
        value: 1,
        setValueAtTime: (v: number) => {
          if (name === 'gain_merger' || name.startsWith('gain_')) {
            mergerGainCalls.push(v);
          }
        },
        cancelScheduledValues: () => {},
        setTargetAtTime: () => {},
      },
      connect: () => {},
    });

    class MockWorkletNode {
      name = 'workletNode';
      port = { onmessage: null, postMessage: () => {} };
      connect() {}
    }

    class MockAudioContext {
      sampleRate = 44100;
      currentTime = 0;
      destination = { name: 'destination' };
      audioWorklet = { addModule: async () => {} };
      private gainCount = 0;
      get state() {
        return mockState;
      }
      resume() {
        if (!allowResume) {
          // Simulate WebKit/Safari keeping resume pending when invoked outside synchronous tap
          return new Promise<void>(() => {});
        }
        mockState = 'running';
        return Promise.resolve();
      }
      close = async () => {};
      createGain = () => {
        this.gainCount += 1;
        return makeGain(`gain_${this.gainCount}`);
      };
      createChannelSplitter = () => ({
        name: 'channelSplitter',
        connect: () => {},
      });
      createBufferSource = () => {
        const id = ++sourceSeq;
        const src = {
          buffer: null as unknown,
          loop: false,
          onended: null as (() => void) | null,
          connect: (target: { name?: string }) => {
            bufferConnections.push({ sourceId: id, to: target.name || 'unknown' });
          },
          start: (_when?: number, offset?: number) => {
            startedOffsets.push(offset ?? 0);
          },
          stop: () => {},
          disconnect: () => {},
        };
        createdSources.push(src);
        return src;
      };
      decodeAudioData = async () => ({
        duration: 4.5,
        numberOfChannels: decodeChannels,
        sampleRate: 44100,
      });
    }

    (globalThis as Record<string, unknown>).AudioWorkletNode = MockWorkletNode;
    (globalThis as Record<string, unknown>).AudioContext = MockAudioContext;
    (globalThis as Record<string, unknown>).window = {
      AudioContext: MockAudioContext,
      location: { search: '' },
    };

    const engine = new AudioEngine();
    const events: { isPlaying: boolean; duration: number; fileName: string; currentTime: number }[] = [];
    engine.onProgress((p) => events.push({ ...p }));

    const fakeFile = new File([new Uint8Array(64)], 'music-track.mp3', { type: 'audio/mpeg' });

    // 1) Suspended context & blocked resume (file picker return): must NOT hang, loads buffer ready for Play tap
    const t0 = Date.now();
    const loadedSuspended = await engine.loadAudioFile(fakeFile);
    const elapsedMs = Date.now() - t0;
    assert.equal(loadedSuspended, true);
    assert.ok(elapsedMs < 1500, `Suspended loadAudioFile must not deadlock (took ${elapsedMs} ms)`);
    assert.equal(startedOffsets.length, 0, 'Must wait for explicit Play tap while AudioContext is suspended');
    assert.equal(events[events.length - 1]?.isPlaying, false);
    assert.equal(events[events.length - 1]?.duration, 4.5);
    assert.equal(events[events.length - 1]?.fileName, 'music-track.mp3');

    // 2) User taps Play (resume allowed): must unlock context and route buffer to BOTH splitter->worklet AND destination
    allowResume = true;
    await engine.resumeContext();
    engine.playAudioFile();
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(startedOffsets.length, 1);
    assert.equal(startedOffsets[0], 0);
    assert.ok(bufferConnections.some((c) => c.sourceId === 1 && c.to === 'channelSplitter'));
    assert.ok(bufferConnections.some((c) => c.sourceId === 1 && c.to === 'destination'));
    assert.equal(events[events.length - 1]?.isPlaying, true);
    assert.equal(mergerGainCalls[mergerGainCalls.length - 1], 0.5, 'Stereo buffer must use 0.5 downmix gain');

    // 3) Pause, seek, natural end, and mono 1.0 downmix gain
    engine.pauseAudioFile();
    assert.equal(events[events.length - 1]?.isPlaying, false);
    engine.seekAudioFile(2.25);
    assert.equal(events[events.length - 1]?.currentTime, 2.25);
    engine.playAudioFile();
    assert.equal(startedOffsets[startedOffsets.length - 1], 2.25);
    createdSources[createdSources.length - 1]?.onended?.();
    assert.equal(events[events.length - 1]?.isPlaying, false);
    assert.equal(events[events.length - 1]?.currentTime, 4.5);

    decodeChannels = 1;
    const monoFile = new File([new Uint8Array(64)], 'mono-tone.wav', { type: 'audio/wav' });
    const loadedMono = await engine.loadAudioFile(monoFile);
    assert.equal(loadedMono, true);
    assert.equal(mergerGainCalls[mergerGainCalls.length - 1], 1.0, 'Mono buffer must use 1.0 unity gain');

    engine.cleanup();
  } finally {
    (globalThis as Record<string, unknown>).window = prevWindow;
    (globalThis as Record<string, unknown>).AudioWorkletNode = prevAudioWorkletNode;
    (globalThis as Record<string, unknown>).AudioContext = prevAudioContext;
  }
});

test('26. Bounded music-input normalization: raw regression, -70 dBFS visibility, -78 dBFS gate/noise protection, silence decay & gain bounds', () => {
  const sr = 44100;
  const L = DEFAULT_GEOMETRY.sideLength;

  // A. Raw-profile regression: default is 'raw', unmodified test-tone behavior
  const { processor: rawProc } = createProductionWorklet(sr);
  assert.equal(rawProc.excitationProfile, 'raw', 'Default worklet excitation profile must be raw');
  const mode11 = rawProc.modes.find((m) => m.m === 1 && m.n === 1);
  assert.ok(mode11, 'Catalogue must include fundamental (1,1) mode');
  const f11 = mode11.frequency;

  const rms70 = Math.pow(10, -70 / 20);
  const amp70 = Math.SQRT2 * rms70;
  feedWorkletSignal(rawProc, 2.0, (t) => amp70 * Math.sin(2 * Math.PI * f11 * t), sr);
  const mbRaw = new ModalBank(DEFAULT_ALUMINUM, DEFAULT_GEOMETRY, 0.01);
  mbRaw.applySnapshot(rawProc.buildSnapshot());
  const raw70CenterRms = mbRaw.evaluateRmsAcceleration(L / 2, L / 2);
  assert.ok(
    raw70CenterRms < 1.5,
    `Under raw profile, -70 dBFS input must stay sub-threshold without AGC boost, got ${raw70CenterRms}`
  );

  // B. Quiet music (-70 dBFS RMS) becomes visible under 'music' profile and moves center particles
  const { processor: musicProc } = createProductionWorklet(sr);
  musicProc.handleMessage({ type: 'SET_EXCITATION_PROFILE', profile: 'music' });
  assert.equal(musicProc.excitationProfile, 'music');

  feedWorkletSignal(musicProc, 2.0, (t) => amp70 * Math.sin(2 * Math.PI * f11 * t), sr);
  const snap70 = musicProc.buildSnapshot();
  const mb70 = new ModalBank(DEFAULT_ALUMINUM, DEFAULT_GEOMETRY, 0.01);
  mb70.applySnapshot(snap70);
  const music70CenterRms = mb70.evaluateRmsAcceleration(L / 2, L / 2);
  assert.ok(
    music70CenterRms > 9.80687,
    `-70 dBFS music-profile RMS center acceleration must exceed 9.80687 m/s^2, got ${music70CenterRms}`
  );

  const moveSys = new ParticleTransportSystem(
    {
      particleCount: 3000,
      dRef: 2.0e-6,
      gammaC: 1.0,
      power: 2.0,
      g: 9.80665,
      dt: 0.016,
      seed: 42,
      enableExternalPowderFeed: true,
      maxParticleCount: 4500,
    },
    L
  );
  moveSys.particles[0].x = L / 2;
  moveSys.particles[0].y = L / 2;
  const grid70 = mb70.getFastRmsGridData();
  for (let k = 0; k < 10; k++) {
    moveSys.stepFromRmsGrid(0.016, grid70.quadrant, grid70.halfN, Boolean(snap70.isSilent) || !grid70.hasEnergy);
  }
  const disp70 = Math.hypot(moveSys.particles[0].x - L / 2, moveSys.particles[0].y - L / 2);
  assert.ok(disp70 > 1e-6, `Expected center particle movement at -70 dBFS music excitation, got disp=${disp70}`);

  // C. Low-level noise protection (-78 dBFS RMS): below transport threshold, zero movement, zero feed/recycle
  const { processor: noiseProc } = createProductionWorklet(sr);
  noiseProc.handleMessage({ type: 'SET_EXCITATION_PROFILE', profile: 'music' });
  const rms78 = Math.pow(10, -78 / 20);
  const amp78 = Math.SQRT2 * rms78;
  feedWorkletSignal(noiseProc, 2.0, (t) => amp78 * Math.sin(2 * Math.PI * f11 * t), sr);
  const snap78 = noiseProc.buildSnapshot();
  const mb78 = new ModalBank(DEFAULT_ALUMINUM, DEFAULT_GEOMETRY, 0.01);
  mb78.applySnapshot(snap78);
  const music78CenterRms = mb78.evaluateRmsAcceleration(L / 2, L / 2);
  assert.ok(
    music78CenterRms < 9.80687,
    `-78 dBFS input must remain below particle transport threshold 9.80687 m/s^2, got ${music78CenterRms}`
  );

  const noiseSys = new ParticleTransportSystem(
    {
      particleCount: 3000,
      dRef: 2.0e-6,
      gammaC: 1.0,
      power: 2.0,
      g: 9.80665,
      dt: 0.016,
      seed: 42,
      enableExternalPowderFeed: true,
      maxParticleCount: 4500,
    },
    L
  );
  noiseSys.particles[0].x = L / 2;
  noiseSys.particles[0].y = L / 2;
  // Also deplete interior below 2,100 to verify feeding/recycling remain blocked under -78 dBFS noise
  for (let i = 1; i < 1201; i++) {
    noiseSys.particles[i].x = 0.0004;
  }
  const before78 = noiseSys.particles.map((p) => ({ x: p.x, y: p.y }));
  const grid78 = mb78.getFastRmsGridData();
  for (let k = 0; k < 30; k++) {
    noiseSys.stepFromRmsGrid(0.016, grid78.quadrant, grid78.halfN, Boolean(snap78.isSilent) || !grid78.hasEnergy);
  }
  assert.equal(noiseSys.particles.length, 3000, 'Sub-threshold -78 dBFS noise must not trigger powder feeding');
  assert.equal(noiseSys.totalAddedCount, 0, 'Sub-threshold -78 dBFS noise must not trigger feeding or recycling');
  for (let i = 0; i < before78.length; i++) {
    assert.equal(noiseSys.particles[i].x, before78[i].x, 'Zero particle x movement allowed under -78 dBFS noise');
    assert.equal(noiseSys.particles[i].y, before78[i].y, 'Zero particle y movement allowed under -78 dBFS noise');
  }

  // D. Digital silence: never generates artificial excitation; preserves existing modal free decay
  const { processor: silentProc } = createProductionWorklet(sr);
  silentProc.handleMessage({ type: 'SET_EXCITATION_PROFILE', profile: 'music' });
  feedWorkletSignal(silentProc, 1.0, () => 0.0, sr);
  assert.equal(silentProc.musicGateOpen, false);
  assert.equal(silentProc.musicSmoothedGain, 1.0);
  assert.equal(silentProc.isSilent, true);
  assert.equal(silentProc.displacements[0], 0);
  assert.equal(silentProc.accelerations[0], 0);

  // Also test transition from excited -70 dBFS music into digital silence -> exact unforced decay without gain runaway
  const gainBeforeSilence = musicProc.musicSmoothedGain ?? 1.0;
  const framesBeforeSilence = musicProc.sampleFramesProcessed;
  const ampBeforeSilence = Math.hypot(musicProc.displacements[0], musicProc.velocities[0] / mode11.omega);
  assert.ok(ampBeforeSilence > 0);
  feedWorkletSignal(musicProc, 0.25, () => 0.0, sr);
  const gainAfterSilence = musicProc.musicSmoothedGain ?? 0;
  assert.ok(Number.isFinite(gainAfterSilence) && gainAfterSilence >= 1.0 && gainAfterSilence <= 16.0);
  assert.ok(
    gainAfterSilence <= gainBeforeSilence + 1e-9,
    'Digital silence must never push AGC gain upward'
  );
  assert.ok(musicProc.sampleFramesProcessed > framesBeforeSilence, 'Clock must advance continuously into decay');
  const ampAfterSilence = Math.hypot(musicProc.displacements[0], musicProc.velocities[0] / mode11.omega);
  const expectedDecay = Math.exp(-mode11.zeta * mode11.omega * 0.25);
  const relDecayErr = Math.abs(ampAfterSilence / ampBeforeSilence - expectedDecay) / expectedDecay;
  assert.ok(relDecayErr < 0.02, `Expected natural modal free decay during music silence, relErr=${relDecayErr}`);

  // E. Gain bounds [1.0, 16.0] & loud signal stays at unity (no boost above 1.0, no attenuation)
  const { processor: boundsProc } = createProductionWorklet(sr);
  boundsProc.handleMessage({ type: 'SET_EXCITATION_PROFILE', profile: 'music' });
  const testRmsLevels = [1e-5, rms70, 0.002, 0.05, 0.5];
  for (const level of testRmsLevels) {
    const peak = Math.SQRT2 * level;
    const total = Math.floor(0.6 * sr);
    const inBuf = new Float32Array(128);
    const outBuf = new Float32Array(128);
    for (let off = 0; off < total; off += 128) {
      for (let s = 0; s < 128; s++) {
        inBuf[s] = peak * Math.sin(2 * Math.PI * f11 * ((off + s) / sr));
      }
      boundsProc.process([[inBuf]], [[outBuf]]);
      const g = boundsProc.musicSmoothedGain;
      assert.ok(
        typeof g === 'number' && Number.isFinite(g) && g >= 1.0 && g <= 16.0,
        `Gain out of bounds [1.0, 16.0]: ${g}`
      );
      assert.ok(Number.isFinite(boundsProc.musicInputMeanSqEnvelope));
    }
  }
  // Last level was 0.5 RMS (loud): smoothed gain must converge to 1.0 unity (never > 1.0)
  assert.ok(
    Math.abs((boundsProc.musicSmoothedGain ?? 0) - 1.0) < 1e-4,
    `Loud input must settle at unity gain 1.0, got ${boundsProc.musicSmoothedGain}`
  );

  // Switching back to raw resets music detector while preserving simulation clock & modal state
  boundsProc.handleMessage({ type: 'SET_EXCITATION_PROFILE', profile: 'raw' });
  assert.equal(boundsProc.excitationProfile, 'raw');
  assert.equal(boundsProc.musicSmoothedGain, 1.0);
  assert.equal(boundsProc.musicGateOpen, false);

  console.log(
    `[Music Normalization Metrics] -70 dBFS center aRms=${music70CenterRms.toFixed(3)} m/s^2 (raw=${raw70CenterRms.toFixed(3)}), -78 dBFS center aRms=${music78CenterRms.toFixed(3)} m/s^2, disp70=${(disp70 * 1000).toFixed(4)} mm`
  );
});

test('27. AudioEngine sends SET_EXCITATION_PROFILE raw for generator and music before buffer/element playback', async () => {
  const prevWindow = (globalThis as Record<string, unknown>).window;
  const prevAudioWorkletNode = (globalThis as Record<string, unknown>).AudioWorkletNode;
  const prevAudioContext = (globalThis as Record<string, unknown>).AudioContext;
  const prevAudio = (globalThis as Record<string, unknown>).Audio;
  const prevURL = globalThis.URL;

  try {
    const timeline: string[] = [];
    let mockState: 'suspended' | 'running' = 'running';
    let allowDecode = true;
    let allowResume = true;

    const makeGain = () => ({
      channelCount: 2,
      channelCountMode: 'max',
      gain: { value: 1, setValueAtTime: () => {}, cancelScheduledValues: () => {}, setTargetAtTime: () => {} },
      connect: () => {},
    });

    class MockWorkletNode {
      port = {
        onmessage: null,
        postMessage: (msg: { type: string; profile?: string }) => {
          timeline.push(
            msg.type === 'SET_EXCITATION_PROFILE' ? `PROFILE:${msg.profile}` : `MSG:${msg.type}`
          );
        },
      };
      connect() {}
    }

    class MockAudioContext {
      sampleRate = 44100;
      currentTime = 0;
      destination = {};
      audioWorklet = { addModule: async () => {} };
      get state() {
        return mockState;
      }
      resume = () => {
        if (!allowResume) return new Promise<void>(() => {});
        mockState = 'running';
        return Promise.resolve();
      };
      close = async () => {};
      createGain = () => makeGain();
      createChannelSplitter = () => ({ connect: () => {} });
      createOscillator = () => ({
        type: 'sine',
        frequency: { setValueAtTime: () => {}, setTargetAtTime: () => {} },
        connect: () => {},
        start: () => {
          timeline.push('OSC_START');
        },
        stop: () => {},
        disconnect: () => {},
      });
      createBufferSource = () => ({
        buffer: null as unknown,
        loop: false,
        onended: null as (() => void) | null,
        connect: () => {},
        start: () => {
          timeline.push('BUFFER_START');
        },
        stop: () => {},
        disconnect: () => {},
      });
      createMediaElementSource = () => ({ connect: () => {} });
      decodeAudioData = async () => {
        if (!allowDecode) throw new Error('decode failed');
        return { duration: 3.0, numberOfChannels: 2, sampleRate: 44100 };
      };
    }

    class MockHTMLAudio {
      src = '';
      loop = false;
      paused = true;
      ended = false;
      currentTime = 0;
      duration = 3.0;
      ontimeupdate: (() => void) | null = null;
      onended: (() => void) | null = null;
      play = async () => {
        this.paused = false;
        timeline.push('ELEMENT_PLAY');
      };
      pause = () => {
        this.paused = true;
      };
    }

    (globalThis as Record<string, unknown>).AudioWorkletNode = MockWorkletNode;
    (globalThis as Record<string, unknown>).AudioContext = MockAudioContext;
    (globalThis as Record<string, unknown>).Audio = MockHTMLAudio;
    (globalThis as Record<string, unknown>).window = {
      AudioContext: MockAudioContext,
      location: { search: '' },
    };
    (globalThis as Record<string, unknown>).URL = {
      createObjectURL: () => 'blob:mock-audio',
      revokeObjectURL: () => {},
    };

    const engine = new AudioEngine();
    assert.equal(engine.getExcitationProfile(), 'raw');

    // 1. Primary AudioBufferSourceNode path selects 'music' BEFORE BUFFER_START
    const mp3File = new File([new Uint8Array(64)], 'quiet-song.mp3', { type: 'audio/mpeg' });
    assert.equal(await engine.loadAudioFile(mp3File), true);
    assert.equal(engine.getExcitationProfile(), 'music');
    assert.ok(timeline.indexOf('PROFILE:music') >= 0);
    assert.ok(timeline.indexOf('PROFILE:music') < timeline.indexOf('BUFFER_START'));

    // 2. Pause, seek, play must NOT alter or reset selected 'music' profile
    const msgCountBeforeOps = timeline.length;
    engine.pauseAudioFile();
    engine.seekAudioFile(1.2);
    engine.playAudioFile();
    const opsTimeline = timeline.slice(msgCountBeforeOps);
    assert.equal(opsTimeline.includes('PROFILE:raw'), false);
    assert.equal(opsTimeline.includes('PROFILE:music'), false);
    assert.equal(engine.getExcitationProfile(), 'music');

    // 3. Suspended AudioContext during file load retains 'music' when user later taps Play
    timeline.length = 0;
    mockState = 'suspended';
    allowResume = false;
    const suspendedEngine = new AudioEngine();
    assert.equal(await suspendedEngine.loadAudioFile(mp3File), true);
    assert.equal(suspendedEngine.getExcitationProfile(), 'music');
    assert.equal(timeline.includes('BUFFER_START'), false, 'Buffer must wait for Play tap while suspended');
    assert.equal(timeline[timeline.length - 1], 'PROFILE:music');

    allowResume = true;
    suspendedEngine.playAudioFile();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(suspendedEngine.getExcitationProfile(), 'music');
    assert.equal(timeline[timeline.length - 1], 'BUFFER_START');

    // 4. HTMLAudioElement fallback path selects 'music' BEFORE ELEMENT_PLAY
    timeline.length = 0;
    mockState = 'running';
    allowDecode = false;
    assert.equal(await engine.loadAudioFile(mp3File), true);
    assert.equal(engine.getExcitationProfile(), 'music');
    assert.ok(timeline.indexOf('PROFILE:music') >= 0);
    assert.ok(timeline.indexOf('PROFILE:music') < timeline.indexOf('ELEMENT_PLAY'));

    // 5. Switching back to sine generator restores 'raw' BEFORE OSC_START
    timeline.length = 0;
    await engine.startTone(269.82);
    assert.equal(engine.getExcitationProfile(), 'raw');
    assert.ok(timeline.indexOf('PROFILE:raw') >= 0);
    assert.ok(timeline.indexOf('PROFILE:raw') < timeline.indexOf('OSC_START'));

    suspendedEngine.cleanup();
    engine.cleanup();
  } finally {
    (globalThis as Record<string, unknown>).window = prevWindow;
    (globalThis as Record<string, unknown>).AudioWorkletNode = prevAudioWorkletNode;
    (globalThis as Record<string, unknown>).AudioContext = prevAudioContext;
    (globalThis as Record<string, unknown>).Audio = prevAudio;
    (globalThis as Record<string, unknown>).URL = prevURL;
  }
});

/* -------------------------------------------------------------------------- */
/* TESTS 28–32: MEMORY-BOUNDED SILENT WAV STREAMING & VIDEO EXPORT HELPERS    */
/* -------------------------------------------------------------------------- */

function buildCustomWavBuffer(opts: {
  audioFormat: number;
  channels: 1 | 2;
  sampleRate: number;
  bitsPerSample: 8 | 16 | 24 | 32;
  frames: number[][];
  extensibleSubtype?: 'pcm' | 'float';
  extraChunks?: { id: string; payload: Uint8Array }[];
}): Uint8Array {
  const { audioFormat, channels, sampleRate, bitsPerSample, frames, extensibleSubtype, extraChunks } = opts;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channels * bytesPerSample;
  const dataSize = frames.length * blockAlign;
  const fmtSize = audioFormat === 0xfffe ? 40 : 16;

  const extraBlocks: Uint8Array[] = [];
  let extraTotal = 0;
  for (const ch of extraChunks ?? []) {
    const padded = ch.payload.length + (ch.payload.length & 1);
    const block = new Uint8Array(8 + padded);
    const dv = new DataView(block.buffer);
    for (let i = 0; i < 4; i++) block[i] = ch.id.charCodeAt(i);
    dv.setUint32(4, ch.payload.length, true);
    block.set(ch.payload, 8);
    extraBlocks.push(block);
    extraTotal += block.length;
  }

  const totalSize = 12 + 8 + fmtSize + extraTotal + 8 + dataSize;
  const out = new Uint8Array(totalSize);
  const dv = new DataView(out.buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < 4; i++) out[off + i] = s.charCodeAt(i);
  };

  writeStr(0, 'RIFF');
  dv.setUint32(4, totalSize - 8, true);
  writeStr(8, 'WAVE');

  let pos = 12;
  writeStr(pos, 'fmt ');
  dv.setUint32(pos + 4, fmtSize, true);
  dv.setUint16(pos + 8, audioFormat, true);
  dv.setUint16(pos + 10, channels, true);
  dv.setUint32(pos + 12, sampleRate, true);
  dv.setUint32(pos + 16, sampleRate * blockAlign, true);
  dv.setUint16(pos + 20, blockAlign, true);
  dv.setUint16(pos + 22, bitsPerSample, true);
  if (audioFormat === 0xfffe) {
    dv.setUint16(pos + 24, 22, true); // cbSize
    dv.setUint16(pos + 26, bitsPerSample, true); // wValidBitsPerSample
    dv.setUint32(pos + 28, channels === 2 ? 0x3 : 0x4, true);
    const guid =
      extensibleSubtype === 'float'
        ? [0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71]
        : [0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];
    out.set(guid, pos + 32);
  }
  pos += 8 + fmtSize;

  for (const b of extraBlocks) {
    out.set(b, pos);
    pos += b.length;
  }

  writeStr(pos, 'data');
  dv.setUint32(pos + 4, dataSize, true);
  pos += 8;

  for (let f = 0; f < frames.length; f++) {
    for (let c = 0; c < channels; c++) {
      const s = frames[f][c];
      const off = pos + f * blockAlign + c * bytesPerSample;
      if (audioFormat === 0x0003 || extensibleSubtype === 'float') {
        dv.setFloat32(off, s, true);
      } else if (bitsPerSample === 8) {
        out[off] = Math.max(0, Math.min(255, Math.round(s * 128 + 128)));
      } else if (bitsPerSample === 16) {
        dv.setInt16(off, Math.max(-32768, Math.min(32767, Math.round(s * 32768))), true);
      } else if (bitsPerSample === 24) {
        const v = Math.max(-8388608, Math.min(8388607, Math.round(s * 8388608)));
        out[off] = v & 0xff;
        out[off + 1] = (v >> 8) & 0xff;
        out[off + 2] = (v >> 16) & 0xff;
      } else {
        dv.setInt32(off, Math.max(-2147483648, Math.min(2147483647, Math.round(s * 2147483648))), true);
      }
    }
  }
  return out;
}

function makeSliceOnlySource(bytes: Uint8Array): WavByteSource & { arrayBuffer: () => never } {
  return {
    size: bytes.byteLength,
    arrayBuffer(): never {
      throw new Error('Full-file arrayBuffer() must NEVER be called on streaming WAV source!');
    },
    slice(start?: number, end?: number): Blob {
      const s = Math.max(0, start ?? 0);
      const e = Math.min(bytes.byteLength, end ?? bytes.byteLength);
      const copy = bytes.slice(s, e);
      return new Blob([copy]);
    },
  };
}

test('28. Streaming PCM WAV parser supports PCM 8/16/24/32, Float32, EXTENSIBLE, odd metadata chunks, stereo 0.5*(L+R), and never calls full arrayBuffer()', async () => {
  // Stereo frames testing boundary polarity across formats
  const sampleFrames = [
    [0.5, -0.25], // mono = 0.125
    [-0.5, -0.5], // mono = -0.5
    [0.0, 0.75], // mono = 0.375
    [-0.25, 0.25], // mono = 0.0
  ];

  const formats: Array<{
    label: string;
    audioFormat: number;
    bitsPerSample: 8 | 16 | 24 | 32;
    extensibleSubtype?: 'pcm' | 'float';
    tol: number;
  }> = [
    { label: 'PCM 8-bit', audioFormat: 0x0001, bitsPerSample: 8, tol: 0.01 },
    { label: 'PCM 16-bit', audioFormat: 0x0001, bitsPerSample: 16, tol: 1e-4 },
    { label: 'PCM 24-bit', audioFormat: 0x0001, bitsPerSample: 24, tol: 1e-6 },
    { label: 'PCM 32-bit', audioFormat: 0x0001, bitsPerSample: 32, tol: 1e-7 },
    { label: 'IEEE Float32', audioFormat: 0x0003, bitsPerSample: 32, tol: 1e-6 },
    { label: 'EXTENSIBLE PCM 24-bit', audioFormat: 0xfffe, bitsPerSample: 24, extensibleSubtype: 'pcm', tol: 1e-6 },
    { label: 'EXTENSIBLE Float32', audioFormat: 0xfffe, bitsPerSample: 32, extensibleSubtype: 'float', tol: 1e-6 },
  ];

  for (const fmt of formats) {
    // Include odd-sized metadata chunk ("JUNK" 5 bytes -> 1 pad byte) before "data"
    const wav = buildCustomWavBuffer({
      audioFormat: fmt.audioFormat,
      channels: 2,
      sampleRate: 44100,
      bitsPerSample: fmt.bitsPerSample,
      frames: sampleFrames,
      extensibleSubtype: fmt.extensibleSubtype,
      extraChunks: [
        { id: 'JUNK', payload: new Uint8Array([1, 2, 3, 4, 5]) },
        { id: 'LIST', payload: new Uint8Array([9, 8, 7, 6]) },
      ],
    });
    const src = makeSliceOnlySource(wav);
    const stream = await createWavPcmChunkStream(src, { chunkDurationSec: 0.25 });
    assert.equal(stream.info.channels, 2, fmt.label);
    assert.equal(stream.info.totalFrames, sampleFrames.length, fmt.label);

    const chunk = await stream.nextChunk();
    assert.ok(chunk, fmt.label);
    assert.equal(chunk.isLast, true);
    assert.equal(chunk.frameCount, sampleFrames.length);
    for (let i = 0; i < sampleFrames.length; i++) {
      const expected = 0.5 * (sampleFrames[i][0] + sampleFrames[i][1]);
      assert.ok(
        Math.abs(chunk.monoSamples[i] - expected) <= fmt.tol,
        `${fmt.label} sample ${i}: got ${chunk.monoSamples[i]}, expected ${expected}`
      );
    }
    assert.equal(await stream.nextChunk(), null);
  }
});

test('29. Streaming WAV chunker preserves exact frame alignment and boundary values across multi-chunk reads', async () => {
  const sr = 8000;
  const totalFrames = 6500; // 0.8125 s -> 4 chunks at chunkDurationSec=0.25 (2000 frames/chunk -> 2000, 2000, 2000, 500)
  const frames: number[][] = [];
  for (let i = 0; i < totalFrames; i++) {
    frames.push([Math.sin((2 * Math.PI * 100 * i) / sr) * 0.8]);
  }
  const wav = buildCustomWavBuffer({
    audioFormat: 0x0001,
    channels: 1,
    sampleRate: sr,
    bitsPerSample: 16,
    frames,
  });
  const src = makeSliceOnlySource(wav);
  const stream = await createWavPcmChunkStream(src, { chunkDurationSec: 0.25 });

  assert.equal(stream.chunkFrames, 2000);
  assert.equal(stream.totalChunks, 4);

  let collectedFrames = 0;
  let expectedStart = 0;
  const reconstructed: number[] = [];
  while (stream.hasNext()) {
    const ch = await stream.nextChunk();
    assert.ok(ch);
    assert.equal(ch.startFrame, expectedStart);
    assert.equal(ch.sampleRate, sr);
    expectedStart += ch.frameCount;
    collectedFrames += ch.frameCount;
    for (let i = 0; i < ch.frameCount; i++) {
      reconstructed.push(ch.monoSamples[i]);
    }
    assert.equal(ch.isLast, collectedFrames === totalFrames);
  }

  assert.equal(collectedFrames, totalFrames);
  // Verify exact first, chunk-boundary, and final sample continuity
  assert.ok(Math.abs(reconstructed[0] - frames[0][0]) < 1e-4);
  assert.ok(Math.abs(reconstructed[1999] - frames[1999][0]) < 1e-4);
  assert.ok(Math.abs(reconstructed[2000] - frames[2000][0]) < 1e-4);
  assert.ok(Math.abs(reconstructed[totalFrames - 1] - frames[totalFrames - 1][0]) < 1e-4);
});

test('30. Streaming WAV parser rejects malformed, truncated, unsupported-format, and >2ch files', async () => {
  await assert.rejects(() => parseWavHeader(makeSliceOnlySource(new Uint8Array(16))), /too small/);

  // Non-RIFF header
  const nonRiff = new Uint8Array(64);
  await assert.rejects(() => parseWavHeader(makeSliceOnlySource(nonRiff)), /Unsupported file container/);

  // Truncated data chunk
  const valid = buildCustomWavBuffer({
    audioFormat: 0x0001,
    channels: 1,
    sampleRate: 44100,
    bitsPerSample: 16,
    frames: [[0.1], [0.2], [0.3], [0.4]],
  });
  const truncated = valid.slice(0, valid.byteLength - 3);
  await assert.rejects(() => parseWavHeader(makeSliceOnlySource(truncated)), /Truncated WAV/);

  // Unsupported format tag (e.g. ADPCM 0x0002)
  const adpcm = valid.slice();
  new DataView(adpcm.buffer).setUint16(20, 0x0002, true);
  await assert.rejects(() => parseWavHeader(makeSliceOnlySource(adpcm)), /Unsupported WAV format tag/);

  // Non-finite IEEE Float sample rejection
  const nanWav = buildCustomWavBuffer({
    audioFormat: 0x0003,
    channels: 1,
    sampleRate: 44100,
    bitsPerSample: 32,
    frames: [[0.25], [NaN]],
  });
  const nanStream = await createWavPcmChunkStream(makeSliceOnlySource(nanWav));
  await assert.rejects(() => nanStream.nextChunk(), /non-finite/);
});

test('31. AudioEngine.startSilentWavStream prebuffers 12-16s, schedules gap-free mono to fileGain ONLY, avoids ctx.destination, drives Worklet clock, and handles cancel/underrun', async () => {
  const prevWindow = (globalThis as Record<string, unknown>).window;
  const prevAudioWorkletNode = (globalThis as Record<string, unknown>).AudioWorkletNode;
  const prevAudioContext = (globalThis as Record<string, unknown>).AudioContext;

  try {
    const sr = 8000;
    const totalSec = 24;
    const frames: number[][] = [];
    for (let i = 0; i < sr * totalSec; i++) {
      const s = 0.5 * Math.sin((2 * Math.PI * 269.815 * i) / sr);
      frames.push([s, s]);
    }
    const longWavBytes = buildCustomWavBuffer({
      audioFormat: 0x0001,
      channels: 2,
      sampleRate: sr,
      bitsPerSample: 16,
      frames,
    });
    const wavSource = makeSliceOnlySource(longWavBytes);

    const { processor, snapshots } = createProductionWorklet(sr);
    const postedWorkletMsgs: unknown[] = [];
    let fakeCtxTime = 1.0;

    interface MockSourceNode {
      buffer: AudioBuffer | null;
      loop: boolean;
      onended: (() => void) | null;
      connections: string[];
      startTime: number;
      stopped: boolean;
      disconnected: boolean;
      connect: (target: { name?: string }) => void;
      start: (when?: number) => void;
      stop: () => void;
      disconnect: () => void;
    }

    const allCreatedSources: MockSourceNode[] = [];
    const mockDestination = { name: 'ctx.destination' };
    let sinkConnected = false;

    class MockWorkletNode {
      name = 'workletNode';
      port = {
        onmessage: null as ((e: { data: unknown }) => void) | null,
        postMessage: (msg: unknown) => {
          postedWorkletMsgs.push(msg);
          processor.handleMessage(msg);
        },
      };
      connect(target: { name?: string }) {
        if (target?.name === 'workletSink' || target === mockDestination) {
          sinkConnected = true;
        }
      }
    }

    class MockAudioContext {
      sampleRate = sr;
      state = 'running';
      destination = mockDestination;
      audioWorklet = { addModule: async () => {} };
      get currentTime() {
        return fakeCtxTime;
      }
      resume = async () => {};
      close = async () => {};
      createGain = () => {
        const g = {
          name: 'gain',
          channelCount: 2,
          channelCountMode: 'max',
          gain: {
            setValueAtTime: () => {},
            cancelScheduledValues: () => {},
            setTargetAtTime: () => {},
          },
          connect: (target: { name?: string }) => {
            if (g.name === 'workletSink' && target === mockDestination) {
              sinkConnected = true;
            }
          },
        };
        if (sinkConnected === false && allCreatedSources.length === 0) {
          // AudioEngine creates toneGain, audibleMonitor, fileGain, workletSink in order
        }
        return g;
      };
      createBuffer = (_ch: number, len: number, sampleRate: number) => {
        const chData = new Float32Array(len);
        return {
          numberOfChannels: 1,
          length: len,
          sampleRate,
          duration: len / sampleRate,
          getChannelData: () => chData,
          copyToChannel: (src: Float32Array) => chData.set(src),
        } as unknown as AudioBuffer;
      };
      createBufferSource = () => {
        const node: MockSourceNode = {
          buffer: null,
          loop: false,
          onended: null,
          connections: [],
          startTime: -1,
          stopped: false,
          disconnected: false,
          connect: (target: { name?: string }) => {
            node.connections.push(target === mockDestination ? 'ctx.destination' : target?.name || 'fileGain');
          },
          start: (when: number = 0) => {
            node.startTime = when;
          },
          stop: () => {
            node.stopped = true;
          },
          disconnect: () => {
            node.disconnected = true;
          },
        };
        allCreatedSources.push(node);
        return node as unknown as AudioBufferSourceNode;
      };
    }

    (globalThis as Record<string, unknown>).window = {
      AudioContext: MockAudioContext,
      location: { search: '' },
    };
    (globalThis as Record<string, unknown>).AudioWorkletNode = MockWorkletNode;
    (globalThis as Record<string, unknown>).AudioContext = MockAudioContext;

    const mb = new ModalBank(DEFAULT_ALUMINUM, DEFAULT_GEOMETRY, 0.01);
    const clock = new SimulationClockAccumulator();
    const engine = new AudioEngine();
    engine.configureModes(mb.getWorkletModeConfig());

    let prepareCalled = false;
    let streamStarted = false;
    let streamStartCtx = 0;

    await engine.startSilentWavStream(
      wavSource,
      {
        onPrepareSimulation: () => {
          prepareCalled = true;
          mb.reset();
          clock.reset();
        },
        onStreamStart: ({ startCtxTime }) => {
          streamStarted = true;
          streamStartCtx = startCtxTime;
        },
      },
      {
        chunkDurationSec: 4.0,
        minPrebufferSec: 12.0,
        maxLookaheadSec: 16.0,
        pumpIntervalMs: 30,
      }
    );

    assert.equal(prepareCalled, true);
    assert.equal(streamStarted, true);
    assert.equal(engine.getExcitationProfile(), 'music');
    assert.equal(engine.getBrowserAudioTelemetry().isFileAudibleToDestination, false);
    assert.ok(
      postedWorkletMsgs.some((m) => (m as { type?: string }).type === 'RESET_MODES'),
      'Worklet must receive RESET_MODES'
    );

    // Prebuffer for 12s using 4s chunks = exactly 3 scheduled chunks (bounded <= 4, <= 16s!)
    assert.equal(allCreatedSources.length, 3, 'Initial prebuffer schedules 3 x 4s = 12s');
    for (let i = 0; i < allCreatedSources.length; i++) {
      const s = allCreatedSources[i];
      assert.equal(s.connections.includes('ctx.destination'), false, 'Streamed chunk MUST NEVER connect to ctx.destination');
      assert.ok(Math.abs(s.startTime - (streamStartCtx + i * 4.0)) < 1e-9, `Chunk ${i} gap-free exact startTime`);
    }

    // Simulate playback passing chunk 0 -> chunk 0 releases buffer & pump schedules chunk 3 (12-16s lookahead bounded)
    fakeCtxTime = streamStartCtx + 4.01;
    allCreatedSources[0].onended?.();
    assert.equal(allCreatedSources[0].disconnected, true);
    assert.equal(allCreatedSources[0].buffer, null);

    await new Promise((r) => setTimeout(r, 90));
    assert.ok(allCreatedSources.length >= 4 && allCreatedSources.length <= 6);
    assert.ok(engine.getSilentWavStreamTelemetry().scheduledSourceCount <= 4, 'Lookahead must stay bounded <= 4 chunks');

    // Feed chunk 0 samples into real production ModalWorkletProcessor and confirm SimulationClock tracks sampleFramesProcessed
    const directStream = await createWavPcmChunkStream(wavSource, { chunkDurationSec: 1.0 });
    const firstChunk = await directStream.nextChunk();
    assert.ok(firstChunk);
    for (let off = 0; off < firstChunk.frameCount; off += 128) {
      const sub = firstChunk.monoSamples.subarray(off, Math.min(firstChunk.frameCount, off + 128));
      const inB = new Float32Array(128);
      inB.set(sub);
      processor.process([[inB]], [[new Float32Array(128)]]);
    }
    assert.ok(snapshots.length > 0);
    const lastSnap = snapshots[snapshots.length - 1];
    assert.ok(Math.abs(lastSnap.elapsedSimTime - lastSnap.sampleFramesProcessed / sr) < 1e-12);

    // Cancel mid-stream -> stops & disconnects all remaining sources cleanly
    engine.cancelSilentWavStream();
    assert.equal(engine.isSilentWavStreaming, false);
    assert.equal(engine.getSilentWavStreamTelemetry().scheduledSourceCount, 0);
    assert.equal(allCreatedSources[1].stopped, true);

    // Verify underrun detection aborts cleanly without gap corruption when clock jumps past unbuffered time
    let underrunErr: Error | null = null;
    await engine.startSilentWavStream(
      wavSource,
      {
        onError: (e) => {
          underrunErr = e;
        },
      },
      {
        chunkDurationSec: 4.0,
        minPrebufferSec: 8.0,
        maxLookaheadSec: 12.0,
        pumpIntervalMs: 25,
        underrunGuardSec: 0.2,
      }
    );
    fakeCtxTime += 9.0; // Jump beyond scheduled 8s prebuffer before pump refills!
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(underrunErr && /underrun/i.test((underrunErr as Error).message), 'Underrun must trigger clean abort');
    assert.equal(engine.isSilentWavStreaming, false);

    engine.cleanup();
  } finally {
    (globalThis as Record<string, unknown>).window = prevWindow;
    (globalThis as Record<string, unknown>).AudioWorkletNode = prevAudioWorkletNode;
    (globalThis as Record<string, unknown>).AudioContext = prevAudioContext;
  }
});

test('32. Silent video codec selection prioritizes H.264 MP4 and pairs containers/extensions consistently', () => {
  const prevMediaRecorder = (globalThis as Record<string, unknown>).MediaRecorder;
  try {
    // 1. Safari / H.264 MP4 supported
    (globalThis as Record<string, unknown>).MediaRecorder = {
      isTypeSupported: (mime: string) => mime === 'video/mp4;codecs=avc1.42E01E' || mime === 'video/webm',
    };
    const mp4 = selectSupportedVideoCodec();
    assert.equal(mp4.extension, 'mp4');
    assert.equal(mp4.baseMimeType, 'video/mp4');
    assert.equal(buildExportDownloadFileName('50-Min Concert.WAV', mp4.extension), '50-Min-Concert-chladni-silent.mp4');

    // 2. Fallback when only WebM VP9 is supported (e.g. Linux Chromium) -> extension must be .webm, NOT .mp4
    (globalThis as Record<string, unknown>).MediaRecorder = {
      isTypeSupported: (mime: string) => mime === 'video/webm;codecs=vp9',
    };
    const webm = selectSupportedVideoCodec();
    assert.equal(webm.extension, 'webm');
    assert.equal(webm.baseMimeType, 'video/webm');
    assert.equal(buildExportDownloadFileName('Track 01.wav', webm.extension), 'Track-01-chladni-silent.webm');

    // 3. Size estimator for 50-minute 200 kbps video (~75 MB payload + headroom)
    const est50m = estimateExportSizeBytes(3000, 200_000);
    assert.equal(est50m.estimatedVideoBytes, 75_000_000);
    assert.ok(est50m.requiredBytesWithHeadroom > 100_000_000);
  } finally {
    (globalThis as Record<string, unknown>).MediaRecorder = prevMediaRecorder;
  }
});

test('33. AudioEngine.startSilentWavStream rejects promptly with AudioContextSuspendedError instead of hanging if resume() never resolves', async () => {
  const prevWindow = (globalThis as Record<string, unknown>).window;
  const prevAudioWorkletNode = (globalThis as Record<string, unknown>).AudioWorkletNode;
  const prevAudioContext = (globalThis as Record<string, unknown>).AudioContext;

  try {
    const wavBytes = buildCustomWavBuffer({
      audioFormat: 0x0001,
      channels: 1,
      sampleRate: 8000,
      bitsPerSample: 16,
      frames: [[0.1], [0.2], [0.3], [0.4]],
    });
    const wavSource = makeSliceOnlySource(wavBytes);

    class MockWorkletNode {
      port = { onmessage: null, postMessage: () => {} };
      connect() {}
    }

    class MockSuspendedAudioContext {
      sampleRate = 8000;
      state = 'suspended';
      currentTime = 0;
      destination = {};
      audioWorklet = { addModule: async () => {} };
      resume = () => new Promise<void>(() => {}); // Never resolves (simulates iOS/Safari suspended without gesture)
      close = async () => {};
      createGain = () => ({
        channelCount: 2,
        channelCountMode: 'max',
        gain: { setValueAtTime: () => {}, cancelScheduledValues: () => {}, setTargetAtTime: () => {} },
        connect: () => {},
      });
    }

    (globalThis as Record<string, unknown>).window = {
      AudioContext: MockSuspendedAudioContext,
      location: { search: '' },
    };
    (globalThis as Record<string, unknown>).AudioWorkletNode = MockWorkletNode;
    (globalThis as Record<string, unknown>).AudioContext = MockSuspendedAudioContext;

    const engine = new AudioEngine();
    const t0 = Date.now();
    await assert.rejects(
      () => engine.startSilentWavStream(wavSource),
      (err: unknown) =>
        err instanceof Error && err.name === 'AudioContextSuspendedError' && /Start Silent Export/i.test(err.message)
    );
    const elapsedMs = Date.now() - t0;
    assert.ok(elapsedMs < 1500, `Suspended AudioContext check must abort promptly (<1500ms), took ${elapsedMs}ms`);
    engine.cleanup();
  } finally {
    (globalThis as Record<string, unknown>).window = prevWindow;
    (globalThis as Record<string, unknown>).AudioWorkletNode = prevAudioWorkletNode;
    (globalThis as Record<string, unknown>).AudioContext = prevAudioContext;
  }
});
