import {APIRequestContext, Page, expect, test} from '@playwright/test';

const backendInspectionUrl = (inspectionId: string) =>
  `http://127.0.0.1:8787/v1/projects/project-c3/inspections/${encodeURIComponent(inspectionId)}`;

test('queues an offline inspection and clears the queue only after a server ACK', async ({page, request}) => {
  await page.goto('/inspections');
  await expect(page.getByRole('heading', {name: 'Field inspections'})).toBeVisible();

  await page.getByRole('button', {name: 'Enable offline test mode'}).click();
  await expect(page.getByRole('button', {name: 'Return online'})).toBeVisible();

  const inspectionId = await createInspection(page);

  await expect(page.getByText('Saved on this device', {exact: true})).toBeVisible();
  await expect(page.getByText('Remote operation queued', {exact: true})).toBeVisible();
  await expect.poll(() => queuedOperationCount(page, inspectionId)).toBe(1);
  await expect.poll(() => remoteInspectionStatus(request, inspectionId)).toBe(404);

  expect(await readLocalInspection(page, inspectionId)).toMatchObject({
    id: inspectionId,
    localSaveStatus: 'saved',
    serverRevision: null,
    syncStatus: 'pending',
  });

  await page.getByRole('button', {name: 'Return online'}).click();

  await expect(page.getByText('Confirmed by the remote service', {exact: true})).toBeVisible({timeout: 20_000});
  await expect.poll(() => queuedOperationCount(page, inspectionId)).toBe(0);
  await expect.poll(() => remoteInspectionStatus(request, inspectionId)).toBe(200);

  const remote = await readRemoteInspection(request, inspectionId);
  expect(remote).toMatchObject({
    id: inspectionId,
    projectId: 'project-c3',
    revision: 1,
    status: 'Draft',
  });

  const local = await readLocalInspection(page, inspectionId);
  expect(local).toMatchObject({
    id: inspectionId,
    localSaveStatus: 'saved',
    serverRevision: 1,
    syncStatus: 'synced',
  });
  expect(local?.lastServerAckAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
});

test('pauses a revision conflict until the user explicitly accepts the server version', async ({page, request}) => {
  await page.goto('/inspections');
  const inspectionId = await createInspection(page);
  await expect(page.getByText('Confirmed by the remote service', {exact: true})).toBeVisible({timeout: 20_000});

  await page.getByRole('button', {name: 'Enable offline test mode'}).click();
  await page.getByLabel('Inspection title').fill('Local conflicting title');
  await expect(page.getByText('Remote operation queued', {exact: true})).toBeVisible();
  await expect.poll(() => queuedOperationCount(page, inspectionId)).toBe(1);

  const operationId = `e2e-server-update-${inspectionId}`;
  const serverUpdate = await request.patch(backendInspectionUrl(inspectionId), {
    headers: {
      Authorization: 'Bearer demo-inspector-token',
      'Content-Type': 'application/json',
      'Idempotency-Key': `idem-${operationId}`,
    },
    data: {
      operationId,
      baseRevision: 1,
      changes: {title: 'Server authoritative title'},
    },
  });
  expect(serverUpdate.ok()).toBe(true);
  expect(await serverUpdate.json()).toMatchObject({status: 'acked', revision: 2});
  await serverUpdate.dispose();

  await page.getByRole('button', {name: 'Return online'}).click();
  await expect(page.getByText('Remote conflict needs review', {exact: true})).toBeVisible({timeout: 20_000});
  await expect.poll(() => queuedOperationCount(page, inspectionId)).toBe(1);

  await page.getByRole('button', {name: 'Review conflict'}).click();
  await expect(page.getByText(/permanently discards this device's queued edits/)).toBeVisible();
  await page.getByRole('button', {name: 'Use server version'}).click();

  await expect(page.getByRole('heading', {name: 'Server authoritative title'})).toBeVisible();
  await expect(page.getByText('Confirmed by the remote service', {exact: true})).toBeVisible();
  await expect.poll(() => queuedOperationCount(page, inspectionId)).toBe(0);
  expect(await readLocalInspection(page, inspectionId)).toMatchObject({
    title: 'Server authoritative title',
    serverRevision: 2,
    syncStatus: 'synced',
  });
});

async function createInspection(page: Page): Promise<string> {
  await page.getByRole('button', {name: /New inspection/}).click();
  const dialog = page.getByRole('dialog', {name: 'Start a new inspection'});
  await dialog.getByRole('button', {name: /Daily Equipment Check/}).click();
  await dialog.getByRole('button', {name: 'Start inspection'}).click();
  await expect(page.getByRole('heading', {name: 'Daily Equipment Check'})).toBeVisible();
  return new URL(page.url()).pathname.split('/').at(-1)!;
}

async function queuedOperationCount(page: Page, inspectionId: string): Promise<number> {
  return page.evaluate(async id => {
    const database = await openDatabase('fieldnote-sync-outbox-db');
    try {
      return await new Promise<number>((resolve, reject) => {
        const transaction = database.transaction('operations', 'readonly');
        const request = transaction.objectStore('operations').getAll();
        request.onerror = () => reject(request.error);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
        transaction.oncomplete = () => {
          const matching = (request.result as Array<{inspectionId?: unknown}>).filter(row => row.inspectionId === id);
          resolve(matching.length);
        };
      });
    } finally {
      database.close();
    }

    function openDatabase(name: string): Promise<IDBDatabase> {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
  }, inspectionId);
}

async function readLocalInspection(page: Page, inspectionId: string): Promise<LocalInspectionState | null> {
  return page.evaluate(async id => {
    const database = await openDatabase('fieldnote-production-db');
    try {
      return await new Promise<LocalInspectionState | null>((resolve, reject) => {
        const transaction = database.transaction('inspections', 'readonly');
        const request = transaction.objectStore('inspections').get(id);
        request.onerror = () => reject(request.error);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
        transaction.oncomplete = () => resolve((request.result as LocalInspectionState | undefined) ?? null);
      });
    } finally {
      database.close();
    }

    function openDatabase(name: string): Promise<IDBDatabase> {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
  }, inspectionId);
}

async function remoteInspectionStatus(request: APIRequestContext, inspectionId: string): Promise<number> {
  const response = await request.get(backendInspectionUrl(inspectionId), {
    headers: {Authorization: 'Bearer demo-inspector-token'},
  });
  const status = response.status();
  await response.dispose();
  return status;
}

async function readRemoteInspection(request: APIRequestContext, inspectionId: string): Promise<Record<string, unknown>> {
  const response = await request.get(backendInspectionUrl(inspectionId), {
    headers: {Authorization: 'Bearer demo-inspector-token'},
  });
  expect(response.ok()).toBe(true);
  const body = await response.json() as {data: Record<string, unknown>};
  await response.dispose();
  return body.data;
}

interface LocalInspectionState {
  id: string;
  lastServerAckAt: string | null;
  localSaveStatus: string;
  serverRevision: number | null;
  syncStatus: string;
  title?: string;
}
