/**
 * PlateCanvas: Top-down, orthographic, realistic visualization of a vibrating square metal plate.
 *
 * Conforms to STAGE 8 Requirements:
 * - Square plate dominates the view with zero perspective distortion.
 * - Realistic dark brushed aluminum plate surface with subtle metallic sheen and refined rim.
 * - Fine, pale sand or powder particles using actual per-particle radius & brightness attributes.
 * - Subtle pre-baked contact shadow in offscreen sprite tiers (zero expensive per-particle shadowBlur).
 * - Zero artificial glowing overlays, heatmaps, or drawn nodal lines.
 * - Pure rendering loop: never advances modal integration, free decay, or particle transport.
 */

import React, { useEffect, useRef } from 'react';
import { DominantModalInfo } from '../physics/modalSolver.ts';
import { Particle, ParticleColor } from '../physics/types.ts';
import {
  DEFAULT_PARTICLE_RADIUS,
  MAX_BRIGHTNESS,
  MIN_BRIGHTNESS,
  SPRITE_BASE_PX,
} from './plateVisuals.ts';
import {
  computeOverlayPulseVisibility,
  DEFAULT_MEMORY_GRID_RES,
  formatResonantFrequency,
  ModalLockPulseTracker,
  PatternMemoryField,
} from './patternMemory.ts';
import { ParticleChainSystem } from './particleChains.ts';

export type HeatmapType = 'none' | 'diffusivity' | 'displacement' | 'nodal';

interface PlateCanvasProps {
  particles: Particle[];
  sideLength: number; // m
  canvasRefExternal?: React.RefObject<HTMLCanvasElement | null>;
  particlesRefExternal?: React.RefObject<Particle[]>;
  patternMemoryHalfLifeSec?: number;
  patternMemoryResetToken?: number;
  isPatternMemoryPausedRef?: React.RefObject<boolean>;
  normalizePatternMemory?: boolean;
  dominantModalInfoRef?: React.RefObject<DominantModalInfo | null>;
}

const GRAIN_COLOR_TIERS: Record<ParticleColor, { body: string; spec: string }[]> = {
  green: [
    { body: 'rgba(34, 197, 94, 0.84)', spec: 'rgba(220, 252, 231, 0.40)' },
    { body: 'rgba(52, 211, 153, 0.88)', spec: 'rgba(220, 252, 231, 0.48)' },
    { body: 'rgba(74, 222, 128, 0.91)', spec: 'rgba(236, 253, 245, 0.56)' },
    { body: 'rgba(94, 234, 150, 0.93)', spec: 'rgba(240, 253, 244, 0.64)' },
    { body: 'rgba(118, 242, 166, 0.95)', spec: 'rgba(255, 255, 255, 0.72)' },
    { body: 'rgba(134, 247, 178, 0.97)', spec: 'rgba(255, 255, 255, 0.80)' },
  ],
  blue: [
    { body: 'rgba(59, 130, 246, 0.84)', spec: 'rgba(219, 234, 254, 0.40)' },
    { body: 'rgba(66, 153, 248, 0.88)', spec: 'rgba(219, 234, 254, 0.48)' },
    { body: 'rgba(84, 168, 250, 0.91)', spec: 'rgba(239, 246, 255, 0.56)' },
    { body: 'rgba(96, 178, 252, 0.93)', spec: 'rgba(239, 246, 255, 0.64)' },
    { body: 'rgba(122, 192, 253, 0.95)', spec: 'rgba(255, 255, 255, 0.72)' },
    { body: 'rgba(147, 205, 254, 0.97)', spec: 'rgba(255, 255, 255, 0.80)' },
  ],
  red: [
    { body: 'rgba(220, 38, 38, 0.84)', spec: 'rgba(254, 226, 226, 0.40)' },
    { body: 'rgba(239, 68, 68, 0.88)', spec: 'rgba(254, 226, 226, 0.48)' },
    { body: 'rgba(244, 88, 88, 0.91)', spec: 'rgba(254, 242, 242, 0.56)' },
    { body: 'rgba(248, 113, 113, 0.93)', spec: 'rgba(254, 242, 242, 0.64)' },
    { body: 'rgba(250, 138, 138, 0.95)', spec: 'rgba(255, 255, 255, 0.72)' },
    { body: 'rgba(252, 165, 165, 0.97)', spec: 'rgba(255, 255, 255, 0.80)' },
  ],
};

