import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Generates a synthetic multi-segment stereo 16-bit PCM WAV buffer whose frequencies
 * switch mid-track so the Chladni plate forms evolving nodal patterns during silent export.
 */
function buildEvolvingStereoWav(opts: {
  sampleRate: number;
  durationSec: number;
}): Buffer {
  const { sampleRate, durationSec } = opts;
  const totalFrames = Math.floor(sampleRate * durationSec);
  const blockAlign = 4; // 2ch * 16-bit
  const dataSize = totalFrames * blockAlign;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(2, 22); // Stereo
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * blockAlign, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < totalFrames; i++) {
    const t = i / sampleRate;
    // First half: (1,3)+(3,1) resonance 269.815 Hz; Second half: higher resonance 1349.08 Hz
    const f = t < durationSec * 0.5 ? 269.815 : 1349.08;
    // Left quiet + Right modulated to verify stereo 0.5*(L+R) downmix in streaming export
    const l = 0.35 * Math.sin(2 * Math.PI * f * t);
    const r = 0.75 * Math.sin(2 * Math.PI * f * t);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, l)) * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, r)) * 32767), 44 + i * 4 + 2);
  }
  return buf;
}

/**
 * Generates a deterministic constant-resonance stereo 16-bit PCM WAV buffer at (1,3)+(3,1) = 269.815 Hz
 * with strong amplitude (0.85) so aRms >> 9.80687 m/s^2 and particles visibly migrate into nodal lines.
 */
function buildResonanceStereoWav(opts: {
  sampleRate: number;
  durationSec: number;
  frequencyHz: number;
  amplitude: number;
}): Buffer {
  const { sampleRate, durationSec, frequencyHz, amplitude } = opts;
  const totalFrames = Math.floor(sampleRate * durationSec);
  const blockAlign = 4; // 2ch * 16-bit
  const dataSize = totalFrames * blockAlign;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(2, 22); // Stereo
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * blockAlign, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < totalFrames; i++) {
    const t = i / sampleRate;
    const s = amplitude * Math.sin(2 * Math.PI * frequencyHz * t);
    const val = Math.round(Math.max(-1, Math.min(1, s)) * 32767);
    buf.writeInt16LE(val, 44 + i * 4);
    buf.writeInt16LE(val, 44 + i * 4 + 2);
  }
  return buf;
}

