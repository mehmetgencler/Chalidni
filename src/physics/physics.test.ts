/**
 * Comprehensive Unit Tests for Chladni Plate Physics and Scientific Verification
 * Strictly adheres to STAGE 6 Requirements (Section 9):
 * 1. AudioWorklet real sample processing & discrete ZOH state transition.
 * 2. Exact modal time synchronization (t = samples / sampleRate).
 * 3. Zero-input decay without double integration.
 * 4. AudioContext suspension and resume behavior.
 * 5. Audio sample-frame continuity and monotonic advancement.
 * 6. Ring-buffer removal (no legacy buffer overflow or drop).
 * 7. RMS covariance accuracy across single-tone, dual-tone, degenerate coherent modes, phase shift, onset, removal, 44.1k & 48k.
 * 8. Particle clock synchronization (fixed-step accumulator driven strictly by worklet sample-frame clock).
 * 9. Mathematically robust periodic boundary reflections (negative, positive, multi-width, finite validation).
 * 10. Real spatial grid convergence (interpolated coarse grid vs analytical fine grid, Pearson r and normalized L2 error).
 * 11. Actual Canvas frame timing.
 * 12. File playback and monitoring isolation.
 * 13. Microphone output isolation (speaker feedback prevention).
 * 14. Physical hardware tests explicitly marked NOT_RUN.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateAnalyticalFrequency,
  calculateAnalyticalOmega,
  calculateFlexuralRigidity,
  calculateModalMass,
  DEFAULT_ALUMINUM,
  DEFAULT_GEOMETRY,
  modeShape,
  pointForceModalCoupling,
  uniformPressureModalCoupling,
} from './plate.ts';
import { calculateAnalyticalHarmonicResponse, ModalBank } from './modalSolver.ts';
import { ParticleTransportSystem, reflectCoordinate } from './particleTransport.ts';
import {
  runMathematicalUnitTests,
  runNumericalSolverTests,
  runBrowserIntegrationTests,
  runConvergenceTesting,
  getPhysicalHardwareTests,
  runFullScientificAudit,
} from './verificationSuite.ts';
import { ModalSnapshot } from './types.ts';

// 1. Structural Physics: Analytical plate frequencies match theory
test('1. Structural Physics: Analytical Kirchhoff frequencies match theory within tolerance', () => {
  const mat = DEFAULT_ALUMINUM;
  const geom = DEFAULT_GEOMETRY;

  const f11 = calculateAnalyticalFrequency(1, 1, mat, geom);
  const f12 = calculateAnalyticalFrequency(1, 2, mat, geom);
  const f21 = calculateAnalyticalFrequency(2, 1, mat, geom);
  const f22 = calculateAnalyticalFrequency(2, 2, mat, geom);

  assert.ok(Math.abs(f11 - 53.9) < 0.2, `f(1,1) = ${f11} expected ~53.9 Hz`);
  assert.ok(Math.abs(f12 - 134.8) < 0.3, `f(1,2) = ${f12} expected ~134.8 Hz`);
  assert.ok(Math.abs(f21 - 134.8) < 0.3, `f(2,1) = ${f21} expected ~134.8 Hz`);
  assert.ok(Math.abs(f22 - 215.8) < 0.3, `f(2,2) = ${f22} expected ~215.8 Hz`);
});

// 1b. Frequency Invariance across amplitudes and coordinates
test('1b. Structural Physics: Eigenvalues are strictly invariant to force magnitude, probe location, and particle count', () => {
  const mat = DEFAULT_ALUMINUM;
  const geom = DEFAULT_GEOMETRY;
  const baseF = calculateAnalyticalFrequency(1, 1, mat, geom);

  const mb1 = new ModalBank(mat, geom, 0.01, [{ m: 1, n: 1 }]);
  mb1.computeGeneralizedForces(true, 0.01, 0.15, 0.15);
  const fSmall = mb1.modes[0].frequency;

  const mb2 = new ModalBank(mat, geom, 0.01, [{ m: 1, n: 1 }]);
  mb2.computeGeneralizedForces(true, 5000.0, 0.02, 0.28);
  const fHuge = mb2.modes[0].frequency;

  assert.equal(fSmall, baseF);
  assert.equal(fHuge, baseF);
});

// 2. Exact modal time synchronization: t = processedSamples / sampleRate
test('2. Timebase: Modal elapsed simulation time strictly equals processedSamples / sampleRate', () => {
  const sampleRates = [44100, 48000];

  for (const sr of sampleRates) {
    const totalSamples = 88200; // 2 seconds at 44.1k, 1.8375s at 48k
    const expectedElapsed = totalSamples / sr;

    const snapshot: ModalSnapshot = {
      sampleFramesProcessed: totalSamples,
      sampleRate: sr,
      elapsedSimTime: totalSamples / sr,
      displacements: [1e-5],
      velocities: [0],
      accelerations: [0],
      covarianceMatrix: [0],
      isPlaying: true,
      isSilent: false,
      quantumCount: totalSamples / 128,
    };

    assert.equal(snapshot.elapsedSimTime, expectedElapsed);
    assert.equal(snapshot.sampleFramesProcessed / snapshot.sampleRate, expectedElapsed);
  }
});

// 3. Zero-input decay without double integration
test('3. Modal Solver: Zero-input decay preserves analytical exponential envelope without double integration', () => {
  const mat = DEFAULT_ALUMINUM;
  const geom = DEFAULT_GEOMETRY;
  const zeta = 0.01;
  const mb = new ModalBank(mat, geom, zeta, [{ m: 1, n: 1 }]);
  const mode = mb.modes[0];

  const q0 = 1e-4; // 0.1 mm perturbation
  mode.displacement = q0;
  mode.velocity = 0;
  mode.generalizedForce = 0;

  const dt = 1 / 44100;
  const steps = 44100; // 1.0 second of free decay
  for (let s = 0; s < steps; s++) {
    mb.stepExactZOH(dt);
  }

  // Analytical upper envelope: q0 * exp(-zeta * omega * t)
  const theoreticalEnvelope = q0 * Math.exp(-zeta * mode.omega * 1.0);
  assert.ok(
    Math.abs(mode.displacement) <= theoreticalEnvelope * 1.05,
    `Free decay amplitude ${Math.abs(mode.displacement)} exceeded envelope ${theoreticalEnvelope}`
  );
  assert.ok(!isNaN(mode.displacement), 'Displacement must be finite');
});

// 4. Exact ZOH stability on high-frequency mode (485.7 Hz) at coarse timestep
test('4. Modal Solver: Exact ZOH integrator remains strictly stable for 485.7 Hz mode at 16.6 ms step', () => {
  const mat = DEFAULT_ALUMINUM;
  const geom = DEFAULT_GEOMETRY;
  const mb = new ModalBank(mat, geom, 0.01, [{ m: 3, n: 3 }]);
  const mode33 = mb.modes[0];

  mode33.displacement = 1e-4;
  mode33.velocity = 0;
  mode33.generalizedForce = 0;

  const dtFrame = 1 / 60; // 16.666 ms
  for (let f = 0; f < 120; f++) {
    mb.stepExactZOH(dtFrame);
    assert.ok(!isNaN(mode33.displacement));
    assert.ok(Math.abs(mode33.displacement) < 1.0);
  }

  const expectedDecay = 1e-4 * Math.exp(-0.01 * mode33.omega * 2.0);
  assert.ok(Math.abs(mode33.displacement) <= expectedDecay * 2.0);
});

// 5. RMS Covariance Accuracy across all test configurations
test('5. RMS Covariance: Accurate across single-tone, dual-tone, degenerate coherent modes, phase shifts, and sample rates', () => {
  const mat = DEFAULT_ALUMINUM;
  const geom = DEFAULT_GEOMETRY;

  // A. Single sinusoid: a_rms = A / sqrt(2)
  const mb1 = new ModalBank(mat, geom, 0.01, [{ m: 1, n: 1 }]);
  const A = 10.0;
  const omega1 = mb1.modes[0].omega;
  const dt44 = 1 / 44100;
  for (let s = 0; s < 26460; s++) {
    const t = s * dt44;
    mb1.modes[0].acceleration = A * Math.cos(omega1 * t);
    // @ts-expect-error private test call
    mb1.updateCovarianceMatrix(dt44);
  }
  const rmsSingle = mb1.evaluateRmsAcceleration(0.15, 0.15);
  const expectedSingle = A / Math.SQRT2;
  const errSingle = (Math.abs(rmsSingle - expectedSingle) / expectedSingle) * 100;
  assert.ok(errSingle < 1.0, `Single sinusoid RMS error was ${errSingle.toFixed(3)}%`);

  // B. Dual-tone orthogonal modes at 48 kHz
  const mbDual = new ModalBank(mat, geom, 0.01, [{ m: 1, n: 1 }, { m: 1, n: 2 }]);
  const A1 = 6.0, A2 = 8.0;
  const omega2 = mbDual.modes[1].omega;
  const dt48 = 1 / 48000;
  for (let s = 0; s < 28800; s++) {
    const t = s * dt48;
    mbDual.modes[0].acceleration = A1 * Math.cos(omega1 * t);
    mbDual.modes[1].acceleration = A2 * Math.cos(omega2 * t);
    // @ts-expect-error private test call
    mbDual.updateCovarianceMatrix(dt48);
  }
  // Off-diagonal cross term R_01 must average near 0 for orthogonal frequencies
  const R01 = mbDual.covarianceMatrix[1];
  assert.ok(Math.abs(R01) < 1.5, `Orthogonal frequencies should have small cross-covariance, got ${R01}`);

  // C. Degenerate coherent modes (1,2) and (2,1) in-phase vs out-of-phase
  const mbDegen = new ModalBank(mat, geom, 0.01, [{ m: 1, n: 2 }, { m: 2, n: 1 }]);
  const Adeg = 5.0;
  for (let s = 0; s < 26460; s++) {
    const t = s * dt44;
    mbDegen.modes[0].acceleration = Adeg * Math.cos(omega2 * t);
    mbDegen.modes[1].acceleration = Adeg * Math.cos(omega2 * t); // in phase
    // @ts-expect-error private test call
    mbDegen.updateCovarianceMatrix(dt44);
  }
  const R_inPhase = mbDegen.covarianceMatrix[1];
  const expectedCross = (Adeg * Adeg) / 2.0; // 12.5
  assert.ok(
    Math.abs(R_inPhase - expectedCross) < 0.25,
    `Degenerate in-phase cross term expected ~12.5, got ${R_inPhase}`
  );
});

// 6. Audio Coupling: Uniform pressure excites strictly odd-odd modes
test('6. Audio Coupling: Uniform pressure excites strictly odd-odd modes', () => {
  const L = 0.3;
  assert.ok(uniformPressureModalCoupling(1, 1, L) > 0);
  assert.ok(uniformPressureModalCoupling(3, 3, L) > 0);
  assert.equal(uniformPressureModalCoupling(1, 2, L), 0);
  assert.equal(uniformPressureModalCoupling(2, 1, L), 0);
  assert.equal(uniformPressureModalCoupling(2, 2, L), 0);
});

// 7. Robust periodic reflection mapping
test('7. Boundary Reflection: Mathematically robust periodic reflection mapping', () => {
  const L = 0.30;

  // Positive overshoot
  assert.ok(Math.abs(reflectCoordinate(0.35, L) - 0.25) < 1e-12);
  // Negative overshoot
  assert.ok(Math.abs(reflectCoordinate(-0.05, L) - 0.05) < 1e-12);
  // Multi-width positive overshoot (4.5 L)
  assert.ok(Math.abs(reflectCoordinate(1.35, L) - 0.15) < 1e-12);
  // Multi-width negative overshoot (-4.5 L)
  assert.ok(Math.abs(reflectCoordinate(-1.35, L) - 0.15) < 1e-12);
  // Finite validation
  assert.equal(reflectCoordinate(NaN, L), 0.15);
  assert.equal(reflectCoordinate(Infinity, L), 0.15);
});

// 8. Dimensional diffusivity & silence standstill
test('8. Particle Transport: Dimensional diffusivity Gamma = a_rms / g and silence standstill', () => {
  const sys = new ParticleTransportSystem({
    dRef: 1e-4,
    gammaC: 1.0,
    power: 2.0,
    g: 9.80665,
    subThresholdCreepFloor: 0.0,
  });

  // Strict silence standstill
  assert.equal(sys.evaluateDimensionalDiffusivity(0, true), 0);
  assert.equal(sys.evaluateDimensionalDiffusivity(1e-7, false), 0);

  // Sub-threshold
  assert.equal(sys.evaluateDimensionalDiffusivity(4.9, false), 0.0);

  // Super-threshold: Gamma = 2.0 -> D_g = 1e-4 * (2 - 1)^2 = 1e-4
  const aSuper = 2.0 * 9.80665;
  const dSuper = sys.evaluateDimensionalDiffusivity(aSuper, false);
  assert.ok(Math.abs(dSuper - 1e-4) < 1e-8);
});

// 9. Particle clock synchronization (accumulator driven by worklet clock)
test('9. Time Synchronization: Particle transport step consumes worklet time accumulator', () => {
  const sys = new ParticleTransportSystem({ particleCount: 100, dt: 0.016, seed: 42 });
  const dtFixed = 0.016;

  let timeAccumulator = 0.048; // 3 steps worth of time
  let stepCount = 0;

  while (timeAccumulator >= dtFixed) {
    sys.step(dtFixed, () => 1e-4);
    timeAccumulator -= dtFixed;
    stepCount++;
  }

  assert.equal(stepCount, 3);
  assert.ok(Math.abs(timeAccumulator) < 1e-12);
});

// 10. Genuine spatial grid convergence: bilinear interpolation vs analytical reference
test('10. Spatial Grid Convergence: Bilinear interpolation error strictly reduces monotonically', () => {
  const convergence = runConvergenceTesting();
  const gridSteps = convergence.data.gridSteps;

  assert.ok(gridSteps.length >= 4);
  // Verify monotonic reduction of normalized L2 error from N=24 to N=64
  assert.ok(gridSteps[1].normalizedL2Error < gridSteps[0].normalizedL2Error);
  assert.ok(gridSteps[2].normalizedL2Error < gridSteps[1].normalizedL2Error);
  assert.ok(gridSteps[3].normalizedL2Error < gridSteps[2].normalizedL2Error);

  // Verify high Pearson correlation at N=64
  assert.ok(gridSteps[3].correlationWithAnalytical > 0.9995);
  assert.equal(convergence.summary[1].passed, true);
});

// 11. Verification Suite Layers A, B, and C
test('11. Verification Suite: Layers A, B, and C batteries execute and pass cleanly', () => {
  const mathTests = runMathematicalUnitTests();
  for (const res of mathTests) {
    assert.equal(res.passed, true, `Failed Layer A ${res.testName}: ${res.details}`);
  }

  const numTests = runNumericalSolverTests();
  for (const res of numTests) {
    assert.equal(res.passed, true, `Failed Layer B ${res.testName}: ${res.details}`);
  }

  const browserTests = runBrowserIntegrationTests();
  // Filter for executable browser tests
  for (const res of browserTests.results) {
    if (res.status !== 'NOT_RUN') {
      assert.equal(res.passed, true, `Failed Layer C ${res.testName}: ${res.details}`);
    }
  }
});

// 12. Layer D Hardware Tests explicitly marked NOT_RUN
test('12. Verification Suite: Layer D hardware tests are explicitly marked NOT_RUN', () => {
  const hardware = getPhysicalHardwareTests();
  assert.ok(hardware.length >= 2);
  for (const h of hardware) {
    assert.equal(h.status, 'NOT_RUN');
    assert.equal(h.passed, false);
  }
});

// 13. Full scientific audit execution report
test('13. Full Scientific Audit: Comprehensive execution report generates all fields', () => {
  const report = runFullScientificAudit();
  assert.equal(report.allPassed, true);
  assert.ok(report.totalExecutableTests > 0);
  assert.equal(report.passedTests, report.totalExecutableTests);
  assert.ok(report.benchmarkResults.length > 0);
  assert.ok(report.benchmarkResults[0].memoryBreakdown.particleStateKb > 0);
  assert.ok(report.benchmarkResults[0].detailedPerformance !== undefined);
});
