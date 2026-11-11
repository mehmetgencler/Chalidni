/**
 * PlateCanvas: High-performance Canvas rendering of the vibrating plate,
 * particle positions, true total-field nodal contours, and physical heatmaps.
 * 
 * PRIORITY 5: Continuous 60 FPS canvas loop decoupled from React state updates.
 * Renders actual displacement w(x,y,t), RMS acceleration a_rms(x,y),
 * particle density, or diffusivity fields.
 * Nodal overlay draws either single-mode lines or combined zero contours.
 */

import React, { useEffect, useRef } from 'react';
import { Particle } from '../physics/types.ts';
import { ModalBank } from '../physics/modalSolver.ts';
import { ParticleTransportSystem } from '../physics/particleTransport.ts';
import { modeShape } from '../physics/plate.ts';

export type HeatmapType = 'none' | 'rmsAcceleration' | 'displacement' | 'diffusivity' | 'density';

interface PlateCanvasProps {
  particles: Particle[];
  particleSystem: ParticleTransportSystem;
  modalBank: ModalBank;
  sideLength: number; // m
  shakerPos: { x: number; y: number }; // [0, 1] normalized
  isPointForce: boolean;
  onSetShakerPos: (pos: { x: number; y: number }) => void;
  showNodalLines: boolean;
  heatmapType: HeatmapType;
}

