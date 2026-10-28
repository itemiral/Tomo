import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testIgnore: "**/ui-foundation/**",
  workers: 1,
  timeout: 30000,
  use: { baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3200", channel: "chrome", ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } } : {}), viewport: { width: 1440, height: 900 }, screenshot: "only-on-failure", trace: "retain-on-failure" },
});
