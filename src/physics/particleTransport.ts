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
  private hasSpare: boolean = false;
  private spareGaussian: number = 0;

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
   * Paired Box-Muller transform for standard normal random variables N(0, 1)
   */
  nextGaussian(): number {
    if (this.hasSpare) {
      this.hasSpare = false;
      return this.spareGaussian;
    }
    let u = 0;
    let v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    const mag = Math.sqrt(-2.0 * Math.log(u));
    const angle = 2.0 * Math.PI * v;
    this.spareGaussian = mag * Math.sin(angle);
    this.hasSpare = true;
    return mag * Math.cos(angle);
  }
}

/**
 * Mathematically robust periodic-reflection mapping for domain [0, L].
 * Correctly handles positive overshoot, negative overshoot, multiple plate widths of overshoot,
 * and finite input validation with zero iteration loops and zero clamping artifacts.
 */
export function reflectCoordinate(val: number, L: number): number {
  if (val >= 0 && val <= L) {
    return val;
  }
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

export interface ParticleStepStats {
  maxMicroSteps: number;
  meanMicroSteps: number;
  totalMicroSteps: number;
  maxSubStepVar: number;
  maxSubStepRms: number;
  declaredLimitRms: number;
  boundViolated: boolean;
  updateDurationMs: number;
}

export class ParticleTransportSystem {
  particles: Particle[] = [];
  config: DimensionalTransportConfig;
  sideLength: number; // L (m)
  private prng: Mulberry32PRNG;
  private initialParticleCount: number;
  private feedCooldownElapsed: number = 0;
  private edgeRecycleCursor: number = 0;

  lastInteriorCount: number = 0;
  lastAddedCount: number = 0;
  totalAddedCount: number = 0;

  lastStepStats: ParticleStepStats = {
    maxMicroSteps: 0,
    meanMicroSteps: 0,
    totalMicroSteps: 0,
    maxSubStepVar: 0,
    maxSubStepRms: 0,
    declaredLimitRms: 0.008,
    boundViolated: false,
    updateDurationMs: 0,
  };

  constructor(config: Partial<DimensionalTransportConfig> = {}, sideLength: number = 0.30) {
    this.config = { ...DEFAULT_DIMENSIONAL_CONFIG, ...config };
    this.sideLength = sideLength;
    this.initialParticleCount = this.config.particleCount;
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
    this.initialParticleCount = this.config.particleCount;
    this.feedCooldownElapsed = 0;
    this.edgeRecycleCursor = 0;
    this.lastAddedCount = 0;
    this.totalAddedCount = 0;
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
    this.lastInteriorCount = this.countInteriorParticles(0.001);
  }

  /**
   * Counts active particles strictly outside the specified perimeter band (default 1 mm).
   */
  countInteriorParticles(perimeterBandM: number = 0.001): number {
    const minCoord = perimeterBandM;
    const maxCoord = this.sideLength - perimeterBandM;
    let count = 0;
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      if (
        p.active &&
        p.x > minCoord &&
        p.x < maxCoord &&
        p.y > minCoord &&
        p.y < maxCoord
      ) {
        count++;
      }
    }
    return count;
  }

  /**
   * Checks whether at least one interior point (strictly outside perimeterBandM) on the
   * 4-fold symmetric quadrant RMS grid satisfies the production particle-transport eligibility
   * condition (D_g > 1e-15 evaluated via evaluateDimensionalDiffusivity).
   */
  hasTransportEligibleInteriorField(
    rmsQuadrant: Float64Array,
    halfN: number,
    perimeterBandM: number = 0.001
  ): boolean {
    if (!rmsQuadrant || halfN < 2 || rmsQuadrant.length < halfN * halfN) {
      return false;
    }

    const halfL = this.sideLength * 0.5;
    if (halfL <= perimeterBandM) {
      return false;
    }

    const maxIdx = halfN - 1;
    const minInteriorIdx = Math.min(maxIdx, Math.floor((perimeterBandM / halfL) * maxIdx) + 1);

    // Check plate center (maxIdx, maxIdx) first for O(1) fast path on active center-coupled modes
    if (this.evaluateDimensionalDiffusivity(rmsQuadrant[maxIdx * halfN + maxIdx], false) > 1e-15) {
      return true;
    }

    for (let gy = minInteriorIdx; gy < halfN; gy++) {
      const rowOffset = gy * halfN;
      for (let gx = minInteriorIdx; gx < halfN; gx++) {
        if (this.evaluateDimensionalDiffusivity(rmsQuadrant[rowOffset + gx], false) > 1e-15) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Controlled external powder-feed visualization model:
   * - Preserves all active interior particles, coordinates, and velocities.
   * - Monitors interior count strictly outside the 1 mm perimeter band.
   * - Gates both feeding and perimeter recycling by actual interior RMS transport eligibility (D_g > 1e-15).
   * - When interior count < 70% of initial count (2,100 for 3,000 initial), gradually introduces
   *   small batches into the interior with a 0.20 s cooldown (~12 snapshots) and a strict total ceiling
   *   of maxParticleCount (4,500).
   * - Once total count reaches maxParticleCount (4,500), reclaims only grains dead-trapped inside the
   *   zero-diffusivity 1 mm perimeter rim (never interior nodal grains) back into the interior so sweeping
   *   back down from 20 kHz toward 20 Hz recovers clean Chladni patterns without breaking the 4,500 cap.
   */
  feedInteriorParticlesIfNeeded(
    dt: number,
    isSilent: boolean,
    rmsQuadrant?: Float64Array,
    halfN?: number
  ): number {
    const perimeterBandM = 0.001;
    const minCoord = perimeterBandM;
    const maxCoord = this.sideLength - perimeterBandM;
    const interiorCount = this.countInteriorParticles(perimeterBandM);
    this.lastInteriorCount = interiorCount;

    if (
      isSilent ||
      dt <= 0 ||
      (rmsQuadrant !== undefined &&
        halfN !== undefined &&
        !this.hasTransportEligibleInteriorField(rmsQuadrant, halfN, perimeterBandM))
    ) {
      this.lastAddedCount = 0;
      return 0;
    }

    const feedIntervalSec = 0.2;
    this.feedCooldownElapsed += dt;
    if (this.feedCooldownElapsed < feedIntervalSec) {
      this.lastAddedCount = 0;
      return 0;
    }

    const minInteriorTarget = Math.floor(0.7 * this.initialParticleCount);
    const maxTotal = this.config.maxParticleCount ?? 4500;
    if (interiorCount >= minInteriorTarget) {
      this.lastAddedCount = 0;
      return 0;
    }

    const maxBatchSize = 60;
    const deficit = minInteriorTarget - interiorCount;
    if (deficit <= 0) {
      this.lastAddedCount = 0;
      return 0;
    }

    const headroom = Math.max(0, maxTotal - this.particles.length);
    const toAppend = Math.min(maxBatchSize, deficit, headroom);
    const innerSpan = Math.max(0, this.sideLength - 2.0 * perimeterBandM);

    let introduced = 0;
    for (let i = 0; i < toAppend; i++) {
      const radius = 0.9 + 0.5 * this.prng.next();
      const brightness = 0.82 + 0.36 * this.prng.next();
      this.particles.push({
        x: minCoord + (1e-6 + this.prng.next() * (1.0 - 2e-6)) * innerSpan,
        y: minCoord + (1e-6 + this.prng.next() * (1.0 - 2e-6)) * innerSpan,
        vx: 0,
        vy: 0,
        active: true,
        radius,
        brightness,
      });
      introduced++;
    }

    // Once at maxTotal (or no append headroom left), reclaim perimeter-rim trapped grains proportionally
    // to deficit (bounded <= 300 per 0.20s interval) so interior visibility recovers rapidly after 20 kHz sweeps.
    const recycleBudget = headroom === 0 ? Math.min(300, Math.max(maxBatchSize, Math.ceil(deficit * 0.25)), deficit) : Math.max(0, Math.min(maxBatchSize, deficit) - toAppend);
    const toRecycle = recycleBudget;
    if (toRecycle > 0 && this.particles.length > 0) {
      const n = this.particles.length;
      let cursor = this.edgeRecycleCursor % n;
      let scanned = 0;
      let recycled = 0;
      while (recycled < toRecycle && scanned < n) {
        const p = this.particles[cursor];
        const isPerimeterOrInactive =
          !p.active ||
          p.x <= minCoord ||
          p.x >= maxCoord ||
          p.y <= minCoord ||
          p.y >= maxCoord;
        if (isPerimeterOrInactive) {
          p.x = minCoord + (1e-6 + this.prng.next() * (1.0 - 2e-6)) * innerSpan;
          p.y = minCoord + (1e-6 + this.prng.next() * (1.0 - 2e-6)) * innerSpan;
          p.vx = 0;
          p.vy = 0;
          p.active = true;
          recycled++;
          introduced++;
        }
        cursor = (cursor + 1) % n;
        scanned++;
      }
      this.edgeRecycleCursor = cursor;
    }

    if (introduced > 0) {
      this.feedCooldownElapsed = 0;
    }
    this.lastAddedCount = introduced;
    this.totalAddedCount += introduced;
    this.lastInteriorCount = interiorCount + introduced;
    return introduced;
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

    if (power === 2.0) {
      return dRef * excessGamma * excessGamma;
    }
    return dRef * Math.pow(excessGamma, power);
  }

  /**
   * Adaptive Euler-Maruyama step for driftless Itô SDE:
   * dX = sqrt(2 * D_g) * dW_x
   * dY = sqrt(2 * D_g) * dW_y
   *
   * Enforces the declared 8 mm per-axis RMS sub-step variance bound (2 * D_g(x,y) * subDt <= 0.008^2)
   * using strictly non-anticipative (F_t-adapted) local step sizing evaluated before each increment.
   * Never silently caps below the required step count for physical fields.
   */
  step(
    dt: number = this.config.dt,
    diffusivityEvaluator?: (x: number, y: number) => number
  ): void {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (dt <= 0) return;

    const L = this.sideLength;
    const maxStepRms = 0.008;
    const maxStepVar = maxStepRms * maxStepRms; // 6.4e-5 m^2
    const safetyCap = 4096; // Emergency non-physical divergence guard; tracked explicitly in boundViolated

    let maxMicro = 0;
    let totalMicro = 0;
    let activeCount = 0;
    let maxSubVar = 0;
    let boundViolated = false;

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      if (!p.active) continue;
      activeCount++;

      const D0 = diffusivityEvaluator ? diffusivityEvaluator(p.x, p.y) : 0;
      if (D0 <= 1e-15) {
        p.vx = 0;
        p.vy = 0;
        continue;
      }

      const fullVar = 2.0 * D0 * dt;
      if (fullVar <= maxStepVar || !diffusivityEvaluator) {
        // Fast single step strictly within 8 mm RMS bound
        const sigmaSqrtDt = Math.sqrt(fullVar);
        const dx = sigmaSqrtDt * this.prng.nextGaussian();
        const dy = sigmaSqrtDt * this.prng.nextGaussian();
        p.vx = dx / dt;
        p.vy = dy / dt;
        p.x = reflectCoordinate(p.x + dx, L);
        p.y = reflectCoordinate(p.y + dy, L);
        totalMicro += 1;
        if (1 > maxMicro) maxMicro = 1;
        if (fullVar > maxSubVar) maxSubVar = fullVar;
      } else {
        // Non-anticipative local-diffusivity adaptive micro-stepping guaranteeing 2*D*subDt <= maxStepVar
        const startX = p.x;
        const startY = p.y;
        let remDt = dt;
        let k = 0;
        let Dk = D0;

        while (remDt > 1e-12) {
          if (k > 0) {
            Dk = diffusivityEvaluator(p.x, p.y);
          }
          if (Dk <= 1e-15) break;

          const twoD = 2.0 * Dk;
          const maxAllowedDt = maxStepVar / twoD;
          let subDt: number;
          if (remDt <= maxAllowedDt) {
            subDt = remDt;
          } else if (k + 1 >= safetyCap) {
            subDt = remDt;
            boundViolated = true;
          } else {
            subDt = maxAllowedDt;
          }

          const subVar = twoD * subDt;
          if (subVar > maxSubVar) maxSubVar = subVar;
          if (subVar > maxStepVar * (1 + 1e-9)) boundViolated = true;

          const sigmaSqrtSubDt = Math.sqrt(subVar);
          const dx = sigmaSqrtSubDt * this.prng.nextGaussian();
          const dy = sigmaSqrtSubDt * this.prng.nextGaussian();
          p.x = reflectCoordinate(p.x + dx, L);
          p.y = reflectCoordinate(p.y + dy, L);

          remDt -= subDt;
          k++;
        }

        totalMicro += k;
        if (k > maxMicro) maxMicro = k;
        p.vx = (p.x - startX) / dt;
        p.vy = (p.y - startY) / dt;
      }
    }

    const elapsedMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    this.lastStepStats = {
      maxMicroSteps: maxMicro,
      meanMicroSteps: activeCount > 0 ? totalMicro / activeCount : 0,
      totalMicroSteps: totalMicro,
      maxSubStepVar: maxSubVar,
      maxSubStepRms: Math.sqrt(maxSubVar),
      declaredLimitRms: maxStepRms,
      boundViolated,
      updateDurationMs: elapsedMs,
    };
  }

  /**
   * Closure-free adaptive Itô micro-stepping directly against the 4-fold symmetric quadrant RMS grid.
   * Identical physics and strict 8 mm per-axis RMS sub-step bound as step(), optimized for real-time 60 FPS browsers.
   */
  stepFromRmsGrid(
    dt: number,
    rmsQuadrant: Float64Array,
    halfN: number,
    isSilent: boolean
  ): void {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (dt <= 0) return;

    if (isSilent) {
      for (let i = 0; i < this.particles.length; i++) {
        this.particles[i].vx = 0;
        this.particles[i].vy = 0;
      }
      this.lastStepStats = {
        maxMicroSteps: 0,
        meanMicroSteps: 0,
        totalMicroSteps: 0,
        maxSubStepVar: 0,
        maxSubStepRms: 0,
        declaredLimitRms: 0.008,
        boundViolated: false,
        updateDurationMs: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0,
      };
      return;
    }

    const L = this.sideLength;
    const halfL = L * 0.5;
    const maxIdx = halfN - 1;
    const idxScale = maxIdx / halfL;
    const period = 2.0 * L;

    const { dRef, gammaC, power, g, subThresholdCreepFloor = 0.0 } = this.config;
    const invG = 1.0 / g;
    const isSq = power === 2.0;

    const maxStepRms = 0.008;
    const maxStepVar = maxStepRms * maxStepRms;
    const safetyCap = 4096;

    let maxMicro = 0;
    let totalMicro = 0;
    let activeCount = 0;
    let maxSubVar = 0;
    let boundViolated = false;

    const lookupD = (x: number, y: number): number => {
      if (x <= 0 || x >= L || y <= 0 || y >= L) return 0.0;
      const fx = x > halfL ? L - x : x;
      const fy = y > halfL ? L - y : y;
      const u = fx * idxScale;
      const v = fy * idxScale;
      const gx0 = u >= maxIdx ? maxIdx - 1 : (u < 0 ? 0 : u | 0);
      const gy0 = v >= maxIdx ? maxIdx - 1 : (v < 0 ? 0 : v | 0);
      const tx = u - gx0;
      const ty = v - gy0;
      const row0 = gy0 * halfN;
      const row1 = row0 + halfN;
      const a00 = rmsQuadrant[row0 + gx0];
      const a10 = rmsQuadrant[row0 + gx0 + 1];
      const a01 = rmsQuadrant[row1 + gx0];
      const a11 = rmsQuadrant[row1 + gx0 + 1];
      const aRms = a00 + (a10 - a00) * tx + ((a01 - a00) + (a11 - a01 - a10 + a00) * tx) * ty;
      if (aRms <= 1e-6) return 0.0;
      const excess = aRms * invG - gammaC;
      if (excess <= 0) return subThresholdCreepFloor;
      return isSq ? dRef * excess * excess : dRef * Math.pow(excess, power);
    };

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      if (!p.active) continue;
      activeCount++;

      const D0 = lookupD(p.x, p.y);
      if (D0 <= 1e-15) {
        p.vx = 0;
        p.vy = 0;
        continue;
      }

      const fullVar = 2.0 * D0 * dt;
      if (fullVar <= maxStepVar) {
        const sigmaSqrtDt = Math.sqrt(fullVar);
        const dx = sigmaSqrtDt * this.prng.nextGaussian();
        const dy = sigmaSqrtDt * this.prng.nextGaussian();
        p.vx = dx / dt;
        p.vy = dy / dt;
        let nx = p.x + dx;
        if (nx < 0 || nx > L) {
          let rem = nx % period;
          if (rem < 0) rem += period;
          nx = rem > L ? period - rem : rem;
        }
        let ny = p.y + dy;
        if (ny < 0 || ny > L) {
          let rem = ny % period;
          if (rem < 0) rem += period;
          ny = rem > L ? period - rem : rem;
        }
        p.x = nx;
        p.y = ny;
        totalMicro += 1;
        if (1 > maxMicro) maxMicro = 1;
        if (fullVar > maxSubVar) maxSubVar = fullVar;
      } else {
        const startX = p.x;
        const startY = p.y;
        let remDt = dt;
        let k = 0;
        let Dk = D0;

        while (remDt > 1e-12) {
          if (k > 0) {
            Dk = lookupD(p.x, p.y);
          }
          if (Dk <= 1e-15) break;

          const twoD = 2.0 * Dk;
          const maxAllowedDt = maxStepVar / twoD;
          let subDt: number;
          if (remDt <= maxAllowedDt) {
            subDt = remDt;
          } else if (k + 1 >= safetyCap) {
            subDt = remDt;
            boundViolated = true;
          } else {
            subDt = maxAllowedDt;
          }

          const subVar = twoD * subDt;
          if (subVar > maxSubVar) maxSubVar = subVar;
          if (subVar > maxStepVar * (1 + 1e-9)) boundViolated = true;

          const sigmaSqrtSubDt = Math.sqrt(subVar);
          const dx = sigmaSqrtSubDt * this.prng.nextGaussian();
          const dy = sigmaSqrtSubDt * this.prng.nextGaussian();
          let nx = p.x + dx;
          if (nx < 0 || nx > L) {
            let rem = nx % period;
            if (rem < 0) rem += period;
            nx = rem > L ? period - rem : rem;
          }
          let ny = p.y + dy;
          if (ny < 0 || ny > L) {
            let rem = ny % period;
            if (rem < 0) rem += period;
            ny = rem > L ? period - rem : rem;
          }
          p.x = nx;
          p.y = ny;

          remDt -= subDt;
          k++;
        }

        totalMicro += k;
        if (k > maxMicro) maxMicro = k;
        p.vx = (p.x - startX) / dt;
        p.vy = (p.y - startY) / dt;
      }
    }

    if (this.config.enableExternalPowderFeed) {
      this.feedInteriorParticlesIfNeeded(dt, false, rmsQuadrant, halfN);
    }

    const elapsedMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    this.lastStepStats = {
      maxMicroSteps: maxMicro,
      meanMicroSteps: activeCount > 0 ? totalMicro / activeCount : 0,
      totalMicroSteps: totalMicro,
      maxSubStepVar: maxSubVar,
      maxSubStepRms: Math.sqrt(maxSubVar),
      declaredLimitRms: maxStepRms,
      boundViolated,
      updateDurationMs: elapsedMs,
    };
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
