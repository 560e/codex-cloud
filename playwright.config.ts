import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: 'http://127.0.0.1:18479',
    browserName: 'chromium',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npx tsx tests/fixture-server.ts',
    url: 'http://127.0.0.1:18479/api/auth/status',
    reuseExistingServer: false,
    env: {
      WORKBENCH_TEST_FIXTURE: '1',
      PORT: '18479',
      PUBLIC_ORIGIN: 'http://127.0.0.1:18479',
      COOKIE_SECURE: 'false',
      DATA_DIR: '.test-data/e2e',
    },
  },
});
