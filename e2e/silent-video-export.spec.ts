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

test.describe('Memory-Bounded Silent WAV-to-Video Export E2E', () => {
  const fixtureDir = path.resolve('.playwright-cli/e2e-fixtures');
  const wav15sPath = path.join(fixtureDir, 'evolving-15s-stereo.wav');
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
});
