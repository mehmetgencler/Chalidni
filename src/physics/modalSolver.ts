/**
 * Modal Solver: Generalized Single-Degree-of-Freedom Oscillators
 * Features exact discrete-time state transition under zero-order-held force,
 * sample-rate audio stream stepping, and true time-window modal covariance RMS acceleration.
 */

import { ModeState, PlateGeometry, PlateMaterial } from './types.ts';
import {
  calculateAnalyticalFrequency,
  calculateAnalyticalOmega,
  calculateModalMass,
  DEFAULT_ALUMINUM,
  DEFAULT_GEOMETRY,
  modeShape,
  pointForceModalCoupling,
  uniformPressureModalCoupling,
} from './plate.ts';

export interface AnalyticalHarmonicResponse {
  amplitude: number; // m
  phaseLag: number;  // radians [0, pi]
  resonanceFrequency: number; // Hz
}

/**
 * Analytical steady-state response for harmonic excitation Q(t) = Q0 * cos(Omega * t):
 * |q| = Q0 / [M * sqrt((omega^2 - Omega^2)^2 + (2 * zeta * omega * Omega)^2)]
 * delta = atan2(2 * zeta * omega * Omega, omega^2 - Omega^2)
 */
export function calculateAnalyticalHarmonicResponse(
  Q0: number,
  M: number,
  omega: number,
  Omega: number,
  zeta: number
): AnalyticalHarmonicResponse {
  const deltaOmegaSq = omega * omega - Omega * Omega;
  const dampingTerm = 2 * zeta * omega * Omega;
  const denom = M * Math.sqrt(deltaOmegaSq * deltaOmegaSq + dampingTerm * dampingTerm);

  const amplitude = denom > 1e-18 ? Q0 / denom : 0;
  const phaseLag = Math.atan2(dampingTerm, deltaOmegaSq);

  return {
    amplitude,
    phaseLag,
    resonanceFrequency: omega / (2 * Math.PI),
  };
}

export class ModalBank {
  modes: ModeState[] = [];
  material: PlateMaterial;
  geometry: PlateGeometry;
  dampingRatio: number;

  // Modal acceleration covariance matrix R_ij for true time-window RMS acceleration
  // Dimension: numModes x numModes
  covarianceMatrix: Float64Array;
  rmsWindowTimeConstant: number = 0.08; // 80 ms moving time-window

  constructor(
    material: PlateMaterial = DEFAULT_ALUMINUM,
    geometry: PlateGeometry = DEFAULT_GEOMETRY,
    dampingRatio: number = 0.01,
    activeIndices: { m: number; n: number }[] = [
      { m: 1, n: 1 }, // 53.96 Hz
      { m: 1, n: 2 }, // 134.91 Hz
      { m: 2, n: 1 }, // 134.91 Hz
      { m: 2, n: 2 }, // 215.85 Hz
      { m: 1, n: 3 }, // 269.81 Hz
      { m: 3, n: 1 }, // 269.81 Hz
      { m: 2, n: 3 }, // 350.76 Hz
      { m: 3, n: 3 }, // 485.67 Hz
    ]
  ) {
    this.material = material;
    this.geometry = geometry;
    this.dampingRatio = dampingRatio;
    this.covarianceMatrix = new Float64Array(activeIndices.length * activeIndices.length);
    this.initModes(activeIndices);
  }

  initModes(indices: { m: number; n: number }[]): void {
    const M = calculateModalMass(this.material, this.geometry);
    const nModes = indices.length;
    this.covarianceMatrix = new Float64Array(nModes * nModes);

    this.modes = indices.map(({ m, n }) => {
      const f = calculateAnalyticalFrequency(m, n, this.material, this.geometry);
      const omega = 2 * Math.PI * f;
      const omegaD = omega * Math.sqrt(Math.max(0, 1 - this.dampingRatio * this.dampingRatio));
      const K = M * omega * omega;
      const C = 2 * M * this.dampingRatio * omega;

      return {
        m,
        n,
        frequency: f,
        omega,
        omegaD,
        modalMass: M,
        modalStiffness: K,
        modalDamping: C,
        displacement: 0,
        velocity: 0,
        acceleration: 0,
        generalizedForce: 0,
        dampingRatio: this.dampingRatio,
        active: true,
      };
    });
  }

