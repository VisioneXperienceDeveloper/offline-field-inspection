import {IDBFactory} from 'fake-indexeddb';
import {Inspection} from '../models/inspection.models';
import {
  FIELDNOTE_DATABASE_NAME,
  FIELDNOTE_DATABASE_VERSION,
  IndexedDbInspectionRepository,
} from './indexed-db.repository';

function inspection(id = 'INSP-TEST-0001'): Inspection {
  return {
    id,
    title: 'Repository test',
    templateId: 'tpl-test',
    templateName: 'Test template',
    templateVersion: 1,
    templatePublishedAt: null,
    templateSnapshotAt: null,
    projectId: 'project-c3',
    projectName: 'Sydney Metro · C3',
    zone: 'North access',
    inspector: 'Test Inspector',
    createdBy: 'test-inspector',
    approvedBy: null,
    status: 'Draft',
    localSaveStatus: 'saved',
    localRevision: 1,
    syncStatus: 'pending',
    serverRevision: null,
    lastServerAckAt: null,
    updatedAt: '2026-09-02T00:00:00.000Z',
    inspectionDate: '2026-09-02',
    weather: 'Clear',
    requiresPhotos: false,
    photos: [],
    checklist: [{id: 1, title: 'Check', answer: 'pass', note: '', required: true}],
    auditTrail: [],
  };
}

