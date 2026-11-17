/**
 * Theoretical Chladni Nodal Wireframe Calculator & Persistent Overlay Cache
 *
 * Computes analytical zero-displacement/acceleration nodal contours:
 *   Phi(x, y) = sum_k weight_k * sin(m_k * pi * x) * sin(n_k * pi * y) = 0
 * across all degenerate center-coupled eigenmodes sharing the currently
 * dominant resonant frequency cluster, extracts smooth sub-pixel segments via
 * Marching Squares with bilinear saddle disambiguation, and caches an
 * anti-aliased light-blue wireframe mask per mode cluster and plate size.
 */

import type { DominantModalInfo, DominantModeEntry } from '../physics/modalSolver.ts';

export const NODAL_WIREFRAME_GRID_RES = 144;
export const NODAL_WIREFRAME_COLOR_RGB: readonly [number, number, number] = [125, 211, 252];
export const NODAL_WIREFRAME_ALPHA = 0.28;
export const NODAL_WIREFRAME_MIN_RMS = 1.0;

const PLATE_INSET_EPS = 1e-4;

/**
 * Evaluates the analytical normalized eigenmode superposition at (normX, normY) in [0, 1]^2.
 */
export function evaluateModalSuperpositionField(
  components: readonly DominantModeEntry[],
  componentCount: number,
  normX: number,
  normY: number
): number {
  if (componentCount <= 0 || normX <= 0 || normX >= 1 || normY <= 0 || normY >= 1) {
    return 0;
  }
  const px = Math.PI * normX;
  const py = Math.PI * normY;
  let sum = 0;
  for (let i = 0; i < componentCount; i++) {
    const c = components[i];
    sum += c.weight * Math.sin(c.m * px) * Math.sin(c.n * py);
  }
  return sum;
}

export function buildDominantClusterSignature(
  components: readonly DominantModeEntry[],
  count: number
): string {
  if (count <= 0) return '';
  if (count === 1) {
    const c = components[0];
    return `${c.m},${c.n}:${c.weight >= 0 ? 1 : -1}`;
  }
  const parts: string[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const c = components[i];
    parts[i] = `${c.m},${c.n}:${c.weight >= 0 ? 1 : -1}`;
  }
  parts.sort();
  return parts.join('|');
}

export function formatDominantModeLabel(
  components: readonly DominantModeEntry[],
  count: number
): string {
  if (count <= 0) return '';
  const items: string[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const c = components[i];
    items[i] = `(${c.m},${c.n})`;
  }
  items.sort();
  return items.join('+');
}

