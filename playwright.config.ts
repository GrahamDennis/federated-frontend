import {defineConfig, devices} from '@playwright/test';

/**
 * E2E tests for the federated-frontend prototype. They drive the real host chrome
 * and exercise the cross-origin plugin channels (capability RPC + remote-dom).
 *
 * `webServer` boots both dev servers (host :5173, plugin :5174) automatically, so
 * `npm test` is self-contained. We drive the locally installed Google Chrome via
 * the `chrome` channel, so no Playwright browser download is required.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['html', {open: 'never'}]] : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chrome',
      use: {...devices['Desktop Chrome'], channel: 'chrome'},
    },
  ],
  webServer: [
    {
      command: 'npm run dev:host',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'npm run dev:plugin',
      url: 'http://localhost:5174',
      reuseExistingServer: !process.env.CI,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
