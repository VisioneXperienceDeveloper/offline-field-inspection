import AxeBuilder from '@axe-core/playwright';
import {Page, expect, test} from '@playwright/test';

const routes = [
  ['/dashboard', 'Good morning, Henry Kim.'],
  ['/inspections', 'Field inspections'],
  ['/templates', 'Inspection templates'],
  ['/audit-log', 'Audit log'],
  ['/settings', 'Settings'],
  ['/help', 'How can we help your field team?'],
] as const;

for (const [path, heading] of routes) {
  test(`renders ${path} without runtime errors`, async ({page}) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') errors.push(`${message.text()} (${message.location().url})`);
    });
    page.on('response', response => {
      if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
    });

    await page.goto(path);

    await expect(page.getByRole('heading', {name: heading})).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('serves an inspection deep link from the production artifact', async ({page}) => {
  await page.goto('/inspections/INSP-2026-0084');
  await expect(page.getByRole('heading', {name: 'Weekly Safety Inspection'})).toBeVisible();
});

test('cold-starts a newly created local inspection in a new offline tab', async ({page, context}) => {
  await page.goto('/inspections');
  const inspectionId = await createInspection(page);
  const inspectionUrl = page.url();
  await expect(page.getByText('Saved on this device', {exact: true})).toBeVisible();
  await expect.poll(() => persistedInspectionId(page, inspectionId)).toBe(inspectionId);

  await page.evaluate(async () => Boolean(await navigator.serviceWorker.ready));
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

  await page.close();
  await context.setOffline(true);
  const coldPage = await context.newPage();
  await coldPage.goto(inspectionUrl);

  await expect(coldPage.getByRole('heading', {name: 'Daily Equipment Check'})).toBeVisible();
  await expect(coldPage.getByText(inspectionId, {exact: false}).first()).toBeVisible();
  await expect(coldPage.getByText('Saved on this device', {exact: true})).toBeVisible();
});

test('has no serious or critical accessibility violations on the inspection register', async ({page}) => {
  await page.goto('/inspections');
  const results = await new AxeBuilder({page}).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(results.violations.filter(violation => violation.impact === 'serious' || violation.impact === 'critical')).toEqual([]);
});

test('keeps the primary register usable at a 390×844 viewport', async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await page.goto('/inspections');

  await expect(page.getByRole('heading', {name: 'Field inspections'})).toBeVisible();
  await expect(page.getByRole('button', {name: /New inspection/})).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

async function createInspection(page: Page): Promise<string> {
  await page.getByRole('button', {name: /New inspection/}).click();
  const dialog = page.getByRole('dialog', {name: 'Start a new inspection'});
  await dialog.getByRole('button', {name: /Daily Equipment Check/}).click();
  await dialog.getByRole('button', {name: 'Start inspection'}).click();
  await expect(page.getByRole('heading', {name: 'Daily Equipment Check'})).toBeVisible();
  return new URL(page.url()).pathname.split('/').at(-1)!;
}

async function persistedInspectionId(page: Page, inspectionId: string): Promise<string | null> {
  return page.evaluate(async id => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('fieldnote-production-db');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<string | null>((resolve, reject) => {
        const transaction = database.transaction('inspections', 'readonly');
        const request = transaction.objectStore('inspections').get(id);
        request.onerror = () => reject(request.error);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
        transaction.oncomplete = () => resolve((request.result as {id?: unknown} | undefined)?.id === id ? id : null);
      });
    } finally {
      database.close();
    }
  }, inspectionId);
}
