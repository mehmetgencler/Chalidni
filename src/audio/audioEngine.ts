/**
 * Web Audio Engine for Chladni Plate Simulation
 * Supports internal signal generator (sine, dual-tone, sweep, silence),
 * uploaded audio files with scrubbing, and microphone input.
 * Strictly guarantees NO microphone feedback to speakers.
 */

export type AudioSourceType = 'generator' | 'microphone' | 'file';
export type GeneratorWaveform = 'sine' | 'dual' | 'sweep' | 'silence';

export interface AudioEngineCallbacks {
  onAudioData: (sampleValue: number, samples: Float32Array) => void;
  onStateChange: (state: AudioContextState) => void;
}

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

  // File audio
  private audioBuffer: AudioBuffer | null = null;
  private bufferSource: AudioBufferSourceNode | null = null;
  private fileStartTime = 0;
  private filePauseOffset = 0;
  private isFilePlaying = false;

  // Master Gain & Analyser
  private generatorGain: GainNode | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private analyser: AnalyserNode | null = null;

  // Configuration
  frequency1 = 53.9;  // Hz
  frequency2 = 215.8; // Hz
  gain = 1.0;
  isMuted = false;

  // Continuous waveform data buffer
  private timeDomainBuffer = new Float32Array(512);

  constructor() {
    // Lazily initialize context on user action
  }

  private initContext(): AudioContext {
    if (!this.ctx) {
      const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioContextClass();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    return this.ctx;
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
   * Sets up internal generator
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

    this.generatorGain = ctx.createGain();
    this.generatorGain.gain.setValueAtTime(this.gain, ctx.currentTime);

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;

    this.osc1 = ctx.createOscillator();
    this.osc1.type = 'sine';
    this.osc1.frequency.setValueAtTime(freq1, ctx.currentTime);

    if (type === 'sine') {
      this.osc1.connect(this.generatorGain);
    } else if (type === 'dual') {
      this.osc2 = ctx.createOscillator();
      this.osc2.type = 'sine';
      this.osc2.frequency.setValueAtTime(freq2, ctx.currentTime);
      this.osc1.connect(this.generatorGain);
      this.osc2.connect(this.generatorGain);
      this.osc2.start();
    } else if (type === 'sweep') {
      // Frequency sweep between 40 Hz and 300 Hz
      this.osc1.connect(this.generatorGain);
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
    this.generatorGain.connect(this.analyser);

    // Only route to speakers if audible monitoring is desired and not muted
    // Here we connect to destination at low volume so user can hear plate tone
    if (!this.isMuted) {
      const monitorGain = ctx.createGain();
      monitorGain.gain.setValueAtTime(0.15, ctx.currentTime);
      this.generatorGain.connect(monitorGain);
      monitorGain.connect(ctx.destination);
    }
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
   * CRITICAL REQUIREMENT: Strictly NO feedback loop to destination
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

      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 1024;

      // Connect mic ONLY to analyser! DO NOT connect to ctx.destination!
      this.micSource.connect(this.analyser);

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
  }

  /**
   * File Audio
   */
  async loadAudioFile(file: File): Promise<boolean> {
    try {
      const ctx = this.initContext();
      const arrayBuffer = await file.arrayBuffer();
      this.audioBuffer = await ctx.decodeAudioData(arrayBuffer);
      this.filePauseOffset = 0;
      this.playAudioFile(0);
      return true;
    } catch (err) {
      console.error('Failed to load audio file:', err);
      return false;
    }
  }

  playAudioFile(offset: number = this.filePauseOffset): void {
    if (!this.audioBuffer) return;
    const ctx = this.initContext();
    this.stopAllSources();
    this.sourceType = 'file';

    this.bufferSource = ctx.createBufferSource();
    this.bufferSource.buffer = this.audioBuffer;
    this.bufferSource.loop = true;

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;

    const fileGain = ctx.createGain();
    fileGain.gain.setValueAtTime(this.gain, ctx.currentTime);

    this.bufferSource.connect(fileGain);
    fileGain.connect(this.analyser);

    if (!this.isMuted) {
      fileGain.connect(ctx.destination);
    }

    this.fileStartTime = ctx.currentTime - offset;
    this.filePauseOffset = offset;
    this.bufferSource.start(0, offset);
    this.isFilePlaying = true;
  }

  pauseAudioFile(): void {
    if (this.bufferSource && this.ctx && this.isFilePlaying) {
      this.filePauseOffset = (this.ctx.currentTime - this.fileStartTime) % (this.audioBuffer?.duration || 1);
      this.bufferSource.stop();
      this.bufferSource.disconnect();
      this.bufferSource = null;
      this.isFilePlaying = false;
    }
  }

  seekAudioFile(timeSec: number): void {
    if (!this.audioBuffer) return;
    this.filePauseOffset = Math.max(0, Math.min(timeSec, this.audioBuffer.duration));
    if (this.isFilePlaying) {
      this.playAudioFile(this.filePauseOffset);
    }
  }

  getFileDuration(): number {
    return this.audioBuffer ? this.audioBuffer.duration : 0;
  }

  getFileCurrentTime(): number {
    if (!this.isFilePlaying || !this.ctx || !this.audioBuffer) return this.filePauseOffset;
    return (this.ctx.currentTime - this.fileStartTime) % this.audioBuffer.duration;
  }

  /**
   * Pulls the instantaneous waveform sample and float buffer
   */
  getInstantaneousWaveform(): { sample: number; buffer: Float32Array } {
    if (this.sourceType === 'generator' && this.generatorType === 'silence') {
      this.timeDomainBuffer.fill(0);
      return { sample: 0, buffer: this.timeDomainBuffer };
    }

    if (this.analyser) {
      this.analyser.getFloatTimeDomainData(this.timeDomainBuffer);
      // Sample is the center or latest sample in buffer
      const sample = this.timeDomainBuffer[this.timeDomainBuffer.length - 1] || 0;
      return { sample: sample * this.gain, buffer: this.timeDomainBuffer };
    }

    return { sample: 0, buffer: this.timeDomainBuffer };
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
    if (this.generatorGain) {
      this.generatorGain.disconnect();
      this.generatorGain = null;
    }
    if (this.bufferSource) {
      try { this.bufferSource.stop(); } catch { /* ignore */ }
      this.bufferSource.disconnect();
      this.bufferSource = null;
      this.isFilePlaying = false;
    }
    this.stopMicrophone();
  }

  cleanup(): void {
    this.stopAllSources();
    if (this.ctx) {
      this.ctx.close();
      this.ctx = null;
    }
  }
}
