import {expect, type Frame, type Page} from '@playwright/test';
import {test} from './fixtures';
import {
  DEFAULT_VIEWS,
  addSlot,
  assignBlock,
  newBlockId,
  canPlace,
  growRect,
  placeSlot,
  resizeGrid,
  resolveSlots,
} from '../packages/host/src/layout';

const slot = (page: Page, id: string) => page.locator(`.slot[data-slot="${id}"]`);
const pane = (page: Page, appId: string) =>
  page.locator('.pane', {has: page.locator(`iframe[title="${appId}"]`)});

async function frameFor(page: Page, appId: string): Promise<Frame> {
  const handle = await page.locator(`iframe[title="${appId}"]`).elementHandle();
  return (await handle!.contentFrame())!;
}

/** Tag an iframe's window so we can prove it was never reloaded. */
async function markFrame(page: Page, appId: string) {
  await (await frameFor(page, appId)).evaluate(() => {
    (window as unknown as {__mark: number}).__mark = 42;
  });
}
async function expectSameFrame(page: Page, appId: string) {
  const mark = await (await frameFor(page, appId)).evaluate(
    () => (window as unknown as {__mark?: number}).__mark,
  );
  expect(mark).toBe(42);
}

test.describe('layout model (pure)', () => {
  const quad = DEFAULT_VIEWS.find((v) => v.id === 'quad')!;

  test('slots cannot overlap or leave the grid', () => {
    expect(canPlace(quad, {col: 1, row: 1, colSpan: 1, rowSpan: 1}, 's4')).toBe(true);
    expect(canPlace(quad, {col: 0, row: 0, colSpan: 2, rowSpan: 1}, 's1')).toBe(false);
    expect(canPlace(quad, {col: 1, row: 1, colSpan: 2, rowSpan: 1}, 's4')).toBe(false);
    expect(placeSlot(quad, 's1', {col: 1, row: 1, colSpan: 1, rowSpan: 1})).toBe(quad);
  });

  test('assigning an app already in another slot swaps them', () => {
    const next = assignBlock(quad, 's1', 'places');
    expect(next.slots.find((s) => s.id === 's1')!.blockId).toBe('places');
    expect(next.slots.find((s) => s.id === 's2')!.blockId).toBe('world-map');
  });

  test('enlarging covers the neighbour; growth is bounded by the grid', () => {
    const rect = growRect(quad, quad.slots[0], 'right')!;
    const resolved = resolveSlots(quad, {slotId: 's1', rect});
    expect(resolved.map((r) => r.covered)).toEqual([false, true, false, false]);
    expect(growRect(quad, quad.slots[0], 'left')).toBeNull();
  });

  test('new block ids never collide', () => {
    expect(newBlockId('world-map', ['world-map', 'world-map~2'])).toBe('world-map~3');
  });

  test('adding slots and shrinking the grid', () => {
    const empty = {...quad, slots: []};
    const one = addSlot(empty, {col: 0, row: 0, colSpan: 2, rowSpan: 1});
    expect(one.slots).toHaveLength(1);
    expect(addSlot(one, {col: 1, row: 0, colSpan: 1, rowSpan: 1})).toBe(one);
    expect(resizeGrid(one, 1, 2).slots).toHaveLength(0);
  });
});