// Discrete sprite sizes (px at dpr=1) baked cleanly with anti-aliased contact shadows & specular highlights
const SPRITE_SIZE_BUCKETS = [9, 11, 13, 15] as const;
const SIZE_BUCKET_COUNT = SPRITE_SIZE_BUCKETS.length;

interface BakedPixelSprite {
  len: number;
  dx: Int8Array;
  dy: Int8Array;
  pr: Float32Array;
  pg: Float32Array;
  pb: Float32Array;
  invA: Float32Array;
}

function buildBakedPixelSpriteBank(dpr: number): Record<ParticleColor, BakedPixelSprite[][]> {
  const scratchCanvas = document.createElement('canvas');
  const maxPx = Math.ceil(SPRITE_SIZE_BUCKETS[SIZE_BUCKET_COUNT - 1] * dpr) + 2;
  scratchCanvas.width = maxPx;
  scratchCanvas.height = maxPx;
  const sCtx = scratchCanvas.getContext('2d', { willReadFrequently: true });

  const banks: Record<ParticleColor, BakedPixelSprite[][]> = {
    green: [],
    blue: [],
    red: [],
  };

  const colors: ParticleColor[] = ['green', 'blue', 'red'];
  for (let c = 0; c < colors.length; c++) {
    const colorKey = colors[c];
    const tiers = GRAIN_COLOR_TIERS[colorKey];

    for (let b = 0; b < SIZE_BUCKET_COUNT; b++) {
      const pxSize = Math.max(5, Math.round(SPRITE_SIZE_BUCKETS[b] * dpr));
      const scaleRatio = pxSize / SPRITE_BASE_PX;
      const cx = pxSize * 0.5;
      const halfInt = pxSize >> 1;
      const sizeBank: BakedPixelSprite[] = [];

      for (let i = 0; i < tiers.length; i++) {
        const tier = tiers[i];
        if (!sCtx) {
          sizeBank.push({
            len: 0,
            dx: new Int8Array(0),
            dy: new Int8Array(0),
            pr: new Float32Array(0),
            pg: new Float32Array(0),
            pb: new Float32Array(0),
            invA: new Float32Array(0),
          });
          continue;
        }

        sCtx.clearRect(0, 0, pxSize, pxSize);

        // Subtle pre-baked contact drop shadow
        sCtx.fillStyle = 'rgba(0, 0, 0, 0.42)';
        sCtx.beginPath();
        sCtx.arc(cx + 0.55 * scaleRatio, cx + 0.75 * scaleRatio, 2.0 * scaleRatio, 0, Math.PI * 2);
        sCtx.fill();

        // Main grain body
        sCtx.fillStyle = tier.body;
        sCtx.beginPath();
        sCtx.arc(cx, cx, 1.85 * scaleRatio, 0, Math.PI * 2);
        sCtx.fill();

        // Subtle specular micro-highlight
        sCtx.fillStyle = tier.spec;
        sCtx.beginPath();
        sCtx.arc(cx - 0.5 * scaleRatio, cx - 0.5 * scaleRatio, 0.7 * scaleRatio, 0, Math.PI * 2);
        sCtx.fill();

        const sd = sCtx.getImageData(0, 0, pxSize, pxSize).data;
        let nonZeroCount = 0;
        for (let p = 3; p < sd.length; p += 4) {
          if (sd[p] > 1) nonZeroCount++;
        }

        const dx = new Int8Array(nonZeroCount);
        const dy = new Int8Array(nonZeroCount);
        const pr = new Float32Array(nonZeroCount);
        const pg = new Float32Array(nonZeroCount);
        const pb = new Float32Array(nonZeroCount);
        const invA = new Float32Array(nonZeroCount);

        let k = 0;
        for (let py = 0; py < pxSize; py++) {
          for (let px = 0; px < pxSize; px++) {
            const idx = (py * pxSize + px) * 4;
            const a = sd[idx + 3];
            if (a <= 1) continue;
            const aNorm = a / 255;
            dx[k] = px - halfInt;
            dy[k] = py - halfInt;
            pr[k] = sd[idx] * aNorm;
            pg[k] = sd[idx + 1] * aNorm;
            pb[k] = sd[idx + 2] * aNorm;
            invA[k] = 1 - aNorm;
            k++;
          }
        }

        sizeBank.push({ len: nonZeroCount, dx, dy, pr, pg, pb, invA });
      }
      banks[colorKey].push(sizeBank);
    }
  }

  return banks;
}

