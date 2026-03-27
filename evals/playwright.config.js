const { defineConfig } = require("@playwright/test");
const baseConfig = require("../playwright.config.js");

module.exports = defineConfig({
  ...baseConfig,
  testDir: "./runs",
  webServer: {
    command: "bun run serve",
    url: "http://127.0.0.1:8080",
    reuseExistingServer: true,
    timeout: 30000,
    cwd: "..",
  },
});
