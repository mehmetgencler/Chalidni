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
import type { DominantModalInfo } from '../physics/modalSolver.ts';

export const PATTERN_MEMORY_MIN_SEC = 0.0;
export const PATTERN_MEMORY_MAX_SEC = 4.0;
export const PATTERN_MEMORY_DEFAULT_SEC = 1.5;
export const PATTERN_MEMORY_STEP_SEC = 0.05;
export const PATTERN_MEMORY_ATTACK_TAU_SEC = 0.08;

export const DEFAULT_MEMORY_GRID_RES = 128;

// Fixed, frame-independent intensity mapping parameters (never normalized per frame)
export const MEMORY_DENSITY_FLOOR = 0.12;
export const MEMORY_DENSITY_SATURATION = 1.8;
export const MEMORY_MAX_CELL_DENSITY = 64.0;
export const MEMORY_MAX_ALPHA = 120; // Subtle translucent mineral powder glow (~47% max opacity)

// Two-scale cloud rendering parameters (derived solely from memoryDensity)
// Layer A: Broad soft halo (4x separable 5x5 Gaussian passes, wide spatial footprint)
export const HALO_GAUSSIAN_PASSES = 4;
export const HALO_DENSITY_FLOOR = 0.29;
export const HALO_DENSITY_SATURATION = 1.75;
export const HALO_MAX_ALPHA = 105;
export const HALO_CURVE_GAMMA = 1.25;

// Layer B: Localized dense core (1x 5x5 Gaussian pass, highlights concentrated nodal geometry)
export const CORE_DENSITY_FLOOR = 0.38;
export const CORE_DENSITY_SATURATION = 2.6;
export const CORE_MAX_ALPHA = 175;
export const CORE_CURVE_GAMMA = 0.9;

// Brief, low-intensity modal-frequency-lock pulse parameters
export const MODAL_LOCK_MIN_RMS = 5.0; // m/s^2 (~0.5 g resonant dominance floor)
export const MODAL_LOCK_MIN_DOMINANCE = 0.40; // >=40% of total modal variance in peak frequency cluster
export const MODAL_LOCK_CONFIRM_SEC = 0.09; // Dwell time to confirm a resonant frequency lock
export const MODAL_LOCK_RELEASE_SEC = 0.65; // Idle/unfocused dwell before releasing prior lock
export const MODAL_LOCK_FREQ_TOL_REL = 0.015;
export const MODAL_LOCK_FREQ_TOL_ABS_HZ = 1.5;
export const MODAL_LOCK_PULSE_DURATION_SEC = 0.55;
export const MODAL_LOCK_PULSE_PEAK_SEC = 0.09;
export const MODAL_LOCK_PULSE_HALO_ALPHA_BOOST = 0.24;
export const MODAL_LOCK_PULSE_CORE_ALPHA_BOOST = 0.20;
export const MODAL_LOCK_PULSE_TINT_BOOST = 0.45;

// Experimental mean-density auto-scaling parameters (used only when Normalization Toggle is enabled)
export const NORMALIZED_FLOOR_MEAN_RATIO = 0.65;
export const NORMALIZED_SATURATION_MEAN_RATIO = 6.0;
export const NORMALIZED_HALO_FLOOR_MEAN_RATIO = 0.9;
export const NORMALIZED_HALO_SATURATION_MEAN_RATIO = 4.8;
export const NORMALIZED_CORE_FLOOR_MEAN_RATIO = 1.15;
export const NORMALIZED_CORE_SATURATION_MEAN_RATIO = 6.5;
export const NORMALIZED_MIN_MEAN_DENSITY = 1e-6;

// Cool silvery-white mineral powder tint layered beneath colored live grains
const MEMORY_TINT_R = 216;
const MEMORY_TINT_G = 230;
const MEMORY_TINT_B = 246;

// Two-scale mineral/silver-blue palette (cooler outer halo, brighter pale mineral core)
const HALO_TINT_R = 196;
const HALO_TINT_G = 218;
const HALO_TINT_B = 244;
const HALO_PULSE_TINT_R = 226;
const HALO_PULSE_TINT_G = 238;
const HALO_PULSE_TINT_B = 254;

