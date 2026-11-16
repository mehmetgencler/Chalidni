/**
 * Visual-only same-color sequential particle chain generator and rasterizer.
 *
 * Detects actively migrating particles via frame-to-frame visual displacement
 * (without altering physics or Particle[] state), partitions them into a
 * zero-allocation spatial hash by color, and builds short 3-5 hop sequential
 * ribbons that sweep forward from grain to grain during pattern transitions.
 */

import { Particle, ParticleColor } from '../physics/types.ts';

export const CHAIN_GRID_RES = 32;
export const CHAIN_MIN_HOPS = 3;
export const CHAIN_MAX_HOPS = 5;
export const CHAIN_MAX_VERTICES = CHAIN_MAX_HOPS + 1;
export const CHAIN_MAX_ACTIVE = 32;
export const CHAIN_DURATION_SEC = 0.42;
export const CHAIN_MIN_HOP_NORM = 0.010; // Min hop distance as fraction of plate sideLength
export const CHAIN_MAX_HOP_NORM = 0.062; // Max local hop distance (~18.6 mm)
export const CHAIN_MAX_LIVE_HOP_NORM = CHAIN_MAX_HOP_NORM * 1.45; // Guard against cross-plate stretching / rim recycling
export const CHAIN_MIN_ACTIVE_SPEED = 0.025; // Plate-widths/sec threshold for active migration

const COLOR_COUNT = 3; // 0: green, 1: blue, 2: red
const GRID_CELLS = CHAIN_GRID_RES * CHAIN_GRID_RES;

// Same-color luminous tints harmonized directly with GRAIN_COLOR_TIERS
export const CHAIN_COLOR_RGB: readonly [number, number, number][] = [
  [74, 222, 128], // green
  [96, 178, 252], // blue
  [248, 113, 113], // red
];

export interface ActiveParticleChain {
  active: boolean;
  colorIdx: number;
  hopCount: number; // 3..5 segments -> hopCount + 1 vertices
  ageSec: number;
  durationSec: number;
  peakAlpha: number;
  particleIndices: Int32Array;
  xs: Float32Array; // Normalized [0, 1] plate coordinates
  ys: Float32Array; // Normalized [0, 1] plate coordinates
}

export interface ChainSweepSpan {
  tailHop: number;
  headHop: number;
  envelopeAlpha: number;
}

/**
 * Evaluates the continuous progressive sweep window [tailHop, headHop] and
 * fade envelope for a multi-hop sequential chain at normalized age u in [0, 1].
 */
export function evaluateChainSweepSpan(
  ageSec: number,
  durationSec: number,
  hopCount: number
): ChainSweepSpan {
  if (
    !Number.isFinite(ageSec) ||
    !Number.isFinite(durationSec) ||
    durationSec <= 0 ||
    hopCount <= 0 ||
    ageSec < 0 ||
    ageSec >= durationSec
  ) {
    return { tailHop: 0, headHop: 0, envelopeAlpha: 0 };
  }

  const u = ageSec / durationSec;
  const headU = Math.min(1, u * 1.48);
  const tailU = u <= 0.16 ? 0 : Math.min(1, (u - 0.16) / 0.84);

  const headHop = headU * hopCount;
  const tailHop = Math.min(headHop, tailU * hopCount);

  let fadeIn = 1;
  if (u < 0.12) {
    const t = u / 0.12;
    fadeIn = t * t * (3 - 2 * t);
  }
  let fadeOut = 1;
  if (u > 0.62) {
    const t = Math.max(0, 1 - (u - 0.62) / 0.38);
    fadeOut = t * t * (3 - 2 * t);
  }

  return {
    tailHop,
    headHop,
    envelopeAlpha: fadeIn * fadeOut,
  };
}

function colorToIndex(color?: ParticleColor): number {
  return color === 'blue' ? 1 : color === 'red' ? 2 : 0;
}

export class ParticleChainSystem {
  private prevCapacity = 0;
  private prevX = new Float32Array(0);
  private prevY = new Float32Array(0);
  private speedSmooth = new Float32Array(0);
  private dirX = new Float32Array(0);
  private dirY = new Float32Array(0);
  private nextInCell = new Int32Array(0);
  private visitedStamp = new Int32Array(0);
  private movingIndices = new Int32Array(0);
  private prevInitialized = false;

  private readonly cellHead = new Int32Array(COLOR_COUNT * GRID_CELLS);
  private readonly chains: ActiveParticleChain[] = [];
  private activeChainCount = 0;
  private stampCounter = 1;
  private seedCursor = 0;
  private spawnCooldownSec = 0;
  private nextColorPref = 0;