export const PlateCanvas: React.FC<PlateCanvasProps> = (props) => {
  const { isPointForce, onSetShakerPos } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const isDraggingRef = useRef(false);

  // Keep latest props in ref so continuous RAF loop always accesses latest physics state
  const propsRef = useRef(props);
  useEffect(() => {
    propsRef.current = props;
  });

  // PRIORITY 5: Continuous rendering loop mounted once
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

      const currentProps = propsRef.current;
      const {
        particles,
        particleSystem,
        modalBank,
        sideLength,
        shakerPos,
        isPointForce: currentIsPointForce,
        showNodalLines,
        heatmapType,
      } = currentProps;

      // Handle high DPI (capped at 2 for performance)
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

      // 1. Draw plate base
      ctx.fillStyle = '#090d16'; // Deep metallic slate plate background
      ctx.fillRect(0, 0, size, size);

      // Plate metallic rim
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 2;
      ctx.strokeRect(1, 1, size - 2, size - 2);

      // 2. Heatmap: True Physical Field Visualization
      if (heatmapType !== 'none') {
        const heatGrid = 40;
        const cellPx = size / heatGrid;

        if (heatmapType === 'density') {
          // 2A. Particle Density Histogram
          const { density } = particleSystem.computeDensityGrid(heatGrid);
          let maxD = 0;
          for (let i = 0; i < density.length; i++) {
            if (density[i] > maxD) maxD = density[i];
          }
          maxD = Math.max(1e-6, maxD);

          for (let j = 0; j < heatGrid; j++) {
            for (let i = 0; i < heatGrid; i++) {
              const val = density[j * heatGrid + i] / maxD;
              if (val > 0.05) {
                const alpha = Math.min(0.6, val * 0.7);
                ctx.fillStyle = `rgba(56, 189, 248, ${alpha})`; // sky blue
                ctx.fillRect(i * cellPx, j * cellPx, cellPx + 0.5, cellPx + 0.5);
              }
            }
          }
        } else {
          // 2B. Physical continuous fields: a_rms, displacement w(x,y,t), or D_g(x,y)
          for (let j = 0; j < heatGrid; j++) {
            const y = ((j + 0.5) / heatGrid) * sideLength;
            for (let i = 0; i < heatGrid; i++) {
              const x = ((i + 0.5) / heatGrid) * sideLength;

              let normVal = 0;
              let r = 15;
              let g = 23;
              let b = 42;
              let alpha = 0.2;

              if (heatmapType === 'rmsAcceleration') {
                const aRms = modalBank.evaluateRmsAcceleration(x, y);
                // Scaled relative to gravity g = 9.81 m/s^2 (typically 0 to 5g)
                normVal = Math.min(1.0, aRms / (3 * 9.80665));
                r = Math.floor(15 + normVal * 40);
                g = Math.floor(23 + normVal * 120);
                b = Math.floor(42 + normVal * 200);
                alpha = 0.15 + normVal * 0.55;
              } else if (heatmapType === 'displacement') {
                const w = modalBank.evaluateDisplacement(x, y);
                normVal = Math.min(1.0, Math.abs(w) / 1e-4); // typical 0.1mm scale
                if (w >= 0) {
                  r = 30; g = Math.floor(80 + normVal * 150); b = 240;
                } else {
                  r = Math.floor(180 + normVal * 70); g = 40; b = 70;
                }
                alpha = 0.15 + normVal * 0.5;
              } else if (heatmapType === 'diffusivity') {
                const aRms = modalBank.evaluateRmsAcceleration(x, y);
                const D_g = particleSystem.evaluateDimensionalDiffusivity(aRms);
                normVal = Math.min(1.0, D_g / (2 * particleSystem.config.dRef));
                r = Math.floor(180 * normVal);
                g = Math.floor(100 * normVal);
                b = Math.floor(220 * normVal);
                alpha = 0.1 + normVal * 0.5;
              }

              ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
              ctx.fillRect(i * cellPx, j * cellPx, cellPx + 0.5, cellPx + 0.5);
            }
          }
        }
      }

      // 3. Nodal Overlay — Explicit Distinction: Single-Mode Lines, Low-RMS Mask, and Total Zero Contours
      if (showNodalLines) {
        const activeModes = modalBank.modes.filter((m) => m.active);

        if (activeModes.length === 1) {
          // Exact analytical straight lines for pure single mode (m, n)
          const m = activeModes[0].m;
          const n = activeModes[0].n;
          ctx.strokeStyle = 'rgba(234, 179, 8, 0.75)'; // amber-500 line
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 4]);

          for (let k = 1; k < m; k++) {
            const px = (k / m) * size;
            ctx.beginPath();
            ctx.moveTo(px, 0);
            ctx.lineTo(px, size);
            ctx.stroke();
          }
          for (let l = 1; l < n; l++) {
            const py = (l / n) * size;
            ctx.beginPath();
            ctx.moveTo(0, py);
            ctx.lineTo(size, py);
            ctx.stroke();
          }
          ctx.setLineDash([]);
        } else if (activeModes.length > 1) {
          // A. Low-Vibration Zone Mask (a_rms <= 0.12 * max_a_rms)
          const sampleN = 50;
          const step = size / sampleN;
          let maxRms = 0;

          for (let j = 0; j <= sampleN; j += 5) {
            const y = (j / sampleN) * sideLength;
            for (let i = 0; i <= sampleN; i += 5) {
              const x = (i / sampleN) * sideLength;
              const val = modalBank.evaluateRmsAcceleration(x, y);
              if (val > maxRms) maxRms = val;
            }
          }

          if (maxRms > 1e-4) {
            const threshold = maxRms * 0.12;
            ctx.fillStyle = 'rgba(234, 179, 8, 0.18)'; // Low-vibration zone tint

            for (let j = 0; j < sampleN; j++) {
              const y = ((j + 0.5) / sampleN) * sideLength;
              for (let i = 0; i < sampleN; i++) {
                const x = ((i + 0.5) / sampleN) * sideLength;
                const aRms = modalBank.evaluateRmsAcceleration(x, y);
                if (aRms <= threshold) {
                  ctx.fillRect(i * step, j * step, step, step);
                }
              }
            }
          }

          // B. Instantaneous Total Displacement Zero Contours: w(x, y, t) = 0
          ctx.strokeStyle = 'rgba(56, 189, 248, 0.85)'; // sky-400 zero-contour segments
          ctx.lineWidth = 1.0;
          const cN = 36;
          const cStep = size / cN;
          const dispGrid = new Float64Array((cN + 1) * (cN + 1));

          for (let j = 0; j <= cN; j++) {
            const y = (j / cN) * sideLength;
            for (let i = 0; i <= cN; i++) {
              const x = (i / cN) * sideLength;
              dispGrid[j * (cN + 1) + i] = modalBank.evaluateDisplacement(x, y);
            }
          }

          ctx.beginPath();
          for (let j = 0; j < cN; j++) {
            for (let i = 0; i < cN; i++) {
              const v00 = dispGrid[j * (cN + 1) + i];
              const v10 = dispGrid[j * (cN + 1) + (i + 1)];
              const v01 = dispGrid[(j + 1) * (cN + 1) + i];

              if (v00 * v10 < 0) {
                const frac = Math.abs(v00) / (Math.abs(v00) + Math.abs(v10));
                const zx = (i + frac) * cStep;
                const zy = j * cStep;
                ctx.moveTo(zx - 1, zy);
                ctx.lineTo(zx + 1, zy);
              }
              if (v00 * v01 < 0) {
                const frac = Math.abs(v00) / (Math.abs(v00) + Math.abs(v01));
                const zx = i * cStep;
                const zy = (j + frac) * cStep;
                ctx.moveTo(zx, zy - 1);
                ctx.lineTo(zx, zy + 1);
              }
            }
          }
          ctx.stroke();
        }
      }

      // 4. Draw Particles (Crisp granular salt/sand particles)
      const scale = size / sideLength;
      ctx.fillStyle = '#f8fafc'; // Clean sand/salt grains

      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        if (!p.active) continue;

        const px = p.x * scale;
        const py = p.y * scale;

        ctx.beginPath();
        ctx.arc(px, py, 1.25, 0, Math.PI * 2);
        ctx.fill();
      }

      // 5. Draw Excitation Shaker Point (if point force enabled)
      if (currentIsPointForce) {
        const sx = shakerPos.x * size;
        const sy = shakerPos.y * size;

        ctx.strokeStyle = '#ef4444';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(sx, sy, 8, 0, Math.PI * 2);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(sx - 12, sy);
        ctx.lineTo(sx + 12, sy);
        ctx.moveTo(sx, sy - 12);
        ctx.lineTo(sx, sy + 12);
        ctx.stroke();

        ctx.fillStyle = '#ef4444';
        ctx.beginPath();
        ctx.arc(sx, sy, 3, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();
      animId = requestAnimationFrame(render);
    };

    animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, []);

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isPointForce) return;
    isDraggingRef.current = true;
    updateShakerFromEvent(e);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (isDraggingRef.current && isPointForce) {
      updateShakerFromEvent(e);
    }
  };

  const handlePointerUp = () => {
    isDraggingRef.current = false;
  };

  const updateShakerFromEvent = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const xNorm = Math.max(0.01, Math.min(0.99, (e.clientX - rect.left) / rect.width));
    const yNorm = Math.max(0.01, Math.min(0.99, (e.clientY - rect.top) / rect.height));
    onSetShakerPos({ x: xNorm, y: yNorm });
  };

  return (
    <div className="relative w-full aspect-square max-w-[620px] mx-auto rounded-xl overflow-hidden shadow-2xl border border-slate-700 bg-slate-950 flex items-center justify-center">
      <canvas
        ref={canvasRef}
        data-testid="plate-canvas"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        className={`w-full h-full block ${isPointForce ? 'cursor-crosshair' : 'cursor-default'}`}
      />
      <div className="absolute top-2 left-2 bg-slate-900/80 backdrop-blur border border-slate-700 rounded px-2 py-1 text-xs font-mono text-slate-300">
        L = {(props.sideLength * 100).toFixed(0)} cm (Simply Supported)
      </div>
      {isPointForce && (
        <div className="absolute bottom-2 left-2 bg-slate-900/85 backdrop-blur border border-red-500/50 rounded px-2 py-1 text-xs font-mono text-red-300 flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span>
          Shaker: ({(props.shakerPos.x * props.sideLength).toFixed(3)}m, {(props.shakerPos.y * props.sideLength).toFixed(3)}m)
        </div>
      )}
    </div>
  );
};
