/**
 * AudioEngine: Real Web Audio AudioWorklet Architecture for Chladni Plate Simulation
 * 
 * Conforms to STAGE 6 Requirements:
 * - ScriptProcessorNode and FIFO ring buffers are completely removed.
 * - Real AudioWorkletProcessor module ('/audio/modal-worklet-processor.js') loaded via audioWorklet.addModule().
 * - All audio sources (Oscillators, Microphone, HTML5 Audio File) route through the same AudioWorkletNode.
 * - Processes continuous audio samples at native AudioContext.sampleRate without requestAnimationFrame coupling.
 * - Modal integration executes inside AudioWorklet thread; compact snapshots are received at ~60 Hz.
 * - Authoritative simulation clock: t = sampleFramesProcessed / sampleRate.
 * - Feedback prevention: microphone monitoring is muted by default (explicit opt-in only).
 * - File playback does NOT loop by default; user-controlled loop option provided.
 * - AnalyserNode is preserved strictly for visual diagnostics, never for modal excitation.
 */

import { ModalSnapshot } from '../physics/types.ts';

export type AudioSourceType = 'generator' | 'microphone' | 'file';
export type GeneratorWaveform = 'sine' | 'dual' | 'sweep' | 'silence';

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private isWorkletReady = false;
  private workletInitPromise: Promise<boolean> | null = null;

  private sourceType: AudioSourceType = 'generator';
  private generatorType: GeneratorWaveform = 'sine';

  // Oscillator nodes for generator
  private osc1: OscillatorNode | null = null;
  private osc2: OscillatorNode | null = null;
  private generatorGain: GainNode | null = null;
  private sweepInterval: number | null = null;

  // Mic stream
  private micStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private micGain: GainNode | null = null;
  private micMonitorGain: GainNode | null = null;
  private isMicMonitoring = false;

  // Streaming HTML5 Audio element for uploaded files (zero decodeAudioData memory pressure)
  private audioElement: HTMLAudioElement | null = null;
  private mediaElementSource: MediaElementAudioSourceNode | null = null;
  private fileGain: GainNode | null = null;
  private audioFileUrl: string | null = null;
  private isFilePlaying = false;
  private isFileLooping = false;

  // Diagnostic Analyser & Monitor Gain Nodes
  private analyser: AnalyserNode | null = null;
  private masterMonitorGain: GainNode | null = null;
  private timeDomainBuffer = new Float32Array(512);

  // Configuration
  frequency1 = 53.96; // Hz
  frequency2 = 215.85; // Hz
  gain = 1.0;
  isMuted = false;

  // Latest snapshot received from AudioWorklet
  latestSnapshot: ModalSnapshot | null = null;
  private snapshotListeners: Set<(snapshot: ModalSnapshot) => void> = new Set();

  constructor() {
    // Lazily initialized on user interaction
  }

  get sampleRate(): number {
    return this.ctx ? this.ctx.sampleRate : 44100;
  }

  getContextState(): AudioContextState {
    return this.ctx ? this.ctx.state : 'suspended';
  }

  isReady(): boolean {
    return this.isWorkletReady && this.workletNode !== null;
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

        // Register AudioWorkletProcessor from public folder
        const workletUrl = '/audio/modal-worklet-processor.js';
        await this.ctx.audioWorklet.addModule(workletUrl);

        // Instantiate AudioWorkletNode
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

        // Create diagnostic AnalyserNode
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 1024;

        // Create Master Monitor Gain Node (for audible playback of generator and file)
        this.masterMonitorGain = this.ctx.createGain();
        this.masterMonitorGain.gain.setValueAtTime(this.isMuted ? 0 : 0.15, this.ctx.currentTime);

        // Route: workletNode -> analyser
        this.workletNode.connect(this.analyser);

        // Sub-bus for generator gain
        this.generatorGain = this.ctx.createGain();
        this.generatorGain.gain.setValueAtTime(1.0, this.ctx.currentTime);
        this.generatorGain.connect(this.workletNode);
        this.generatorGain.connect(this.masterMonitorGain);

        // Sub-bus for file gain
        this.fileGain = this.ctx.createGain();
        this.fileGain.gain.setValueAtTime(1.0, this.ctx.currentTime);
        this.fileGain.connect(this.workletNode);
        this.fileGain.connect(this.masterMonitorGain);

        // Sub-bus for mic gain:
        // Strictly routes to workletNode, NOT to masterMonitorGain (prevents acoustic feedback)
        this.micGain = this.ctx.createGain();
        this.micGain.gain.setValueAtTime(1.0, this.ctx.currentTime);
        this.micGain.connect(this.workletNode);

        // Optional mic monitoring gain (strictly 0.0 by default)
        this.micMonitorGain = this.ctx.createGain();
        this.micMonitorGain.gain.setValueAtTime(0.0, this.ctx.currentTime);
        this.micGain.connect(this.micMonitorGain);
        this.micMonitorGain.connect(this.ctx.destination);

        // Master monitor output to destination
        this.masterMonitorGain.connect(this.ctx.destination);

        this.isWorkletReady = true;
        return true;
      } catch (err) {
        console.error('AudioWorklet initialization failed:', err);
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

  /**
   * Post control message to AudioWorklet
   */
  postMessageToWorklet(message: unknown): void {
    if (this.workletNode) {
      this.workletNode.port.postMessage(message);
    }
  }

  setExcitationConfig(isPointForce: boolean, shakerPos: { x: number; y: number }, gain: number): void {
    this.gain = gain;
    this.postMessageToWorklet({
      type: 'SET_EXCITATION',
      isPointForce,
      shakerPos,
      gain,
    });
  }

  toggleMode(index: number, active: boolean): void {
    this.postMessageToWorklet({
      type: 'TOGGLE_MODE',
      index,
      active,
    });
  }

  resetModes(): void {
    this.postMessageToWorklet({
      type: 'RESET_MODES',
    });
  }

  /**
   * Starts Internal Signal Generator (sine, dual tone, or sweep)
   */
  async startGenerator(
    type: GeneratorWaveform = 'sine',
    freq1: number = 53.96,
    freq2: number = 215.85
  ): Promise<void> {
    await this.initContext();
    if (!this.ctx || !this.generatorGain) return;

    this.stopAllSources();
    this.sourceType = 'generator';
    this.generatorType = type;
    this.frequency1 = freq1;
    this.frequency2 = freq2;

    if (type === 'silence') {
      // In silence, generators are inactive, but AudioWorklet continues processing zero input
      // allowing free modal decay in true physical lockstep.
      return;
    }

    this.osc1 = this.ctx.createOscillator();
    this.osc1.type = 'sine';
    this.osc1.frequency.setValueAtTime(freq1, this.ctx.currentTime);

    if (type === 'sine') {
      this.osc1.connect(this.generatorGain);
    } else if (type === 'dual') {
      this.osc2 = this.ctx.createOscillator();
      this.osc2.type = 'sine';
      this.osc2.frequency.setValueAtTime(freq2, this.ctx.currentTime);

      const mixer = this.ctx.createGain();
      mixer.gain.setValueAtTime(0.5, this.ctx.currentTime); // 50% each to prevent clipping

      this.osc1.connect(mixer);
      this.osc2.connect(mixer);
      mixer.connect(this.generatorGain);
      this.osc2.start();
    } else if (type === 'sweep') {
      this.osc1.connect(this.generatorGain);

      const sweepDuration = 6.0;
      const startTime = this.ctx.currentTime;
      this.osc1.frequency.setValueAtTime(40, startTime);
      this.osc1.frequency.exponentialRampToValueAtTime(300, startTime + sweepDuration);

      this.sweepInterval = window.setInterval(() => {
        if (!this.osc1 || !this.ctx) return;
        const now = this.ctx.currentTime;
        this.osc1.frequency.cancelScheduledValues(now);
        this.osc1.frequency.setValueAtTime(40, now);
        this.osc1.frequency.exponentialRampToValueAtTime(300, now + sweepDuration);
      }, sweepDuration * 1000);
    }

    this.osc1.start();
  }

  setGeneratorFrequency(f: number): void {
    this.frequency1 = f;
    if (this.osc1 && this.ctx && this.generatorType === 'sine') {
      this.osc1.frequency.setValueAtTime(f, this.ctx.currentTime);
    }
  }

  setDualFrequencies(f1: number, f2: number): void {
    this.frequency1 = f1;
    this.frequency2 = f2;
    if (this.ctx) {
      if (this.osc1) this.osc1.frequency.setValueAtTime(f1, this.ctx.currentTime);
      if (this.osc2) this.osc2.frequency.setValueAtTime(f2, this.ctx.currentTime);
    }
  }

  /**
   * Microphone Input
   * Strictly routed to AudioWorklet; monitoring to speakers is MUTED by default to prevent feedback.
   */
  async startMicrophone(): Promise<boolean> {
    try {
      await this.initContext();
      if (!this.ctx || !this.micGain) return false;

      this.stopAllSources();
      this.sourceType = 'microphone';

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });

      this.micStream = stream;
      this.micSource = this.ctx.createMediaStreamSource(stream);
      this.micSource.connect(this.micGain);

      // Verify mic monitoring is disabled by default
      if (this.micMonitorGain) {
        this.micMonitorGain.gain.setValueAtTime(this.isMicMonitoring ? 0.15 : 0.0, this.ctx.currentTime);
      }

      return true;
    } catch (err) {
      console.error('Failed to open microphone:', err);
      return false;
    }
  }

  setMicMonitoring(enabled: boolean): void {
    this.isMicMonitoring = enabled;
    if (this.micMonitorGain && this.ctx) {
      this.micMonitorGain.gain.setValueAtTime(enabled ? 0.15 : 0.0, this.ctx.currentTime);
    }
  }

  stopMicrophone(): void {
    if (this.micStream) {
      this.micStream.getTracks().forEach((track) => track.stop());
      this.micStream = null;
    }
    if (this.micSource) {
      this.micSource.disconnect();
      this.micSource = null;
    }
    if (this.micMonitorGain && this.ctx) {
      this.micMonitorGain.gain.setValueAtTime(0.0, this.ctx.currentTime);
    }
  }

  /**
   * Streaming Audio File Player (uses HTMLMediaElement streaming)
   * Avoids decoding entire file into memory; scales to arbitrarily long recordings.
   * Does NOT loop by default; user-controlled loop option provided.
   */
  async loadAudioFile(file: File): Promise<boolean> {
    try {
      await this.initContext();
      if (!this.ctx || !this.fileGain) return false;

      this.stopAllSources();
      this.sourceType = 'file';

      if (this.audioFileUrl) {
        URL.revokeObjectURL(this.audioFileUrl);
      }
      this.audioFileUrl = URL.createObjectURL(file);

      if (!this.audioElement) {
        this.audioElement = new Audio();
        this.audioElement.loop = this.isFileLooping; // false by default
        this.mediaElementSource = this.ctx.createMediaElementSource(this.audioElement);
        this.mediaElementSource.connect(this.fileGain);
      } else {
        this.audioElement.loop = this.isFileLooping;
      }

      this.audioElement.src = this.audioFileUrl;
      await this.audioElement.play();
      this.isFilePlaying = true;
      return true;
    } catch (err) {
      console.error('Failed to stream audio file:', err);
      return false;
    }
  }

  setFileLooping(loop: boolean): void {
    this.isFileLooping = loop;
    if (this.audioElement) {
      this.audioElement.loop = loop;
    }
  }

  playAudioFile(): void {
    if (this.audioElement) {
      this.audioElement.play();
      this.isFilePlaying = true;
    }
  }

  pauseAudioFile(): void {
    if (this.audioElement) {
      this.audioElement.pause();
      this.isFilePlaying = false;
    }
  }

  seekAudioFile(timeSec: number): void {
    if (this.audioElement) {
      this.audioElement.currentTime = timeSec;
    }
  }

  getFileDuration(): number {
    return this.audioElement ? (isNaN(this.audioElement.duration) ? 0 : this.audioElement.duration) : 0;
  }

  getFileCurrentTime(): number {
    return this.audioElement ? this.audioElement.currentTime : 0;
  }

  setMuted(muted: boolean): void {
    this.isMuted = muted;
    if (this.masterMonitorGain && this.ctx) {
      this.masterMonitorGain.gain.setValueAtTime(muted ? 0 : 0.15, this.ctx.currentTime);
    }
  }

  /**
   * Diagnostic oscilloscope buffer (strictly for visual HUD)
   */
  getDiagnosticWaveform(): Float32Array {
    if (this.analyser) {
      this.analyser.getFloatTimeDomainData(this.timeDomainBuffer);
    } else {
      this.timeDomainBuffer.fill(0);
    }
    return this.timeDomainBuffer;
  }

  stopAllSources(): void {
    if (this.sweepInterval !== null) {
      clearInterval(this.sweepInterval);
      this.sweepInterval = null;
    }
    if (this.osc1) {
      try { this.osc1.stop(); } catch { /* ignore */ }
      this.osc1.disconnect();
      this.osc1 = null;
    }
    if (this.osc2) {
      try { this.osc2.stop(); } catch { /* ignore */ }
      this.osc2.disconnect();
      this.osc2 = null;
    }
    if (this.audioElement) {
      this.audioElement.pause();
      this.isFilePlaying = false;
    }
    this.stopMicrophone();
  }

  cleanup(): void {
    this.stopAllSources();
    if (this.audioFileUrl) {
      URL.revokeObjectURL(this.audioFileUrl);
      this.audioFileUrl = null;
    }
    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.ctx) {
      this.ctx.close();
      this.ctx = null;
    }
    this.isWorkletReady = false;
    this.snapshotListeners.clear();
  }
}
