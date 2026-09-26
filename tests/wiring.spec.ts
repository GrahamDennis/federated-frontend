import {expect, type Page} from '@playwright/test';
import {test} from './fixtures';
import {DEFAULT_VIEWS, resolveInputs, setBinding} from '../packages/host/src/layout';

/**
 * Wiring: blocks declare typed inputs/outputs; a view binds outputs to inputs
 * and the host routes values between the (cross-origin, isolated) iframes.
 */
const frame = (page: Page, instanceId: string) =>
  page.frameLocator(`iframe[title="${instanceId}"]`);
const histogram = (page: Page) => frame(page, 'histogram');
const places = (page: Page) => frame(page, 'places');

test.describe('wiring model (pure)', () => {
  const explorer = DEFAULT_VIEWS.find((v) => v.id === 'explorer')!;

  test('only bound inputs are present, with their source value or null', () => {
    const outputs: Record<string, Record<string, unknown>> = {
      histogram: {selection: {id: 'tokyo'}},
    };
    const outputOf = (b: string, o: string) => outputs[b]?.[o] as never;
    expect(resolveInputs(explorer, 'places', outputOf)).toEqual({place: {id: 'tokyo'}});
    expect(resolveInputs(explorer, 'histogram', outputOf)).toEqual({viewport: null});
    expect(resolveInputs(explorer, 'world-map~overview', outputOf)).toEqual({});
  });

  test('rebinding replaces, and null disconnects', () => {
    const rebound = setBinding(explorer, 'places', 'place', {
      blockId: 'world-map~overview',
      output: 'selection',
    });
    expect(rebound.bindings!.filter((b) => b.blockId === 'places')).toHaveLength(1);
    const cut = setBinding(rebound, 'places', 'place', null);
    expect(cut.bindings!.some((b) => b.blockId === 'places')).toBe(false);
  });
});

test.describe('wired explorer view', () => {
  test.beforeEach(async ({connectedPage: page}) => {
    await page.evaluate(() => localStorage.clear());
    await page.goto('/?mode=layout&view=explorer');
    await expect(page.getByLabel('Layout view')).toHaveValue('explorer');
    await expect(histogram(page).locator('.hist-badge.wired')).toBeVisible();
    // The overview map publishes its visible area once it's up.
    await expect(histogram(page).locator('.histogram-scope')).toContainText(
      'in the connected area',
    );
  });

  test('the map viewport filters the histogram', async ({page}) => {
    // Fly the overview map to Tokyo: its published viewport narrows the data.
    await frame(page, 'world-map~overview').getByRole('button', {name: 'Tokyo'}).click();
    const list = histogram(page).getByRole('list', {name: 'Matching cities'});
    await expect(list).toContainText('Tokyo', {timeout: 10_000});
    await expect(list).not.toContainText('London', {timeout: 10_000});
  });

  test('picking a city in the histogram drives the detail map and Places', async ({
    page,
  }) => {
    // Pick whichever city tops the list for the overview's current area.
    const first = histogram(page)
      .getByRole('list', {name: 'Matching cities'})
      .getByRole('button')
      .first();
    const name = (await first.locator('span').first().textContent())!;
    await first.click();
    await expect(places(page).locator('.place-detail h2')).toHaveText(name);
    await expect(places(page).locator('.places-badge.wired')).toBeVisible();
    await expect(frame(page, 'world-map~detail').locator('.map-status')).toHaveText(
      `Flying to ${name}`,
    );
  });

  test('brushing the histogram narrows the city list', async ({page}) => {
    const list = histogram(page).getByRole('list', {name: 'Matching cities'});
    const bar = histogram(page).getByRole('button', {name: /^8 to 16 million/});
    await bar.click();
    await expect(bar).toHaveAttribute('aria-pressed', 'true');
    await expect(histogram(page).locator('.histogram-scope')).toContainText('8–16M people');
    // Every listed city is in the brushed range.
    for (const meta of await list.locator('.city-meta').allTextContents()) {
      const millions = Number(meta.match(/([\d.]+)M/)![1]);
      expect(millions).toBeGreaterThanOrEqual(8);
      expect(millions).toBeLessThan(16);
    }
    // Clicking the only brushed bar again clears the brush.
    await bar.click();
    await expect(bar).toHaveAttribute('aria-pressed', 'false');
    await expect(histogram(page).locator('.histogram-scope')).not.toContainText('M people');
  });

  test('a wired input takes precedence over the shared selection', async ({page}) => {
    // The overview map still publishes to the shared context, but Places is
    // wired to the histogram, so it ignores that.
    await frame(page, 'world-map~overview').getByRole('button', {name: 'London'}).click();
    await expect(places(page).locator('.places-empty')).toHaveText(
      'Nothing selected upstream yet.',
    );
  });

  test('rewiring an input in edit mode', async ({page}) => {
    await page.getByRole('button', {name: /Edit layouts/}).click();
    await page.getByLabel('Settings for slot s4').click();
    const input = page.getByLabel('Input Place to show');
    await expect(input.locator('option:checked')).toHaveText('City histogram · Picked city');
    // Only type-compatible outputs (place) are offered — not the map's viewport.
    await expect(input.locator('option')).toHaveText([
      '— Not connected —',
      'Overview map · Selected city',
      'City histogram · Picked city',
      'Detail map · Selected city',
    ]);
    await input.selectOption({label: 'Overview map · Selected city'});
    await expect(page.locator('.slot-edit-wire', {hasText: 'place ←'})).toContainText(
      'Overview map.selection',
    );
    await page.getByRole('button', {name: 'Save view'}).click();

    await frame(page, 'world-map~overview').getByRole('button', {name: 'Cairo'}).click();
    await expect(places(page).locator('.place-detail h2')).toHaveText('Cairo');
  });
});

test.describe('block lifecycle', () => {
  test('an explicit block can be deleted; default blocks cannot', async ({
    connectedPage: page,
  }) => {
    await page.evaluate(() => localStorage.clear());
    await page.goto('/?mode=layout&view=quad');
    await page.getByRole('button', {name: /Edit layouts/}).click();
    await page.getByLabel('Block for slot s4').selectOption('new:world-map');
    await expect(page.locator('iframe[title="world-map~2"]')).toBeAttached();

    await page.getByLabel('Settings for slot s1').click();
    await expect(page.getByRole('button', {name: 'Delete block'})).toHaveCount(0);

    await page.getByLabel('Settings for slot s4').click();
    await page.getByRole('button', {name: 'Delete block'}).click();
    await expect(page.getByLabel('Block for slot s4')).toHaveValue('');
    await expect(page.getByLabel('Block for slot s4').locator('option')).not.toContainText([
      'World Map 2',
    ]);
  });

  test('a block used by another view cannot be deleted', async ({connectedPage: page}) => {
    await page.evaluate(() => localStorage.clear());
    await page.goto('/?mode=layout&view=two-maps');
    await page.getByRole('button', {name: /Edit layouts/}).click();
    await page.getByLabel('Settings for slot s1').click();
    await expect(page.getByRole('button', {name: 'Delete block'})).toBeDisabled();
    await expect(page.getByRole('complementary', {name: 'Block settings'})).toContainText(
      'Also used in: Explorer (wired)',
    );
  });
});
