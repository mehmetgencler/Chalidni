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

    // Excitation profiles: 'raw' (default, unmodified sine/direct input) | 'music' (bounded RMS normalization)
    this.excitationProfile = 'raw';
    this.musicTargetInputRms = 0.006;
    this.musicMinGain = 1.0;
    this.musicMaxGain = 16.0;
    this.musicGateOpenRms = Math.pow(10.0, -78.0 / 20.0);
    this.musicGateCloseRms = Math.pow(10.0, -84.0 / 20.0);
    this.musicEnvTimeConstant = 0.05;
    this.musicGainAttackTimeConstant = 0.05;
    this.musicGainReleaseTimeConstant = 0.02;
    this.musicInputMeanSqEnvelope = 0.0;
    this.musicGateOpen = false;
    this.musicSmoothedGain = 1.0;

    // Build default 146 odd-odd active modes catalogue up to 20,000 Hz
    this.modes = this.generateDefaultActiveModes(20000);
    this.lastQuantumLen = 128;
    this.initModeArrays();

    this.rmsWindowTimeConstant = 0.08; // tau = 80 ms
    this.dt = 1.0 / this.sampleRate;
    this.staggerBuckets = 8;
    this.recomputeCovarianceLut(this.lastQuantumLen);

    this.recomputeCoefficients();

    // Exact sample-count snapshot accumulator at 60 Hz (preserves excess quantum samples)
    this.exactSnapshotInterval = this.sampleRate / 60.0;
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
    this.forceGain = new Float64Array(n);
    this.forceToEq = new Float64Array(n);

    // Pre-allocated quantum work buffers (zero GC per quantum)
    this.excBuf = new Float64Array(this.lastQuantumLen);
    this.accBlock = new Float64Array(n * this.lastQuantumLen);
    this.accSqSums = new Float64Array(n);
    this.rankIndices = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      this.rankIndices[i] = i;
    }

    // Track last-updated quantum index per covariance cell (for exact exponential decay)
    this.covLastQ = new Int32Array(n * n);

    // Track degenerate pairs and partition all remaining non-degenerate pairs into P=8 staggered groups
    this.degeneratePairs = [];
    this.degenMask = new Uint8Array(n * n);
    const P = this.staggerBuckets || 8;
    const groupLists = Array.from({ length: P }, () => []);
    let nonDegenIdx = 0;

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const idx = i * n + j;
        if (Math.abs(this.modes[i].omega - this.modes[j].omega) < 0.1) {
          this.degeneratePairs.push({ i, j, idx, symIdx: j * n + i });
          this.degenMask[idx] = 1;
          this.degenMask[j * n + i] = 1;
        } else {
          const g = nonDegenIdx % P;
          groupLists[g].push(i, j, idx, j * n + i);
          nonDegenIdx++;
        }
      }
    }

    this.staggerGroups = groupLists.map((arr) => new Int32Array(arr));
  }

  recomputeCovarianceLut(quantumLen) {
    const stepAlpha = (quantumLen * this.dt) / this.rmsWindowTimeConstant;
    const maxLag = 64;
    this.decayLut = new Float64Array(maxLag);
    this.alphaLut = new Float64Array(maxLag);
    for (let d = 0; d < maxLag; d++) {
      const dec = Math.exp(-d * stepAlpha);
      this.decayLut[d] = dec;
      this.alphaLut[d] = 1.0 - dec;
    }
    this.covAlpha = this.alphaLut[1];
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
      const coupling = Math.sin((mode.m * Math.PI) / 2.0) * Math.sin((mode.n * Math.PI) / 2.0);
      this.couplings[i] = coupling;
      this.forceGain[i] = coupling / M;
      this.forceToEq[i] = this.forceGain[i] / (omega * omega);

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

  resetMusicDetectorState() {
    this.musicInputMeanSqEnvelope = 0.0;
    this.musicGateOpen = false;
    this.musicSmoothedGain = this.musicMinGain;
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

      case 'SET_EXCITATION_PROFILE':
        this.excitationProfile = msg.profile === 'music' ? 'music' : 'raw';
        this.resetMusicDetectorState();
        break;

      case 'RESET_MODES':
        this.displacements.fill(0);
        this.velocities.fill(0);
        this.accelerations.fill(0);
        this.covarianceMatrix.fill(0);
        this.covLastQ.fill(0);
        this.sampleFramesProcessed = 0;
        break;
    }
  }

  buildSnapshot() {
    const n = this.modes.length;
    const covarianceDiag = new Array(n);
    const covarianceCross = [];
    const qNow = this.quantumCount;
    const decayLut = this.decayLut;

    let maxVar = 0;
    let maxAcc = 0;

    for (let i = 0; i < n; i++) {
      const diag = this.covarianceMatrix[i * n + i];
      covarianceDiag[i] = diag;
      if (diag > maxVar) maxVar = diag;
      const a = Math.abs(this.accelerations[i]);
      if (a > maxAcc) maxAcc = a;
    }

    const crossFloor = Math.max(1e-8, maxVar * 1e-7);
    const staggerPeriod = this.staggerBuckets || 8;
    for (let i = 0; i < n; i++) {
      const rowOffset = i * n;
      for (let j = i + 1; j < n; j++) {
        const idx = rowOffset + j;
        let val = this.covarianceMatrix[idx];
        if (Math.abs(val) > crossFloor) {
          const lag = qNow - this.covLastQ[idx];
          if (lag > staggerPeriod) {
            const excessLag = lag - staggerPeriod;
            val *=
              excessLag < 64
                ? decayLut[excessLag]
                : Math.exp(-(excessLag * this.lastQuantumLen * this.dt) / this.rmsWindowTimeConstant);
          }
          if (Math.abs(val) > crossFloor) {
            covarianceCross.push(i, j, val);
          }
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
      this.excBuf = new Float64Array(quantumLen);
      this.accBlock = new Float64Array(n * quantumLen);
      this.recomputeCovarianceLut(quantumLen);
    }

    const excBuf = this.excBuf;
    const accBlock = this.accBlock;
    const accSqSums = this.accSqSums;
    let localEnergy = 0;
    let effectiveEnergy = 0;

    if (this.excitationProfile === 'music') {
      const quantumDt = quantumLen > 0 ? quantumLen * this.dt : 0;
      if (inputChannel && quantumLen > 0) {
        for (let s = 0; s < quantumLen; s++) {
          const rawSample = inputChannel[s];
          if (Number.isFinite(rawSample)) {
            localEnergy += rawSample * rawSample;
          }
        }
      }

      const blockMeanSq = quantumLen > 0 && Number.isFinite(localEnergy) ? localEnergy / quantumLen : 0;
      const envAlpha = quantumDt > 0 ? 1.0 - Math.exp(-quantumDt / this.musicEnvTimeConstant) : 1.0;
      this.musicInputMeanSqEnvelope += envAlpha * (blockMeanSq - this.musicInputMeanSqEnvelope);
      if (!Number.isFinite(this.musicInputMeanSqEnvelope) || this.musicInputMeanSqEnvelope < 0) {
        this.musicInputMeanSqEnvelope = 0.0;
      }
      const inputRmsEnvelope = Math.sqrt(this.musicInputMeanSqEnvelope);

      if (!this.musicGateOpen && inputRmsEnvelope >= this.musicGateOpenRms) {
        this.musicGateOpen = true;
      } else if (this.musicGateOpen && inputRmsEnvelope < this.musicGateCloseRms) {
        this.musicGateOpen = false;
      }

      let targetGain = this.musicMinGain;
      if (this.musicGateOpen && Number.isFinite(inputRmsEnvelope) && inputRmsEnvelope > 0) {
        const rawTarget = this.musicTargetInputRms / inputRmsEnvelope;
        if (Number.isFinite(rawTarget)) {
          targetGain = Math.max(this.musicMinGain, Math.min(this.musicMaxGain, rawTarget));
        }
      }

      const gainTau =
        targetGain > this.musicSmoothedGain
          ? this.musicGainAttackTimeConstant
          : this.musicGainReleaseTimeConstant;
      const gainAlpha = quantumDt > 0 ? 1.0 - Math.exp(-quantumDt / gainTau) : 1.0;
      this.musicSmoothedGain += gainAlpha * (targetGain - this.musicSmoothedGain);
      if (!Number.isFinite(this.musicSmoothedGain)) {
        this.musicSmoothedGain = this.musicMinGain;
      } else {
        this.musicSmoothedGain = Math.max(
          this.musicMinGain,
          Math.min(this.musicMaxGain, this.musicSmoothedGain)
        );
      }

      if (this.musicGateOpen && inputChannel && quantumLen > 0) {
        const scale = this.musicSmoothedGain * 3.0;
        for (let s = 0; s < quantumLen; s++) {
          const rawSample = inputChannel[s];
          const safeSample = Number.isFinite(rawSample) ? rawSample : 0;
          const postSample = safeSample * this.musicSmoothedGain;
          effectiveEnergy += postSample * postSample;
          excBuf[s] = safeSample * scale;
        }
      } else {
        excBuf.fill(0);
        effectiveEnergy = 0;
      }
    } else {
      if (inputChannel) {
        for (let s = 0; s < quantumLen; s++) {
          const rawSample = inputChannel[s];
          localEnergy += rawSample * rawSample;
          excBuf[s] = rawSample * 3.0;
        }
      } else {
        excBuf.fill(0);
      }
      effectiveEnergy = localEnergy;
    }
    this.sampleFramesProcessed += quantumLen;

    const hasInput = effectiveEnergy > 1e-20;
    let maxAccSq = 0;

    if (hasInput) {
      // Forced exact discrete-time ZOH transition (outer mode i, inner contiguous sample s)
      for (let i = 0; i < n; i++) {
        const cOverM = this.forceGain[i];
        const fToEq = this.forceToEq[i];
        const wSq = this.omegaSq[i];
        const twoZW = this.twoZetaOmega[i];
        const a11 = this.A11[i];
        const a12 = this.A12[i];
        const a21 = this.A21[i];
        const a22 = this.A22[i];

        let q = this.displacements[i];
        let v = this.velocities[i];
        let aLast = this.accelerations[i];
        let sqSum = 0;
        const off = i * quantumLen;

        for (let s = 0; s < quantumLen; s++) {
          const exc = excBuf[s];
          const qEq = exc * fToEq;
          const qTilde = q - qEq;
          const qNew = a11 * qTilde + a12 * v + qEq;
          const vNew = a21 * qTilde + a22 * v;
          aLast = exc * cOverM - twoZW * vNew - wSq * qNew;
          q = qNew;
          v = vNew;
          accBlock[off + s] = aLast;
          sqSum += aLast * aLast;
        }

        this.displacements[i] = q;
        this.velocities[i] = v;
        this.accelerations[i] = aLast;
        accSqSums[i] = sqSum;
        if (sqSum > maxAccSq) maxAccSq = sqSum;
      }
    } else {
      // Exact unforced free modal decay (outer mode i, inner contiguous sample s)
      for (let i = 0; i < n; i++) {
        const wSq = this.omegaSq[i];
        const twoZW = this.twoZetaOmega[i];
        const a11 = this.A11[i];
        const a12 = this.A12[i];
        const a21 = this.A21[i];
        const a22 = this.A22[i];

        let q = this.displacements[i];
        let v = this.velocities[i];
        let aLast = this.accelerations[i];
        let sqSum = 0;
        const off = i * quantumLen;

        if (q === 0 && v === 0) {
          accSqSums[i] = 0;
          continue;
        }

        for (let s = 0; s < quantumLen; s++) {
          const qNew = a11 * q + a12 * v;
          const vNew = a21 * q + a22 * v;
          aLast = -twoZW * vNew - wSq * qNew;
          q = qNew;
          v = vNew;
          accBlock[off + s] = aLast;
          sqSum += aLast * aLast;
        }

        this.displacements[i] = q;
        this.velocities[i] = v;
        this.accelerations[i] = aLast;
        accSqSums[i] = sqSum;
        if (sqSum > maxAccSq) maxAccSq = sqSum;
      }
    }

    // Exact exponentially smoothed covariance update across all 146x146 modes:
    // Diagonals, Degenerate pairs, and Top-20 active modes update EVERY quantum (0 ms lag).
    // Remaining non-degenerate pairs cycle across P=10 staggered groups with exact timestamp decay LUT.
    const alpha1 = this.alphaLut[1];
    const decay1 = this.decayLut[1];
    const invQ = 1.0 / quantumLen;
    const qNow = this.quantumCount;
    const cov = this.covarianceMatrix;
    const lastQ = this.covLastQ;
    const alphaLut = this.alphaLut;
    const decayLut = this.decayLut;

    // 1. All 146 diagonal auto-variances
    for (let i = 0; i < n; i++) {
      const ii = i * n + i;
      cov[ii] = cov[ii] * decay1 + accSqSums[i] * invQ * alpha1;
    }

    // 2. All degenerate equal-frequency mode cross-terms (every quantum)
    const numDegen = this.degeneratePairs.length;
    for (let p = 0; p < numDegen; p++) {
      const pair = this.degeneratePairs[p];
      const offI = pair.i * quantumLen;
      const offJ = pair.j * quantumLen;
      let sum = 0;
      if (quantumLen === 128) {
        for (let s = 0; s < 128; s += 4) {
          sum +=
            accBlock[offI + s] * accBlock[offJ + s] +
            accBlock[offI + s + 1] * accBlock[offJ + s + 1] +
            accBlock[offI + s + 2] * accBlock[offJ + s + 2] +
            accBlock[offI + s + 3] * accBlock[offJ + s + 3];
        }
      } else {
        for (let s = 0; s < quantumLen; s++) {
          sum += accBlock[offI + s] * accBlock[offJ + s];
        }
      }
      const val = cov[pair.idx] * decay1 + sum * invQ * alpha1;
      cov[pair.idx] = val;
      cov[pair.symIdx] = val;
      lastQ[pair.idx] = qNow;
    }

    // 3. Top-20 highest-energy active non-degenerate modal cross-terms (instantaneous transient tracking)
    const K = Math.min(20, n);
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
        const ii = i < j ? i : j;
        const jj = i < j ? j : i;
        const idx = ii * n + jj;
        if (this.degenMask[idx]) continue;

        const offJ = j * quantumLen;
        let sum = 0;
        if (quantumLen === 128) {
          for (let s = 0; s < 128; s += 4) {
            sum +=
              accBlock[offI + s] * accBlock[offJ + s] +
              accBlock[offI + s + 1] * accBlock[offJ + s + 1] +
              accBlock[offI + s + 2] * accBlock[offJ + s + 2] +
              accBlock[offI + s + 3] * accBlock[offJ + s + 3];
          }
        } else {
          for (let s = 0; s < quantumLen; s++) {
            sum += accBlock[offI + s] * accBlock[offJ + s];
          }
        }

        const lag = qNow - lastQ[idx];
        const aW = lag < 64 ? alphaLut[lag] : 1.0 - Math.exp(-(lag * quantumLen * this.dt) / this.rmsWindowTimeConstant);
        const dW = 1.0 - aW;
        const val = cov[idx] * dW + sum * invQ * aW;
        cov[idx] = val;
        cov[jj * n + ii] = val;
        lastQ[idx] = qNow;
      }
    }

    // 4. Staggered full-matrix sweep (1/8 of non-degenerate pairs per quantum -> full exact steady-state coherence)
    const grp = this.staggerGroups[qNow % this.staggerGroups.length];
    const sqFloor = Math.max(1e-14, maxAccSq * 1e-6);
    for (let p = 0; p < grp.length; p += 4) {
      const i = grp[p];
      const j = grp[p + 1];
      const idx = grp[p + 2];
      const symIdx = grp[p + 3];

      if (lastQ[idx] === qNow) continue; // Already updated in Top-20 this quantum
      const sqI = accSqSums[i];
      const sqJ = accSqSums[j];
      const existing = cov[idx];
      if (existing === 0 && (sqI <= sqFloor || sqJ <= sqFloor)) {
        lastQ[idx] = qNow;
        continue;
      }

      const lag = qNow - lastQ[idx];
      const aW = lag < 64 ? alphaLut[lag] : 1.0 - Math.exp(-(lag * quantumLen * this.dt) / this.rmsWindowTimeConstant);
      const dW = 1.0 - aW;

      let dot = 0;
      if (sqI > sqFloor && sqJ > sqFloor) {
        const offI = i * quantumLen;
        const offJ = j * quantumLen;
        let sum = 0;
        if (quantumLen === 128) {
          for (let s = 0; s < 128; s += 4) {
            sum +=
              accBlock[offI + s] * accBlock[offJ + s] +
              accBlock[offI + s + 1] * accBlock[offJ + s + 1] +
              accBlock[offI + s + 2] * accBlock[offJ + s + 2] +
              accBlock[offI + s + 3] * accBlock[offJ + s + 3];
          }
        } else {
          for (let s = 0; s < quantumLen; s++) {
            sum += accBlock[offI + s] * accBlock[offJ + s];
          }
        }
        dot = sum * invQ;
      }

      const val = existing * dW + dot * aW;
      cov[idx] = val;
      cov[symIdx] = val;
      lastQ[idx] = qNow;
    }

    this.isSilent = effectiveEnergy < 1e-10;
    this.samplesSinceLastSnapshot += quantumLen;

    if (this.samplesSinceLastSnapshot >= this.exactSnapshotInterval) {
      this.samplesSinceLastSnapshot -= this.exactSnapshotInterval;
      // Guard against runaway multi-fire if quantumLen > exactSnapshotInterval
      if (this.samplesSinceLastSnapshot >= this.exactSnapshotInterval) {
        this.samplesSinceLastSnapshot %= this.exactSnapshotInterval;
      }
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
