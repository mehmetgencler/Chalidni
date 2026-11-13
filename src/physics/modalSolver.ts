/**
 * Modal Solver: Unified Generalized Single-Degree-of-Freedom Plate Modal Bank
 * Features:
 * - Full 20 Hz to 20,000 Hz active modal coverage (all 146 odd-odd center-coupled modes).
 * - Exact discrete-time ZOH state transition integration for offline verification.
 * - Sparse active covariance evaluation + Chebyshev odd-harmonic recurrence for O(active) 3,000-particle field queries.
 * - Unified snapshot synchronization for both sine test tones and uploaded audio files via AudioWorklet.
 */

import { ModalSnapshot, ModeState, PlateGeometry, PlateMaterial } from './types.ts';
import {
  calculateAnalyticalFrequency,
  calculateModalMass,
  DEFAULT_ALUMINUM,
  DEFAULT_GEOMETRY,
  generateModalCatalogue,
  getActiveCenterCoupledModes,
  ModeCatalogueItem,
  modeShape,
} from './plate.ts';

export interface AnalyticalHarmonicResponse {
  amplitude: number; // m
  phaseLag: number;  // radians [0, pi]
  resonanceFrequency: number; // Hz
}

/**
 * Analytical steady-state response for harmonic excitation Q(t) = Q0 * cos(Omega * t):
 * |q| = Q0 / [M * sqrt((omega^2 - Omega^2)^2 + (2 * zeta * omega * Omega)^2)]
 * delta = atan2(2 * zeta * omega * Omega, omega^2 - Omega^2)
 * Retained strictly as an independent mathematical reference for verification tests.
 */
export function calculateAnalyticalHarmonicResponse(
  Q0: number,
  M: number,
  omega: number,
  Omega: number,
  zeta: number
): AnalyticalHarmonicResponse {
  const deltaOmegaSq = omega * omega - Omega * Omega;
  const dampingTerm = 2 * zeta * omega * Omega;
  const denom = M * Math.sqrt(deltaOmegaSq * deltaOmegaSq + dampingTerm * dampingTerm);

  const amplitude = denom > 1e-18 ? Q0 / denom : 0;
  const phaseLag = Math.atan2(dampingTerm, deltaOmegaSq);

  return {
    amplitude,
    phaseLag,
    resonanceFrequency: omega / (2 * Math.PI),
  };
}

export class ModalBank {
  modes: ModeState[] = [];
  material: PlateMaterial;
  geometry: PlateGeometry;
  dampingRatio: number;

  // Full 20 Hz - 20,000 Hz catalogue (557 modes for default plate, 146 center-coupled odd-odd)
  fullCatalogue: ModeCatalogueItem[] = [];

  // Modal acceleration covariance matrix R_ij (n x n)
  covarianceMatrix: Float64Array;
  rmsWindowTimeConstant: number = 0.08;

  // Pre-allocated typed buffers for zero-GC spatial evaluation
  private phisCache: Float64Array;
  private allOddOdd: boolean = true;
  private maxOddHalfIdx: number = 14;
  private sinXCache: Float64Array;
  private sinYCache: Float64Array;
  private mHalfIdx: Int32Array;
  private nHalfIdx: Int32Array;

  // Sparse non-zero covariance structures for fast spatial evaluation across 146 modes
  private activeDiagCount: number = 0;
  private activeDiagIndices: Int32Array;
  private activeDiagValues: Float64Array;

  private activeCrossCount: number = 0;
  private activeCrossI: Int32Array;
  private activeCrossJ: Int32Array;
  private activeCrossValues: Float64Array;

  // Adaptive 4-fold symmetric quadrant RMS field cache (tiers: [33 baseline], 65, 129, 193 => 65x65, 129x129, 257x257, 385x385 plate)
  private static readonly TIER_HALF_NS = [33, 65, 129, 193] as const;
  private tierSinCols: Float64Array[][];
  private tierCosCols: Float64Array[][];
  private cosStride: number = 28;
  private activeFastHalfN: number = 65;
  private forcedHalfN: number | null = null;
  private fastRmsQuadrant: Float64Array;
  private fastGridDirty: boolean = true;
  private lastRebuildDurationMs: number = 0;

