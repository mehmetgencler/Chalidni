/**
 * AudioEngine: Stage 8 Unified Audio Engine for Chladni Plate Simulation
 * 
 * - Routes BOTH single-tone sine generator (20 Hz - 20,000 Hz) and streamed audio files
 *   through the exact same AudioWorkletProcessor modal engine.
 * - Configures the AudioWorklet with the complete 146-mode center-coupled catalogue up to 20 kHz,
 *   preserving queued configuration messages sent prior to AudioWorkletNode readiness.
 * - Full stereo playback to speakers with unclipped 0.5 * (L + R) mono downmix to Worklet.
 * - Connects Worklet output through a silent zero-gain sink to destination so browsers always pull process().
 * - Authoritative AudioWorklet simulation clock: t = sampleFramesProcessed / sampleRate.
 * - Zero microphone code, zero getUserMedia(), zero microphone permissions.
 * - Preserves modal states on pause/stop/end for natural physical free decay.
 */

import { ModalSnapshot } from '../physics/types.ts';
import {
  createWavPcmChunkStream,
  WavByteSource,
  WavDecodedChunk,
  WavFormatInfo,
  WavPcmChunkStream,
} from './wavPcmStream.ts';

export interface WorkletModeConfig {
  m: number;
  n: number;
  frequency: number;
  omega: number;
  zeta: number;
  modalMass: number;
}

export type AudioSourceType = 'generator' | 'file';
export type ExcitationProfile = 'raw' | 'music';

export interface PlaybackProgress {
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  fileName: string;
}

export interface SilentWavStreamStatus {
  phase: 'validating' | 'buffering' | 'streaming' | 'completing';
  info: WavFormatInfo;
  simulatedTimeSec: number;
  bufferedAheadSec: number;
  framesScheduled: number;
}

export interface SilentWavStreamCallbacks {
  onStatus?: (status: SilentWavStreamStatus) => void;
  onPrepareSimulation?: (info: WavFormatInfo) => void;
  onStreamStart?: (startInfo: { startCtxTime: number; wavInfo: WavFormatInfo }) => void;
  onEnded?: (info: WavFormatInfo) => void;
  onError?: (error: Error) => void;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private isWorkletReady = false;
  private workletInitPromise: Promise<boolean> | null = null;
  private pendingWorkletMessages: { type: string; [key: string]: unknown }[] = [];
  private configuredModes: WorkletModeConfig[] | null = null;

  private sourceType: AudioSourceType = 'generator';
  private excitationProfile: ExcitationProfile = 'raw';

  // Single sine test tone generator (20 Hz – 20,000 Hz)
  private osc: OscillatorNode | null = null;
  private toneGain: GainNode | null = null;
  private currentFrequency = 269.82; // Default to (1,3)+(3,1) Chladni resonance
  private isTonePlaying = false;

  // Uploaded audio file playback: primary Web Audio AudioBufferSourceNode (iOS Safari compatible)
  // with HTMLAudioElement MediaElementAudioSourceNode fallback
  private audioBuffer: AudioBuffer | null = null;
  private bufferSource: AudioBufferSourceNode | null = null;
  private fileInputSplitter: ChannelSplitterNode | null = null;
  private fileDownmixMerger: GainNode | null = null;
  private filePlaybackStartCtxTime = 0;
  private filePlaybackOffsetSec = 0;
  private isBufferPlaying = false;
  private progressTimerId: ReturnType<typeof setInterval> | null = null;

  private audioElement: HTMLAudioElement | null = null;
  private mediaElementSource: MediaElementAudioSourceNode | null = null;
  private fileGain: GainNode | null = null;
  private audioFileUrl: string | null = null;
  private currentFileName: string = '';
  private isFileAudibleToDestination = false;
  private progressListeners: Set<(progress: PlaybackProgress) => void> = new Set();

  // Memory-bounded silent streaming WAV scheduler state (for offline video export)
  private silentStreamSessionId = 0;
  private silentStreamActive = false;
  private silentStreamPumpTimer: ReturnType<typeof setInterval> | null = null;
  private silentStreamSources: Set<AudioBufferSourceNode> = new Set();
  private silentStreamChunkStream: WavPcmChunkStream | null = null;
  private silentStreamInfo: WavFormatInfo | null = null;
  private silentStreamStartCtxTime = 0;
  private silentStreamNextFrame = 0;
  private silentStreamCompleted = false;

  // Latest snapshot received from AudioWorklet
  latestSnapshot: ModalSnapshot | null = null;
  private snapshotListeners: Set<(snapshot: ModalSnapshot) => void> = new Set();

  constructor() {
    // Lazily initialized on user gesture
  }

  get sampleRate(): number {
    return this.ctx ? this.ctx.sampleRate : 44100;
  }