  reset(): void {
    for (const mode of this.modes) {
      mode.displacement = 0;
      mode.velocity = 0;
      mode.acceleration = 0;
      mode.generalizedForce = 0;
    }
    this.covarianceMatrix.fill(0);
  }

  /**
   * Computes generalized force for all modes from a single scalar excitation input.
   */
  computeGeneralizedForces(
    isPointForce: boolean,
    excitationValue: number, // N for point force, Pa for uniform pressure
    x0: number = 0.15,
    y0: number = 0.15
  ): void {
    const L = this.geometry.sideLength;
    for (const mode of this.modes) {
      if (!mode.active) {
        mode.generalizedForce = 0;
        continue;
      }
      if (isPointForce) {
        const coupling = pointForceModalCoupling(mode.m, mode.n, x0, y0, L);
        mode.generalizedForce = excitationValue * coupling;
      } else {
        const couplingArea = uniformPressureModalCoupling(mode.m, mode.n, L);
        mode.generalizedForce = excitationValue * couplingArea;
      }
    }
  }

  /**
   * PRIORITY 1: Exact discrete-time state transition for damped linear oscillator
   * under Zero-Order Held (ZOH) generalized force Q_k:
   * 
   * q̈ + 2ζωq̇ + ω²q = u, where u = Q / M.
   * Static equilibrium q_eq = u / ω²
   * Let q̃(t) = q(t) - q_eq.
   * q̃(t + dt) = exp(-ζω dt) * [ q̃(0)*cos(ω_d dt) + ((v(0) + ζω q̃(0))/ω_d)*sin(ω_d dt) ]
   * v(t + dt) = exp(-ζω dt) * [ v(0)*cos(ω_d dt) - ((ω² q̃(0) + ζω v(0))/ω_d)*sin(ω_d dt) ]
   * q(t + dt) = q̃(t + dt) + q_eq
   * 
   * This analytical state transition has discrete eigenvalues with modulus exp(-ζω dt) < 1,
   * guaranteeing unconditional numerical stability for ANY timestep dt > 0 (even dt = 16.6 ms on a 485 Hz mode).
   */
  stepExactZOH(dt: number): void {
    if (dt <= 0) return;

    const n = this.modes.length;
    for (let i = 0; i < n; i++) {
      const mode = this.modes[i];
      if (!mode.active) continue;

      const omega = mode.omega;
      const zeta = mode.dampingRatio;
      const omegaD = mode.omegaD;
      const M = mode.modalMass;
      const u = mode.generalizedForce / M;

      // Equilibrium offset under constant piece of force
      const qEq = u / (omega * omega);
      const q0Tilde = mode.displacement - qEq;
      const v0 = mode.velocity;

      const expDecay = Math.exp(-zeta * omega * dt);
      const cosTerm = Math.cos(omegaD * dt);
      const sinTerm = Math.sin(omegaD * dt);

      // Homogeneous step
      const qTildeNew = expDecay * (q0Tilde * cosTerm + ((v0 + zeta * omega * q0Tilde) / omegaD) * sinTerm);
      const vNew = expDecay * (v0 * cosTerm - ((omega * omega * q0Tilde + zeta * omega * v0) / omegaD) * sinTerm);

      mode.displacement = qTildeNew + qEq;
      mode.velocity = vNew;
      // Instantaneous acceleration from equation of motion: a = u - 2*zeta*omega*v - omega^2*q
      mode.acceleration = u - 2 * zeta * omega * vNew - omega * omega * mode.displacement;
    }

    // Update modal covariance matrix for true time RMS
    this.updateCovarianceMatrix(dt);
  }