  // Exact 2D cosine contraction scratch buffers (zero GC per rebuild)
  private cos2D: Float64Array;
  private activeKxList: Int32Array;
  private nzStart: Int32Array;
  private nzKy: Int32Array;
  private nzVal: Float64Array;
  private rowCosWeights: Float64Array;
  private rowRmsSq: Float64Array;

  constructor(
    material: PlateMaterial = DEFAULT_ALUMINUM,
    geometry: PlateGeometry = DEFAULT_GEOMETRY,
    dampingRatio: number = 0.01,
    activeIndices?: { m: number; n: number }[]
  ) {
    this.material = material;
    this.geometry = geometry;
    this.dampingRatio = dampingRatio;

    this.fullCatalogue = generateModalCatalogue(20000, material, geometry);

    const initialModes =
      activeIndices && activeIndices.length > 0
        ? activeIndices.map(({ m, n }) => {
            const f = calculateAnalyticalFrequency(m, n, material, geometry);
            return {
              m,
              n,
              frequency: f,
              omega: 2 * Math.PI * f,
              modalMass: calculateModalMass(material, geometry),
              centerCoupling: modeShape(m, n, geometry.sideLength / 2, geometry.sideLength / 2, geometry.sideLength),
              isOddOdd: m % 2 !== 0 && n % 2 !== 0,
            };
          })
        : getActiveCenterCoupledModes(20000, material, geometry);

    const nModes = initialModes.length;
    this.covarianceMatrix = new Float64Array(nModes * nModes);
    this.phisCache = new Float64Array(nModes);
    this.mHalfIdx = new Int32Array(nModes);
    this.nHalfIdx = new Int32Array(nModes);

    this.activeDiagIndices = new Int32Array(nModes);
    this.activeDiagValues = new Float64Array(nModes);
    const maxCross = Math.max(1, (nModes * (nModes - 1)) >> 1);
    this.activeCrossI = new Int32Array(maxCross);
    this.activeCrossJ = new Int32Array(maxCross);
    this.activeCrossValues = new Float64Array(maxCross);

    let maxOdd = 1;
    let isAllOddOdd = true;
    for (let i = 0; i < nModes; i++) {
      const m = initialModes[i].m;
      const n = initialModes[i].n;
      if (m % 2 === 0 || n % 2 === 0) {
        isAllOddOdd = false;
      } else {
        this.mHalfIdx[i] = (m - 1) >> 1;
        this.nHalfIdx[i] = (n - 1) >> 1;
        if (m > maxOdd) maxOdd = m;
        if (n > maxOdd) maxOdd = n;
      }
    }
    this.allOddOdd = isAllOddOdd;
    this.maxOddHalfIdx = ((maxOdd - 1) >> 1) + 1;
    this.sinXCache = new Float64Array(this.maxOddHalfIdx);
    this.sinYCache = new Float64Array(this.maxOddHalfIdx);

    // Precompute 1D odd-harmonic sine tables (for isolated single-mode fast path) and cosine tables
    // for exact product-to-sum 2D cosine matrix contraction:
    // sin((2a+1)t)*sin((2b+1)t) = 0.5 * [cos(2|a-b|t) - cos(2(a+b+1)t)]
    const stride = this.maxOddHalfIdx;
    const cosStride = 2 * stride;
    this.cosStride = cosStride;
    const L = geometry.sideLength;

    this.tierSinCols = ModalBank.TIER_HALF_NS.map((halfN) => {
      const cols: Float64Array[] = new Array(stride);
      for (let k = 0; k < stride; k++) {
        const col = new Float64Array(halfN);
        const harmonic = 2 * k + 1;
        for (let g = 0; g < halfN; g++) {
          const coord = (g / (halfN - 1)) * (L * 0.5);
          col[g] = Math.sin((harmonic * Math.PI * coord) / L);
        }
        cols[k] = col;
      }
      return cols;
    });

    this.tierCosCols = ModalBank.TIER_HALF_NS.map((halfN) => {
      const cols: Float64Array[] = new Array(cosStride);
      for (let k = 0; k < cosStride; k++) {
        const col = new Float64Array(halfN);
        const twoK = 2 * k;
        for (let g = 0; g < halfN; g++) {
          const coord = (g / (halfN - 1)) * (L * 0.5);
          col[g] = Math.cos((twoK * Math.PI * coord) / L);
        }
        cols[k] = col;
      }
      return cols;
    });

    const maxHalfN = ModalBank.TIER_HALF_NS[ModalBank.TIER_HALF_NS.length - 1];
    this.fastRmsQuadrant = new Float64Array(maxHalfN * maxHalfN);
    this.cos2D = new Float64Array(cosStride * cosStride);
    this.activeKxList = new Int32Array(cosStride);
    this.nzStart = new Int32Array(cosStride + 1);
    this.nzKy = new Int32Array(cosStride * cosStride);
    this.nzVal = new Float64Array(cosStride * cosStride);
    this.rowCosWeights = new Float64Array(cosStride);
    this.rowRmsSq = new Float64Array(maxHalfN);

    const M = calculateModalMass(material, geometry);
    this.modes = initialModes.map((m) => {
      const omega = m.omega;
      const omegaD = omega * Math.sqrt(Math.max(0, 1 - dampingRatio * dampingRatio));
      return {
        m: m.m,
        n: m.n,
        frequency: m.frequency,
        omega,
        omegaD,
        modalMass: M,
        modalStiffness: M * omega * omega,
        modalDamping: 2 * M * dampingRatio * omega,
        displacement: 0,
        velocity: 0,
        acceleration: 0,
        generalizedForce: 0,
        dampingRatio,
        active: true,
      };
    });
  }