  get isPlayingTone(): boolean {
    return this.isTonePlaying;
  }

  get activeSourceType(): AudioSourceType {
    return this.sourceType;
  }

  get frequency(): number {
    return this.currentFrequency;
  }

  private triggerContextResume(): Promise<void> | null {
    if (!this.ctx || (this.ctx.state as string) === 'running') {
      return null;
    }
    return this.ctx.resume().catch(() => {
      // Caller inspects ctx.state and keeps file ready until explicit Play tap if still suspended
    });
  }

  private async waitForContextResumeBounded(promise: Promise<void> | null, timeoutMs: number = 150): Promise<void> {
    if (!promise || !this.ctx || (this.ctx.state as string) === 'running') return;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        promise,
        new Promise<void>((resolve) => {
          timerId = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } finally {
      if (timerId !== null) clearTimeout(timerId);
    }
  }

  /**
   * Initializes the AudioContext and registers the AudioWorkletProcessor module
   */
  async initContext(): Promise<AudioContext> {
    if (!this.ctx) {
      const AudioContextClass =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      let sampleRateOpt: number | undefined;
      if (typeof window !== 'undefined' && typeof window.location?.search === 'string') {
        const match = window.location.search.match(/[?&]sr=(\d+)/);
        if (match) {
          const parsed = Number(match[1]);
          if (parsed === 44100 || parsed === 48000) sampleRateOpt = parsed;
        }
      }
      this.ctx = sampleRateOpt ? new AudioContextClass({ sampleRate: sampleRateOpt }) : new AudioContextClass();
    }

    // Trigger resume synchronously before awaiting ensureWorklet so browser gesture activation is preserved,
    // without deadlocking if the browser defers resume outside a synchronous tap (e.g. after file picker closes).
    const resumePromise = this.triggerContextResume();
    await this.ensureWorklet();
    await this.waitForContextResumeBounded(resumePromise, 150);
    return this.ctx;
  }

  /**
   * Ensures the real AudioWorkletProcessor is registered and connected
   */
  private async ensureWorklet(): Promise<boolean> {
    if (this.isWorkletReady && this.workletNode) return true;
    if (this.workletInitPromise) return this.workletInitPromise;

    this.workletInitPromise = (async () => {
      try {
        if (!this.ctx) return false;

        const workletUrl = '/audio/modal-worklet-processor.js';
        let addModuleTimer: ReturnType<typeof setTimeout> | null = null;
        await Promise.race([
          this.ctx.audioWorklet.addModule(workletUrl),
          new Promise<never>((_, reject) => {
            addModuleTimer = setTimeout(() => {
              reject(new Error('Timed out loading AudioWorklet modal processor module.'));
            }, 6000);
          }),
        ]).finally(() => {
          if (addModuleTimer !== null) clearTimeout(addModuleTimer);
        });

        this.workletNode = new AudioWorkletNode(this.ctx, 'modal-worklet-processor', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        });

        // Set up snapshot reception from worklet thread
        this.workletNode.port.onmessage = (event) => {
          const data = event.data;
          if (data && data.type === 'MODAL_SNAPSHOT') {
            this.latestSnapshot = data as ModalSnapshot;
            for (const listener of this.snapshotListeners) {
              listener(this.latestSnapshot);
            }
          }
        };

        // Generator sub-bus
        this.toneGain = this.ctx.createGain();
        this.toneGain.gain.setValueAtTime(0.0, this.ctx.currentTime);
        this.toneGain.connect(this.workletNode);
        // Connect tone to speakers at comfortable monitoring level
        const audibleMonitor = this.ctx.createGain();
        audibleMonitor.gain.setValueAtTime(0.08, this.ctx.currentTime);
        this.toneGain.connect(audibleMonitor);
        audibleMonitor.connect(this.ctx.destination);

        // File sub-bus for mono worklet excitation
        this.fileGain = this.ctx.createGain();
        this.fileGain.gain.setValueAtTime(1.0, this.ctx.currentTime);
        this.fileGain.connect(this.workletNode);

        // Silent zero-gain sink guarantees browser audio graph continuously pulls process()
        const workletSink = this.ctx.createGain();
        workletSink.gain.setValueAtTime(0.0, this.ctx.currentTime);
        this.workletNode.connect(workletSink);
        workletSink.connect(this.ctx.destination);

        this.isWorkletReady = true;

        // Flush any buffered messages sent prior to initialization (including CONFIGURE_MODES)
        while (this.pendingWorkletMessages.length > 0) {
          const msg = this.pendingWorkletMessages.shift();
          this.workletNode.port.postMessage(msg);
        }

        return true;
      } catch (err) {
        console.error('AudioWorklet initialization error:', err);
        this.isWorkletReady = false;
        this.workletInitPromise = null;
        return false;
      }
    })();

    return this.workletInitPromise;
  }

