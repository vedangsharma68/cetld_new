import {defineConfig} from '@playwright/test';
export default defineConfig({
  testDir:'tests/browser',timeout:60000,workers:1,
  use:{browserName:'chromium',headless:true,launchOptions:{...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{}),args:['--no-sandbox']},reducedMotion:'reduce',screenshot:'only-on-failure',trace:'retain-on-failure'},
});