  constructor() {
    for (let i = 0; i < CHAIN_MAX_ACTIVE; i++) {
      this.chains.push({
        active: false,
        colorIdx: 0,
        hopCount: 0,
        ageSec: 0,
        durationSec: CHAIN_DURATION_SEC,
        peakAlpha: 0.32,
        particleIndices: new Int32Array(CHAIN_MAX_VERTICES),
        xs: new Float32Array(CHAIN_MAX_VERTICES),
        ys: new Float32Array(CHAIN_MAX_VERTICES),
      });
    }
  }

  get activeCount(): number {
    return this.activeChainCount;
  }

  getChains(): readonly ActiveParticleChain[] {
    return this.chains;
  }

  reset(): void {
    this.prevInitialized = false;
    this.speedSmooth.fill(0);
    this.dirX.fill(0);
    this.dirY.fill(0);
    this.activeChainCount = 0;
    this.spawnCooldownSec = 0;
    for (let i = 0; i < this.chains.length; i++) {
      this.chains[i].active = false;
    }
  }

  private ensureCapacity(count: number): void {
    if (count <= this.prevCapacity) return;
    const cap = Math.max(4608, count + 512);
    const nextPrevX = new Float32Array(cap);
    const nextPrevY = new Float32Array(cap);
    const nextSpeed = new Float32Array(cap);
    const nextDirX = new Float32Array(cap);
    const nextDirY = new Float32Array(cap);

    if (this.prevCapacity > 0) {
      nextPrevX.set(this.prevX);
      nextPrevY.set(this.prevY);
      nextSpeed.set(this.speedSmooth);
      nextDirX.set(this.dirX);
      nextDirY.set(this.dirY);
    }

    this.prevX = nextPrevX;
    this.prevY = nextPrevY;
    this.speedSmooth = nextSpeed;
    this.dirX = nextDirX;
    this.dirY = nextDirY;
    this.nextInCell = new Int32Array(cap);
    this.visitedStamp = new Int32Array(cap);
    this.movingIndices = new Int32Array(cap);
    this.prevCapacity = cap;
  }

