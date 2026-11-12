/**
 * Modal Solver: Generalized Single-Degree-of-Freedom Oscillators
 * Features:
 * - 20 Hz to 20,000 Hz full-band frequency coverage across the complete 557-mode Kirchhoff catalogue.
 * - Coherent complex spatial superposition for pure test tones: A_hat(x, y) = sum [ a_hat_mn * phi_mn(x, y) ].
 * - Exact discrete-time ZOH state transition for real-time audio playback.
 * - Natural physical exponential free decay e^(-zeta * omega * t) when excitation ceases.
 */

import { ModalSnapshot, ModeState, PlateGeometry, PlateMaterial } from './types.ts';
import {
  calculateAnalyticalFrequency,
  calculateModalMass,
  computeHarmonicModalAccelerations,
  DEFAULT_ALUMINUM,
  DEFAULT_GEOMETRY,
  generateModalCatalogue,
  ModalPhasorComponent,
  ModeCatalogueItem,
  modeShape,
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

  // Full 20 Hz – 20,000 Hz modal catalogue (557 modes for default plate)
  fullCatalogue: ModeCatalogueItem[] = [];

  // Single-tone harmonic mode state
  isHarmonicToneMode: boolean = true;
  harmonicToneFrequency: number = 53.96;
  isHarmonicPlaying: boolean = false;
  private harmonicPhasors: ModalPhasorComponent[] = [];
  private harmonicEnvelope: number = 0.0;
  private lastHarmonicUpdateTime: number = 0;
  private dominantDecayRate: number = 3.39; // zeta * omega_11

  // Audio file broadband covariance matrix R_ij
  covarianceMatrix: Float64Array;
  rmsWindowTimeConstant: number = 0.08;

  // Cached typed array to eliminate allocation churn
  private phisCache: Float64Array;

  constructor(
    material: PlateMaterial = DEFAULT_ALUMINUM,
    geometry: PlateGeometry = DEFAULT_GEOMETRY,
    dampingRatio: number = 0.01,
    activeIndices?: { m: number; n: number }[]
  ) {
    this.material = material;
    this.geometry = geometry;
    this.dampingRatio = dampingRatio;

    // Generate the full modal catalogue up to 20 kHz (557 modes)
    this.fullCatalogue = generateModalCatalogue(20000, material, geometry);

    const initialModes =
      activeIndices && activeIndices.length > 0
        ? activeIndices.map(({ m, n }) => {
            const f = calculateAnalyticalFrequency(m, n, material, geometry);
            return {
              m,
              n,
              frequency: f,
              omega: 2 * Math.PI * f,
              modalMass: calculateModalMass(material, geometry),
              centerCoupling: modeShape(m, n, geometry.sideLength / 2, geometry.sideLength / 2, geometry.sideLength),
              isOddOdd: m % 2 !== 0 && n % 2 !== 0,
            };
          })
        : this.fullCatalogue.filter((m) => m.isOddOdd && m.frequency <= 2700);

    const nModes = initialModes.length;
    this.covarianceMatrix = new Float64Array(nModes * nModes);
    this.phisCache = new Float64Array(nModes);

    const M = calculateModalMass(material, geometry);
    this.modes = initialModes.map((m) => {
      const omega = m.omega;
      const omegaD = omega * Math.sqrt(Math.max(0, 1 - dampingRatio * dampingRatio));
      return {
        m: m.m,
        n: m.n,
        frequency: m.frequency,
        omega,
        omegaD,
        modalMass: M,
        modalStiffness: M * omega * omega,
        modalDamping: 2 * M * dampingRatio * omega,
        displacement: 0,
        velocity: 0,
        acceleration: 0,
        generalizedForce: 0,
        dampingRatio,
        active: true,
      };
    });

    // Initialize default test tone at fundamental mode (53.96 Hz)
    this.setHarmonicTone(53.96, false);
  }

  reset(): void {
    for (const mode of this.modes) {
      mode.displacement = 0;
      mode.velocity = 0;
      mode.acceleration = 0;
      mode.generalizedForce = 0;
    }
    this.covarianceMatrix.fill(0);
    this.harmonicEnvelope = 0;
  }

  computeGeneralizedForces(
    isPointForce: boolean,
    excitationValue: number,
    x0: number = 0.15,
    y0: number = 0.15
  ): void {
    const L = this.geometry.sideLength;
    for (const mode of this.modes) {
      if (isPointForce) {
        mode.generalizedForce = excitationValue * modeShape(mode.m, mode.n, x0, y0, L);
      } else {
        if (mode.m % 2 !== 0 && mode.n % 2 !== 0) {
          const couplingArea = (4 * L * L) / (mode.m * mode.n * Math.PI * Math.PI);
          mode.generalizedForce = excitationValue * couplingArea;
        } else {
          mode.generalizedForce = 0;
        }
      }
    }
  }

  stepExactZOH(dt: number): void {
    for (const mode of this.modes) {
      if (!mode.active) continue;

      const omega = mode.omega;
      const zeta = mode.dampingRatio;
      const omegaD = mode.omegaD;
      const M = mode.modalMass;
      const u = mode.generalizedForce / M;

      const qEq = u / (omega * omega);
      const q0Tilde = mode.displacement - qEq;
      const v0 = mode.velocity;

      const expDecay = Math.exp(-zeta * omega * dt);
      const cosTerm = Math.cos(omegaD * dt);
      const sinTerm = Math.sin(omegaD * dt);

      const qTildeNew = expDecay * (q0Tilde * cosTerm + ((v0 + zeta * omega * q0Tilde) / omegaD) * sinTerm);
      const vNew = expDecay * (v0 * cosTerm - ((omega * omega * q0Tilde + zeta * omega * v0) / omegaD) * sinTerm);

      mode.displacement = qTildeNew + qEq;
      mode.velocity = vNew;
      mode.acceleration = u - 2 * zeta * omega * vNew - omega * omega * mode.displacement;
    }

    this.updateCovarianceMatrix(dt);
  }

  updateCovarianceMatrix(dt: number): void {
    const alpha = 1.0 - Math.exp(-dt / this.rmsWindowTimeConstant);
    const n = this.modes.length;

    for (let i = 0; i < n; i++) {
      const ai = this.modes[i].active ? this.modes[i].acceleration : 0;
      for (let j = 0; j < n; j++) {
        const aj = this.modes[j].active ? this.modes[j].acceleration : 0;
        const idx = i * n + j;
        this.covarianceMatrix[idx] = this.covarianceMatrix[idx] * (1 - alpha) + (ai * aj) * alpha;
      }
    }
  }

  /**
   * Sets single-tone generator frequency (20 Hz - 20,000 Hz) and play state.
   * Computes the exact coherent harmonic phasors across the entire modal catalogue.
   */
  setHarmonicTone(frequency: number, isPlaying: boolean): void {
    this.isHarmonicToneMode = true;
    this.harmonicToneFrequency = Math.max(20, Math.min(20000, frequency));
    this.isHarmonicPlaying = isPlaying;

    // Evaluate complex frequency response across all 557 modes
    this.harmonicPhasors = computeHarmonicModalAccelerations(
      this.harmonicToneFrequency,
      this.fullCatalogue,
      3.0, // F0 = 3 N center shaker force
      this.dampingRatio
    );

    // Find resonant mode nearest to frequency to determine physical free decay rate
    let nearestDist = Infinity;
    let resonantOmega = 2 * Math.PI * 53.96;
    for (let i = 0; i < this.harmonicPhasors.length; i++) {
      const p = this.harmonicPhasors[i];
      const mag = Math.sqrt(p.aReal * p.aReal + p.aImag * p.aImag);
      if (mag > 10.0) {
        resonantOmega = 2 * Math.PI * this.harmonicToneFrequency;
        break;
      }
    }
    this.dominantDecayRate = Math.max(1.0, this.dampingRatio * resonantOmega);

    if (isPlaying) {
      this.harmonicEnvelope = 1.0;
    }
    this.lastHarmonicUpdateTime = performance.now();
  }

  /**
   * Advances the harmonic tone free-decay envelope when tone is stopped.
   */
  updateHarmonicDecay(nowMs: number = performance.now()): void {
    if (!this.isHarmonicToneMode) return;

    const dt = (nowMs - this.lastHarmonicUpdateTime) / 1000.0;
    this.lastHarmonicUpdateTime = nowMs;

    if (this.isHarmonicPlaying) {
      // Rapid smooth ramp-up
      this.harmonicEnvelope = Math.min(1.0, this.harmonicEnvelope + dt * 20.0);
    } else if (this.harmonicEnvelope > 0) {
      // Physically authentic exponential decay e^(-zeta * omega * dt)
      this.harmonicEnvelope *= Math.exp(-this.dominantDecayRate * dt);
      if (this.harmonicEnvelope < 1e-5) {
        this.harmonicEnvelope = 0;
      }
    }
  }

  /**
   * Switches to broadband audio file playback mode and applies worklet snapshot.
   */
  applySnapshot(snapshot: ModalSnapshot): void {
    this.isHarmonicToneMode = false;
    const n = Math.min(this.modes.length, snapshot.displacements.length);
    for (let i = 0; i < n; i++) {
      this.modes[i].displacement = snapshot.displacements[i];
      this.modes[i].velocity = snapshot.velocities[i];
      this.modes[i].acceleration = snapshot.accelerations[i];
    }
    const covLen = Math.min(this.covarianceMatrix.length, snapshot.covarianceMatrix.length);
    for (let i = 0; i < covLen; i++) {
      this.covarianceMatrix[i] = snapshot.covarianceMatrix[i];
    }
  }

  /**
   * Evaluates RMS acceleration field a_rms(x, y) [m/s^2]:
   * - For single tone: Coherent complex spatial summation over all 557 modes:
   *   A_hat(x, y) = sum_mn [ a_hat_mn * phi_mn(x, y) ]
   *   a_rms = |A_hat| / sqrt(2) * envelope(t)
   * - For audio file: Quadratic form sum_i sum_j R_ij * phi_i * phi_j from AudioWorklet covariance.
   */
  evaluateRmsAcceleration(x: number, y: number): number {
    const L = this.geometry.sideLength;

    // Broadband audio file playback mode or direct covariance matrix evaluation:
    if (!this.isHarmonicToneMode || this.covarianceMatrix[0] > 1e-12) {
      const n = this.modes.length;
      let sumRmsSq = 0;
      const phis = this.phisCache;

      for (let i = 0; i < n; i++) {
        phis[i] = modeShape(this.modes[i].m, this.modes[i].n, x, y, L);
      }

      for (let i = 0; i < n; i++) {
        if (phis[i] === 0.0) continue;
        const phi_i = phis[i];
        const rowOffset = i * n;

        for (let j = 0; j < n; j++) {
          if (phis[j] === 0.0) continue;
          const R_ij = this.covarianceMatrix[rowOffset + j];
          sumRmsSq += R_ij * phi_i * phis[j];
        }
      }

      return Math.sqrt(Math.max(0, sumRmsSq));
    }

    // Single-tone harmonic mode: evaluate coherent complex phasor sum across all 557 modes
    if (this.harmonicEnvelope <= 1e-5) {
      return 0.0;
    }

    let realSum = 0;
    let imagSum = 0;
    const phasors = this.harmonicPhasors;
    const count = phasors.length;

    for (let i = 0; i < count; i++) {
      const p = phasors[i];
      const phi = modeShape(p.m, p.n, x, y, L);
      if (phi === 0) continue;
      realSum += p.aReal * phi;
      imagSum += p.aImag * phi;
    }

    // Phasor magnitude divided by sqrt(2) for true RMS
    const aRmsSteady = Math.sqrt(realSum * realSum + imagSum * imagSum) / Math.SQRT2;
    return aRmsSteady * this.harmonicEnvelope;
  }

  /**
   * Evaluates instantaneous deflection w(x, y, t) [m]
   */
  evaluateDisplacement(x: number, y: number): number {
    let w = 0;
    const L = this.geometry.sideLength;
    for (let i = 0; i < this.modes.length; i++) {
      const mode = this.modes[i];
      if (mode.active) {
        w += mode.displacement * modeShape(mode.m, mode.n, x, y, L);
      }
    }
    return w;
  }
}