describe('IndexedDbInspectionRepository', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'indexedDB', {value: new IDBFactory(), configurable: true});
  });

  it('saves and reloads an inspection from a fresh database', async () => {
    const repository = new IndexedDbInspectionRepository();
    const record = inspection();

    await repository.save(record);

    await expect(repository.loadAll()).resolves.toEqual([record]);
  });

  it('resolves a write only after its transaction completes', async () => {
    const harness = installControlledWriteDatabase();
    const repository = new IndexedDbInspectionRepository();
    let resolved = false;

    const savePromise = repository.save(inspection()).then(() => {
      resolved = true;
    });
    await vi.waitFor(() => expect(harness.put).toHaveBeenCalledOnce());

    expect(resolved).toBe(false);
    harness.complete();
    await savePromise;
    expect(resolved).toBe(true);
  });

  it('saves a batch in one transaction', async () => {
    const repository = new IndexedDbInspectionRepository();
    const records = [inspection('INSP-TEST-0001'), inspection('INSP-TEST-0002')];

    await repository.saveMany(records);

    await expect(repository.loadAll()).resolves.toEqual(records);
  });

  it('round-trips terminal sync failure and conflict states without quarantining them', async () => {
    const repository = new IndexedDbInspectionRepository();
    const failed = {...inspection('INSP-SYNC-FAILED'), syncStatus: 'failed' as const};
    const conflicted = {...inspection('INSP-SYNC-CONFLICTED'), syncStatus: 'conflicted' as const};

    await repository.saveMany([failed, conflicted]);

    await expect(repository.loadAllWithReport()).resolves.toEqual({
      inspections: [conflicted, failed],
      quarantinedRows: [],
    });
  });

  it('rolls back every write when one row makes saveMany fail', async () => {
    const repository = new IndexedDbInspectionRepository();
    const invalidRecord = {...inspection(''), id: undefined} as unknown as Inspection;

    await expect(repository.saveMany([inspection('INSP-ATOMIC-0001'), invalidRecord])).rejects.toBeInstanceOf(DOMException);
    await expect(repository.loadAll()).resolves.toEqual([]);
  });

  it('migrates version-one data without deleting it', async () => {
    const legacyRecord = inspection('INSP-LEGACY-0001');
    await seedVersionOneDatabase(legacyRecord);

    const repository = new IndexedDbInspectionRepository();

    await expect(repository.loadAll()).resolves.toEqual([legacyRecord]);
    const database = await openDatabase(FIELDNOTE_DATABASE_VERSION);
    expect(database.version).toBe(FIELDNOTE_DATABASE_VERSION);
    expect(database.transaction('inspections').objectStore('inspections').indexNames.contains('by-project-id')).toBe(true);
    database.close();
  });

  it('quarantines malformed rows while returning valid inspections', async () => {
    const validRecord = inspection('INSP-VALID-0001');
    const malformedRecord = {...inspection('INSP-CORRUPT-0001'), checklist: 'not-an-array'};
    await putRawRows([validRecord, malformedRecord]);
    const repository = new IndexedDbInspectionRepository();

    await expect(repository.loadAllWithReport()).resolves.toEqual({
      inspections: [validRecord],
      quarantinedRows: [{
        rowIndex: 0,
        recordId: 'INSP-CORRUPT-0001',
        reason: 'Missing or invalid checklist.',
      }],
    });
    await expect(repository.loadAll()).resolves.toEqual([validRecord]);
  });

  it('reports each minimum validation failure without rejecting the whole load', async () => {
    const harness = installControlledReadDatabase();
    const repository = new IndexedDbInspectionRepository();
    const loadPromise = repository.loadAllWithReport();
    await vi.waitFor(() => expect(harness.getAll).toHaveBeenCalledOnce());

    harness.succeed([
      null,
      {...inspection('INSP-BAD-TITLE'), title: ''},
      {...inspection('INSP-BAD-TEMPLATE'), templateId: ''},
      {...inspection('INSP-BAD-PROJECT'), projectId: ''},
      {...inspection('INSP-BAD-STATUS'), status: 'Unknown'},
      {...inspection('INSP-BAD-SYNC'), syncStatus: 'Unknown'},
      {...inspection('INSP-BAD-PHOTOS'), photos: null},
      {...inspection('INSP-BAD-AUDIT'), auditTrail: null},
    ]);

    const report = await loadPromise;
    expect(report.inspections).toEqual([]);
    expect(report.quarantinedRows.map(row => row.reason)).toEqual([
      'Row is not an object.',
      'Missing or invalid title.',
      'Missing or invalid templateId.',
      'Missing or invalid projectId.',
      'Missing or invalid status.',
      'Missing or invalid syncStatus.',
      'Missing or invalid photos.',
      'Missing or invalid auditTrail.',
    ]);
    expect(report.quarantinedRows[0]?.recordId).toBeNull();
  });

  it('surfaces read request errors', async () => {
    const harness = installControlledReadDatabase();
    const repository = new IndexedDbInspectionRepository();
    const loadPromise = repository.loadAll();
    await vi.waitFor(() => expect(harness.getAll).toHaveBeenCalledOnce());

    harness.failRequest(new DOMException('Read request failed', 'UnknownError'));

    await expect(loadPromise).rejects.toThrow('Read request failed');
  });

  it('surfaces read transaction errors', async () => {
    const harness = installControlledReadDatabase();
    const repository = new IndexedDbInspectionRepository();
    const loadPromise = repository.loadAll();
    await vi.waitFor(() => expect(harness.getAll).toHaveBeenCalledOnce());

    harness.failTransaction(new DOMException('Read transaction failed', 'UnknownError'));

    await expect(loadPromise).rejects.toThrow('Read transaction failed');
  });

  it('surfaces aborted read transactions', async () => {
    const harness = installControlledReadDatabase();
    const repository = new IndexedDbInspectionRepository();
    const loadPromise = repository.loadAll();
    await vi.waitFor(() => expect(harness.getAll).toHaveBeenCalledOnce());

    harness.abort(new DOMException('Read transaction aborted', 'AbortError'));

    await expect(loadPromise).rejects.toThrow('Read transaction aborted');
  });

  it('surfaces database open failures and allows a later retry', async () => {
    const workingIndexedDb = new IDBFactory();
    const request = {error: new DOMException('Database unavailable'), onerror: null} as unknown as IDBOpenDBRequest;
    const open = vi.fn(() => {
      queueMicrotask(() => request.onerror?.call(request, new Event('error')));
      return request;
    });
    Object.defineProperty(globalThis, 'indexedDB', {value: {open}, configurable: true});
    const repository = new IndexedDbInspectionRepository();

    await expect(repository.loadAll()).rejects.toThrow('Database unavailable');

    Object.defineProperty(globalThis, 'indexedDB', {value: workingIndexedDb, configurable: true});
    await expect(repository.loadAll()).resolves.toEqual([]);
  });

  it('surfaces request errors from a write transaction', async () => {
    const harness = installControlledWriteDatabase();
    const repository = new IndexedDbInspectionRepository();
    const savePromise = repository.save(inspection());
    await vi.waitFor(() => expect(harness.put).toHaveBeenCalledOnce());

    harness.failRequest(new DOMException('Write request failed', 'DataError'));

    await expect(savePromise).rejects.toThrow('Write request failed');
  });

  it('surfaces write transaction errors', async () => {
    const harness = installControlledWriteDatabase();
    const repository = new IndexedDbInspectionRepository();
    const savePromise = repository.save(inspection());
    await vi.waitFor(() => expect(harness.put).toHaveBeenCalledOnce());

    harness.failTransaction(new DOMException('Transaction failed', 'UnknownError'));

    await expect(savePromise).rejects.toThrow('Transaction failed');
  });

  it('surfaces aborted write transactions', async () => {
    const harness = installControlledWriteDatabase();
    const repository = new IndexedDbInspectionRepository();
    const savePromise = repository.save(inspection());
    await vi.waitFor(() => expect(harness.put).toHaveBeenCalledOnce());

    harness.abort(new DOMException('Quota exhausted', 'QuotaExceededError'));

    await expect(savePromise).rejects.toThrow('Quota exhausted');
  });

  it('closes and resets the database for isolated reuse', async () => {
    const repository = new IndexedDbInspectionRepository();
    await repository.save(inspection());

    await repository.close();
    await repository.reset();

    await expect(repository.loadAll()).resolves.toEqual([]);
  });

  it('surfaces database reset failures', async () => {
    const deleteRequest = {
      error: new DOMException('Reset failed', 'UnknownError'),
      onsuccess: null as ((event: Event) => unknown) | null,
      onerror: null as ((event: Event) => unknown) | null,
      onblocked: null as ((event: Event) => unknown) | null,
    };
    Object.defineProperty(globalThis, 'indexedDB', {
      value: {
        deleteDatabase: vi.fn(() => {
          queueMicrotask(() => deleteRequest.onerror?.(new Event('error')));
          return deleteRequest;
        }),
      },
      configurable: true,
    });

    await expect(new IndexedDbInspectionRepository().reset()).rejects.toThrow('Reset failed');
  });
});

