/**
 * ModalSpectrogram: Displays live dynamic modal displacements q_mn(t),
 * modal accelerations, generalized forces, and theoretical frequency comparison.
 */

import React from 'react';
import { BarChart2, Zap } from 'lucide-react';
import { ModalBank } from '../physics/modalSolver.ts';

interface ModalSpectrogramProps {
  modalBank: ModalBank;
}

export const ModalSpectrogram: React.FC<ModalSpectrogramProps> = ({ modalBank }) => {
  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 shadow-xl flex flex-col gap-3 text-slate-200">
      <div className="flex items-center justify-between border-b border-slate-800 pb-2">
        <div className="flex items-center gap-2">
          <BarChart2 className="w-5 h-5 text-emerald-400" />
          <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-200">
            Modal Coordinates &amp; Dynamic State
          </h2>
        </div>
        <div className="flex items-center gap-1 text-[11px] font-mono text-emerald-400 bg-emerald-950/40 px-2 py-0.5 rounded border border-emerald-800/50">
          <Zap className="w-3 h-3" />
          <span>SDOF RK4 Integrator</span>
        </div>
      </div>

      {/* Grid of Active Modes */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {modalBank.modes.map((mode) => {
          // Normalize displacement for bar display: typical amplitude ~ 1e-4 m (0.1 mm)
          const dispMm = mode.displacement * 1000;
          const absDispMm = Math.abs(dispMm);
          const barPercent = Math.min(100, (absDispMm / 0.15) * 100);

          return (
            <div
              key={`${mode.m}-${mode.n}`}
              className={`p-2.5 rounded-lg border flex flex-col justify-between ${
                mode.active
                  ? 'bg-slate-950/70 border-slate-700'
                  : 'bg-slate-950/30 border-slate-900 opacity-40'
              }`}
            >
              <div className="flex justify-between items-start mb-1.5">
                <div>
                  <span className="font-bold font-mono text-xs text-white">
                    Mode ({mode.m},{mode.n})
                  </span>
                  <span className="block text-[10px] font-mono text-slate-400">
                    f = {mode.frequency.toFixed(1)} Hz
                  </span>
                </div>
                <span className={`text-[10px] font-mono px-1 py-0.5 rounded ${
                  mode.active ? 'bg-indigo-950 text-indigo-300' : 'bg-slate-800 text-slate-500'
                }`}>
                  {mode.active ? 'ACTIVE' : 'OFF'}
                </span>
              </div>

              {/* Live amplitude bar */}
              <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden my-1">
                <div
                  className="bg-emerald-400 h-full transition-all duration-75"
                  style={{ width: `${barPercent}%` }}
                />
              </div>

              {/* Numerical Readouts */}
              <div className="text-[10px] font-mono text-slate-300 flex justify-between mt-1">
                <span>q: {dispMm >= 0 ? '+' : ''}{dispMm.toFixed(3)} mm</span>
                <span className="text-slate-500">Q: {mode.generalizedForce.toFixed(2)} N</span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="text-[11px] text-slate-400 border-t border-slate-800/80 pt-2 flex flex-wrap justify-between gap-1">
        <span>Modal Mass M = {modalBank.modes[0]?.modalMass.toFixed(4)} kg</span>
        <span>Theoretical Stiffness K_11 = {(modalBank.modes[0]?.modalStiffness || 0).toFixed(0)} N/m</span>
        <span>Units: q [m], dq/dt [m/s], d²q/dt² [m/s²], Q [N]</span>
      </div>
    </div>
  );
};