  /**
   * PRIORITY 2: Advances modal oscillator through an entire buffer of sequential audio samples
   * at sample rate f_s (e.g. 44.1 kHz or 48 kHz).
   * Applies excitation gain exactly once.
   */
  stepSampleBuffer(
    samples: Float32Array,
    sampleRate: number,
    isPointForce: boolean,
    x0: number,
    y0: number,
    gain: number
  ): void {
    if (samples.length === 0 || sampleRate <= 0) return;

    const dt = 1 / sampleRate;
    const L = this.geometry.sideLength;
    const nModes = this.modes.length;

    // Precompute couplings and mode-specific exponential transition coefficients for sampleRate
    const couplings = new Float64Array(nModes);
    const expDecays = new Float64Array(nModes);
    const cosTerms = new Float64Array(nModes);
    const sinTerms = new Float64Array(nModes);

    for (let i = 0; i < nModes; i++) {
      const mode = this.modes[i];
      if (!mode.active) continue;

      couplings[i] = isPointForce
        ? pointForceModalCoupling(mode.m, mode.n, x0, y0, L)
        : uniformPressureModalCoupling(mode.m, mode.n, L);

      expDecays[i] = Math.exp(-mode.dampingRatio * mode.omega * dt);
      cosTerms[i] = Math.cos(mode.omegaD * dt);
      sinTerms[i] = Math.sin(mode.omegaD * dt);
    }

    // Step through sequential samples
    for (let s = 0; s < samples.length; s++) {
      const rawSample = samples[s];
      // Excitation value with gain applied strictly once here:
      const excValue = rawSample * gain;

      for (let i = 0; i < nModes; i++) {
        const mode = this.modes[i];
        if (!mode.active) continue;

        const Q = excValue * couplings[i];
        mode.generalizedForce = Q;

        const omega = mode.omega;
        const zeta = mode.dampingRatio;
        const omegaD = mode.omegaD;
        const M = mode.modalMass;
        const u = Q / M;

        const qEq = u / (omega * omega);
        const q0Tilde = mode.displacement - qEq;
        const v0 = mode.velocity;

        const expDecay = expDecays[i];
        const cosTerm = cosTerms[i];
        const sinTerm = sinTerms[i];

        const qTildeNew = expDecay * (q0Tilde * cosTerm + ((v0 + zeta * omega * q0Tilde) / omegaD) * sinTerm);
        const vNew = expDecay * (v0 * cosTerm - ((omega * omega * q0Tilde + zeta * omega * v0) / omegaD) * sinTerm);

        mode.displacement = qTildeNew + qEq;
        mode.velocity = vNew;
        mode.acceleration = u - 2 * zeta * omega * vNew - omega * omega * mode.displacement;
      }

      this.updateCovarianceMatrix(dt);
    }
  }

  /**
   * Classical 4th-order Runge-Kutta step (preserved for verification comparisons)
   */
  stepRK4(dt: number): void {
    for (const mode of this.modes) {
      if (!mode.active) continue;

      const M = mode.modalMass;
      const C = mode.modalDamping;
      const K = mode.modalStiffness;
      const Q = mode.generalizedForce;

      const fAcc = (q: number, v: number): number => {
        return (Q - C * v - K * q) / M;
      };

      const q0 = mode.displacement;
      const v0 = mode.velocity;

      // k1
      const k1_v = fAcc(q0, v0);
      const k1_q = v0;

      // k2
      const q_half1 = q0 + 0.5 * dt * k1_q;
      const v_half1 = v0 + 0.5 * dt * k1_v;
      const k2_v = fAcc(q_half1, v_half1);
      const k2_q = v_half1;

      // k3
      const q_half2 = q0 + 0.5 * dt * k2_q;
      const v_half2 = v0 + 0.5 * dt * k2_v;
      const k3_v = fAcc(q_half2, v_half2);
      const k3_q = v_half2;

      // k4
      const q_end = q0 + dt * k3_q;
      const v_end = v0 + dt * k3_v;
      const k4_v = fAcc(q_end, v_end);
      const k4_q = v_end;

      mode.displacement = q0 + (dt / 6) * (k1_q + 2 * k2_q + 2 * k3_q + k4_q);
      mode.velocity = v0 + (dt / 6) * (k1_v + 2 * k2_v + 2 * k3_v + k4_v);
      mode.acceleration = fAcc(mode.displacement, mode.velocity);
    }

    this.updateCovarianceMatrix(dt);
  }

