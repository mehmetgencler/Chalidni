/**
 * Chladni Plate Acoustical Simulator: Main Application
 *
 * Conforms to STAGE 8 Requirements:
 * - Minimal, realistic Chladni plate visualization (UI unchanged from Stage 7).
 * - Perfectly square plate dominates the screen with dark brushed metallic realism.
 * - Two audio input methods routed through ONE unified AudioWorklet modal engine:
 *   1. Single-tone sine wave generator with logarithmic slider (20 Hz - 20,000 Hz).
 *   2. Uploaded stereo audio file playback with Play/Pause and stereo speaker output.
 * - Full 146-mode center-coupled Kirchhoff catalogue (up to 20 kHz) configured on Worklet.
 * - Single authoritative simulation clock: t = sampleFramesProcessed / sampleRate.
 * - Zero duplicate RAF physics loops; requestAnimationFrame only renders Canvas.
 * - Bounded chunked catch-up preserves delayed physical time without discarding it.
 * - True per-mode physical free decay when excitation pauses, stops, or ends.
 */

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Waves } from 'lucide-react';
import { AudioEngine } from './audio/audioEngine.ts';
import { ModalBank } from './physics/modalSolver.ts';
import {
  ParticleTransportSystem,
  REACTION_THRESHOLD_DEFAULT_G,
  REACTION_THRESHOLD_MAX_G,
  REACTION_THRESHOLD_MIN_G,
  REACTION_THRESHOLD_STEP_G,
} from './physics/particleTransport.ts';
import { SimulationClockAccumulator } from './physics/simulationClock.ts';
import { DEFAULT_ALUMINUM, DEFAULT_GEOMETRY } from './physics/plate.ts';
import { PlateCanvas } from './components/PlateCanvas.tsx';
import { AudioExciter } from './components/AudioExciter.tsx';
import { SilentVideoExport } from './components/SilentVideoExport.tsx';
import {
  PATTERN_MEMORY_DEFAULT_SEC,
  PATTERN_MEMORY_MAX_SEC,
  PATTERN_MEMORY_MIN_SEC,
  PATTERN_MEMORY_STEP_SEC,
} from './components/patternMemory.ts';

