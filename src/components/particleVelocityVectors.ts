/**
 * Visual-only Momentum Velocity Vector Renderer
 *
 * Draws short, fading, color-matched momentum wakes directly behind actively
 * moving particles onto PlateCanvas's RGBA frame buffer to visualize live
 * granular transport flux without mutating physics state or adding GC overhead.
 */

import { Particle, ParticleColor } from '../physics/types.ts';

export const VELOCITY_VECTOR_MIN_SPEED_MPS = 0.015;
export const VELOCITY_VECTOR_PX_PER_MPS = 26.0;
export const VELOCITY_VECTOR_MAX_LEN_PX = 14.0;
export const VELOCITY_VECTOR_PEAK_ALPHA = 0.56;

const VECTOR_COLOR_RGB: Record<ParticleColor, readonly [number, number, number]> = {
  green: [110, 231, 183],
  blue: [125, 211, 252],
  red: [253, 164, 175],
};

export interface ParticleVelocityVectorSpec {
  active: boolean;
  speedMps: number;
  lenPx: number;
  tailDirX: number;
  tailDirY: number;
}

/**
 * Computes the trailing vector direction (opposite to momentum (vx, vy), i.e., behind the grain)
 * and clamped visual length in backing-store pixels.
 */
export function computeParticleVelocityVector(
  vx: number,
  vy: number,
  dpr: number
): ParticleVelocityVectorSpec {
  if (!Number.isFinite(vx) || !Number.isFinite(vy)) {
    return { active: false, speedMps: 0, lenPx: 0, tailDirX: 0, tailDirY: 0 };
  }
  const speedSq = vx * vx + vy * vy;
  if (speedSq < VELOCITY_VECTOR_MIN_SPEED_MPS * VELOCITY_VECTOR_MIN_SPEED_MPS) {
    return { active: false, speedMps: Math.sqrt(speedSq), lenPx: 0, tailDirX: 0, tailDirY: 0 };
  }

  const speed = Math.sqrt(speedSq);
  const safeDpr = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const maxLen = VELOCITY_VECTOR_MAX_LEN_PX * safeDpr;
  const rawLen = speed * VELOCITY_VECTOR_PX_PER_MPS * safeDpr;
  const lenPx = rawLen < maxLen ? rawLen : maxLen;
  if (lenPx < 1.0) {
    return { active: false, speedMps: speed, lenPx: 0, tailDirX: 0, tailDirY: 0 };
  }

  const invSpeed = 1 / speed;
  return {
    active: true,
    speedMps: speed,
    lenPx,
    tailDirX: -vx * invSpeed,
    tailDirY: -vy * invSpeed,
  };
}

/**
 * Draws short, fading momentum velocity vectors strictly behind each active moving particle
 * using zero-allocation Xiaolin Wu major-axis anti-aliased rasterization.
 */
