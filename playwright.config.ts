import { defineConfig } from "@playwright/test";

/**
 * Three full projects exercise every functional and accessibility flow.
 * Every other device runs only the responsive layout spec (and, for the four
 * review devices, the screenshot pass), so the matrix stays fast.
 */
const LAYOUT_ONLY = /responsive\.spec\.ts/;
const LAYOUT_AND_SHOTS = /responsive\.spec\.ts|screenshots\.spec\.ts/;

export default defineConfig({
  testDir: "./e2e",
  timeout: 40_000,
  expect: { timeout: 7_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:4173",
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "iphone-15-pro",
      use: {
        viewport: { width: 393, height: 852 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "ipad",
      use: {
        viewport: { width: 820, height: 1180 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "webkit-iphone-15-pro",
      use: {
        browserName: "webkit",
        viewport: { width: 393, height: 852 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "desktop",
      use: {
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
        isMobile: false,
        hasTouch: false,
      },
    },
    {
      name: "iphone-se",
      testMatch: LAYOUT_AND_SHOTS,
      use: {
        viewport: { width: 375, height: 667 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "iphone-15-pro-max",
      testMatch: LAYOUT_ONLY,
      use: {
        viewport: { width: 430, height: 932 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "galaxy-s24",
      testMatch: LAYOUT_ONLY,
      use: {
        viewport: { width: 360, height: 780 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "iphone-15-pro-landscape",
      testMatch: LAYOUT_ONLY,
      use: {
        viewport: { width: 852, height: 393 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "ipad-mini",
      testMatch: LAYOUT_AND_SHOTS,
      use: {
        viewport: { width: 768, height: 1024 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "ipad-landscape",
      testMatch: LAYOUT_ONLY,
      use: {
        viewport: { width: 1024, height: 768 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "laptop-1280",
      testMatch: LAYOUT_ONLY,
      use: {
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 1,
        isMobile: false,
        hasTouch: false,
      },
    },
    {
      name: "wide-1920",
      testMatch: LAYOUT_ONLY,
      use: {
        viewport: { width: 1920, height: 1080 },
        deviceScaleFactor: 1,
        isMobile: false,
        hasTouch: false,
      },
    },
    {
      name: "short-height",
      testMatch: LAYOUT_ONLY,
      use: {
        viewport: { width: 740, height: 360 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: {
    command: "npm run dev -- --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