  /**
   * Configures the AudioWorkletProcessor with the active analytical plate modal catalogue.
   * Preserves configuration in the initialization queue if called prior to AudioWorkletNode readiness.
   */
  configureModes(modes: WorkletModeConfig[]): void {
    this.configuredModes = modes;
    const message = { type: 'CONFIGURE_MODES', modes };
    if (this.workletNode && this.isWorkletReady) {
      this.workletNode.port.postMessage(message);
    } else {
      // Replace any earlier un-flushed CONFIGURE_MODES so latest full catalogue is delivered
      const existingIdx = this.pendingWorkletMessages.findIndex((m) => m.type === 'CONFIGURE_MODES');
      if (existingIdx >= 0) {
        this.pendingWorkletMessages[existingIdx] = message;
      } else {
        this.pendingWorkletMessages.push(message);
      }
    }
  }

  /**
   * Explicitly switches the AudioWorklet excitation profile between 'raw' (sine generator)
   * and 'music' (bounded RMS normalization for uploaded audio files).
   */
  setExcitationProfile(profile: ExcitationProfile): void {
    this.excitationProfile = profile;
    const message = { type: 'SET_EXCITATION_PROFILE', profile };
    if (this.workletNode && this.isWorkletReady) {
      this.workletNode.port.postMessage(message);
    } else {
      const existingIdx = this.pendingWorkletMessages.findIndex((m) => m.type === 'SET_EXCITATION_PROFILE');
      if (existingIdx >= 0) {
        this.pendingWorkletMessages[existingIdx] = message;
      } else {
        this.pendingWorkletMessages.push(message);
      }
    }
  }

  getExcitationProfile(): ExcitationProfile {
    return this.excitationProfile;
  }

  getConfiguredModeCount(): number {
    return this.configuredModes ? this.configuredModes.length : 0;
  }

  getPendingMessageCount(): number {
    return this.pendingWorkletMessages.length;
  }

  getBrowserAudioTelemetry(): {
    hasRealAudioContext: boolean;
    hasRealAudioWorkletNode: boolean;
    sampleRate: number;
    isToneConnected: boolean;
    isFileDownmixConnected: boolean;
    isFileAudibleToDestination: boolean;
  } {
    const hasAudioCtx =
      typeof AudioContext !== 'undefined' && this.ctx instanceof AudioContext;
    const hasWorklet =
      this.isWorkletReady &&
      typeof AudioWorkletNode !== 'undefined' &&
      this.workletNode instanceof AudioWorkletNode;
    return {
      hasRealAudioContext: hasAudioCtx,
      hasRealAudioWorkletNode: hasWorklet,
      sampleRate: this.sampleRate,
      isToneConnected: Boolean(this.toneGain && this.workletNode),
      isFileDownmixConnected: Boolean(this.fileGain && this.workletNode),
      isFileAudibleToDestination: this.isFileAudibleToDestination,
    };
  }

  /**
   * Subscribes to periodic modal snapshots emitted by the AudioWorklet
   */
  onSnapshot(callback: (snapshot: ModalSnapshot) => void): () => void {
    this.snapshotListeners.add(callback);
    return () => {
      this.snapshotListeners.delete(callback);
    };
  }

  /**
   * Subscribes to audio file playback progress updates
   */
  onProgress(callback: (progress: PlaybackProgress) => void): () => void {
    this.progressListeners.add(callback);
    return () => {
      this.progressListeners.delete(callback);
    };
  }

  private getCurrentBufferPlaybackTime(): number {
    if (!this.audioBuffer) return 0;
    if (!this.isBufferPlaying || !this.ctx) {
      return Math.max(0, Math.min(this.audioBuffer.duration, this.filePlaybackOffsetSec));
    }
    const elapsed = Math.max(0, this.ctx.currentTime - this.filePlaybackStartCtxTime);
    return Math.max(0, Math.min(this.audioBuffer.duration, this.filePlaybackOffsetSec + elapsed));
  }

  private notifyProgress(): void {
    let progress: PlaybackProgress | null = null;
    if (this.audioBuffer) {
      progress = {
        currentTime: this.getCurrentBufferPlaybackTime(),
        duration: this.audioBuffer.duration || 0,
        isPlaying: this.isBufferPlaying,
        fileName: this.currentFileName,
      };
    } else if (this.audioElement && this.currentFileName) {
      progress = {
        currentTime: this.audioElement.currentTime || 0,
        duration: this.audioElement.duration || 0,
        isPlaying: !this.audioElement.paused && !this.audioElement.ended,
        fileName: this.currentFileName,
      };
    } else {
      progress = {
        currentTime: 0,
        duration: 0,
        isPlaying: false,
        fileName: '',
      };
    }
    for (const listener of this.progressListeners) {
      listener(progress);
    }
  }

