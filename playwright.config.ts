import { defineConfig, devices } from '@playwright/test';

const webPort = Number(process.env.WEB_PORT ?? '5173');

// E2E tests exercise the application UI only. They NEVER run destructive
// operations against a real Tableau Cloud site — the backend is expected to run
// in a mocked / test configuration.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${webPort}`,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Serve the SPA (Vite dev server) for UI-only, non-destructive E2E. No backend
  // is required: these tests assert client rendering and validation, never live
  // Tableau operations.
  webServer: {
    command: `npx vite --port ${webPort} --strictPort`,
    url: `http://localhost:${webPort}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
