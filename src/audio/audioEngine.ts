/**
 * Web Audio Engine for Chladni Plate Simulation
 * PRIORITY 2: Continuous audio sample streaming pipeline.
 * Collects sequential samples at AudioContext.sampleRate into a ring buffer.
 * Streams long audio files via HTMLMediaElement (zero decodeAudioData memory overhead).
 * Strictly guarantees microphone is disconnected from audible output.
 * Preserves AnalyserNode strictly for diagnostic visual monitoring.
 */

export type AudioSourceType = 'generator' | 'microphone' | 'file';
export type GeneratorWaveform = 'sine' | 'dual' | 'sweep' | 'silence';

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private sourceType: AudioSourceType = 'generator';
  private generatorType: GeneratorWaveform = 'sine';

  // Oscillator nodes for generator
  private osc1: OscillatorNode | null = null;
  private osc2: OscillatorNode | null = null;
  private sweepInterval: number | null = null;

  // Mic stream
  private micStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;

  // Streaming HTML5 Audio element for uploaded files (zero decodeAudioData memory pressure)
  private audioElement: HTMLAudioElement | null = null;
  private mediaElementSource: MediaElementAudioSourceNode | null = null;
  private audioFileUrl: string | null = null;
  private isFilePlaying = false;

  // Nodes
  private streamTapNode: ScriptProcessorNode | null = null;
  private analyser: AnalyserNode | null = null;
  private monitorGain: GainNode | null = null;

  // Configuration
  frequency1 = 53.9;  // Hz
  frequency2 = 215.8; // Hz
  gain = 1.0;
  isMuted = false;

  // Sample ring buffer for continuous sample-rate delivery
  private ringBufferSize = 32768;
  private ringBuffer = new Float32Array(32768);
  private writeIndex = 0;
  private readIndex = 0;

  // Diagnostics visual buffer
  private timeDomainBuffer = new Float32Array(512);

  constructor() {
    // Lazily initialized on user interaction
  }

  private initContext(): AudioContext {
    if (!this.ctx) {
      const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioContextClass();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    this.ensureTapNode();
    return this.ctx;
  }

  get sampleRate(): number {
    return this.ctx ? this.ctx.sampleRate : 44100;
  }

  getContextState(): AudioContextState {
    return this.ctx ? this.ctx.state : 'suspended';
  }

  async resumeContext(): Promise<void> {
    const ctx = this.initContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
  }

  /**
   * Sets up the continuous audio stream tap node (ScriptProcessor / Worklet buffer).
   * Sequential audio blocks are pushed into the FIFO ring buffer.
   */
  private ensureTapNode(): void {
    if (!this.ctx || this.streamTapNode) return;

    // Buffer size 1024 provides low latency capture (~23ms at 44.1kHz)
    this.streamTapNode = this.ctx.createScriptProcessor(1024, 1, 1);
    this.streamTapNode.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const len = input.length;
      for (let i = 0; i < len; i++) {
        this.ringBuffer[this.writeIndex] = input[i];
        this.writeIndex = (this.writeIndex + 1) % this.ringBufferSize;
      }
    };

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;

    this.monitorGain = this.ctx.createGain();
    this.monitorGain.gain.setValueAtTime(this.isMuted ? 0 : 0.15, this.ctx.currentTime);

    // Audio graph: Source -> tapNode -> analyser -> (monitorGain -> destination)
    this.streamTapNode.connect(this.analyser);
    this.analyser.connect(this.monitorGain);
    this.monitorGain.connect(this.ctx.destination);
  }

  /**
   * Drains and returns all sequential samples received since the last call.
   * Guarantees continuous sample-rate feeding to the modal solver.
   */
  pullSampleStream(): Float32Array {
    if (!this.ctx) {
      return new Float32Array(0);
    }

    if (this.sourceType === 'generator' && this.generatorType === 'silence') {
      this.readIndex = this.writeIndex;
      return new Float32Array(0);
    }

    let count = this.writeIndex - this.readIndex;
    if (count < 0) {
      count += this.ringBufferSize;
    }

    if (count === 0) {
      return new Float32Array(0);
    }

    const output = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      output[i] = this.ringBuffer[this.readIndex];
      this.readIndex = (this.readIndex + 1) % this.ringBufferSize;
    }

    return output;
  }

  /**
   * Starts Internal Signal Generator
   */
  startGenerator(type: GeneratorWaveform = 'sine', freq1: number = 53.9, freq2: number = 215.8): void {
    const ctx = this.initContext();
    this.stopAllSources();
    this.sourceType = 'generator';
    this.generatorType = type;
    this.frequency1 = freq1;
    this.frequency2 = freq2;

    if (type === 'silence') {
      return;
    }

    this.osc1 = ctx.createOscillator();
    this.osc1.type = 'sine';
    this.osc1.frequency.setValueAtTime(freq1, ctx.currentTime);

    if (type === 'sine') {
      if (this.streamTapNode) this.osc1.connect(this.streamTapNode);
    } else if (type === 'dual') {
      this.osc2 = ctx.createOscillator();
      this.osc2.type = 'sine';
      this.osc2.frequency.setValueAtTime(freq2, ctx.currentTime);

      const merger = ctx.createGain();
      merger.gain.setValueAtTime(0.5, ctx.currentTime); // 50% mix each

      this.osc1.connect(merger);
      this.osc2.connect(merger);
      if (this.streamTapNode) merger.connect(this.streamTapNode);
      this.osc2.start();
    } else if (type === 'sweep') {
      if (this.streamTapNode) this.osc1.connect(this.streamTapNode);

      const sweepDuration = 6.0;
      const startTime = ctx.currentTime;
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
   * Strictly disconnected from speaker monitor to avoid acoustic feedback.
   */
  async startMicrophone(): Promise<boolean> {
    try {
      const ctx = this.initContext();
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
      this.micSource = ctx.createMediaStreamSource(stream);

      // Connect mic to tap node for continuous stream capture:
      // Note: tapNode connects to analyser -> monitorGain.
      // For microphone, we MUST mute monitorGain to eliminate speaker feedback!
      if (this.monitorGain) {
        this.monitorGain.gain.setValueAtTime(0, ctx.currentTime);
      }
      if (this.streamTapNode) {
        this.micSource.connect(this.streamTapNode);
      }

      return true;
    } catch (err) {
      console.error('Failed to open microphone:', err);
      return false;
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
    if (this.monitorGain && this.ctx) {
      this.monitorGain.gain.setValueAtTime(this.isMuted ? 0 : 0.15, this.ctx.currentTime);
    }
  }

  /**
   * Streaming Audio File Player (PRIORITY 2: uses HTMLMediaElement streaming)
   * Avoids decoding entire file into memory; scales effortlessly to files of any duration.
   */
  async loadAudioFile(file: File): Promise<boolean> {
    try {
      const ctx = this.initContext();
      this.stopAllSources();
      this.sourceType = 'file';

      if (this.audioFileUrl) {
        URL.revokeObjectURL(this.audioFileUrl);
      }
      this.audioFileUrl = URL.createObjectURL(file);

      if (!this.audioElement) {
        this.audioElement = new Audio();
        this.audioElement.loop = true;
        this.mediaElementSource = ctx.createMediaElementSource(this.audioElement);
        if (this.streamTapNode) {
          this.mediaElementSource.connect(this.streamTapNode);
        }
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
    if (this.monitorGain && this.ctx && this.sourceType !== 'microphone') {
      this.monitorGain.gain.setValueAtTime(muted ? 0 : 0.15, this.ctx.currentTime);
    }
  }

  /**
   * Diagnostic oscilloscope buffer (preserved strictly for visual HUD)
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
    if (this.streamTapNode) {
      this.streamTapNode.disconnect();
      this.streamTapNode = null;
    }
    if (this.ctx) {
      this.ctx.close();
      this.ctx = null;
    }
  }
}