export function drawParticleVelocityVectorsToFrame(
  frame: Uint8ClampedArray,
  targetPx: number,
  dpr: number,
  particles: readonly Particle[],
  sideLength: number
): number {
  if (targetPx <= 0 || !Number.isFinite(sideLength) || sideLength <= 0 || particles.length === 0) {
    return 0;
  }

  const safeDpr = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const scalePx = targetPx / sideLength;
  const minSpeedSq = VELOCITY_VECTOR_MIN_SPEED_MPS * VELOCITY_VECTOR_MIN_SPEED_MPS;
  const pxPerMps = VELOCITY_VECTOR_PX_PER_MPS * safeDpr;
  const maxLenPx = VELOCITY_VECTOR_MAX_LEN_PX * safeDpr;
  const maxLimit = targetPx - 1;
  let drawnCount = 0;

  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    if (!p.active) continue;

    const vx = p.vx;
    const vy = p.vy;
    if (!Number.isFinite(vx) || !Number.isFinite(vy)) continue;

    const speedSq = vx * vx + vy * vy;
    if (speedSq < minSpeedSq) continue;

    const speed = Math.sqrt(speedSq);
    const rawLen = speed * pxPerMps;
    const lenPx = rawLen < maxLenPx ? rawLen : maxLenPx;
    if (lenPx < 1.0) continue;

    const hx = p.x * scalePx;
    const hy = p.y * scalePx;
    if (!Number.isFinite(hx) || !Number.isFinite(hy)) continue;

    const invSpeed = 1 / speed;
    const tx = hx - vx * invSpeed * lenPx;
    const ty = hy - vy * invSpeed * lenPx;

    const dx = tx - hx;
    const dy = ty - hy;
    const absDx = dx < 0 ? -dx : dx;
    const absDy = dy < 0 ? -dy : dy;
    const steps = Math.ceil(absDx > absDy ? absDx : absDy);
    if (steps <= 0) continue;

    const color = p.color === 'blue' ? VECTOR_COLOR_RGB.blue : p.color === 'red' ? VECTOR_COLOR_RGB.red : VECTOR_COLOR_RGB.green;
    const colR = color[0];
    const colG = color[1];
    const colB = color[2];
    const bFactor = p.brightness !== undefined && Number.isFinite(p.brightness) ? Math.min(1.18, Math.max(0.75, p.brightness)) : 1.0;
    const headAlpha = Math.min(0.72, VELOCITY_VECTOR_PEAK_ALPHA * bFactor * Math.min(1, lenPx / (4.5 * safeDpr)));

    const invSteps = 1 / steps;
    drawnCount++;

    if (absDx >= absDy) {
      const stepX = dx * invSteps;
      const stepY = dy * invSteps;
      for (let s = 0; s <= steps; s++) {
        const u = s * invSteps;
        const fade = (1 - u);
        const segAlpha = headAlpha * fade * Math.sqrt(fade);
        if (segAlpha <= 0.01) continue;

        const px = Math.round(hx + stepX * s);
        if (px < 0 || px > maxLimit) continue;

        const fy = hy + stepY * s;
        const iy = Math.floor(fy);
        const fracY = fy - iy;

        if (iy >= 0 && iy <= maxLimit) {
          const a0 = segAlpha * (1 - fracY);
          const invA0 = 1 - a0;
          const d0 = (iy * targetPx + px) * 4;
          frame[d0] = colR * a0 + frame[d0] * invA0;
          frame[d0 + 1] = colG * a0 + frame[d0 + 1] * invA0;
          frame[d0 + 2] = colB * a0 + frame[d0 + 2] * invA0;
        }
        const iy1 = iy + 1;
        if (fracY > 0.02 && iy1 >= 0 && iy1 <= maxLimit) {
          const a1 = segAlpha * fracY;
          const invA1 = 1 - a1;
          const d1 = (iy1 * targetPx + px) * 4;
          frame[d1] = colR * a1 + frame[d1] * invA1;
          frame[d1 + 1] = colG * a1 + frame[d1 + 1] * invA1;
          frame[d1 + 2] = colB * a1 + frame[d1 + 2] * invA1;
        }
      }
    } else {
      const stepX = dx * invSteps;
      const stepY = dy * invSteps;
      for (let s = 0; s <= steps; s++) {
        const u = s * invSteps;
        const fade = (1 - u);
        const segAlpha = headAlpha * fade * Math.sqrt(fade);
        if (segAlpha <= 0.01) continue;

        const py = Math.round(hy + stepY * s);
        if (py < 0 || py > maxLimit) continue;

        const fx = hx + stepX * s;
        const ix = Math.floor(fx);
        const fracX = fx - ix;
        const rowOff = py * targetPx;

        if (ix >= 0 && ix <= maxLimit) {
          const a0 = segAlpha * (1 - fracX);
          const invA0 = 1 - a0;
          const d0 = (rowOff + ix) * 4;
          frame[d0] = colR * a0 + frame[d0] * invA0;
          frame[d0 + 1] = colG * a0 + frame[d0 + 1] * invA0;
          frame[d0 + 2] = colB * a0 + frame[d0 + 2] * invA0;
        }
        const ix1 = ix + 1;
        if (fracX > 0.02 && ix1 >= 0 && ix1 <= maxLimit) {
          const a1 = segAlpha * fracX;
          const invA1 = 1 - a1;
          const d1 = (rowOff + ix1) * 4;
          frame[d1] = colR * a1 + frame[d1] * invA1;
          frame[d1 + 1] = colG * a1 + frame[d1 + 1] * invA1;
          frame[d1 + 2] = colB * a1 + frame[d1 + 2] * invA1;
        }
      }
    }
  }

  return drawnCount;
}
