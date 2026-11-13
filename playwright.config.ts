import { defineConfig } from '@playwright/test';
import fs from 'node:fs';

const containerChromium = '/ms-playwright/chrome-headless-shell-linux64/chrome-headless-shell';
const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_PATH ||
  (fs.existsSync(containerChromium) ? containerChromium : undefined);

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    headless: true,
    launchOptions: {
      ...(executablePath ? { executablePath } : {}),
      args: [
        '--autoplay-policy=no-user-gesture-required',
        '--enable-precise-memory-info',
        '--js-flags=--expose-gc',
      ],
    },
  },
  webServer: {
    command: 'npx vite preview --port 4173 --host 127.0.0.1 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
