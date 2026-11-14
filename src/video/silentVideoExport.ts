/**
 * silentVideoExport.ts: Memory-bounded Silent PCM WAV-to-Video Export Controller.
 *
 * - Reads long PCM WAV files via bounded slice streaming (AudioEngine.startSilentWavStream).
 * - Captures ONLY the rendered Chladni PlateCanvas (downscaled to 480x480 at 12 FPS, 0 audio tracks).
 * - Selects H.264 MP4 when MediaRecorder.isTypeSupported allows, with matching container/extension fallback.
 * - Streams encoded MediaRecorder timeslice chunks sequentially straight into OPFS via Web Worker.
 * - Never accumulates recording Blobs in JS heap memory.
 */

import { AudioEngine } from '../audio/audioEngine.ts';
import { parseWavHeader, WavFormatInfo } from '../audio/wavPcmStream.ts';
import type { WorkerInboundMessage, WorkerOutboundMessage } from './videoFileWriter.worker.ts';

export type ExportPhase =
  | 'idle'
  | 'validating'
  | 'buffering'
  | 'recording'
  | 'finalizing'
  | 'ready'
  | 'cancelled'
  | 'error';

export interface VideoCodecSelection {
  mimeType: string;
  baseMimeType: string;
  extension: 'mp4' | 'webm';
}

export interface StoragePreflightResult {
  estimatedVideoBytes: number;
  requiredBytesWithHeadroom: number;
  availableQuotaBytes: number | null;
  persistentStorageGranted: boolean;
}

export interface SilentVideoExportProgress {
  phase: ExportPhase;
  sourceFileName: string;
  wavInfo: WavFormatInfo | null;
  codec: VideoCodecSelection | null;
  simulatedTimeSec: number;
  durationSec: number;
  progressPct: number;
  bufferedAheadSec: number;
  bytesWritten: number;
  backgroundWarning: boolean;
  message: string;
}

export interface SilentVideoExportResult {
  file: File;
  downloadFileName: string;
  opfsFileName: string;
  mimeType: string;
  extension: 'mp4' | 'webm';
  sizeBytes: number;
  durationSec: number;
  codecMimeType: string;
  videoTrackCount: number;
  audioTrackCount: number;
  chunksWritten: number;
}

export interface SilentVideoExportOptions {
  audioEngine: AudioEngine;
  sourceCanvas: HTMLCanvasElement;
  wavFile: File;
  onPrepareSimulation: (info: WavFormatInfo) => void;
  onProgress: (progress: SilentVideoExportProgress) => void;
}

export const EXPORT_WIDTH = 480;
export const EXPORT_HEIGHT = 480;
export const EXPORT_FPS = 12;
export const EXPORT_VIDEO_BITRATE_BPS = 200_000;
export const EXPORT_TIMESLICE_MS = 2000;

const CODEC_CANDIDATES: VideoCodecSelection[] = [
  { mimeType: 'video/mp4;codecs=avc1.42E01E', baseMimeType: 'video/mp4', extension: 'mp4' },
  { mimeType: 'video/mp4;codecs=avc1.4D401E', baseMimeType: 'video/mp4', extension: 'mp4' },
  { mimeType: 'video/mp4;codecs=avc1', baseMimeType: 'video/mp4', extension: 'mp4' },
  { mimeType: 'video/mp4', baseMimeType: 'video/mp4', extension: 'mp4' },
  { mimeType: 'video/webm;codecs=vp9', baseMimeType: 'video/webm', extension: 'webm' },
  { mimeType: 'video/webm;codecs=vp8', baseMimeType: 'video/webm', extension: 'webm' },
  { mimeType: 'video/webm', baseMimeType: 'video/webm', extension: 'webm' },
];

export function selectSupportedVideoCodec(): VideoCodecSelection {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    throw new Error('MediaRecorder video encoding is not supported in this browser.');
  }
  for (const candidate of CODEC_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(candidate.mimeType)) {
      return candidate;
    }
  }
  throw new Error('No supported silent video recording codec (MP4 H.264 or WebM) is available.');
}