test.describe('layout mode', () => {
  test.beforeEach(async ({connectedPage: page}) => {
    await page.evaluate(() => localStorage.clear());
    await page.getByRole('button', {name: 'Layouts', exact: true}).click();
    await expect(page.locator('.panes.layout-grid')).toBeVisible();
  });

  test('shows the default view: several apps at once, one per slot', async ({
    connectedPage: page,
  }) => {
    await expect(page).toHaveURL(/mode=layout/);
    await expect(page.locator('.app-rail')).toBeHidden();
    for (const id of ['world-map', 'places', 'example-notes']) {
      await expect(page.locator(`iframe[title="${id}"]`)).toBeVisible();
    }
    // The map spans 2×2 of the 3×2 grid.
    const map = await pane(page, 'world-map').boundingBox();
    const places = await pane(page, 'places').boundingBox();
    expect(map!.width).toBeGreaterThan(places!.width * 1.5);
    expect(map!.height).toBeGreaterThan(places!.height * 1.5);
  });

  test('shared context still composes apps across slots', async ({
    connectedPage: page,
  }) => {
    const map = page.frameLocator('iframe[title="world-map"]');
    const places = page.frameLocator('iframe[title="places"]');
    await map.getByRole('button', {name: 'Tokyo'}).click();
    await expect(places.locator('.place-detail h2')).toHaveText('Tokyo');
  });

  test('swapping a slot’s app swaps places without reloading iframes', async ({
    connectedPage: page,
  }) => {
    await markFrame(page, 'world-map');
    await markFrame(page, 'places');
    await page.getByLabel('Block in slot s2').selectOption('world-map');

    await expect(page.getByLabel('Block in slot s1')).toHaveValue('places');
    const map = await pane(page, 'world-map').boundingBox();
    const places = await pane(page, 'places').boundingBox();
    expect(places!.width).toBeGreaterThan(map!.width * 1.5);
    await expectSameFrame(page, 'world-map');
    await expectSameFrame(page, 'places');

    // Ad-hoc changes are resettable back to the saved view.
    await page.getByRole('button', {name: 'Reset view'}).click();
    await expect(page.getByLabel('Block in slot s1')).toHaveValue('world-map');
  });

  test('maximize takes over the grid; restore brings the others back', async ({
    connectedPage: page,
  }) => {
    await page.getByRole('button', {name: 'Maximize slot s2'}).click();
    await expect(slot(page, 's1')).toBeHidden();
    await expect(pane(page, 'world-map')).toBeHidden();
    const stage = await page.locator('.stage').boundingBox();
    const places = await pane(page, 'places').boundingBox();
    expect(places!.width).toBeGreaterThan(stage!.width * 0.95);

    await page.getByRole('button', {name: 'Restore slot s2'}).first().click();
    await expect(pane(page, 'world-map')).toBeVisible();
  });

  test('expanding into a neighbouring slot covers it', async ({
    connectedPage: page,
  }) => {
    await markFrame(page, 'example-notes');
    await page.getByRole('button', {name: 'Enlarge slot s3'}).click();
    await expect(page.getByRole('menuitem', {name: /Expand right/})).toBeDisabled();
    await page.getByRole('menuitem', {name: /Expand up/}).click();

    await expect(slot(page, 's2')).toBeHidden();
    await expect(pane(page, 'places')).toBeHidden();
    await expect(pane(page, 'example-notes')).toBeVisible();
    await expectSameFrame(page, 'example-notes');
  });

  test('switching views via the drop-down, and deep-linking a view', async ({
    connectedPage: page,
  }) => {
    await page.getByLabel('Layout view').selectOption('quad');
    await expect(page).toHaveURL(/view=quad/);
    await expect(page.locator('.slot')).toHaveCount(4);
    await expect(slot(page, 's4').locator('.slot-empty')).toBeVisible();

    await page.goto('/?mode=layout&view=portals');
    await expect(page.getByLabel('Layout view')).toHaveValue('portals');
    await expect(page.locator('.slot')).toHaveCount(4);
  });

  test('edit mode: add, move, resize and save a view', async ({
    connectedPage: page,
  }) => {
    await page.getByRole('button', {name: /Edit layouts/}).click();
    await page.getByRole('button', {name: 'New', exact: true}).click();
    await page.getByLabel('View name').fill('Test view');

    // New views are a blank 3×2 grid: add a slot at the top-left cell.
    await expect(page.locator('.empty-cell')).toHaveCount(6);
    await page.getByLabel('Add slot at column 1, row 1').click();
    await expect(page.locator('.slot-edit')).toHaveCount(1);
    await page.getByLabel('Block for slot s1').selectOption('world-map');

    // Drag the slot one cell right.
    const box = (await page.locator('.slot-edit').boundingBox())!;
    const stage = (await page.locator('.slot-layer').boundingBox())!;
    const cellW = stage.width / 3;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + cellW, box.y + box.height / 2, {steps: 5});
    await page.mouse.up();
    await expect(page.getByLabel('Add slot at column 1, row 1')).toBeVisible();
    await expect(page.getByLabel('Add slot at column 2, row 1')).toHaveCount(0);

    // Resize it to 2×2 via the corner handle.
    const handle = (await page.getByLabel('Resize slot s1').boundingBox())!;
    await page.mouse.move(handle.x + 4, handle.y + 4);
    await page.mouse.down();
    await page.mouse.move(handle.x + cellW, handle.y + stage.height / 2, {steps: 5});
    await page.mouse.up();
    await expect(page.locator('.slot-size')).toHaveText('2×2');

    await page.getByRole('button', {name: 'Save view'}).click();
    await expect(page.getByLabel('Layout view')).toHaveValue(/^view-/);
    await expect(pane(page, 'world-map')).toBeVisible();

    // Saved views persist across reloads.
    await page.reload();
    await expect(page.getByLabel('Layout view')).toContainText('Test view');
  });
});
