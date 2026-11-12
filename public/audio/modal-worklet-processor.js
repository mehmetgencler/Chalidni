/**
 * ModalWorkletProcessor: Stage 8 Unified Real-Time AudioWorklet Processor
 *
 * Unified modal physics engine and simulation clock for both single-tone and audio-file excitation:
 * - Single authoritative physical simulation clock: t = sampleFramesProcessed / sampleRate.
 * - Full 20 Hz - 20 kHz active modal catalogue (146 odd-odd Kirchhoff modes for center shaker).
 * - Exact discrete-time Zero-Order-Held (ZOH) state transitions at sampleRate:
 *   q_ddot_mn + 2*zeta_mn*omega_mn*q_dot_mn + omega_mn^2*q_mn = Q_mn / M
 * - Physically authentic modal free decay: each mode retains its own natural frequency and damping rate.
 * - Block-averaged covariance integration across all 146 diagonals, all degenerate equal-frequency
 *   pairs, and all active top-K (K=24) modal cross-pairs per 128-sample quantum.
 * - Single center-shaker excitation at (L/2, L/2) = (0.15m, 0.15m).
 * - Publishes compact ~60 Hz snapshots with sparse covariance to synchronize main-thread rendering.
 */

const _BaseWorkletProcessor =
  typeof AudioWorkletProcessor !== 'undefined'
    ? AudioWorkletProcessor
    : class {
        constructor() {
          this.port = {
            onmessage: null,
            postMessage: () => {},
          };
        }
      };

class ModalWorkletProcessor extends _BaseWorkletProcessor {
  constructor(options) {
    super();

    const sr =
      typeof sampleRate !== 'undefined'
        ? sampleRate
        : options && options.processorOptions && options.processorOptions.sampleRate
          ? options.processorOptions.sampleRate
          : 44100;

    this.sampleFramesProcessed = 0;
    this.quantumCount = 0;
    this.sampleRate = sr;

    this.sideLength = 0.30;
    this.isSilent = true;

    // Build default 146 odd-odd active modes catalogue up to 20,000 Hz
    this.modes = this.generateDefaultActiveModes(20000);
    this.lastQuantumLen = 128;
    this.initModeArrays();

    this.rmsWindowTimeConstant = 0.08; // tau = 80 ms
    this.dt = 1.0 / this.sampleRate;
    this.covAlpha = 1.0 - Math.exp(-(128.0 * this.dt) / this.rmsWindowTimeConstant);

    this.recomputeCoefficients();

    // Snapshot publication at ~60 Hz
    this.snapshotIntervalSamples = Math.max(128, Math.round(this.sampleRate / 60));
    this.samplesSinceLastSnapshot = 0;

    this.port.onmessage = (event) => {
      this.handleMessage(event.data);
    };
  }

  /**
   * Generates analytical 146 odd-odd modes up to maxFrequency (default 20,000 Hz)
   * Aluminum plate: E=69e9, rho=2700, nu=0.33, L=0.30, h=0.001 -> f11 = 53.96303 Hz
   */
  generateDefaultActiveModes(maxFrequency = 20000) {
    const modes = [];
    const E = 69e9;
    const rho = 2700;
    const nu = 0.33;
    const L = 0.30;
    const h = 0.001;
    const D = (E * h * h * h) / (12.0 * (1.0 - nu * nu));
    const M = (rho * h * L * L) / 4.0;
    const prefactor = (Math.PI / (2.0 * L * L)) * Math.sqrt(D / (rho * h));
    const f11 = prefactor * 2.0;
    const maxM = Math.ceil(Math.sqrt((2.0 * maxFrequency) / f11));

    for (let m = 1; m <= maxM; m += 2) {
      for (let n = 1; n <= maxM; n += 2) {
        const f = prefactor * (m * m + n * n);
        if (f <= maxFrequency) {
          modes.push({
            m,
            n,
            frequency: f,
            omega: 2.0 * Math.PI * f,
            zeta: 0.01,
            modalMass: M,
            centerCoupling: Math.sin((m * Math.PI) / 2.0) * Math.sin((n * Math.PI) / 2.0),
          });
        }
      }
    }

    modes.sort((a, b) => a.frequency - b.frequency);
    return modes;
  }

