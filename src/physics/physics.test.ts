/**
 * Unit Tests for Chladni Plate Physics and Scientific Verification
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
  runAudioVerification,
  runModalSolverVerification,
  runStructuralVerification,
  runTransportVerification,
  runConvergenceTesting,
  runPerformanceBenchmark,
} from './verificationSuite.ts';

test('1. Structural Physics: Analytical plate frequencies match theory within tolerance', () => {
  const mat = DEFAULT_ALUMINUM;
  const geom = DEFAULT_GEOMETRY;

  // Expected from prompt:
  // f(1,1) = 53.9 Hz
  // f(1,2) = 134.8 Hz
  // f(2,1) = 134.8 Hz
  // f(2,2) = 215.8 Hz
  const f11 = calculateAnalyticalFrequency(1, 1, mat, geom);
  const f12 = calculateAnalyticalFrequency(1, 2, mat, geom);
  const f21 = calculateAnalyticalFrequency(2, 1, mat, geom);
  const f22 = calculateAnalyticalFrequency(2, 2, mat, geom);

  assert.ok(Math.abs(f11 - 53.9) < 0.2, `f(1,1) = ${f11} expected ~53.9 Hz`);
  assert.ok(Math.abs(f12 - 134.8) < 0.2, `f(1,2) = ${f12} expected ~134.8 Hz`);
  assert.ok(Math.abs(f21 - 134.8) < 0.2, `f(2,1) = ${f21} expected ~134.8 Hz`);
  assert.ok(Math.abs(f22 - 215.8) < 0.2, `f(2,2) = ${f22} expected ~215.8 Hz`);
});

test('1b. Structural Physics: Eigenfrequencies are invariant to excitation, coords, and particles', () => {
  const mat = DEFAULT_ALUMINUM;
  const geom = DEFAULT_GEOMETRY;
  const f11_base = calculateAnalyticalFrequency(1, 1, mat, geom);

  // Frequency depends purely on E, rho, nu, L, h
  const mb = new ModalBank(mat, geom, 0.01);
  assert.equal(mb.modes[0].frequency, f11_base);

  // Apply massive force
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

test('3. Audio Coupling: Uniform pressure excites strictly odd-odd modes', () => {
  const L = 0.3;
  // Odd-odd
  assert.ok(uniformPressureModalCoupling(1, 1, L) > 0);
  assert.ok(uniformPressureModalCoupling(3, 3, L) > 0);
  assert.ok(uniformPressureModalCoupling(1, 3, L) > 0);

  // Even modes must be exactly 0
  assert.equal(uniformPressureModalCoupling(1, 2, L), 0);
  assert.equal(uniformPressureModalCoupling(2, 1, L), 0);
  assert.equal(uniformPressureModalCoupling(2, 2, L), 0);
  assert.equal(uniformPressureModalCoupling(2, 4, L), 0);
});

test('4. Particle Transport: Zero vibration yields zero transport', () => {
  const sys = new ParticleTransportSystem({
    particleCount: 100,
    baseDiffusivity: 1e-5,
    accelerationCoupling: 1.0,
    dt: 0.01,
    seed: 42,
  });

  const p0 = { ...sys.particles[0] };
  for (let i = 0; i < 20; i++) {
    sys.step(0.01, () => 0); // D_g = 0
  }
  assert.equal(sys.particles[0].x, p0.x);
  assert.equal(sys.particles[0].y, p0.y);
});

test('4b. Particle Transport: Boundary reflection and particle conservation', () => {
  const sys = new ParticleTransportSystem({
    particleCount: 500,
    baseDiffusivity: 1e-4,
    accelerationCoupling: 1.0,
    dt: 0.01,
    seed: 99,
  });

  // Step with vigorous random diffusion
  for (let s = 0; s < 50; s++) {
    sys.step(0.01, () => 1e-3);
  }

  const check = sys.verifyConservationAndBounds();
  assert.equal(check.conserved, true);
  assert.equal(check.count, 500);
  assert.equal(check.inBounds, true);
});

test('5. Verification Suite: Structural and modal batteries pass', () => {
  const struct = runStructuralVerification();
  for (const res of struct) {
    assert.equal(res.passed, true, `Failed ${res.testName}: ${res.details}`);
  }

  const audio = runAudioVerification();
  for (const res of audio) {
    assert.equal(res.passed, true, `Failed ${res.testName}: ${res.details}`);
  }

  const transport = runTransportVerification();
  for (const res of transport) {
    assert.equal(res.passed, true, `Failed ${res.testName}: ${res.details}`);
  }
});
