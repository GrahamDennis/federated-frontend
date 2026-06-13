import {test, expect, pluginFrame} from './fixtures';

/**
 * Global host shortcuts must work even when a plugin iframe has focus. A
 * cross-origin iframe is a hard boundary, so the host can't observe these
 * keystrokes itself — cooperating plugins forward chord shortcuts + Escape over
 * the thread (see `forwardKeyboardShortcuts`).
 */
test.describe('forwarded keyboard shortcuts', () => {
  test('⌘K opens the host palette while a plugin iframe is focused', async ({
    connectedPage: page,
  }) => {
    // Move focus into the (cross-origin) plugin iframe without triggering an action.
    await pluginFrame(page).getByRole('button', {name: 'Open the modal'}).focus();

    await page.keyboard.press('Meta+k');
    await expect(page.locator('.palette')).toBeVisible();
  });

  test('Escape forwarded from a focused iframe closes the palette', async ({
    connectedPage: page,
  }) => {
    await page.locator('.cmdk-button').click();
    await expect(page.locator('.palette')).toBeVisible();

    // The palette input took focus in the host; put focus back into the iframe
    // and forward Escape from there.
    await pluginFrame(page).getByRole('button', {name: 'Open the modal'}).focus();
    await page.keyboard.press('Escape');
    await expect(page.locator('.palette')).toHaveCount(0);
  });
});