  async resumeContext(): Promise<void> {
    const ctx = await this.initContext();
    if ((ctx.state as string) !== 'running') {
      await this.waitForContextResumeBounded(this.triggerContextResume(), 150);
    }
  }

  async suspendContext(): Promise<void> {
    if (this.ctx && this.ctx.state === 'running') {
      await this.ctx.suspend();
    }
  }

  postMessageToWorklet(message: { type: string; [key: string]: unknown }): void {
    if (this.workletNode && this.isWorkletReady) {
      this.workletNode.port.postMessage(message);
    } else {
      this.pendingWorkletMessages.push(message);
    }
  }

  /* -------------------------------------------------------------------------- */
  /* SINGLE-TONE SINE GENERATOR (20 Hz – 20,000 Hz)                              */
  /* -------------------------------------------------------------------------- */

  async startTone(frequency: number = this.currentFrequency): Promise<void> {
    await this.initContext();
    if (!this.ctx || !this.toneGain) return;

    this.cancelSilentWavStream();
    this.stopAudioFile();
    this.sourceType = 'generator';
    this.setExcitationProfile('raw');
    this.currentFrequency = Math.max(20, Math.min(20000, frequency));

    if (!this.osc) {
      this.osc = this.ctx.createOscillator();
      this.osc.type = 'sine';
      this.osc.frequency.setValueAtTime(this.currentFrequency, this.ctx.currentTime);
      this.osc.connect(this.toneGain);
      this.osc.start();
    } else {
      this.osc.frequency.setTargetAtTime(this.currentFrequency, this.ctx.currentTime, 0.01);
    }

    // Smooth gain ramp to prevent clicks
    this.toneGain.gain.cancelScheduledValues(this.ctx.currentTime);
    this.toneGain.gain.setTargetAtTime(1.0, this.ctx.currentTime, 0.02);
    this.isTonePlaying = true;
  }

  setGeneratorFrequency(frequency: number): void {
    this.currentFrequency = Math.max(20, Math.min(20000, frequency));
    if (this.osc && this.ctx) {
      // Smooth logarithmic/continuous frequency transition
      this.osc.frequency.setTargetAtTime(this.currentFrequency, this.ctx.currentTime, 0.015);
    }
  }

  stopTone(): void {
    if (!this.ctx || !this.toneGain) return;
    this.isTonePlaying = false;
    // Smooth ramp down to 0, allowing worklet to integrate free modal decay
    this.toneGain.gain.cancelScheduledValues(this.ctx.currentTime);
    this.toneGain.gain.setTargetAtTime(0.0, this.ctx.currentTime, 0.03);
  }

  /* -------------------------------------------------------------------------- */
  /* UPLOADED AUDIO FILE STREAMING                                              */
  /* -------------------------------------------------------------------------- */

  private ensureFileDownmixBus(): void {
    if (!this.ctx || !this.fileGain) return;
    if (this.fileInputSplitter && this.fileDownmixMerger) return;

    this.fileGain.channelCount = 1;
    this.fileGain.channelCountMode = 'explicit';

    const splitter = this.ctx.createChannelSplitter(2);
    const merger = this.ctx.createGain();
    merger.channelCount = 1;
    merger.channelCountMode = 'explicit';
    merger.gain.setValueAtTime(0.5, this.ctx.currentTime); // 0.5 * (L + R)

    splitter.connect(merger, 0); // L
    splitter.connect(merger, 1); // R
    merger.connect(this.fileGain);

    this.fileInputSplitter = splitter;
    this.fileDownmixMerger = merger;
  }

  private stopProgressTimer(): void {
    if (this.progressTimerId !== null) {
      clearInterval(this.progressTimerId);
      this.progressTimerId = null;
    }
  }

  private startProgressTimer(): void {
    this.stopProgressTimer();
    this.progressTimerId = setInterval(() => {
      if (!this.isBufferPlaying) {
        this.stopProgressTimer();
        return;
      }
      this.notifyProgress();
    }, 150);
  }

  private teardownBufferSource(): void {
    if (this.bufferSource) {
      this.bufferSource.onended = null;
      try {
        this.bufferSource.stop();
      } catch {
        // already stopped
      }
      try {
        this.bufferSource.disconnect();
      } catch {
        // already disconnected
      }
      this.bufferSource = null;
    }
  }

