import { defineConfig } from '@playwright/test';
const software = Boolean(process.env.CI || process.env.TRAVEL_TEST_SOFTWARE_GL);
export default defineConfig({
  testDir: './tests/browser',
  timeout: 60000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:43717',
    viewport: { width: 1280, height: 720 },
    channel: software ? undefined : 'chrome',
    launchOptions: {
      args: software
        ? [
            '--enable-webgl',
            '--use-angle=swiftshader',
            '--enable-unsafe-swiftshader',
          ]
        : ['--enable-webgl', '--use-angle=gl', '--disable-gpu-sandbox'],
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
