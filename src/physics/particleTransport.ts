/**
 * Particle Transport: Itô Stochastic Differential Equation Simulator
 * 
 * dX = sqrt(2 * D_g) * dW_x
 * dY = sqrt(2 * D_g) * dW_y
 * 
 * Corresponding Fokker-Planck Equation:
 * dc/dt = div^2(D_g * c)
 * 
 * Under reflecting boundary conditions, stationary state satisfies:
 * c(x, y) proportional to 1 / D_g(x, y)
 * (Without gradient-of-diffusivity drift)
 */

import { Particle, TransportConfig } from './types.ts';

/**
 * High-quality seeded pseudo-random number generator (Mulberry32)
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
 * Reflects coordinate into [0, L]
 */
export function reflectCoordinate(val: number, L: number): number {
  let v = val;
  // Safety iteration limit
  let iters = 0;
  while ((v < 0 || v > L) && iters < 10) {
    if (v < 0) {
      v = -v;
    } else if (v > L) {
      v = 2 * L - v;
    }
    iters++;
  }
  return Math.min(Math.max(v, 0), L);
}

export class ParticleTransportSystem {
  particles: Particle[] = [];
  config: TransportConfig;
  sideLength: number; // L (m)
  private prng: Mulberry32PRNG;

  constructor(config: TransportConfig, sideLength: number = 0.30) {
    this.config = { ...config };
    this.sideLength = sideLength;
    this.prng = new Mulberry32PRNG(config.seed);
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
      this.particles.push({
        x: this.prng.next() * L,
        y: this.prng.next() * L,
        vx: 0,
        vy: 0,
        active: true,
      });
    }
  }

  /**
   * Evaluates local diffusivity D_g(x, y) based on local vibration acceleration
   * D_g = D_base + alpha * (a_rms / a_ref)^2
   * If zeroVibration = true, D_g is 0 (zero transport)
   */
  evaluateDiffusivity(
    x: number,
    y: number,
    diffusivityEvaluator?: (x: number, y: number) => number
  ): number {
    if (diffusivityEvaluator) {
      return diffusivityEvaluator(x, y);
    }
    return this.config.baseDiffusivity;
  }

  /**
   * Euler-Maruyama step for Itô SDE:
   * dX = sqrt(2 * D_g) * dW_x
   * dY = sqrt(2 * D_g) * dW_y
   * With zero drift (no grad D_g drift) and reflecting boundaries.
   */
  step(
    dt: number = this.config.dt,
    diffusivityEvaluator?: (x: number, y: number) => number
  ): void {
    const L = this.sideLength;
    const sqrtDt = Math.sqrt(dt);

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      if (!p.active) continue;

      const D_g = this.evaluateDiffusivity(p.x, p.y, diffusivityEvaluator);

      // If vibration/diffusivity is zero, transport is strictly zero
      if (D_g <= 1e-15) {
        p.vx = 0;
        p.vy = 0;
        continue;
      }

      const sigma = Math.sqrt(2 * D_g);
      const dWx = sqrtDt * this.prng.nextGaussian();
      const dWy = sqrtDt * this.prng.nextGaussian();

      const dx = sigma * dWx;
      const dy = sigma * dWy;

      p.vx = dx / dt;
      p.vy = dy / dt;

      // Update position with reflection at plate edges
      p.x = reflectCoordinate(p.x + dx, L);
      p.y = reflectCoordinate(p.y + dy, L);
    }
  }

  /**
   * Computes a 2D density histogram of current particles on an N x N spatial grid
   */
  computeDensityGrid(gridSize: number): {
    density: Float64Array; // size gridSize * gridSize
    gridSize: number;
    cellSize: number;
  } {
    const total = this.particles.length;
    const density = new Float64Array(gridSize * gridSize);
    const cellSize = this.sideLength / gridSize;

    for (const p of this.particles) {
      let gx = Math.floor(p.x / cellSize);
      let gy = Math.floor(p.y / cellSize);
      if (gx < 0) gx = 0;
      if (gx >= gridSize) gx = gridSize - 1;
      if (gy < 0) gy = 0;
      if (gy >= gridSize) gy = gridSize - 1;

      density[gy * gridSize + gx] += 1;
    }

    // Normalize so total sum is 1.0 (probability density)
    if (total > 0) {
      for (let i = 0; i < density.length; i++) {
        density[i] /= total;
      }
    }

    return { density, gridSize, cellSize };
  }

  /**
   * Checks whether all particles are strictly conserved and inside plate boundaries
   */
  verifyConservationAndBounds(): { conserved: boolean; count: number; inBounds: boolean } {
    let count = 0;
    let inBounds = true;
    const L = this.sideLength;

    for (const p of this.particles) {
      count++;
      if (p.x < 0 || p.x > L || p.y < 0 || p.y > L || isNaN(p.x) || isNaN(p.y)) {
        inBounds = false;
      }
    }

    return {
      conserved: count === this.config.particleCount,
      count,
      inBounds,
    };
  }

  /**
   * Computes mirror symmetry metric across center lines x = L/2 and y = L/2
   * Returns symmetry score in [0, 1], where 1.0 is perfect statistical symmetry.
   */
  computeSymmetryScore(gridSize: number = 32): { xSymmetry: number; ySymmetry: number; overall: number } {
    const { density } = this.computeDensityGrid(gridSize);
    let diffX = 0;
    let diffY = 0;
    let total = 0;

    for (let gy = 0; gy < gridSize; gy++) {
      for (let gx = 0; gx < gridSize; gx++) {
        const val = density[gy * gridSize + gx];
        total += val;

        // mirror in X
        const mirrorGx = gridSize - 1 - gx;
        const mirrorValX = density[gy * gridSize + mirrorGx];
        diffX += Math.abs(val - mirrorValX);

        // mirror in Y
        const mirrorGy = gridSize - 1 - gy;
        const mirrorValY = density[mirrorGy * gridSize + gx];
        diffY += Math.abs(val - mirrorValY);
      }
    }

    const xSymmetry = total > 0 ? Math.max(0, 1 - diffX / (2 * total)) : 1;
    const ySymmetry = total > 0 ? Math.max(0, 1 - diffY / (2 * total)) : 1;
    const overall = (xSymmetry + ySymmetry) / 2;

    return { xSymmetry, ySymmetry, overall };
  }
}
