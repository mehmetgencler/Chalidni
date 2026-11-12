/**
 * AudioExciter: Minimal Realistic Audio Controls for Chladni Plate Simulation
 * 
 * Conforms to STAGE 7 Requirements:
 * 1. Single test-tone sine generator: 20 Hz to 20,000 Hz with logarithmic slider mapping.
 * 2. Uploaded audio file playback: File selection, Play/Pause, playback progress bar.
 * 3. Zero microphone code or controls.
 * 4. Zero unnecessary presets, gain sliders, or mode toggles.
 */

import React, { useRef, useState, useEffect } from 'react';
import { Play, Pause, Upload, Volume2, Square, Music } from 'lucide-react';
import { AudioEngine, PlaybackProgress } from '../audio/audioEngine.ts';

interface AudioExciterProps {
  audioEngine: AudioEngine;
  onFrequencyChange: (f: number) => void;
  onToneStateChange: (isPlaying: boolean, frequency: number) => void;
}

// Logarithmic slider mapping: f = 20 * (20000 / 20)^u, for u in [0, 1]
const F_MIN = 20;
const F_MAX = 20000;
const LOG_RATIO = Math.log10(F_MAX / F_MIN); // log10(1000) = 3

function freqToSlider(f: number): number {
  const clamped = Math.max(F_MIN, Math.min(F_MAX, f));
  return Math.log10(clamped / F_MIN) / LOG_RATIO;
}

function sliderToFreq(u: number): number {
  const clamped = Math.max(0, Math.min(1, u));
  return F_MIN * Math.pow(10, clamped * LOG_RATIO);
}