function interpEdge(v0: number, v1: number): number {
  const denom = v0 - v1;
  if (Math.abs(denom) < 1e-12) return 0.5;
  const t = v0 / denom;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * Extracts zero-contour wireframe segments [x0, y0, x1, y1, ...] in normalized [0, 1]^2
 * plate coordinates using Marching Squares with bilinear saddle asymptote resolution so
 * both closed Chladni curves (e.g. 269.8 Hz circle) and orthogonal nodal grid intersections
 * (e.g. 485.7 Hz (3,3) crosshairs) are extracted cleanly without rounding artifacts.
 */
export function computeTheoreticalNodalSegments(
  components: readonly DominantModeEntry[],
  componentCount: number = components.length,
  gridRes: number = NODAL_WIREFRAME_GRID_RES
): Float32Array {
  if (componentCount <= 0 || gridRes < 4) {
    return new Float32Array(0);
  }

  const res = Math.floor(gridRes);
  const sinX = new Float64Array(componentCount * res);
  const sinY = new Float64Array(componentCount * res);
  const weights = new Float64Array(componentCount);
  const minCoord = PLATE_INSET_EPS;
  const span = 1 - 2 * PLATE_INSET_EPS;
  const step = span / (res - 1);

  for (let k = 0; k < componentCount; k++) {
    const comp = components[k];
    weights[k] = comp.weight;
    const kx = comp.m * Math.PI;
    const ky = comp.n * Math.PI;
    const base = k * res;
    for (let g = 0; g < res; g++) {
      const coord = minCoord + g * step;
      sinX[base + g] = Math.sin(kx * coord);
      sinY[base + g] = Math.sin(ky * coord);
    }
  }

  const field = new Float32Array(res * res);
  let maxAbs = 0;

  if (componentCount === 1) {
    const w0 = weights[0];
    for (let gy = 0; gy < res; gy++) {
      const wy = w0 * sinY[gy];
      const row = gy * res;
      for (let gx = 0; gx < res; gx++) {
        const val = wy * sinX[gx];
        field[row + gx] = val;
        const av = val < 0 ? -val : val;
        if (av > maxAbs) maxAbs = av;
      }
    }
  } else {
    for (let gy = 0; gy < res; gy++) {
      const row = gy * res;
      for (let gx = 0; gx < res; gx++) {
        let val = 0;
        for (let k = 0; k < componentCount; k++) {
          const base = k * res;
          val += weights[k] * sinX[base + gx] * sinY[base + gy];
        }
        field[row + gx] = val;
        const av = val < 0 ? -val : val;
        if (av > maxAbs) maxAbs = av;
      }
    }
  }

  if (maxAbs <= 1e-10) {
    return new Float32Array(0);
  }

  // Nudge exact grid zeros infinitesimally so boundary/axis lines never produce degenerate double loops
  const zeroEps = maxAbs * 1e-7;
  for (let i = 0; i < field.length; i++) {
    const v = field[i];
    if (v >= -zeroEps && v <= zeroEps) {
      field[i] = v >= 0 ? zeroEps : -zeroEps;
    }
  }

  const out: number[] = [];
  const pushSeg = (ax: number, ay: number, bx: number, by: number) => {
    const dx = bx - ax;
    const dy = by - ay;
    if (dx * dx + dy * dy <= 1e-12) return;
    out.push(ax, ay, bx, by);
  };

  for (let gy = 0; gy < res - 1; gy++) {
    const y0 = minCoord + gy * step;
    const row0 = gy * res;
    const row1 = row0 + res;

    for (let gx = 0; gx < res - 1; gx++) {
      const f00 = field[row0 + gx];     // Top-Left
      const f10 = field[row0 + gx + 1]; // Top-Right
      const f11 = field[row1 + gx + 1]; // Bottom-Right
      const f01 = field[row1 + gx];     // Bottom-Left

      const idx =
        (f00 > 0 ? 8 : 0) |
        (f10 > 0 ? 4 : 0) |
        (f11 > 0 ? 2 : 0) |
        (f01 > 0 ? 1 : 0);

      if (idx === 0 || idx === 15) continue;

      const x0 = minCoord + gx * step;

      // Edge intersection points (Top=0, Right=1, Bottom=2, Left=3)
      const tx = () => x0 + interpEdge(f00, f10) * step;
      const rx = x0 + step;
      const ry = () => y0 + interpEdge(f10, f11) * step;
      const bx = () => x0 + interpEdge(f01, f11) * step;
      const by = y0 + step;
      const lx = x0;
      const ly = () => y0 + interpEdge(f00, f01) * step;

      switch (idx) {
        case 1:
        case 14:
          pushSeg(lx, ly(), bx(), by);
          break;
        case 2:
        case 13:
          pushSeg(bx(), by, rx, ry());
          break;
        case 3:
        case 12:
          pushSeg(lx, ly(), rx, ry());
          break;
        case 4:
        case 11:
          pushSeg(tx(), y0, rx, ry());
          break;
        case 6:
        case 9:
          pushSeg(tx(), y0, bx(), by);
          break;
        case 7:
        case 8:
          pushSeg(lx, ly(), tx(), y0);
          break;
        case 5:
        case 10: {
          // Bilinear saddle asymptote test:
          // f(u,v) = f00 + a*u + b*v + c*u*v; saddle f_s = f00 - (a*b)/c
          const a = f10 - f00;
          const b = f01 - f00;
          const c = f11 - f10 - f01 + f00;
          const localScale = Math.max(
            zeroEps,
            Math.abs(f00),
            Math.abs(f10),
            Math.abs(f01),
            Math.abs(f11)
          );

          if (Math.abs(c) > 1e-12) {
            const us = -b / c;
            const vs = -a / c;
            const fSaddle = f00 - (a * b) / c;
            if (
              Math.abs(fSaddle) <= 0.025 * localScale &&
              us >= -0.2 &&
              us <= 1.2 &&
              vs >= -0.2 &&
              vs <= 1.2
            ) {
              // Exact nodal crossing: draw clean intersecting cross lines
              pushSeg(tx(), y0, bx(), by);
              pushSeg(lx, ly(), rx, ry());
              break;
            }
            if ((fSaddle > 0) === (f00 > 0)) {
              // Diagonal 00-11 connected
              pushSeg(tx(), y0, rx, ry());
              pushSeg(lx, ly(), bx(), by);
            } else {
              // Diagonal 10-01 connected
              pushSeg(lx, ly(), tx(), y0);
              pushSeg(bx(), by, rx, ry());
            }
          } else {
            pushSeg(tx(), y0, bx(), by);
            pushSeg(lx, ly(), rx, ry());
          }
          break;
        }
      }
    }
  }

  return new Float32Array(out);
}

/**
 * Rasterizes normalized contour segments [x0, y0, x1, y1, ...] into a reusable
 * pixel coverage mask [0..255] scaled cleanly by baseAlpha using max-compositing
 * so overlapping endpoints and intersections never brighten unevenly.
 */
export function rasterizeNodalWireframeMask(
  segments: Float32Array,
  targetPx: number,
  dpr: number,
  baseAlpha: number = NODAL_WIREFRAME_ALPHA
): Uint8Array {
  const len = targetPx * targetPx;
  const mask = new Uint8Array(len);
  if (segments.length < 4 || targetPx <= 0 || baseAlpha <= 0) {
    return mask;
  }

  const halfWidth = Math.max(0.85, 0.95 * dpr);
  const invHalfWidth = 1 / halfWidth;
  const pad = Math.ceil(halfWidth) + 1;
  const spanAxis = targetPx - 1;
  const peakAlphaByte = Math.min(255, Math.max(1, Math.round(baseAlpha * 255)));

  for (let s = 0; s + 3 < segments.length; s += 4) {
    const sx = segments[s] * spanAxis;
    const sy = segments[s + 1] * spanAxis;
    const ex = segments[s + 2] * spanAxis;
    const ey = segments[s + 3] * spanAxis;

    const dx = ex - sx;
    const dy = ey - sy;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-4) continue;

    const minY = Math.max(0, Math.floor(Math.min(sy, ey)) - pad);
    const maxY = Math.min(targetPx - 1, Math.ceil(Math.max(sy, ey)) + pad);
    const minX = Math.max(0, Math.floor(Math.min(sx, ex)) - pad);
    const maxX = Math.min(targetPx - 1, Math.ceil(Math.max(sx, ex)) + pad);

    for (let py = minY; py <= maxY; py++) {
      const rowOffset = py * targetPx;
      for (let px = minX; px <= maxX; px++) {
        let proj = ((px - sx) * dx + (py - sy) * dy) / lenSq;
        if (proj < 0) proj = 0;
        else if (proj > 1) proj = 1;

        const cx = sx + proj * dx;
        const cy = sy + proj * dy;
        const dist = Math.hypot(px - cx, py - cy);
        if (dist >= halfWidth) continue;

        const cov = 1 - dist * invHalfWidth;
        const alphaByte = Math.round(cov * peakAlphaByte);
        if (alphaByte > mask[rowOffset + px]) {
          mask[rowOffset + px] = alphaByte;
        }
      }
    }
  }

  return mask;
}