  /**
   * Advances motion tracking, chain sweep lifetimes, and spawns new same-color
   * sequential chains strictly across actively migrating particles.
   */
  step(
    particles: readonly Particle[],
    sideLength: number,
    deltaTimeSec: number,
    isPaused: boolean = false,
    pulseBoost: number = 0
  ): number {
    const count = particles.length;
    if (count === 0 || !Number.isFinite(sideLength) || sideLength <= 0) {
      this.activeChainCount = 0;
      for (let i = 0; i < this.chains.length; i++) {
        this.chains[i].active = false;
      }
      return 0;
    }

    if (isPaused) {
      return this.activeChainCount;
    }

    this.ensureCapacity(count);
    const dt = Number.isFinite(deltaTimeSec) && deltaTimeSec > 0 ? Math.min(0.1, deltaTimeSec) : 1 / 60;
    const invL = 1 / sideLength;
    const invLdt = 1 / (sideLength * dt);

    if (!this.prevInitialized) {
      for (let i = 0; i < count; i++) {
        this.prevX[i] = particles[i].x;
        this.prevY[i] = particles[i].y;
        this.speedSmooth[i] = 0;
        this.dirX[i] = 0;
        this.dirY[i] = 0;
      }
      this.prevInitialized = true;
      return 0;
    }

    // 1. Update live vertex coordinates, advance active chain sweep timers, and retire stretched/teleported chains
    let liveChains = 0;
    const maxLiveHopSq = CHAIN_MAX_LIVE_HOP_NORM * CHAIN_MAX_LIVE_HOP_NORM;
    for (let c = 0; c < this.chains.length; c++) {
      const chain = this.chains[c];
      if (!chain.active) continue;
      chain.ageSec += dt;
      if (chain.ageSec >= chain.durationSec) {
        chain.active = false;
        continue;
      }
      const vCount = chain.hopCount + 1;
      let broken = false;
      for (let v = 0; v < vCount; v++) {
        const pIdx = chain.particleIndices[v];
        if (pIdx < 0 || pIdx >= count || !particles[pIdx].active) {
          broken = true;
          break;
        }
        const nx = particles[pIdx].x * invL;
        const ny = particles[pIdx].y * invL;
        const jumpDx = nx - chain.xs[v];
        const jumpDy = ny - chain.ys[v];
        if (jumpDx * jumpDx + jumpDy * jumpDy > 0.0025) {
          // Single-frame jump > 5% plate width (e.g. rim reclamation teleport) -> retire cleanly
          broken = true;
          break;
        }
        chain.xs[v] = nx;
        chain.ys[v] = ny;
        if (v > 0) {
          const segDx = nx - chain.xs[v - 1];
          const segDy = ny - chain.ys[v - 1];
          if (segDx * segDx + segDy * segDy > maxLiveHopSq) {
            broken = true;
            break;
          }
        }
      }
      if (broken) {
        chain.active = false;
        continue;
      }
      liveChains++;
    }

    // 2. Compute smoothed particle migration speed and populate same-color spatial hash
    this.cellHead.fill(-1);
    const blend = Math.min(1, dt * 14);
    const decay = 1 - blend;
    let movingCount = 0;

    for (let i = 0; i < count; i++) {
      const p = particles[i];
      if (!p.active || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        this.speedSmooth[i] = 0;
        continue;
      }

      const dx = p.x - this.prevX[i];
      const dy = p.y - this.prevY[i];
      this.prevX[i] = p.x;
      this.prevY[i] = p.y;

      const stepDist = Math.hypot(dx, dy);
      if (stepDist * invL > 0.05) {
        this.speedSmooth[i] = 0;
        this.dirX[i] = 0;
        this.dirY[i] = 0;
        continue;
      }
      const instSpeed = stepDist * invLdt;
      const smoothed = this.speedSmooth[i] * decay + instSpeed * blend;
      this.speedSmooth[i] = smoothed;

      if (stepDist > 1e-7) {
        const invDist = 1 / stepDist;
        this.dirX[i] = dx * invDist;
        this.dirY[i] = dy * invDist;
      }

      if (smoothed >= CHAIN_MIN_ACTIVE_SPEED) {
        const nx = p.x * invL;
        const ny = p.y * invL;
        if (nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1) {
          let gx = (nx * CHAIN_GRID_RES) | 0;
          let gy = (ny * CHAIN_GRID_RES) | 0;
          if (gx >= CHAIN_GRID_RES) gx = CHAIN_GRID_RES - 1;
          if (gy >= CHAIN_GRID_RES) gy = CHAIN_GRID_RES - 1;

          const cIdx = colorToIndex(p.color);
          const bucket = cIdx * GRID_CELLS + gy * CHAIN_GRID_RES + gx;
          this.nextInCell[i] = this.cellHead[bucket];
          this.cellHead[bucket] = i;
          this.movingIndices[movingCount++] = i;
        }
      }
    }

    // 3. Spawn new sequential chains when enough particles are actively migrating
    const boost = Number.isFinite(pulseBoost) ? Math.max(0, Math.min(1, pulseBoost)) : 0;
    this.spawnCooldownSec -= dt * (1 + boost * 1.4);

    if (movingCount >= 12 && liveChains < CHAIN_MAX_ACTIVE && this.spawnCooldownSec <= 0) {
      const targetSpawns = Math.min(3, CHAIN_MAX_ACTIVE - liveChains);
      let spawned = 0;
      const maxAttempts = movingCount < 24 ? movingCount : 24;

      for (let attempt = 0; attempt < maxAttempts && spawned < targetSpawns; attempt++) {
        const pickSlot = (this.seedCursor + attempt * 7) % movingCount;
        const seedIdx = this.movingIndices[pickSlot];
        const seedColor = colorToIndex(particles[seedIdx].color);
        if (spawned === 0 && seedColor !== this.nextColorPref && attempt < 8) {
          continue;
        }

        if (this.trySpawnChain(seedIdx, seedColor, particles, invL, boost)) {
          liveChains++;
          spawned++;
          this.nextColorPref = (this.nextColorPref + 1) % COLOR_COUNT;
        }
      }

      this.seedCursor = (this.seedCursor + 13) % Math.max(1, movingCount);
      this.spawnCooldownSec = boost > 0.15 ? 0.025 : 0.045;
    }

    this.activeChainCount = liveChains;
    return liveChains;
  }

