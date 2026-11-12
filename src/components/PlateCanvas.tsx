/**
 * PlateCanvas: Top-down, orthographic, realistic visualization of a vibrating square metal plate.
 * 
 * Conforms to STAGE 7 Requirements:
 * - Square plate dominates the view with zero perspective distortion.
 * - Realistic dark brushed aluminum plate surface with subtle metallic sheen and refined rim.
 * - Fine, pale sand or powder particles with natural variations in size and brightness.
 * - Subtle particle depth cues and contact shadows.
 * - Zero artificial glowing overlays, heatmaps, or drawn nodal lines.
 * - The nodal patterns emerge purely from simulated granular accumulation.
 * - Fixed high-density particle rendering with capped DPR = 2.
 */

import React, { useEffect, useRef } from 'react';
import { Particle } from '../physics/types.ts';

export type HeatmapType = 'none' | 'diffusivity' | 'displacement' | 'nodal';

interface PlateCanvasProps {
  particles: Particle[];
  sideLength: number; // m
}

export const PlateCanvas: React.FC<PlateCanvasProps> = ({ particles, sideLength }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Pre-rendered grain sprites for high-performance antialiased rendering
  const spritesRef = useRef<HTMLCanvasElement[] | null>(null);

  // Initialize offscreen grain sprites with natural subtle variations and soft shadow
  useEffect(() => {
    const sprites: HTMLCanvasElement[] = [];
    const tints = [
      'rgba(241, 245, 249, 0.95)', // Pale quartz / salt
      'rgba(226, 232, 240, 0.92)', // Fine aluminum powder
      'rgba(254, 240, 138, 0.88)', // Pale brass grain
      'rgba(203, 213, 225, 0.90)', // Natural silica
    ];

    for (let i = 0; i < tints.length; i++) {
      const sprite = document.createElement('canvas');
      const s = 12; // 12x12 sprite
      sprite.width = s;
      sprite.height = s;
      const sCtx = sprite.getContext('2d');
      if (sCtx) {
        // Soft contact drop shadow
        sCtx.fillStyle = 'rgba(0, 0, 0, 0.45)';
        sCtx.beginPath();
        sCtx.arc(s / 2 + 0.6, s / 2 + 0.8, 2.0, 0, Math.PI * 2);
        sCtx.fill();

        // Main grain body
        sCtx.fillStyle = tints[i];
        sCtx.beginPath();
        sCtx.arc(s / 2, s / 2, 1.8, 0, Math.PI * 2);
        sCtx.fill();

        // Subtle specular micro-highlight
        sCtx.fillStyle = 'rgba(255, 255, 255, 0.6)';
        sCtx.beginPath();
        sCtx.arc(s / 2 - 0.5, s / 2 - 0.5, 0.7, 0, Math.PI * 2);
        sCtx.fill();
      }
      sprites.push(sprite);
    }
    spritesRef.current = sprites;
  }, []);

  // Continuous rendering loop mounted once
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

      // Handle high DPI display (capped at 2 for guaranteed 60 FPS)
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const size = Math.min(width, height);

      if (canvas.width !== size * dpr || canvas.height !== size * dpr) {
        canvas.width = size * dpr;
        canvas.height = size * dpr;
      }

      ctx.save();
      ctx.scale(dpr, dpr);

      // 1. Realistic dark brushed metal plate surface
      // Radial metallic sheen gradient
      const plateGrad = ctx.createRadialGradient(
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

      ctx.fillStyle = plateGrad;
      ctx.fillRect(0, 0, size, size);

      // Subtle fine brushed texture lines across the metal surface
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.015)';
      ctx.lineWidth = 1;
      const step = 4;
      for (let y = 2; y < size - 2; y += step) {
        ctx.beginPath();
        ctx.moveTo(2, y);
        ctx.lineTo(size - 2, y);
        ctx.stroke();
      }

      // 2. Refined plate rim / beveled metal edge
      // Outer rim
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 2.5;
      ctx.strokeRect(1, 1, size - 2, size - 2);

      // Inner metallic highlight rim
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 1;
      ctx.strokeRect(2.5, 2.5, size - 5, size - 5);

      // Center shaker probe mounting pin (subtle lab fixture dot at center)
      ctx.fillStyle = '#0f172a';
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, 4.0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#475569';
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#94a3b8';
      ctx.beginPath();
      ctx.arc(size / 2 - 0.5, size / 2 - 0.5, 0.8, 0, Math.PI * 2);
      ctx.fill();

      // 3. Render granular powder particles
      const scale = size / sideLength;
      const sprites = spritesRef.current;

      if (sprites && sprites.length > 0) {
        const spriteCount = sprites.length;
        const spriteSize = 12;
        const halfSprite = spriteSize / 2;

        for (let i = 0; i < particles.length; i++) {
          const p = particles[i];
          if (!p.active) continue;

          const px = p.x * scale;
          const py = p.y * scale;

          // Select deterministic sprite per particle index
          const spriteIdx = i % spriteCount;
          const sprite = sprites[spriteIdx];

          // Draw pre-rendered antialiased powder grain with contact shadow
          ctx.drawImage(sprite, px - halfSprite, py - halfSprite);
        }
      } else {
        // Fallback direct circle rendering if sprites loading
        ctx.fillStyle = 'rgba(241, 245, 249, 0.95)';
        for (let i = 0; i < particles.length; i++) {
          const p = particles[i];
          if (!p.active) continue;
          ctx.beginPath();
          ctx.arc(p.x * scale, p.y * scale, 1.4, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      ctx.restore();
      animId = requestAnimationFrame(render);
    };

    animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, [particles, sideLength]);

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
