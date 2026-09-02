import {IDBFactory, IDBKeyRange as FakeIDBKeyRange} from 'fake-indexeddb';
import {
  FIELDNOTE_OUTBOX_DATABASE_NAME,
  IndexedDbOutboxRepository,
} from './indexed-db-outbox.repository';
import {EnqueueOutboxOperation} from './sync.models';

function operation(
  operationId: string,
  projectId = 'project-c3',
  createdAt = '2026-09-02T01:00:00.000Z',
): EnqueueOutboxOperation {
  return {
    operationId,
    idempotencyKey: `idem-${operationId}`,
    kind: 'update',
    identityId: 'demo-inspector',
    projectId,
    inspectionId: `INSP-${operationId}`,
    baseRevision: 2,
    payload: {weather: 'Rain'},
    createdAt,
  };
}

describe('IndexedDbOutboxRepository', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'indexedDB', {value: new IDBFactory(), configurable: true});
    Object.defineProperty(globalThis, 'IDBKeyRange', {value: FakeIDBKeyRange, configurable: true});
  });

  it('round-trips every durable field and initializes attempt metadata', async () => {
    const repository = new IndexedDbOutboxRepository();
    const input = operation('op-001');

    await expect(repository.enqueue(input)).resolves.toEqual({
      ...input,
      attempts: 0,
      lastAttemptAt: null,
      lastError: null,
    });

    await expect(repository.list('project-c3')).resolves.toEqual([{
      ...input,
      attempts: 0,
      lastAttemptAt: null,
      lastError: null,
    }]);
  });

  it('keeps enqueue order for identical timestamps and isolates projects', async () => {
    const repository = new IndexedDbOutboxRepository();
    const secondLexically = operation('op-z');
    const firstLexically = operation('op-a');
    const anotherProject = operation('op-p2', 'project-p2');

    await repository.enqueue(secondLexically);
    await repository.enqueue(anotherProject);
    await repository.enqueue(firstLexically);

    expect((await repository.list('project-c3')).map(item => item.operationId)).toEqual(['op-z', 'op-a']);
    expect((await repository.list('project-p2')).map(item => item.operationId)).toEqual(['op-p2']);
    await expect(repository.list('project-north')).resolves.toEqual([]);
  });

  it('increments attempts without changing the original actor and records retry details', async () => {
    const repository = new IndexedDbOutboxRepository();
    await repository.enqueue(operation('op-retry'));

    const first = await repository.markAttempt(
      'op-retry',
      'Network unavailable',
      '2026-09-02T01:05:00.000Z',
    );
    const second = await repository.markAttempt(
      'op-retry',
      null,
      '2026-09-02T01:06:00.000Z',
    );

    expect(first).toMatchObject({
      identityId: 'demo-inspector',
      attempts: 1,
      lastAttemptAt: '2026-09-02T01:05:00.000Z',
      lastError: 'Network unavailable',
    });
    expect(second).toMatchObject({
      identityId: 'demo-inspector',
      attempts: 2,
      lastAttemptAt: '2026-09-02T01:06:00.000Z',
      lastError: null,
    });
  });

  it('removes an acknowledged operation and treats a missing removal as idempotent', async () => {
    const repository = new IndexedDbOutboxRepository();
    await repository.enqueue(operation('op-remove'));

    await repository.remove('op-remove');
    await repository.remove('op-remove');

    await expect(repository.list('project-c3')).resolves.toEqual([]);
  });

  it('atomically removes only one inspection queue during conflict recovery', async () => {
    const repository = new IndexedDbOutboxRepository();
    await repository.enqueue({...operation('op-a'), inspectionId: 'INSP-CONFLICT'});
    await repository.enqueue({...operation('op-b'), inspectionId: 'INSP-KEEP'});
    await repository.enqueue({...operation('op-c', 'project-p2'), inspectionId: 'INSP-CONFLICT'});

    await expect(repository.removeForInspection('project-c3', 'INSP-CONFLICT')).resolves.toBe(1);

    await expect(repository.list('project-c3')).resolves.toEqual([
      expect.objectContaining({operationId: 'op-b', inspectionId: 'INSP-KEEP'}),
    ]);
    await expect(repository.list('project-p2')).resolves.toEqual([
      expect.objectContaining({operationId: 'op-c', inspectionId: 'INSP-CONFLICT'}),
    ]);
  });

  it('rejects duplicate operation ids without overwriting the durable operation', async () => {
    const repository = new IndexedDbOutboxRepository();
    await repository.enqueue(operation('op-duplicate'));

    await expect(repository.enqueue({
      ...operation('op-duplicate'),
      payload: {weather: 'Changed'},
    })).rejects.toBeInstanceOf(DOMException);

    expect(await repository.list('project-c3')).toHaveLength(1);
    expect((await repository.list('project-c3'))[0]?.payload).toEqual({weather: 'Rain'});
  });

  it('rejects attempts for an operation that does not exist', async () => {
    const repository = new IndexedDbOutboxRepository();

    await expect(repository.markAttempt(
      'op-missing',
      'No record',
      '2026-09-02T01:05:00.000Z',
    )).rejects.toMatchObject({name: 'NotFoundError'});
  });

  it.each([
    [{...operation(''), operationId: ''}, 'operationId'],
    [{...operation('op-bad-kind'), kind: 'merge'}, 'kind'],
    [{...operation('op-bad-actor'), identityId: ''}, 'identityId'],
    [{...operation('op-bad-revision'), baseRevision: -1}, 'baseRevision'],
    [{...operation('op-bad-payload'), payload: []}, 'payload'],
    [{...operation('op-bad-created'), createdAt: 'yesterday'}, 'createdAt'],
    [{...operation('op-bad-attempts'), attempts: -1}, 'attempts'],
    [{...operation('op-bad-attempt-date'), lastAttemptAt: 'later'}, 'lastAttemptAt'],
    [{...operation('op-bad-error'), lastError: ''}, 'lastError'],
  ])('validates queued operation invariants (%s)', async (input, field) => {
    const repository = new IndexedDbOutboxRepository();
    await expect(repository.enqueue(input as EnqueueOutboxOperation)).rejects.toThrow(String(field));
  });

  it('resolves enqueue only after the IndexedDB transaction completes', async () => {
    const harness = installControlledEnqueueDatabase();
    const repository = new IndexedDbOutboxRepository();
    let resolved = false;

    const enqueuePromise = repository.enqueue(operation('op-controlled')).then(() => {
      resolved = true;
    });
    await vi.waitFor(() => expect(harness.add).toHaveBeenCalledOnce());

    expect(resolved).toBe(false);
    harness.complete();
    await enqueuePromise;
    expect(resolved).toBe(true);
  });

  it('surfaces enqueue transaction errors and aborts', async () => {
    const errorHarness = installControlledEnqueueDatabase();
    const errorRepository = new IndexedDbOutboxRepository();
    const errorPromise = errorRepository.enqueue(operation('op-error'));
    await vi.waitFor(() => expect(errorHarness.add).toHaveBeenCalledOnce());
    errorHarness.failTransaction(new DOMException('Outbox disk failure', 'UnknownError'));
    await expect(errorPromise).rejects.toThrow('Outbox disk failure');

    const abortHarness = installControlledEnqueueDatabase();
    const abortRepository = new IndexedDbOutboxRepository();
    const abortPromise = abortRepository.enqueue(operation('op-abort'));
    await vi.waitFor(() => expect(abortHarness.add).toHaveBeenCalledOnce());
    abortHarness.abort(new DOMException('Outbox quota exhausted', 'QuotaExceededError'));
    await expect(abortPromise).rejects.toThrow('Outbox quota exhausted');
  });

  it('surfaces list request, transaction-error, and abort paths', async () => {
    const abortHarness = installControlledCrudDatabase();
    const aborted = new IndexedDbOutboxRepository().list('project-c3').catch(error => error as Error);
    await vi.waitFor(() => expect(abortHarness.getAll).toHaveBeenCalledOnce());
    const readError = new DOMException('Outbox list request failed', 'UnknownError');
    abortHarness.failGetAll(readError);
    abortHarness.abort(readError);
    await expect(aborted).resolves.toMatchObject({message: 'Outbox list request failed'});

    const errorHarness = installControlledCrudDatabase();
    const failed = new IndexedDbOutboxRepository().list('project-c3').catch(error => error as Error);
    await vi.waitFor(() => expect(errorHarness.getAll).toHaveBeenCalledOnce());
    errorHarness.failTransaction(new DOMException('Outbox list transaction failed hard', 'UnknownError'));
    await expect(failed).resolves.toMatchObject({message: 'Outbox list transaction failed hard'});

    const fallbackHarness = installControlledCrudDatabase();
    const fallback = new IndexedDbOutboxRepository().list('project-c3').catch(error => error as Error);
    await vi.waitFor(() => expect(fallbackHarness.getAll).toHaveBeenCalledOnce());
    fallbackHarness.failTransactionWithoutError();
    await expect(fallback).resolves.toMatchObject({message: 'Outbox list transaction failed.'});
  });

  it('surfaces markAttempt read, update, transaction-error, and abort paths', async () => {
    const updateHarness = installControlledCrudDatabase();
    const updateFailed = new IndexedDbOutboxRepository().markAttempt(
      'op-mark',
      'Retry failed',
      '2026-09-02T01:10:00.000Z',
    ).catch(error => error as Error);
    await vi.waitFor(() => expect(updateHarness.get).toHaveBeenCalledOnce());
    updateHarness.succeedGet(storedOperation('op-mark'));
    await vi.waitFor(() => expect(updateHarness.put).toHaveBeenCalledOnce());
    const putError = new DOMException('Outbox attempt update failed', 'UnknownError');
    updateHarness.failPut(putError);
    updateHarness.abort(putError);
    await expect(updateFailed).resolves.toMatchObject({message: 'Outbox attempt update failed'});

    const readHarness = installControlledCrudDatabase();
    const readFailed = new IndexedDbOutboxRepository().markAttempt(
      'op-mark',
      null,
      '2026-09-02T01:11:00.000Z',
    ).catch(error => error as Error);
    await vi.waitFor(() => expect(readHarness.get).toHaveBeenCalledOnce());
    const readError = new DOMException('Outbox attempt read failed', 'UnknownError');
    readHarness.failGet(readError);
    readHarness.failTransaction(readError);
    await expect(readFailed).resolves.toMatchObject({message: 'Outbox attempt read failed'});
  });

  it('surfaces remove lookup, delete, transaction-error, and abort paths', async () => {
    const deleteHarness = installControlledCrudDatabase();
    const deleteFailed = new IndexedDbOutboxRepository().remove('op-remove')
      .catch(error => error as Error);
    await vi.waitFor(() => expect(deleteHarness.getKey).toHaveBeenCalledOnce());
    deleteHarness.succeedGetKey(1);
    await vi.waitFor(() => expect(deleteHarness.deleteRecord).toHaveBeenCalledOnce());
    const deleteError = new DOMException('Outbox delete failed', 'UnknownError');
    deleteHarness.failDelete(deleteError);
    deleteHarness.abort(deleteError);
    await expect(deleteFailed).resolves.toMatchObject({message: 'Outbox delete failed'});

    const lookupHarness = installControlledCrudDatabase();
    const lookupFailed = new IndexedDbOutboxRepository().remove('op-remove')
      .catch(error => error as Error);
    await vi.waitFor(() => expect(lookupHarness.getKey).toHaveBeenCalledOnce());
    const lookupError = new DOMException('Outbox lookup failed', 'UnknownError');
    lookupHarness.failGetKey(lookupError);
    lookupHarness.failTransaction(lookupError);
    await expect(lookupFailed).resolves.toMatchObject({message: 'Outbox lookup failed'});
  });

  it('surfaces database open failures and permits a later retry', async () => {
    const workingIndexedDb = new IDBFactory();
    const request = {
      error: new DOMException('Outbox unavailable'),
      onerror: null as ((event: Event) => unknown) | null,
    } as unknown as IDBOpenDBRequest;
    const open = vi.fn(() => {
      queueMicrotask(() => request.onerror?.call(request, new Event('error')));
      return request;
    });
    Object.defineProperty(globalThis, 'indexedDB', {value: {open}, configurable: true});
    const repository = new IndexedDbOutboxRepository();

    await expect(repository.list('project-c3')).rejects.toThrow('Outbox unavailable');

    Object.defineProperty(globalThis, 'indexedDB', {value: workingIndexedDb, configurable: true});
    await expect(repository.list('project-c3')).resolves.toEqual([]);
  });

  it('closes and resets the dedicated database', async () => {
    const repository = new IndexedDbOutboxRepository();
    await repository.enqueue(operation('op-reset'));

    await repository.close();
    await repository.reset();

    await expect(repository.list('project-c3')).resolves.toEqual([]);
  });

  it('surfaces blocked database resets', async () => {
    const request = {
      error: null,
      onsuccess: null as ((event: Event) => unknown) | null,
      onerror: null as ((event: Event) => unknown) | null,
      onblocked: null as ((event: Event) => unknown) | null,
    };
    Object.defineProperty(globalThis, 'indexedDB', {
      value: {
        deleteDatabase: vi.fn(() => {
          queueMicrotask(() => request.onblocked?.(new Event('blocked')));
          return request;
        }),
      },
      configurable: true,
    });

    await expect(new IndexedDbOutboxRepository().reset()).rejects.toMatchObject({name: 'InvalidStateError'});
  });

  it('surfaces database reset request failures', async () => {
    const request = {
      error: new DOMException('Outbox reset failed', 'UnknownError'),
      onsuccess: null as ((event: Event) => unknown) | null,
      onerror: null as ((event: Event) => unknown) | null,
      onblocked: null as ((event: Event) => unknown) | null,
    };
    Object.defineProperty(globalThis, 'indexedDB', {
      value: {
        deleteDatabase: vi.fn(() => {
          queueMicrotask(() => request.onerror?.(new Event('error')));
          return request;
        }),
      },
      configurable: true,
    });

    await expect(new IndexedDbOutboxRepository().reset()).rejects.toThrow('Outbox reset failed');
  });

  it('uses a database separate from inspection and photo storage', () => {
    expect(FIELDNOTE_OUTBOX_DATABASE_NAME).toBe('fieldnote-sync-outbox-db');
  });
});

