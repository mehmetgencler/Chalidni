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

  // 4-fold symmetric 33x33 quadrant (65x65 plate resolution) RMS field cache for 3000-particle stepping
  private readonly fastHalfN: number = 33; // indices 0..32 cover [0, L/2]
  private fastSinTable: Float64Array;
  private fastRmsQuadrant: Float64Array;
  private fastGridDirty: boolean = true;

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

    // Precompute 1D odd-harmonic sine table over [0, L/2] for 4-fold symmetric fast RMS grid
    const halfN = this.fastHalfN;
    const stride = this.maxOddHalfIdx;
    this.fastSinTable = new Float64Array(halfN * stride);
    this.fastRmsQuadrant = new Float64Array(halfN * halfN);
    const L = geometry.sideLength;
    for (let g = 0; g < halfN; g++) {
      const coord = (g / (halfN - 1)) * (L * 0.5);
      for (let k = 0; k < stride; k++) {
        const harmonic = 2 * k + 1;
        this.fastSinTable[g * stride + k] = Math.sin((harmonic * Math.PI * coord) / L);
      }
    }

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
   * Rebuilds the 33x33 quadrant (65x65 full-plate) symmetric RMS acceleration field cache.
   */
  private rebuildFastRmsGrid(): void {
    this.fastGridDirty = false;
    if (this.activeDiagCount === 0 && this.activeCrossCount === 0) {
      this.fastRmsQuadrant.fill(0);
      return;
    }

    if (!this.allOddOdd) {
      const halfN = this.fastHalfN;
      const halfL = this.geometry.sideLength * 0.5;
      for (let gy = 0; gy < halfN; gy++) {
        const y = (gy / (halfN - 1)) * halfL;
        for (let gx = 0; gx < halfN; gx++) {
          const x = (gx / (halfN - 1)) * halfL;
          this.fastRmsQuadrant[gy * halfN + gx] = this.evaluateRmsAcceleration(x, y);
        }
      }
      return;
    }

    const halfN = this.fastHalfN;
    const stride = this.maxOddHalfIdx;
    const sinTab = this.fastSinTable;
    const phis = this.phisCache;
    const mHalf = this.mHalfIdx;
    const nHalf = this.nHalfIdx;
    const dCount = this.activeDiagCount;
    const cCount = this.activeCrossCount;

    for (let gy = 0; gy < halfN; gy++) {
      const yOff = gy * stride;
      for (let gx = 0; gx < halfN; gx++) {
        const xOff = gx * stride;
        let sumRmsSq = 0;

        if (cCount > 0) {
          for (let i = 0; i < this.modes.length; i++) {
            phis[i] = sinTab[xOff + mHalf[i]] * sinTab[yOff + nHalf[i]];
          }
          for (let k = 0; k < dCount; k++) {
            const idx = this.activeDiagIndices[k];
            const phi = phis[idx];
            sumRmsSq += this.activeDiagValues[k] * phi * phi;
          }
          for (let k = 0; k < cCount; k++) {
            sumRmsSq += 2.0 * this.activeCrossValues[k] * phis[this.activeCrossI[k]] * phis[this.activeCrossJ[k]];
          }
        } else {
          for (let k = 0; k < dCount; k++) {
            const idx = this.activeDiagIndices[k];
            const phi = sinTab[xOff + mHalf[idx]] * sinTab[yOff + nHalf[idx]];
            sumRmsSq += this.activeDiagValues[k] * phi * phi;
          }
        }

        this.fastRmsQuadrant[gy * halfN + gx] = Math.sqrt(Math.max(0, sumRmsSq));
      }
    }
  }

  /**
   * High-speed bilinear lookup of the spatial RMS acceleration field a_rms(x, y) [m/s^2]
   * using 4-fold odd-mode plate symmetry. Runs in O(1) (~15 ns) per particle micro-step.
   */
  sampleRmsFieldFast(x: number, y: number): number {
    if (this.activeDiagCount === 0 && this.activeCrossCount === 0) {
      return 0.0;
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

    const halfN = this.fastHalfN;
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
