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

import React, { useEffect, useMemo, useRef } from 'react';
import { Waves } from 'lucide-react';
import { AudioEngine } from './audio/audioEngine.ts';
import { ModalBank } from './physics/modalSolver.ts';
import { ParticleTransportSystem } from './physics/particleTransport.ts';
import { SimulationClockAccumulator } from './physics/simulationClock.ts';
import { DEFAULT_ALUMINUM, DEFAULT_GEOMETRY } from './physics/plate.ts';
import { PlateCanvas } from './components/PlateCanvas.tsx';
import { AudioExciter } from './components/AudioExciter.tsx';

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
        gammaC: 1.0,
        power: 2.0,
        g: 9.80665,
        dt: 0.016,
        seed: 42,
      },
      sideLength
    );
  }, [sideLength]);

  // Single authoritative sample-frame clock accumulator
  const simClock = useMemo(() => new SimulationClockAccumulator(), []);
  const DT_PARTICLE = 0.016; // 16 ms fixed physical transport step
  const MAX_SUBSTEPS_PER_SNAPSHOT = 4;

  // Send complete 146-mode catalogue to AudioWorklet initialization queue
  useEffect(() => {
    audioEngine.configureModes(modalBank.getWorkletModeConfig());
  }, [audioEngine, modalBank]);

  // Single unified physics & particle transport subscription driven strictly by AudioWorklet clock
  useEffect(() => {
    const unsubscribe = audioEngine.onSnapshot((snapshot) => {
      // Apply modal displacements, velocities, accelerations, and covariance for both tone and file
      modalBank.applySnapshot(snapshot);

      // Advance particle transport strictly once per elapsed sample-frame interval
      simClock.advanceFromSnapshot(snapshot, DT_PARTICLE, MAX_SUBSTEPS_PER_SNAPSHOT, (dt) => {
        particleSystem.step(dt, (px, py) => {
          const aRms = modalBank.sampleRmsFieldFast(px, py);
          return particleSystem.evaluateDimensionalDiffusivity(aRms, snapshot.isSilent);
        });
      });

      // Expose non-reactive observability attributes on canvas element for verification
      const canvasEl = canvasRef.current;
      if (canvasEl) {
        canvasEl.dataset.simFrames = String(snapshot.sampleFramesProcessed);
        canvasEl.dataset.simTime = snapshot.elapsedSimTime.toFixed(4);
        canvasEl.dataset.modeCount = String(snapshot.modeCount ?? modalBank.modes.length);
        canvasEl.dataset.particleSteps = String(simClock.stepsExecuted);
        canvasEl.dataset.isSilent = String(snapshot.isSilent);
        canvasEl.dataset.sourceType = audioEngine.activeSourceType;
      }
    });

    return unsubscribe;
  }, [audioEngine, modalBank, particleSystem, simClock]);

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

  const handleToneStateChange = (_isPlaying: boolean, _f: number) => {
    // Tone gain ramps smoothly in AudioEngine;
    // ModalWorkletProcessor handles forced excitation and natural free modal decay.
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans select-none">
      {/* Refined Minimal Header */}
      <header className="border-b border-slate-900 bg-slate-950/90 backdrop-blur-md px-4 py-3 shrink-0">
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
      <main className="flex-1 flex flex-col items-center justify-center p-2 sm:p-4 gap-3 max-w-4xl mx-auto w-full">
        {/* The Square Metal Plate */}
        <section aria-label="Chladni Plate Visualization" className="w-full flex-1 flex items-center justify-center min-h-[300px]">
          <PlateCanvas
            particles={particleSystem.particles}
            sideLength={sideLength}
            canvasRefExternal={canvasRef}
          />
        </section>

        {/* Minimal Audio Controls */}
        <section aria-label="Acoustic Excitation Controls" className="w-full shrink-0">
          <AudioExciter
            audioEngine={audioEngine}
            onFrequencyChange={handleFrequencyChange}
            onToneStateChange={handleToneStateChange}
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
