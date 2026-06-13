import {
  test as base,
  expect,
  type Page,
  type FrameLocator,
} from '@playwright/test';

/**
 * Every test starts from a host chrome where the example plugin has already
 * connected. The contributed toolbar section only renders once the plugin has
 * completed the `@quilted/threads` handshake and streamed its remote-dom tree
 * across the origin boundary, so waiting for it doubles as a "fully connected"
 * gate.
 */
export const test = base.extend<{connectedPage: Page}>({
  connectedPage: async ({page}, use) => {
    await page.goto('/');
    await expect(
      page.locator('.nav .toolbar-section button', {hasText: 'Open details'}),
    ).toBeVisible();
    await use(page);
  },
});

export {expect};

/** The example plugin's sandboxed cross-origin iframe (served from :5174). */
export function pluginFrame(page: Page): FrameLocator {
  return page.frameLocator('iframe[title="example-notes"]');
}
