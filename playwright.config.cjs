module.exports = {
  testDir: './browser',
  testMatch: '**/smoke.cjs',
  timeout: 60000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4318',
    browserName: 'chromium',
    viewport: { width: 1100, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  },
  webServer: {
    command: 'bun browser/server.js',
    url: 'http://127.0.0.1:4318',
    reuseExistingServer: false,
    timeout: 15000
  }
}
