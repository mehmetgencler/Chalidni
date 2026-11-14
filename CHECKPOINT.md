# Working Version Checkpoint — 2026-11-14

## Exact Behavior Changes

1. **Bounded Music-Input Normalization (`public/audio/modal-worklet-processor.js`, `src/audio/audioEngine.ts`)**:
   - Added explicit `SET_EXCITATION_PROFILE` support (`'raw'` default vs `'music'`) in `ModalWorkletProcessor`.
   - Preserved `'raw'` profile bit-for-bit identically (`excBuf[s] = rawSample * 3.0`, no AGC, gating, normalization, or attenuation).
   - Added bounded RMS normalizer & hysteresis noise gate for `'music'` profile only (`musicTargetInputRms = 0.006`, `musicMinGain = 1.0`, `musicMaxGain = 16.0`, open `-78 dBFS RMS`, close `-84 dBFS RMS`, precomputed linear thresholds, zero per-quantum heap allocations, separate from 80 ms modal covariance tracking):
     - Tracks mean-square envelope (`tauEnv = 0.05 s`) using actual quantum duration `quantumLen / sampleRate`.
     - Applies smoothed gain (`tauGainAttack = 0.05 s`, `tauGainRelease = 0.02 s`) toward `clamp(0.006 / inputRmsEnvelope, 1.0, 16.0)` when gate is open; outputs exact zero excitation during closed-gate periods without pushing gain upward on silence or resetting modal free decay.
     - Computes `hasInput` and `isSilent` from post-gate effective excitation energy in `'music'` profile.
   - Updated `AudioEngine` to send `SET_EXCITATION_PROFILE`: `'raw'` before starting the sine oscillator (`startTone()`) and `'music'` before starting playback in both `AudioBufferSourceNode` and `HTMLAudioElement` paths (`loadAudioFile()`), preserving `'music'` across pause, resume, seek, and suspended-context file loads.

2. **Audio File Reactive Simulation & iOS Safari Compatibility (`src/audio/audioEngine.ts`, `src/components/AudioExciter.tsx`)**:
   - Decodes uploaded `.mp3`/`.wav` via `ctx.decodeAudioData()` + `AudioBufferSourceNode` dual-routed to mono downmix worklet bus and stereo destination, with bounded `ctx.resume()` wait so deferred resume after file-picker close remains ready for an explicit **Play** tap.
   - Uses `peer sr-only` `<input>` + visible `<label htmlFor>` with extension-based `.mp3`/`.wav` validation and visible `role="alert"` errors.

3. **Transport-Eligibility Gate & Down-Sweep Recovery (`src/physics/particleTransport.ts`)**:
   - Gated `feedInteriorParticlesIfNeeded()` and `1 mm` perimeter recycling in `stepFromRmsGrid()` with `hasTransportEligibleInteriorField(rmsQuadrant, halfN, 0.001)` (`D_g > 1e-15`).

## Files Modified

- `public/audio/modal-worklet-processor.js`
- `src/audio/audioEngine.ts`
- `src/components/AudioExciter.tsx`
- `src/physics/particleTransport.ts`
- `src/physics/physics.test.ts` (`Tests 24–27` added; `Tests 1–23` preserved)
- `CHECKPOINT.md`

## Tests Executed & Actual Results

- **TypeScript Lint (`npm run lint`)**: Passed (`0` errors).
- **Production Build (`npm run build`)**: Passed.
- **Unit Tests (`npm run test` -> `tsx --test src/physics/physics.test.ts`)**: `25/25` passed (`Tests 1–27`), including:
  - `Test 26`: `-70 dBFS` center `aRms = 12.328 m/s²` (`0.771 m/s²` under `'raw'`), particle movement `0.1413 mm`; `-78 dBFS` center `aRms = 4.900 m/s² < 9.80687 m/s²` with zero movement and zero feeding/recycling; digital silence free of artificial excitation with natural modal free decay; gain strictly in `[1.0, 16.0]`; loud signal stays at `1.0` unity.
  - `Test 27`: `SET_EXCITATION_PROFILE` ordering across generator, primary buffer, suspended load + Play, and HTMLAudio fallback.
- **Scientific Audit (`npm run audit` -> `tsx src/physics/independentAudit.ts`)**: `17/17` executable checks passed (`3` hardware/physical-device checks `NOT RUN`).
- **Playwright E2E (`npm run test:e2e`)**: `2/2` passed in Chromium (`0` console/page errors).

## Outstanding Manual Validation

- **Physical iPhone Safari MP3/WAV Selection & Playback**: Not executed in this Linux container (no physical iOS Safari browser available). Must be confirmed on a real iPhone Safari device.
