/**
 * ControlPanel: Controls for Plate Physical Parameters, Active Modes,
 * Particle Transport Settings, and Display Overlays.
 */

import React from 'react';
import { Sliders, RefreshCw, Eye, Sparkles, Layers } from 'lucide-react';
import { PlateGeometry, PlateMaterial } from '../physics/types.ts';
import { ModalBank } from '../physics/modalSolver.ts';
import { DEFAULT_ALUMINUM } from '../physics/plate.ts';

const MATERIAL_PRESETS: PlateMaterial[] = [
  DEFAULT_ALUMINUM,
  {
    name: 'Structural Steel',
    youngsModulus: 200e9,
    density: 7850,
    poissonRatio: 0.30,
  },
  {
    name: 'Yellow Brass',
    youngsModulus: 105e9,
    density: 8500,
    poissonRatio: 0.35,
  },
];

interface ControlPanelProps {
  material: PlateMaterial;
  onMaterialChange: (m: PlateMaterial) => void;
  geometry: PlateGeometry;
  onGeometryChange: (g: PlateGeometry) => void;
  dampingRatio: number;
  onDampingChange: (z: number) => void;
  modalBank: ModalBank;
  onToggleMode: (index: number) => void;
  particleCount: number;
  onParticleCountChange: (count: number) => void;
  alphaCoupling: number;
  onAlphaCouplingChange: (alpha: number) => void;
  onResetParticles: () => void;
  onShakeParticles: () => void;
  showNodalLines: boolean;
  onToggleNodalLines: (show: boolean) => void;
  showHeatmap: boolean;
  onToggleHeatmap: (show: boolean) => void;
}