  /**
   * PRIORITY 3: Continuous update of the modal acceleration covariance matrix R_ij:
   * R_ij = (1/T) ∫ a_i(t) a_j(t) dt
   * Maintained via exponential moving window with time constant tau = 0.08s
   */
  private updateCovarianceMatrix(dt: number): void {
    const alpha = 1.0 - Math.exp(-dt / this.rmsWindowTimeConstant);
    const n = this.modes.length;

    for (let i = 0; i < n; i++) {
      const ai = this.modes[i].active ? this.modes[i].acceleration : 0;
      for (let j = 0; j < n; j++) {
        const aj = this.modes[j].active ? this.modes[j].acceleration : 0;
        const idx = i * n + j;
        const currentVal = this.covarianceMatrix[idx];
        this.covarianceMatrix[idx] = currentVal * (1 - alpha) + (ai * aj) * alpha;
      }
    }
  }

  /**
   * Evaluates the surface displacement w(x, y, t) = sum q_mn(t) * phi_mn(x, y)
   */
  evaluateDisplacement(x: number, y: number): number {
    let w = 0;
    const L = this.geometry.sideLength;
    for (const mode of this.modes) {
      if (mode.active) {
        w += mode.displacement * modeShape(mode.m, mode.n, x, y, L);
      }
    }
    return w;
  }

  /**
   * Evaluates the instantaneous surface acceleration a_z(x, y, t) = sum a_mn(t) * phi_mn(x, y)
   */
  evaluateInstantaneousAcceleration(x: number, y: number): number {
    let a = 0;
    const L = this.geometry.sideLength;
    for (const mode of this.modes) {
      if (mode.active) {
        a += mode.acceleration * modeShape(mode.m, mode.n, x, y, L);
      }
    }
    return a;
  }

  /**
   * PRIORITY 3: Calculates true time-window RMS acceleration field:
   * a_rms(x, y) = sqrt[ (1/T) ∫ a_z(x, y, t)^2 dt ]
   *             = sqrt[ sum_i sum_j R_ij * phi_i(x, y) * phi_j(x, y) ]
   * 
   * Strictly preserves phase relationships and cross-terms between modes.
   * For single sinusoid of peak acceleration A: returns A / sqrt(2).
   * For degenerate/coherent modes: correctly retains non-zero cross terms.
   * Does NOT depend on Canvas frame rate.
   */
  evaluateRmsAcceleration(x: number, y: number): number {
    const L = this.geometry.sideLength;
    const n = this.modes.length;
    let sumRmsSq = 0;

    // Cache mode shapes at (x, y)
    const phis = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      if (this.modes[i].active) {
        phis[i] = modeShape(this.modes[i].m, this.modes[i].n, x, y, L);
      }
    }

    // sum_i sum_j R_ij * phi_i * phi_j
    for (let i = 0; i < n; i++) {
      if (!this.modes[i].active || phis[i] === 0) continue;
      const phi_i = phis[i];

      for (let j = 0; j < n; j++) {
        if (!this.modes[j].active || phis[j] === 0) continue;
        const R_ij = this.covarianceMatrix[i * n + j];
        sumRmsSq += R_ij * phi_i * phis[j];
      }
    }

    return Math.sqrt(Math.max(0, sumRmsSq));
  }
}