function formatFrequency(f: number): string {
  if (f < 100) return `${f.toFixed(2)} Hz`;
  if (f < 1000) return `${f.toFixed(1)} Hz`;
  if (f < 10000) return `${(f / 1000).toFixed(2)} kHz (${Math.round(f)} Hz)`;
  return `${(f / 1000).toFixed(1)} kHz (${Math.round(f)} Hz)`;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

export const AudioExciter: React.FC<AudioExciterProps> = ({
  audioEngine,
  onFrequencyChange,
  onToneStateChange,
}) => {
  const [activeTab, setActiveTab] = useState<'tone' | 'file'>('tone');
  const [frequency, setFrequency] = useState<number>(269.82); // (1,3)+(3,1) Chladni resonance by default
  const [isToneActive, setIsToneActive] = useState<boolean>(false);

  // File playback state
  const [fileProgress, setFileProgress] = useState<PlaybackProgress>({
    currentTime: 0,
    duration: 0,
    isPlaying: false,
    fileName: '',
  });

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Subscribe to file progress
  useEffect(() => {
    const unsub = audioEngine.onProgress((progress) => {
      setFileProgress(progress);
    });
    return unsub;
  }, [audioEngine]);

  // Handle logarithmic slider change
  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const u = parseFloat(e.target.value);
    const newFreq = sliderToFreq(u);
    setFrequency(newFreq);
    audioEngine.setGeneratorFrequency(newFreq);
    onFrequencyChange(newFreq);
  };

  // Toggle test tone generator
  const handleToggleTone = async () => {
    if (isToneActive) {
      audioEngine.stopTone();
      setIsToneActive(false);
      onToneStateChange(false, frequency);
    } else {
      await audioEngine.resumeContext();
      await audioEngine.startTone(frequency);
      setIsToneActive(true);
      onToneStateChange(true, frequency);
    }
  };

  // Handle audio file selection
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (isToneActive) {
      audioEngine.stopTone();
      setIsToneActive(false);
      onToneStateChange(false, frequency);
    }

    await audioEngine.resumeContext();
    const ok = await audioEngine.loadAudioFile(file);
    if (ok) {
      setActiveTab('file');
    }
  };

  // Toggle audio file play / pause
  const handleToggleFilePlay = async () => {
    if (isToneActive) {
      audioEngine.stopTone();
      setIsToneActive(false);
      onToneStateChange(false, frequency);
    }

    await audioEngine.resumeContext();
    if (fileProgress.isPlaying) {
      audioEngine.pauseAudioFile();
    } else {
      audioEngine.playAudioFile();
    }
  };

  const sliderVal = freqToSlider(frequency);

  return (
    <div className="w-full max-w-xl mx-auto flex flex-col gap-3 p-4 rounded-xl bg-slate-900/80 border border-slate-800 backdrop-blur-sm text-slate-200">
      {/* Mode Selector Tabs */}
      <div className="grid grid-cols-2 p-1 bg-slate-950 rounded-lg border border-slate-800 text-xs font-medium">
        <button
          onClick={() => {
            setActiveTab('tone');
            if (fileProgress.isPlaying) audioEngine.pauseAudioFile();
          }}
          className={`flex items-center justify-center gap-2 py-2 rounded-md transition-colors ${
            activeTab === 'tone'
              ? 'bg-slate-800 text-white shadow-sm font-semibold'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Volume2 className="w-3.5 h-3.5" />
          <span>Sine Test Tone (20 Hz – 20 kHz)</span>
        </button>
        <button
          onClick={() => {
            setActiveTab('file');
            if (isToneActive) {
              audioEngine.stopTone();
              setIsToneActive(false);
              onToneStateChange(false, frequency);
            }
          }}
          className={`flex items-center justify-center gap-2 py-2 rounded-md transition-colors ${
            activeTab === 'file'
              ? 'bg-slate-800 text-white shadow-sm font-semibold'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Music className="w-3.5 h-3.5" />
          <span>Audio File Playback</span>
        </button>
      </div>

      {/* SECTION A: SINGLE-TONE SINE GENERATOR */}
      {activeTab === 'tone' && (
        <div className="flex flex-col gap-3 py-1">
          {/* Readout and Start/Stop Button */}
          <div className="flex items-center justify-between gap-4">
            <div>
              <span className="text-[11px] text-slate-400 uppercase tracking-wider block">Excitation Frequency</span>
              <span className="text-xl sm:text-2xl font-mono font-semibold text-sky-400 tracking-tight">
                {formatFrequency(frequency)}
              </span>
            </div>

            <button
              onClick={handleToggleTone}
              className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold transition-all shadow-md active:scale-95 ${
                isToneActive
                  ? 'bg-rose-600 hover:bg-rose-500 text-white'
                  : 'bg-sky-600 hover:bg-sky-500 text-white'
              }`}
            >
              {isToneActive ? <Square className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current" />}
              <span>{isToneActive ? 'Stop Tone' : 'Start Tone'}</span>
            </button>
          </div>

          {/* Logarithmic Frequency Slider */}
          <div className="flex flex-col gap-1.5 pt-1">
            <input
              type="range"
              min="0"
              max="1"
              step="0.001"
              value={sliderVal}
              onChange={handleSliderChange}
              aria-label="Excitation Frequency (Logarithmic 20 Hz to 20,000 Hz)"
              className="w-full h-2 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-sky-400 focus:outline-none"
            />
            <div className="flex justify-between text-[10px] font-mono text-slate-500">
              <span>20 Hz</span>
              <span>100 Hz</span>
              <span>1 kHz</span>
              <span>10 kHz</span>
              <span>20 kHz</span>
            </div>
          </div>
        </div>
      )}

      {/* SECTION B: UPLOADED AUDIO FILE PLAYBACK */}
      {activeTab === 'file' && (
        <div className="flex flex-col gap-3 py-1">
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*"
            onChange={handleFileSelect}
            className="hidden"
          />

          <div className="flex items-center justify-between gap-3">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors shadow-sm"
            >
              <Upload className="w-3.5 h-3.5" />
              <span>{fileProgress.fileName ? 'Change Audio File' : 'Choose Audio File'}</span>
            </button>

            {fileProgress.fileName ? (
              <span className="text-xs text-slate-300 truncate max-w-[220px] font-medium" title={fileProgress.fileName}>
                {fileProgress.fileName}
              </span>
            ) : (
              <span className="text-xs text-slate-500 italic">No audio file loaded</span>
            )}

            {fileProgress.fileName && (
              <button
                onClick={handleToggleFilePlay}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white transition-all shadow-sm active:scale-95 ml-auto"
              >
                {fileProgress.isPlaying ? (
                  <>
                    <Pause className="w-3.5 h-3.5 fill-current" />
                    <span>Pause</span>
                  </>
                ) : (
                  <>
                    <Play className="w-3.5 h-3.5 fill-current" />
                    <span>Play</span>
                  </>
                )}
              </button>
            )}
          </div>

          {/* Audio progress bar */}
          {fileProgress.fileName && (
            <div className="flex flex-col gap-1.5 pt-1">
              <div className="flex justify-between text-[11px] font-mono text-slate-400">
                <span>{formatTime(fileProgress.currentTime)}</span>
                <span>{formatTime(fileProgress.duration)}</span>
              </div>
              <div
                className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden cursor-pointer relative"
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const pct = (e.clientX - rect.left) / rect.width;
                  audioEngine.seekAudioFile(pct * fileProgress.duration);
                }}
              >
                <div
                  className="h-full bg-emerald-500 transition-all duration-100"
                  style={{
                    width: `${fileProgress.duration > 0 ? (fileProgress.currentTime / fileProgress.duration) * 100 : 0}%`,
                  }}
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
