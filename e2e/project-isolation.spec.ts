import {expect, test} from '@playwright/test';

test('blocks list and direct URL access after switching away from a project', async ({page}) => {
  await page.goto('/inspections');
  await page.getByRole('button', {name: 'Open profile menu'}).click();
  await page.getByRole('button', {name: 'Alex Morgan Admin', exact: true}).click();
  await page.getByRole('button', {name: /Sydney Metro · C3/}).click();
  await page.getByRole('button', {name: /Western Harbour · P2/}).click();
  await page.getByRole('button', {name: /New inspection/}).click();
  const dialog = page.getByRole('dialog', {name: 'Start a new inspection'});
  await dialog.getByRole('button', {name: /Daily Equipment Check/}).click();
  await dialog.getByRole('button', {name: 'Start inspection'}).click();
  const projectBUrl = page.url();
  const projectBId = projectBUrl.split('/').at(-1)!;
  await expect(page.getByText('Western Harbour · P2', {exact: false}).first()).toBeVisible();
  await expect(page.getByText('Saved on this device', {exact: true})).toBeVisible();

  await page.getByRole('button', {name: /Western Harbour · P2/}).click();
  await page.getByRole('button', {name: /Sydney Metro · C3/}).click();
  await page.goto(projectBUrl);

  await expect(page.getByRole('heading', {name: 'Inspection not found'})).toBeVisible();
  await page.goto('/inspections');
  await expect(page.getByText(projectBId, {exact: true})).toHaveCount(0);

  await page.getByRole('button', {name: 'Open profile menu'}).click();
  await page.getByRole('button', {name: 'Henry Kim Inspector', exact: true}).click();
  await page.getByRole('button', {name: /Sydney Metro · C3/}).click();
  await expect(page.getByRole('button', {name: /Western Harbour · P2/})).toHaveCount(0);
});
