import {expect, type Page} from '@playwright/test';
import {test} from './fixtures';
import {
  checkExpr,
  evaluateExpr,
  referencedOutputs,
  toIdentifier,
  type ExprScope,
} from '../packages/layout-model/src/expressions';
import {DEFAULT_VIEWS, resolveInputs} from '../packages/layout-model/src/layout';

const tokyo = {id: 'tokyo', name: 'Tokyo', latitude: 35.69, longitude: 139.69, zoom: 9};
const osaka = {id: 'osaka', name: 'Osaka', latitude: 34.69, longitude: 135.5};

const scope: ExprScope = [
  {name: 'histogram', blockId: 'histogram', outputs: {selection: 'place', range: 'range'}},
  {name: 'nearby', blockId: 'histogram~nearby', outputs: {selection: 'place', range: 'range'}},
  {name: 'overview', blockId: 'world-map~overview', outputs: {selection: 'place', viewport: 'bbox'}},
];
const outputs: Record<string, Record<string, unknown>> = {
  histogram: {selection: tokyo},
  'world-map~overview': {selection: osaka, viewport: {west: 100, south: 0, east: 150, north: 50}},
};
const outputOf = (b: string, o: string) => (outputs[b]?.[o] ?? undefined) as never;
const run = (src: string) => evaluateExpr(src, scope, outputOf);

test.describe('CEL expressions (pure)', () => {
  test('block outputs are typed variables; results come back as plain JSON', () => {
    expect(run('overview.viewport.west')).toBe(100);
    expect(run('histogram.selection')).toEqual(tokyo);
    expect(run('histogram.selection.name + "!"')).toBe('Tokyo!');
    expect(run('1 + 2')).toBe(3); // CEL int (bigint) → number
    expect(run('overview.viewport.north > 40.0 ? "north" : "south"')).toBe('north');
  });

  test('unpublished outputs are absent: has() and optional chaining handle them', () => {
    expect(run('has(nearby.selection)')).toBe(false);
    expect(run('nearby.?selection.orValue(histogram.selection)')).toEqual(tokyo);
    // Reading an absent output is an error, which makes the input null.
    expect(run('bboxAround(nearby.selection, 100)')).toBeNull();
  });

  test('custom geo functions', () => {
    const box = run('bboxAround(histogram.selection, 1500)') as any;
    expect(box.north - box.south).toBeCloseTo((2 * 1500) / 111.32, 3);
    expect(run('bboxAround(histogram.selection, 1500.0)')).toEqual(box);
    const km = run('distanceKm(histogram.selection, overview.selection)') as number;
    expect(km).toBeGreaterThan(380);
    expect(km).toBeLessThan(420);
    // No overlap → error → null.
    expect(run('intersect(bbox(0.0, 0.0, 10.0, 10.0), bbox(20.0, 20.0, 30.0, 30.0))')).toBeNull();
    expect(run('center(bbox(0.0, 0.0, 10.0, 20.0))')).toMatchObject({latitude: 10, longitude: 5});
  });

  test('static checking: syntax, unknown names, overloads and the expected type', () => {
    expect(checkExpr('bboxAround(histogram.selection, 1500)', scope, 'bbox')).toEqual({
      ok: true,
      type: 'BBox',
    });
    expect(checkExpr('nearby.?selection.orValue(histogram.selection)', scope, 'place')).toEqual({
      ok: true,
      type: 'Place',
    });
    const cases: [string, RegExp][] = [
      ['bboxAround(histogram.selection', /Expected RPAREN/],
      ['bboxAround(missing.selection, 1)', /Unknown variable: missing/],
      ['bboxAround(histogram, 1)', /no matching overload/],
      ['histogram.selection', /Returns Place, but this input expects BBox/],
    ];
    for (const [src, message] of cases) {
      const result = checkExpr(src, scope, 'bbox');
      expect(result.ok, src).toBe(false);
      expect((result as {message: string}).message, src).toMatch(message);
    }
  });

  test('references and identifiers', () => {
    expect(referencedOutputs('nearby.?selection.orValue(histogram.selection)')).toEqual([
      {name: 'nearby', output: 'selection'},
      {name: 'histogram', output: 'selection'},
    ]);
    expect(toIdentifier('world-map~2')).toBe('world_map_2');
    expect(toIdentifier('in')).toBe('in_');
  });

  test('bindings resolve through expressions', () => {
    const nearbyView = DEFAULT_VIEWS.find((v) => v.id === 'nearby')!;
    expect(resolveInputs(nearbyView, 'places', outputOf, scope)).toEqual({place: tokyo});
    expect(resolveInputs(nearbyView, 'histogram~nearby', outputOf, scope).viewport).toMatchObject({
      west: expect.any(Number),
    });
  });
});

