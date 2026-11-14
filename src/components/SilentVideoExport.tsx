/**
 * SilentVideoExport: Memory-bounded Silent PCM WAV-to-Video Export UI.
 *
 * - Minimal collapsible panel preserving the Stage 7/8 idle control layout.
 * - Uses an accessible <label> + <input type="file"> (iOS Safari compatible, no hidden .click()).
 * - Displays explicit validation, buffering, simulation/recording progress, foreground/screen-lock
 *   warning, Cancel, and Save / Share Video actions backed by OPFS.
 */

import React, { useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, Download, Play, Share2, Upload, Video, X } from 'lucide-react';
import { AudioEngine } from '../audio/audioEngine.ts';
import { WavFormatInfo } from '../audio/wavPcmStream.ts';
import {
  ActiveSilentVideoExportController,
  removeOpfsExportFile,
  saveOrShareExportedVideo,
  SilentVideoExportProgress,
  SilentVideoExportResult,
  startSilentVideoExport,
} from '../video/silentVideoExport.ts';

interface SilentVideoExportProps {
  audioEngine: AudioEngine;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  onPrepareSimulation: (info: WavFormatInfo) => void;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const totalSec = Math.floor(seconds);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}:${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
  }
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function formatMegabytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0.0 MB';
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isWavFileName(fileName: string): boolean {
  return fileName.trim().toLowerCase().endsWith('.wav');
}

const ACCEPTED_WAV_TYPES = '.wav,audio/wav,audio/x-wav,audio/wave';

const INITIAL_PROGRESS: SilentVideoExportProgress = {
  phase: 'idle',
  sourceFileName: '',
  wavInfo: null,
  codec: null,
  simulatedTimeSec: 0,
  durationSec: 0,
  progressPct: 0,
  bufferedAheadSec: 0,
  bytesWritten: 0,
  backgroundWarning: false,
  message: '',
};