async function seedVersionOneDatabase(record: Inspection): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(FIELDNOTE_DATABASE_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('inspections', {keyPath: 'id'}).put(record);
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

async function putRawRows(rows: unknown[]): Promise<void> {
  const database = await openDatabase(FIELDNOTE_DATABASE_VERSION);
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction('inspections', 'readwrite');
    const store = transaction.objectStore('inspections');
    rows.forEach(row => store.put(row));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  database.close();
}

function openDatabase(version: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(FIELDNOTE_DATABASE_NAME, version);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('inspections', {keyPath: 'id'});
      if (version >= 2) store.createIndex('by-project-id', 'projectId', {unique: false});
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function installControlledWriteDatabase(): {
  put: ReturnType<typeof vi.fn>;
  complete: () => void;
  failRequest: (error: DOMException) => void;
  failTransaction: (error: DOMException) => void;
  abort: (error: DOMException) => void;
} {
  type Handler<T> = ((this: T, event: Event) => unknown) | null;

  const writeRequest = {
    error: null as DOMException | null,
    onerror: null as Handler<IDBRequest>,
  };
  const put = vi.fn(() => writeRequest as unknown as IDBRequest<IDBValidKey>);
  const transaction = {
    error: null as DOMException | null,
    oncomplete: null as Handler<IDBTransaction>,
    onerror: null as Handler<IDBTransaction>,
    onabort: null as Handler<IDBTransaction>,
    objectStore: vi.fn(() => ({put} as unknown as IDBObjectStore)),
    abort: vi.fn(),
  };
  const database = {
    transaction: vi.fn(() => transaction as unknown as IDBTransaction),
    close: vi.fn(),
    onversionchange: null as Handler<IDBDatabase>,
  };
  const openRequest = {
    result: database as unknown as IDBDatabase,
    error: null as DOMException | null,
    onsuccess: null as Handler<IDBOpenDBRequest>,
    onerror: null as Handler<IDBOpenDBRequest>,
    onblocked: null as Handler<IDBOpenDBRequest>,
    onupgradeneeded: null as Handler<IDBOpenDBRequest>,
  };
  const open = vi.fn(() => {
    queueMicrotask(() => openRequest.onsuccess?.call(openRequest as unknown as IDBOpenDBRequest, new Event('success')));
    return openRequest as unknown as IDBOpenDBRequest;
  });
  Object.defineProperty(globalThis, 'indexedDB', {value: {open}, configurable: true});

  return {
    put,
    complete: () => transaction.oncomplete?.call(transaction as unknown as IDBTransaction, new Event('complete')),
    failRequest: error => {
      writeRequest.error = error;
      writeRequest.onerror?.call(writeRequest as unknown as IDBRequest, new Event('error'));
    },
    failTransaction: error => {
      transaction.error = error;
      transaction.onerror?.call(transaction as unknown as IDBTransaction, new Event('error'));
    },
    abort: error => {
      transaction.error = error;
      transaction.onabort?.call(transaction as unknown as IDBTransaction, new Event('abort'));
    },
  };
}

function installControlledReadDatabase(): {
  getAll: ReturnType<typeof vi.fn>;
  succeed: (rows: unknown[]) => void;
  failRequest: (error: DOMException) => void;
  failTransaction: (error: DOMException) => void;
  abort: (error: DOMException) => void;
} {
  type Handler<T> = ((this: T, event: Event) => unknown) | null;

  const readRequest = {
    result: [] as unknown[],
    error: null as DOMException | null,
    onsuccess: null as Handler<IDBRequest>,
    onerror: null as Handler<IDBRequest>,
  };
  const getAll = vi.fn(() => readRequest as unknown as IDBRequest<unknown[]>);
  const transaction = {
    error: null as DOMException | null,
    oncomplete: null as Handler<IDBTransaction>,
    onerror: null as Handler<IDBTransaction>,
    onabort: null as Handler<IDBTransaction>,
    objectStore: vi.fn(() => ({getAll} as unknown as IDBObjectStore)),
  };
  const database = {
    transaction: vi.fn(() => transaction as unknown as IDBTransaction),
    close: vi.fn(),
    onversionchange: null as Handler<IDBDatabase>,
  };
  const openRequest = {
    result: database as unknown as IDBDatabase,
    error: null as DOMException | null,
    onsuccess: null as Handler<IDBOpenDBRequest>,
    onerror: null as Handler<IDBOpenDBRequest>,
    onblocked: null as Handler<IDBOpenDBRequest>,
    onupgradeneeded: null as Handler<IDBOpenDBRequest>,
  };
  const open = vi.fn(() => {
    queueMicrotask(() => openRequest.onsuccess?.call(openRequest as unknown as IDBOpenDBRequest, new Event('success')));
    return openRequest as unknown as IDBOpenDBRequest;
  });
  Object.defineProperty(globalThis, 'indexedDB', {value: {open}, configurable: true});

  return {
    getAll,
    succeed: rows => {
      readRequest.result = rows;
      readRequest.onsuccess?.call(readRequest as unknown as IDBRequest, new Event('success'));
      transaction.oncomplete?.call(transaction as unknown as IDBTransaction, new Event('complete'));
    },
    failRequest: error => {
      readRequest.error = error;
      readRequest.onerror?.call(readRequest as unknown as IDBRequest, new Event('error'));
    },
    failTransaction: error => {
      transaction.error = error;
      transaction.onerror?.call(transaction as unknown as IDBTransaction, new Event('error'));
    },
    abort: error => {
      transaction.error = error;
      transaction.onabort?.call(transaction as unknown as IDBTransaction, new Event('abort'));
    },
  };
}
