/**
 * AudioExciter: Audio generator, microphone, and file upload excitation interface.
 * Real-time oscilloscope, resonance frequency presets, and wave monitoring.
 */

import React, { useRef, useState, useEffect } from 'react';
import { Volume2, VolumeX, Mic, MicOff, Upload, Radio, Activity, Play, Pause, RotateCcw, AlertCircle } from 'lucide-react';
import { AudioEngine, AudioSourceType, GeneratorWaveform } from '../audio/audioEngine.ts';

interface AudioExciterProps {
  audioEngine: AudioEngine;
  onFrequencyChange?: (f: number) => void;
  gain: number;
  onGainChange: (g: number) => void;
  isPointForce: boolean;
  onTogglePointForce: (isPoint: boolean) => void;
}

export const AudioExciter: React.FC<AudioExciterProps> = ({
  audioEngine,
  onFrequencyChange,
  gain,
  onGainChange,
  isPointForce,
  onTogglePointForce,
}) => {
  const [sourceType, setSourceType] = useState<AudioSourceType>('generator');
  const [generatorType, setGeneratorType] = useState<GeneratorWaveform>('sine');
  const [freq1, setFreq1] = useState<number>(53.9);
  const [freq2, setFreq2] = useState<number>(215.8);
  const [isMicActive, setIsMicActive] = useState<boolean>(false);
  const [isFileLoaded, setIsFileLoaded] = useState<boolean>(false);
  const [fileName, setFileName] = useState<string>('');
  const [isPlayingFile, setIsPlayingFile] = useState<boolean>(false);
  const [isFileLooping, setIsFileLooping] = useState<boolean>(false);
  const [isMicMonitoring, setIsMicMonitoring] = useState<boolean>(false);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [micErrorMessage, setMicErrorMessage] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const oscCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Preset resonances
  const presets = [
    { label: 'f(1,1) = 53.9 Hz', f: 53.9 },
    { label: 'f(1,2) = 134.8 Hz', f: 134.8 },
    { label: 'f(2,2) = 215.8 Hz', f: 215.8 },
  ];

  // Select sine preset
  const handleSelectPreset = (f: number) => {
    audioEngine.resumeContext();
    setSourceType('generator');
    setGeneratorType('sine');
    setFreq1(f);
    audioEngine.startGenerator('sine', f);
    if (onFrequencyChange) onFrequencyChange(f);
  };

  const handleSelectDual = () => {
    audioEngine.resumeContext();
    setSourceType('generator');
    setGeneratorType('dual');
    setFreq1(53.9);
    setFreq2(215.8);
    audioEngine.startGenerator('dual', 53.9, 215.8);
  };

  const handleSelectSweep = () => {
    audioEngine.resumeContext();
    setSourceType('generator');
    setGeneratorType('sweep');
    audioEngine.startGenerator('sweep');
  };

  const handleSelectSilence = () => {
    audioEngine.resumeContext();
    setSourceType('generator');
    setGeneratorType('silence');
    audioEngine.startGenerator('silence');
  };

  const handleToggleMic = async () => {
    setMicErrorMessage(null);
    if (isMicActive) {
      audioEngine.stopMicrophone();
      setIsMicActive(false);
      handleSelectPreset(freq1);
    } else {
      await audioEngine.resumeContext();
      const ok = await audioEngine.startMicrophone();
      if (ok) {
        setIsMicActive(true);
        setSourceType('microphone');
        setMicErrorMessage(null);
      } else {
        setMicErrorMessage(
          audioEngine.lastMicError ||
            'Microphone access could not be initialized. Please check your browser permissions.'
        );
      }
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await audioEngine.resumeContext();
    const ok = await audioEngine.loadAudioFile(file);
    if (ok) {
      setIsFileLoaded(true);
      setFileName(file.name);
      setIsPlayingFile(true);
      setSourceType('file');
    }
  };

  const handleToggleFilePlay = () => {
    if (isPlayingFile) {
      audioEngine.pauseAudioFile();
      setIsPlayingFile(false);
    } else {
      audioEngine.playAudioFile();
      setIsPlayingFile(true);
    }
  };

  const handleToggleMute = () => {
    const next = !isMuted;
    setIsMuted(next);
    audioEngine.setMuted(next);
  };

  const handleGainSlider = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    onGainChange(val);
    audioEngine.gain = val;
  };

  const handleFreqSlider = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    setFreq1(val);
    audioEngine.setGeneratorFrequency(val);
    if (onFrequencyChange) onFrequencyChange(val);
  };

  // Oscilloscope render loop
  useEffect(() => {
    let animId: number;
    const canvas = oscCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const renderOscilloscope = () => {
      const buffer = audioEngine.getDiagnosticWaveform();
      ctx.fillStyle = '#090d16';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.strokeStyle = '#38bdf8'; // sky-400
      ctx.lineWidth = 1.5;
      ctx.beginPath();

      const sliceWidth = canvas.width / buffer.length;
      let x = 0;

      for (let i = 0; i < buffer.length; i++) {
        const v = buffer[i];
        const y = (v + 1) * 0.5 * canvas.height;
        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
        x += sliceWidth;
      }

      ctx.lineTo(canvas.width, canvas.height / 2);
      ctx.stroke();

      animId = requestAnimationFrame(renderOscilloscope);
    };

    animId = requestAnimationFrame(renderOscilloscope);
    return () => cancelAnimationFrame(animId);
  }, [audioEngine]);

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 shadow-xl flex flex-col gap-4">
      {/* Top Header & Mute */}
      <div className="flex items-center justify-between border-b border-slate-800 pb-2">
        <div className="flex items-center gap-2">
          <Activity className="w-5 h-5 text-sky-400" />
          <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-200">
            Audio &amp; Excitation Source
          </h2>
        </div>
        <button
          onClick={handleToggleMute}
          className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg border transition ${
            isMuted
              ? 'bg-rose-950/40 border-rose-700/60 text-rose-300'
              : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
          }`}
          title={isMuted ? 'Audible monitor muted' : 'Mute audible monitor'}
        >
          {isMuted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
          <span>{isMuted ? 'Monitor Muted' : 'Monitor Audio'}</span>
        </button>
      </div>

      {/* Excitation Coupling Model Selector */}
      <div className="bg-slate-950/60 p-2.5 rounded-lg border border-slate-800/80 flex items-center justify-between">
        <div>
          <span className="text-xs text-slate-400 block font-medium">Coupling Mechanism:</span>
          <span className="text-xs text-slate-200 font-semibold">
            {isPointForce ? 'Point Force (Shaker Probe)' : 'Uniform Acoustic Pressure Field'}
          </span>
        </div>
        <div className="flex bg-slate-900 p-0.5 rounded-lg border border-slate-700">
          <button
            onClick={() => onTogglePointForce(true)}
            className={`px-2.5 py-1 text-xs font-medium rounded-md transition ${
              isPointForce ? 'bg-sky-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Point Force
          </button>
          <button
            onClick={() => onTogglePointForce(false)}
            className={`px-2.5 py-1 text-xs font-medium rounded-md transition ${
              !isPointForce ? 'bg-sky-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Uniform Pressure
          </button>
        </div>
      </div>
      {!isPointForce && (
        <p className="text-[11px] text-amber-400/90 bg-amber-950/30 p-2 rounded border border-amber-900/40">
          Analytical Notice: Uniform acoustic pressure excites ONLY odd-odd modes due to spatial symmetry cancellation.
        </p>
      )}

      {/* Waveform Generator Presets */}
      <div className="flex flex-col gap-2">
        <label className="text-xs font-medium text-slate-400 flex items-center gap-1.5">
          <Radio className="w-3.5 h-3.5 text-sky-400" />
          <span>Internal Signal Generator</span>
        </label>
        <div className="grid grid-cols-3 gap-2">
          {presets.map((p) => (
            <button
              key={p.f}
              onClick={() => handleSelectPreset(p.f)}
              className={`px-2 py-2 text-xs rounded-lg font-mono font-medium border text-center transition ${
                sourceType === 'generator' && generatorType === 'sine' && Math.abs(freq1 - p.f) < 0.1
                  ? 'bg-sky-600 border-sky-400 text-white shadow-md'
                  : 'bg-slate-800/80 border-slate-700 text-slate-300 hover:bg-slate-700'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-3 gap-2 mt-1">
          <button
            onClick={handleSelectDual}
            className={`px-2 py-1.5 text-xs rounded-lg border transition ${
              sourceType === 'generator' && generatorType === 'dual'
                ? 'bg-purple-600 border-purple-400 text-white shadow'
                : 'bg-slate-800/80 border-slate-700 text-slate-300 hover:bg-slate-700'
            }`}
          >
            Dual Tone (54+216Hz)
          </button>
          <button
            onClick={handleSelectSweep}
            className={`px-2 py-1.5 text-xs rounded-lg border transition ${
              sourceType === 'generator' && generatorType === 'sweep'
                ? 'bg-emerald-600 border-emerald-400 text-white shadow'
                : 'bg-slate-800/80 border-slate-700 text-slate-300 hover:bg-slate-700'
            }`}
          >
            Sweep (40-300Hz)
          </button>
          <button
            onClick={handleSelectSilence}
            className={`px-2 py-1.5 text-xs rounded-lg border transition ${
              sourceType === 'generator' && generatorType === 'silence'
                ? 'bg-slate-700 border-slate-500 text-white shadow'
                : 'bg-slate-800/80 border-slate-700 text-slate-300 hover:bg-slate-700'
            }`}
          >
            Silence (0 Input)
          </button>
        </div>
      </div>

      {/* Manual Frequency Slider */}
      {sourceType === 'generator' && generatorType === 'sine' && (
        <div className="flex flex-col gap-1.5 bg-slate-950/40 p-2.5 rounded-lg border border-slate-800">
          <div className="flex justify-between text-xs">
            <span className="text-slate-400">Continuous Tuning:</span>
            <span className="font-mono text-sky-400 font-semibold">{freq1.toFixed(1)} Hz</span>
          </div>
          <input
            type="range"
            min="20"
            max="500"
            step="0.5"
            value={freq1}
            onChange={handleFreqSlider}
            className="w-full accent-sky-500 cursor-pointer"
          />
        </div>
      )}

      {/* Microphone & File Audio Row */}
      <div className="grid grid-cols-2 gap-2 pt-1 border-t border-slate-800">
        <button
          onClick={handleToggleMic}
          className={`flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium rounded-lg border transition ${
            isMicActive
              ? 'bg-rose-600 border-rose-400 text-white shadow animate-pulse'
              : 'bg-slate-800/80 border-slate-700 text-slate-300 hover:bg-slate-700'
          }`}
        >
          {isMicActive ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
          <span>{isMicActive ? 'Stop Mic (Safe)' : 'Use Microphone'}</span>
        </button>

        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*"
            onChange={handleFileUpload}
            className="hidden"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium rounded-lg border bg-slate-800/80 border-slate-700 text-slate-300 hover:bg-slate-700 transition"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>Upload Audio File</span>
          </button>
        </div>
      </div>

      {/* Microphone Status Notice / Inline Alert */}
      {micErrorMessage && (
        <div className="bg-rose-950/70 border border-rose-800 p-2.5 rounded-lg text-xs text-rose-200 flex items-start justify-between gap-2 shadow-sm">
          <div className="flex items-start gap-1.5">
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              <span className="font-semibold block text-rose-300">Microphone Notice</span>
              <p className="text-[11px] text-rose-200/90 leading-relaxed">{micErrorMessage}</p>
            </div>
          </div>
          <button
            onClick={() => setMicErrorMessage(null)}
            className="text-rose-400 hover:text-white text-xs px-1.5 py-0.5 rounded hover:bg-rose-900/50 transition font-bold"
            title="Dismiss notice"
          >
            ✕
          </button>
        </div>
      )}

      {/* Mic Monitor Opt-In Warning (Feedback Prevention) */}
      {isMicActive && (
        <div className="bg-amber-950/30 p-2 rounded border border-amber-800/60 flex items-center justify-between text-xs">
          <span className="text-amber-300 text-[11px]">
            Mic Speaker Monitor: {isMicMonitoring ? 'AUDIBLE (Caution: Feedback)' : 'MUTED (Feedback Isolated)'}
          </span>
          <button
            onClick={() => {
              const next = !isMicMonitoring;
              setIsMicMonitoring(next);
              audioEngine.setMicMonitoring(next);
            }}
            className={`px-2 py-0.5 rounded text-[10px] font-bold border transition ${
              isMicMonitoring
                ? 'bg-rose-900 border-rose-600 text-rose-200'
                : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
            }`}
          >
            {isMicMonitoring ? 'Mute Monitor' : 'Enable Monitor'}
          </button>
        </div>
      )}

      {/* File playback controls if loaded */}
      {isFileLoaded && sourceType === 'file' && (
        <div className="bg-slate-950/70 p-2 rounded border border-slate-700 flex flex-col gap-1.5 text-xs">
          <div className="flex items-center justify-between">
            <span className="truncate max-w-[150px] font-mono text-slate-300">{fileName}</span>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => {
                  const next = !isFileLooping;
                  setIsFileLooping(next);
                  audioEngine.setFileLooping(next);
                }}
                className={`px-2 py-0.5 rounded text-[10px] font-medium border transition ${
                  isFileLooping
                    ? 'bg-indigo-900 border-indigo-600 text-indigo-200'
                    : 'bg-slate-800 border-slate-700 text-slate-400'
                }`}
              >
                {isFileLooping ? 'Loop: ON' : 'Loop: OFF'}
              </button>
              <button
                onClick={handleToggleFilePlay}
                className="flex items-center gap-1 px-2.5 py-1 bg-sky-600 hover:bg-sky-500 rounded text-white"
              >
                {isPlayingFile ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
                <span>{isPlayingFile ? 'Pause' : 'Play'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Excitation Amplitude / Gain Slider */}
      <div className="flex flex-col gap-1.5 pt-1">
        <div className="flex justify-between text-xs">
          <span className="text-slate-400">
            Excitation Digital Gain <span className="text-[10px] text-slate-500">(Uncalibrated Demo Setting)</span>:
          </span>
          <span className="font-mono text-slate-200 font-semibold">{gain.toFixed(2)}x</span>
        </div>
        <input
          type="range"
          min="0.1"
          max="5.0"
          step="0.05"
          value={gain}
          onChange={handleGainSlider}
          className="w-full accent-sky-500 cursor-pointer"
        />
        <div className="flex justify-between text-[10px] text-slate-500 font-mono">
          <span>0.1x (Fine grain)</span>
          <span>Mode: {isPointForce ? 'Effective Shaker Force' : 'Acoustic Field'}</span>
          <span>5.0x (High energy)</span>
        </div>
      </div>

      {/* Live Oscilloscope */}
      <div className="flex flex-col gap-1">
        <div className="flex justify-between items-center text-[11px] text-slate-400">
          <span>Real-time Waveform Stream (Time-Domain s(t))</span>
          <span className="text-slate-500 font-mono">Sampled Integration</span>
        </div>
        <div className="w-full h-14 rounded-lg overflow-hidden border border-slate-800 bg-slate-950">
          <canvas ref={oscCanvasRef} width={320} height={56} className="w-full h-full block" />
        </div>
      </div>
    </div>
  );
};
