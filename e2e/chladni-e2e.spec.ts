import { test, expect, Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Generates a deterministic 16-bit PCM stereo WAV buffer.
 */
function buildStereoWavBuffer(opts: {
  sampleRate: number;
  durationSec: number;
  leftFreqHz: number;
  leftAmp: number;
  rightFreqHz: number;
  rightAmp: number;
}): Buffer {
  const { sampleRate, durationSec, leftFreqHz, leftAmp, rightFreqHz, rightAmp } = opts;
  const totalSamples = Math.floor(sampleRate * durationSec);
  const buf = Buffer.alloc(44 + totalSamples * 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + totalSamples * 4, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(2, 22); // Stereo
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(totalSamples * 4, 40);

  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;
    const l = Math.max(-1, Math.min(1, leftAmp * Math.sin(2 * Math.PI * leftFreqHz * t)));
    const r = Math.max(-1, Math.min(1, rightAmp * Math.sin(2 * Math.PI * rightFreqHz * t)));
    buf.writeInt16LE(Math.round(l * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(r * 32767), 44 + i * 4 + 2);
  }
  return buf;
}

async function readCanvasDataset(page: Page) {
  return page.evaluate(() => {
    const c = document.querySelector('canvas');
    return c ? { ...c.dataset } : {};
  });
}

async function measureFrameAndPhysicsPerf(page: Page, sampleDurationMs: number) {
  return page.evaluate(async (ms: number) => {
    const deltas: number[] = [];
    const gridRebuilds: number[] = [];
    const particleUpdates: number[] = [];
    const canvas = document.querySelector('canvas');

    await new Promise<void>((resolve) => {
      const start = performance.now();
      let prev = start;
      const tick = (now: number) => {
        deltas.push(now - prev);
        prev = now;
        if (canvas) {
          const gr = parseFloat(canvas.dataset.gridRebuildMs || '0');
          const pu = parseFloat(canvas.dataset.particleUpdateMs || '0');
          if (Number.isFinite(gr)) gridRebuilds.push(gr);
          if (Number.isFinite(pu)) particleUpdates.push(pu);
        }
        if (now - start >= ms) {
          resolve();
        } else {
          requestAnimationFrame(tick);
        }
      };
      requestAnimationFrame(tick);
    });

    deltas.sort((a, b) => a - b);
    const pct = (arr: number[], p: number) => {
      if (arr.length === 0) return 0;
      const idx = Math.min(arr.length - 1, Math.floor(p * (arr.length - 1)));
      return arr[idx];
    };
    const mean = (arr: number[]) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0);

    const perfMem = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
    return {
      frameCount: deltas.length,
      medianFrameMs: pct(deltas, 0.5),
      p95FrameMs: pct(deltas, 0.95),
      worstFrameMs: deltas[deltas.length - 1] ?? 0,
      meanParticleUpdateMs: mean(particleUpdates),
      maxParticleUpdateMs: Math.max(0, ...particleUpdates),
      meanGridRebuildMs: mean(gridRebuilds),
      maxGridRebuildMs: Math.max(0, ...gridRebuilds),
      jsHeapMb: perfMem ? perfMem.usedJSHeapSize / (1024 * 1024) : null,
    };
  }, sampleDurationMs);
}

test.describe('Stage 9 Real Browser AudioWorklet & Granular Simulation E2E', () => {
  const fixtureDir = path.resolve('.playwright-cli/e2e-fixtures');
  const rightOnlyLongWav = path.join(fixtureDir, 'stereo-right-5s.wav');
  const rightOnlyShortWav = path.join(fixtureDir, 'stereo-right-0.8s.wav');

  test.beforeAll(() => {
    fs.mkdirSync(fixtureDir, { recursive: true });
    // Right-channel-only 5s 44.1 kHz WAV (L = 0, R = 269.815 Hz)
    fs.writeFileSync(
      rightOnlyLongWav,
      buildStereoWavBuffer({
        sampleRate: 44100,
        durationSec: 5.0,
        leftFreqHz: 269.815,
        leftAmp: 0.0,
        rightFreqHz: 269.815,
        rightAmp: 0.95,
      })
    );
    // Short 0.8s right-channel-only WAV for testing natural file-end free decay
    fs.writeFileSync(
      rightOnlyShortWav,
      buildStereoWavBuffer({
        sampleRate: 44100,
        durationSec: 0.8,
        leftFreqHz: 269.815,
        leftAmp: 0.0,
        rightFreqHz: 269.815,
        rightAmp: 0.95,
      })
    );
  });

  test('1. Full AudioWorklet pipeline: tone sweep (269.8 Hz -> 5 kHz -> 20 kHz), stereo WAV downmix, pause & file-end free decay, UI invariant', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(String(err)));

    // Confirm production AudioWorklet module asset serves cleanly with 200 OK
    const workletRes = await page.request.get('/audio/modal-worklet-processor.js');
    expect(workletRes.status()).toBe(200);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');

    // Check Stage 7/8 minimal UI preservation (zero extra controls, zero microphone)
    await expect(page.getByRole('button', { name: 'Sine Test Tone (20 Hz – 20 kHz)' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Audio File Playback' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start Tone' })).toBeVisible();
    await expect(page.locator('input[type="range"]')).toHaveCount(1);
    await expect(page.locator('button')).toHaveCount(3); // 2 tabs + Start Tone

    // 1. Start Sine Test Tone (269.82 Hz default)
    await page.getByRole('button', { name: 'Start Tone' }).click();
    await page.waitForTimeout(800);

    const dsTone1 = await readCanvasDataset(page);
    expect(dsTone1.realWorklet).toBe('true');
    expect(dsTone1.sharedWorklet).toBe('true');
    expect(dsTone1.modeCount).toBe('146');
    expect(dsTone1.isSilent).toBe('false');
    expect(dsTone1.boundViolated).toBe('false');
    expect(Number(dsTone1.simFrames)).toBeGreaterThan(10000);
    expect(Number(dsTone1.maxSubstepRms)).toBeLessThanOrEqual(0.008001);

    // 2. Sweep above 2.7 kHz (~5 kHz -> u = log10(5000/20)/3 = 0.7993) and verify >2.7 kHz mode response
    const slider = page.locator('input[type="range"]');
    const box = (await slider.boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.8, box.y + box.height / 2);
    await page.waitForTimeout(600);

    const ds5k = await readCanvasDataset(page);
    expect(Number(ds5k.highFreqRms)).toBeGreaterThan(20.0);
    expect(Number(ds5k.simFrames)).toBeGreaterThan(Number(dsTone1.simFrames));
    expect(ds5k.isSilent).toBe('false');

    // 3. Exercise 20 kHz input path (u = 1.0)
    await page.mouse.click(box.x + box.width - 1, box.y + box.height / 2);
    await page.waitForTimeout(600);
    const ds20k = await readCanvasDataset(page);
    expect(ds20k.isSilent).toBe('false');
    expect(Number(ds20k.highFreqRms)).toBeGreaterThan(50.0);
    expect(Number(ds20k.simFrames)).toBeGreaterThan(Number(ds5k.simFrames));

    // 4. Stop Tone -> natural free decay, clock never resets or jumps backward
    await page.getByRole('button', { name: 'Stop Tone' }).click();
    await page.waitForTimeout(250);
    const dsStop1 = await readCanvasDataset(page);
    await page.waitForTimeout(450);
    const dsStop2 = await readCanvasDataset(page);
    expect(Number(dsStop1.simFrames)).toBeGreaterThan(Number(ds20k.simFrames));
    expect(Number(dsStop2.simFrames)).toBeGreaterThan(Number(dsStop1.simFrames));

    // 5. Switch to Audio File Playback and upload Right-channel-only 5s stereo WAV
    await page.getByRole('button', { name: 'Audio File Playback' }).click();
    await page.locator('input[type="file"]').setInputFiles(rightOnlyLongWav);
    await page.waitForTimeout(900);

    const dsFilePlaying = await readCanvasDataset(page);
    expect(dsFilePlaying.sourceType).toBe('file');
    expect(dsFilePlaying.sharedWorklet).toBe('true');
    expect(dsFilePlaying.audibleFile).toBe('true');
    expect(dsFilePlaying.isSilent).toBe('false');
    expect(dsFilePlaying.modeCount).toBe('146');
    expect(Number(dsFilePlaying.simFrames)).toBeGreaterThan(Number(dsStop2.simFrames));

    // 6. Pause playback -> natural modal free decay, sample-frame clock never resets
    await page.getByRole('button', { name: 'Pause' }).click();
    await page.waitForTimeout(250);
    const dsPause1 = await readCanvasDataset(page);
    await page.waitForTimeout(400);
    const dsPause2 = await readCanvasDataset(page);
    expect(Number(dsPause1.simFrames)).toBeGreaterThanOrEqual(Number(dsFilePlaying.simFrames));
    expect(Number(dsPause2.simFrames)).toBeGreaterThan(Number(dsPause1.simFrames));

    // 7. Upload short 0.8s WAV and let playback reach natural file end -> natural free decay without clock reset
    await page.locator('input[type="file"]').setInputFiles(rightOnlyShortWav);
    await page.waitForTimeout(350);
    const dsShortMid = await readCanvasDataset(page);
    expect(dsShortMid.isSilent).toBe('false');
    expect(Number(dsShortMid.simFrames)).toBeGreaterThan(Number(dsPause2.simFrames));

    // Wait past 0.8s file duration so onended fires naturally + decay runs
    await page.waitForTimeout(1000);
    const dsShortEnd = await readCanvasDataset(page);
    expect(Number(dsShortEnd.simFrames)).toBeGreaterThan(Number(dsShortMid.simFrames));
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();

    expect(consoleErrors).toEqual([]);
  });

  test('2. Real Browser Performance Comparison: Fixed 65x65 vs Adaptive RMS (3,000 particles, 44.1 kHz & 48 kHz, Desktop & Mobile viewport)', async ({
    page,
  }) => {
    const configs = [
      { label: 'Desktop 1440x900 | 65x65 Baseline | 48 kHz', width: 1440, height: 900, url: '/?grid=65&sr=48000' },
      { label: 'Desktop 1440x900 | Adaptive RMS  | 48 kHz', width: 1440, height: 900, url: '/?sr=48000' },
      { label: 'Desktop 1440x900 | Adaptive RMS  | 44.1 kHz', width: 1440, height: 900, url: '/?sr=44100' },
      { label: 'Mobile  390x844   | 65x65 Baseline | 48 kHz', width: 390, height: 844, url: '/?grid=65&sr=48000' },
      { label: 'Mobile  390x844   | Adaptive RMS  | 48 kHz', width: 390, height: 844, url: '/?sr=48000' },
      { label: 'Mobile  390x844   | Adaptive RMS  | 44.1 kHz', width: 390, height: 844, url: '/?sr=44100' },
    ];

    const results: unknown[] = [];

    for (const cfg of configs) {
      await page.setViewportSize({ width: cfg.width, height: cfg.height });
      await page.goto(cfg.url);

      // Start tone at 269.82 Hz and also sweep to high-order 19.9 kHz region to trigger full adaptive resolution
      await page.getByRole('button', { name: 'Start Tone' }).click();
      await page.waitForTimeout(400);
      const slider = page.locator('input[type="range"]');
      const box = (await slider.boundingBox())!;
      await page.mouse.click(box.x + box.width * 0.999, box.y + box.height / 2);
      await page.waitForTimeout(300);

      const perf = await measureFrameAndPhysicsPerf(page, 1200);
      const ds = await readCanvasDataset(page);
      const mobileOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth
      );

      expect(mobileOverflow).toBe(false);
      expect(ds.boundViolated).toBe('false');
      expect(Number(ds.maxSubstepRms)).toBeLessThanOrEqual(0.008001);

      results.push({
        label: cfg.label,
        sampleRate: ds.sampleRate,
        gridRes: `${ds.gridRes}x${ds.gridRes}`,
        ...perf,
      });
    }

    console.log('\n[Stage 9 Browser Performance Table (Chromium)]:');
    console.table(results);
  });
});