  /**
   * Returns lightweight mode definitions suitable for configuring the AudioWorkletProcessor.
   */
  getWorkletModeConfig(): {
    m: number;
    n: number;
    frequency: number;
    omega: number;
    zeta: number;
    modalMass: number;
  }[] {
    return this.modes.map((m) => ({
      m: m.m,
      n: m.n,
      frequency: m.frequency,
      omega: m.omega,
      zeta: m.dampingRatio,
      modalMass: m.modalMass,
    }));
  }

  reset(): void {
    for (const mode of this.modes) {
      mode.displacement = 0;
      mode.velocity = 0;
      mode.acceleration = 0;
      mode.generalizedForce = 0;
    }
    this.covarianceMatrix.fill(0);
    this.activeDiagCount = 0;
    this.activeCrossCount = 0;
    this.fastRmsQuadrant.fill(0);
    this.fastGridDirty = true;
  }

  computeGeneralizedForces(
    isPointForce: boolean,
    excitationValue: number,
    x0: number = 0.15,
    y0: number = 0.15
  ): void {
    const L = this.geometry.sideLength;
    for (const mode of this.modes) {
      if (isPointForce) {
        mode.generalizedForce = excitationValue * modeShape(mode.m, mode.n, x0, y0, L);
      } else {
        if (mode.m % 2 !== 0 && mode.n % 2 !== 0) {
          const couplingArea = (4 * L * L) / (mode.m * mode.n * Math.PI * Math.PI);
          mode.generalizedForce = excitationValue * couplingArea;
        } else {
          mode.generalizedForce = 0;
        }
      }
    }
  }

  stepExactZOH(dt: number): void {
    for (const mode of this.modes) {
      if (!mode.active) continue;

      const omega = mode.omega;
      const zeta = mode.dampingRatio;
      const omegaD = mode.omegaD;
      const M = mode.modalMass;
      const u = mode.generalizedForce / M;

      const qEq = u / (omega * omega);
      const q0Tilde = mode.displacement - qEq;
      const v0 = mode.velocity;

      const expDecay = Math.exp(-zeta * omega * dt);
      const cosTerm = Math.cos(omegaD * dt);
      const sinTerm = Math.sin(omegaD * dt);

      const qTildeNew = expDecay * (q0Tilde * cosTerm + ((v0 + zeta * omega * q0Tilde) / omegaD) * sinTerm);
      const vNew = expDecay * (v0 * cosTerm - ((omega * omega * q0Tilde + zeta * omega * v0) / omegaD) * sinTerm);

      mode.displacement = qTildeNew + qEq;
      mode.velocity = vNew;
      mode.acceleration = u - 2 * zeta * omega * vNew - omega * omega * mode.displacement;
    }

    this.updateCovarianceMatrix(dt);
  }

