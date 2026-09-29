import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  timeout: 60000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:43717',
    viewport: { width: 1280, height: 720 },
    channel: 'chrome',
    launchOptions: {
      args: ['--enable-webgl', '--use-angle=gl', '--disable-gpu-sandbox'],
    },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  reporter: [['list'], ['html', { open: 'never' }]],
  outputDir: 'output/playwright/results',
  webServer: {
    command: 'pnpm exec node scripts/browser-server.mjs',
    url: 'http://127.0.0.1:43717',
    reuseExistingServer: false,
    timeout: 20000,
  },
});
