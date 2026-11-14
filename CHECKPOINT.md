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

4. **Memory-Bounded Silent WAV-to-Video Export (`src/audio/wavPcmStream.ts`, `src/video/videoFileWriter.worker.ts`, `src/audio/audioEngine.ts`, `src/video/silentVideoExport.ts`, `src/components/SilentVideoExport.tsx`, `src/App.tsx`)**:
   - **Slice-based PCM WAV streaming (`src/audio/wavPcmStream.ts`)**: Parses RIFF/WAVE headers and reads `~4 s` frame-aligned chunks strictly via `file.slice(start, end).arrayBuffer()` (with bounded 10 s slice read timeouts). Scans metadata chunks with RIFF odd-byte padding and decodes mono/stereo (`0.5 * (L + R)`) across 8/16/24/32-bit PCM, IEEE Float32, and `WAVE_FORMAT_EXTENSIBLE`.
   - **Silent Worklet Streaming Scheduler (`src/audio/audioEngine.ts`)**: `AudioEngine.startSilentWavStream()` routes streamed mono `AudioBufferSourceNode` chunks strictly into `fileGain` -> `AudioWorkletNode` (`'music'` excitation profile + `RESET_MODES`) and never connects to `ctx.destination` (zero speaker output). Prebuffers `12–16 s` before `onStreamStart`, maintains `<= 4` look-ahead sources with prompt `onended` buffer release, and aborts cleanly on underrun or cancellation. Includes bounded `AudioContext.resume()` handling raising `AudioContextSuspendedError` for one-tap `Start Silent Export` recovery if the browser suspends audio after file selection.
   - **OPFS Disk-Backed Capture & Export (`src/video/videoFileWriter.worker.ts`, `src/video/silentVideoExport.ts`, `src/components/SilentVideoExport.tsx`)**: Preflights `MediaRecorder.isTypeSupported` (preferring H.264 MP4, matching container/extension fallback), bounded `navigator.storage.estimate()` / `persist()`, and OPFS `FileSystemSyncAccessHandle`. Captures only a `480×480` downscaled canvas copy targeting `30 FPS` (`EXPORT_FPS = 30`, `350 kbps` bitrate, `0` audio tracks, `2000 ms` timeslice) via drift-free vsync-paced `requestAnimationFrame` (`advanceCaptureDeadline`), preferring `captureStream(0)` + explicit `requestFrame()` on every copied frame with fallback to `captureStream(30)`, transferring chunks sequentially to the dedicated OPFS Worker with bounded `16 MB` queue protection and cleanup on cancel/error.

5. **1/3 Green, 1/3 Blue, 1/3 Red Randomized Particles (`src/physics/types.ts`, `src/physics/particleTransport.ts`, `src/components/PlateCanvas.tsx`)**:
   - Assigns an exact 1/3 `'green'`, 1/3 `'blue'`, 1/3 `'red'` distribution across particles using deterministic seeded Fisher–Yates shuffling (and preserves the balanced random color assignment across external powder feed / recycled grains), with pre-baked per-color sprite banks in `PlateCanvas`.

6. **Static-Frame Silent Video Export Fix — Particle Reference Synchronization (`src/App.tsx`, `src/components/PlateCanvas.tsx`, `src/video/silentVideoExport.ts`)**:
   - Diagnosed stale `particlesRef.current` in `PlateCanvas` after `App.handlePrepareSilentSimulation()` called `particleSystem.initParticles()` (which allocates a new `this.particles = []` array without triggering a React re-render).
   - Added a stable external reference (`liveParticlesRef` in `src/App.tsx`, optional `particlesRefExternal` prop in `src/components/PlateCanvas.tsx`) updated immediately after `particleSystem.initParticles()` so `PlateCanvas`'s `requestAnimationFrame` loop always draws the live evolving particle array, and added `captureStream(0)` + explicit `requestFrame()` in `src/video/silentVideoExport.ts` on every copied export frame.

## Files Modified / Added

- `src/audio/wavPcmStream.ts` (new)
- `src/video/videoFileWriter.worker.ts` (new)
- `src/video/silentVideoExport.ts` (new)
- `src/components/SilentVideoExport.tsx` (new)
- `src/audio/audioEngine.ts`
- `src/physics/types.ts`
- `src/physics/particleTransport.ts`
- `src/components/PlateCanvas.tsx`
- `src/App.tsx`
- `src/physics/physics.test.ts` (`Tests 28–35` added; `Tests 1–27` preserved)
- `e2e/silent-video-export.spec.ts` (new, `Tests 1–4`)
- `public/audio/modal-worklet-processor.js`, `src/physics/modalSolver.ts`, `src/physics/simulationClock.ts`, `src/physics/plate.ts`: physics solver/worklet unchanged from bounded music-input normalization checkpoint.

## Tests Executed & Actual Results

- **TypeScript Lint (`npm run lint`)**: Passed (`0` errors).
- **Production Build (`npm run build` / `compile_applet`)**: Passed.
- **Unit & Scheduler Integration Tests (`npm run test` -> `tsx --test src/physics/physics.test.ts`)**: `33/33` passed (`Tests 1–35`), covering PCM 8/16/24/32, Float32, `EXTENSIBLE`, odd metadata padding, slice-only read verification, frame alignment, prebuffering, lookahead bounds, silent routing (`isFileAudibleToDestination === false`), suspended `AudioContext` prompt failure (`AudioContextSuspendedError`), cancellation, underrun abort, codec/extension pairing, 1/3 green/blue/red particle distribution, and 30 FPS vsync-paced capture scheduling at 60 Hz & 120 Hz.
- **Scientific Audit (`npm run audit` -> `tsx src/physics/independentAudit.ts`)**: `17/17` executable checks passed (`3` hardware/physical-device checks `NOT RUN`).
- **Playwright E2E (`npm run test:e2e`)**: `6/6` passed in headless Chromium (`e2e/chladni-e2e.spec.ts`: `2/2`; `e2e/silent-video-export.spec.ts`: `4/4` covering 15 s silent stereo WAV export to OPFS with `0` audio tracks & `480×480` playable video decode check, Discard cleanup, active export Cancellation cleanup, suspended `AudioContext` `Start Silent Export` recovery, and Test 4 proving live `PlateCanvas` pixel evolution (`changedPixels: 27,185`, `simFrames: 47,488 -> 312,832`, `particleSteps: 67 -> 443`), `27.52 fps` decoded playback cadence in headless Chromium, and separated decoded MP4 frame differences (`0.25s vs 3.5s: 98,347 changed pixels`; `0.25s vs 7.0s: 101,489 changed pixels`), with `0` console/page errors).

## Outstanding Manual Validation

- **Physical iPhone Safari Long-WAV (e.g. 50-minute) Export & Background/Screen-Lock Behavior**: Not executed in this Linux Chromium container. Real physical iPhone Safari H.264 MP4 `MediaRecorder`, OPFS `SyncAccessHandle`, `navigator.share` Files export, and screen-lock behavior must be confirmed directly on an iOS Safari device.

