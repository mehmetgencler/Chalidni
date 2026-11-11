/**
 * Physical types and interfaces for Chladni Plate Workbench
 */

export interface PlateMaterial {
  name: string;
  youngsModulus: number; // Pa (E)
  density: number;       // kg/m^3 (rho)
  poissonRatio: number;  // dimensionless (nu)
}

export interface PlateGeometry {
  sideLength: number; // m (L)
  thickness: number;  // m (h)
}

export interface ModeIndex {
  m: number; // half-waves in x
  n: number; // half-waves in y
}

export interface ModeState {
  m: number;
  n: number;
  frequency: number;     // Hz (f_mn)
  omega: number;         // rad/s (omega_mn)
  modalMass: number;     // kg (M_mn)
  modalStiffness: number;// N/m (K_mn)
  modalDamping: number;  // N*s/m (C_mn)
  displacement: number;  // m (q_mn)
  velocity: number;      // m/s (dq_mn/dt)
  acceleration: number;  // m/s^2 (d2q_mn/dt^2)
  generalizedForce: number; // N (Q_mn)
  dampingRatio: number;  // zeta
  active: boolean;
}

export type ExcitationType = 'point' | 'uniform';

export interface ExcitationConfig {
  type: ExcitationType;
  pointLocation: { x: number; y: number }; // normalized [0, 1]
  amplitude: number; // N for point force, Pa for uniform pressure
}

export interface Particle {
  x: number; // [0, L]
  y: number; // [0, L]
  vx: number;
  vy: number;
  active: boolean;
}

export interface TransportConfig {
  particleCount: number;
  baseDiffusivity: number; // D0 (m^2/s)
  accelerationCoupling: number; // alpha
  dt: number; // s
  seed: number;
}

export interface VerificationResult {
  category: string;
  testName: string;
  passed: boolean;
  expected: string;
  measured: string;
  relativeErrorPercent?: number;
  details: string;
}

export interface ConvergenceData {
  timestepSteps: { dt: number; rmsAmplitude: number; maxRelativeError: number }[];
  gridSteps: { resolution: number; correlationWithAnalytical: number; meanDiffusivity: number }[];
}

export interface BenchmarkResult {
  particleCount: number;
  avgFps: number;
  minFps: number;
  physicsUpdateTimeMs: number;
  audioTimeMs: number;
  memoryEstimateMb: number;
}