  private trySpawnChain(
    seedIdx: number,
    colorIdx: number,
    particles: readonly Particle[],
    invL: number,
    pulseBoost: number
  ): boolean {
    let targetSlot: ActiveParticleChain | null = null;
    for (let i = 0; i < this.chains.length; i++) {
      if (!this.chains[i].active) {
        targetSlot = this.chains[i];
        break;
      }
    }
    if (!targetSlot) return false;

    const stamp = ++this.stampCounter;
    if (this.stampCounter >= 0x7ffffff0) {
      this.visitedStamp.fill(0);
      this.stampCounter = 1;
    }

    const minSq = CHAIN_MIN_HOP_NORM * CHAIN_MIN_HOP_NORM;
    const maxSq = CHAIN_MAX_HOP_NORM * CHAIN_MAX_HOP_NORM;
    const cellRadius = Math.max(1, Math.ceil(CHAIN_MAX_HOP_NORM * CHAIN_GRID_RES));
    const colorOffset = colorIdx * GRID_CELLS;

    let currIdx = seedIdx;
    let currX = particles[currIdx].x * invL;
    let currY = particles[currIdx].y * invL;
    let prefDx = this.dirX[currIdx];
    let prefDy = this.dirY[currIdx];

    targetSlot.particleIndices[0] = currIdx;
    targetSlot.xs[0] = currX;
    targetSlot.ys[0] = currY;
    this.visitedStamp[currIdx] = stamp;

    const desiredHops = CHAIN_MIN_HOPS + ((seedIdx + stamp) % (CHAIN_MAX_HOPS - CHAIN_MIN_HOPS + 1));
    let actualHops = 0;

    for (let hop = 0; hop < desiredHops; hop++) {
      let cgx = (currX * CHAIN_GRID_RES) | 0;
      let cgy = (currY * CHAIN_GRID_RES) | 0;
      if (cgx >= CHAIN_GRID_RES) cgx = CHAIN_GRID_RES - 1;
      if (cgy >= CHAIN_GRID_RES) cgy = CHAIN_GRID_RES - 1;

      const x0 = Math.max(0, cgx - cellRadius);
      const x1 = Math.min(CHAIN_GRID_RES - 1, cgx + cellRadius);
      const y0 = Math.max(0, cgy - cellRadius);
      const y1 = Math.min(CHAIN_GRID_RES - 1, cgy + cellRadius);

      let bestIdx = -1;
      let bestScore = Infinity;
      let bestDx = 0;
      let bestDy = 0;

      for (let gy = y0; gy <= y1; gy++) {
        const rowBase = colorOffset + gy * CHAIN_GRID_RES;
        for (let gx = x0; gx <= x1; gx++) {
          let cand = this.cellHead[rowBase + gx];
          while (cand !== -1) {
            if (this.visitedStamp[cand] !== stamp) {
              const candX = particles[cand].x * invL;
              const candY = particles[cand].y * invL;
              const dx = candX - currX;
              const dy = candY - currY;
              const dSq = dx * dx + dy * dy;
              if (dSq >= minSq && dSq <= maxSq) {
                const dist = Math.sqrt(dSq);
                let alignFactor = 1.0;
                if (prefDx !== 0 || prefDy !== 0) {
                  const cosAlign = (dx * prefDx + dy * prefDy) / dist;
                  // Reject sharp backwards folds while softly favoring forward flow
                  if (cosAlign < -0.35) {
                    cand = this.nextInCell[cand];
                    continue;
                  }
                  alignFactor = 1.15 - 0.35 * cosAlign;
                }
                const score = dist * alignFactor;
                if (score < bestScore) {
                  bestScore = score;
                  bestIdx = cand;
                  bestDx = dx / dist;
                  bestDy = dy / dist;
                }
              }
            }
            cand = this.nextInCell[cand];
          }
        }
      }

      if (bestIdx === -1) break;

      this.visitedStamp[bestIdx] = stamp;
      currIdx = bestIdx;
      currX = particles[currIdx].x * invL;
      currY = particles[currIdx].y * invL;
      prefDx = bestDx;
      prefDy = bestDy;

      actualHops++;
      targetSlot.particleIndices[actualHops] = currIdx;
      targetSlot.xs[actualHops] = currX;
      targetSlot.ys[actualHops] = currY;
    }

    if (actualHops < CHAIN_MIN_HOPS) {
      return false;
    }

    targetSlot.active = true;
    targetSlot.colorIdx = colorIdx;
    targetSlot.hopCount = actualHops;
    targetSlot.ageSec = 0;
    targetSlot.durationSec = CHAIN_DURATION_SEC * (0.9 + (actualHops - CHAIN_MIN_HOPS) * 0.12);
    targetSlot.peakAlpha = Math.min(0.68, 0.52 + pulseBoost * 0.16);
    return true;
  }