  updateCovarianceMatrix(dt: number): void {
    const alpha = 1.0 - Math.exp(-dt / this.rmsWindowTimeConstant);
    const n = this.modes.length;

    for (let i = 0; i < n; i++) {
      const ai = this.modes[i].active ? this.modes[i].acceleration : 0;
      for (let j = 0; j < n; j++) {
        const aj = this.modes[j].active ? this.modes[j].acceleration : 0;
        const idx = i * n + j;
        this.covarianceMatrix[idx] = this.covarianceMatrix[idx] * (1 - alpha) + (ai * aj) * alpha;
      }
    }

    this.rebuildSparseCovarianceIndex();
  }

  private rebuildSparseCovarianceIndex(): void {
    const n = this.modes.length;
    let dCount = 0;
    let cCount = 0;

    for (let i = 0; i < n; i++) {
      const d = this.covarianceMatrix[i * n + i];
      if (d > 1e-10) {
        this.activeDiagIndices[dCount] = i;
        this.activeDiagValues[dCount] = d;
        dCount++;
      }
      const row = i * n;
      for (let j = i + 1; j < n; j++) {
        const v = this.covarianceMatrix[row + j];
        if (Math.abs(v) > 1e-10) {
          this.activeCrossI[cCount] = i;
          this.activeCrossJ[cCount] = j;
          this.activeCrossValues[cCount] = v;
          cCount++;
        }
      }
    }

    this.activeDiagCount = dCount;
    this.activeCrossCount = cCount;
    this.fastGridDirty = true;
  }

  /**
   * Applies an AudioWorklet snapshot (for both test tone and uploaded audio file playback).
   */
  applySnapshot(snapshot: ModalSnapshot): void {
    const n = this.modes.length;
    const stateLen = Math.min(n, snapshot.displacements.length);
    for (let i = 0; i < stateLen; i++) {
      this.modes[i].displacement = snapshot.displacements[i];
      this.modes[i].velocity = snapshot.velocities[i];
      this.modes[i].acceleration = snapshot.accelerations[i];
    }

    if (snapshot.covarianceDiag && snapshot.covarianceCross) {
      // Fast sparse snapshot update
      this.covarianceMatrix.fill(0);
      let dCount = 0;
      const diagLen = Math.min(n, snapshot.covarianceDiag.length);
      for (let i = 0; i < diagLen; i++) {
        const d = snapshot.covarianceDiag[i];
        this.covarianceMatrix[i * n + i] = d;
        if (d > 1e-10) {
          this.activeDiagIndices[dCount] = i;
          this.activeDiagValues[dCount] = d;
          dCount++;
        }
      }
      this.activeDiagCount = dCount;

      let cCount = 0;
      const cross = snapshot.covarianceCross;
      for (let k = 0; k + 2 < cross.length; k += 3) {
        const i = cross[k];
        const j = cross[k + 1];
        const v = cross[k + 2];
        if (i >= 0 && i < n && j > i && j < n && Math.abs(v) > 1e-10) {
          this.covarianceMatrix[i * n + j] = v;
          this.covarianceMatrix[j * n + i] = v;
          this.activeCrossI[cCount] = i;
          this.activeCrossJ[cCount] = j;
          this.activeCrossValues[cCount] = v;
          cCount++;
        }
      }
      this.activeCrossCount = cCount;
    } else if (snapshot.covarianceMatrix) {
      // Legacy dense matrix snapshot support
      const covLen = Math.min(this.covarianceMatrix.length, snapshot.covarianceMatrix.length);
      for (let i = 0; i < covLen; i++) {
        this.covarianceMatrix[i] = snapshot.covarianceMatrix[i];
      }
      this.rebuildSparseCovarianceIndex();
    }
    this.fastGridDirty = true;
  }

