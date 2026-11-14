# Working Version Checkpoint — 2026-11-14

## Exact Behavior Changes

1. **Audio File Reactive Simulation Fix (`src/audio/audioEngine.ts`)**:
   - Switched `AudioEngine.loadAudioFile(file)` to decode uploaded `.mp3`/`.wav` files via `ctx.decodeAudioData(arrayBuf.slice(0))` and play via `AudioBufferSourceNode` connected simultaneously to `fileInputSplitter` (`ChannelSplitterNode(2)` -> mono downmix `0.5 * (L + R)` / `1.0` mono -> `fileGain` -> `workletNode`) and `ctx.destination`, keeping `HTMLAudioElement` + `MediaElementAudioSourceNode` only as a fallback if `decodeAudioData` rejects.
   - Fixes Safari/iOS WebKit silent `MediaElementAudioSourceNode` output for `blob:` URLs and `<audio>`/`AudioContext` state mismatch where audio plays audibly while the `AudioWorklet` modal simulation stays silent/idle.
   - Bounded `ctx.resume()` waiting in `initContext()`, `resumeContext()`, and `loadAudioFile()` using `triggerContextResume()` + `waitForContextResumeBounded()`, preventing file-loading deadlocks when a browser defers `AudioContext.resume()` outside a user gesture after file-picker dismissal and ensuring a subsequent **Play** tap calls `ctx.resume()` freshly and starts `AudioBufferSourceNode`.
   - Preserved `AudioBufferSourceNode` lifecycle (`pauseAudioFile()`, `seekAudioFile()`, `stopAudioFile()`, natural `onended` modal free decay) and cleared stale state if file load fails.

2. **MP3/WAV File Selection & iOS Safari Compatibility Patch (`src/components/AudioExciter.tsx`)**:
   - Replaced `className="hidden"` + programmatic `fileInputRef.current?.click()` with a `peer sr-only` `<input id={fileInputId} type="file" ... />` paired with a visible `<label htmlFor={fileInputId}>` preserving existing styling and text.
   - Updated `accept` to `.mp3,.wav,audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/wave`, added case-insensitive `.mp3`/`.wav` filename validation independent of `File.type`, immediate `input.value = ''` reset, and `role="alert"` error feedback.

3. **Transport-Eligibility Gate & Down-Sweep Recovery (`src/physics/particleTransport.ts`)**:
   - Gated `feedInteriorParticlesIfNeeded()` and `1 mm` perimeter recycling in `stepFromRmsGrid()` with `hasTransportEligibleInteriorField(rmsQuadrant, halfN, 0.001)` using `evaluateDimensionalDiffusivity(aRms, false) > 1e-15`.
   - Preserved all existing powder-feed constants (`3,000` initial, `2,100` interior target, `4,500` ceiling, `0.20 s` cooldown, `60` append max, `300` recycle max, `1 mm` perimeter), `Mulberry32PRNG`, `edgeRecycleCursor`, and closed-system `step()` physics.

## Files Modified

- `src/audio/audioEngine.ts`
- `src/components/AudioExciter.tsx`
- `src/physics/particleTransport.ts`
- `src/physics/physics.test.ts` (`Tests 24–25` added; `Tests 1–23` preserved)
- `CHECKPOINT.md`

## Tests Executed & Actual Results

- **TypeScript Lint (`tsc --noEmit` / `lint_applet`)**: Passed (`0` errors).
- **Production Build (`vite build` / `compile_applet`)**: Passed.
- **Unit Tests (`npm run test` -> `tsx --test src/physics/physics.test.ts`)**: `23/23` passed (`Tests 1–25`, including `Test 25` verifying `AudioBufferSourceNode` dual routing, `0.5`/`1.0` gain, pause/seek/`onended`, and suspended-context Play recovery).
- **Scientific Audit (`npm run audit` -> `tsx src/physics/independentAudit.ts`)**: `17/17` executable checks passed (`3` hardware/browser checks `NOT RUN`).
- **Playwright E2E (`npm run test:e2e`)**: `2/2` passed in Chromium (`41.0 s`, `0` console/page errors).
- **Live Browser Cold-Start Music Playback Check (`playwright-cli` Chromium, `1440x900` & `390x844`)**: Verified cold-start switch to `Audio File Playback` without starting test tone -> uploading stereo music-mix WAV (`music-mix-8s.wav` / `music-mix-12s.wav`) and mono WAV (`mono-music.wav`) drove `AudioWorklet` (`simFrames: 73,600 -> 163,968`, `particleSteps: 103 -> 231`, `isSilent: false`, visible Chladni ring formation), Pause/Play transitions, `0` console errors/warnings.

## Outstanding Manual Validation

- **Physical iPhone Safari MP3/WAV Selection & Playback**: Not executed in this Linux container (no physical iOS Safari browser available). Must be confirmed on a real iPhone Safari device (selecting `.mp3`/`.wav`, confirming autoplay or tapping Play if iOS suspends context across file picker dismissal, and confirming audible sound + reactive plate patterns).
