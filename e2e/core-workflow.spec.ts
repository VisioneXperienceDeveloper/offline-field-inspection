import {expect, test} from '@playwright/test';

test('creates, completes, approves, and reloads an inspection', async ({page}) => {
  await page.goto('/inspections');
  await expect(page.getByRole('heading', {name: 'Field inspections'})).toBeVisible();

  await page.getByRole('button', {name: /New inspection/}).click();
  const dialog = page.getByRole('dialog', {name: 'Start a new inspection'});
  await dialog.getByRole('button', {name: /Daily Equipment Check/}).click();
  await dialog.getByRole('button', {name: 'Start inspection'}).click();

  await expect(page.getByRole('heading', {name: 'Daily Equipment Check'})).toBeVisible();
  await page.getByLabel('Site zone').selectOption('North access');
  for (const button of await page.getByRole('button', {name: 'Pass', exact: true}).all()) await button.click();

  await page.getByRole('button', {name: 'Submit inspection'}).click();
  await expect(page.getByRole('button', {name: 'Approve inspection'})).toHaveCount(0);
  const inspectionUrl = page.url();
  await page.getByRole('button', {name: 'Open profile menu'}).click();
  await page.getByRole('button', {name: 'Rina Park Reviewer', exact: true}).click();
  await page.goto(inspectionUrl);
  await expect(page.getByRole('button', {name: 'Approve inspection'})).toBeVisible();
  await page.getByRole('button', {name: 'Approve inspection'}).click();
  await expect(page.getByRole('button', {name: 'Done'})).toBeVisible();
  await expect(page.getByText('Saved on this device', {exact: true})).toBeVisible();

  await page.reload();
  await expect(page.getByRole('button', {name: 'Done'})).toBeVisible();
});