  /**
   * Selects the optimal adaptive quadrant resolution tier based on active modal order & energy sparsity.
   */
  private chooseAdaptiveTierIndex(): number {
    if (this.forcedHalfN !== null) {
      const idx = ModalBank.TIER_HALF_NS.indexOf(this.forcedHalfN as 33 | 65 | 129 | 193);
      return idx >= 0 ? idx : 1;
    }

    let maxDiag = 0;
    let totalDiag = 0;
    const dCount = this.activeDiagCount;
    for (let k = 0; k < dCount; k++) {
      const v = this.activeDiagValues[k];
      totalDiag += v;
      if (v > maxDiag) maxDiag = v;
    }

    // Ignore negligible <1% RMS modes (variance < 1e-4 * maxDiag) when selecting adaptive grid resolution
    const threshold = maxDiag * 1e-4;
    let maxOrder = 1;
    let highOrderEnergy = 0;

    for (let k = 0; k < dCount; k++) {
      const v = this.activeDiagValues[k];
      if (v < threshold) continue;
      const mode = this.modes[this.activeDiagIndices[k]];
      const order = Math.max(mode.m, mode.n);
      if (order > maxOrder) maxOrder = order;
      if (order > 13) highOrderEnergy += v;
    }

    for (let k = 0; k < this.activeCrossCount; k++) {
      if (Math.abs(this.activeCrossValues[k]) < threshold) continue;
      const mi = this.modes[this.activeCrossI[k]];
      const mj = this.modes[this.activeCrossJ[k]];
      const order = Math.max(mi.m, mi.n, mj.m, mj.n);
      if (order > maxOrder) maxOrder = order;
    }

    if (maxOrder <= 5) return 1; // 65x65 quadrant (129x129 full plate)
    if (maxOrder <= 13) return 2; // 129x129 quadrant (257x257 full plate)

    const highOrderShare = totalDiag > 0 ? highOrderEnergy / totalDiag : 0;
    if (dCount <= 48 || this.activeCrossCount <= 48 || highOrderShare >= 0.12) {
      return 3; // 193x193 quadrant (385x385 full plate -> <=1.52% L2 error at (27,3))
    }
    return 2; // Dense low-dominated broadband noise uses 257x257 plate
  }

  /**
   * Optional override used strictly for benchmark comparisons (null = adaptive mode-order tiering).
   */
  setForcedHalfN(halfN: number | null): void {
    this.forcedHalfN = halfN;
    this.fastGridDirty = true;
  }

  getFastGridTelemetry(): {
    quadrantHalfN: number;
    effectivePlateResolution: number;
    lastRebuildDurationMs: number;
    activeDiagCount: number;
    activeCrossCount: number;
  } {
    return {
      quadrantHalfN: this.activeFastHalfN,
      effectivePlateResolution: this.activeFastHalfN * 2 - 1,
      lastRebuildDurationMs: this.lastRebuildDurationMs,
      activeDiagCount: this.activeDiagCount,
      activeCrossCount: this.activeCrossCount,
    };
  }

  /**
   * Returns maximum RMS acceleration among modes above cutoffHz (used to verify >2.7 kHz excitation).
   */
  getMaxModeRmsAboveFrequency(cutoffHz: number): number {
    let maxVar = 0;
    const n = this.modes.length;
    for (let i = 0; i < n; i++) {
      if (this.modes[i].frequency > cutoffHz) {
        const d = this.covarianceMatrix[i * n + i];
        if (d > maxVar) maxVar = d;
      }
    }
    return Math.sqrt(Math.max(0, maxVar));
  }

