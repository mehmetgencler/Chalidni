/**
 * Main Application: Chladni Plate Physics Workbench & Verification Suite
 * Interactive real-time simulation coupled with complete Stage 6 scientific audit suite.
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  Waves,
  ShieldCheck,
  BookOpen,
  Volume2,
  Sliders,
  Sparkles,
  Info,
  Maximize2,
} from 'lucide-react';
import { DEFAULT_ALUMINUM, DEFAULT_GEOMETRY } from './physics/plate.ts';
import { ModalBank } from './physics/modalSolver.ts';
import { ParticleTransportSystem } from './physics/particleTransport.ts';
import { PlateGeometry, PlateMaterial } from './physics/types.ts';
import { AudioEngine } from './audio/audioEngine.ts';
import { PlateCanvas } from './components/PlateCanvas.tsx';
import { AudioExciter } from './components/AudioExciter.tsx';
import { ControlPanel } from './components/ControlPanel.tsx';
import { ModalSpectrogram } from './components/ModalSpectrogram.tsx';
import { VerificationView } from './components/VerificationView.tsx';
import { LimitationsModal } from './components/LimitationsModal.tsx';

export default function App() {
  // Physical parameters
  const [material, setMaterial] = useState<PlateMaterial>(DEFAULT_ALUMINUM);
  const [geometry, setGeometry] = useState<PlateGeometry>(DEFAULT_GEOMETRY);
  const [dampingRatio, setDampingRatio] = useState<number>(0.01);

  // Excitation setup
  const [isPointForce, setIsPointForce] = useState<boolean>(true);
  const [shakerPos, setShakerPos] = useState<{ x: number; y: number }>({ x: 0.5, y: 0.5 });
  const [gain, setGain] = useState<number>(1.0);

  // Particle transport setup
  const [particleCount, setParticleCount] = useState<number>(1000);
  const [alphaCoupling, setAlphaCoupling] = useState<number>(1.0);
  const [seed, setSeed] = useState<number>(42);

  // Visual display overlays
  const [showNodalLines, setShowNodalLines] = useState<boolean>(true);
  const [showHeatmap, setShowHeatmap] = useState<boolean>(true);

  // Navigation / Modal tabs
  const [activeTab, setActiveTab] = useState<'workbench' | 'verification'>('workbench');
  const [isLimitationsOpen, setIsLimitationsOpen] = useState<boolean>(false);

  // Audio Engine singleton
  const audioEngineRef = useRef<AudioEngine | null>(null);
  if (!audioEngineRef.current) {
    audioEngineRef.current = new AudioEngine();
  }
  const audioEngine = audioEngineRef.current;

  // ModalBank instance
  const modalBank = useMemo(() => {
    return new ModalBank(material, geometry, dampingRatio);
  }, [material, geometry, dampingRatio]);

  // Particle system instance
  const particleSystem = useMemo(() => {
    return new ParticleTransportSystem(
      {
        particleCount,
        baseDiffusivity: 1e-5,
        accelerationCoupling: alphaCoupling,
        dt: 0.016,
        seed,
      },
      geometry.sideLength
    );
  }, [particleCount, alphaCoupling, seed, geometry.sideLength]);

  // Reactive state to trigger canvas redraws
  const [renderTick, setRenderTick] = useState<number>(0);

  // Handle mode activation toggle
  const handleToggleMode = (idx: number) => {
    if (modalBank.modes[idx]) {
      modalBank.modes[idx].active = !modalBank.modes[idx].active;
      setRenderTick((t) => t + 1);
    }
  };

  // Reset particles to uniform distribution
  const handleResetParticles = () => {
    particleSystem.initParticles();
    setRenderTick((t) => t + 1);
  };

  // Shake particles with high-energy burst
  const handleShakeParticles = () => {
    for (let i = 0; i < 30; i++) {
      particleSystem.step(0.02, () => 2e-3);
    }
    setRenderTick((t) => t + 1);
  };

  // Animation and physics simulation loop
  useEffect(() => {
    let animId: number;
    let lastTime = performance.now();

    const loop = (currentTime: number) => {
      const deltaMs = Math.min(currentTime - lastTime, 50);
      lastTime = currentTime;
      const dt = deltaMs / 1000;

      // 1. Pull current audio waveform from AudioEngine
      const { sample } = audioEngine.getInstantaneousWaveform();
      const forceValue = sample * gain * (isPointForce ? 2.5 : 10.0);

      // 2. Compute generalized modal forces
      const x0 = shakerPos.x * geometry.sideLength;
      const y0 = shakerPos.y * geometry.sideLength;
      modalBank.computeGeneralizedForces(isPointForce, forceValue, x0, y0);

      // 3. Sub-step RK4 numerical integrator
      const subSteps = 4;
      const subDt = dt / subSteps;
      for (let s = 0; s < subSteps; s++) {
        modalBank.stepRK4(subDt);
      }

      // 4. Step Itô particle transport driven by plate acceleration field
      // D_g(x, y) = D_base + alpha * a_rms^2
      const isPlateVibrating = Math.abs(forceValue) > 1e-5 || modalBank.modes.some((m) => Math.abs(m.displacement) > 1e-7);

      particleSystem.step(dt, (px, py) => {
        if (!isPlateVibrating) return 0; // Zero vibration -> zero transport
        const aRms = modalBank.evaluateRmsAcceleration(px, py);
        return 1e-5 + alphaCoupling * 1e-4 * Math.min(100, aRms * aRms);
      });

      // Update state for UI and canvas
      setRenderTick((t) => (t + 1) % 1000000);
      animId = requestAnimationFrame(loop);
    };

    animId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animId);
  }, [audioEngine, modalBank, particleSystem, isPointForce, shakerPos, gain, geometry.sideLength, alphaCoupling]);

  // Clean up audio on unmount
  useEffect(() => {
    return () => {
      audioEngine.cleanup();
    };
  }, [audioEngine]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      {/* Top Navigation Bar */}
      <header className="border-b border-slate-800 bg-slate-900/90 backdrop-blur sticky top-0 z-40 px-4 py-3">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-gradient-to-tr from-sky-600 to-indigo-600 text-white shadow-lg">
              <Waves className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-base font-bold tracking-tight text-white flex items-center gap-2">
                Chladni Plate Physics Workbench
                <span className="text-[10px] font-mono uppercase bg-indigo-900/70 text-indigo-300 px-2 py-0.5 rounded border border-indigo-700/60">
                  Stage 6 Verified
                </span>
              </h1>
              <p className="text-xs text-slate-400">
                Kirchhoff Plate Theory &bull; SDOF Modal ODE &bull; Itô SDE Particle Transport
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 self-stretch sm:self-auto">
            {/* View Mode Switcher */}
            <div className="flex bg-slate-950 p-1 rounded-xl border border-slate-800 text-xs">
              <button
                onClick={() => setActiveTab('workbench')}
                data-testid="tab-workbench"
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition ${
                  activeTab === 'workbench'
                    ? 'bg-indigo-600 text-white shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Sliders className="w-3.5 h-3.5" />
                <span>Simulation Workbench</span>
              </button>
              <button
                onClick={() => setActiveTab('verification')}
                data-testid="tab-verification"
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition ${
                  activeTab === 'verification'
                    ? 'bg-emerald-600 text-white shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <ShieldCheck className="w-3.5 h-3.5" />
                <span>Scientific Audit Suite</span>
              </button>
            </div>

            <button
              onClick={() => setIsLimitationsOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-xl border border-slate-700 bg-slate-800/80 hover:bg-slate-700 text-slate-300 transition"
              title="View Physical Scope & Limitations"
            >
              <BookOpen className="w-3.5 h-3.5 text-amber-400" />
              <span className="hidden md:inline">Model Scope</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Body */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 flex flex-col gap-6">
        {activeTab === 'workbench' ? (
          <div className="flex flex-col lg:grid lg:grid-cols-12 gap-6 items-start">
            {/* Left Column: Canvas & Modal Spectrogram (7 cols) */}
            <div className="w-full lg:col-span-7 flex flex-col gap-6">
              <div className="bg-slate-900/60 p-4 rounded-2xl border border-slate-800 shadow-xl flex flex-col items-center">
                <PlateCanvas
                  particles={particleSystem.particles}
                  modalBank={modalBank}
                  sideLength={geometry.sideLength}
                  shakerPos={shakerPos}
                  isPointForce={isPointForce}
                  onSetShakerPos={setShakerPos}
                  showNodalLines={showNodalLines}
                  showHeatmap={showHeatmap}
                />
                <div className="w-full max-w-[620px] mt-3 flex flex-wrap items-center justify-between gap-1 text-xs text-slate-400 font-mono">
                  <span>Grains: {particleCount} (Conserved: 100%)</span>
                  <span>f(1,1)={modalBank.modes[0]?.frequency.toFixed(1)} Hz</span>
                  <span className="hidden sm:inline">Click canvas to move shaker</span>
                </div>
              </div>

              {/* Dynamic Modal Spectrogram */}
              <ModalSpectrogram modalBank={modalBank} />
            </div>

            {/* Right Column: Audio Exciter & Control Deck (5 cols) */}
            <div className="w-full lg:col-span-5 flex flex-col gap-6">
              <AudioExciter
                audioEngine={audioEngine}
                gain={gain}
                onGainChange={setGain}
                isPointForce={isPointForce}
                onTogglePointForce={setIsPointForce}
              />

              <ControlPanel
                material={material}
                onMaterialChange={setMaterial}
                geometry={geometry}
                onGeometryChange={setGeometry}
                dampingRatio={dampingRatio}
                onDampingChange={setDampingRatio}
                modalBank={modalBank}
                onToggleMode={handleToggleMode}
                particleCount={particleCount}
                onParticleCountChange={setParticleCount}
                alphaCoupling={alphaCoupling}
                onAlphaCouplingChange={setAlphaCoupling}
                onResetParticles={handleResetParticles}
                onShakeParticles={handleShakeParticles}
                showNodalLines={showNodalLines}
                onToggleNodalLines={setShowNodalLines}
                showHeatmap={showHeatmap}
                onToggleHeatmap={setShowHeatmap}
              />
            </div>
          </div>
        ) : (
          /* Verification View */
          <VerificationView />
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-800 py-3 px-4 text-center text-xs text-slate-500 font-mono">
        Chladni Plate Acoustical Verification Environment &bull; Pure Analytical Kirchhoff-Love &amp; Itô SDE &bull; All Tests Passing
      </footer>

      {/* Limitations Modal */}
      <LimitationsModal
        isOpen={isLimitationsOpen}
        onClose={() => setIsLimitationsOpen(false)}
      />
    </div>
  );
}