  private startBufferPlayback(offsetSec: number): void {
    if (!this.ctx || !this.audioBuffer || !this.fileInputSplitter || !this.fileDownmixMerger) return;

    this.teardownBufferSource();

    const duration = this.audioBuffer.duration || 0;
    const clampedOffset = duration > 0 && offsetSec >= duration - 0.01 ? 0 : Math.max(0, Math.min(duration, offsetSec));

    const gainVal = this.audioBuffer.numberOfChannels <= 1 ? 1.0 : 0.5;
    this.fileDownmixMerger.gain.setValueAtTime(gainVal, this.ctx.currentTime);

    const src = this.ctx.createBufferSource();
    src.buffer = this.audioBuffer;
    src.loop = false;

    // Route decoded buffer through exact same 0.5 * (L + R) worklet bus AND stereo speakers
    src.connect(this.fileInputSplitter);
    src.connect(this.ctx.destination);
    this.isFileAudibleToDestination = true;

    this.filePlaybackOffsetSec = clampedOffset;
    this.filePlaybackStartCtxTime = this.ctx.currentTime;
    this.isBufferPlaying = true;
    this.bufferSource = src;

    src.onended = () => {
      if (this.bufferSource !== src) return;
      this.bufferSource = null;
      this.isBufferPlaying = false;
      this.filePlaybackOffsetSec = duration;
      this.stopProgressTimer();
      this.notifyProgress();
      // Worklet continues modal free decay automatically
    };

    src.start(0, clampedOffset);
    this.startProgressTimer();
    this.notifyProgress();
  }

  async loadAudioFile(file: File): Promise<boolean> {
    try {
      await this.initContext();
      if (!this.ctx || !this.fileGain) return false;

      this.cancelSilentWavStream();
      this.stopTone();
      this.stopAudioFile();
      this.audioBuffer = null;
      this.sourceType = 'file';
      this.setExcitationProfile('music');
      this.currentFileName = file.name;
      this.ensureFileDownmixBus();

      // Primary path: decode into AudioBuffer so samples feed AudioWorklet directly inside Web Audio
      // (avoids iOS/macOS Safari MediaElementAudioSourceNode outputting silent zeros for blob: URLs)
      try {
        const arrayBuf = await file.arrayBuffer();
        const decoded = await this.ctx.decodeAudioData(arrayBuf.slice(0));
        this.audioBuffer = decoded;
        this.filePlaybackOffsetSec = 0;
        this.isBufferPlaying = false;

        if ((this.ctx.state as string) !== 'running') {
          await this.waitForContextResumeBounded(this.triggerContextResume(), 100);
        }

        if ((this.ctx.state as string) === 'running') {
          this.startBufferPlayback(0);
        } else {
          this.isFileAudibleToDestination = true;
          this.notifyProgress();
        }
        return true;
      } catch (decodeErr) {
        console.warn('decodeAudioData fallback to MediaElementAudioSourceNode:', decodeErr);
        this.audioBuffer = null;
      }

      // Fallback path for containers/codecs handled by HTMLAudioElement only
      if (this.audioFileUrl) {
        URL.revokeObjectURL(this.audioFileUrl);
      }
      this.audioFileUrl = URL.createObjectURL(file);

      if (!this.audioElement) {
        this.audioElement = new Audio();
        this.audioElement.loop = false; // Never loop by default

        this.mediaElementSource = this.ctx.createMediaElementSource(this.audioElement);
        this.mediaElementSource.connect(this.fileInputSplitter!);

        // Audible system output in full stereo
        this.mediaElementSource.connect(this.ctx.destination);
        this.isFileAudibleToDestination = true;

        this.audioElement.ontimeupdate = () => this.notifyProgress();
        this.audioElement.onended = () => {
          this.notifyProgress();
          // Worklet continues modal free decay automatically
        };
      }

      this.audioElement.src = this.audioFileUrl;
      await this.audioElement.play();
      this.notifyProgress();
      return true;
    } catch (err) {
      console.error('Failed to load audio file:', err);
      this.audioBuffer = null;
      this.currentFileName = '';
      this.notifyProgress();
      return false;
    }
  }

  playAudioFile(): void {
    this.cancelSilentWavStream();
    this.stopTone();
    this.sourceType = 'file';
    if (this.audioBuffer && this.ctx) {
      const startPlay = () => {
        if (this.audioBuffer && !this.isBufferPlaying) {
          this.startBufferPlayback(this.filePlaybackOffsetSec);
        }
      };
      if ((this.ctx.state as string) !== 'running') {
        const pending = this.triggerContextResume();
        if (pending) {
          pending
            .then(() => {
              if (this.ctx && (this.ctx.state as string) === 'running') {
                startPlay();
              } else if (this.ctx) {
                return this.ctx.resume().then(startPlay);
              }
            })
            .catch(console.error);
        } else {
          this.ctx.resume().then(startPlay).catch(console.error);
        }
      } else {
        startPlay();
      }
      return;
    }
    if (this.audioElement) {
      if (this.ctx && (this.ctx.state as string) !== 'running') {
        this.triggerContextResume();
      }
      this.audioElement.play().catch(console.error);
      this.notifyProgress();
    }
  }