export function App() {
  const sideLength = DEFAULT_GEOMETRY.sideLength; // 0.30 m
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Audio Engine singleton
  const audioEngineRef = useRef<AudioEngine | null>(null);
  if (!audioEngineRef.current) {
    audioEngineRef.current = new AudioEngine();
  }
  const audioEngine = audioEngineRef.current;

  // Unified 146-mode center-coupled physical plate model (20 Hz - 20 kHz, zeta = 0.01)
  const modalBank = useMemo(() => {
    return new ModalBank(DEFAULT_ALUMINUM, DEFAULT_GEOMETRY, 0.01);
  }, []);

  // Fixed particle transport system: 3000 grains, Itô SDE
  const particleSystem = useMemo(() => {
    return new ParticleTransportSystem(
      {
        particleCount: 3000,
        dRef: 2.0e-6,
        gammaC: REACTION_THRESHOLD_DEFAULT_G,
        power: 2.0,
        g: 9.80665,
        dt: 0.016,
        seed: 42,
        enableExternalPowderFeed: true,
        maxParticleCount: 4500,
      },
      sideLength
    );
  }, [sideLength]);

  // Stable live reference so PlateCanvas always renders particleSystem.particles even across resets without React re-renders
  const liveParticlesRef = useRef(particleSystem.particles);

  // Visual-only pattern-memory controls (independent of physics simulation & audio)
  const [patternMemorySec, setPatternMemorySec] = useState<number>(PATTERN_MEMORY_DEFAULT_SEC);
  const [normalizePatternMemory, setNormalizePatternMemory] = useState<boolean>(false);
  const [patternMemoryResetToken, setPatternMemoryResetToken] = useState<number>(0);
  const isPatternMemoryPausedRef = useRef<boolean>(false);
  const memorySliderId = useId();
  const normalizeToggleId = useId();

  // Physical particle activation threshold (Gamma_c in units of g)
  const [reactionThresholdG, setReactionThresholdG] = useState<number>(REACTION_THRESHOLD_DEFAULT_G);
  const thresholdSliderId = useId();

  // Single authoritative sample-frame clock accumulator
  const simClock = useMemo(() => new SimulationClockAccumulator(), []);
  const DT_PARTICLE = 0.016; // 16 ms fixed physical transport step
  const MAX_SUBSTEPS_PER_SNAPSHOT = 4;

  // Send complete 146-mode catalogue to AudioWorklet initialization queue
  useEffect(() => {
    audioEngine.configureModes(modalBank.getWorkletModeConfig());
    if (typeof window !== 'undefined' && window.location.search.includes('grid=65')) {
      modalBank.setForcedHalfN(33);
    }
  }, [audioEngine, modalBank]);

  // Single unified physics & particle transport subscription driven strictly by AudioWorklet clock
  useEffect(() => {
    const unsubscribe = audioEngine.onSnapshot((snapshot) => {
      // Apply modal displacements, velocities, accelerations, and covariance for both tone and file
      modalBank.applySnapshot(snapshot);

      // Advance particle transport strictly once per elapsed sample-frame interval
      simClock.advanceFromSnapshot(snapshot, DT_PARTICLE, MAX_SUBSTEPS_PER_SNAPSHOT, (dt) => {
        const gridData = modalBank.getFastRmsGridData();
        particleSystem.stepFromRmsGrid(
          dt,
          gridData.quadrant,
          gridData.halfN,
          snapshot.isSilent || !gridData.hasEnergy
        );
      });

      // Expose non-reactive observability attributes on canvas element for automated E2E verification
      const canvasEl = canvasRef.current;
      if (canvasEl) {
        const gridStats = modalBank.getFastGridTelemetry();
        const stepStats = particleSystem.lastStepStats;
        const audioStats = audioEngine.getBrowserAudioTelemetry();

        canvasEl.dataset.simFrames = String(snapshot.sampleFramesProcessed);
        canvasEl.dataset.simTime = snapshot.elapsedSimTime.toFixed(4);
        canvasEl.dataset.sampleRate = String(snapshot.sampleRate);
        canvasEl.dataset.modeCount = String(snapshot.modeCount ?? modalBank.modes.length);
        canvasEl.dataset.particleSteps = String(simClock.stepsExecuted);
        canvasEl.dataset.isSilent = String(snapshot.isSilent);
        canvasEl.dataset.sourceType = audioEngine.activeSourceType;
        canvasEl.dataset.highFreqRms = modalBank.getMaxModeRmsAboveFrequency(2700).toFixed(3);
        canvasEl.dataset.gridRes = String(gridStats.effectivePlateResolution);
        canvasEl.dataset.gridRebuildMs = gridStats.lastRebuildDurationMs.toFixed(3);
        canvasEl.dataset.particleUpdateMs = stepStats.updateDurationMs.toFixed(3);
        canvasEl.dataset.particleCount = String(particleSystem.particles.length);
        canvasEl.dataset.interiorParticles = String(particleSystem.lastInteriorCount);
        canvasEl.dataset.maxMicroSteps = String(stepStats.maxMicroSteps);
        canvasEl.dataset.maxSubstepRms = stepStats.maxSubStepRms.toFixed(6);
        canvasEl.dataset.boundViolated = String(stepStats.boundViolated);
        canvasEl.dataset.realWorklet = String(audioStats.hasRealAudioWorkletNode);
        canvasEl.dataset.sharedWorklet = String(audioStats.isToneConnected && audioStats.isFileDownmixConnected);
        canvasEl.dataset.audibleFile = String(audioStats.isFileAudibleToDestination);
        canvasEl.dataset.gammaC = particleSystem.config.gammaC.toFixed(2);
      }
    });

    return unsubscribe;
  }, [audioEngine, modalBank, particleSystem, simClock]);

  // Freeze pattern memory accumulation when uploaded audio playback is explicitly paused
  useEffect(() => {
    return audioEngine.onProgress((progress) => {
      const isExplicitFilePause =
        !audioEngine.isSilentWavStreaming &&
        audioEngine.activeSourceType === 'file' &&
        Boolean(progress.fileName) &&
        !progress.isPlaying &&
        progress.duration > 0 &&
        progress.currentTime < progress.duration - 0.05;
      isPatternMemoryPausedRef.current = isExplicitFilePause;
    });
  }, [audioEngine]);

  // Clean up audio on unmount
  useEffect(() => {
    return () => {
      audioEngine.cleanup();
    };
  }, [audioEngine]);

  const handleFrequencyChange = (_f: number) => {
    // OscillatorNode frequency is updated directly in AudioEngine;
    // ModalWorkletProcessor integrates physical plate response at sampleRate.
  };

  const handleToneStateChange = (isPlaying: boolean, _f: number) => {
    // Tone gain ramps smoothly in AudioEngine;
    // ModalWorkletProcessor handles forced excitation and natural free modal decay.
    if (isPlaying) {
      isPatternMemoryPausedRef.current = false;
    }
  };

  const handlePrepareSilentSimulation = () => {
    modalBank.reset();
    simClock.reset();
    particleSystem.initParticles();
    liveParticlesRef.current = particleSystem.particles;
    isPatternMemoryPausedRef.current = false;
    setPatternMemoryResetToken((token) => token + 1);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans select-none">
      {/* Refined Minimal Header */}
      <header className="border-b border-slate-900 bg-slate-950/90 backdrop-blur-md px-4 py-2.5 shrink-0">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-sky-950 text-sky-400 border border-sky-800/60">
              <Waves className="w-4 h-4" />
            </div>
            <div>
              <h1 className="text-sm sm:text-base font-semibold tracking-tight text-slate-100">
                Chladni Plate Acoustical Simulator
              </h1>
              <p className="text-[11px] text-slate-400">
                Kirchhoff–Love Plate Theory &bull; 0.30 m Aluminum &bull; 20 Hz – 20 kHz
              </p>
            </div>
          </div>
        </div>
      </header>

      {/* Main Screen: Visualization Dominates */}
      <main className="flex-1 flex flex-col items-center justify-center p-2 sm:p-3 gap-2 max-w-4xl mx-auto w-full">
        {/* The Square Metal Plate */}
        <section aria-label="Chladni Plate Visualization" className="w-full flex-1 flex items-center justify-center min-h-[280px]">
          <PlateCanvas
            particles={particleSystem.particles}
            sideLength={sideLength}
            canvasRefExternal={canvasRef}
            particlesRefExternal={liveParticlesRef}
            patternMemoryHalfLifeSec={patternMemorySec}
            patternMemoryResetToken={patternMemoryResetToken}
            isPatternMemoryPausedRef={isPatternMemoryPausedRef}
            normalizePatternMemory={normalizePatternMemory}
          />
        </section>

        {/* Minimal Audio Controls */}
        <section aria-label="Acoustic Excitation Controls" className="w-full shrink-0 flex flex-col gap-2">
          <AudioExciter
            audioEngine={audioEngine}
            onFrequencyChange={handleFrequencyChange}
            onToneStateChange={handleToneStateChange}
          />
          {/* Visual Pattern Memory & Particle Reaction Threshold Controls */}
          <div className="w-full max-w-xl mx-auto px-4 py-2.5 rounded-xl bg-slate-900/80 border border-slate-800 backdrop-blur-sm text-slate-200 grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-3">
                <label
                  htmlFor={memorySliderId}
                  className="text-xs font-medium text-slate-200 tracking-tight"
                >
                  Desen Hafızası
                </label>
                <span
                  data-testid="pattern-memory-value"
                  className="text-xs font-mono font-semibold text-sky-400 tabular-nums"
                >
                  {patternMemorySec.toFixed(2)} s
                </span>
              </div>
              <input
                id={memorySliderId}
                type="range"
                min={PATTERN_MEMORY_MIN_SEC}
                max={PATTERN_MEMORY_MAX_SEC}
                step={PATTERN_MEMORY_STEP_SEC}
                value={patternMemorySec}
                onChange={(e) => {
                  const next = parseFloat(e.target.value);
                  setPatternMemorySec(Number.isFinite(next) ? next : PATTERN_MEMORY_DEFAULT_SEC);
                }}
                data-testid="pattern-memory-slider"
                className="w-full h-2 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-sky-400 focus:outline-none"
              />
              <p className="text-[11px] text-slate-400 leading-snug">
                Eski desenlerin ne kadar süreyle görünür kalacağını ayarlar.
              </p>
            </div>

            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-3">
                <label
                  htmlFor={thresholdSliderId}
                  className="text-xs font-medium text-slate-200 tracking-tight"
                >
                  Reaction Threshold
                </label>
                <span
                  data-testid="reaction-threshold-value"
                  className="text-xs font-mono font-semibold text-amber-400 tabular-nums"
                >
                  {reactionThresholdG.toFixed(2)} g
                </span>
              </div>
              <input
                id={thresholdSliderId}
                type="range"
                min={REACTION_THRESHOLD_MIN_G}
                max={REACTION_THRESHOLD_MAX_G}
                step={REACTION_THRESHOLD_STEP_G}
                value={reactionThresholdG}
                onChange={(e) => {
                  const next = parseFloat(e.target.value);
                  const safeG = Number.isFinite(next) ? next : REACTION_THRESHOLD_DEFAULT_G;
                  setReactionThresholdG(safeG);
                  particleSystem.setGammaC(safeG);
                  if (canvasRef.current) {
                    canvasRef.current.dataset.gammaC = particleSystem.config.gammaC.toFixed(2);
                  }
                }}
                data-testid="reaction-threshold-slider"
                className="w-full h-2 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-amber-400 focus:outline-none"
              />
              <p className="text-[11px] text-slate-400 leading-snug">
                Minimum local RMS acceleration required for particle movement.
              </p>
            </div>

            <div className="sm:col-span-2 pt-2.5 border-t border-slate-800/80 flex items-center justify-between gap-4">
              <div className="flex flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <label
                    id={`${normalizeToggleId}-label`}
                    htmlFor={normalizeToggleId}
                    className="text-xs font-medium text-slate-200 tracking-tight cursor-pointer"
                  >
                    Normalization Toggle
                  </label>
                  <span className="text-[10px] font-medium uppercase tracking-wider text-sky-400/90">
                    Experimental
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 leading-snug">
                  Auto-scales cloud intensity from measured mean density to recover contrast on faint patterns.
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <label
                  htmlFor={normalizeToggleId}
                  aria-labelledby={`${normalizeToggleId}-label`}
                  className="relative inline-flex items-center cursor-pointer"
                >
                  <input
                    id={normalizeToggleId}
                    type="checkbox"
                    role="switch"
                    aria-labelledby={`${normalizeToggleId}-label`}
                    checked={normalizePatternMemory}
                    onChange={(e) => setNormalizePatternMemory(e.target.checked)}
                    data-testid="normalization-toggle"
                    className="sr-only peer"
                  />
                  <span className="w-9 h-5 bg-slate-800 border border-slate-700 rounded-full peer peer-focus-visible:ring-2 peer-focus-visible:ring-sky-400 peer-checked:bg-sky-500/80 peer-checked:border-sky-400 transition-colors after:content-[''] after:absolute after:top-[3px] after:left-[3px] after:bg-slate-200 after:rounded-full after:h-3.5 after:w-3.5 after:transition-transform peer-checked:after:translate-x-4" />
                </label>
                <span
                  data-testid="normalization-toggle-state"
                  className="text-[11px] font-mono font-semibold tabular-nums text-slate-300 w-7 text-right"
                >
                  {normalizePatternMemory ? 'ON' : 'OFF'}
                </span>
              </div>
            </div>
          </div>
          <SilentVideoExport
            audioEngine={audioEngine}
            canvasRef={canvasRef}
            onPrepareSimulation={handlePrepareSilentSimulation}
          />
        </section>
      </main>

      {/* Quiet Footer */}
      <footer className="py-2 text-center text-[10px] text-slate-600 border-t border-slate-900/60">
        Continuous AudioWorklet Physics Clock &bull; Itô Granular Diffusion &bull; Full Frequency Response
      </footer>
    </div>
  );
}
export default App;
