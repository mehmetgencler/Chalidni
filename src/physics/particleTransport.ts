/**
 * Particle Transport: Itô Stochastic Differential Equation Simulator
 * 
 * SDE:
 * dX = sqrt(2 * D_g(X, Y)) * dW_x
 * dY = sqrt(2 * D_g(X, Y)) * dW_y
 * 
 * Fokker-Planck Equation:
 * dc/dt = div^2(D_g * c)
 * 
 * Stationary density with reflecting boundaries:
 * c(x, y) proportional to 1 / D_g(x, y)
 * (Without gradient-of-diffusivity drift)
 * 
 * Dimensionally consistent grain diffusivity:
 * Gamma = a_rms / g  (g = 9.80665 m/s^2)
 * D_g = D_ref * max(Gamma - Gamma_c, 0)^p
 */

import { DimensionalTransportConfig, Particle } from './types.ts';

export const DEFAULT_DIMENSIONAL_CONFIG: DimensionalTransportConfig = {
  particleCount: 3000, // Fixed high particle density for realistic powder accumulation
  dRef: 1.0e-4,        // m^2/s reference diffusivity scale
  gammaC: 1.0,         // dimensionless liftoff threshold (Gamma = a_rms / g)
  power: 2.0,          // quadratic kinetic scaling
  g: 9.80665,          // m/s^2
  dt: 0.016,           // s
  seed: 42,
  subThresholdCreepFloor: 0.0,
};

/**
 * Seeded pseudo-random number generator (Mulberry32)
 */
export class Mulberry32PRNG {
  private state: number;

  constructor(seed: number = 12345) {
    this.state = seed >>> 0;
  }

  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * Box-Muller transform for standard normal random variables N(0, 1)
   */
  nextGaussian(): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }
}

/**
 * Mathematically robust periodic-reflection mapping for domain [0, L].
 * Correctly handles positive overshoot, negative overshoot, multiple plate widths of overshoot,
 * and finite input validation with zero iteration loops and zero clamping artifacts.
 */
export function reflectCoordinate(val: number, L: number): number {
  if (!Number.isFinite(val) || L <= 0) {
    return L > 0 ? L * 0.5 : 0;
  }

  const period = 2.0 * L;
  let rem = val % period;
  if (rem < 0) {
    rem += period;
  }

  return rem > L ? period - rem : rem;
}

export class ParticleTransportSystem {
  particles: Particle[] = [];
  config: DimensionalTransportConfig;
  sideLength: number; // L (m)
  private prng: Mulberry32PRNG;

  constructor(config: Partial<DimensionalTransportConfig> = {}, sideLength: number = 0.30) {
    this.config = { ...DEFAULT_DIMENSIONAL_CONFIG, ...config };
    this.sideLength = sideLength;
    this.prng = new Mulberry32PRNG(this.config.seed);
    this.initParticles();
  }

  setSeed(seed: number): void {
    this.config.seed = seed;
    this.prng = new Mulberry32PRNG(seed);
    this.initParticles();
  }

  setParticleCount(count: number): void {
    this.config.particleCount = count;
    this.initParticles();
  }

  initParticles(): void {
    this.particles = [];
    const L = this.sideLength;
    for (let i = 0; i < this.config.particleCount; i++) {
      // Natural subtle powder variations
      const radius = 0.9 + 0.5 * this.prng.next(); // 0.9px - 1.4px
      const brightness = 0.82 + 0.36 * this.prng.next(); // 0.82 - 1.18 brightness multiplier
      this.particles.push({
        x: this.prng.next() * L,
        y: this.prng.next() * L,
        vx: 0,
        vy: 0,
        active: true,
        radius,
        brightness,
      });
    }
  }

  /**
   * Evaluates dimensionally consistent grain diffusivity D_g [m^2/s]:
   * Gamma = a_rms / g
   * D_g = D_ref * max(Gamma - Gamma_c, 0)^p
   */
  evaluateDimensionalDiffusivity(
    aRms: number,
    isSilent: boolean = false
  ): number {
    if (isSilent || aRms <= 1e-6) {
      return 0.0;
    }

    const { dRef, gammaC, power, g, subThresholdCreepFloor = 0.0 } = this.config;
    const gamma = aRms / g;
    const excessGamma = Math.max(0, gamma - gammaC);

    if (excessGamma <= 0) {
      return subThresholdCreepFloor;
    }

    return dRef * Math.pow(excessGamma, power);
  }

  /**
   * Euler-Maruyama step for driftless Itô SDE:
   * dX = sqrt(2 * D_g) * dW_x
   * dY = sqrt(2 * D_g) * dW_y
   */
  step(
    dt: number = this.config.dt,
    diffusivityEvaluator?: (x: number, y: number) => number
  ): void {
    if (dt <= 0) return;

    const L = this.sideLength;
    const sqrtDt = Math.sqrt(dt);

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      if (!p.active) continue;

      const D_g = diffusivityEvaluator ? diffusivityEvaluator(p.x, p.y) : 0;

      if (D_g <= 1e-15) {
        p.vx = 0;
        p.vy = 0;
        continue;
      }

      // Diffusion noise amplitude: sigma = sqrt(2 * D_g)
      const sigma = Math.sqrt(2.0 * D_g);

      // Wiener increments: dW = sqrt(dt) * N(0, 1)
      const dWx = sqrtDt * this.prng.nextGaussian();
      const dWy = sqrtDt * this.prng.nextGaussian();

      const dx = sigma * dWx;
      const dy = sigma * dWy;

      p.vx = dx / dt;
      p.vy = dy / dt;

      // Periodic boundary reflection mapping
      p.x = reflectCoordinate(p.x + dx, L);
      p.y = reflectCoordinate(p.y + dy, L);
    }
  }

  /**
   * Computes spatial histogram density grid for analysis and tests
   */
  computeDensityGrid(gridSize: number = 32): {
    density: Float64Array;
    gridSize: number;
    cellWidth: number;
  } {
    const density = new Float64Array(gridSize * gridSize);
    const cellWidth = this.sideLength / gridSize;
    const invCell = 1.0 / cellWidth;

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      const gx = Math.min(gridSize - 1, Math.max(0, Math.floor(p.x * invCell)));
      const gy = Math.min(gridSize - 1, Math.max(0, Math.floor(p.y * invCell)));
      density[gy * gridSize + gx]++;
    }

    return { density, gridSize, cellWidth };
  }

  /**
   * Computes spatial uniformity score (Variance-to-Mean Ratio and Chi-square across bins)
   */
  computeSpatialUniformityScore(binsPerDim: number = 8): {
    vmr: number;
    chiSquare: number;
    isUniform: boolean;
  } {
    const totalBins = binsPerDim * binsPerDim;
    const { density } = this.computeDensityGrid(binsPerDim);
    const N = this.particles.length;
    const expected = N / totalBins;

    let sumDiffSq = 0;
    let chiSquare = 0;
    for (let i = 0; i < totalBins; i++) {
      const diff = density[i] - expected;
      sumDiffSq += diff * diff;
      chiSquare += (diff * diff) / expected;
    }

    const variance = sumDiffSq / (totalBins - 1);
    const vmr = variance / expected;
    const isUniform = vmr >= 0.5 && vmr <= 1.8;

    return { vmr, chiSquare, isUniform };
  }
}
