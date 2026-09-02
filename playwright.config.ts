import {defineConfig, devices} from '@playwright/test';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const backendDataFile = join(tmpdir(), `fieldnote-playwright-${process.pid}.json`);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 2 : 0,
  reporter: process.env['CI'] ? [['github'], ['html', {open: 'never'}]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {...devices['Desktop Chrome'], ...(process.env['CI'] ? {} : {channel: 'chrome'})},
    },
  ],
  webServer: [
    {
      command: 'npm run server:start',
      url: 'http://127.0.0.1:8787/healthz',
      env: {
        FIELDNOTE_BUILD_VERSION: 'playwright-e2e',
        FIELDNOTE_CORS_ORIGINS: 'http://127.0.0.1:4173',
        FIELDNOTE_DATA_FILE: backendDataFile,
        FIELDNOTE_HOST: '127.0.0.1',
        FIELDNOTE_PORT: '8787',
      },
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
    },
    {
      command: 'npm run preview',
      url: 'http://127.0.0.1:4173/inspections',
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
    },
  ],
});
