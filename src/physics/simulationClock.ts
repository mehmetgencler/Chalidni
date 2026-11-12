/**
 * SimulationClockAccumulator: Authoritative Sample-Frame Simulation Clock
 * 
 * Ensures:
 * - Single authoritative physical clock: t = sampleFramesProcessed / sampleRate.
 * - Identical snapshots or backward sample counts perform zero steps.
 * - Main-thread rendering stalls never silently discard elapsed simulation time:
 *   all accumulated time is preserved and processed in bounded chunks.
 * - Zero dependency on wall-clock requestAnimationFrame dt.
 */

import { ModalSnapshot } from './types.ts';

export class SimulationClockAccumulator {
  private lastSampleFrames: number | null = null;
  private accumulatedTimeSec: number = 0;
  private totalSimulatedTimeSec: number = 0;
  private totalStepsExecuted: number = 0;

  get remainingTimeSec(): number {
    return this.accumulatedTimeSec;
  }

  get simulatedTimeSec(): number {
    return this.totalSimulatedTimeSec;
  }

  get stepsExecuted(): number {
    return this.totalStepsExecuted;
  }

  get lastFrames(): number | null {
    return this.lastSampleFrames;
  }

  reset(): void {
    this.lastSampleFrames = null;
    this.accumulatedTimeSec = 0;
    this.totalSimulatedTimeSec = 0;
    this.totalStepsExecuted = 0;
  }

  /**
   * Advances simulation accumulator strictly from monotonic AudioWorklet sample frames.
   * Returns the number of fixed dtParticle steps executed in this tick.
   * Preserves any remaining accumulated time across bounded chunks without discarding it.
   */
  advanceFromSnapshot(
    snapshot: Pick<ModalSnapshot, 'sampleFramesProcessed' | 'sampleRate'>,
    dtParticle: number,
    maxSubStepsPerTick: number,
    onStep: (dt: number) => void
  ): number {
    if (snapshot.sampleRate <= 0 || dtParticle <= 0) {
      return 0;
    }

    if (this.lastSampleFrames === null) {
      this.lastSampleFrames = snapshot.sampleFramesProcessed;
      return 0;
    }

    const deltaSamples = snapshot.sampleFramesProcessed - this.lastSampleFrames;
    if (deltaSamples <= 0) {
      // Handle explicit worklet reset if sampleFramesProcessed dropped to a smaller value
      if (snapshot.sampleFramesProcessed < this.lastSampleFrames) {
        this.lastSampleFrames = snapshot.sampleFramesProcessed;
      }
      return 0;
    }

    this.lastSampleFrames = snapshot.sampleFramesProcessed;
    const dtSim = deltaSamples / snapshot.sampleRate;
    this.accumulatedTimeSec += dtSim;

    let stepsThisTick = 0;
    while (this.accumulatedTimeSec >= dtParticle - 1e-12 && stepsThisTick < maxSubStepsPerTick) {
      onStep(dtParticle);
      this.accumulatedTimeSec = Math.max(0, this.accumulatedTimeSec - dtParticle);
      this.totalSimulatedTimeSec += dtParticle;
      this.totalStepsExecuted++;
      stepsThisTick++;
    }

    return stepsThisTick;
  }

  /**
   * Drains any remaining accumulated time in bounded steps (used by tests or explicit catch-up).
   */
  drainRemaining(dtParticle: number, maxSubSteps: number, onStep: (dt: number) => void): number {
    let steps = 0;
    while (this.accumulatedTimeSec >= dtParticle - 1e-12 && steps < maxSubSteps) {
      onStep(dtParticle);
      this.accumulatedTimeSec = Math.max(0, this.accumulatedTimeSec - dtParticle);
      this.totalSimulatedTimeSec += dtParticle;
      this.totalStepsExecuted++;
      steps++;
    }
    return steps;
  }
}
