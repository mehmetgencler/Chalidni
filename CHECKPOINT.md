# Working Version Checkpoint — 2026-11-13

## Exact Behavior Change (Transport-Eligibility Gate)

- **Gated External Powder Feed & Perimeter Recycling (`src/physics/particleTransport.ts`)**:
  - Added `hasTransportEligibleInteriorField(rmsQuadrant, halfN, perimeterBandM = 0.001)` on `ParticleTransportSystem`, which evaluates the 4-fold symmetric quadrant RMS grid strictly inside `(0.001 m, L - 0.001 m)^2` using the existing `evaluateDimensionalDiffusivity(aRms, false) > 1e-15` threshold (for production defaults `g = 9.80665 m/s^2`, `gammaC = 1.0`, `dRef = 2.0e-6`, `power = 2.0`, `subThresholdCreepFloor = 0.0`).
  - Updated `feedInteriorParticlesIfNeeded(dt, isSilent, rmsQuadrant?, halfN?)` and its production call site in `stepFromRmsGrid()` so both new particle introduction (`<= 60` per `0.20 s` cooldown, `4,500` total ceiling) and perimeter-rim recycling (`<= 300` per `0.20 s` cooldown, `1 mm` perimeter only, interior nodal grains untouched) are skipped whenever no interior point on the current RMS grid satisfies the production transport-eligibility condition.
  - Preserved all existing powder-feed parameters (`3,000` initial, `2,100` interior target, `4,500` cap, `0.20 s` cooldown, `60` append max, `300` recycle max, `1 mm` perimeter band), `Mulberry32PRNG`, `edgeRecycleCursor`, and closed-system `step()` physics.

## Files Modified

- `src/physics/particleTransport.ts`
- `src/physics/physics.test.ts` (added `Test 24`; preserved `Tests 1–23`)
- `CHECKPOINT.md`

## Tests Executed & Actual Results

- **TypeScript Lint (`tsc --noEmit` / `lint_applet`)**: Passed (`0` errors).
- **Production Build (`vite build` / `compile_applet`)**: Passed.
- **Unit Tests (`npm run test` -> `tsx --test src/physics/physics.test.ts`)**: `22/22` passed (`Tests 1–24`, including `Test 23` down-sweep `269.8 Hz -> 5 kHz -> 19.912 kHz -> 269.8 Hz -> 53.96 Hz -> 20 Hz` recovery and `Test 24` sub-threshold/silent/perimeter-only block, eligible feed resume, and `4,500`-cap rim recycling).
- **Scientific Audit (`npm run audit` -> `tsx src/physics/independentAudit.ts`)**: `17/17` executable checks passed (`3` hardware/non-Node checks marked `NOT RUN`).
- **Playwright E2E (`npm run test:e2e`)**: `2/2` passed in Chromium (`28.4 s`, `0` console/page errors; covers `269.8 Hz -> 5 kHz -> 20 kHz` tone sweep, synthetic `269.815 Hz` stereo WAV downmix & free decay, and `65x65` vs `385x385` adaptive RMS benchmarks at `44.1 kHz` / `48 kHz` across desktop & mobile).

## Outstanding Validation

- **Real-music multi-component browser validation**: Remains a manual test. No pre-existing multi-component music WAV/audio fixture exists in the repository (browser E2E uses generated single-frequency `269.815 Hz` stereo WAVs).
