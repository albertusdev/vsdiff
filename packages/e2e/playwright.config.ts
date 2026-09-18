import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 120_000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3111',
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: 'node ../../scripts/web.mjs run',
    url: 'http://localhost:3111',
    reuseExistingServer: true,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