  /**
   * Rebuilds the adaptive 4-fold symmetric quadrant RMS acceleration field cache
   * using exact product-to-sum 2D cosine folding (folds all 146 diagonals + up to 10,585 cross-terms
   * once into a 28x28 cosine matrix, reducing grid evaluation from ~6M scattered ops to <=1M linear ops).
   */
  private rebuildFastRmsGrid(): void {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.fastGridDirty = false;

    const tierIdx = this.chooseAdaptiveTierIndex();
    const halfN = ModalBank.TIER_HALF_NS[tierIdx];
    this.activeFastHalfN = halfN;

    const dCount = this.activeDiagCount;
    const cCount = this.activeCrossCount;
    const out = this.fastRmsQuadrant;

    if (dCount === 0 && cCount === 0) {
      out.fill(0, 0, halfN * halfN);
      this.lastRebuildDurationMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
      return;
    }

    if (!this.allOddOdd) {
      const halfL = this.geometry.sideLength * 0.5;
      for (let gy = 0; gy < halfN; gy++) {
        const y = (gy / (halfN - 1)) * halfL;
        for (let gx = 0; gx < halfN; gx++) {
          const x = (gx / (halfN - 1)) * halfL;
          out[gy * halfN + gx] = this.evaluateRmsAcceleration(x, y);
        }
      }
      this.lastRebuildDurationMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
      return;
    }

    const mHalf = this.mHalfIdx;
    const nHalf = this.nHalfIdx;

    // Ultra-fast zero-subtraction path when a single isolated mode is active
    if (dCount === 1 && cCount === 0) {
      const d0 = this.activeDiagValues[0];
      if (d0 <= 0) {
        out.fill(0, 0, halfN * halfN);
      } else {
        const idx0 = this.activeDiagIndices[0];
        const sinCols = this.tierSinCols[tierIdx];
        const sx = sinCols[mHalf[idx0]];
        const sy = sinCols[nHalf[idx0]];
        const amp = Math.sqrt(d0);
        for (let gy = 0; gy < halfN; gy++) {
          const ay = amp * Math.abs(sy[gy]);
          const outRow = gy * halfN;
          for (let gx = 0; gx < halfN; gx++) {
            out[outRow + gx] = ay * Math.abs(sx[gx]);
          }
        }
      }
      this.lastRebuildDurationMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
      return;
    }

    // Fold all active diagonals & cross-terms once into 28x28 cos2D[kx, ky]
    const cosStride = this.cosStride;
    const cos2D = this.cos2D;
    cos2D.fill(0);

    let maxDiag = 0;
    const diagIdx = this.activeDiagIndices;
    const diagVal = this.activeDiagValues;
    for (let k = 0; k < dCount; k++) {
      const v = diagVal[k];
      if (v > maxDiag) maxDiag = v;
      const w = 0.25 * v;
      const idx = diagIdx[k];
      const kx2 = mHalf[idx] * 2 + 1; // kx1 = 0
      const ky2 = nHalf[idx] * 2 + 1; // ky1 = 0
      cos2D[0] += w;
      cos2D[ky2] -= w;
      cos2D[kx2 * cosStride] -= w;
      cos2D[kx2 * cosStride + ky2] += w;
    }

    const crossI = this.activeCrossI;
    const crossJ = this.activeCrossJ;
    const crossVal = this.activeCrossValues;
    for (let k = 0; k < cCount; k++) {
      const cv = crossVal[k];
      if (cv === 0) continue;
      // W = 2 * cv => 0.25 * W = 0.5 * cv
      const w = 0.5 * cv;
      const ci = crossI[k];
      const cj = crossJ[k];
      const ax = mHalf[ci];
      const bx = mHalf[cj];
      const ay = nHalf[ci];
      const by = nHalf[cj];
      const kx1 = ax >= bx ? ax - bx : bx - ax;
      const kx2 = ax + bx + 1;
      const ky1 = ay >= by ? ay - by : by - ay;
      const ky2 = ay + by + 1;
      const r1 = kx1 * cosStride;
      const r2 = kx2 * cosStride;
      cos2D[r1 + ky1] += w;
      cos2D[r1 + ky2] -= w;
      cos2D[r2 + ky1] -= w;
      cos2D[r2 + ky2] += w;
    }

    // Compress non-zero entries of cos2D by row kx
    const cosCols = this.tierCosCols[tierIdx];
    const activeKx = this.activeKxList;
    const nzStart = this.nzStart;
    const nzKy = this.nzKy;
    const nzVal = this.nzVal;
    const entryTol = Math.max(1e-22, maxDiag * 1e-13);

    let numActiveKx = 0;
    let nzPtr = 0;
    for (let kx = 0; kx < cosStride; kx++) {
      const rOff = kx * cosStride;
      const startPtr = nzPtr;
      for (let ky = 0; ky < cosStride; ky++) {
        const v = cos2D[rOff + ky];
        if (v > entryTol || v < -entryTol) {
          nzKy[nzPtr] = ky;
          nzVal[nzPtr] = v;
          nzPtr++;
        }
      }
      if (nzPtr > startPtr) {
        activeKx[numActiveKx] = kx;
        nzStart[numActiveKx] = startPtr;
        numActiveKx++;
      }
    }
    nzStart[numActiveKx] = nzPtr;

    if (numActiveKx === 0) {
      out.fill(0, 0, halfN * halfN);
      this.lastRebuildDurationMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
      return;
    }

    // Separable evaluation: for each row gy, contract along ky into rowCosWeights[aKx], then sum along gx
    const rowWeights = this.rowCosWeights;
    const rowSq = this.rowRmsSq;
    const rowTol = Math.max(1e-22, maxDiag * 1e-12);
    const hasKx0 = activeKx[0] === 0;

    for (let gy = 0; gy < halfN; gy++) {
      for (let a = 0; a < numActiveKx; a++) {
        const pStart = nzStart[a];
        const pEnd = nzStart[a + 1];
        let acc = 0;
        for (let p = pStart; p < pEnd; p++) {
          acc += nzVal[p] * cosCols[nzKy[p]][gy];
        }
        rowWeights[a] = acc;
      }

      if (hasKx0) {
        rowSq.fill(rowWeights[0], 0, halfN);
      } else {
        rowSq.fill(0, 0, halfN);
      }

      const startA = hasKx0 ? 1 : 0;
      for (let a = startA; a < numActiveKx; a++) {
        const c = rowWeights[a];
        if (c > rowTol || c < -rowTol) {
          const col = cosCols[activeKx[a]];
          for (let gx = 0; gx < halfN; gx++) {
            rowSq[gx] += c * col[gx];
          }
        }
      }

      const outRow = gy * halfN;
      for (let gx = 0; gx < halfN; gx++) {
        const sq = rowSq[gx];
        out[outRow + gx] = sq > 0 ? Math.sqrt(sq) : 0;
      }
    }

    this.lastRebuildDurationMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  }