export interface NodalWireframeStatus {
  active: boolean;
  frequencyHz: number;
  modeLabel: string;
  segmentCount: number;
}

/**
 * Persistent frame-cached nodal wireframe renderer.
 * Latches the active dominant modal frequency cluster once peak RMS >= NODAL_WIREFRAME_MIN_RMS,
 * retains it persistently across stops/pauses until superseded by a new dominant frequency
 * or reset(), and composites the pre-rasterized mask onto PlateCanvas's RGBA frame buffer.
 */
export class NodalWireframeOverlayCache {
  private signature = '';
  private modeLabel = '';
  private frequencyHz = 0;
  private segmentCount = 0;
  private segments: Float32Array = new Float32Array(0);
  private maskTargetPx = 0;
  private maskDpr = 0;
  private mask: Uint8Array = new Uint8Array(0);

  reset(): void {
    this.signature = '';
    this.modeLabel = '';
    this.frequencyHz = 0;
    this.segmentCount = 0;
    this.segments = new Float32Array(0);
    this.mask = new Uint8Array(0);
    this.maskTargetPx = 0;
    this.maskDpr = 0;
  }

  getStatus(): NodalWireframeStatus {
    return {
      active: this.segmentCount > 0 && this.frequencyHz > 0,
      frequencyHz: this.frequencyHz,
      modeLabel: this.modeLabel,
      segmentCount: this.segmentCount,
    };
  }