function installControlledEnqueueDatabase(): {
  add: ReturnType<typeof vi.fn>;
  complete: () => void;
  failTransaction: (error: DOMException) => void;
  abort: (error: DOMException) => void;
} {
  type Handler<T> = ((this: T, event: Event) => unknown) | null;

  const addRequest = {
    error: null as DOMException | null,
    onerror: null as Handler<IDBRequest>,
  };
  const add = vi.fn(() => addRequest as unknown as IDBRequest<IDBValidKey>);
  const transaction = {
    error: null as DOMException | null,
    oncomplete: null as Handler<IDBTransaction>,
    onerror: null as Handler<IDBTransaction>,
    onabort: null as Handler<IDBTransaction>,
    objectStore: vi.fn(() => ({add} as unknown as IDBObjectStore)),
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
    queueMicrotask(() => openRequest.onsuccess?.call(
      openRequest as unknown as IDBOpenDBRequest,
      new Event('success'),
    ));
    return openRequest as unknown as IDBOpenDBRequest;
  });
  Object.defineProperty(globalThis, 'indexedDB', {value: {open}, configurable: true});

  return {
    add,
    complete: () => transaction.oncomplete?.call(
      transaction as unknown as IDBTransaction,
      new Event('complete'),
    ),
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

function storedOperation(operationId: string): Record<string, unknown> {
  return {
    ...operation(operationId),
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
    queueSequence: 1,
  };
}

function installControlledCrudDatabase(): {
  getAll: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  getKey: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  deleteRecord: ReturnType<typeof vi.fn>;
  succeedGet: (value: Record<string, unknown>) => void;
  succeedGetKey: (value: IDBValidKey) => void;
  failGetAll: (error: DOMException) => void;
  failGet: (error: DOMException) => void;
  failGetKey: (error: DOMException) => void;
  failPut: (error: DOMException) => void;
  failDelete: (error: DOMException) => void;
  failTransaction: (error: DOMException) => void;
  failTransactionWithoutError: () => void;
  abort: (error: DOMException) => void;
} {
  type Handler<T> = ((this: T, event: Event) => unknown) | null;

  const makeRequest = <T>(initial: T) => ({
    result: initial,
    error: null as DOMException | null,
    onsuccess: null as Handler<IDBRequest>,
    onerror: null as Handler<IDBRequest>,
  });
  const getAllRequest = makeRequest<unknown[]>([]);
  const getRequest = makeRequest<unknown>(undefined);
  const getKeyRequest = makeRequest<IDBValidKey | undefined>(undefined);
  const putRequest = makeRequest<IDBValidKey | undefined>(undefined);
  const deleteRequest = makeRequest<undefined>(undefined);

  const getAll = vi.fn(() => getAllRequest as unknown as IDBRequest<unknown[]>);
  const get = vi.fn(() => getRequest as unknown as IDBRequest<unknown>);
  const getKey = vi.fn(() => getKeyRequest as unknown as IDBRequest<IDBValidKey | undefined>);
  const put = vi.fn(() => putRequest as unknown as IDBRequest<IDBValidKey>);
  const deleteRecord = vi.fn(() => deleteRequest as unknown as IDBRequest<undefined>);
  const index = {getAll, get, getKey};
  const store = {
    index: vi.fn(() => index as unknown as IDBIndex),
    put,
    delete: deleteRecord,
  };
  const transaction = {
    error: null as DOMException | null,
    oncomplete: null as Handler<IDBTransaction>,
    onerror: null as Handler<IDBTransaction>,
    onabort: null as Handler<IDBTransaction>,
    objectStore: vi.fn(() => store as unknown as IDBObjectStore),
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
  Object.defineProperty(globalThis, 'indexedDB', {
    value: {
      open: vi.fn(() => {
        queueMicrotask(() => openRequest.onsuccess?.call(
          openRequest as unknown as IDBOpenDBRequest,
          new Event('success'),
        ));
        return openRequest as unknown as IDBOpenDBRequest;
      }),
    },
    configurable: true,
  });

  const fail = (request: ReturnType<typeof makeRequest>, error: DOMException) => {
    request.error = error;
    request.onerror?.call(request as unknown as IDBRequest, new Event('error'));
  };

  return {
    getAll,
    get,
    getKey,
    put,
    deleteRecord,
    succeedGet: value => {
      getRequest.result = value;
      getRequest.onsuccess?.call(getRequest as unknown as IDBRequest, new Event('success'));
    },
    succeedGetKey: value => {
      getKeyRequest.result = value;
      getKeyRequest.onsuccess?.call(getKeyRequest as unknown as IDBRequest, new Event('success'));
    },
    failGetAll: error => fail(getAllRequest, error),
    failGet: error => fail(getRequest, error),
    failGetKey: error => fail(getKeyRequest, error),
    failPut: error => fail(putRequest, error),
    failDelete: error => fail(deleteRequest, error),
    failTransaction: error => {
      transaction.error = error;
      transaction.onerror?.call(transaction as unknown as IDBTransaction, new Event('error'));
    },
    failTransactionWithoutError: () => {
      transaction.onerror?.call(transaction as unknown as IDBTransaction, new Event('error'));
    },
    abort: error => {
      transaction.error = error;
      transaction.onabort?.call(transaction as unknown as IDBTransaction, new Event('abort'));
    },
  };
}
