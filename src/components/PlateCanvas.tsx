/**
 * PlateCanvas: High-performance 2D Canvas rendering of the vibrating plate,
 * particle positions, nodal lines, and displacement/acceleration fields.
 */

import React, { useEffect, useRef } from 'react';
import { Particle } from '../physics/types.ts';
import { ModalBank } from '../physics/modalSolver.ts';
import { modeShape } from '../physics/plate.ts';

interface PlateCanvasProps {
  particles: Particle[];
  modalBank: ModalBank;
  sideLength: number; // m
  shakerPos: { x: number; y: number }; // [0, 1] normalized
  isPointForce: boolean;
  onSetShakerPos: (pos: { x: number; y: number }) => void;
  showNodalLines: boolean;
  showHeatmap: boolean;
  activeModeIndex?: { m: number; n: number };
}

export const PlateCanvas: React.FC<PlateCanvasProps> = ({
  particles,
  modalBank,
  sideLength,
  shakerPos,
  isPointForce,
  onSetShakerPos,
  showNodalLines,
  showHeatmap,
  activeModeIndex = { m: 1, n: 1 },
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const isDraggingRef = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Handle high DPI
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const size = Math.min(width, height);

    if (canvas.width !== size * dpr || canvas.height !== size * dpr) {
      canvas.width = size * dpr;
      canvas.height = size * dpr;
    }

    ctx.save();
    ctx.scale(dpr, dpr);

    // 1. Draw plate boundary and base surface
    ctx.fillStyle = '#0f172a'; // slate-900 plate background
    ctx.fillRect(0, 0, size, size);

    // Plate metallic rim
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, size - 2, size - 2);

    // 2. Optional: Draw displacement / acceleration heatmap
    if (showHeatmap) {
      const heatGrid = 40;
      const cellPx = size / heatGrid;
      for (let j = 0; j < heatGrid; j++) {
        const yNorm = (j + 0.5) / heatGrid;
        const y = yNorm * sideLength;
        for (let i = 0; i < heatGrid; i++) {
          const xNorm = (i + 0.5) / heatGrid;
          const x = xNorm * sideLength;

          // Combined active modes amplitude
          let ampNorm = 0;
          for (const m of modalBank.modes) {
            if (m.active) {
              const phi = modeShape(m.m, m.n, x, y, sideLength);
              ampNorm += Math.abs(phi);
            }
          }
          ampNorm = Math.min(1, ampNorm * 0.7);

          // Color: Slate to Cyan/Blue intensity
          const r = Math.floor(15 + ampNorm * 30);
          const g = Math.floor(23 + ampNorm * 130);
          const b = Math.floor(42 + ampNorm * 210);
          const alpha = 0.15 + ampNorm * 0.45;

          ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
          ctx.fillRect(i * cellPx, j * cellPx, cellPx + 0.5, cellPx + 0.5);
        }
      }
    }

    // 3. Optional: Analytical Nodal Lines Overlay
    if (showNodalLines) {
      ctx.strokeStyle = 'rgba(234, 179, 8, 0.4)'; // amber-500 line
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);

      // Nodal lines occur where phi_mn(x, y) = 0
      // For mode (m, n), nodal lines are at x = k * L / m (k = 1..m-1) and y = l * L / n (l = 1..n-1)
      for (const mode of modalBank.modes) {
        if (!mode.active) continue;
        const m = mode.m;
        const n = mode.n;

        // Vertical nodal lines
        for (let k = 1; k < m; k++) {
          const px = (k / m) * size;
          ctx.beginPath();
          ctx.moveTo(px, 0);
          ctx.lineTo(px, size);
          ctx.stroke();
        }

        // Horizontal nodal lines
        for (let l = 1; l < n; l++) {
          const py = (l / n) * size;
          ctx.beginPath();
          ctx.moveTo(0, py);
          ctx.lineTo(size, py);
          ctx.stroke();
        }
      }
      ctx.setLineDash([]);
    }

    // 4. Draw Particles (Chladni dry sand/salt grains)
    const scale = size / sideLength;
    ctx.fillStyle = '#f8fafc'; // Crisp off-white grain

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (!p.active) continue;

      const px = p.x * scale;
      const py = p.y * scale;

      // Small round grain
      ctx.beginPath();
      ctx.arc(px, py, 1.25, 0, Math.PI * 2);
      ctx.fill();
    }

    // 5. Draw Excitation Shaker Point (if point force enabled)
    if (isPointForce) {
      const sx = shakerPos.x * size;
      const sy = shakerPos.y * size;

      // Outer target glow
      ctx.strokeStyle = '#ef4444'; // Red shaker probe
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx, sy, 8, 0, Math.PI * 2);
      ctx.stroke();

      // Center crosshair
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
  }, [particles, modalBank, sideLength, shakerPos, isPointForce, showNodalLines, showHeatmap, activeModeIndex]);

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
      {/* Corner coordinate badge */}
      <div className="absolute top-2 left-2 bg-slate-900/80 backdrop-blur border border-slate-700 rounded px-2 py-1 text-xs font-mono text-slate-300">
        L = {(sideLength * 100).toFixed(0)} cm (Simply Supported)
      </div>
      {isPointForce && (
        <div className="absolute bottom-2 left-2 bg-slate-900/85 backdrop-blur border border-red-500/50 rounded px-2 py-1 text-xs font-mono text-red-300 flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span>
          Shaker: ({(shakerPos.x * sideLength).toFixed(3)}m, {(shakerPos.y * sideLength).toFixed(3)}m)
        </div>
      )}
    </div>
  );
};
