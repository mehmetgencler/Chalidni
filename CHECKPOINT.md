# Working Version Checkpoint — 2026-11-13

## Verified Application State

- **Scope**: Minimal realistic Chladni plate simulator (`0.30 m` aluminum Kirchhoff–Love plate, `20 Hz – 20 kHz`) with single-tone sine excitation (`20 Hz – 20,000 Hz`) and stereo audio file playback (`Play`/`Pause`), routed through a unified `146`-mode center-coupled `AudioWorklet` solver and `Itô` granular particle transport engine.
- **UI**: Unchanged minimal plate visualization and excitation controls; zero microphone code/permissions; zero telemetry overlays.
- **High-Frequency Spatial Fidelity**: Exact `28x28` 2D cosine tensor contraction in `ModalBank.rebuildFastRmsGrid()` supporting adaptive RMS quadrant resolution up to `385x385` full-plate equivalent.
- **Controlled Powder Feeding & Down-Sweep Recovery**:
  - `3,000` initial grains with `maxParticleCount = 4,500` and `1 mm` perimeter exclusion monitoring (`minInteriorTarget = 2,100`).
  - Once `4,500` total grains are reached, `feedInteriorParticlesIfNeeded` reclaims only permanently dead-trapped `1 mm` perimeter-rim grains (never moving interior nodal particles) back into the plate interior with a `0.20 s` cooldown, resolving interior sparsity when sweeping down from `20 kHz` to `20 Hz`.

## Last Verified Checks (Run Prior to Checkpoint Record, Zero Source Changes Since)

- **Build & Type Check**: `npm run build` (`vite build`) and `npm run lint` (`tsc --noEmit`) — passed.
- **Unit Tests (`npm run test`)**: `21/21` passed (`Tests 1–23`, including `20 kHz -> 20 Hz` down-sweep recovery).
- **Scientific Audit (`npm run audit`)**: `17/17` executable checks passed (`3` hardware/non-Node checks marked `NOT RUN`).
- **Playwright E2E (`npm run test:e2e`)**: `2/2` passed (`meanParticleUpdateMs = 0.73–1.72 ms` across desktop & mobile viewports at `44.1 kHz` / `48 kHz`).
- **Live Browser Sweep (`48 kHz` Chromium)**: `20.0 kHz` (`4,500` total / `1,572` interior) -> `263.0 Hz` (`1,903` interior) -> `20.00 Hz` (`2,100` interior), `0` console/page errors.