export function estimateExportSizeBytes(durationSec: number, bitrateBps: number = EXPORT_VIDEO_BITRATE_BPS): {
  estimatedVideoBytes: number;
  requiredBytesWithHeadroom: number;
} {
  const safeDuration = Math.max(1, durationSec);
  const estimatedVideoBytes = Math.ceil((bitrateBps / 8) * safeDuration);
  // Allow 35% container/VBR headroom + 16 MB buffer for OPFS safety
  const requiredBytesWithHeadroom = Math.ceil(estimatedVideoBytes * 1.35) + 16 * 1024 * 1024;
  return { estimatedVideoBytes, requiredBytesWithHeadroom };
}

async function withOptionalTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timerId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timerId = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timerId !== null) clearTimeout(timerId);
  }
}

export async function runStoragePreflight(durationSec: number): Promise<StoragePreflightResult> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
    throw new Error(
      'Origin Private File System (OPFS) is unavailable here. Disk-backed export requires OPFS (avoiding RAM buffering).'
    );
  }
  if (typeof Worker === 'undefined') {
    throw new Error('Web Workers are unavailable in this browser; OPFS SyncAccessHandle writer cannot start.');
  }

  const { estimatedVideoBytes, requiredBytesWithHeadroom } = estimateExportSizeBytes(durationSec);

  let availableQuotaBytes: number | null = null;
  if (typeof navigator.storage.estimate === 'function') {
    const est = await withOptionalTimeout(navigator.storage.estimate(), 1500);
    if (est && typeof est.quota === 'number' && typeof est.usage === 'number') {
      availableQuotaBytes = Math.max(0, est.quota - est.usage);
      if (availableQuotaBytes < requiredBytesWithHeadroom) {
        const needMb = (requiredBytesWithHeadroom / (1024 * 1024)).toFixed(1);
        const availMb = (availableQuotaBytes / (1024 * 1024)).toFixed(1);
        throw new Error(
          `Insufficient browser storage quota for silent video export (need ~${needMb} MB including headroom, only ${availMb} MB available).`
        );
      }
    }
  }

  let persistentStorageGranted = false;
  if (typeof navigator.storage.persist === 'function') {
    const persisted = await withOptionalTimeout(navigator.storage.persist(), 1000);
    persistentStorageGranted = persisted === true;
  }

  return {
    estimatedVideoBytes,
    requiredBytesWithHeadroom,
    availableQuotaBytes,
    persistentStorageGranted,
  };
}

export function buildExportDownloadFileName(wavFileName: string, extension: 'mp4' | 'webm'): string {
  const base = wavFileName.replace(/\.[^/.]+$/, '').trim() || 'chladni-simulation';
  const sanitized = base.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'chladni-simulation';
  return `${sanitized}-chladni-silent.${extension}`;
}

export async function removeOpfsExportFile(opfsFileName: string): Promise<void> {
  if (!opfsFileName || typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return;
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(opfsFileName);
  } catch {
    // ignore missing or already removed OPFS entry
  }
}

export async function saveOrShareExportedVideo(result: SilentVideoExportResult): Promise<'shared' | 'downloaded' | 'cancelled'> {
  if (
    typeof navigator !== 'undefined' &&
    typeof navigator.share === 'function' &&
    typeof navigator.canShare === 'function'
  ) {
    try {
      if (navigator.canShare({ files: [result.file] })) {
        await navigator.share({
          files: [result.file],
          title: result.downloadFileName,
        });
        return 'shared';
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return 'cancelled';
      }
      // Fall through to object URL download link if Web Share failed
    }
  }

  const blobUrl = URL.createObjectURL(result.file);
  const link = document.createElement('a');
  link.href = blobUrl;
  link.download = result.downloadFileName;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => {
    URL.revokeObjectURL(blobUrl);
  }, 60_000);
  return 'downloaded';
}

export interface ActiveSilentVideoExportController {
  cancel(): Promise<void>;
  promise: Promise<SilentVideoExportResult>;
}

