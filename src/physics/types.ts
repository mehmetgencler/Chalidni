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
  omegaD: number;        // rad/s (damped angular frequency: omega * sqrt(1 - zeta^2))
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

export interface DimensionalTransportConfig {
  particleCount: number;
  dRef: number;       // m^2/s (reference diffusivity scale)
  gammaC: number;     // dimensionless critical acceleration ratio (a_rms / g)
  power: number;      // dimensionless scaling exponent (p)
  g: number;          // m/s^2 (gravitational acceleration, 9.80665)
  dt: number;         // s
  seed: number;
  subThresholdCreepFloor?: number; // m^2/s, explicit optional floor (default 0.0)
}

/**
 * Snapshot emitted by the AudioWorklet thread at controlled ~60 Hz intervals
 */
export interface ModalSnapshot {
  sampleFramesProcessed: number;
  sampleRate: number;
  elapsedSimTime: number;
  displacements: number[];
  velocities: number[];
  accelerations: number[];
  covarianceMatrix: number[];
  isPlaying: boolean;
  isSilent: boolean;
  quantumCount: number;
}

export type TestLayer =
  | 'A_MATHEMATICAL'
  | 'B_NUMERICAL'
  | 'C_BROWSER_INTEGRATION'
  | 'D_PHYSICAL_HARDWARE';

export interface VerificationResult {
  layer: TestLayer;
  category: string;
  testName: string;
  passed: boolean;
  status: 'PASS' | 'FAIL' | 'NOT_RUN';
  expected: string;
  measured: string;
  absoluteError?: number;
  relativeErrorPercent?: number;
  uncertaintyStdDev?: number;
  passCriterion: string;
  details: string;
}

export interface ConvergenceData {
  timestepSteps: { dt: number; rmsAmplitude: number; maxRelativeError: number }[];
  gridSteps: {
    resolution: number;
    correlationWithAnalytical: number;
    l2Error: number;
    normalizedL2Error: number;
    meanDiffusivity: number;
  }[];
}

export interface DetailedFramePerformance {
  medianFrameTimeMs: number;
  p95FrameTimeMs: number;
  worstFrameTimeMs: number;
  particleUpdateTimeMs: number;
  canvasRenderTimeMs: number;
  measuredFps: number;
}

export interface BenchmarkResult {
  particleCount: number;
  avgFps: number;
  minFps: number;
  physicsUpdateTimeMs: number;
  audioTimeMs: number;
  detailedPerformance?: DetailedFramePerformance;
  memoryBreakdown: {
    particleStateKb: number;
    densityGridsKb: number;
    audioBuffersKb: number;
    canvasBackingStoreMb: number;
    jsRuntimeHeapStatus: 'MEASURED' | 'NOT_MEASURED';
    jsRuntimeHeapMb?: number;
  };
}
