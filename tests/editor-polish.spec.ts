import {expect, type Page} from '@playwright/test';
import {test} from './fixtures';

/**
 * Editor polish: keyboard move/resize of slots, drawing a slot by dragging
 * across empty cells, and the cap on how many hidden plugins stay running.
 */
async function blankView(page: Page) {
  await page.goto('/?mode=layout');
  await expect(page.locator('.source-badge.service')).toBeVisible();
  await page.getByRole('button', {name: /Edit layouts/}).click();
  await page.getByRole('button', {name: 'New', exact: true}).click();
  await expect(page.locator('.empty-cell')).toHaveCount(6); // a blank 3×2 grid
}

const announcement = (page: Page) => page.getByRole('status', {name: 'Layout editor'});

test.describe('editor polish', () => {
  test('slots can be moved, resized and removed from the keyboard', async ({connectedPage: page}) => {
    await blankView(page);
    await page.getByLabel('Add slot at column 1, row 1').click();
    const box = page.getByRole('group', {name: /^Slot s1:/});
    await expect(box).toHaveAttribute('aria-label', 'Slot s1: empty, 1×1 at column 1, row 1');
    await box.focus();

    await page.keyboard.press('ArrowRight');
    await expect(box).toHaveAttribute('aria-label', /1×1 at column 2, row 1/);
    await expect(announcement(page)).toHaveText('Slot s1: 1×1 at column 2, row 1.');

    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Shift+ArrowDown');
    await expect(box).toHaveAttribute('aria-label', /2×2 at column 2, row 1/);

    // Off the edge of the grid: refused and announced.
    await page.keyboard.press('ArrowRight');
    await expect(announcement(page)).toHaveText('Can’t move there.');
    await expect(box).toHaveAttribute('aria-label', /2×2 at column 2, row 1/);

    await page.keyboard.press('Delete');
    await expect(page.getByRole('group', {name: /^Slot s1:/})).toHaveCount(0);
    await expect(page.locator('.empty-cell')).toHaveCount(6);
  });

  test('dragging across empty cells draws a slot of that size', async ({connectedPage: page}) => {
    await blankView(page);
    const from = (await page.getByLabel('Add slot at column 1, row 1').boundingBox())!;
    const to = (await page.getByLabel('Add slot at column 2, row 2').boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {steps: 6});
    await expect(page.locator('.slot-ghost:not(.invalid)')).toBeVisible();
    await page.mouse.up();

    await expect(page.getByRole('group', {name: /^Slot s1:/})).toHaveAttribute(
      'aria-label',
      'Slot s1: empty, 2×2 at column 1, row 1',
    );
    await expect(page.locator('.empty-cell')).toHaveCount(2);
    // A plain click still adds a single cell.
    await page.getByLabel('Add slot at column 3, row 1').click();
    await expect(page.getByRole('group', {name: /^Slot s2:/})).toHaveAttribute(
      'aria-label',
      /1×1 at column 3, row 1/,
    );

    // Dragging over an occupied cell is refused.
    const a = (await page.getByLabel('Add slot at column 3, row 2').boundingBox())!;
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2, {steps: 6});
    await expect(page.locator('.slot-ghost.invalid')).toBeVisible();
    await page.mouse.up();
    await expect(page.getByRole('group', {name: /^Slot s3:/})).toHaveCount(0);
  });

  test('only a capped number of hidden plugins keep running', async ({page}) => {
    await page.addInitScript(() => localStorage.setItem('ff.keepAliveHidden', '1'));
    await page.goto('/');
    await expect(page.locator('iframe[title="example-notes"]')).toBeAttached();
    const rail = (name: string) => page.locator('.app-rail-item', {hasText: name});

    await rail('World Map').click();
    // One hidden plugin is allowed: Notes keeps running.
    await expect(page.locator('iframe[title="example-notes"]')).toBeAttached();
    await expect(rail('Example Notes')).toContainText('running');

    await rail('City histogram').click();
    // Now the map is the most recently seen hidden one; Notes is unmounted.
    await expect(page.locator('iframe[title="world-map"]')).toBeAttached();
    await expect(page.locator('iframe[title="example-notes"]')).toHaveCount(0);
    await expect(rail('Example Notes')).not.toContainText('running');
    await expect(rail('World Map')).toContainText('running');

    // Coming back remounts it.
    await rail('Example Notes').click();
    await expect(page.frameLocator('iframe[title="example-notes"]').locator('body')).toContainText(
      'Example Notes',
    );
  });
});
