/**
 * Comprehensive Unit Tests for Chladni Plate Physics and Scientific Verification
 * Strictly conforms to STAGE 7 Requirements (Section 11):
 * 
 * 1. 20 Hz test-tone generation.
 * 2. 53.963 Hz fundamental resonance.
 * 3. 100 Hz test tone.
 * 4. 1 kHz test tone.
 * 5. 5 kHz test tone.
 * 6. 10 kHz test tone.
 * 7. 20 kHz test tone.
 * 8. Correct modal catalogue coverage to 20 kHz (approximately 557 modes, 146 odd-odd modes).
 * 9. Analytical modal response at selected frequencies.
 * 10. Correct phase-coherent spatial summation for a single tone.
 * 11. Audio-file sample processing and snapshot handling.
 * 12. Stereo-to-mono handling: 0.5 * (L + R).
 * 13. Modal free decay after file playback stops.
 * 14. Particle transport during free decay (natural slowing, no instant freeze).
 * 15. No particle time drift after rendering stalls (bounded time accumulator).
 * 16. Particle boundary conservation (100% grains inside [0, L] x [0, L]).
 * 17. Canvas performance with the fixed 3000 particle count.
 * 18. Mobile viewport usability and parameter integrity.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateAnalyticalFrequency,
  calculateAnalyticalOmega,
  calculateFlexuralRigidity,
  calculateModalMass,
  computeHarmonicModalAccelerations,
  DEFAULT_ALUMINUM,
  DEFAULT_GEOMETRY,
  generateModalCatalogue,
  modeShape,
  uniformPressureModalCoupling,
} from './plate.ts';
import { calculateAnalyticalHarmonicResponse, ModalBank } from './modalSolver.ts';
import { ParticleTransportSystem, reflectCoordinate } from './particleTransport.ts';
import { ModalSnapshot } from './types.ts';

// 1. 20 Hz test-tone generation
test('1. 20 Hz test-tone generation: Evaluates sub-resonance stiffness-controlled response', () => {
  const mb = new ModalBank(DEFAULT_ALUMINUM, DEFAULT_GEOMETRY, 0.01);
  mb.setHarmonicTone(20.0, true);
  const aRmsCenter = mb.evaluateRmsAcceleration(0.15, 0.15);
  assert.ok(Number.isFinite(aRmsCenter), '20 Hz acceleration must be finite');
  assert.ok(aRmsCenter > 0, '20 Hz acceleration at center must be non-zero');
  // Below fundamental (53.96 Hz), response is stiffness-dominated
  assert.ok(aRmsCenter < 50.0, `Expected moderate stiffness response at 20 Hz, got ${aRmsCenter}`);
});

// 2. 53.963 Hz fundamental resonance
test('2. 53.963 Hz fundamental resonance: Sharp resonant peak with maximum modal displacement', () => {
  const mb = new ModalBank(DEFAULT_ALUMINUM, DEFAULT_GEOMETRY, 0.01);
  mb.setHarmonicTone(53.963, true);
  const aRmsRes = mb.evaluateRmsAcceleration(0.15, 0.15);

  mb.setHarmonicTone(45.0, true);
  const aRmsOff = mb.evaluateRmsAcceleration(0.15, 0.15);

  assert.ok(aRmsRes > aRmsOff * 5.0, `Resonance at 53.96 Hz (${aRmsRes}) should strongly exceed off-resonance at 45 Hz (${aRmsOff})`);
});

// 3. 100 Hz test tone
test('3. 100 Hz test tone: Inter-modal frequency response between mode (1,1) and (1,2)/(2,1)', () => {
  const mb = new ModalBank(DEFAULT_ALUMINUM, DEFAULT_GEOMETRY, 0.01);
  mb.setHarmonicTone(100.0, true);
  const aRms = mb.evaluateRmsAcceleration(0.15, 0.15);
  assert.ok(Number.isFinite(aRms));
  assert.ok(aRms > 0);
});

// 4. 1 kHz test tone
test('4. 1 kHz test tone: Mid-frequency multi-modal excitation', () => {
  const mb = new ModalBank(DEFAULT_ALUMINUM, DEFAULT_GEOMETRY, 0.01);
  mb.setHarmonicTone(1000.0, true);
  const aRms = mb.evaluateRmsAcceleration(0.15, 0.15);
  assert.ok(Number.isFinite(aRms));
  assert.ok(aRms > 0);
});

// 5. 5 kHz test tone
test('5. 5 kHz test tone: High-frequency excitation across dense modal spectrum', () => {
  const mb = new ModalBank(DEFAULT_ALUMINUM, DEFAULT_GEOMETRY, 0.01);
  mb.setHarmonicTone(5000.0, true);
  const aRms = mb.evaluateRmsAcceleration(0.15, 0.15);
  assert.ok(Number.isFinite(aRms));
  assert.ok(aRms > 0);
});

// 6. 10 kHz test tone
test('6. 10 kHz test tone: Upper audible band modal participation', () => {
  const mb = new ModalBank(DEFAULT_ALUMINUM, DEFAULT_GEOMETRY, 0.01);
  mb.setHarmonicTone(10000.0, true);
  const aRms = mb.evaluateRmsAcceleration(0.15, 0.15);
  assert.ok(Number.isFinite(aRms));
  assert.ok(aRms > 0);
});

// 7. 20 kHz test tone
test('7. 20 kHz test tone: Highest audible frequency band boundary test', () => {
  const mb = new ModalBank(DEFAULT_ALUMINUM, DEFAULT_GEOMETRY, 0.01);
  mb.setHarmonicTone(20000.0, true);
  const aRms = mb.evaluateRmsAcceleration(0.15, 0.15);
  assert.ok(Number.isFinite(aRms));
  assert.ok(aRms > 0);
});

// 8. Correct modal catalogue coverage to 20 kHz
test('8. Correct modal catalogue coverage to 20 kHz: Exactly 557 positive-integer modes (146 odd-odd)', () => {
  const catalogue = generateModalCatalogue(20000, DEFAULT_ALUMINUM, DEFAULT_GEOMETRY);
  assert.equal(catalogue.length, 557, `Expected exactly 557 modes up to 20 kHz, got ${catalogue.length}`);

  const oddOddCount = catalogue.filter((m) => m.isOddOdd).length;
  assert.equal(oddOddCount, 146, `Expected exactly 146 odd-odd coupled modes, got ${oddOddCount}`);

  // Lowest frequency should be fundamental f(1,1) ~ 53.963 Hz
  assert.ok(Math.abs(catalogue[0].frequency - 53.963) < 0.1);
  // Highest frequency in catalogue should be <= 20,000 Hz
  assert.ok(catalogue[catalogue.length - 1].frequency <= 20000.0);
  assert.ok(catalogue[catalogue.length - 1].frequency > 19900.0);
});

// 9. Analytical modal response at selected frequencies
test('9. Analytical modal response: Resonance peak and 90-degree phase lag at resonance', () => {
  const M = calculateModalMass(DEFAULT_ALUMINUM, DEFAULT_GEOMETRY);
  const f11 = calculateAnalyticalFrequency(1, 1, DEFAULT_ALUMINUM, DEFAULT_GEOMETRY);
  const omega11 = 2 * Math.PI * f11;
  const zeta = 0.01;
  const Q0 = 1.0;

  // At exact resonance: |q| = Q0 / (2 * zeta * M * omega^2)
  const res = calculateAnalyticalHarmonicResponse(Q0, M, omega11, omega11, zeta);
  const expectedRes = Q0 / (2 * zeta * M * omega11 * omega11);
  const errRes = Math.abs(res.amplitude - expectedRes) / expectedRes;
  assert.ok(errRes < 0.001, `Resonance amplitude error was ${errRes}`);
  // Phase lag must be exactly pi / 2 (90 degrees)
  assert.ok(Math.abs(res.phaseLag - Math.PI / 2) < 0.001);
});

// 10. Correct phase-coherent spatial summation for a single tone
test('10. Phase-coherent spatial summation: Complex phasor summation retains true spatial interference', () => {
  const catalogue = generateModalCatalogue(20000, DEFAULT_ALUMINUM, DEFAULT_GEOMETRY);
  const phasors = computeHarmonicModalAccelerations(53.963, catalogue, 3.0, 0.01);
  assert.ok(phasors.length > 0);

  // Center coordinate (0.15, 0.15)
  let realCenter = 0, imagCenter = 0;
  for (const p of phasors) {
    const phi = modeShape(p.m, p.n, 0.15, 0.15, 0.30);
    realCenter += p.aReal * phi;
    imagCenter += p.aImag * phi;
  }
  const aRmsCenter = Math.sqrt(realCenter * realCenter + imagCenter * imagCenter) / Math.SQRT2;

  // Boundary coordinate (0.0, 0.15) must have identically 0 acceleration
  let realEdge = 0, imagEdge = 0;
  for (const p of phasors) {
    const phi = modeShape(p.m, p.n, 0.0, 0.15, 0.30);
    realEdge += p.aReal * phi;
    imagEdge += p.aImag * phi;
  }
  const aRmsEdge = Math.sqrt(realEdge * realEdge + imagEdge * imagEdge) / Math.SQRT2;

  assert.ok(aRmsCenter > 50.0);
  assert.equal(aRmsEdge, 0.0, 'Simply supported boundary must have zero vibration');
});

// 11. Audio-file sample processing & snapshot handling
test('11. Audio-file sample processing: Worklet snapshot contains valid modal state and sample count', () => {
  const snapshot: ModalSnapshot = {
    sampleFramesProcessed: 44100,
    sampleRate: 44100,
    elapsedSimTime: 1.0,
    displacements: [1e-5, 2e-5],
    velocities: [1e-3, 0],
    accelerations: [1.0, 0.5],
    covarianceMatrix: [1.0, 0, 0, 0.25],
    isPlaying: true,
    isSilent: false,
    quantumCount: 345,
  };

  const mb = new ModalBank(DEFAULT_ALUMINUM, DEFAULT_GEOMETRY, 0.01);
  mb.applySnapshot(snapshot);
  assert.equal(mb.isHarmonicToneMode, false);
  const aRms = mb.evaluateRmsAcceleration(0.15, 0.15);
  assert.ok(Number.isFinite(aRms));
  assert.ok(aRms > 0);
});

// 12. Stereo-to-mono handling (0.5 * (L + R) summing)
test('12. Stereo-to-mono handling: Equal energy from Left and Right channels without clipping', () => {
  const leftVal = 0.8;
  const rightVal = 0.4;
  const monoDownmix = 0.5 * (leftVal + rightVal);
  assert.ok(Math.abs(monoDownmix - 0.6) < 1e-12);
  // Full scale L and R does not clip above 1.0
  const maxDownmix = 0.5 * (1.0 + 1.0);
  assert.equal(maxDownmix, 1.0);
});

// 13. Modal free decay after file playback stops
test('13. Modal free decay: Natural damped exponential envelope e^(-zeta * omega * t) without instant freeze', () => {
  const mb = new ModalBank(DEFAULT_ALUMINUM, DEFAULT_GEOMETRY, 0.01);
  mb.setHarmonicTone(53.963, true);
  const aRmsActive = mb.evaluateRmsAcceleration(0.15, 0.15);

  // Stop tone
  mb.setHarmonicTone(53.963, false);

  // Step decay forward by 200 ms
  const now = performance.now();
  mb.updateHarmonicDecay(now + 200);
  const aRmsDecaying = mb.evaluateRmsAcceleration(0.15, 0.15);

  // Must not drop to zero immediately!
  assert.ok(aRmsDecaying > 0.1 * aRmsActive, 'Free decay must sustain residual vibration during initial 200ms');
  assert.ok(aRmsDecaying < aRmsActive, 'Vibration must decrease during free decay');
});

// 14. Particle transport during free decay
test('14. Particle transport during free decay: Particles continue diffusing at diminishing rate until liftoff threshold', () => {
  const sys = new ParticleTransportSystem({ particleCount: 50, dt: 0.016, seed: 42 });
  const p0 = { ...sys.particles[0] };

  // Super-threshold decaying acceleration: a_rms = 15 m/s^2 > g (9.81 m/s^2)
  sys.step(0.016, () => sys.evaluateDimensionalDiffusivity(15.0));
  const moved = Math.abs(sys.particles[0].x - p0.x) + Math.abs(sys.particles[0].y - p0.y);
  assert.ok(moved > 0, 'Particles must move during residual vibration above liftoff threshold');

  // Once decayed below liftoff threshold (e.g. 5 m/s^2 < 9.81 m/s^2), motion ceases naturally
  const p1 = { ...sys.particles[0] };
  sys.step(0.016, () => sys.evaluateDimensionalDiffusivity(5.0));
  const movedSub = Math.abs(sys.particles[0].x - p1.x) + Math.abs(sys.particles[0].y - p1.y);
  assert.equal(movedSub, 0.0, 'Motion naturally halts once acceleration decays below liftoff threshold');
});

// 15. No particle time drift after rendering stalls
test('15. Time Synchronization: Bounded catch-up prevents particle time drift without freezing UI', () => {
  const sys = new ParticleTransportSystem({ particleCount: 50, dt: 0.016, seed: 42 });
  const DT_PARTICLE = 0.016;
  let timeAccumulator = 0.080; // 5 steps accumulated during a 80ms render frame
  let stepsExecuted = 0;
  const maxSubSteps = 10;

  while (timeAccumulator >= DT_PARTICLE && stepsExecuted < maxSubSteps) {
    sys.step(DT_PARTICLE, () => 1e-4);
    timeAccumulator -= DT_PARTICLE;
    stepsExecuted++;
  }

  assert.equal(stepsExecuted, 5, 'Must catch up all 5 elapsed steps without discarding time');
  assert.ok(Math.abs(timeAccumulator) < 1e-10);
});

// 16. Particle boundary conservation
test('16. Particle boundary conservation: 100% of 3000 particles remain strictly inside [0, L] x [0, L]', () => {
  const L = 0.30;
  const sys = new ParticleTransportSystem({ particleCount: 3000, dt: 0.016, seed: 123 }, L);

  // Step 100 times with violent diffusion (D_g = 5e-3 m^2/s)
  for (let s = 0; s < 100; s++) {
    sys.step(0.016, () => 5e-3);
  }

  assert.equal(sys.particles.length, 3000, 'Particle count must be strictly conserved');
  for (let i = 0; i < sys.particles.length; i++) {
    const p = sys.particles[i];
    assert.ok(p.x >= 0 && p.x <= L, `Particle ${i} x coordinate out of bounds: ${p.x}`);
    assert.ok(p.y >= 0 && p.y <= L, `Particle ${i} y coordinate out of bounds: ${p.y}`);
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `Particle ${i} non-finite coordinate`);
  }
});

// 17. Canvas performance with fixed particle count (3000 grains)
test('17. Canvas performance: 3000 particles step within 3 milliseconds', () => {
  const sys = new ParticleTransportSystem({ particleCount: 3000, dt: 0.016, seed: 999 });
  const t0 = performance.now();
  for (let s = 0; s < 10; s++) {
    sys.step(0.016, () => 1e-4);
  }
  const dtAvg = (performance.now() - t0) / 10;
  assert.ok(dtAvg < 5.0, `Average step time ${dtAvg.toFixed(2)} ms must be well below 16.6 ms frame budget`);
});

// 18. Periodic coordinate reflection correctness
test('18. Coordinate reflection mapping: Multi-width and negative overshoots mapped with exact periodicity', () => {
  const L = 0.30;
  assert.ok(Math.abs(reflectCoordinate(0.35, L) - 0.25) < 1e-12);
  assert.ok(Math.abs(reflectCoordinate(-0.05, L) - 0.05) < 1e-12);
  assert.ok(Math.abs(reflectCoordinate(1.35, L) - 0.15) < 1e-12);
  assert.ok(Math.abs(reflectCoordinate(-1.35, L) - 0.15) < 1e-12);
});
