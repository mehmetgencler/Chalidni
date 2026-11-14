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
import { Particle, ParticleColor } from '../physics/types.ts';
import { computeParticleRenderParams, SPRITE_BASE_PX } from './plateVisuals.ts';

export type HeatmapType = 'none' | 'diffusivity' | 'displacement' | 'nodal';

interface PlateCanvasProps {
  particles: Particle[];
  sideLength: number; // m
  canvasRefExternal?: React.RefObject<HTMLCanvasElement | null>;
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

const FALLBACK_COLORS: Record<ParticleColor, string> = {
  green: 'rgba(74, 222, 128, 0.95)',
  blue: 'rgba(96, 178, 252, 0.95)',
  red: 'rgba(248, 113, 113, 0.95)',
};

export const PlateCanvas: React.FC<PlateCanvasProps> = ({
  particles,
  sideLength,
  canvasRefExternal,
}) => {
  const internalCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const canvasRef = canvasRefExternal ?? internalCanvasRef;
  const particlesRef = useRef<Particle[]>(particles);
  particlesRef.current = particles;

  // Pre-rendered grain sprite tiers grouped by color ('green' | 'blue' | 'red')
  const spritesRef = useRef<Record<ParticleColor, HTMLCanvasElement[]> | null>(null);
  // Cached brushed aluminum plate background (only re-rendered when size or dpr changes)
  const plateSurfaceRef = useRef<{ canvas: HTMLCanvasElement; size: number; dpr: number } | null>(null);

  useEffect(() => {
    const s = SPRITE_BASE_PX;
    const banks: Record<ParticleColor, HTMLCanvasElement[]> = {
      green: [],
      blue: [],
      red: [],
    };

    (Object.keys(GRAIN_COLOR_TIERS) as ParticleColor[]).forEach((colorKey) => {
      const tiers = GRAIN_COLOR_TIERS[colorKey];
      for (let i = 0; i < tiers.length; i++) {
        const tier = tiers[i];
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
        banks[colorKey].push(sprite);
      }
    });
    spritesRef.current = banks;
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

      // 3. Render granular powder particles using per-particle color, radius & brightness
      const activeParticles = particlesRef.current;
      const scale = size / sideLength;
      const spriteBanks = spritesRef.current;

      if (spriteBanks && spriteBanks.green.length > 0) {
        const tierCount = spriteBanks.green.length;
        for (let i = 0; i < activeParticles.length; i++) {
          const p = activeParticles[i];
          if (!p.active) continue;

          const px = p.x * scale;
          const py = p.y * scale;
          const { spriteTier, drawSize } = computeParticleRenderParams(p, tierCount);
          const half = drawSize * 0.5;
          const colorKey: ParticleColor = p.color ?? 'green';
          const bank = spriteBanks[colorKey];

          ctx.drawImage(bank[spriteTier], px - half, py - half, drawSize, drawSize);
        }
      } else {
        for (let i = 0; i < activeParticles.length; i++) {
          const p = activeParticles[i];
          if (!p.active) continue;
          ctx.fillStyle = FALLBACK_COLORS[p.color ?? 'green'];
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