  /**
   * Ensures the adaptive quadrant RMS grid is up-to-date and returns raw buffer access
   * for zero-overhead inline particle micro-stepping.
   */
  getFastRmsGridData(): { quadrant: Float64Array; halfN: number; hasEnergy: boolean } {
    const hasEnergy = this.activeDiagCount > 0 || this.activeCrossCount > 0;
    if (hasEnergy && this.allOddOdd && this.fastGridDirty) {
      this.rebuildFastRmsGrid();
    }
    return {
      quadrant: this.fastRmsQuadrant,
      halfN: this.activeFastHalfN,
      hasEnergy,
    };
  }

  /**
   * High-speed bilinear lookup of the spatial RMS acceleration field a_rms(x, y) [m/s^2]
   * over the adaptive mode-order quadrant grid. Falls back to exact evaluation if non-odd modes exist.
   */
  sampleRmsFieldFast(x: number, y: number): number {
    if (this.activeDiagCount === 0 && this.activeCrossCount === 0) {
      return 0.0;
    }
    if (!this.allOddOdd) {
      return this.evaluateRmsAcceleration(x, y);
    }
    if (this.fastGridDirty) {
      this.rebuildFastRmsGrid();
    }

    const L = this.geometry.sideLength;
    if (x <= 0 || x >= L || y <= 0 || y >= L) {
      return 0.0;
    }

    const halfL = L * 0.5;
    const fxCoord = x > halfL ? L - x : x;
    const fyCoord = y > halfL ? L - y : y;

    const halfN = this.activeFastHalfN;
    const maxIdx = halfN - 1;
    const u = (fxCoord / halfL) * maxIdx;
    const v = (fyCoord / halfL) * maxIdx;

    const gx0 = Math.min(maxIdx - 1, Math.max(0, Math.floor(u)));
    const gy0 = Math.min(maxIdx - 1, Math.max(0, Math.floor(v)));
    const tx = u - gx0;
    const ty = v - gy0;

    const row0 = gy0 * halfN;
    const row1 = (gy0 + 1) * halfN;
    const q = this.fastRmsQuadrant;

    const a00 = q[row0 + gx0];
    const a10 = q[row0 + gx0 + 1];
    const a01 = q[row1 + gx0];
    const a11 = q[row1 + gx0 + 1];

    const top = a00 + (a10 - a00) * tx;
    const bot = a01 + (a11 - a01) * tx;
    return top + (bot - top) * ty;
  }

