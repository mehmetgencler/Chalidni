/**
 * Unit Tests for Chladni Plate Physics and Scientific Verification
 * Validates Priorities 1-7:
 * - Kirchhoff plate natural frequencies and invariant eigenvalues.
 * - Exact discrete ZOH state transition stability at 16.6 ms (60 Hz frame rate) for 485.7 Hz mode.
 * - Single sinusoid modal acceleration covariance yielding a_rms = A / sqrt(2).
 * - Uniform pressure spatial orthogonality (strictly odd-odd modes).
 * - Dimensional diffusivity D_g = D_ref * max(Gamma - Gamma_c, 0)^p with silence gating.
 * - Zero vibration standstill, reflecting boundary conservation, and VMR spatial uniformity.
 * - Layered verification: Layers A, B, C pass cleanly; Layer D is marked NOT_RUN.
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
import { Mulberry32PRNG, ParticleTransportSystem } from './particleTransport.ts';
import {
  runMathematicalUnitTests,
  runNumericalSolverTests,
  runBrowserIntegrationTests,
  runConvergenceTesting,
  getPhysicalHardwareTests,
  runFullScientificAudit,
} from './verificationSuite.ts';

test('1. Structural Physics: Analytical plate frequencies match Kirchhoff theory within tolerance', () => {
  const mat = DEFAULT_ALUMINUM;
  const geom = DEFAULT_GEOMETRY;

  // Expected:
  // f(1,1) = 53.9 Hz
  // f(1,2) = 134.8 Hz
  // f(2,1) = 134.8 Hz
  // f(2,2) = 215.8 Hz
  const f11 = calculateAnalyticalFrequency(1, 1, mat, geom);
  const f12 = calculateAnalyticalFrequency(1, 2, mat, geom);
  const f21 = calculateAnalyticalFrequency(2, 1, mat, geom);
  const f22 = calculateAnalyticalFrequency(2, 2, mat, geom);

  assert.ok(Math.abs(f11 - 53.9) < 0.2, `f(1,1) = ${f11} expected ~53.9 Hz`);
  assert.ok(Math.abs(f12 - 134.8) < 0.3, `f(1,2) = ${f12} expected ~134.8 Hz`);
  assert.ok(Math.abs(f21 - 134.8) < 0.3, `f(2,1) = ${f21} expected ~134.8 Hz`);
  assert.ok(Math.abs(f22 - 215.8) < 0.3, `f(2,2) = ${f22} expected ~215.8 Hz`);
});

test('1b. Structural Physics: Eigenfrequencies are invariant to excitation, coords, and particles', () => {
  const mat = DEFAULT_ALUMINUM;
  const geom = DEFAULT_GEOMETRY;
  const f11_base = calculateAnalyticalFrequency(1, 1, mat, geom);

  const mb = new ModalBank(mat, geom, 0.01);
  assert.equal(mb.modes[0].frequency, f11_base);

  // Apply large excitation force
  mb.computeGeneralizedForces(true, 1000.0, 0.1, 0.1);
  assert.equal(mb.modes[0].frequency, f11_base);
});

test('2. Modal Solver: Analytical steady-state resonance formula matches expectation', () => {
  const Q0 = 1.0;
  const M = 0.5;
  const omega = 100;
  const zeta = 0.02;

  // At resonance: |q| = Q0 / (2 * M * zeta * omega^2)
  const analytical = calculateAnalyticalHarmonicResponse(Q0, M, omega, omega, zeta);
  const expectedAmp = Q0 / (2 * M * zeta * omega * omega);
  assert.ok(Math.abs(analytical.amplitude - expectedAmp) < 1e-12);
  assert.ok(Math.abs(analytical.phaseLag - Math.PI / 2) < 1e-12);
});

test('2b. Modal Solver: Exact discrete ZOH state transition is stable for 485.7 Hz mode at 16.6 ms (60 Hz)', () => {
  // PRIORITY 1: Mode (3,3) has f = 485.7 Hz, omega = 3051.7 rad/s.
  // At dt = 16.666 ms, omega * dt = 50.8 >> 2.83 (RK4 explodes).
  // The exact ZOH state transition has discrete poles exp(-zeta * omega * dt) < 1.0.
  const mat = DEFAULT_ALUMINUM;
  const geom = DEFAULT_GEOMETRY;
  const zeta = 0.01;
  const mb = new ModalBank(mat, geom, zeta, [{ m: 3, n: 3 }]);
  const mode33 = mb.modes[0];

  mode33.displacement = 1e-4; // 0.1 mm initial displacement
  mode33.velocity = 0;
  mode33.generalizedForce = 0;

  const dtFrame = 1 / 60; // 16.666 ms
  // Integrate 120 frames (2 seconds)
  for (let f = 0; f < 120; f++) {
    mb.stepExactZOH(dtFrame);
    assert.ok(!isNaN(mode33.displacement), 'Displacement must not be NaN');
    assert.ok(Math.abs(mode33.displacement) < 1.0, 'Displacement must not blow up');
  }

  // The amplitude must decay exponentially: exp(-zeta * omega * 2.0)
  const expectedDecay = 1e-4 * Math.exp(-zeta * mode33.omega * 2.0);
  assert.ok(
    Math.abs(mode33.displacement) <= expectedDecay * 2.0,
    `Exact ZOH oscillator must strictly decay without numerical explosion (measured ${mode33.displacement})`
  );
});

test('2c. Modal Solver: Sinusoid time-window RMS acceleration field satisfies a_rms = A / sqrt(2)', () => {
  // PRIORITY 3: Continuous modal acceleration covariance matrix R_ij satisfies a_rms = A / sqrt(2)
  const mat = DEFAULT_ALUMINUM;
  const geom = DEFAULT_GEOMETRY;
  const mb = new ModalBank(mat, geom, 0.01, [{ m: 1, n: 1 }]);
  const A = 10.0; // peak modal acceleration
  const omega = mb.modes[0].omega;
  const dt = 1 / 44100;

  // Simulate harmonic motion for 600 ms (~7.5 time constants of 80 ms window)
  for (let s = 0; s < 26460; s++) {
    const t = s * dt;
    mb.modes[0].acceleration = A * Math.cos(omega * t);
    // @ts-expect-error private method test verification
    mb.updateCovarianceMatrix(dt);
  }

  // At center antinode (phi = 1.0)
  const measuredRms = mb.evaluateRmsAcceleration(0.15, 0.15);
  const theoreticalRms = A / Math.SQRT2;
  const relError = Math.abs(measuredRms - theoreticalRms) / theoreticalRms * 100;
  assert.ok(relError < 1.0, `RMS error must be < 1.0%, measured error was ${relError.toFixed(3)}%`);
});

test('3. Audio Coupling: Uniform pressure excites strictly odd-odd modes', () => {
  const L = 0.3;
  // Odd-odd
  assert.ok(uniformPressureModalCoupling(1, 1, L) > 0);
  assert.ok(uniformPressureModalCoupling(3, 3, L) > 0);
  assert.ok(uniformPressureModalCoupling(1, 3, L) > 0);

  // Even / antisymmetric modes must be exactly 0
  assert.equal(uniformPressureModalCoupling(1, 2, L), 0);
  assert.equal(uniformPressureModalCoupling(2, 1, L), 0);
  assert.equal(uniformPressureModalCoupling(2, 2, L), 0);
  assert.equal(uniformPressureModalCoupling(2, 4, L), 0);
});

test('4. Particle Transport: Zero vibration yields zero transport (silence standstill)', () => {
  const sys = new ParticleTransportSystem({
    particleCount: 100,
    seed: 42,
  });

  const p0 = { ...sys.particles[0] };
  for (let i = 0; i < 30; i++) {
    sys.step(0.016, () => 0); // D_g = 0
  }
  assert.equal(sys.particles[0].x, p0.x);
  assert.equal(sys.particles[0].y, p0.y);
});

test('4b. Particle Transport: Boundary reflection and particle conservation', () => {
  const sys = new ParticleTransportSystem({
    particleCount: 500,
    seed: 99,
  });

  // Step with active random diffusion
  for (let s = 0; s < 50; s++) {
    sys.step(0.016, () => 1e-3);
  }

  const check = sys.verifyConservationAndBounds();
  assert.equal(check.conserved, true);
  assert.equal(check.count, 500);
  assert.equal(check.inBounds, true);
});

test('4c. Particle Transport: Dimensional diffusivity Gamma = a_rms / g and silence gating', () => {
  const sys = new ParticleTransportSystem({
    dRef: 1e-4,
    gammaC: 1.0,
    power: 2.0,
    g: 9.80665,
  });

  // 1. Silent plate (isSilent = true or aRms <= 1e-6)
  assert.equal(sys.evaluateDimensionalDiffusivity(0, true), 0);
  assert.equal(sys.evaluateDimensionalDiffusivity(1e-7, false), 0);

  // 2. Sub-threshold vibration (aRms = 4.9 m/s^2, Gamma = 0.5 < Gamma_c = 1.0)
  const dSub = sys.evaluateDimensionalDiffusivity(4.9, false);
  assert.ok(dSub > 0 && dSub < 1e-6, `Sub-threshold creep must be microscopic: ${dSub}`);

  // 3. Super-threshold vibration (aRms = 19.6133 m/s^2, Gamma = 2.0, excess = 1.0)
  // D_g = 1e-4 * (2.0 - 1.0)^2 = 1.0e-4 m^2/s
  const dSuper = sys.evaluateDimensionalDiffusivity(19.6133, false);
  const expectedSuper = 1e-4 * Math.pow(19.6133 / 9.80665 - 1.0, 2.0);
  assert.ok(Math.abs(dSuper - expectedSuper) < 1e-7, `Super-threshold diffusivity: ${dSuper} vs ${expectedSuper}`);
});

test('4d. Particle Transport: Genuine spatial uniformity (Variance-to-Mean Ratio)', () => {
  const sys = new ParticleTransportSystem({
    particleCount: 2000,
    seed: 123,
  });

  for (let s = 0; s < 50; s++) {
    sys.step(0.016, () => 1e-4);
  }

  const unif = sys.computeSpatialUniformityScore(8);
  assert.ok(unif.isUniform, `Uniformity score must pass: VMR = ${unif.vmr}`);
  assert.ok(unif.vmr >= 0.5 && unif.vmr <= 1.8, `VMR should be close to 1.0 (Poisson scatter), got ${unif.vmr}`);
});

test('5. Verification Suite: Layers A, B, and C batteries execute and pass cleanly', () => {
  const mathTests = runMathematicalUnitTests();
  for (const res of mathTests) {
    assert.equal(res.passed, true, `Failed Layer A ${res.testName}: ${res.details}`);
  }

  const numTests = runNumericalSolverTests();
  for (const res of numTests) {
    assert.equal(res.passed, true, `Failed Layer B ${res.testName}: ${res.details}`);
  }

  const browserTests = runBrowserIntegrationTests();
  for (const res of browserTests.results) {
    assert.equal(res.passed, true, `Failed Layer C ${res.testName}: ${res.details}`);
  }

  const convergence = runConvergenceTesting();
  for (const res of convergence.summary) {
    assert.equal(res.passed, true, `Failed Convergence ${res.testName}: ${res.details}`);
  }
});

test('6. Verification Suite: Layer D hardware tests are explicitly marked NOT_RUN', () => {
  const hardware = getPhysicalHardwareTests();
  assert.ok(hardware.length >= 2);
  for (const h of hardware) {
    assert.equal(h.status, 'NOT_RUN', `Hardware test ${h.testName} must be marked NOT_RUN`);
    assert.equal(h.passed, false);
  }
});

test('7. Full Scientific Audit: Comprehensive execution report generates all fields', () => {
  const report = runFullScientificAudit();
  assert.equal(report.allPassed, true);
  assert.ok(report.totalExecutableTests > 0);
  assert.equal(report.passedTests, report.totalExecutableTests);
  assert.ok(report.benchmarkResults.length > 0);
  assert.ok(report.benchmarkResults[0].memoryBreakdown.particleStateKb > 0);
});
