/**
 * AudioEngine: Minimal Realistic Audio Engine for Chladni Plate Simulation
 * 
 * Conforms to STAGE 7 Requirements:
 * - Pure sine test tone (20 Hz - 20,000 Hz) with logarithmic frequency slider support.
 * - Streaming HTML5 audio file playback with full stereo speaker output.
 * - Proper stereo-to-mono downmixing: (L + R) / 2 to the AudioWorklet excitation pipeline.
 * - Authoritative AudioWorklet simulation clock: t = sampleFramesProcessed / sampleRate.
 * - Zero microphone code, zero getUserMedia(), zero microphone permissions.
 * - Natural modal free decay when audio input ceases or pauses.
 * - Stores pending worklet configurations to guarantee zero lost initialization messages.
 */

import { ModalSnapshot } from '../physics/types.ts';

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
  private pendingWorkletMessages: unknown[] = [];

  private sourceType: AudioSourceType = 'generator';

  // Single sine test tone generator (20 Hz – 20,000 Hz)
  private osc: OscillatorNode | null = null;
  private toneGain: GainNode | null = null;
  private currentFrequency = 53.96; // Default to fundamental resonance
  private isTonePlaying = false;

  // HTML5 audio file streaming
  private audioElement: HTMLAudioElement | null = null;
  private mediaElementSource: MediaElementAudioSourceNode | null = null;
  private fileGain: GainNode | null = null;
  private audioFileUrl: string | null = null;
  private currentFileName: string = '';
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

  /**
   * Initializes the AudioContext and registers the AudioWorkletProcessor module
   */
  async initContext(): Promise<AudioContext> {
    if (!this.ctx) {
      const AudioContextClass =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioContextClass();
    }

    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }

    await this.ensureWorklet();
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

        this.isWorkletReady = true;

        // Flush any buffered messages sent prior to initialization
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

  private notifyProgress(): void {
    if (!this.audioElement) return;
    const progress: PlaybackProgress = {
      currentTime: this.audioElement.currentTime || 0,
      duration: this.audioElement.duration || 0,
      isPlaying: !this.audioElement.paused && !this.audioElement.ended,
      fileName: this.currentFileName,
    };
    for (const listener of this.progressListeners) {
      listener(progress);
    }
  }

  async resumeContext(): Promise<void> {
    const ctx = await this.initContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
  }

  async suspendContext(): Promise<void> {
    if (this.ctx && this.ctx.state === 'running') {
      await this.ctx.suspend();
    }
  }

  postMessageToWorklet(message: unknown): void {
    if (this.workletNode) {
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

  async loadAudioFile(file: File): Promise<boolean> {
    try {
      await this.initContext();
      if (!this.ctx || !this.fileGain) return false;

      this.stopTone();
      this.sourceType = 'file';
      this.currentFileName = file.name;

      if (this.audioFileUrl) {
        URL.revokeObjectURL(this.audioFileUrl);
      }
      this.audioFileUrl = URL.createObjectURL(file);

      if (!this.audioElement) {
        this.audioElement = new Audio();
        this.audioElement.loop = false; // Never loop by default

        // Handle stereo input: downmix to mono for plate excitation,
        // while routing full stereo to user's system output!
        this.mediaElementSource = this.ctx.createMediaElementSource(this.audioElement);

        const splitter = this.ctx.createChannelSplitter(2);
        const merger = this.ctx.createGain();
        merger.gain.setValueAtTime(0.5, this.ctx.currentTime); // 0.5 * (L + R)

        this.mediaElementSource.connect(splitter);
        splitter.connect(merger, 0); // L
        splitter.connect(merger, 1); // R
        merger.connect(this.fileGain);

        // Audible system output in full stereo
        this.mediaElementSource.connect(this.ctx.destination);

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
      return false;
    }
  }

  playAudioFile(): void {
    if (this.audioElement) {
      this.stopTone();
      this.sourceType = 'file';
      this.audioElement.play().catch(console.error);
      this.notifyProgress();
    }
  }

  pauseAudioFile(): void {
    if (this.audioElement) {
      this.audioElement.pause();
      this.notifyProgress();
      // Worklet continues natural free modal decay
    }
  }

  seekAudioFile(timeSec: number): void {
    if (this.audioElement && Number.isFinite(timeSec)) {
      this.audioElement.currentTime = Math.max(0, Math.min(this.audioElement.duration || 0, timeSec));
      this.notifyProgress();
    }
  }

  stopAudioFile(): void {
    if (this.audioElement) {
      this.audioElement.pause();
      this.audioElement.currentTime = 0;
      this.notifyProgress();
    }
  }

  cleanup(): void {
    this.stopTone();
    this.stopAudioFile();
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
