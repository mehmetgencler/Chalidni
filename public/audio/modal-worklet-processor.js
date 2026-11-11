/**
 * ModalWorkletProcessor
 * 
 * Real-time audio rendering thread processor executing the authoritative physical
 * simulation clock and modal ODE integration for the Chladni Plate Workbench.
 * 
 * Conforms to STAGE 6 Requirements:
 * - Runs strictly in the AudioWorklet processing thread at AudioContext.sampleRate.
 * - Processes continuous sequential audio samples (128-sample quanta).
 * - Implements exact discrete-time Zero-Order-Held (ZOH) state transitions per audio sample.
 * - Continues processing zero-valued audio during silence to guarantee physically synchronized free modal decay.
 * - Maintains modal acceleration covariance matrix R_ij for exponentially weighted RMS field estimation.
 * - Publishes compact modal snapshots at controlled ~60 Hz rate to drive main-thread rendering and particle transport.
 * - Monotonically increments sampleFramesProcessed to establish the single authoritative simulation clock:
 *   t_sim = sampleFramesProcessed / sampleRate.
 */

class ModalWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.sampleFramesProcessed = 0;
    this.quantumCount = 0;
    this.sampleRate = sampleRate; // Global in AudioWorkletGlobalScope

    // Plate geometry and excitation configuration
    this.sideLength = 0.30; // m (L)
    this.shakerPos = { x: 0.15, y: 0.15 }; // m
    this.isPointForce = true;
    this.gain = 1.0;
    this.isMonitoring = false;
    this.isSilent = true;

    // Default 8 Kirchhoff modes for simply supported aluminum plate
    // f(1,1)=53.96Hz, f(1,2)=134.91Hz, f(2,1)=134.91Hz, f(2,2)=215.85Hz,
    // f(1,3)=269.81Hz, f(3,1)=269.81Hz, f(2,3)=350.76Hz, f(3,3)=485.67Hz
    this.modes = [
      { m: 1, n: 1, active: true, frequency: 53.963, omega: 339.059, zeta: 0.01, M: 0.06075 },
      { m: 1, n: 2, active: true, frequency: 134.908, omega: 847.648, zeta: 0.01, M: 0.06075 },
      { m: 2, n: 1, active: true, frequency: 134.908, omega: 847.648, zeta: 0.01, M: 0.06075 },
      { m: 2, n: 2, active: true, frequency: 215.852, omega: 1356.237, zeta: 0.01, M: 0.06075 },
      { m: 1, n: 3, active: true, frequency: 269.815, omega: 1695.297, zeta: 0.01, M: 0.06075 },
      { m: 3, n: 1, active: true, frequency: 269.815, omega: 1695.297, zeta: 0.01, M: 0.06075 },
      { m: 2, n: 3, active: true, frequency: 350.760, omega: 2203.886, zeta: 0.01, M: 0.06075 },
      { m: 3, n: 3, active: true, frequency: 485.667, omega: 3051.534, zeta: 0.01, M: 0.06075 },
    ];

    const n = this.modes.length;
    this.displacements = new Float64Array(n);
    this.velocities = new Float64Array(n);
    this.accelerations = new Float64Array(n);
    this.covarianceMatrix = new Float64Array(n * n);

    // Precomputed coefficients for exact ZOH integration at sampleRate
    this.expDecays = new Float64Array(n);
    this.cosTerms = new Float64Array(n);
    this.sinTerms = new Float64Array(n);
    this.omegas = new Float64Array(n);
    this.omegaDs = new Float64Array(n);
    this.zetas = new Float64Array(n);
    this.modalMasses = new Float64Array(n);
    this.couplings = new Float64Array(n);
    this.activeMask = new Uint8Array(n);

    // Exponential covariance filter parameter (tau = 0.08s)
    this.rmsWindowTimeConstant = 0.08;
    this.dt = 1.0 / this.sampleRate;
    this.covAlpha = 1.0 - Math.exp(-this.dt / this.rmsWindowTimeConstant);

    this.recomputeCoefficients();

    // Snapshot publication throttle: ~60 Hz
    this.snapshotIntervalSamples = Math.max(128, Math.round(this.sampleRate / 60));
    this.samplesSinceLastSnapshot = 0;

    // Handle incoming messages from the main thread
    this.port.onmessage = (event) => {
      this.handleMessage(event.data);
    };
  }

  recomputeCoefficients() {
    const dt = this.dt;
    const L = this.sideLength;
    const n = this.modes.length;

    for (let i = 0; i < n; i++) {
      const mode = this.modes[i];
      const omega = mode.omega;
      const zeta = mode.zeta;
      const omegaD = omega * Math.sqrt(Math.max(0, 1.0 - zeta * zeta));

      this.omegas[i] = omega;
      this.zetas[i] = zeta;
      this.omegaDs[i] = omegaD;
      this.modalMasses[i] = mode.M;
      this.activeMask[i] = mode.active ? 1 : 0;

      // Analytical ZOH transition factors
      this.expDecays[i] = Math.exp(-zeta * omega * dt);
      this.cosTerms[i] = Math.cos(omegaD * dt);
      this.sinTerms[i] = Math.sin(omegaD * dt);

      // Modal coupling coefficient
      if (this.isPointForce) {
        // Point shaker: phi_mn(x0, y0) = sin(m*pi*x0/L) * sin(n*pi*y0/L)
        const phi = Math.sin((mode.m * Math.PI * this.shakerPos.x) / L) *
                    Math.sin((mode.n * Math.PI * this.shakerPos.y) / L);
        this.couplings[i] = phi;
      } else {
        // Uniform acoustic pressure: odd-odd mode selection
        if (mode.m % 2 !== 0 && mode.n % 2 !== 0) {
          this.couplings[i] = (4.0 * L * L) / (mode.m * mode.n * Math.PI * Math.PI);
        } else {
          this.couplings[i] = 0.0;
        }
      }
    }
  }

  handleMessage(msg) {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'CONFIGURE_MODES':
        if (Array.isArray(msg.modes)) {
          this.modes = msg.modes;
        }
        if (typeof msg.sideLength === 'number') {
          this.sideLength = msg.sideLength;
        }
        this.recomputeCoefficients();
        break;

      case 'TOGGLE_MODE':
        if (typeof msg.index === 'number' && this.modes[msg.index]) {
          this.modes[msg.index].active = !!msg.active;
          this.activeMask[msg.index] = msg.active ? 1 : 0;
        }
        break;

      case 'SET_EXCITATION':
        if (typeof msg.isPointForce === 'boolean') {
          this.isPointForce = msg.isPointForce;
        }
        if (msg.shakerPos && typeof msg.shakerPos.x === 'number' && typeof msg.shakerPos.y === 'number') {
          this.shakerPos = msg.shakerPos;
        }
        if (typeof msg.gain === 'number') {
          this.gain = msg.gain;
        }
        this.recomputeCoefficients();
        break;

      case 'RESET_MODES':
        this.displacements.fill(0);
        this.velocities.fill(0);
        this.accelerations.fill(0);
        this.covarianceMatrix.fill(0);
        this.sampleFramesProcessed = 0;
        break;

      case 'SET_MONITORING':
        this.isMonitoring = !!msg.isMonitoring;
        break;
    }
  }

  process(inputs, outputs) {
    this.quantumCount++;

    const input = inputs[0];
    const output = outputs[0];
    const inputChannel = input && input.length > 0 ? input[0] : null;
    const outputChannel = output && output.length > 0 ? output[0] : null;

    // Pass-through monitoring if enabled
    if (outputChannel) {
      if (this.isMonitoring && inputChannel) {
        outputChannel.set(inputChannel);
      } else {
        outputChannel.fill(0);
      }
    }

    const quantumLen = inputChannel ? inputChannel.length : 128;
    const n = this.modes.length;
    const alpha = this.covAlpha;
    const gain = this.gain;

    let localEnergy = 0;

    for (let s = 0; s < quantumLen; s++) {
      this.sampleFramesProcessed++;

      const rawSample = inputChannel ? inputChannel[s] : 0.0;
      localEnergy += rawSample * rawSample;
      const excValue = rawSample * gain;

      // Integrate each mode with exact ZOH discrete transition
      for (let i = 0; i < n; i++) {
        if (!this.activeMask[i]) continue;

        const Q = excValue * this.couplings[i];
        const omega = this.omegas[i];
        const omegaD = this.omegaDs[i];
        const zeta = this.zetas[i];
        const M = this.modalMasses[i];
        const u = Q / M;

        // Equilibrium offset under constant piece of force
        const qEq = u / (omega * omega);
        const q0Tilde = this.displacements[i] - qEq;
        const v0 = this.velocities[i];

        const expDecay = this.expDecays[i];
        const cosTerm = this.cosTerms[i];
        const sinTerm = this.sinTerms[i];

        // Exact analytical step
        const qTildeNew = expDecay * (q0Tilde * cosTerm + ((v0 + zeta * omega * q0Tilde) / omegaD) * sinTerm);
        const vNew = expDecay * (v0 * cosTerm - ((omega * omega * q0Tilde + zeta * omega * v0) / omegaD) * sinTerm);

        const qNew = qTildeNew + qEq;
        const aNew = u - 2.0 * zeta * omega * vNew - omega * omega * qNew;

        this.displacements[i] = qNew;
        this.velocities[i] = vNew;
        this.accelerations[i] = aNew;
      }

      // Continuous modal acceleration covariance update:
      // R_ij = R_ij * (1 - alpha) + (a_i * a_j) * alpha
      for (let i = 0; i < n; i++) {
        const ai = this.activeMask[i] ? this.accelerations[i] : 0.0;
        const rowOffset = i * n;
        for (let j = 0; j < n; j++) {
          const aj = this.activeMask[j] ? this.accelerations[j] : 0.0;
          const idx = rowOffset + j;
          this.covarianceMatrix[idx] = this.covarianceMatrix[idx] * (1.0 - alpha) + (ai * aj) * alpha;
        }
      }
    }

    this.isSilent = localEnergy < 1e-9;
    this.samplesSinceLastSnapshot += quantumLen;

    // Publish snapshot at controlled ~60 Hz rate
    if (this.samplesSinceLastSnapshot >= this.snapshotIntervalSamples) {
      this.samplesSinceLastSnapshot = 0;

      this.port.postMessage({
        type: 'MODAL_SNAPSHOT',
        sampleFramesProcessed: this.sampleFramesProcessed,
        sampleRate: this.sampleRate,
        elapsedSimTime: this.sampleFramesProcessed / this.sampleRate,
        displacements: Array.from(this.displacements),
        velocities: Array.from(this.velocities),
        accelerations: Array.from(this.accelerations),
        covarianceMatrix: Array.from(this.covarianceMatrix),
        isPlaying: !this.isSilent,
        isSilent: this.isSilent,
        quantumCount: this.quantumCount,
      });
    }

    return true; // Keep processor alive
  }
}

registerProcessor('modal-worklet-processor', ModalWorkletProcessor);