  getMask(): Uint8Array {
    return this.mask;
  }

  update(modalInfo: DominantModalInfo | null | undefined, targetPx: number, dpr: number): NodalWireframeStatus {
    if (
      modalInfo &&
      !modalInfo.isSilent &&
      modalInfo.hasEnergy &&
      Number.isFinite(modalInfo.frequency) &&
      modalInfo.frequency > 0 &&
      modalInfo.peakRms >= NODAL_WIREFRAME_MIN_RMS &&
      modalInfo.dominantModes &&
      (modalInfo.dominantModeCount ?? modalInfo.dominantModes.length) > 0
    ) {
      const count = modalInfo.dominantModeCount ?? modalInfo.dominantModes.length;
      const nextSig = buildDominantClusterSignature(modalInfo.dominantModes, count);
      this.frequencyHz = modalInfo.frequency;

      if (nextSig !== this.signature) {
        this.signature = nextSig;
        this.modeLabel = formatDominantModeLabel(modalInfo.dominantModes, count);
        this.segments = computeTheoreticalNodalSegments(
          modalInfo.dominantModes,
          count,
          NODAL_WIREFRAME_GRID_RES
        );
        this.segmentCount = this.segments.length >> 2;
        this.maskTargetPx = 0; // Force mask rebuild at current canvas resolution
      }
    }

    if (
      this.signature !== '' &&
      this.segments.length >= 4 &&
      targetPx > 0 &&
      (this.maskTargetPx !== targetPx || this.maskDpr !== dpr)
    ) {
      this.maskTargetPx = targetPx;
      this.maskDpr = dpr;
      this.mask = rasterizeNodalWireframeMask(this.segments, targetPx, dpr, NODAL_WIREFRAME_ALPHA);
    }

    return this.getStatus();
  }

  compositeOntoFrame(frame: Uint8ClampedArray, targetPx: number): void {
    const mask = this.mask;
    const pixelCount = targetPx * targetPx;
    if (this.segmentCount <= 0 || mask.length < pixelCount || frame.length < pixelCount * 4) {
      return;
    }

    const r = NODAL_WIREFRAME_COLOR_RGB[0];
    const g = NODAL_WIREFRAME_COLOR_RGB[1];
    const b = NODAL_WIREFRAME_COLOR_RGB[2];
    const inv255 = 1 / 255;

    for (let i = 0; i < pixelCount; i++) {
      const aByte = mask[i];
      if (aByte === 0) continue;
      const a = aByte * inv255;
      const invA = 1 - a;
      const d = i * 4;
      frame[d] = r * a + frame[d] * invA;
      frame[d + 1] = g * a + frame[d + 1] * invA;
      frame[d + 2] = b * a + frame[d + 2] * invA;
    }
  }
}
