/**
 * Visual-only Chladni pattern-memory field.
 *
 * Reads live particle positions, rasterizes instantaneous spatial density into
 * reusable Float32Array buffers, and blends into an accumulated density-memory
 * buffer with an exponentially weighted moving average parameterized by half-life:
 *
 *   decay = 0.5 ^ (dt / halfLifeSeconds)
 *   memoryNew = decay * memoryOld + (1 - decay) * currentDensity
 *
 * This module performs zero physics calculations and never mutates particle state.
 */

import { Particle } from '../physics/types.ts';

export const PATTERN_MEMORY_MIN_SEC = 0.0;
export const PATTERN_MEMORY_MAX_SEC = 4.0;
export const PATTERN_MEMORY_DEFAULT_SEC = 1.5;
export const PATTERN_MEMORY_STEP_SEC = 0.05;

export const DEFAULT_MEMORY_GRID_RES = 128;

// Fixed, frame-independent intensity mapping parameters (never normalized per frame)
export const MEMORY_DENSITY_FLOOR = 0.22;
export const MEMORY_DENSITY_SATURATION = 2.6;
export const MEMORY_MAX_CELL_DENSITY = 64.0;
export const MEMORY_MAX_ALPHA = 105; // Subtle translucent mineral powder glow (~41% max opacity)

// Cool silvery-white mineral powder tint layered beneath colored live grains
const MEMORY_TINT_R = 216;
const MEMORY_TINT_G = 230;
const MEMORY_TINT_B = 246;

/**
 * Computes exact half-life EWMA decay factor for a frame interval deltaTimeSec.
 * After elapsed == halfLifeSec with zero new input, memory decays to 0.5 * initial.
 */
export function computeHalfLifeDecay(deltaTimeSec: number, halfLifeSec: number): number {
  if (!Number.isFinite(halfLifeSec) || halfLifeSec <= 0) return 0;
  if (!Number.isFinite(deltaTimeSec) || deltaTimeSec <= 0) return 1;
  return Math.pow(0.5, deltaTimeSec / halfLifeSec);
}

/**
 * Maps a single cell's accumulated particle density to a subtle opacity [0, MEMORY_MAX_ALPHA]
 * using a fixed intensity curve so brightness never flickers with per-frame maxima.
 */
export function mapDensityToAlpha(density: number): number {
  if (!Number.isFinite(density) || density <= MEMORY_DENSITY_FLOOR) return 0;
  const normalized = (density - MEMORY_DENSITY_FLOOR) / (MEMORY_DENSITY_SATURATION - MEMORY_DENSITY_FLOOR);
  const clamped = normalized >= 1 ? 1 : normalized;
  const shaped = Math.pow(clamped, 0.85);
  return Math.round(shaped * MEMORY_MAX_ALPHA);
}

export class PatternMemoryField {
  readonly gridRes: number;
  readonly currentDensity: Float32Array;
  readonly memoryDensity: Float32Array;
  private hasAccumulated = false;

  constructor(gridRes: number = DEFAULT_MEMORY_GRID_RES) {
    this.gridRes = Math.max(16, Math.floor(gridRes));
    const cellCount = this.gridRes * this.gridRes;
    this.currentDensity = new Float32Array(cellCount);
    this.memoryDensity = new Float32Array(cellCount);
  }

  get isActive(): boolean {
    return this.hasAccumulated;
  }

  clear(): void {
    this.currentDensity.fill(0);
    this.memoryDensity.fill(0);
    this.hasAccumulated = false;
  }