  pauseAudioFile(): void {
    if (this.audioBuffer) {
      if (this.isBufferPlaying) {
        this.filePlaybackOffsetSec = this.getCurrentBufferPlaybackTime();
        this.isBufferPlaying = false;
        this.teardownBufferSource();
        this.stopProgressTimer();
      }
      this.notifyProgress();
      return;
    }
    if (this.audioElement) {
      this.audioElement.pause();
      this.notifyProgress();
      // Worklet continues natural free modal decay
    }
  }

  seekAudioFile(timeSec: number): void {
    if (!Number.isFinite(timeSec)) return;
    if (this.audioBuffer) {
      const duration = this.audioBuffer.duration || 0;
      const clamped = Math.max(0, Math.min(duration, timeSec));
      this.filePlaybackOffsetSec = clamped;
      if (this.isBufferPlaying) {
        this.startBufferPlayback(clamped);
      } else {
        this.notifyProgress();
      }
      return;
    }
    if (this.audioElement) {
      this.audioElement.currentTime = Math.max(0, Math.min(this.audioElement.duration || 0, timeSec));
      this.notifyProgress();
    }
  }

  stopAudioFile(): void {
    if (this.audioBuffer) {
      this.isBufferPlaying = false;
      this.filePlaybackOffsetSec = 0;
      this.teardownBufferSource();
      this.stopProgressTimer();
      this.notifyProgress();
    }
    if (this.audioElement) {
      this.audioElement.pause();
      this.audioElement.currentTime = 0;
      this.notifyProgress();
    }
  }

  /* -------------------------------------------------------------------------- */
  /* MEMORY-BOUNDED SILENT WAV STREAMING FOR VIDEO EXPORT                       */
  /* -------------------------------------------------------------------------- */

  get isSilentWavStreaming(): boolean {
    return this.silentStreamActive;
  }

  getSilentWavStreamTelemetry(): {
    active: boolean;
    scheduledSourceCount: number;
    framesScheduled: number;
    durationSec: number;
  } {
    return {
      active: this.silentStreamActive,
      scheduledSourceCount: this.silentStreamSources.size,
      framesScheduled: this.silentStreamNextFrame,
      durationSec: this.silentStreamInfo ? this.silentStreamInfo.durationSec : 0,
    };
  }

  private clearSilentStreamRuntime(): void {
    this.silentStreamActive = false;
    if (this.silentStreamPumpTimer !== null) {
      clearInterval(this.silentStreamPumpTimer);
      this.silentStreamPumpTimer = null;
    }
    for (const src of this.silentStreamSources) {
      src.onended = null;
      try {
        src.stop();
      } catch {
        // already stopped
      }
      try {
        src.disconnect();
      } catch {
        // already disconnected
      }
      try {
        src.buffer = null;
      } catch {
        // ignore immutable buffer setter in some environments
      }
    }
    this.silentStreamSources.clear();
    this.silentStreamChunkStream = null;
    this.silentStreamInfo = null;
    this.silentStreamStartCtxTime = 0;
    this.silentStreamNextFrame = 0;
    this.silentStreamCompleted = false;
  }

  cancelSilentWavStream(): void {
    this.silentStreamSessionId++;
    this.clearSilentStreamRuntime();
  }

  private createMonoAudioBufferFromChunk(ctx: AudioContext, chunk: WavDecodedChunk): AudioBuffer {
    const audioBuf = ctx.createBuffer(1, chunk.frameCount, chunk.sampleRate);
    if (typeof audioBuf.copyToChannel === 'function') {
      audioBuf.copyToChannel(chunk.monoSamples as Float32Array<ArrayBuffer>, 0);
    } else {
      audioBuf.getChannelData(0).set(chunk.monoSamples);
    }
    return audioBuf;
  }