export const SilentVideoExport: React.FC<SilentVideoExportProps> = ({
  audioEngine,
  canvasRef,
  onPrepareSimulation,
}) => {
  const wavInputId = useId();
  const [isOpen, setIsOpen] = useState(false);
  const [progress, setProgress] = useState<SilentVideoExportProgress>(INITIAL_PROGRESS);
  const [result, setResult] = useState<SilentVideoExportResult | null>(null);
  const [saveFeedback, setSaveFeedback] = useState<string | null>(null);
  const [pendingWavFile, setPendingWavFile] = useState<File | null>(null);

  const controllerRef = useRef<ActiveSilentVideoExportController | null>(null);
  const resultRef = useRef<SilentVideoExportResult | null>(null);

  useEffect(() => {
    resultRef.current = result;
  }, [result]);

  useEffect(() => {
    return () => {
      void controllerRef.current?.cancel();
      if (resultRef.current?.opfsFileName) {
        void removeOpfsExportFile(resultRef.current.opfsFileName);
      }
    };
  }, []);

  const isActive =
    progress.phase === 'validating' ||
    progress.phase === 'buffering' ||
    progress.phase === 'recording' ||
    progress.phase === 'finalizing';

  const effectiveOpen = isOpen || progress.phase !== 'idle' || result !== null || pendingWavFile !== null;

  const runExportForFile = async (file: File) => {
    const canvasEl = canvasRef.current;
    if (!canvasEl) {
      setProgress({
        ...INITIAL_PROGRESS,
        phase: 'error',
        sourceFileName: file.name,
        message: 'Chladni plate canvas is not mounted yet.',
      });
      return;
    }

    // Discard any previous completed OPFS file before starting a new export
    if (result?.opfsFileName) {
      void removeOpfsExportFile(result.opfsFileName);
      setResult(null);
    }

    // Wake AudioContext inside the user gesture before async header/OPFS checks
    await audioEngine.resumeContext();

    const controller = startSilentVideoExport({
      audioEngine,
      sourceCanvas: canvasEl,
      wavFile: file,
      onPrepareSimulation,
      onProgress: (nextProgress) => {
        setProgress(nextProgress);
      },
    });
    controllerRef.current = controller;

    try {
      const exported = await controller.promise;
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setPendingWavFile(null);
        setResult(exported);
      }
    } catch (err) {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
      if (err instanceof Error && err.name === 'AudioContextSuspendedError') {
        setPendingWavFile(file);
      }
    }
  };

  const handleWavSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    setSaveFeedback(null);
    setPendingWavFile(null);

    if (!isWavFileName(file.name)) {
      setProgress({
        ...INITIAL_PROGRESS,
        phase: 'error',
        sourceFileName: file.name,
        message: 'Unsupported file extension. Please choose a .wav PCM audio file.',
      });
      return;
    }

    await runExportForFile(file);
  };

  const handleResumePendingExport = async () => {
    if (!pendingWavFile) return;
    const file = pendingWavFile;
    setPendingWavFile(null);
    setSaveFeedback(null);
    await runExportForFile(file);
  };

  const handleCancel = async () => {
    const ctrl = controllerRef.current;
    controllerRef.current = null;
    if (ctrl) {
      await ctrl.cancel();
    }
  };

  const handleSaveOrShare = async () => {
    if (!result) return;
    setSaveFeedback(null);
    try {
      const outcome = await saveOrShareExportedVideo(result);
      if (outcome === 'shared') {
        setSaveFeedback('Shared via device share sheet.');
      } else if (outcome === 'downloaded') {
        setSaveFeedback(`Saved ${result.downloadFileName}.`);
      } else {
        setSaveFeedback('Share dismissed; video remains ready to save.');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSaveFeedback(`Save failed: ${msg}`);
    }
  };

  const handleDiscard = async () => {
    setSaveFeedback(null);
    if (result?.opfsFileName) {
      await removeOpfsExportFile(result.opfsFileName);
    }
    setResult(null);
    setProgress(INITIAL_PROGRESS);
  };

  return (
    <details
      open={effectiveOpen}
      onToggle={(e) => {
        setIsOpen(e.currentTarget.open);
      }}
      data-testid="silent-video-export"
      data-export-phase={progress.phase}
      data-export-codec={progress.codec?.mimeType ?? ''}
      data-export-ext={progress.codec?.extension ?? ''}
      data-export-audio-tracks={result ? String(result.audioTrackCount) : ''}
      data-export-bytes={String(progress.bytesWritten)}
      className="w-full max-w-xl mx-auto rounded-xl bg-slate-900/75 border border-slate-800/90 text-slate-200 text-xs"
    >
      <summary
        onClick={() => {
          void audioEngine.resumeContext();
        }}
        className="list-none cursor-pointer select-none px-4 py-2.5 flex items-center justify-between gap-3 text-slate-300 hover:text-white transition-colors"
      >
        <span className="flex items-center gap-2 font-medium">
          <Video className="w-3.5 h-3.5 text-sky-400 shrink-0" />
          <span>Export Silent Video (WAV)</span>
        </span>
        <span className="flex items-center gap-2 text-[11px] text-slate-400">
          <span>{isActive ? `${progress.progressPct.toFixed(0)}%` : 'Disk-streamed, no audio track'}</span>
          <ChevronDown
            className={`w-3.5 h-3.5 transition-transform ${effectiveOpen ? 'rotate-180' : ''}`}
          />
        </span>
      </summary>

      {effectiveOpen && (
        <div className="px-4 pb-3.5 pt-2 border-t border-slate-800/80 flex flex-col gap-2.5">
          <div className="flex items-start gap-2 rounded-lg bg-amber-950/35 border border-amber-800/40 px-2.5 py-2 text-[11px] text-amber-200/90">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
            <span>
              Runs in real time at 480&times;480 (30 fps) directly to browser disk (OPFS) with zero speaker output. Keep this tab active and screen unlocked while exporting.
            </span>
          </div>

          <div className="flex items-center justify-between gap-2 flex-wrap">
            {!isActive && (
              <>
                <input
                  id={wavInputId}
                  type="file"
                  accept={ACCEPTED_WAV_TYPES}
                  onChange={handleWavSelect}
                  data-testid="silent-wav-file-input"
                  className="peer sr-only"
                />
                <label
                  htmlFor={wavInputId}
                  onClick={() => {
                    void audioEngine.resumeContext();
                  }}
                  className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-100 border border-slate-700 cursor-pointer select-none peer-focus-visible:ring-2 peer-focus-visible:ring-sky-400 transition-colors"
                >
                  <Upload className="w-3.5 h-3.5" />
                  <span>{result ? 'Export Another WAV' : 'Choose WAV File'}</span>
                </label>
              </>
            )}

            {!isActive && pendingWavFile && (
              <button
                type="button"
                onClick={handleResumePendingExport}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold bg-sky-600 hover:bg-sky-500 text-white transition-colors"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>Start Silent Export</span>
              </button>
            )}

            {progress.sourceFileName && (
              <span className="text-[11px] text-slate-300 truncate max-w-[240px]" title={progress.sourceFileName}>
                {progress.sourceFileName}
                {progress.wavInfo
                  ? ` • ${progress.wavInfo.channels === 2 ? 'Stereo' : 'Mono'} ${progress.wavInfo.bitsPerSample}-bit @ ${(progress.wavInfo.sampleRate / 1000).toFixed(1)} kHz`
                  : ''}
              </span>
            )}

            {isActive && (
              <button
                type="button"
                onClick={handleCancel}
                className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-rose-600/90 hover:bg-rose-500 text-white transition-colors"
              >
                <X className="w-3.5 h-3.5" />
                <span>Cancel</span>
              </button>
            )}
          </div>

          {progress.phase !== 'idle' && (
            <div className="flex flex-col gap-1.5 rounded-lg bg-slate-950/70 border border-slate-800 px-3 py-2">
              <div className="flex items-center justify-between gap-2 text-[11px]">
                <span
                  className={`font-medium ${
                    progress.phase === 'error'
                      ? 'text-rose-400'
                      : progress.phase === 'ready'
                        ? 'text-emerald-400'
                        : 'text-sky-300'
                  }`}
                >
                  {progress.message || progress.phase}
                </span>
                {progress.durationSec > 0 && (
                  <span className="font-mono text-slate-400 shrink-0">
                    {formatDuration(progress.simulatedTimeSec)} / {formatDuration(progress.durationSec)} ({progress.progressPct.toFixed(1)}%)
                  </span>
                )}
              </div>

              {isActive && progress.durationSec > 0 && (
                <div className="w-full h-1.5 rounded-full bg-slate-800 overflow-hidden">
                  <div
                    className="h-full bg-sky-500 transition-all duration-150"
                    style={{ width: `${progress.progressPct}%` }}
                  />
                </div>
              )}

              {(isActive || progress.bytesWritten > 0) && (
                <div className="flex items-center justify-between text-[10px] font-mono text-slate-500">
                  <span>
                    {progress.codec ? progress.codec.extension.toUpperCase() : 'Video'} written: {formatMegabytes(progress.bytesWritten)}
                  </span>
                  {isActive && <span>Buffer ahead: {progress.bufferedAheadSec.toFixed(1)}s</span>}
                </div>
              )}

              {progress.backgroundWarning && isActive && (
                <p className="text-[11px] text-amber-300">
                  Tab went to background during export; keep page visible to avoid frame drops or browser suspension.
                </p>
              )}
            </div>
          )}

          {result && (
            <div className="flex items-center justify-between gap-2 flex-wrap pt-0.5">
              <div className="flex items-center gap-1.5 text-[11px] text-emerald-300">
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                <span>
                  {result.downloadFileName} ({formatMegabytes(result.sizeBytes)}, 0 audio tracks)
                </span>
              </div>
              <div className="flex items-center gap-2 ml-auto">
                <button
                  type="button"
                  onClick={handleDiscard}
                  className="px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
                >
                  Discard
                </button>
                <button
                  type="button"
                  onClick={handleSaveOrShare}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white transition-colors"
                >
                  {typeof navigator !== 'undefined' && typeof navigator.share === 'function' ? (
                    <Share2 className="w-3.5 h-3.5" />
                  ) : (
                    <Download className="w-3.5 h-3.5" />
                  )}
                  <span>Save / Share Video</span>
                </button>
              </div>
              {saveFeedback && <p className="w-full text-[11px] text-slate-400">{saveFeedback}</p>}
            </div>
          )}
        </div>
      )}
    </details>
  );
};
