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
import { Particle } from '../physics/types.ts';
import { computeParticleRenderParams, SPRITE_BASE_PX } from './plateVisuals.ts';

export type HeatmapType = 'none' | 'diffusivity' | 'displacement' | 'nodal';

interface PlateCanvasProps {
  particles: Particle[];
  sideLength: number; // m
  canvasRefExternal?: React.RefObject<HTMLCanvasElement | null>;
}

const GRAIN_SPRITE_TIERS = [
  { body: 'rgba(198, 206, 218, 0.80)', spec: 'rgba(255, 255, 255, 0.35)' }, // Dimmer cool silica
  { body: 'rgba(215, 222, 232, 0.86)', spec: 'rgba(255, 255, 255, 0.44)' }, // Soft quartz
  { body: 'rgba(232, 236, 240, 0.90)', spec: 'rgba(255, 255, 255, 0.52)' }, // Pale aluminum powder
  { body: 'rgba(246, 241, 214, 0.92)', spec: 'rgba(255, 255, 255, 0.58)' }, // Warm fine sand
  { body: 'rgba(244, 247, 251, 0.95)', spec: 'rgba(255, 255, 255, 0.68)' }, // Bright quartz
  { body: 'rgba(254, 246, 198, 0.96)', spec: 'rgba(255, 255, 255, 0.78)' }, // High-luminance pale grain
];

export const PlateCanvas: React.FC<PlateCanvasProps> = ({
  particles,
  sideLength,
  canvasRefExternal,
}) => {
  const internalCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const canvasRef = canvasRefExternal ?? internalCanvasRef;
  const particlesRef = useRef<Particle[]>(particles);
  particlesRef.current = particles;

  // Pre-rendered grain sprite tiers ordered by luminance/tint
  const spritesRef = useRef<HTMLCanvasElement[] | null>(null);
  // Cached brushed aluminum plate background (only re-rendered when size or dpr changes)
  const plateSurfaceRef = useRef<{ canvas: HTMLCanvasElement; size: number; dpr: number } | null>(null);

  useEffect(() => {
    const sprites: HTMLCanvasElement[] = [];
    const s = SPRITE_BASE_PX;

    for (let i = 0; i < GRAIN_SPRITE_TIERS.length; i++) {
      const tier = GRAIN_SPRITE_TIERS[i];
      const sprite = document.createElement('canvas');
      sprite.width = s;
      sprite.height = s;
      const sCtx = sprite.getContext('2d');
      if (sCtx) {
        // Subtle pre-baked contact drop shadow
        sCtx.fillStyle = 'rgba(0, 0, 0, 0.42)';
        sCtx.beginPath();
        sCtx.arc(s / 2 + 0.55, s / 2 + 0.75, 2.0, 0, Math.PI * 2);
        sCtx.fill();

        // Main grain body
        sCtx.fillStyle = tier.body;
        sCtx.beginPath();
        sCtx.arc(s / 2, s / 2, 1.85, 0, Math.PI * 2);
        sCtx.fill();

        // Subtle specular micro-highlight
        sCtx.fillStyle = tier.spec;
        sCtx.beginPath();
        sCtx.arc(s / 2 - 0.5, s / 2 - 0.5, 0.7, 0, Math.PI * 2);
        sCtx.fill();
      }
      sprites.push(sprite);
    }
    spritesRef.current = sprites;
  }, []);

  // Pure rendering loop (never advances physics or particle transport)
  useEffect(() => {
    let animId: number;

    const render = () => {
      const canvas = canvasRef.current;
      if (!canvas) {
        animId = requestAnimationFrame(render);
        return;
      }

      const ctx = canvas.getContext('2d');
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

      // Build or reuse cached brushed metal plate surface
      let cached = plateSurfaceRef.current;
      if (!cached || cached.size !== size || cached.dpr !== dpr) {
        const off = document.createElement('canvas');
        off.width = targetPx;
        off.height = targetPx;
        const oCtx = off.getContext('2d');
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
        cached = { canvas: off, size, dpr };
        plateSurfaceRef.current = cached;
      }

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.drawImage(cached.canvas, 0, 0, size, size);

      // 3. Render granular powder particles using per-particle radius & brightness
      const activeParticles = particlesRef.current;
      const scale = size / sideLength;
      const sprites = spritesRef.current;

      if (sprites && sprites.length > 0) {
        const tierCount = sprites.length;
        for (let i = 0; i < activeParticles.length; i++) {
          const p = activeParticles[i];
          if (!p.active) continue;

          const px = p.x * scale;
          const py = p.y * scale;
          const { spriteTier, drawSize } = computeParticleRenderParams(p, tierCount);
          const half = drawSize * 0.5;

          ctx.drawImage(sprites[spriteTier], px - half, py - half, drawSize, drawSize);
        }
      } else {
        ctx.fillStyle = 'rgba(241, 245, 249, 0.95)';
        for (let i = 0; i < activeParticles.length; i++) {
          const p = activeParticles[i];
          if (!p.active) continue;
          ctx.beginPath();
          ctx.arc(p.x * scale, p.y * scale, p.radius ?? 1.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      ctx.restore();
      animId = requestAnimationFrame(render);
    };

    animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, [sideLength, canvasRef]);

  return (
    <div className="w-full flex items-center justify-center p-2">
      <div className="relative w-full max-w-[min(80vw,560px)] aspect-square rounded-lg shadow-2xl overflow-hidden bg-black/80 ring-1 ring-slate-800">
        <canvas
          ref={canvasRef}
          data-testid="chladni-plate-canvas"
          className="w-full h-full block cursor-default"
        />
      </div>
    </div>
  );
};