  /**
   * Draws all active sequential chains directly into the RGBA frame buffer
   * (above the density cloud and beneath live particles) with smooth
   * scanline-bounded anti-aliasing and head-to-tail progressive brightness.
   */
  drawToRgbaFrame(frame: Uint8ClampedArray, targetPx: number, dpr: number): void {
    if (this.activeChainCount <= 0 || targetPx <= 0) return;

    const halfWidth = Math.max(1.4, 1.65 * dpr);
    const invHalfWidth = 1 / halfWidth;
    const pad = Math.ceil(halfWidth) + 1;
    const spanAxis = targetPx - 1;

    for (let c = 0; c < this.chains.length; c++) {
      const chain = this.chains[c];
      if (!chain.active) continue;

      const sweep = evaluateChainSweepSpan(chain.ageSec, chain.durationSec, chain.hopCount);
      if (sweep.envelopeAlpha <= 0.005 || sweep.headHop - sweep.tailHop <= 0.02) continue;

      const rgb = CHAIN_COLOR_RGB[chain.colorIdx];
      const colR = rgb[0];
      const colG = rgb[1];
      const colB = rgb[2];
      const baseAlpha = chain.peakAlpha * sweep.envelopeAlpha;
      const totalSpan = sweep.headHop - sweep.tailHop;

      const firstHop = Math.floor(sweep.tailHop);
      const lastHop = Math.min(chain.hopCount - 1, Math.floor(sweep.headHop - 1e-5));

      for (let h = firstHop; h <= lastHop; h++) {
        const localStart = Math.max(0, sweep.tailHop - h);
        const localEnd = Math.min(1, sweep.headHop - h);
        if (localEnd <= localStart) continue;

        const ax = chain.xs[h] * spanAxis;
        const ay = chain.ys[h] * spanAxis;
        const bx = chain.xs[h + 1] * spanAxis;
        const by = chain.ys[h + 1] * spanAxis;

        const sx = ax + (bx - ax) * localStart;
        const sy = ay + (by - ay) * localStart;
        const ex = ax + (bx - ax) * localEnd;
        const ey = ay + (by - ay) * localEnd;

        const dx = ex - sx;
        const dy = ey - sy;
        const lenSq = dx * dx + dy * dy;
        if (lenSq < 0.25) continue;
        const len = Math.sqrt(lenSq);

        // Progress along the visible ribbon: 0 at trailing tail, 1 at leading head
        const startRatio = (h + localStart - sweep.tailHop) / totalSpan;
        const endRatio = (h + localEnd - sweep.tailHop) / totalSpan;

        const minY = Math.max(0, Math.floor(Math.min(sy, ey)) - pad);
        const maxY = Math.min(targetPx - 1, Math.ceil(Math.max(sy, ey)) + pad);
        const segMinX = Math.max(0, Math.floor(Math.min(sx, ex)) - pad);
        const segMaxX = Math.min(targetPx - 1, Math.ceil(Math.max(sx, ex)) + pad);
        const absDy = Math.abs(dy);
        const slopeX = absDy >= 0.5 ? dx / (ey - sy) : 0;
        const xSpanPad = absDy >= 0.5 ? (halfWidth * len) / absDy + 1.5 : 0;

        for (let py = minY; py <= maxY; py++) {
          let rowMinX = segMinX;
          let rowMaxX = segMaxX;
          if (absDy >= 0.5) {
            const xCenter = sx + (py - sy) * slopeX;
            rowMinX = Math.max(segMinX, Math.floor(xCenter - xSpanPad));
            rowMaxX = Math.min(segMaxX, Math.ceil(xCenter + xSpanPad));
          }

          const rowOffset = py * targetPx;
          for (let px = rowMinX; px <= rowMaxX; px++) {
            let proj = ((px - sx) * dx + (py - sy) * dy) / lenSq;
            if (proj < 0) proj = 0;
            else if (proj > 1) proj = 1;

            const cx = sx + proj * dx;
            const cy = sy + proj * dy;
            const dist = Math.hypot(px - cx, py - cy);
            if (dist >= halfWidth) continue;

            const linearCov = 1 - dist * invHalfWidth;
            const cov = linearCov >= 0.72 ? 1.0 : linearCov * 1.388;
            const ribbonRatio = startRatio + (endRatio - startRatio) * proj;
            // Smooth ramp from subtle trailing tail (0.32) to crisp bright head (1.0)
            const a = baseAlpha * cov * (0.32 + 0.68 * ribbonRatio);
            if (a <= 0.004) continue;

            const d = (rowOffset + px) * 4;
            const invA = 1 - a;
            frame[d] = colR * a + frame[d] * invA;
            frame[d + 1] = colG * a + frame[d + 1] * invA;
            frame[d + 2] = colB * a + frame[d + 2] * invA;
          }
        }
      }
    }
  }
}