export const ControlPanel: React.FC<ControlPanelProps> = ({
  material,
  onMaterialChange,
  geometry,
  onGeometryChange,
  dampingRatio,
  onDampingChange,
  modalBank,
  onToggleMode,
  particleCount,
  onParticleCountChange,
  alphaCoupling,
  onAlphaCouplingChange,
  onResetParticles,
  onShakeParticles,
  showNodalLines,
  onToggleNodalLines,
  showHeatmap,
  onToggleHeatmap,
}) => {
  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 shadow-xl flex flex-col gap-4 text-slate-200">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-slate-800 pb-2">
        <Sliders className="w-5 h-5 text-indigo-400" />
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-200">
          Plate Physics &amp; Grain Dynamics
        </h2>
      </div>

      {/* Material Presets */}
      <div className="flex flex-col gap-1.5">
        <label className="text-xs text-slate-400 font-medium">Plate Material:</label>
        <div className="grid grid-cols-3 gap-1.5">
          {MATERIAL_PRESETS.map((m) => (
            <button
              key={m.name}
              onClick={() => onMaterialChange(m)}
              className={`px-2 py-1.5 text-xs rounded-lg border text-center transition ${
                material.name === m.name
                  ? 'bg-indigo-600 border-indigo-400 text-white font-medium shadow'
                  : 'bg-slate-800/80 border-slate-700 text-slate-300 hover:bg-slate-700'
              }`}
            >
              {m.name.split(' ')[0]}
            </button>
          ))}
        </div>
        <div className="text-[11px] font-mono text-slate-400 mt-0.5">
          E={(material.youngsModulus / 1e9).toFixed(0)}GPa | &rho;={material.density}kg/m&sup3; | &nu;={material.poissonRatio}
        </div>
      </div>

      {/* Dimensions & Damping */}
      <div className="grid grid-cols-2 gap-3 bg-slate-950/40 p-2.5 rounded-lg border border-slate-800">
        <div>
          <div className="flex justify-between text-xs mb-1">
            <span className="text-slate-400">Side L:</span>
            <span className="font-mono text-slate-200 font-semibold">{(geometry.sideLength * 100).toFixed(0)} cm</span>
          </div>
          <input
            type="range"
            min="0.15"
            max="0.50"
            step="0.01"
            value={geometry.sideLength}
            onChange={(e) => onGeometryChange({ ...geometry, sideLength: parseFloat(e.target.value) })}
            className="w-full accent-indigo-500 cursor-pointer"
          />
        </div>
        <div>
          <div className="flex justify-between text-xs mb-1">
            <span className="text-slate-400">Thickness h:</span>
            <span className="font-mono text-slate-200 font-semibold">{(geometry.thickness * 1000).toFixed(1)} mm</span>
          </div>
          <input
            type="range"
            min="0.0005"
            max="0.003"
            step="0.0001"
            value={geometry.thickness}
            onChange={(e) => onGeometryChange({ ...geometry, thickness: parseFloat(e.target.value) })}
            className="w-full accent-indigo-500 cursor-pointer"
          />
        </div>
        <div className="col-span-2">
          <div className="flex justify-between text-xs mb-1">
            <span className="text-slate-400">Damping Ratio (&zeta;):</span>
            <span className="font-mono text-slate-200 font-semibold">{(dampingRatio * 100).toFixed(1)}%</span>
          </div>
          <input
            type="range"
            min="0.002"
            max="0.05"
            step="0.001"
            value={dampingRatio}
            onChange={(e) => onDampingChange(parseFloat(e.target.value))}
            className="w-full accent-indigo-500 cursor-pointer"
          />
        </div>
      </div>

      {/* Active Modes Matrix */}
      <div className="flex flex-col gap-1.5">
        <label className="text-xs text-slate-400 font-medium flex items-center justify-between">
          <span>Active Eigenmodes (Kirchhoff Analytical):</span>
          <span className="text-[11px] text-slate-500">Toggle superposition</span>
        </label>
        <div className="grid grid-cols-4 gap-1.5">
          {modalBank.modes.map((mode, idx) => (
            <button
              key={`${mode.m}-${mode.n}`}
              onClick={() => onToggleMode(idx)}
              className={`p-1.5 rounded border text-center transition flex flex-col items-center ${
                mode.active
                  ? 'bg-slate-800 border-indigo-500 text-indigo-300 shadow-sm'
                  : 'bg-slate-950/60 border-slate-800 text-slate-500 hover:text-slate-400'
              }`}
            >
              <span className="text-xs font-bold font-mono">({mode.m},{mode.n})</span>
              <span className="text-[10px] font-mono">{mode.frequency.toFixed(1)} Hz</span>
            </button>
          ))}
        </div>
      </div>

      {/* Particle Transport Configuration */}
      <div className="flex flex-col gap-2 pt-1 border-t border-slate-800">
        <div className="flex justify-between items-center">
          <label className="text-xs text-slate-400 font-medium flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-amber-400" />
            <span>Particle Count (Itô SDE):</span>
          </label>
          <div className="flex gap-1">
            {[500, 1000, 2000, 4000].map((cnt) => (
              <button
                key={cnt}
                onClick={() => onParticleCountChange(cnt)}
                className={`px-2 py-0.5 text-[11px] rounded font-mono border transition ${
                  particleCount === cnt
                    ? 'bg-amber-600 border-amber-400 text-white font-bold'
                    : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-200'
                }`}
              >
                {cnt}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="flex justify-between text-xs mb-1">
            <span className="text-slate-400">Vibration Diffusivity Coupling (&alpha;):</span>
            <span className="font-mono text-slate-200 font-semibold">{alphaCoupling.toFixed(1)}x</span>
          </div>
          <input
            type="range"
            min="0.1"
            max="4.0"
            step="0.1"
            value={alphaCoupling}
            onChange={(e) => onAlphaCouplingChange(parseFloat(e.target.value))}
            className="w-full accent-amber-500 cursor-pointer"
          />
        </div>

        <div className="grid grid-cols-2 gap-2 mt-1">
          <button
            onClick={onShakeParticles}
            className="flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700 transition"
          >
            <Sparkles className="w-3.5 h-3.5 text-amber-400" />
            <span>Scatter Grains</span>
          </button>
          <button
            onClick={onResetParticles}
            className="flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700 transition"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Redistribute (Reset)</span>
          </button>
        </div>
      </div>

      {/* Visual Display Toggles */}
      <div className="flex items-center justify-between pt-1 border-t border-slate-800 text-xs">
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={showNodalLines}
            onChange={(e) => onToggleNodalLines(e.target.checked)}
            className="rounded accent-amber-500"
          />
          <span className="text-slate-300">Nodal Lines (&phi;=0)</span>
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={showHeatmap}
            onChange={(e) => onToggleHeatmap(e.target.checked)}
            className="rounded accent-sky-500"
          />
          <span className="text-slate-300">Surface Heatmap</span>
        </label>
      </div>
    </div>
  );
};