test.describe('Memory-Bounded Silent WAV-to-Video Export E2E', () => {
  const fixtureDir = path.resolve('.playwright-cli/e2e-fixtures');
  const wav15sPath = path.join(fixtureDir, 'evolving-15s-stereo.wav');
  const wav11sResonancePath = path.join(fixtureDir, 'resonance-269hz-11s-stereo.wav');
  const badTxtPath = path.join(fixtureDir, 'not-a-wav.txt');

  test.beforeAll(() => {
    fs.mkdirSync(fixtureDir, { recursive: true });
    // 15 seconds (>12s prebuffer threshold, exercises multiple 4s chunks + lookahead pump)
    fs.writeFileSync(
      wav15sPath,
      buildEvolvingStereoWav({
        sampleRate: 22050,
        durationSec: 15.0,
      })
    );
    // 11 seconds at exact (1,3)+(3,1) resonance 269.815 Hz for deterministic particle migration & frame-diff proof
    fs.writeFileSync(
      wav11sResonancePath,
      buildResonanceStereoWav({
        sampleRate: 22050,
        durationSec: 11.0,
        frequencyHz: 269.815,
        amplitude: 0.85,
      })
    );
    fs.writeFileSync(badTxtPath, 'invalid');
  });

  test('1. Silent 15s stereo WAV exports playable 480x480 canvas-only video to OPFS with zero speaker output and zero audio tracks', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(String(err)));

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');

    // Idle button count invariant remains untouched
    await expect(page.locator('button')).toHaveCount(3);

    const exportDetails = page.getByTestId('silent-video-export');
    await expect(exportDetails).toBeVisible();
    await exportDetails.locator('summary').click();

    // Reject non-WAV extension cleanly
    const wavInput = page.getByTestId('silent-wav-file-input');
    await wavInput.setInputFiles(badTxtPath);
    await expect(exportDetails).toHaveAttribute('data-export-phase', 'error');
    await expect(exportDetails).toContainText('Unsupported file extension');

    // Start real 15s silent export
    await wavInput.setInputFiles(wav15sPath);

    // Wait for recording phase & verify silent worklet routing (audibleFile=false)
    await expect(exportDetails).toHaveAttribute('data-export-phase', 'recording', { timeout: 10_000 });

    await page.waitForTimeout(2600);
    const midState = await page.evaluate(() => {
      const c = document.querySelector('canvas');
      return {
        audibleFile: c?.dataset.audibleFile,
        sourceType: c?.dataset.sourceType,
        realWorklet: c?.dataset.realWorklet,
        simFrames: Number(c?.dataset.simFrames || '0'),
        particleSteps: Number(c?.dataset.particleSteps || '0'),
        isSilent: c?.dataset.isSilent,
      };
    });
    expect(midState.audibleFile).toBe('false');
    expect(midState.sourceType).toBe('file');
    expect(midState.realWorklet).toBe('true');
    expect(midState.simFrames).toBeGreaterThan(10000);
    expect(midState.particleSteps).toBeGreaterThan(10);

    // Wait for full 15s WAV simulation & OPFS finalization
    await expect(exportDetails).toHaveAttribute('data-export-phase', 'ready', { timeout: 35_000 });

    const ext = await exportDetails.getAttribute('data-export-ext');
    const codec = await exportDetails.getAttribute('data-export-codec');
    const audioTracks = await exportDetails.getAttribute('data-export-audio-tracks');
    const bytesWritten = Number((await exportDetails.getAttribute('data-export-bytes')) || '0');

    expect(ext === 'mp4' || ext === 'webm').toBe(true);
    expect(codec?.includes(ext!)).toBe(true);
    expect(audioTracks).toBe('0');
    expect(bytesWritten).toBeGreaterThan(40_000);
    await expect(exportDetails).toContainText('0 audio tracks');

    // Verify OPFS actually contains the completed exported file, and it decodes cleanly at 480x480
    const videoCheck = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const files: { name: string; file: File }[] = [];
      for await (const [name, handle] of (root as unknown as {
        entries(): AsyncIterable<[string, FileSystemHandle]>;
      }).entries()) {
        if (handle.kind === 'file' && name.startsWith('chladni-export-')) {
          const fh = handle as FileSystemFileHandle;
          files.push({ name, file: await fh.getFile() });
        }
      }
      if (files.length === 0) {
        return { found: false };
      }
      const target = files[files.length - 1];
      const url = URL.createObjectURL(target.file);
      const vid = document.createElement('video');
      vid.muted = true;
      vid.playsInline = true;
      vid.src = url;
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('Video metadata load timeout')), 8000);
        vid.onloadeddata = () => {
          clearTimeout(t);
          resolve();
        };
        vid.onerror = () => {
          clearTimeout(t);
          reject(new Error('Video element failed to decode exported OPFS file'));
        };
      });
      const width = vid.videoWidth;
      const height = vid.videoHeight;
      const duration = vid.duration;
      URL.revokeObjectURL(url);
      return {
        found: true,
        name: target.name,
        size: target.file.size,
        width,
        height,
        duration,
      };
    });

    expect(videoCheck.found).toBe(true);
    expect(videoCheck.size).toBe(bytesWritten);
    expect(videoCheck.width).toBe(480);
    expect(videoCheck.height).toBe(480);
    if (Number.isFinite(videoCheck.duration)) {
      expect(videoCheck.duration).toBeGreaterThan(10.0);
    }

    // Discard removes OPFS file cleanly and resets panel
    await page.getByRole('button', { name: 'Discard' }).click();
    await expect(exportDetails).toHaveAttribute('data-export-phase', 'idle');

    const remainingOpfs = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      let count = 0;
      for await (const [name] of (root as unknown as {
        entries(): AsyncIterable<[string, FileSystemHandle]>;
      }).entries()) {
        if (name.startsWith('chladni-export-')) count++;
      }
      return count;
    });
    expect(remainingOpfs).toBe(0);
    expect(consoleErrors).toEqual([]);
  });

  test('2. Cancelling active silent export cleans up OPFS file and halts stream cleanly', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');

    const exportDetails = page.getByTestId('silent-video-export');
    await exportDetails.locator('summary').click();
    await page.getByTestId('silent-wav-file-input').setInputFiles(wav15sPath);

    await expect(exportDetails).toHaveAttribute('data-export-phase', 'recording', { timeout: 10_000 });
    await page.waitForTimeout(1000);

    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(exportDetails).toHaveAttribute('data-export-phase', 'cancelled', { timeout: 5_000 });

    const remainingOpfs = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      let count = 0;
      for await (const [name] of (root as unknown as {
        entries(): AsyncIterable<[string, FileSystemHandle]>;
      }).entries()) {
        if (name.startsWith('chladni-export-')) count++;
      }
      return count;
    });
    expect(remainingOpfs).toBe(0);
  });

  test('3. Suspended AudioContext after file picker never hangs in validating state and recovers cleanly via Start Silent Export', async ({
    page,
  }) => {
    // Inject wrapper mimicking iOS Safari / iframe AudioContext staying suspended until direct button click
    await page.addInitScript(() => {
      const OrigAC = window.AudioContext;
      let allowResume = false;
      (window as unknown as { __unlockAudio?: () => void }).__unlockAudio = () => {
        allowResume = true;
      };
      class GatedAudioContext extends OrigAC {
        private _fakeSuspended = true;
        override get state(): AudioContextState {
          return this._fakeSuspended && !allowResume ? 'suspended' : super.state;
        }
        override resume(): Promise<void> {
          if (!allowResume) {
            return new Promise<void>(() => {}); // Simulate non-resolving resume outside fresh tap
          }
          this._fakeSuspended = false;
          return super.resume();
        }
      }
      window.AudioContext = GatedAudioContext as unknown as typeof AudioContext;
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');

    const exportDetails = page.getByTestId('silent-video-export');
    await exportDetails.locator('summary').click();
    await page.getByTestId('silent-wav-file-input').setInputFiles(wav15sPath);

    // Must settle quickly into error/pending state with "Start Silent Export" button (not stuck validating!)
    const startBtn = page.getByRole('button', { name: 'Start Silent Export' });
    await expect(startBtn).toBeVisible({ timeout: 5000 });
    await expect(exportDetails).toHaveAttribute('data-export-phase', 'error');

    // Now simulate direct user tap unlocking AudioContext and starting export without re-picking the file
    await page.evaluate(() => {
      (window as unknown as { __unlockAudio?: () => void }).__unlockAudio?.();
    });
    await startBtn.click();
    await expect(exportDetails).toHaveAttribute('data-export-phase', 'recording', { timeout: 10_000 });

    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(exportDetails).toHaveAttribute('data-export-phase', 'cancelled', { timeout: 5000 });
  });

  test('4. Resonance 269.815 Hz silent export renders live moving particles on PlateCanvas and produces non-static decoded video frames', async ({
    page,
  }) => {
    test.setTimeout(75_000);
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(String(err)));

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');

    const exportDetails = page.getByTestId('silent-video-export');
    await exportDetails.locator('summary').click();
    await page.getByTestId('silent-wav-file-input').setInputFiles(wav11sResonancePath);

    await expect(exportDetails).toHaveAttribute('data-export-phase', 'recording', { timeout: 10_000 });

    // Helper installed in page to capture a 480x480 snapshot + telemetry of PlateCanvas
    await page.evaluate(() => {
      const cap = (label: string) => {
        const src = document.querySelector('[data-testid="chladni-plate-canvas"]') as HTMLCanvasElement | null;
        if (!src) throw new Error('PlateCanvas not found');
        const c = document.createElement('canvas');
        c.width = 480;
        c.height = 480;
        const ctx = c.getContext('2d');
        if (!ctx) throw new Error('2D context unavailable');
        ctx.drawImage(src, 0, 0, 480, 480);
        const img = ctx.getImageData(0, 0, 480, 480).data;
        const store = ((window as unknown as { __e2eCaps?: Record<string, Uint8ClampedArray> }).__e2eCaps ??= {});
        store[label] = img;
        return {
          simFrames: Number(src.dataset.simFrames || '0'),
          particleSteps: Number(src.dataset.particleSteps || '0'),
          particleCount: Number(src.dataset.particleCount || '0'),
          interiorParticles: Number(src.dataset.interiorParticles || '0'),
        };
      };
      (window as unknown as { __capturePlate?: typeof cap }).__capturePlate = cap;
    });

    await page.waitForTimeout(600);
    const liveEarly = await page.evaluate(() => {
      return (window as unknown as { __capturePlate: (l: string) => { simFrames: number; particleSteps: number; particleCount: number; interiorParticles: number } }).__capturePlate('early');
    });

    await page.waitForTimeout(6000);
    const liveLate = await page.evaluate(() => {
      return (window as unknown as { __capturePlate: (l: string) => { simFrames: number; particleSteps: number; particleCount: number; interiorParticles: number } }).__capturePlate('late');
    });

    const liveCanvasDiff = await page.evaluate(() => {
      const store = (window as unknown as { __e2eCaps: Record<string, Uint8ClampedArray> }).__e2eCaps;
      const a = store.early;
      const b = store.late;
      let changedPixels = 0;
      let totalAbsRgbDiff = 0;
      for (let i = 0; i < a.length; i += 4) {
        const diff = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
        totalAbsRgbDiff += diff;
        if (diff > 18) changedPixels++;
      }
      return {
        changedPixels,
        totalAbsRgbDiff,
        meanAbsRgbDiff: Number((totalAbsRgbDiff / (480 * 480)).toFixed(3)),
      };
    });

    expect(liveLate.simFrames).toBeGreaterThan(liveEarly.simFrames + 100_000);
    expect(liveLate.particleSteps).toBeGreaterThan(liveEarly.particleSteps + 150);
    expect(liveCanvasDiff.changedPixels).toBeGreaterThan(2000);
    expect(liveCanvasDiff.totalAbsRgbDiff).toBeGreaterThan(100_000);

    // Wait for full 11s export to finalize in OPFS
    await expect(exportDetails).toHaveAttribute('data-export-phase', 'ready', { timeout: 35_000 });

    // Load exported video file from OPFS and decode separated frames at t = 0.25s, 3.5s, 7.0s
    const decodedDiff = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const files: { name: string; file: File }[] = [];
      for await (const [name, handle] of (root as unknown as {
        entries(): AsyncIterable<[string, FileSystemHandle]>;
      }).entries()) {
        if (handle.kind === 'file' && name.startsWith('chladni-export-')) {
          files.push({ name, file: await (handle as FileSystemFileHandle).getFile() });
        }
      }
      if (files.length === 0) throw new Error('No exported video found in OPFS');
      const target = files[files.length - 1];
      const url = URL.createObjectURL(target.file);

      const vid = document.createElement('video');
      vid.muted = true;
      vid.playsInline = true;
      vid.preload = 'auto';
      vid.src = url;

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Video load timeout')), 8000);
        vid.onloadeddata = () => {
          clearTimeout(timer);
          resolve();
        };
        vid.onerror = () => {
          clearTimeout(timer);
          reject(new Error('Video decode error'));
        };
      });

      const canvas = document.createElement('canvas');
      canvas.width = 480;
      canvas.height = 480;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('2D context unavailable');

      const grabFrame = (): Uint8ClampedArray => {
        ctx.drawImage(vid, 0, 0, 480, 480);
        return new Uint8ClampedArray(ctx.getImageData(0, 0, 480, 480).data);
      };

      const seekTo = async (sec: number): Promise<boolean> => {
        return await new Promise<boolean>((resolve) => {
          let done = false;
          const finish = (ok: boolean) => {
            if (!done) {
              done = true;
              vid.removeEventListener('seeked', onSeeked);
              resolve(ok);
            }
          };
          const timer = setTimeout(() => finish(false), 2500);
          const onSeeked = () => {
            clearTimeout(timer);
            requestAnimationFrame(() => setTimeout(() => finish(true), 60));
          };
          vid.addEventListener('seeked', onSeeked);
          vid.currentTime = sec;
        });
      };

      const targets = [0.25, 3.5, 7.0];
      const frames: Uint8ClampedArray[] = [];
      const actualTimes: number[] = [];

      // Try seeking first; if WebM lacks seek cues or time stalls, fall back to accelerated playback sampling
      let seekWorked = true;
      for (const t of targets) {
        const ok = await seekTo(t);
        if (!ok || Math.abs(vid.currentTime - t) > 1.2) {
          seekWorked = false;
          break;
        }
        actualTimes.push(Number(vid.currentTime.toFixed(3)));
        frames.push(grabFrame());
      }

      if (!seekWorked) {
        frames.length = 0;
        actualTimes.length = 0;
        vid.currentTime = 0;
        vid.playbackRate = 4.0;
        await vid.play();
        for (const t of targets) {
          await new Promise<void>((resolve) => {
            const poll = setInterval(() => {
              if (vid.currentTime >= t || vid.ended) {
                clearInterval(poll);
                resolve();
              }
            }, 30);
          });
          actualTimes.push(Number(vid.currentTime.toFixed(3)));
          frames.push(grabFrame());
        }
        vid.pause();
      }

      const diffFrames = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
        let changedPixels = 0;
        let totalAbsRgbDiff = 0;
        for (let i = 0; i < a.length; i += 4) {
          const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
          totalAbsRgbDiff += d;
          if (d > 18) changedPixels++;
        }
        return {
          changedPixels,
          totalAbsRgbDiff,
          meanAbsRgbDiff: Number((totalAbsRgbDiff / (480 * 480)).toFixed(3)),
        };
      };

      const earlyVsMid = diffFrames(frames[0], frames[1]);
      const earlyVsLate = diffFrames(frames[0], frames[2]);
      const midVsLate = diffFrames(frames[1], frames[2]);

      const width = vid.videoWidth;
      const height = vid.videoHeight;
      URL.revokeObjectURL(url);

      return {
        fileName: target.name,
        sizeBytes: target.file.size,
        width,
        height,
        seekWorked,
        actualTimes,
        earlyVsMid,
        earlyVsLate,
        midVsLate,
      };
    });

    console.log(
      '[E2E Test 4 Telemetry]',
      JSON.stringify({ liveEarly, liveLate, liveCanvasDiff, decodedDiff })
    );

    expect(decodedDiff.width).toBe(480);
    expect(decodedDiff.height).toBe(480);
    expect(decodedDiff.earlyVsMid.changedPixels).toBeGreaterThan(2000);
    expect(decodedDiff.earlyVsMid.totalAbsRgbDiff).toBeGreaterThan(100_000);
    expect(decodedDiff.earlyVsLate.changedPixels).toBeGreaterThan(2000);
    expect(decodedDiff.earlyVsLate.totalAbsRgbDiff).toBeGreaterThan(100_000);

    // Clean up OPFS file
    await page.getByRole('button', { name: 'Discard' }).click();
    await expect(exportDetails).toHaveAttribute('data-export-phase', 'idle');
    expect(consoleErrors).toEqual([]);
  });
});