  /**
   * Rasterizes active particle positions into currentDensity using a mass-conserving
   * continuous 2x2 bilinear splat. Zero heap allocations.
   */
  rasterizeParticles(particles: readonly Particle[], sideLength: number): void {
    this.currentDensity.fill(0);
    if (!Number.isFinite(sideLength) || sideLength <= 0 || particles.length === 0) {
      return;
    }

    const res = this.gridRes;
    const maxIdx = res - 1;
    const invL = maxIdx / sideLength;
    const buf = this.currentDensity;

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (!p.active) continue;
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;

      const gx = p.x * invL;
      const gy = p.y * invL;
      const cx = gx <= 0 ? 0 : gx >= maxIdx ? maxIdx : gx;
      const cy = gy <= 0 ? 0 : gy >= maxIdx ? maxIdx : gy;

      const ix = cx >= maxIdx ? maxIdx - 1 : cx | 0;
      const iy = cy >= maxIdx ? maxIdx - 1 : cy | 0;
      const tx = cx - ix;
      const ty = cy - iy;

      const oneMinusTx = 1 - tx;
      const oneMinusTy = 1 - ty;
      const row0 = iy * res + ix;
      const row1 = row0 + res;

      buf[row0] += oneMinusTx * oneMinusTy;
      buf[row0 + 1] += tx * oneMinusTy;
      buf[row1] += oneMinusTx * ty;
      buf[row1 + 1] += tx * ty;
    }
  }

  /**
   * Updates the accumulated pattern-memory field for one animation step.
   *
   * - At halfLifeSec <= 0: disables & clears pattern memory completely.
   * - When isPaused is true: preserves existing memoryDensity unchanged without
   *   injecting stationary paused particles or washing out the paused image.
   */
  step(
    particles: readonly Particle[],
    sideLength: number,
    deltaTimeSec: number,
    halfLifeSec: number,
    isPaused: boolean = false
  ): boolean {
    if (!Number.isFinite(halfLifeSec) || halfLifeSec <= 0) {
      if (this.hasAccumulated) {
        this.clear();
      }
      return false;
    }

    if (isPaused) {
      return this.hasAccumulated;
    }

    this.rasterizeParticles(particles, sideLength);

    const decay = computeHalfLifeDecay(deltaTimeSec, halfLifeSec);
    const inject = 1 - decay;
    const cur = this.currentDensity;
    const mem = this.memoryDensity;
    const len = mem.length;

    let anyNonZero = false;
    for (let i = 0; i < len; i++) {
      const prev = mem[i];
      const nextRaw = decay * prev + inject * cur[i];
      const next =
        !Number.isFinite(nextRaw) || nextRaw < 1e-6
          ? 0
          : nextRaw > MEMORY_MAX_CELL_DENSITY
            ? MEMORY_MAX_CELL_DENSITY
            : nextRaw;
      mem[i] = next;
      if (next > 0) anyNonZero = true;
    }

    this.hasAccumulated = anyNonZero;
    return anyNonZero;
  }

  /**
   * Advances EWMA directly from a pre-filled currentDensity buffer (useful for unit tests
   * verifying exact decay without particle discretization noise).
   */
  stepWithCurrentDensity(deltaTimeSec: number, halfLifeSec: number): boolean {
    if (!Number.isFinite(halfLifeSec) || halfLifeSec <= 0) {
      if (this.hasAccumulated) {
        this.clear();
      }
      return false;
    }

    const decay = computeHalfLifeDecay(deltaTimeSec, halfLifeSec);
    const inject = 1 - decay;
    const cur = this.currentDensity;
    const mem = this.memoryDensity;
    const len = mem.length;

    let anyNonZero = false;
    for (let i = 0; i < len; i++) {
      const nextRaw = decay * mem[i] + inject * cur[i];
      const next =
        !Number.isFinite(nextRaw) || nextRaw < 1e-6
          ? 0
          : nextRaw > MEMORY_MAX_CELL_DENSITY
            ? MEMORY_MAX_CELL_DENSITY
            : nextRaw;
      mem[i] = next;
      if (next > 0) anyNonZero = true;
    }

    this.hasAccumulated = anyNonZero;
    return anyNonZero;
  }

  /**
   * Writes the accumulated density field into a pre-allocated RGBA Uint8ClampedArray
   * matching ImageData.data layout (gridRes * gridRes * 4 bytes). Zero allocations.
   */
  writeToRgba(targetRgba: Uint8ClampedArray): void {
    const mem = this.memoryDensity;
    const len = mem.length;
    if (targetRgba.length < len * 4) return;

    for (let i = 0; i < len; i++) {
      const alpha = mapDensityToAlpha(mem[i]);
      const p = i * 4;
      if (alpha <= 0) {
        targetRgba[p] = 0;
        targetRgba[p + 1] = 0;
        targetRgba[p + 2] = 0;
        targetRgba[p + 3] = 0;
      } else {
        targetRgba[p] = MEMORY_TINT_R;
        targetRgba[p + 1] = MEMORY_TINT_G;
        targetRgba[p + 2] = MEMORY_TINT_B;
        targetRgba[p + 3] = alpha;
      }
    }
  }

  getMaxMemoryDensity(): number {
    let maxVal = 0;
    const mem = this.memoryDensity;
    for (let i = 0; i < mem.length; i++) {
      if (mem[i] > maxVal) maxVal = mem[i];
    }
    return maxVal;
  }
}