const frame = (page: Page, instanceId: string) =>
  page.frameLocator(`iframe[title="${instanceId}"]`);

test.describe('derived expressions (Nearby view)', () => {
  test.beforeEach(async ({connectedPage: page}) => {
    await page.evaluate(() => localStorage.clear());
    await page.goto('/?mode=layout&view=nearby');
    await expect(page.getByLabel('Layout view')).toHaveValue('nearby');
  });

  test('a computed viewport shows cities near the pick', async ({page}) => {
    const nearby = frame(page, 'histogram~nearby');
    await expect(nearby.locator('.histogram-scope')).toContainText('Waiting for an area');

    await frame(page, 'histogram').getByRole('button', {name: /^Tokyo/}).click();

    const list = nearby.getByRole('list', {name: 'Matching cities'});
    await expect(list).toContainText('Osaka');
    await expect(list).toContainText('Seoul');
    await expect(list).not.toContainText('London');
    // orValue(): nothing picked nearby yet, so Places falls back to the main pick…
    await expect(frame(page, 'places').locator('.place-detail h2')).toHaveText('Tokyo');
    // …and follows the nearby pick once there is one.
    await list.getByRole('button', {name: /^Osaka/}).click();
    await expect(frame(page, 'places').locator('.place-detail h2')).toHaveText('Osaka');
  });

  test('editing an expression: errors, inferred type, and the result', async ({page}) => {
    await page.getByRole('button', {name: /Edit layouts/}).click();
    await page.getByLabel('Settings for slot s3').click();
    const panel = page.getByRole('complementary', {name: 'Block settings'});
    await expect(panel.locator('.block-name')).toHaveText('nearby');
    const editor = page.getByLabel('Expression for Filter to area');
    await expect(editor).toHaveValue('bboxAround(histogram.selection, 1500)');
    const status = panel.getByRole('status');
    await expect(status).toContainText('→ BBox');

    await editor.fill('bboxAround(histogram.selection');
    await expect(status).toContainText('Expected RPAREN');

    await editor.fill('histogram.selection');
    await expect(status).toContainText('Returns Place, but this input expects BBox');

    await editor.fill('bboxAround(histogram.selection, 500)');
    await expect(status).toContainText('→ BBox');
    await page.getByRole('button', {name: 'Save view'}).click();
    await frame(page, 'histogram').getByRole('button', {name: /^Tokyo/}).click();
    const list = frame(page, 'histogram~nearby').getByRole('list', {name: 'Matching cities'});
    await expect(list).toContainText('Osaka');
    await expect(list).not.toContainText('Seoul');
  });

  test('switching an input between a direct source and an expression', async ({page}) => {
    await page.goto('/?mode=layout&view=explorer');
    await page.getByRole('button', {name: /Edit layouts/}).click();
    await page.getByLabel('Settings for slot s4').click();
    await page.getByLabel('Input Place to show').selectOption({label: 'ƒ Expression (CEL)…'});
    // Seeded from the direct source it replaces, using the block's CEL name.
    const editor = page.getByLabel('Expression for Place to show');
    await expect(editor).toHaveValue('histogram.selection');
    await expect(page.locator('.slot-edit-wire', {hasText: 'place ='})).toContainText(
      'histogram.selection',
    );
    // Clicking an available output inserts a reference.
    await editor.fill('overview.?selection.orValue(');
    await page.getByRole('button', {name: 'histogram.selection'}).click();
    await expect(editor).toHaveValue('overview.?selection.orValue(histogram.selection');
  });
});
