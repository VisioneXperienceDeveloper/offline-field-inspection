import assert from 'node:assert/strict';
import {mkdtemp, readdir, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createFileStorage} from '../src/storage.mjs';

test('file storage commits an atomic JSON snapshot and can reopen it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fieldnote-server-storage-'));
  const filePath = join(directory, 'state.json');
  const storage = await createFileStorage(filePath);
  await storage.transaction(state => {
    state.inspections['project-c3'] = {
      'INSP-STORAGE-1': {id: 'INSP-STORAGE-1', projectId: 'project-c3', revision: 1},
    };
    return 'committed';
  });

  const parsed = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(parsed.inspections['project-c3']['INSP-STORAGE-1'].revision, 1);
  assert.deepEqual((await readdir(directory)).sort(), ['state.json']);

  const reopened = await createFileStorage(filePath);
  const snapshot = await reopened.snapshot();
  assert.equal(snapshot.inspections['project-c3']['INSP-STORAGE-1'].id, 'INSP-STORAGE-1');
});
