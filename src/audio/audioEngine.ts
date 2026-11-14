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

export interface WorkletModeConfig {
  m: number;
  n: number;
  frequency: number;
  omega: number;
  zeta: number;
  modalMass: number;
}

export type AudioSourceType = 'generator' | 'file';

export interface PlaybackProgress {
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  fileName: string;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private isWorkletReady = false;
  private workletInitPromise: Promise<boolean> | null = null;
  private pendingWorkletMessages: { type: string; [key: string]: unknown }[] = [];
  private configuredModes: WorkletModeConfig[] | null = null;

  private sourceType: AudioSourceType = 'generator';

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
        await this.ctx.audioWorklet.addModule(workletUrl);

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

    this.stopAudioFile();
    this.sourceType = 'generator';
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

      this.stopTone();
      this.stopAudioFile();
      this.audioBuffer = null;
      this.sourceType = 'file';
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

  cleanup(): void {
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