/**
 * Starts a complete memory-bounded silent WAV-to-video export session.
 */
export function startSilentVideoExport(options: SilentVideoExportOptions): ActiveSilentVideoExportController {
  const { audioEngine, sourceCanvas, wavFile, onPrepareSimulation, onProgress } = options;

  let cancelled = false;
  let finished = false;
  let worker: Worker | null = null;
  let recorder: MediaRecorder | null = null;
  let captureStream: MediaStream | null = null;
  let drawIntervalId: ReturnType<typeof setInterval> | null = null;
  let exportCanvas: HTMLCanvasElement | null = null;
  let visibilityListener: (() => void) | null = null;
  let backgroundWarning = false;
  let bytesWritten = 0;
  let chunksWritten = 0;
  let chunkSeq = 0;
  let chunkTransferQueue: Promise<void> = Promise.resolve();
  let wavInfo: WavFormatInfo | null = null;
  let codec: VideoCodecSelection | null = null;
  let opfsFileName = '';

  let pendingFinalizeResolve: ((msg: Extract<WorkerOutboundMessage, { type: 'FINALIZED' }>) => void) | null = null;
  let pendingFinalizeReject: ((err: Error) => void) | null = null;
  let pendingAbortResolve: (() => void) | null = null;
  let workerFatalError: Error | null = null;
  let abortActiveRun: ((err: Error) => void) | null = null;

  const emitProgress = (
    phase: ExportPhase,
    simulatedTimeSec: number,
    bufferedAheadSec: number,
    message: string
  ) => {
    const durationSec = wavInfo ? wavInfo.durationSec : 0;
    const progressPct =
      durationSec > 0 ? Math.max(0, Math.min(100, (simulatedTimeSec / durationSec) * 100)) : 0;
    onProgress({
      phase,
      sourceFileName: wavFile.name,
      wavInfo,
      codec,
      simulatedTimeSec,
      durationSec,
      progressPct,
      bufferedAheadSec,
      bytesWritten,
      backgroundWarning,
      message,
    });
  };

  const stopRenderLoopAndTracks = () => {
    if (drawIntervalId !== null) {
      clearInterval(drawIntervalId);
      drawIntervalId = null;
    }
    if (visibilityListener && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', visibilityListener);
      visibilityListener = null;
    }
    if (captureStream) {
      for (const track of captureStream.getTracks()) {
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
      captureStream = null;
    }
    if (exportCanvas) {
      exportCanvas.width = 0;
      exportCanvas.height = 0;
      exportCanvas = null;
    }
  };

  const terminateWorker = () => {
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      try {
        worker.terminate();
      } catch {
        // ignore
      }
      worker = null;
    }
  };

  const abortWorkerSafely = async () => {
    if (!worker) {
      if (opfsFileName) await removeOpfsExportFile(opfsFileName);
      return;
    }
    await new Promise<void>((resolve) => {
      pendingAbortResolve = resolve;
      const timer = setTimeout(() => {
        pendingAbortResolve = null;
        resolve();
      }, 1500);
      try {
        worker!.postMessage({ type: 'ABORT' } satisfies WorkerInboundMessage);
      } catch {
        clearTimeout(timer);
        pendingAbortResolve = null;
        resolve();
        return;
      }
      const prevResolve = pendingAbortResolve;
      pendingAbortResolve = () => {
        clearTimeout(timer);
        prevResolve?.();
      };
    });
    terminateWorker();
    if (opfsFileName) {
      await removeOpfsExportFile(opfsFileName);
    }
  };

  const cancel = async () => {
    if (cancelled || finished) return;
    cancelled = true;
    audioEngine.cancelSilentWavStream();
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        // ignore
      }
    }
    stopRenderLoopAndTracks();
    abortActiveRun?.(new Error('Silent video export cancelled by user.'));
    await abortWorkerSafely();
    emitProgress('cancelled', 0, 0, 'Export cancelled; temporary OPFS file removed.');
  };

  const promise = (async (): Promise<SilentVideoExportResult> => {
    try {
      emitProgress('validating', 0, 0, 'Checking browser capture & OPFS support...');

      codec = selectSupportedVideoCodec();
      if (typeof sourceCanvas.captureStream !== 'function') {
        throw new Error('HTMLCanvasElement.captureStream() is unavailable in this browser.');
      }

      emitProgress('validating', 0, 0, 'Validating PCM WAV header...');
      wavInfo = await parseWavHeader(wavFile);
      if (cancelled) throw new Error('Silent video export cancelled by user.');

      emitProgress('validating', 0, 0, 'Checking browser storage quota...');
      await runStoragePreflight(wavInfo.durationSec);
      if (cancelled) throw new Error('Silent video export cancelled by user.');

      // Open OPFS SyncAccessHandle writer Worker immediately so unsupported environments fail fast
      emitProgress('validating', 0, 0, 'Opening disk video writer (OPFS)...');
      opfsFileName = `chladni-export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${codec.extension}`;
      worker = new Worker(new URL('./videoFileWriter.worker.ts', import.meta.url), { type: 'module' });

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const initTimeout = setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(
              new Error(
                'Timed out opening OPFS disk video writer. Private browsing or restricted iframes may block OPFS SyncAccessHandle.'
              )
            );
          }
        }, 5000);

        const finishInitResolve = () => {
          clearTimeout(initTimeout);
          if (!settled) {
            settled = true;
            resolve();
          }
        };
        const finishInitReject = (err: Error) => {
          clearTimeout(initTimeout);
          if (!settled) {
            settled = true;
            reject(err);
          }
        };

        worker!.onmessage = (event: MessageEvent<WorkerOutboundMessage>) => {
          const msg = event.data;
          if (!msg) return;
          if (msg.type === 'READY') {
            finishInitResolve();
            return;
          }
          if (msg.type === 'CHUNK_ACK') {
            bytesWritten = msg.bytesWritten;
            return;
          }
          if (msg.type === 'FINALIZED') {
            bytesWritten = msg.sizeBytes;
            pendingFinalizeResolve?.(msg);
            pendingFinalizeResolve = null;
            pendingFinalizeReject = null;
            return;
          }
          if (msg.type === 'ABORTED') {
            pendingAbortResolve?.();
            pendingAbortResolve = null;
            return;
          }
          if (msg.type === 'ERROR') {
            const err = new Error(msg.error);
            workerFatalError = err;
            if (!settled) {
              finishInitReject(err);
              return;
            }
            pendingFinalizeReject?.(err);
            pendingFinalizeResolve = null;
            pendingFinalizeReject = null;
            abortActiveRun?.(err);
          }
        };
        worker!.onerror = (ev) => {
          const err = new Error(ev.message || 'OPFS video writer Worker failed to load.');
          workerFatalError = err;
          if (!settled) {
            finishInitReject(err);
            return;
          }
          pendingFinalizeReject?.(err);
          abortActiveRun?.(err);
        };
        worker!.onmessageerror = () => {
          const err = new Error('OPFS video writer Worker message error.');
          workerFatalError = err;
          if (!settled) {
            finishInitReject(err);
            return;
          }
          pendingFinalizeReject?.(err);
          abortActiveRun?.(err);
        };
        worker!.postMessage({ type: 'INIT', fileName: opfsFileName } satisfies WorkerInboundMessage);
      });

      if (cancelled) throw new Error('Silent video export cancelled by user.');

      // Track backgrounding / screen lock transitions
      if (typeof document !== 'undefined') {
        visibilityListener = () => {
          if (document.visibilityState === 'hidden') {
            backgroundWarning = true;
          }
        };
        document.addEventListener('visibilitychange', visibilityListener);
      }

      // Prepare 480x480 offscreen canvas copying from PlateCanvas at 12 FPS
      exportCanvas = document.createElement('canvas');
      exportCanvas.width = EXPORT_WIDTH;
      exportCanvas.height = EXPORT_HEIGHT;
      const exportCtx = exportCanvas.getContext('2d', { alpha: false });
      if (!exportCtx) {
        throw new Error('Could not acquire 2D context for 480x480 video export canvas.');
      }

      // Prefer manual requestFrame() capture (captureStream(0)) when supported so every copied frame
      // is explicitly emitted to MediaRecorder; fall back to timed captureStream(EXPORT_FPS) otherwise.
      let manualTrack: (MediaStreamTrack & { requestFrame?: () => void }) | null = null;
      const manualCandidate = exportCanvas.captureStream(0);
      const candidateTrack = manualCandidate.getVideoTracks()[0] as
        | (MediaStreamTrack & { requestFrame?: () => void })
        | undefined;
      if (
        candidateTrack &&
        typeof candidateTrack.requestFrame === 'function' &&
        manualCandidate.getAudioTracks().length === 0
      ) {
        captureStream = manualCandidate;
        manualTrack = candidateTrack;
      } else {
        for (const t of manualCandidate.getTracks()) {
          try {
            t.stop();
          } catch {
            // ignore
          }
        }
        captureStream = exportCanvas.captureStream(EXPORT_FPS);
      }

      const drawFrameFromPlateCanvas = () => {
        if (!exportCtx || !exportCanvas || sourceCanvas.width <= 0 || sourceCanvas.height <= 0) return;
        exportCtx.drawImage(sourceCanvas, 0, 0, EXPORT_WIDTH, EXPORT_HEIGHT);
        if (manualTrack && typeof manualTrack.requestFrame === 'function') {
          try {
            manualTrack.requestFrame();
          } catch {
            // ignore if track already stopped
          }
        }
      };

      // Verify stream strictly contains video track and zero audio tracks
      const videoTrackCount = captureStream.getVideoTracks().length;
      const audioTrackCount = captureStream.getAudioTracks().length;
      if (videoTrackCount === 0 || audioTrackCount !== 0) {
        throw new Error(
          `Expected video-only canvas stream (got ${videoTrackCount} video, ${audioTrackCount} audio tracks).`
        );
      }

      const localRecorder = new MediaRecorder(captureStream, {
        mimeType: codec.mimeType,
        videoBitsPerSecond: EXPORT_VIDEO_BITRATE_BPS,
      });
      recorder = localRecorder;

      const recorderStoppedPromise = new Promise<void>((resolve, reject) => {
        localRecorder.ondataavailable = (ev: BlobEvent) => {
          if (!ev.data || ev.data.size === 0 || cancelled || workerFatalError) return;
          const seq = chunkSeq++;
          const blob = ev.data;
          chunkTransferQueue = chunkTransferQueue.then(async () => {
            if (cancelled || workerFatalError || !worker) return;
            const buf = await blob.arrayBuffer();
            if (cancelled || workerFatalError || !worker) return;
            chunksWritten++;
            worker.postMessage(
              { type: 'WRITE_CHUNK', seq, buffer: buf } satisfies WorkerInboundMessage,
              [buf]
            );
          });
        };
        localRecorder.onerror = () => {
          reject(new Error('MediaRecorder encountered an encoding error during export.'));
        };
        localRecorder.onstop = () => {
          resolve();
        };
      });

      // Stream audio slices silently through AudioEngine -> fileGain -> AudioWorkletNode
      await new Promise<void>((resolveStream, rejectStream) => {
        let settled = false;
        abortActiveRun = (err: Error) => {
          if (!settled) {
            settled = true;
            rejectStream(err);
          }
        };

        void audioEngine
          .startSilentWavStream(wavFile, {
            onPrepareSimulation,
            onStatus: (st) => {
              if (cancelled || settled) return;
              if (st.phase === 'validating') {
                emitProgress('validating', 0, st.bufferedAheadSec, 'Starting silent audio engine...');
              } else if (st.phase === 'buffering') {
                emitProgress(
                  'buffering',
                  0,
                  st.bufferedAheadSec,
                  `Buffering initial audio chunks (${st.bufferedAheadSec.toFixed(1)}s)...`
                );
              } else {
                emitProgress(
                  'recording',
                  st.simulatedTimeSec,
                  st.bufferedAheadSec,
                  backgroundWarning
                    ? 'Warning: Browser tab was backgrounded; timing/frames may be affected.'
                    : 'Simulating plate and recording silent video...'
                );
              }
            },
            onStreamStart: () => {
              if (cancelled || settled) return;
              // Draw initial reset frame and begin synchronized 12 FPS capture + 2s MediaRecorder timeslice
              drawFrameFromPlateCanvas();
              localRecorder.start(EXPORT_TIMESLICE_MS);
              drawIntervalId = setInterval(drawFrameFromPlateCanvas, Math.round(1000 / EXPORT_FPS));
              emitProgress('recording', 0, 12, 'Simulating plate and recording silent video...');
            },
            onEnded: () => {
              if (!settled) {
                settled = true;
                resolveStream();
              }
            },
            onError: (err) => {
              if (!settled) {
                settled = true;
                rejectStream(err);
              }
            },
          })
          .catch((err) => {
            if (!settled) {
              settled = true;
              rejectStream(err instanceof Error ? err : new Error(String(err)));
            }
          });
      });

      if (cancelled) throw new Error('Silent video export cancelled by user.');
      if (workerFatalError) throw workerFatalError;

      // Capture final simulated frame and stop MediaRecorder cleanly
      emitProgress(
        'finalizing',
        wavInfo.durationSec,
        0,
        'Finalizing encoded video in Origin Private File System...'
      );
      drawFrameFromPlateCanvas();
      await new Promise((r) => setTimeout(r, 140));

      if (drawIntervalId !== null) {
        clearInterval(drawIntervalId);
        drawIntervalId = null;
      }
      if (localRecorder.state !== 'inactive') {
        localRecorder.stop();
      }
      await recorderStoppedPromise;

      // Ensure all MediaRecorder chunk ArrayBuffers have transferred to the OPFS Worker
      await chunkTransferQueue;
      if (workerFatalError) throw workerFatalError;
      if (!worker) throw new Error('OPFS writer Worker terminated before finalization.');

      const finalizedMsg = await new Promise<Extract<WorkerOutboundMessage, { type: 'FINALIZED' }>>(
        (resolve, reject) => {
          pendingFinalizeResolve = resolve;
          pendingFinalizeReject = reject;
          worker!.postMessage({ type: 'FINALIZE' } satisfies WorkerInboundMessage);
        }
      );

      stopRenderLoopAndTracks();
      terminateWorker();

      const root = await navigator.storage.getDirectory();
      const fileHandle = await root.getFileHandle(finalizedMsg.fileName);
      const opfsFile = await fileHandle.getFile();
      const downloadFileName = buildExportDownloadFileName(wavFile.name, codec.extension);
      const exportFile = new File([opfsFile], downloadFileName, { type: codec.baseMimeType });

      finished = true;
      emitProgress(
        'ready',
        wavInfo.durationSec,
        0,
        `Silent video ready (${(exportFile.size / (1024 * 1024)).toFixed(2)} MB ${codec.extension.toUpperCase()}).`
      );

      return {
        file: exportFile,
        downloadFileName,
        opfsFileName: finalizedMsg.fileName,
        mimeType: codec.baseMimeType,
        extension: codec.extension,
        sizeBytes: exportFile.size,
        durationSec: wavInfo.durationSec,
        codecMimeType: codec.mimeType,
        videoTrackCount,
        audioTrackCount,
        chunksWritten,
      };
    } catch (err) {
      audioEngine.cancelSilentWavStream();
      if (recorder && recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {
          // ignore
        }
      }
      stopRenderLoopAndTracks();
      if (!cancelled) {
        await abortWorkerSafely();
        const message = err instanceof Error ? err.message : String(err);
        emitProgress('error', 0, 0, message);
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  })();

  return { cancel, promise };
}
