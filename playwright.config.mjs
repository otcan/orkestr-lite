import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [["line"]],
  use: {
    headless: true,
    trace: "retain-on-failure",
    launchOptions: process.env.ORKESTR_PLAYWRIGHT_EXECUTABLE_PATH
      ? {
          executablePath: process.env.ORKESTR_PLAYWRIGHT_EXECUTABLE_PATH,
          args: ["--no-sandbox", "--disable-dev-shm-usage"],
        }
      : {},
  },
});
