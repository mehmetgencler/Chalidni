/**
 * Chladni Plate Acoustical Simulator: Main Application
 * 
 * Conforms to STAGE 7 Requirements:
 * - Minimal, realistic Chladni plate visualization.
 * - Perfectly square plate dominates the screen with dark brushed metallic realism.
 * - Only two input methods:
 *   1. Single-tone sine wave generator with logarithmic slider (20 Hz - 20,000 Hz).
 *   2. Uploaded stereo audio file playback through AudioWorklet.
 * - Natural damped free decay when input stops: particles gradually slow and settle into nodal lines.
 * - Authoritative AudioWorklet simulation clock with bounded time accumulator.
 * - Zero microphone functionality, zero parameter clutter.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Waves } from 'lucide-react';
import { AudioEngine } from './audio/audioEngine.ts';
import { ModalBank } from './physics/modalSolver.ts';
import { ParticleTransportSystem } from './physics/particleTransport.ts';
import { DEFAULT_ALUMINUM, DEFAULT_GEOMETRY } from './physics/plate.ts';
import { PlateCanvas } from './components/PlateCanvas.tsx';
import { AudioExciter } from './components/AudioExciter.tsx';

export function App() {
  const sideLength = DEFAULT_GEOMETRY.sideLength; // 0.30 m

  // Audio Engine singleton
  const audioEngineRef = useRef<AudioEngine | null>(null);
  if (!audioEngineRef.current) {
    audioEngineRef.current = new AudioEngine();
  }
  const audioEngine = audioEngineRef.current;

  // Fixed physical configuration: Simply supported aluminum plate, zeta = 0.01
  const modalBank = useMemo(() => {
    return new ModalBank(DEFAULT_ALUMINUM, DEFAULT_GEOMETRY, 0.01);
  }, []);

  // Fixed particle transport system: 3000 grains, Itô SDE
  const particleSystem = useMemo(() => {
    return new ParticleTransportSystem(
      {
        particleCount: 3000,
        dRef: 1.0e-4,
        gammaC: 1.0,
        power: 2.0,
        g: 9.80665,
        dt: 0.016,
        seed: 42,
      },
      sideLength
    );
  }, [sideLength]);

  // AudioWorklet sample-frame tracking & bounded time accumulator
  const lastSampleFramesRef = useRef<number>(0);
  const timeAccumulatorRef = useRef<number>(0);
  const DT_PARTICLE = 0.016; // 16 ms fixed physical step

  // Tone generator state tracking
  const [isToneActive, setIsToneActive] = useState<boolean>(false);
  const [toneFrequency, setToneFrequency] = useState<number>(53.96);

  const handleFrequencyChange = (f: number) => {
    setToneFrequency(f);
    modalBank.setHarmonicTone(f, isToneActive);
  };

  const handleToneStateChange = (isPlaying: boolean, f: number) => {
    setIsToneActive(isPlaying);
    setToneFrequency(f);
    modalBank.setHarmonicTone(f, isPlaying);
  };

  // Subscribe to AudioWorklet snapshots (for broadband audio file mode and clock synchronization)
  useEffect(() => {
    const unsubscribe = audioEngine.onSnapshot((snapshot) => {
      // If an audio file is currently active, sync dynamic state from worklet
      if (audioEngine.activeSourceType === 'file') {
        modalBank.applySnapshot(snapshot);
      }

      // Authoritative physical time from monotonic sample frames
      if (lastSampleFramesRef.current === 0) {
        lastSampleFramesRef.current = snapshot.sampleFramesProcessed;
        return;
      }

      const deltaSamples = snapshot.sampleFramesProcessed - lastSampleFramesRef.current;
      lastSampleFramesRef.current = snapshot.sampleFramesProcessed;

      if (deltaSamples > 0 && snapshot.sampleRate > 0) {
        const dtSim = deltaSamples / snapshot.sampleRate;
        timeAccumulatorRef.current += dtSim;

        // Bounded catch-up: allow up to 10 sub-steps per snapshot to prevent stalling
        let subSteps = 0;
        const maxSubSteps = 10;

        while (timeAccumulatorRef.current >= DT_PARTICLE && subSteps < maxSubSteps) {
          particleSystem.step(DT_PARTICLE, (px, py) => {
            const aRms = modalBank.evaluateRmsAcceleration(px, py);
            return particleSystem.evaluateDimensionalDiffusivity(aRms);
          });
          timeAccumulatorRef.current -= DT_PARTICLE;
          subSteps++;
        }

        // Bound remaining lag to prevent unbounded drift if browser tab was suspended
        if (timeAccumulatorRef.current > 0.1) {
          timeAccumulatorRef.current = 0.1;
        }
      }
    });

    return unsubscribe;
  }, [audioEngine, modalBank, particleSystem]);

  // Single-tone RAF physics step (smoothly evaluates harmonic response & free decay)
  useEffect(() => {
    let animId: number;
    let lastTime = performance.now();

    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - lastTime) / 1000.0);
      lastTime = now;

      if (modalBank.isHarmonicToneMode) {
        modalBank.updateHarmonicDecay(now);

        // Step particle transport if plate is vibrating
        particleSystem.step(dt, (px, py) => {
          const aRms = modalBank.evaluateRmsAcceleration(px, py);
          return particleSystem.evaluateDimensionalDiffusivity(aRms);
        });
      }

      animId = requestAnimationFrame(loop);
    };

    animId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animId);
  }, [modalBank, particleSystem]);

  // Clean up audio on unmount
  useEffect(() => {
    return () => {
      audioEngine.cleanup();
    };
  }, [audioEngine]);

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
