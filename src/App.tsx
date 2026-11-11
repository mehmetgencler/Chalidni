/**
 * Main Application: Chladni Plate Physics Workbench
 * Real-time AudioWorklet/buffer streaming pipeline, exact discrete state-transition modal ODE,
 * true time-window modal covariance RMS acceleration, dimensional Itô SDE, and decoupled continuous canvas.
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  Waves,
  ShieldCheck,
  BookOpen,
  Sliders,
} from 'lucide-react';
import { DEFAULT_ALUMINUM, DEFAULT_GEOMETRY } from './physics/plate.ts';
import { ModalBank } from './physics/modalSolver.ts';
import { ParticleTransportSystem, DEFAULT_DIMENSIONAL_CONFIG } from './physics/particleTransport.ts';
import { PlateGeometry, PlateMaterial } from './physics/types.ts';
import { AudioEngine } from './audio/audioEngine.ts';
import { HeatmapType, PlateCanvas } from './components/PlateCanvas.tsx';
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

  // PRIORITY 4: Configurable Dimensional Transport Parameters
  const [particleCount, setParticleCount] = useState<number>(1000);
  const [dRef, setDRef] = useState<number>(DEFAULT_DIMENSIONAL_CONFIG.dRef);
  const [gammaC, setGammaC] = useState<number>(DEFAULT_DIMENSIONAL_CONFIG.gammaC);
  const [power, setPower] = useState<number>(DEFAULT_DIMENSIONAL_CONFIG.power);
  const [seed] = useState<number>(42);

  // PRIORITY 5: Visual display overlays and physical heatmap types
  const [showNodalLines, setShowNodalLines] = useState<boolean>(true);
  const [heatmapType, setHeatmapType] = useState<HeatmapType>('rmsAcceleration');

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
        dRef,
        gammaC,
        power,
        g: 9.80665,
        dt: 0.016,
        seed,
      },
      geometry.sideLength
    );
  }, [particleCount, dRef, gammaC, power, seed, geometry.sideLength]);

  // Handle mode activation toggle
  const handleToggleMode = (idx: number) => {
    if (modalBank.modes[idx]) {
      modalBank.modes[idx].active = !modalBank.modes[idx].active;
    }
  };

  // Reset particles to uniform distribution
  const handleResetParticles = () => {
    particleSystem.initParticles();
  };

  // Shake particles with high-energy burst
  const handleShakeParticles = () => {
    for (let i = 0; i < 30; i++) {
      particleSystem.step(0.02, () => 2e-3);
    }
  };

  // PRIORITY 1 & 2: High-rate sample streaming and exact ZOH physics integration
  useEffect(() => {
    let animId: number;
    let lastTime = performance.now();

    const loop = (currentTime: number) => {
      const deltaMs = Math.min(currentTime - lastTime, 50);
      lastTime = currentTime;
      const dt = deltaMs / 1000;

      const x0 = shakerPos.x * geometry.sideLength;
      const y0 = shakerPos.y * geometry.sideLength;

      // 1. Pull sequential audio stream produced at AudioContext.sampleRate
      const samples = audioEngine.pullSampleStream();

      if (samples.length > 0) {
        // PRIORITY 2: Advance modal solver through sequential audio samples at true sample rate
        // Gain is applied strictly once inside stepSampleBuffer.
        modalBank.stepSampleBuffer(
          samples,
          audioEngine.sampleRate,
          isPointForce,
          x0,
          y0,
          gain * (isPointForce ? 2.5 : 10.0)
        );
      } else {
        // Fallback when no audio samples are queued: advance with exact discrete state transition
        modalBank.computeGeneralizedForces(isPointForce, 0, x0, y0);
        modalBank.stepExactZOH(dt);
      }

      // 2. Check vibration activity for silence gating (PRIORITY 4)
      const hasModalMotion = modalBank.modes.some((m) => m.active && Math.abs(m.displacement) > 1e-8);

      // 3. Step Itô particle transport driven by physical dimensional diffusivity D_g(x,y)
      // dX = sqrt(2*D_g) dW_x, dY = sqrt(2*D_g) dW_y
      particleSystem.step(dt, (px, py) => {
        if (!hasModalMotion) return 0.0; // Strictly zero transport during silence
        const aRms = modalBank.evaluateRmsAcceleration(px, py);
        return particleSystem.evaluateDimensionalDiffusivity(aRms, !hasModalMotion);
      });

      animId = requestAnimationFrame(loop);
    };

    animId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animId);
  }, [audioEngine, modalBank, particleSystem, isPointForce, shakerPos, gain, geometry.sideLength]);

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
                  Sample-Accurate Audio &bull; Exact ZOH
                </span>
              </h1>
              <p className="text-xs text-slate-400">
                Kirchhoff Plate Theory &bull; Exact Discrete SDOF State Transition &bull; Dimensional Itô SDE
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
                  particleSystem={particleSystem}
                  modalBank={modalBank}
                  sideLength={geometry.sideLength}
                  shakerPos={shakerPos}
                  isPointForce={isPointForce}
                  onSetShakerPos={setShakerPos}
                  showNodalLines={showNodalLines}
                  heatmapType={heatmapType}
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
                dRef={dRef}
                onDRefChange={setDRef}
                gammaC={gammaC}
                onGammaCChange={setGammaC}
                power={power}
                onPowerChange={setPower}
                onResetParticles={handleResetParticles}
                onShakeParticles={handleShakeParticles}
                showNodalLines={showNodalLines}
                onToggleNodalLines={setShowNodalLines}
                heatmapType={heatmapType}
                onHeatmapTypeChange={setHeatmapType}
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
        Chladni Plate Acoustical Verification Environment &bull; Sample-Rate Discrete Transition &bull; Uncalibrated Demonstration SDE
      </footer>

      {/* Limitations Modal */}
      <LimitationsModal
        isOpen={isLimitationsOpen}
        onClose={() => setIsLimitationsOpen(false)}
      />
    </div>
  );
}
