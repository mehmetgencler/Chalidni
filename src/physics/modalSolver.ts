/**
 * Modal Solver: Generalized Single-Degree-of-Freedom Oscillators
 * Numerically and analytically integrates modal coordinates q_mn(t)
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

  constructor(
    material: PlateMaterial = DEFAULT_ALUMINUM,
    geometry: PlateGeometry = DEFAULT_GEOMETRY,
    dampingRatio: number = 0.01,
    activeIndices: { m: number; n: number }[] = [
      { m: 1, n: 1 }, // 53.9 Hz
      { m: 1, n: 2 }, // 134.8 Hz
      { m: 2, n: 1 }, // 134.8 Hz
      { m: 2, n: 2 }, // 215.8 Hz
      { m: 1, n: 3 }, // 269.8 Hz
      { m: 3, n: 1 }, // 269.8 Hz
      { m: 2, n: 3 }, // 350.8 Hz
      { m: 3, n: 3 }, // 485.7 Hz
    ]
  ) {
    this.material = material;
    this.geometry = geometry;
    this.dampingRatio = dampingRatio;
    this.initModes(activeIndices);
  }

  initModes(indices: { m: number; n: number }[]): void {
    const M = calculateModalMass(this.material, this.geometry);
    this.modes = indices.map(({ m, n }) => {
      const f = calculateAnalyticalFrequency(m, n, this.material, this.geometry);
      const omega = 2 * Math.PI * f;
      const K = M * omega * omega;
      const C = 2 * M * this.dampingRatio * omega;

      return {
        m,
        n,
        frequency: f,
        omega,
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
  }

  /**
   * Updates generalized modal force Q_mn given current excitation input.
   * pointForce: Force in N at (x0, y0)
   * uniformPressure: Pressure in Pa over plate
   */
  computeGeneralizedForces(
    isPointForce: boolean,
    excitationValue: number, // N or Pa
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
        // Point force excitation: Q_mn = F(t) * phi_mn(x0, y0)
        const coupling = pointForceModalCoupling(mode.m, mode.n, x0, y0, L);
        mode.generalizedForce = excitationValue * coupling;
      } else {
        // Uniform acoustic pressure: Q_mn = p(t) * integral(phi_mn)
        const couplingArea = uniformPressureModalCoupling(mode.m, mode.n, L);
        mode.generalizedForce = excitationValue * couplingArea;
      }
    }
  }

  /**
   * Runge-Kutta 4 (RK4) numerical integration step for all active modes
   * d2q/dt2 = (Q - C*dq/dt - K*q) / M
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

      // Combine
      mode.displacement = q0 + (dt / 6) * (k1_q + 2 * k2_q + 2 * k3_q + k4_q);
      mode.velocity = v0 + (dt / 6) * (k1_v + 2 * k2_v + 2 * k3_v + k4_v);
      mode.acceleration = fAcc(mode.displacement, mode.velocity);
    }
  }

  /**
   * Computes surface displacement w(x, y) = sum q_mn * phi_mn(x, y)
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
   * Computes surface acceleration a(x, y) = sum a_mn * phi_mn(x, y)
   */
  evaluateAcceleration(x: number, y: number): number {
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
   * Computes RMS acceleration field contribution for steady-state diffusivity
   */
  evaluateRmsAcceleration(x: number, y: number): number {
    let totalAccSq = 0;
    const L = this.geometry.sideLength;
    for (const mode of this.modes) {
      if (mode.active) {
        // In harmonic vibration, a_peak = omega^2 * q_peak, a_rms = a_peak / sqrt(2)
        // Here we use instantaneous acceleration or mode acceleration amplitude
        const phi = modeShape(mode.m, mode.n, x, y, L);
        const a_val = mode.acceleration * phi;
        totalAccSq += a_val * a_val;
      }
    }
    return Math.sqrt(totalAccSq);
  }
}