  /**
   * Evaluates spatial RMS acceleration field a_rms(x, y) [m/s^2]:
   * a_rms^2(x, y) = sum_i R_ii * phi_i(x, y)^2 + 2 * sum_{i < j} R_ij * phi_i(x, y) * phi_j(x, y)
   */
  evaluateRmsAcceleration(x: number, y: number): number {
    if (this.activeDiagCount === 0 && this.activeCrossCount === 0) {
      return 0.0;
    }

    const L = this.geometry.sideLength;
    if (x <= 0 || x >= L || y <= 0 || y >= L) {
      return 0.0;
    }

    const phis = this.phisCache;

    if (this.allOddOdd) {
      // Fast exact Chebyshev recurrence for odd harmonics sin((2k+1)*theta)
      const numOdd = this.maxOddHalfIdx;
      const sinX = this.sinXCache;
      const sinY = this.sinYCache;

      const tx = (Math.PI * x) / L;
      const s1x = Math.sin(tx);
      const c2x = 2.0 * Math.cos(2.0 * tx);
      sinX[0] = s1x;
      if (numOdd > 1) sinX[1] = c2x * s1x + s1x;
      for (let k = 2; k < numOdd; k++) {
        sinX[k] = c2x * sinX[k - 1] - sinX[k - 2];
      }

      const ty = (Math.PI * y) / L;
      const s1y = Math.sin(ty);
      const c2y = 2.0 * Math.cos(2.0 * ty);
      sinY[0] = s1y;
      if (numOdd > 1) sinY[1] = c2y * s1y + s1y;
      for (let k = 2; k < numOdd; k++) {
        sinY[k] = c2y * sinY[k - 1] - sinY[k - 2];
      }

      let sumRmsSq = 0;
      const dCount = this.activeDiagCount;
      const mHalf = this.mHalfIdx;
      const nHalf = this.nHalfIdx;

      if (this.activeCrossCount === 0) {
        for (let k = 0; k < dCount; k++) {
          const idx = this.activeDiagIndices[k];
          const phi = sinX[mHalf[idx]] * sinY[nHalf[idx]];
          sumRmsSq += this.activeDiagValues[k] * phi * phi;
        }
        return Math.sqrt(Math.max(0, sumRmsSq));
      }

      const n = this.modes.length;
      for (let i = 0; i < n; i++) {
        phis[i] = sinX[mHalf[i]] * sinY[nHalf[i]];
      }
      for (let k = 0; k < dCount; k++) {
        const idx = this.activeDiagIndices[k];
        const phi = phis[idx];
        sumRmsSq += this.activeDiagValues[k] * phi * phi;
      }
      const cCount = this.activeCrossCount;
      for (let k = 0; k < cCount; k++) {
        sumRmsSq += 2.0 * this.activeCrossValues[k] * phis[this.activeCrossI[k]] * phis[this.activeCrossJ[k]];
      }
      return Math.sqrt(Math.max(0, sumRmsSq));
    }

    // General mode fallback (used by unit tests with even modes)
    const n = this.modes.length;
    for (let i = 0; i < n; i++) {
      phis[i] = modeShape(this.modes[i].m, this.modes[i].n, x, y, L);
    }

    let sumRmsSq = 0;
    for (let k = 0; k < this.activeDiagCount; k++) {
      const idx = this.activeDiagIndices[k];
      const phi = phis[idx];
      sumRmsSq += this.activeDiagValues[k] * phi * phi;
    }
    for (let k = 0; k < this.activeCrossCount; k++) {
      sumRmsSq += 2.0 * this.activeCrossValues[k] * phis[this.activeCrossI[k]] * phis[this.activeCrossJ[k]];
    }

    return Math.sqrt(Math.max(0, sumRmsSq));
  }

  /**
   * Evaluates instantaneous deflection w(x, y, t) [m]
   */
  evaluateDisplacement(x: number, y: number): number {
    let w = 0;
    const L = this.geometry.sideLength;
    for (let i = 0; i < this.modes.length; i++) {
      const mode = this.modes[i];
      if (mode.active) {
        w += mode.displacement * modeShape(mode.m, mode.n, x, y, L);
      }
    }
    return w;
  }
}