  /**
   * Streams a potentially very long PCM WAV file slice-by-slice into the existing AudioWorkletNode
   * via fileGain ONLY (never connected to ctx.destination -> strictly silent output).
   * Maintains a bounded 12-16s look-ahead window and aborts safely on any underrun.
   */
  async startSilentWavStream(
    source: WavByteSource,
    callbacks: SilentWavStreamCallbacks = {},
    options?: {
      chunkDurationSec?: number;
      minPrebufferSec?: number;
      maxLookaheadSec?: number;
      pumpIntervalMs?: number;
      underrunGuardSec?: number;
    }
  ): Promise<WavFormatInfo> {
    const chunkDurationSec = options?.chunkDurationSec ?? 4.0;
    const minPrebufferSec = options?.minPrebufferSec ?? 12.0;
    const maxLookaheadSec = options?.maxLookaheadSec ?? 16.0;
    const pumpIntervalMs = options?.pumpIntervalMs ?? 150;
    const underrunGuardSec = options?.underrunGuardSec ?? 0.15;

    const sessionId = ++this.silentStreamSessionId;
    this.clearSilentStreamRuntime();

    this.stopTone();
    this.stopAudioFile();
    this.audioBuffer = null;
    this.currentFileName = '';

    const chunkStream = await createWavPcmChunkStream(source, { chunkDurationSec });
    if (sessionId !== this.silentStreamSessionId) {
      throw new Error('Silent WAV stream cancelled.');
    }

    const wavInfo = chunkStream.info;
    callbacks.onStatus?.({
      phase: 'validating',
      info: wavInfo,
      simulatedTimeSec: 0,
      bufferedAheadSec: 0,
      framesScheduled: 0,
    });

    await this.initContext();
    if (sessionId !== this.silentStreamSessionId) {
      throw new Error('Silent WAV stream cancelled.');
    }
    if (!this.ctx || !this.fileGain) {
      throw new Error('Web Audio context or AudioWorklet failed to initialize.');
    }

    if ((this.ctx.state as string) !== 'running') {
      await this.waitForContextResumeBounded(this.triggerContextResume(), 450);
      if ((this.ctx.state as string) !== 'running') {
        const suspendedErr = new Error(
          'Browser paused AudioContext after file selection. Tap "Start Silent Export" to continue.'
        );
        suspendedErr.name = 'AudioContextSuspendedError';
        throw suspendedErr;
      }
    }

    if (sessionId !== this.silentStreamSessionId) {
      throw new Error('Silent WAV stream cancelled.');
    }

    const ctx = this.ctx;
    const fileGain = this.fileGain;

    // Route silent file excitation strictly into fileGain -> workletNode (zero speaker output)
    fileGain.channelCount = 1;
    fileGain.channelCountMode = 'explicit';
    fileGain.gain.setValueAtTime(1.0, ctx.currentTime);
    this.sourceType = 'file';
    this.isFileAudibleToDestination = false;

    // Reset worklet + simulation timeline cleanly from t = 0 under bounded music excitation
    this.postMessageToWorklet({ type: 'RESET_MODES' });
    this.setExcitationProfile('music');
    callbacks.onPrepareSimulation?.(wavInfo);

    // Prebuffer 12-16s (or full file if shorter) BEFORE starting timeline & recorder
    const targetPrebufferSec = Math.min(wavInfo.durationSec, minPrebufferSec);
    const maxQueuedSources = Math.max(2, Math.ceil(maxLookaheadSec / chunkDurationSec));
    const prebuffered: { chunk: WavDecodedChunk; audioBuf: AudioBuffer }[] = [];
    let prebufferedSec = 0;

    callbacks.onStatus?.({
      phase: 'buffering',
      info: wavInfo,
      simulatedTimeSec: 0,
      bufferedAheadSec: 0,
      framesScheduled: 0,
    });

    while (
      chunkStream.hasNext() &&
      prebufferedSec < targetPrebufferSec - 1e-6 &&
      prebuffered.length < maxQueuedSources
    ) {
      const next = await chunkStream.nextChunk();
      if (sessionId !== this.silentStreamSessionId) {
        throw new Error('Silent WAV stream cancelled.');
      }
      if (!next) break;
      const audioBuf = this.createMonoAudioBufferFromChunk(ctx, next);
      prebuffered.push({ chunk: next, audioBuf });
      prebufferedSec += next.durationSec;
      callbacks.onStatus?.({
        phase: 'buffering',
        info: wavInfo,
        simulatedTimeSec: 0,
        bufferedAheadSec: prebufferedSec,
        framesScheduled: 0,
      });
    }

    if (prebuffered.length === 0) {
      throw new Error('WAV file contains zero decodable audio frames.');
    }

    this.silentStreamActive = true;
    this.silentStreamChunkStream = chunkStream;
    this.silentStreamInfo = wavInfo;
    this.silentStreamCompleted = false;
    this.silentStreamNextFrame = 0;

    const startCtxTime = ctx.currentTime + 0.05;
    this.silentStreamStartCtxTime = startCtxTime;

    const finishStream = () => {
      if (sessionId !== this.silentStreamSessionId || this.silentStreamCompleted) return;
      this.silentStreamCompleted = true;
      const finishedInfo = wavInfo;
      this.clearSilentStreamRuntime();
      callbacks.onEnded?.(finishedInfo);
    };

    const failStream = (err: Error) => {
      if (sessionId !== this.silentStreamSessionId || this.silentStreamCompleted) return;
      this.silentStreamCompleted = true;
      this.clearSilentStreamRuntime();
      callbacks.onError?.(err);
    };

    const scheduleChunk = (chunk: WavDecodedChunk, audioBuf: AudioBuffer) => {
      if (sessionId !== this.silentStreamSessionId || !this.silentStreamActive) return;

      const chunkStartCtxTime = startCtxTime + chunk.startFrame / wavInfo.sampleRate;
      const now = ctx.currentTime;
      if (chunk.startFrame > 0 && chunkStartCtxTime < now + 0.015) {
        failStream(
          new Error('Streaming underrun: browser disk read fell behind the simulation audio timeline.')
        );
        return;
      }

      const src = ctx.createBufferSource();
      src.buffer = audioBuf;
      src.loop = false;
      // Silent path: connect ONLY to fileGain (which feeds workletNode); NEVER connect to ctx.destination
      src.connect(fileGain);
      this.silentStreamSources.add(src);
      this.silentStreamNextFrame = chunk.startFrame + chunk.frameCount;

      src.onended = () => {
        src.onended = null;
        try {
          src.disconnect();
        } catch {
          // ignore
        }
        try {
          src.buffer = null;
        } catch {
          // ignore
        }
        this.silentStreamSources.delete(src);
        if (chunk.isLast && sessionId === this.silentStreamSessionId) {
          finishStream();
        }
      };

      src.start(chunkStartCtxTime);
    };

    for (const item of prebuffered) {
      scheduleChunk(item.chunk, item.audioBuf);
    }

    if (!this.silentStreamActive) {
      return wavInfo;
    }

    callbacks.onStreamStart?.({ startCtxTime, wavInfo });

    let isPumping = false;
    const pumpLoop = async () => {
      if (
        isPumping ||
        sessionId !== this.silentStreamSessionId ||
        !this.silentStreamActive ||
        this.silentStreamCompleted
      ) {
        return;
      }
      isPumping = true;
      try {
        const now = ctx.currentTime;
        const scheduledEndCtxTime = startCtxTime + this.silentStreamNextFrame / wavInfo.sampleRate;
        const bufferedAhead = scheduledEndCtxTime - now;

        // Guard against undetected gaps if disk reads fell behind before EOF
        if (chunkStream.hasNext() && bufferedAhead <= underrunGuardSec) {
          failStream(
            new Error('Streaming underrun: look-ahead buffer exhausted before next WAV chunk arrived.')
          );
          return;
        }

        while (
          chunkStream.hasNext() &&
          startCtxTime + this.silentStreamNextFrame / wavInfo.sampleRate - ctx.currentTime < maxLookaheadSec &&
          this.silentStreamSources.size < maxQueuedSources
        ) {
          const next = await chunkStream.nextChunk();
          if (
            sessionId !== this.silentStreamSessionId ||
            !this.silentStreamActive ||
            this.silentStreamCompleted
          ) {
            return;
          }
          if (!next) break;
          const audioBuf = this.createMonoAudioBufferFromChunk(ctx, next);
          scheduleChunk(next, audioBuf);
          if (!this.silentStreamActive || this.silentStreamCompleted) return;
        }

        const updatedScheduledEnd = startCtxTime + this.silentStreamNextFrame / wavInfo.sampleRate;
        const updatedBufferedAhead = Math.max(0, updatedScheduledEnd - ctx.currentTime);
        callbacks.onStatus?.({
          phase: chunkStream.hasNext() ? 'streaming' : 'completing',
          info: wavInfo,
          simulatedTimeSec: Math.max(0, Math.min(wavInfo.durationSec, ctx.currentTime - startCtxTime)),
          bufferedAheadSec: updatedBufferedAhead,
          framesScheduled: this.silentStreamNextFrame,
        });

        // Safety net for total duration completion in case last source's onended is delayed
        if (!chunkStream.hasNext() && ctx.currentTime >= startCtxTime + wavInfo.durationSec + 0.05) {
          finishStream();
        }
      } catch (err) {
        failStream(err instanceof Error ? err : new Error(String(err)));
      } finally {
        isPumping = false;
      }
    };

    this.silentStreamPumpTimer = setInterval(() => {
      void pumpLoop();
    }, pumpIntervalMs);

    return wavInfo;
  }

  cleanup(): void {
    this.cancelSilentWavStream();
    this.stopTone();
    this.stopAudioFile();
    this.stopProgressTimer();
    this.audioBuffer = null;
    if (this.audioFileUrl) {
      URL.revokeObjectURL(this.audioFileUrl);
      this.audioFileUrl = null;
    }
    if (this.osc) {
      try {
        this.osc.stop();
        this.osc.disconnect();
      } catch {
        // already stopped
      }
      this.osc = null;
    }
    if (this.ctx && this.ctx.state !== 'closed') {
      this.ctx.close();
      this.ctx = null;
    }
    this.snapshotListeners.clear();
    this.progressListeners.clear();
  }
}
