/**
 * LimitationsModal: Explicit disclosure of physical assumptions,
 * boundary conditions, and scientific domain limitations (Section 7).
 */

import React from 'react';
import { X, AlertTriangle, BookOpen, Check } from 'lucide-react';

interface LimitationsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const LimitationsModal: React.FC<LimitationsModalProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto shadow-2xl p-6 text-slate-200 flex flex-col gap-5">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2">
            <BookOpen className="w-5 h-5 text-indigo-400" />
            <h2 className="text-base font-bold text-white">
              Scientific Model Scope &amp; Physical Limitations
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Warning Banner */}
        <div className="bg-amber-950/40 border border-amber-800/80 p-3.5 rounded-xl flex items-start gap-3 text-amber-200 text-xs leading-relaxed">
          <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          <div>
            <strong className="block text-amber-300 font-semibold mb-1">
              Important Scientific Notice (Audit Section 7)
            </strong>
            This simulation uses rigorous analytical Kirchhoff-Love plate theory coupled with an
            Itô stochastic differential equation (SDE) for dry macroscopic grain transport. It is
            <strong> not</strong> a fully resolved 3D continuum Finite Element Method (FEM) or
            Discrete Element Method (DEM) contact simulator.
          </div>
        </div>

        {/* Breakdown of Subsystems */}
        <div className="flex flex-col gap-4 text-xs">
          {/* 1 */}
          <div className="bg-slate-950/70 p-3.5 rounded-xl border border-slate-800">
            <h3 className="font-semibold text-sky-400 text-sm mb-1">
              1. Analytical Kirchhoff-Love Plate Solution
            </h3>
            <p className="text-slate-300 leading-relaxed">
              Natural frequencies and mode shapes are computed using thin-plate theory for an
              ideal square plate with simply supported (SS) edges on all four boundaries.
              Rotary inertia, transverse shear deformation (Mindlin-Reissner effects), and clamping
              edge boundary boundary layers are neglected. For thin plates (h/L &le; 0.005), this
              matches experimental natural frequencies within &lt; 1%.
            </p>
          </div>

          {/* 2 */}
          <div className="bg-slate-950/70 p-3.5 rounded-xl border border-slate-800">
            <h3 className="font-semibold text-sky-400 text-sm mb-1">
              2. Audio-to-Force / Audio-to-Pressure Calibration
            </h3>
            <p className="text-slate-300 leading-relaxed">
              Coupling from incoming waveforms (microphone, uploaded file, or internal test generator)
              is modeled as either:
            </p>
            <ul className="list-disc list-inside mt-1.5 space-y-1 text-slate-400">
              <li>
                <strong>Point Force (Electrodynamic Shaker):</strong> Force F(t) applied at
                coordinates (x₀, y₀), exciting modes via &phi;<sub>mn</sub>(x₀, y₀).
              </li>
              <li>
                <strong>Uniform Acoustic Pressure Field:</strong> Incident sound pressure p(t)
                integrated over the plate area. As proven analytically, this excites
                <strong> only odd-odd modes</strong> (e.g., 1,1; 1,3; 3,3) and produces zero generalized
                force on antisymmetric modes (1,2; 2,1; 2,2).
              </li>
            </ul>
          </div>

          {/* 3 */}
          <div className="bg-slate-950/70 p-3.5 rounded-xl border border-slate-800">
            <h3 className="font-semibold text-sky-400 text-sm mb-1">
              3. Reduced Itô Particle Transport Model
            </h3>
            <p className="text-slate-300 leading-relaxed">
              Dry grains (sand/salt, diameter &gt; 100 &mu;m) undergo ballistic bounces driven by plate
              acceleration. In the continuous limit, this is modeled by the Itô stochastic differential
              equation:
            </p>
            <div className="bg-slate-900 font-mono text-[11px] p-2 rounded my-1.5 text-center text-emerald-400">
              dX = &radic;(2D<sub>g</sub>) dW<sub>x</sub>, &nbsp;&nbsp; dY = &radic;(2D<sub>g</sub>) dW<sub>y</sub>
            </div>
            <p className="text-slate-300 leading-relaxed">
              Under reflecting boundaries, the stationary particle density approaches:
            </p>
            <div className="bg-slate-900 font-mono text-[11px] p-2 rounded my-1.5 text-center text-emerald-400">
              c(x, y) &prop; 1 / D<sub>g</sub>(x, y)
            </div>
            <p className="text-slate-300 leading-relaxed">
              Because plate vibration vanishes at nodal lines (&phi; = 0), local diffusivity D<sub>g</sub> is
              minimized there, causing particles to concentrate into classical Chladni figures.
            </p>
          </div>

          {/* 4 */}
          <div className="bg-slate-950/70 p-3.5 rounded-xl border border-slate-800 border-amber-900/50">
            <h3 className="font-semibold text-amber-400 text-sm mb-1">
              4. Unmodelled Airflow &amp; Inverse Chladni Patterns
            </h3>
            <p className="text-slate-300 leading-relaxed">
              <strong>Notice regarding fine powders (&lt; 10 &mu;m, e.g., lycopodium spores or talc):</strong>
              In physical experiments in ambient air, vibrating plates create acoustic streaming
              (Faraday boundary-layer circulation). These circulating air currents drag lightweight
              spores toward the <strong>antinodes</strong> (maximum vibration centers), forming
              <strong> &ldquo;Inverse Chladni Patterns&rdquo;</strong>.
            </p>
            <p className="text-slate-400 mt-1.5">
              The current application models <strong>dry macroscopic granular transport</strong>
              where particle inertia exceeds aerodynamic drag. It does <strong>not</strong> model
              Navier-Stokes acoustic streaming or inter-particle van der Waals cohesion.
            </p>
          </div>
        </div>

        {/* Close Button */}
        <div className="flex justify-end pt-2 border-t border-slate-800">
          <button
            onClick={onClose}
            className="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-white font-medium text-xs transition shadow-lg"
          >
            <Check className="w-4 h-4" />
            <span>Understood &amp; Accept Scope</span>
          </button>
        </div>
      </div>
    </div>
  );
};
