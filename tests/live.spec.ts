import {expect, type Browser, type BrowserContext, type Page} from '@playwright/test';
import {test} from './fixtures';

/**
 * Live updates and presence: the layout service pushes `layouts-changed` and
 * `presence` events, so other people's saves and edits show up without reload.
 */
const HOST = 'http://localhost:5173';

/** Extra browser contexts opened by a test, closed after it. */
const contexts: BrowserContext[] = [];
test.afterEach(async () => {
  await Promise.all(contexts.splice(0).map((c) => c.close()));
});

/** Open the Quad view in `page` and wait for shared, live layouts. */
async function openQuad(page: Page) {
  await page.goto(`${HOST}/?mode=layout&view=quad`);
  await expect(page.locator('.source-badge.service')).toBeVisible();
  await expect(page.getByLabel('Live updates on')).toBeVisible();
}

/**
 * A second person in the same workspace, in their own browser context (so
 * their own sign-in), signed in as `user`.
 */
async function secondPerson(browser: Browser, page: Page, user: string) {
  const workspace = await page.evaluate(() => localStorage.getItem('ff.workspace'));
  const context = await browser.newContext();
  contexts.push(context);
  await context.addInitScript(
    ([ws, u]) => {
      localStorage.setItem('ff.workspace', ws!);
      localStorage.setItem('ff.user', u!);
    },
    [workspace, user],
  );
  const other = await context.newPage();
  await openQuad(other);
  await expect(other.getByLabel('Signed in as')).toHaveValue(user);
  return other;
}

async function editAndSaveName(page: Page, name: string) {
  await page.getByRole('button', {name: /Edit layouts/}).click();
  await page.getByLabel('View name').fill(name);
  await page.getByRole('button', {name: 'Save view'}).click();
  await expect(page.getByRole('button', {name: /Edit layouts/})).toBeVisible();
}

test.describe('live updates & presence', () => {
  test('another user’s view updates live when an editor saves', async ({connectedPage: page, browser}) => {
    await openQuad(page);
    const andy = await secondPerson(browser, page, 'andy');
    await editAndSaveName(page, 'Quad (live)');
    await expect(andy.getByLabel('Layout view').locator('option:checked')).toHaveText('Quad (live)');
  });

  test('presence: others see who is editing, until they stop or leave', async ({
    connectedPage: page,
    browser,
  }) => {
    await openQuad(page);
    const andy = await secondPerson(browser, page, 'andy');
    const status = andy.getByRole('status').filter({hasText: 'is editing this view'});

    await page.getByRole('button', {name: /Edit layouts/}).click();
    await expect(status).toHaveText('✎ Alice is editing this view');
    await page.getByRole('button', {name: 'Cancel'}).click();
    await expect(status).toHaveCount(0);

    // Presence is tied to the connection: closing the tab clears it too.
    await page.getByRole('button', {name: /Edit layouts/}).click();
    await expect(status).toBeVisible();
    await page.close();
    await expect(status).toHaveCount(0);
  });

  test('an editor is warned before saving a view someone else changed', async ({
    connectedPage: page,
    browser,
  }) => {
    await openQuad(page);
    const alice2 = await secondPerson(browser, page, 'alice');
    await alice2.getByRole('button', {name: /Edit layouts/}).click();
    await expect(
      alice2.getByRole('status').filter({hasText: 'is also editing'}),
    ).toHaveCount(0);

    // The first tab edits too — the second sees them — then saves.
    await page.getByRole('button', {name: /Edit layouts/}).click();
    await expect(alice2.getByRole('status').filter({hasText: 'is also editing'})).toHaveText(
      '✎ Alice is also editing this view',
    );
    await page.getByLabel('View name').fill('Quad (first)');
    await page.getByRole('button', {name: 'Save view'}).click();

    const warning = alice2.getByRole('alert', {name: 'Stale edit'});
    await expect(warning).toContainText('Alice saved a newer version of this view');
    await warning.getByRole('button', {name: /Reload latest/}).click();
    await expect(alice2.getByRole('button', {name: /Edit layouts/})).toBeVisible();
    await expect(alice2.getByLabel('Layout view').locator('option:checked')).toHaveText('Quad (first)');
  });

  test('an ad-hoc copy is dropped live when the approved view changes', async ({
    connectedPage: page,
    browser,
  }) => {
    await openQuad(page);
    const andy = await secondPerson(browser, page, 'andy');
    await andy.getByLabel('Block in slot s2').selectOption('world-map');
    await expect(andy.getByLabel('Block in slot s1')).toHaveValue('places');

    await editAndSaveName(page, 'Quad v2');
    await expect(andy.getByLabel('Layout view').locator('option:checked')).toHaveText('Quad v2');
    await expect(andy.getByLabel('Block in slot s1')).toHaveValue('world-map');
  });
});