  initModeArrays() {
    const n = this.modes.length;
    this.displacements = new Float64Array(n);
    this.velocities = new Float64Array(n);
    this.accelerations = new Float64Array(n);
    this.covarianceMatrix = new Float64Array(n * n);

    // Exact ZOH state transition coefficients
    this.A11 = new Float64Array(n);
    this.A12 = new Float64Array(n);
    this.A21 = new Float64Array(n);
    this.A22 = new Float64Array(n);

    this.omegas = new Float64Array(n);
    this.omegaSq = new Float64Array(n);
    this.zetas = new Float64Array(n);
    this.twoZetaOmega = new Float64Array(n);
    this.modalMasses = new Float64Array(n);
    this.couplings = new Float64Array(n);

    // Pre-allocated quantum work buffers (zero GC per quantum)
    this.accBlock = new Float64Array(n * this.lastQuantumLen);
    this.accSqSums = new Float64Array(n);
    this.rankIndices = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      this.rankIndices[i] = i;
    }

    // Track degenerate pairs and avoid duplicate dot-product work
    this.degeneratePairs = [];
    this.degenMask = new Uint8Array(n * n);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (Math.abs(this.modes[i].omega - this.modes[j].omega) < 0.1) {
          this.degeneratePairs.push({ i, j, rowI: i * n + j, rowJ: j * n + i });
          this.degenMask[i * n + j] = 1;
          this.degenMask[j * n + i] = 1;
        }
      }
    }
  }

  recomputeCoefficients() {
    const dt = this.dt;
    const n = this.modes.length;

    for (let i = 0; i < n; i++) {
      const mode = this.modes[i];
      const omega = mode.omega;
      const zeta = mode.zeta || 0.01;
      const omegaD = omega * Math.sqrt(Math.max(0, 1.0 - zeta * zeta));
      const M = mode.modalMass || mode.M || 0.06075;

      this.omegas[i] = omega;
      this.omegaSq[i] = omega * omega;
      this.zetas[i] = zeta;
      this.twoZetaOmega[i] = 2.0 * zeta * omega;
      this.modalMasses[i] = M;

      // Exact center shaker coupling: phi_mn(L/2, L/2) = sin(m*pi/2)*sin(n*pi/2)
      this.couplings[i] = Math.sin((mode.m * Math.PI) / 2.0) * Math.sin((mode.n * Math.PI) / 2.0);

      const expDecay = Math.exp(-zeta * omega * dt);
      const cosTerm = Math.cos(omegaD * dt);
      const sinTerm = Math.sin(omegaD * dt);
      const sinOverOmegaD = omegaD > 1e-12 ? sinTerm / omegaD : dt;

      this.A11[i] = expDecay * (cosTerm + zeta * omega * sinOverOmegaD);
      this.A12[i] = expDecay * sinOverOmegaD;
      this.A21[i] = -expDecay * (omega * omega * sinOverOmegaD);
      this.A22[i] = expDecay * (cosTerm - zeta * omega * sinOverOmegaD);
    }
  }

  handleMessage(msg) {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'CONFIGURE_MODES':
        if (Array.isArray(msg.modes) && msg.modes.length > 0) {
          this.modes = msg.modes.map((m) => ({
            m: m.m,
            n: m.n,
            frequency: m.frequency,
            omega: m.omega || 2.0 * Math.PI * m.frequency,
            zeta: m.zeta || 0.01,
            modalMass: m.modalMass || m.M || 0.06075,
          }));
          this.initModeArrays();
          this.recomputeCoefficients();
        }
        break;

      case 'RESET_MODES':
        this.displacements.fill(0);
        this.velocities.fill(0);
        this.accelerations.fill(0);
        this.covarianceMatrix.fill(0);
        this.sampleFramesProcessed = 0;
        break;
    }
  }

  buildSnapshot() {
    const n = this.modes.length;
    const covarianceDiag = new Array(n);
    const covarianceCross = [];

    let maxVar = 0;
    let maxAcc = 0;

    for (let i = 0; i < n; i++) {
      const diag = this.covarianceMatrix[i * n + i];
      covarianceDiag[i] = diag;
      if (diag > maxVar) maxVar = diag;
      const a = Math.abs(this.accelerations[i]);
      if (a > maxAcc) maxAcc = a;

      const rowOffset = i * n;
      for (let j = i + 1; j < n; j++) {
        const val = this.covarianceMatrix[rowOffset + j];
        if (Math.abs(val) > 1e-8) {
          covarianceCross.push(i, j, val);
        }
      }
    }

    // Use acceleration & covariance energy (never displacement, which scales as 1/omega^2 at 20kHz)
    const hasVibration = maxAcc > 1e-3 || maxVar > 1e-4;

    return {
      type: 'MODAL_SNAPSHOT',
      sampleFramesProcessed: this.sampleFramesProcessed,
      sampleRate: this.sampleRate,
      elapsedSimTime: this.sampleFramesProcessed / this.sampleRate,
      modeCount: n,
      displacements: Array.from(this.displacements),
      velocities: Array.from(this.velocities),
      accelerations: Array.from(this.accelerations),
      covarianceDiag,
      covarianceCross,
      isPlaying: !this.isSilent || hasVibration,
      isSilent: this.isSilent && !hasVibration,
      quantumCount: this.quantumCount,
    };
  }

  process(inputs, outputs) {
    this.quantumCount++;

    const input = inputs[0];
    const output = outputs[0];
    const inputChannel = input && input.length > 0 ? input[0] : null;
    const outputChannel = output && output.length > 0 ? output[0] : null;

    if (outputChannel) {
      outputChannel.fill(0);
    }

    const quantumLen = inputChannel ? inputChannel.length : 128;
    const n = this.modes.length;

    if (quantumLen !== this.lastQuantumLen) {
      this.lastQuantumLen = quantumLen;
      this.accBlock = new Float64Array(n * quantumLen);
      this.covAlpha = 1.0 - Math.exp(-(quantumLen * this.dt) / this.rmsWindowTimeConstant);
    }

    const accBlock = this.accBlock;
    const accSqSums = this.accSqSums;
    accSqSums.fill(0);
    let localEnergy = 0;

    for (let s = 0; s < quantumLen; s++) {
      this.sampleFramesProcessed++;

      const rawSample = inputChannel ? inputChannel[s] : 0.0;
      localEnergy += rawSample * rawSample;
      const excValue = rawSample * 3.0; // Center shaker excitation force in Newtons

      if (Math.abs(excValue) > 1e-12) {
        // Forced exact discrete-time ZOH modal transition
        for (let i = 0; i < n; i++) {
          const u = (excValue * this.couplings[i]) / this.modalMasses[i];
          const w2 = this.omegaSq[i];
          const qEq = u / w2;
          const qTilde = this.displacements[i] - qEq;
          const v0 = this.velocities[i];

          const qNew = this.A11[i] * qTilde + this.A12[i] * v0 + qEq;
          const vNew = this.A21[i] * qTilde + this.A22[i] * v0;
          const aNew = u - this.twoZetaOmega[i] * vNew - w2 * qNew;

          this.displacements[i] = qNew;
          this.velocities[i] = vNew;
          this.accelerations[i] = aNew;

          accBlock[i * quantumLen + s] = aNew;
          accSqSums[i] += aNew * aNew;
        }
      } else {
        // Exact unforced free modal decay (q_ddot + 2*zeta*omega*q_dot + omega^2*q = 0)
        for (let i = 0; i < n; i++) {
          const q0 = this.displacements[i];
          const v0 = this.velocities[i];

          const qNew = this.A11[i] * q0 + this.A12[i] * v0;
          const vNew = this.A21[i] * q0 + this.A22[i] * v0;
          const aNew = -this.twoZetaOmega[i] * vNew - this.omegaSq[i] * qNew;

          this.displacements[i] = qNew;
          this.velocities[i] = vNew;
          this.accelerations[i] = aNew;

          accBlock[i * quantumLen + s] = aNew;
          accSqSums[i] += aNew * aNew;
        }
      }
    }

    // Exponentially smooth full covariance matrix over the quantum
    const alpha = this.covAlpha;
    const oneMinusAlpha = 1.0 - alpha;
    const invQ = 1.0 / quantumLen;
    const covLen = this.covarianceMatrix.length;
    for (let k = 0; k < covLen; k++) {
      this.covarianceMatrix[k] *= oneMinusAlpha;
    }

    // 1. All 146 diagonal auto-variances
    for (let i = 0; i < n; i++) {
      this.covarianceMatrix[i * n + i] += accSqSums[i] * invQ * alpha;
    }

    // 2. All degenerate equal-frequency mode cross-terms (sample-averaged over entire quantum)
    const numDegen = this.degeneratePairs.length;
    for (let p = 0; p < numDegen; p++) {
      const pair = this.degeneratePairs[p];
      const offI = pair.i * quantumLen;
      const offJ = pair.j * quantumLen;
      let sum = 0;
      for (let s = 0; s < quantumLen; s++) {
        sum += accBlock[offI + s] * accBlock[offJ + s];
      }
      const deltaCov = sum * invQ * alpha;
      this.covarianceMatrix[pair.rowI] += deltaCov;
      this.covarianceMatrix[pair.rowJ] += deltaCov;
    }

    // 3. Top-K (K=24) highest-energy active non-degenerate modal cross-terms
    const K = Math.min(24, n);
    const rankIndices = this.rankIndices;
    for (let a = 0; a < K; a++) {
      let bestPos = a;
      let bestEnergy = accSqSums[rankIndices[a]];
      for (let b = a + 1; b < n; b++) {
        const energy = accSqSums[rankIndices[b]];
        if (energy > bestEnergy) {
          bestEnergy = energy;
          bestPos = b;
        }
      }
      if (bestPos !== a) {
        const tmp = rankIndices[a];
        rankIndices[a] = rankIndices[bestPos];
        rankIndices[bestPos] = tmp;
      }
    }

    for (let a = 0; a < K; a++) {
      const i = rankIndices[a];
      if (accSqSums[i] <= 1e-12) break;
      const offI = i * quantumLen;
      for (let b = a + 1; b < K; b++) {
        const j = rankIndices[b];
        if (accSqSums[j] <= 1e-12) break;
        if (this.degenMask[i * n + j]) continue; // Already updated in step 2

        const offJ = j * quantumLen;
        let sum = 0;
        for (let s = 0; s < quantumLen; s++) {
          sum += accBlock[offI + s] * accBlock[offJ + s];
        }
        const deltaCov = sum * invQ * alpha;
        this.covarianceMatrix[i * n + j] += deltaCov;
        this.covarianceMatrix[j * n + i] += deltaCov;
      }
    }

    this.isSilent = localEnergy < 1e-10;
    this.samplesSinceLastSnapshot += quantumLen;

    if (this.samplesSinceLastSnapshot >= this.snapshotIntervalSamples) {
      this.samplesSinceLastSnapshot = 0;
      this.port.postMessage(this.buildSnapshot());
    }

    return true;
  }
}

if (typeof AudioWorkletProcessor !== 'undefined' && typeof registerProcessor === 'function') {
  registerProcessor('modal-worklet-processor', ModalWorkletProcessor);
} else if (typeof globalThis !== 'undefined') {
  globalThis.__ModalWorkletProcessorClass = ModalWorkletProcessor;
}