export const PlateCanvas: React.FC<PlateCanvasProps> = ({
  particles,
  sideLength,
  canvasRefExternal,
  particlesRefExternal,
  patternMemoryHalfLifeSec = 0,
  patternMemoryResetToken = 0,
  isPatternMemoryPausedRef,
  normalizePatternMemory = false,
  dominantModalInfoRef,
}) => {
  const internalCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const canvasRef = canvasRefExternal ?? internalCanvasRef;
  const internalParticlesRef = useRef<Particle[]>(particles);
  internalParticlesRef.current = particles;
  const particlesRef = particlesRefExternal ?? internalParticlesRef;

  const halfLifeRef = useRef<number>(patternMemoryHalfLifeSec);
  halfLifeRef.current = patternMemoryHalfLifeSec;
  const normalizeMemoryRef = useRef<boolean>(normalizePatternMemory);
  normalizeMemoryRef.current = normalizePatternMemory;
  const appliedNormalizeRef = useRef<boolean>(normalizePatternMemory);
  const resetTokenRef = useRef<number>(patternMemoryResetToken);
  resetTokenRef.current = patternMemoryResetToken;
  const appliedResetTokenRef = useRef<number>(patternMemoryResetToken);
  const fallbackPausedRef = useRef<boolean>(false);
  const pausedRef = isPatternMemoryPausedRef ?? fallbackPausedRef;
  const fallbackModalInfoRef = useRef<DominantModalInfo | null>(null);
  const modalInfoRef = dominantModalInfoRef ?? fallbackModalInfoRef;

  // Reusable visual pattern-memory buffers & offscreen halo/core ImageData targets (allocated once)
  const memoryFieldRef = useRef<PatternMemoryField | null>(null);
  const pulseTrackerRef = useRef<ModalLockPulseTracker | null>(null);
  const chainSystemRef = useRef<ParticleChainSystem | null>(null);
  const appliedPulseRef = useRef<number>(0);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const overlayValueRef = useRef<HTMLSpanElement | null>(null);
  const overlayUnitRef = useRef<HTMLSpanElement | null>(null);
  const lastOverlayFreqRef = useRef<number>(-1);
  const lastOverlayVisibleRef = useRef<boolean>(false);
  const memorySurfaceRef = useRef<{
    gridRes: number;
    haloRgba: Uint8ClampedArray;
    coreRgba: Uint8ClampedArray;
    cloudPremul: Float32Array;
  } | null>(null);

  // Pre-rendered anti-aliased sprite pixel lists (keyed by dpr, rebuilt only when dpr changes)
  const pixelSpritesRef = useRef<{
    dpr: number;
    maxHalf: number;
    banks: Record<ParticleColor, BakedPixelSprite[][]>;
  } | null>(null);

  // Cached brushed aluminum plate pixels & single reusable output frame buffer (rebuilt on size/dpr change)
  const plateSurfaceRef = useRef<{
    size: number;
    dpr: number;
    targetPx: number;
    platePixels: Uint8ClampedArray;
    frameImageData: ImageData;
    xMap: Uint16Array;
    xFrac: Float32Array;
    yMap: Uint16Array;
    yFrac: Float32Array;
  } | null>(null);

  // Pure rendering loop (never advances physics or particle transport)
  useEffect(() => {
    let animId: number;
    let lastRenderMs: number | null = null;
    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const syncOverlayIndicator = (pulseAmount: number, lockedFreqHz: number | null) => {
      const overlayEl = overlayRef.current;
      if (!overlayEl) return;

      const isVisible = pulseAmount > 0 && lockedFreqHz !== null && lockedFreqHz > 0;
      if (isVisible) {
        const { opacity, translateYpx } = computeOverlayPulseVisibility(pulseAmount);
        overlayEl.style.visibility = 'visible';
        overlayEl.style.opacity = opacity.toFixed(3);
        overlayEl.style.transform = prefersReducedMotion
          ? 'translate3d(0, 0, 0)'
          : `translate3d(0, ${translateYpx.toFixed(2)}px, 0)`;

        if (lastOverlayFreqRef.current !== lockedFreqHz) {
          lastOverlayFreqRef.current = lockedFreqHz;
          const formatted = formatResonantFrequency(lockedFreqHz);
          if (overlayValueRef.current) overlayValueRef.current.textContent = formatted.value;
          if (overlayUnitRef.current) overlayUnitRef.current.textContent = formatted.unit;
          overlayEl.dataset.frequencyHz = lockedFreqHz.toFixed(2);
        }
        if (!lastOverlayVisibleRef.current) {
          lastOverlayVisibleRef.current = true;
          overlayEl.dataset.visible = 'true';
        }
        overlayEl.dataset.pulseOpacity = opacity.toFixed(3);
      } else if (lastOverlayVisibleRef.current || overlayEl.dataset.visible !== 'false') {
        lastOverlayVisibleRef.current = false;
        overlayEl.style.opacity = '0';
        overlayEl.style.visibility = 'hidden';
        overlayEl.style.transform = prefersReducedMotion
          ? 'translate3d(0, 0, 0)'
          : 'translate3d(0, -3px, 0)';
        overlayEl.dataset.visible = 'false';
        overlayEl.dataset.pulseOpacity = '0.000';
      }
    };

    const render = (nowMs: number) => {
      const dtSec =
        lastRenderMs === null ? 1 / 60 : Math.min(0.1, Math.max(0, (nowMs - lastRenderMs) / 1000));
      lastRenderMs = nowMs;

      const canvas = canvasRef.current;
      if (!canvas) {
        animId = requestAnimationFrame(render);
        return;
      }

      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) {
        animId = requestAnimationFrame(render);
        return;
      }

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const size = Math.min(width, height);

      if (size <= 0) {
        animId = requestAnimationFrame(render);
        return;
      }

      const targetPx = Math.round(size * dpr);
      if (canvas.width !== targetPx || canvas.height !== targetPx) {
        canvas.width = targetPx;
        canvas.height = targetPx;
      }

      // Build or reuse cached brushed metal plate pixel buffer + coordinate lookup tables
      let cached = plateSurfaceRef.current;
      if (!cached || cached.size !== size || cached.dpr !== dpr || cached.targetPx !== targetPx) {
        const off = document.createElement('canvas');
        off.width = targetPx;
        off.height = targetPx;
        const oCtx = off.getContext('2d', { alpha: false });
        if (oCtx) {
          oCtx.scale(dpr, dpr);

          // 1. Realistic dark brushed metal plate surface
          const plateGrad = oCtx.createRadialGradient(
            size * 0.45,
            size * 0.42,
            size * 0.05,
            size * 0.5,
            size * 0.5,
            size * 0.72
          );
          plateGrad.addColorStop(0.0, '#1c222c');
          plateGrad.addColorStop(0.35, '#161b23');
          plateGrad.addColorStop(0.7, '#11151c');
          plateGrad.addColorStop(1.0, '#0c0f14');

          oCtx.fillStyle = plateGrad;
          oCtx.fillRect(0, 0, size, size);

          // Subtle fine brushed horizontal grain lines
          oCtx.strokeStyle = 'rgba(255, 255, 255, 0.015)';
          oCtx.lineWidth = 1;
          for (let y = 2; y < size - 2; y += 4) {
            oCtx.beginPath();
            oCtx.moveTo(2, y);
            oCtx.lineTo(size - 2, y);
            oCtx.stroke();
          }

          // 2. Refined beveled metal edge
          oCtx.strokeStyle = '#0f172a';
          oCtx.lineWidth = 2.5;
          oCtx.strokeRect(1, 1, size - 2, size - 2);

          oCtx.strokeStyle = '#334155';
          oCtx.lineWidth = 1;
          oCtx.strokeRect(2.5, 2.5, size - 5, size - 5);

          // Center shaker probe mounting pin
          oCtx.fillStyle = '#0f172a';
          oCtx.beginPath();
          oCtx.arc(size / 2, size / 2, 4.0, 0, Math.PI * 2);
          oCtx.fill();
          oCtx.fillStyle = '#475569';
          oCtx.beginPath();
          oCtx.arc(size / 2, size / 2, 2.5, 0, Math.PI * 2);
          oCtx.fill();
          oCtx.fillStyle = '#94a3b8';
          oCtx.beginPath();
          oCtx.arc(size / 2 - 0.5, size / 2 - 0.5, 0.8, 0, Math.PI * 2);
          oCtx.fill();
        }

        const plateImageData = oCtx
          ? oCtx.getImageData(0, 0, targetPx, targetPx)
          : ctx.createImageData(targetPx, targetPx);
        const frameImageData = ctx.createImageData(targetPx, targetPx);

        const maxGridIdx = DEFAULT_MEMORY_GRID_RES - 1;
        const maxAxis = Math.max(1, targetPx - 1);
        const xMap = new Uint16Array(targetPx);
        const xFrac = new Float32Array(targetPx);
        const yMap = new Uint16Array(targetPx);
        const yFrac = new Float32Array(targetPx);
        for (let i = 0; i < targetPx; i++) {
          const g = (i / maxAxis) * maxGridIdx;
          const ig = g >= maxGridIdx ? maxGridIdx - 1 : g | 0;
          xMap[i] = ig;
          xFrac[i] = g - ig;
          yMap[i] = ig;
          yFrac[i] = g - ig;
        }

        cached = {
          size,
          dpr,
          targetPx,
          platePixels: new Uint8ClampedArray(plateImageData.data),
          frameImageData,
          xMap,
          xFrac,
          yMap,
          yFrac,
        };
        plateSurfaceRef.current = cached;
      }

      // Build or reuse pre-baked anti-aliased sprite pixel lists
      let spriteCache = pixelSpritesRef.current;
      if (!spriteCache || spriteCache.dpr !== dpr) {
        const maxPx = Math.max(5, Math.round(SPRITE_SIZE_BUCKETS[SIZE_BUCKET_COUNT - 1] * dpr));
        spriteCache = {
          dpr,
          maxHalf: (maxPx >> 1) + 1,
          banks: buildBakedPixelSpriteBank(dpr),
        };
        pixelSpritesRef.current = spriteCache;
      }

      const frame = cached.frameImageData.data;
      frame.set(cached.platePixels);

      const activeParticles = particlesRef.current;

      // Clear accumulated visual pattern memory & modal lock pulse on explicit simulation reset
      if (appliedResetTokenRef.current !== resetTokenRef.current) {
        appliedResetTokenRef.current = resetTokenRef.current;
        memoryFieldRef.current?.clear();
        pulseTrackerRef.current?.reset();
        chainSystemRef.current?.reset();
        appliedPulseRef.current = 0;
        lastOverlayFreqRef.current = -1;
        syncOverlayIndicator(0, null);
      }

      // 2.5 Visual-only two-scale density cloud (broad halo + dense core) rendered beneath live particles
      const halfLifeSec = halfLifeRef.current;
      const normalizeMemory = normalizeMemoryRef.current;
      let currentPulseAmount = 0;
      canvas.dataset.patternMemorySec = halfLifeSec.toFixed(2);
      canvas.dataset.patternMemoryNormalized = String(normalizeMemory);
      if (halfLifeSec > 0) {
        const memT0 = performance.now();
        let field = memoryFieldRef.current;
        if (!field) {
          field = new PatternMemoryField(DEFAULT_MEMORY_GRID_RES);
          memoryFieldRef.current = field;
        }
        let pulseTracker = pulseTrackerRef.current;
        if (!pulseTracker) {
          pulseTracker = new ModalLockPulseTracker();
          pulseTrackerRef.current = pulseTracker;
        }
        let memSurface = memorySurfaceRef.current;
        if (!memSurface || memSurface.gridRes !== field.gridRes) {
          const cellCount = field.gridRes * field.gridRes;
          memSurface = {
            gridRes: field.gridRes,
            haloRgba: new Uint8ClampedArray(cellCount * 4),
            coreRgba: new Uint8ClampedArray(cellCount * 4),
            cloudPremul: new Float32Array(cellCount * 4),
          };
          memorySurfaceRef.current = memSurface;
        }

        const isPaused = pausedRef.current;
        const normalizeChanged = appliedNormalizeRef.current !== normalizeMemory;
        appliedNormalizeRef.current = normalizeMemory;
        const pulseAmount = pulseTracker.update(modalInfoRef.current, dtSec, isPaused);
        currentPulseAmount = pulseAmount;
        const pulseChanged = Math.abs(appliedPulseRef.current - pulseAmount) > 1e-4;
        appliedPulseRef.current = pulseAmount;

        const hasMemory = field.step(activeParticles, sideLength, dtSec, halfLifeSec, isPaused);
        if (hasMemory) {
          const cloudPremul = memSurface.cloudPremul;
          const res = memSurface.gridRes;

          if (!isPaused || normalizeChanged || pulseChanged) {
            const haloRgba = memSurface.haloRgba;
            const coreRgba = memSurface.coreRgba;
            field.writeDualLayersToRgba(haloRgba, coreRgba, normalizeMemory, pulseAmount);

            // Pre-combine Halo + Core in 128x128 using exact sequential 'screen' identity over opaque plate
            const inv255Sq = 1 / (255 * 255);
            const cellCount = res * res;
            for (let i = 0; i < cellCount; i++) {
              const p = i * 4;
              const ha = haloRgba[p + 3];
              const ca = coreRgba[p + 3];
              if ((ha | ca) === 0) {
                cloudPremul[p] = 0;
                cloudPremul[p + 1] = 0;
                cloudPremul[p + 2] = 0;
                cloudPremul[p + 3] = 0;
              } else {
                const hScale = ha * inv255Sq;
                const cScale = ca * inv255Sq;
                const hr = haloRgba[p] * hScale;
                const hg = haloRgba[p + 1] * hScale;
                const hb = haloRgba[p + 2] * hScale;
                const cr = coreRgba[p] * cScale;
                const cg = coreRgba[p + 1] * cScale;
                const cb = coreRgba[p + 2] * cScale;
                cloudPremul[p] = hr + cr - hr * cr;
                cloudPremul[p + 1] = hg + cg - hg * cg;
                cloudPremul[p + 2] = hb + cb - hb * cb;
                cloudPremul[p + 3] = 1;
              }
            }
          }

          // Bilinear upsample + screen blend onto opaque frame buffer (zero-regions skipped in O(1))
          const stride = res * 4;
          const xMap = cached.xMap;
          const xFrac = cached.xFrac;
          const yMap = cached.yMap;
          const yFrac = cached.yFrac;

          for (let y = 0; y < targetPx; y++) {
            const iy = yMap[y];
            const fy = yFrac[y];
            const oneMinusFy = 1 - fy;
            const row0 = iy * stride;
            const row1 = row0 + stride;
            const dstRow = y * targetPx * 4;

            for (let x = 0; x < targetPx; x++) {
              const p00 = row0 + xMap[x] * 4;
              const p10 = p00 + 4;
              const p01 = row1 + xMap[x] * 4;
              const p11 = p01 + 4;
              if (
                cloudPremul[p00 + 3] === 0 &&
                cloudPremul[p10 + 3] === 0 &&
                cloudPremul[p01 + 3] === 0 &&
                cloudPremul[p11 + 3] === 0
              ) {
                continue;
              }

              const fx = xFrac[x];
              const oneMinusFx = 1 - fx;
              const w00 = oneMinusFx * oneMinusFy;
              const w10 = fx * oneMinusFy;
              const w01 = oneMinusFx * fy;
              const w11 = fx * fy;

              const mr =
                cloudPremul[p00] * w00 +
                cloudPremul[p10] * w10 +
                cloudPremul[p01] * w01 +
                cloudPremul[p11] * w11;
              const mg =
                cloudPremul[p00 + 1] * w00 +
                cloudPremul[p10 + 1] * w10 +
                cloudPremul[p01 + 1] * w01 +
                cloudPremul[p11 + 1] * w11;
              const mb =
                cloudPremul[p00 + 2] * w00 +
                cloudPremul[p10 + 2] * w10 +
                cloudPremul[p01 + 2] * w01 +
                cloudPremul[p11 + 2] * w11;

              const d = dstRow + x * 4;
              const dr = frame[d];
              const dg = frame[d + 1];
              const db = frame[d + 2];
              frame[d] = dr + mr * (255 - dr);
              frame[d + 1] = dg + mg * (255 - dg);
              frame[d + 2] = db + mb * (255 - db);
            }
          }
        }
        const memMs = performance.now() - memT0;
        canvas.dataset.patternMemoryActive = String(hasMemory);
        canvas.dataset.patternMemoryPeak = field.getLastMaxDensity().toFixed(3);
        canvas.dataset.patternMemoryMean = field.getLastMeanDensity().toFixed(4);
        canvas.dataset.patternMemoryRenderMs = memMs.toFixed(3);
        canvas.dataset.modalLockFreqHz = (pulseTracker.lockedFrequencyHz ?? 0).toFixed(2);
        canvas.dataset.modalLockCount = String(pulseTracker.lockCount);
        canvas.dataset.patternPulseAmount = pulseAmount.toFixed(3);
        syncOverlayIndicator(pulseAmount, pulseTracker.lockedFrequencyHz);
      } else {
        appliedNormalizeRef.current = normalizeMemory;
        appliedPulseRef.current = 0;
        if (memoryFieldRef.current?.isActive) {
          memoryFieldRef.current.clear();
        }
        pulseTrackerRef.current?.reset();
        lastOverlayFreqRef.current = -1;
        syncOverlayIndicator(0, null);
        canvas.dataset.patternMemoryActive = 'false';
        canvas.dataset.patternMemoryPeak = '0.000';
        canvas.dataset.patternMemoryMean = '0.0000';
        canvas.dataset.patternMemoryRenderMs = '0.000';
        canvas.dataset.modalLockFreqHz = '0.00';
        canvas.dataset.modalLockCount = '0';
        canvas.dataset.patternPulseAmount = '0.000';
      }

      // 2.75 Visual-only sequential same-color hop ribbons connecting actively migrating particles
      let chainSystem = chainSystemRef.current;
      if (!chainSystem) {
        chainSystem = new ParticleChainSystem();
        chainSystemRef.current = chainSystem;
      }
      const activeChainCount = chainSystem.step(
        activeParticles,
        sideLength,
        dtSec,
        pausedRef.current,
        currentPulseAmount
      );
      chainSystem.drawToRgbaFrame(frame, targetPx, dpr);
      canvas.dataset.particleChainCount = String(activeChainCount);

      // 3. Composite granular powder particles directly onto frame buffer via pre-baked sprite pixel lists
      const scalePx = targetPx / sideLength;
      const banks = spriteCache.banks;
      const tierCount = banks.green[0].length;
      const bSpanInv = 1 / (MAX_BRIGHTNESS - MIN_BRIGHTNESS);
      const rBaseScale = SPRITE_BASE_PX / DEFAULT_PARTICLE_RADIUS;
      const maxMargin = spriteCache.maxHalf;
      const safeLimit = targetPx - maxMargin;

      for (let i = 0; i < activeParticles.length; i++) {
        const p = activeParticles[i];
        if (!p.active) continue;

        const cx = (p.x * scalePx) | 0;
        const cy = (p.y * scalePx) | 0;
        const b = p.brightness ?? 1.0;
        const normB = Math.max(0, Math.min(0.9999, (b - MIN_BRIGHTNESS) * bSpanInv));
        const spriteTier = (normB * tierCount) | 0;

        const r = p.radius ?? DEFAULT_PARTICLE_RADIUS;
        const clampedR = r < 0.6 ? 0.6 : r > 2.0 ? 2.0 : r;
        const targetSpritePx = clampedR * rBaseScale;
        let bucket = ((targetSpritePx - 8) * 0.5) | 0;
        if (bucket < 0) bucket = 0;
        else if (bucket >= SIZE_BUCKET_COUNT) bucket = SIZE_BUCKET_COUNT - 1;

        const colorBank =
          p.color === 'blue' ? banks.blue : p.color === 'red' ? banks.red : banks.green;
        const sprite = colorBank[bucket][spriteTier];
        const sLen = sprite.len;
        const sDx = sprite.dx;
        const sDy = sprite.dy;
        const sPr = sprite.pr;
        const sPg = sprite.pg;
        const sPb = sprite.pb;
        const sInvA = sprite.invA;

        if (cx >= maxMargin && cx < safeLimit && cy >= maxMargin && cy < safeLimit) {
          for (let k = 0; k < sLen; k++) {
            const d = ((cy + sDy[k]) * targetPx + (cx + sDx[k])) * 4;
            const invA = sInvA[k];
            frame[d] = sPr[k] + frame[d] * invA;
            frame[d + 1] = sPg[k] + frame[d + 1] * invA;
            frame[d + 2] = sPb[k] + frame[d + 2] * invA;
          }
        } else {
          for (let k = 0; k < sLen; k++) {
            const px = cx + sDx[k];
            const py = cy + sDy[k];
            if (px < 0 || px >= targetPx || py < 0 || py >= targetPx) continue;
            const d = (py * targetPx + px) * 4;
            const invA = sInvA[k];
            frame[d] = sPr[k] + frame[d] * invA;
            frame[d + 1] = sPg[k] + frame[d + 1] * invA;
            frame[d + 2] = sPb[k] + frame[d + 2] * invA;
          }
        }
      }

      ctx.putImageData(cached.frameImageData, 0, 0);
      animId = requestAnimationFrame(render);
    };

    animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, [sideLength, canvasRef, particlesRef]);

  return (
    <div className="w-full flex items-center justify-center p-1">
      <div className="relative w-full max-w-[min(80vw,560px,54vh)] aspect-square rounded-lg shadow-2xl overflow-hidden bg-black/80 ring-1 ring-slate-800">
        <canvas
          ref={canvasRef}
          data-testid="chladni-plate-canvas"
          className="w-full h-full block cursor-default"
        />
        <div
          ref={overlayRef}
          data-testid="resonant-frequency-overlay"
          data-visible="false"
          data-frequency-hz="0.00"
          data-pulse-opacity="0.000"
          aria-hidden="true"
          className="pointer-events-none select-none absolute top-3 left-3 px-2.5 py-1.5 rounded-md bg-slate-950/90 border border-slate-700/60 flex items-baseline gap-2 opacity-0 invisible"
        >
          <span className="text-[11px] font-medium text-slate-300/90 tracking-tight leading-none">
            Resonant lock
          </span>
          <span className="inline-flex items-baseline gap-1 leading-none">
            <span
              ref={overlayValueRef}
              data-testid="resonant-frequency-overlay-value"
              className="text-sm font-mono font-semibold tabular-nums text-sky-200 leading-none"
            >
              0.0
            </span>
            <span
              ref={overlayUnitRef}
              data-testid="resonant-frequency-overlay-unit"
              className="text-[11px] font-mono text-slate-400 leading-none"
            >
              Hz
            </span>
          </span>
        </div>
      </div>
    </div>
  );
};
