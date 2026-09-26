import {expect, type Page} from '@playwright/test';
import {test} from './fixtures';
import {inputsAuthorize} from '../packages/host/src/commands';
import {checkExpr, evaluateExpr, type ExprScope} from '../packages/layout-model/src/expressions';

const scope: ExprScope = [
  {name: 'actions', blockId: 'actions', outputs: {pressed: 'any', pressedLabel: 'string'}},
];

test.describe('action buttons (pure)', () => {
  test('a command runs only if the caller’s inputs contain that exact reference', () => {
    const inputs = {
      buttons: [
        {label: 'Tokyo', value: {id: 'tokyo'}},
        {label: 'Sydney', command: {block: 'detail', command: 'map.fly.sydney'}},
      ],
    };
    expect(inputsAuthorize(inputs, {block: 'detail', command: 'map.fly.sydney'})).toBe(true);
    expect(inputsAuthorize(inputs, {block: 'detail', command: 'map.fly.tokyo'})).toBe(false);
    expect(inputsAuthorize(inputs, {block: 'overview', command: 'map.fly.sydney'})).toBe(false);
    expect(inputsAuthorize({}, {block: 'detail', command: 'map.fly.sydney'})).toBe(false);
  });

  test('CEL builds button lists with values and commands', () => {
    const src =
      '[{"label": "Tokyo", "value": place("Tokyo", 35.69, 139.69)},' +
      ' {"label": "Go", "command": command("detail", "map.fly.sydney")}]';
    expect(checkExpr(src, scope, 'buttons')).toMatchObject({ok: true});
    expect(evaluateExpr(src, scope, () => undefined)).toEqual([
      {label: 'Tokyo', value: {id: 'tokyo', name: 'Tokyo', latitude: 35.69, longitude: 139.69}},
      {label: 'Go', command: {block: 'detail', command: 'map.fly.sydney'}},
    ]);
  });

  test('an `any` output carrying a place flows into typed functions', () => {
    const pressed = {id: 'tokyo', name: 'Tokyo', latitude: 35.69, longitude: 139.69};
    const box = evaluateExpr('bboxAround(actions.pressed, 1500)', scope, (_b, o) =>
      o === 'pressed' ? (pressed as never) : undefined,
    );
    expect(box).toMatchObject({west: expect.any(Number), north: expect.any(Number)});
  });
});

const frame = (page: Page, instanceId: string) =>
  page.frameLocator(`iframe[title="${instanceId}"]`);

test.describe('Quick actions view', () => {
  test.beforeEach(async ({connectedPage: page}) => {
    await page.evaluate(() => localStorage.clear());
    await page.goto('/?mode=layout&view=actions');
    await expect(page.getByLabel('Layout view')).toHaveValue('actions');
    await expect(frame(page, 'actions').locator('.actions-badge')).toHaveText('wired');
  });

  test('a value button drives every block wired to `pressed`', async ({page}) => {
    await frame(page, 'actions').getByRole('button', {name: 'Tokyo'}).click();
    await expect(frame(page, 'places').locator('.place-detail h2')).toHaveText('Tokyo');
    await expect(frame(page, 'world-map~detail').locator('.map-status')).toHaveText(
      'Flying to Tokyo',
    );
    // bboxAround(actions.pressed, 1500) — an `any` output into a typed function.
    const nearby = frame(page, 'histogram~nearby').getByRole('list', {name: 'Matching cities'});
    await expect(nearby).toContainText('Osaka');
  });

  test('a command button runs another block’s command', async ({page}) => {
    await frame(page, 'actions').getByRole('button', {name: /Fly the detail map to Sydney/}).click();
    await expect(frame(page, 'world-map~detail').locator('.map-status')).toHaveText(
      'Flying to Sydney',
    );
    // The command itself raises the map's toast.
    await expect(page.locator('.toast', {hasText: 'Flying to Sydney'})).toBeVisible();
  });

  test('authoring buttons: command chips, and a command that can’t run', async ({page}) => {
    await page.getByRole('button', {name: /Edit layouts/}).click();
    await page.getByLabel('Settings for slot s1').click();
    const editor = page.getByLabel('Expression for Buttons');
    await expect(editor).toHaveValue(/command\("detail", "map.fly.sydney"\)/);
    const panel = page.getByRole('complementary', {name: 'Block settings'});
    await expect(panel.getByRole('status')).toContainText('✓');
    // Commands registered by blocks in the view are offered as insertable calls.
    await expect(
      panel.getByRole('button', {name: 'command("detail", "map.fly.tokyo")'}),
    ).toBeVisible();

    // A button naming a block that doesn't exist: allowed to be authored, but
    // the host reports it can't run it.
    await editor.fill('[{"label": "Broken", "command": command("nope", "x")}]');
    await page.getByRole('button', {name: 'Save view'}).click();
    await frame(page, 'actions').getByRole('button', {name: 'Broken'}).click();
    await expect(page.locator('.toast', {hasText: 'No command “x” on block “nope”'})).toBeVisible();
    await expect(frame(page, 'actions').locator('.actions-status')).toContainText(
      'Couldn’t run nope:x',
    );
  });
});