const CORE_TINT_R = 228;
const CORE_TINT_G = 240;
const CORE_TINT_B = 252;
const CORE_PULSE_TINT_R = 250;
const CORE_PULSE_TINT_G = 253;
const CORE_PULSE_TINT_B = 255;

/**
 * Computes exact half-life release decay factor for a frame interval deltaTimeSec.
 * After elapsed == halfLifeSec with zero new input, memory decays to 0.5 * initial.
 */
export function computeHalfLifeDecay(deltaTimeSec: number, halfLifeSec: number): number {
  if (!Number.isFinite(halfLifeSec) || halfLifeSec <= 0) return 0;
  if (!Number.isFinite(deltaTimeSec) || deltaTimeSec <= 0) return 1;
  return Math.pow(0.5, deltaTimeSec / halfLifeSec);
}

/**
 * Computes fast exponential attack blend factor (1 - exp(-dt / tau)) for rising density.
 */
export function computeAttackBlend(
  deltaTimeSec: number,
  attackTauSec: number = PATTERN_MEMORY_ATTACK_TAU_SEC
): number {
  if (!Number.isFinite(deltaTimeSec) || deltaTimeSec <= 0) return 0;
  if (!Number.isFinite(attackTauSec) || attackTauSec <= 0) return 1;
  return 1 - Math.exp(-deltaTimeSec / attackTauSec);
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

/**
 * Experimental contrast-recovery mapping that auto-scales floor and saturation bounds
 * relative to the field's measured mean density so faint patterns regain visibility.
 */
export function mapNormalizedDensityToAlpha(density: number, meanDensity: number): number {
  if (
    !Number.isFinite(density) ||
    !Number.isFinite(meanDensity) ||
    meanDensity < NORMALIZED_MIN_MEAN_DENSITY
  ) {
    return 0;
  }
  const floor = meanDensity * NORMALIZED_FLOOR_MEAN_RATIO;
  const saturation = meanDensity * NORMALIZED_SATURATION_MEAN_RATIO;
  if (density <= floor || saturation <= floor) return 0;
  const normalized = (density - floor) / (saturation - floor);
  const clamped = normalized >= 1 ? 1 : normalized;
  const shaped = Math.pow(clamped, 0.85);
  return Math.round(shaped * MEMORY_MAX_ALPHA);
}

function mapCurveToAlpha(
  density: number,
  floor: number,
  saturation: number,
  maxAlpha: number,
  gamma: number
): number {
  if (!Number.isFinite(density) || density <= floor || saturation <= floor) return 0;
  const normalized = (density - floor) / (saturation - floor);
  const clamped = normalized >= 1 ? 1 : normalized;
  const shaped = Math.pow(clamped, gamma);
  return Math.round(shaped * maxAlpha);
}

/**
 * Maps broadly blurred density to subtle outer halo alpha [0, HALO_MAX_ALPHA].
 * Suppresses sparse uniform background below HALO_DENSITY_FLOOR so no full-plate haze forms.
 */
export function mapHaloDensityToAlpha(density: number): number {
  return mapCurveToAlpha(
    density,
    HALO_DENSITY_FLOOR,
    HALO_DENSITY_SATURATION,
    HALO_MAX_ALPHA,
    HALO_CURVE_GAMMA
  );
}

/**
 * Maps normalized halo density relative to measured mean density when Normalization Toggle is active.
 */
export function mapNormalizedHaloDensityToAlpha(density: number, meanDensity: number): number {
  if (!Number.isFinite(meanDensity) || meanDensity < NORMALIZED_MIN_MEAN_DENSITY) {
    return 0;
  }
  return mapCurveToAlpha(
    density,
    meanDensity * NORMALIZED_HALO_FLOOR_MEAN_RATIO,
    meanDensity * NORMALIZED_HALO_SATURATION_MEAN_RATIO,
    HALO_MAX_ALPHA,
    HALO_CURVE_GAMMA
  );
}

/**
 * Maps 5x5 core-smoothed density to concentrated luminous core alpha [0, CORE_MAX_ALPHA].
 */
export function mapCoreDensityToAlpha(density: number): number {
  return mapCurveToAlpha(
    density,
    CORE_DENSITY_FLOOR,
    CORE_DENSITY_SATURATION,
    CORE_MAX_ALPHA,
    CORE_CURVE_GAMMA
  );
}

/**
 * Maps normalized core density relative to measured mean density when Normalization Toggle is active.
 */
export function mapNormalizedCoreDensityToAlpha(density: number, meanDensity: number): number {
  if (!Number.isFinite(meanDensity) || meanDensity < NORMALIZED_MIN_MEAN_DENSITY) {
    return 0;
  }
  return mapCurveToAlpha(
    density,
    meanDensity * NORMALIZED_CORE_FLOOR_MEAN_RATIO,
    meanDensity * NORMALIZED_CORE_SATURATION_MEAN_RATIO,
    CORE_MAX_ALPHA,
    CORE_CURVE_GAMMA
  );
}

/**
 * Evaluates a smooth C1 bell-shaped envelope [0, 1] for the brief modal-lock pulse:
 * quick soft rise to peak around MODAL_LOCK_PULSE_PEAK_SEC, followed by cosine-squared falloff.
 */
export function evaluateModalLockPulseCurve(
  elapsedSec: number,
  durationSec: number = MODAL_LOCK_PULSE_DURATION_SEC,
  peakSec: number = MODAL_LOCK_PULSE_PEAK_SEC
): number {
  if (!Number.isFinite(elapsedSec) || elapsedSec < 0 || elapsedSec >= durationSec || durationSec <= 0) {
    return 0;
  }
  const clampedPeak = Math.max(1e-4, Math.min(durationSec * 0.5, peakSec));
  if (elapsedSec < clampedPeak) {
    const u = elapsedSec / clampedPeak;
    return u * u * (3 - 2 * u);
  }
  const decaySpan = durationSec - clampedPeak;
  if (decaySpan <= 0) return 0;
  const u = (elapsedSec - clampedPeak) / decaySpan;
  const c = Math.cos(u * Math.PI * 0.5);
  return c * c;
}

/**
 * Computes synchronized overlay indicator opacity & micro-slide offset from the density-cloud pulse envelope [0, 1].
 */
export function computeOverlayPulseVisibility(pulseAmount: number): {
  opacity: number;
  translateYpx: number;
} {
  if (!Number.isFinite(pulseAmount) || pulseAmount <= 0) {
    return { opacity: 0, translateYpx: -3 };
  }
  const clamped = pulseAmount >= 1 ? 1 : pulseAmount;
  const envelope = Math.pow(clamped, 0.45);
  return {
    opacity: Math.min(0.96, envelope * 0.96),
    translateYpx: envelope >= 1 ? 0 : (1 - envelope) * -3,
  };
}

/**
 * Formats detected resonant frequency into uniform tabular value & unit strings.
 */
export function formatResonantFrequency(freqHz: number): {
  value: string;
  unit: 'Hz' | 'kHz';
  text: string;
} {
  if (!Number.isFinite(freqHz) || freqHz <= 0) {
    return { value: '0.0', unit: 'Hz', text: '0.0 Hz' };
  }
  if (freqHz < 1000) {
    const value = freqHz.toFixed(1);
    return { value, unit: 'Hz', text: `${value} Hz` };
  }
  if (freqHz < 10000) {
    const value = (freqHz / 1000).toFixed(2);
    return { value, unit: 'kHz', text: `${value} kHz` };
  }
  const value = (freqHz / 1000).toFixed(1);
  return { value, unit: 'kHz', text: `${value} kHz` };
}

function sameModalFrequencyCluster(aHz: number, bHz: number): boolean {
  const tol = Math.max(MODAL_LOCK_FREQ_TOL_ABS_HZ, Math.max(aHz, bHz) * MODAL_LOCK_FREQ_TOL_REL);
  return Math.abs(aHz - bHz) <= tol;
}

/**
 * Tracks live dominant modal frequency transitions and emits a short-lived
 * brightness-pulse envelope whenever excitation locks onto a new modal frequency.
 */
export class ModalLockPulseTracker {
  private lockedFreqHz: number | null = null;
  private candidateFreqHz: number | null = null;
  private candidateHoldSec = 0;
  private unlockedDurationSec = 0;
  private pulseElapsedSec = -1;
  private totalLocks = 0;

  get lockedFrequencyHz(): number | null {
    return this.lockedFreqHz;
  }

  get lockCount(): number {
    return this.totalLocks;
  }

  getPulseAmount(): number {
    if (this.pulseElapsedSec < 0) return 0;
    return evaluateModalLockPulseCurve(this.pulseElapsedSec);
  }

  reset(): void {
    this.lockedFreqHz = null;
    this.candidateFreqHz = null;
    this.candidateHoldSec = 0;
    this.unlockedDurationSec = 0;
    this.pulseElapsedSec = -1;
    this.totalLocks = 0;
  }

  update(
    modalInfo: DominantModalInfo | null | undefined,
    deltaTimeSec: number,
    isPaused: boolean = false
  ): number {
    if (isPaused) {
      return this.getPulseAmount();
    }

    const dt = Number.isFinite(deltaTimeSec) && deltaTimeSec > 0 ? Math.min(0.1, deltaTimeSec) : 0;

    if (this.pulseElapsedSec >= 0) {
      this.pulseElapsedSec += dt;
      if (this.pulseElapsedSec >= MODAL_LOCK_PULSE_DURATION_SEC) {
        this.pulseElapsedSec = -1;
      }
    }

    const isQualifying =
      Boolean(modalInfo) &&
      !modalInfo!.isSilent &&
      modalInfo!.hasEnergy &&
      Number.isFinite(modalInfo!.frequency) &&
      modalInfo!.frequency > 0 &&
      modalInfo!.peakRms >= MODAL_LOCK_MIN_RMS &&
      modalInfo!.dominanceRatio >= MODAL_LOCK_MIN_DOMINANCE;

    if (isQualifying) {
      const freq = modalInfo!.frequency;
      this.unlockedDurationSec = 0;

      if (this.candidateFreqHz !== null && sameModalFrequencyCluster(this.candidateFreqHz, freq)) {
        this.candidateHoldSec += dt;
      } else {
        this.candidateFreqHz = freq;
        this.candidateHoldSec = dt;
      }

      const alreadyLocked =
        this.lockedFreqHz !== null && sameModalFrequencyCluster(this.lockedFreqHz, this.candidateFreqHz);

      if (!alreadyLocked && this.candidateHoldSec >= MODAL_LOCK_CONFIRM_SEC) {
        this.lockedFreqHz = this.candidateFreqHz;
        this.pulseElapsedSec = 0;
        this.totalLocks += 1;
      }
    } else {
      this.candidateFreqHz = null;
      this.candidateHoldSec = 0;
      this.unlockedDurationSec += dt;
      if (this.lockedFreqHz !== null && this.unlockedDurationSec >= MODAL_LOCK_RELEASE_SEC) {
        this.lockedFreqHz = null;
      }
    }

    return this.getPulseAmount();
  }
}

export class PatternMemoryField {
  readonly gridRes: number;
  readonly currentDensity: Float32Array;
  readonly memoryDensity: Float32Array;
  private readonly smoothScratch: Float32Array;
  private readonly coreWorkBuffer: Float32Array;
  private readonly haloWorkBuffer: Float32Array;
  private hasAccumulated = false;
  private lastMeanDensity = 0;
  private maxMemoryDensity = 0;

  constructor(gridRes: number = DEFAULT_MEMORY_GRID_RES) {
    this.gridRes = Math.max(16, Math.floor(gridRes));
    const cellCount = this.gridRes * this.gridRes;
    this.currentDensity = new Float32Array(cellCount);
    this.memoryDensity = new Float32Array(cellCount);
    this.smoothScratch = new Float32Array(cellCount);
    this.coreWorkBuffer = new Float32Array(cellCount);
    this.haloWorkBuffer = new Float32Array(cellCount);
  }

  get isActive(): boolean {
    return this.hasAccumulated;
  }

  clear(): void {
    this.currentDensity.fill(0);
    this.memoryDensity.fill(0);
    this.smoothScratch.fill(0);
    this.coreWorkBuffer.fill(0);
    this.haloWorkBuffer.fill(0);
    this.hasAccumulated = false;
    this.lastMeanDensity = 0;
    this.maxMemoryDensity = 0;
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
    return this.applyAsymmetricTemporalUpdate(deltaTimeSec, halfLifeSec);
  }

  /**
   * Advances asymmetric fast-attack / slow-release memory directly from a pre-filled
   * currentDensity buffer (useful for unit tests verifying exact temporal dynamics
   * without particle discretization noise).
   */
  stepWithCurrentDensity(deltaTimeSec: number, halfLifeSec: number): boolean {
    if (!Number.isFinite(halfLifeSec) || halfLifeSec <= 0) {
      if (this.hasAccumulated) {
        this.clear();
      }
      return false;
    }

    return this.applyAsymmetricTemporalUpdate(deltaTimeSec, halfLifeSec);
  }

  private applyAsymmetricTemporalUpdate(deltaTimeSec: number, halfLifeSec: number): boolean {
    const attackBlend = computeAttackBlend(deltaTimeSec, PATTERN_MEMORY_ATTACK_TAU_SEC);
    const releaseDecay = computeHalfLifeDecay(deltaTimeSec, halfLifeSec);
    const cur = this.currentDensity;
    const mem = this.memoryDensity;
    const len = mem.length;

    let anyNonZero = false;
    let maxVal = 0;
    for (let i = 0; i < len; i++) {
      const c = cur[i];
      const prev = mem[i];
      const nextRaw =
        c >= prev
          ? prev + (c - prev) * attackBlend
          : c + (prev - c) * releaseDecay;
      const next =
        !Number.isFinite(nextRaw) || nextRaw < 1e-6
          ? 0
          : nextRaw > MEMORY_MAX_CELL_DENSITY
            ? MEMORY_MAX_CELL_DENSITY
            : nextRaw;
      mem[i] = next;
      if (next > 0) {
        anyNonZero = true;
        if (next > maxVal) maxVal = next;
      }
    }

    this.hasAccumulated = anyNonZero;
    this.maxMemoryDensity = maxVal;
    return anyNonZero;
  }

  /**
   * Writes a locally 5x5 separable Gaussian-smoothed ([1, 4, 6, 4, 1] / 16) view of the
   * accumulated density field into a pre-allocated RGBA Uint8ClampedArray (gridRes * gridRes * 4 bytes).
   * Uses a single pre-allocated Float32Array scratch buffer for the horizontal pass,
   * reads strictly from memoryDensity without mutating it, renormalizes edge weights,
   * and performs zero allocations inside pixel loops.
   *
   * When normalizeContrast is true, intensity floor and saturation auto-scale from the
   * measured mean density across the grid to recover contrast for very faint patterns.
   */
  writeToRgba(targetRgba: Uint8ClampedArray, normalizeContrast: boolean = false): void {
    const mem = this.memoryDensity;
    const scratch = this.smoothScratch;
    const len = mem.length;
    if (targetRgba.length < len * 4) return;

    const res = this.gridRes;
    const last = res - 1;
    const lastMinus1 = res - 2;
    let scratchSum = 0;

    // Pass 1: Horizontal 1D Gaussian [1, 4, 6, 4, 1] / 16 -> smoothScratch
    for (let y = 0; y < res; y++) {
      const row = y * res;

      // Left boundary x = 0 (weights: [6, 4, 1] => sum 11)
      const s0 = (6 * mem[row] + 4 * mem[row + 1] + mem[row + 2]) / 11;
      scratch[row] = s0;
      // Left boundary x = 1 (weights: [4, 6, 4, 1] => sum 15)
      const s1 = (4 * mem[row] + 6 * mem[row + 1] + 4 * mem[row + 2] + mem[row + 3]) / 15;
      scratch[row + 1] = s1;
      scratchSum += s0 + s1;

      // Fast interior columns x = 2 .. res - 3 (weights sum = 16)
      for (let x = 2; x < lastMinus1; x++) {
        const idx = row + x;
        const sv =
          (mem[idx - 2] + 4 * mem[idx - 1] + 6 * mem[idx] + 4 * mem[idx + 1] + mem[idx + 2]) *
          0.0625;
        scratch[idx] = sv;
        scratchSum += sv;
      }

      // Right boundary x = res - 2 (weights: [1, 4, 6, 4] => sum 15)
      const sR1 =
        (mem[row + last - 3] +
          4 * mem[row + last - 2] +
          6 * mem[row + last - 1] +
          4 * mem[row + last]) /
        15;
      scratch[row + lastMinus1] = sR1;
      // Right boundary x = res - 1 (weights: [1, 4, 6] => sum 11)
      const sR0 = (mem[row + last - 2] + 4 * mem[row + last - 1] + 6 * mem[row + last]) / 11;
      scratch[row + last] = sR0;
      scratchSum += sR1 + sR0;
    }

    const meanDensity = scratchSum / len;
    this.lastMeanDensity = meanDensity;

    // Pass 2: Vertical 1D Gaussian [1, 4, 6, 4, 1] / 16 from smoothScratch -> targetRgba
    for (let y = 0; y < res; y++) {
      const row0 = y * res;

      if (y >= 2 && y < lastMinus1) {
        const rM2 = row0 - 2 * res;
        const rM1 = row0 - res;
        const rP1 = row0 + res;
        const rP2 = row0 + 2 * res;

        for (let x = 0; x < res; x++) {
          const smoothed =
            (scratch[rM2 + x] +
              4 * scratch[rM1 + x] +
              6 * scratch[row0 + x] +
              4 * scratch[rP1 + x] +
              scratch[rP2 + x]) *
            0.0625;
          const alpha = normalizeContrast
            ? mapNormalizedDensityToAlpha(smoothed, meanDensity)
            : mapDensityToAlpha(smoothed);
          const p = (row0 + x) * 4;
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
      } else {
        const hasM2 = y >= 2;
        const hasM1 = y >= 1;
        const hasP1 = y <= lastMinus1;
        const hasP2 = y <= last - 2;
        const wSum = (hasM2 ? 1 : 0) + (hasM1 ? 4 : 0) + 6 + (hasP1 ? 4 : 0) + (hasP2 ? 1 : 0);
        const invW = 1 / wSum;
        const rM2 = hasM2 ? row0 - 2 * res : 0;
        const rM1 = hasM1 ? row0 - res : 0;
        const rP1 = hasP1 ? row0 + res : 0;
        const rP2 = hasP2 ? row0 + 2 * res : 0;

        for (let x = 0; x < res; x++) {
          let acc = 6 * scratch[row0 + x];
          if (hasM2) acc += scratch[rM2 + x];
          if (hasM1) acc += 4 * scratch[rM1 + x];
          if (hasP1) acc += 4 * scratch[rP1 + x];
          if (hasP2) acc += scratch[rP2 + x];

          const smoothed = acc * invW;
          const alpha = normalizeContrast
            ? mapNormalizedDensityToAlpha(smoothed, meanDensity)
            : mapDensityToAlpha(smoothed);
          const p = (row0 + x) * 4;
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
    }
  }

  /**
   * Applies one separable 5x5 Gaussian pass ([1, 4, 6, 4, 1] / 16) from src -> dst
   * using smoothScratch, safely renormalizing weights along all borders. Returns mean density.
   */
  private applySeparableGaussian5x5(src: Float32Array, dst: Float32Array): number {
    const res = this.gridRes;
    const last = res - 1;
    const lastMinus1 = res - 2;
    const scratch = this.smoothScratch;

    // Horizontal pass: src -> smoothScratch
    for (let y = 0; y < res; y++) {
      const row = y * res;
      scratch[row] = (6 * src[row] + 4 * src[row + 1] + src[row + 2]) / 11;
      scratch[row + 1] = (4 * src[row] + 6 * src[row + 1] + 4 * src[row + 2] + src[row + 3]) / 15;

      for (let x = 2; x < lastMinus1; x++) {
        const idx = row + x;
        scratch[idx] =
          (src[idx - 2] + 4 * src[idx - 1] + 6 * src[idx] + 4 * src[idx + 1] + src[idx + 2]) *
          0.0625;
      }

      scratch[row + lastMinus1] =
        (src[row + last - 3] +
          4 * src[row + last - 2] +
          6 * src[row + last - 1] +
          4 * src[row + last]) /
        15;
      scratch[row + last] =
        (src[row + last - 2] + 4 * src[row + last - 1] + 6 * src[row + last]) / 11;
    }

    // Vertical pass: smoothScratch -> dst
    let totalSum = 0;
    for (let y = 0; y < res; y++) {
      const row0 = y * res;

      if (y >= 2 && y < lastMinus1) {
        const rM2 = row0 - 2 * res;
        const rM1 = row0 - res;
        const rP1 = row0 + res;
        const rP2 = row0 + 2 * res;

        for (let x = 0; x < res; x++) {
          const v =
            (scratch[rM2 + x] +
              4 * scratch[rM1 + x] +
              6 * scratch[row0 + x] +
              4 * scratch[rP1 + x] +
              scratch[rP2 + x]) *
            0.0625;
          dst[row0 + x] = v;
          totalSum += v;
        }
      } else {
        const hasM2 = y >= 2;
        const hasM1 = y >= 1;
        const hasP1 = y <= lastMinus1;
        const hasP2 = y <= last - 2;
        const wSum = (hasM2 ? 1 : 0) + (hasM1 ? 4 : 0) + 6 + (hasP1 ? 4 : 0) + (hasP2 ? 1 : 0);
        const invW = 1 / wSum;
        const rM2 = hasM2 ? row0 - 2 * res : 0;
        const rM1 = hasM1 ? row0 - res : 0;
        const rP1 = hasP1 ? row0 + res : 0;
        const rP2 = hasP2 ? row0 + 2 * res : 0;

        for (let x = 0; x < res; x++) {
          let acc = 6 * scratch[row0 + x];
          if (hasM2) acc += scratch[rM2 + x];
          if (hasM1) acc += 4 * scratch[rM1 + x];
          if (hasP1) acc += 4 * scratch[rP1 + x];
          if (hasP2) acc += scratch[rP2 + x];

          const v = acc * invW;
          dst[row0 + x] = v;
          totalSum += v;
        }
      }
    }

    return src.length > 0 ? totalSum / src.length : 0;
  }

  /**
   * Renders TWO spatial scales from the exact same unchanged memoryDensity buffer:
   * - Layer A (haloRgba): broad outer aura obtained via repeated 5x5 separable Gaussian passes.
   * - Layer B (coreRgba): localized dense core using a single 5x5 separable Gaussian pass.
   * Optional pulseAmount in [0, 1] applies a brief, low-intensity mineral brightness & opacity
   * increase strictly to existing cloud regions while keeping empty areas transparent.
   * Performs zero heap allocations and never mutates memoryDensity.
   */
  writeDualLayersToRgba(
    haloRgba: Uint8ClampedArray,
    coreRgba: Uint8ClampedArray,
    normalizeContrast: boolean = false,
    pulseAmount: number = 0
  ): void {
    const mem = this.memoryDensity;
    const len = mem.length;
    if (haloRgba.length < len * 4 || coreRgba.length < len * 4) return;

    const pulse = Number.isFinite(pulseAmount) ? Math.max(0, Math.min(1, pulseAmount)) : 0;
    const hasPulse = pulse > 0;
    const tintMix = pulse * MODAL_LOCK_PULSE_TINT_BOOST;
    const coreR = hasPulse ? Math.round(CORE_TINT_R + tintMix * (CORE_PULSE_TINT_R - CORE_TINT_R)) : CORE_TINT_R;
    const coreG = hasPulse ? Math.round(CORE_TINT_G + tintMix * (CORE_PULSE_TINT_G - CORE_TINT_G)) : CORE_TINT_G;
    const coreB = hasPulse ? Math.round(CORE_TINT_B + tintMix * (CORE_PULSE_TINT_B - CORE_TINT_B)) : CORE_TINT_B;
    const haloR = hasPulse ? Math.round(HALO_TINT_R + tintMix * (HALO_PULSE_TINT_R - HALO_TINT_R)) : HALO_TINT_R;
    const haloG = hasPulse ? Math.round(HALO_TINT_G + tintMix * (HALO_PULSE_TINT_G - HALO_TINT_G)) : HALO_TINT_G;
    const haloB = hasPulse ? Math.round(HALO_TINT_B + tintMix * (HALO_PULSE_TINT_B - HALO_TINT_B)) : HALO_TINT_B;
    const coreAlphaScale = 1 + pulse * MODAL_LOCK_PULSE_CORE_ALPHA_BOOST;
    const haloAlphaScale = 1 + pulse * MODAL_LOCK_PULSE_HALO_ALPHA_BOOST;

    const coreBuf = this.coreWorkBuffer;
    const haloBuf = this.haloWorkBuffer;

    // Pass 1 (1x 5x5): memoryDensity -> coreWorkBuffer, compute measured mean density
    const meanDensity = this.applySeparableGaussian5x5(mem, coreBuf);
    this.lastMeanDensity = meanDensity;

    // Rasterize Layer B (Dense Core) immediately before reusing coreBuf for halo widening
    for (let i = 0; i < len; i++) {
      const baseAlpha = normalizeContrast
        ? mapNormalizedCoreDensityToAlpha(coreBuf[i], meanDensity)
        : mapCoreDensityToAlpha(coreBuf[i]);
      const p = i * 4;
      if (baseAlpha <= 0) {
        coreRgba[p] = 0;
        coreRgba[p + 1] = 0;
        coreRgba[p + 2] = 0;
        coreRgba[p + 3] = 0;
      } else {
        let outAlpha = baseAlpha;
        if (hasPulse) {
          outAlpha = Math.round(baseAlpha * coreAlphaScale);
          if (outAlpha > 255) outAlpha = 255;
        }
        coreRgba[p] = coreR;
        coreRgba[p + 1] = coreG;
        coreRgba[p + 2] = coreB;
        coreRgba[p + 3] = outAlpha;
      }
    }

    // Additional passes (total = HALO_GAUSSIAN_PASSES) broaden the density field into a smooth outer halo.
    // Core buffer already holds pass 1; alternate between coreBuf & haloBuf so final result lands in haloBuf
    // when extraPasses is odd (default: 4 - 1 = 3 extra passes: core->halo, halo->core, core->halo).
    let src = coreBuf;
    let dst = haloBuf;
    const extraPasses = Math.max(0, HALO_GAUSSIAN_PASSES - 1);
    for (let pass = 0; pass < extraPasses; pass++) {
      this.applySeparableGaussian5x5(src, dst);
      const tmp = src;
      src = dst;
      dst = tmp;
    }
    const finalHalo = extraPasses === 0 ? coreBuf : src;
    const haloMean = normalizeContrast ? meanDensity : 0;

    // Rasterize Layer A (Broad Soft Halo)
    for (let i = 0; i < len; i++) {
      const baseAlpha = normalizeContrast
        ? mapNormalizedHaloDensityToAlpha(finalHalo[i], haloMean)
        : mapHaloDensityToAlpha(finalHalo[i]);
      const p = i * 4;
      if (baseAlpha <= 0) {
        haloRgba[p] = 0;
        haloRgba[p + 1] = 0;
        haloRgba[p + 2] = 0;
        haloRgba[p + 3] = 0;
      } else {
        let outAlpha = baseAlpha;
        if (hasPulse) {
          outAlpha = Math.round(baseAlpha * haloAlphaScale);
          if (outAlpha > 255) outAlpha = 255;
        }
        haloRgba[p] = haloR;
        haloRgba[p + 1] = haloG;
        haloRgba[p + 2] = haloB;
        haloRgba[p + 3] = outAlpha;
      }
    }
  }

  getMeanMemoryDensity(): number {
    const mem = this.memoryDensity;
    if (mem.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < mem.length; i++) {
      sum += mem[i];
    }
    return sum / mem.length;
  }

  getLastMeanDensity(): number {
    return this.lastMeanDensity;
  }

  getLastMaxDensity(): number {
    return this.maxMemoryDensity;
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
