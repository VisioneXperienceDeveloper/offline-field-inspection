import {IDBFactory, IDBKeyRange as FakeIDBKeyRange} from 'fake-indexeddb';
import {
  FIELDNOTE_PHOTO_DATABASE_NAME,
  IndexedDbPhotoRepository,
  MAX_PHOTO_BLOB_BYTES,
  MAX_PROJECT_PHOTO_BYTES,
  PhotoBlobSaveInput,
  PhotoStorageLimits,
} from './indexed-db-photo.repository';

const nativeStructuredClone = globalThis.structuredClone;

describe('IndexedDbPhotoRepository', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'indexedDB', {value: new IDBFactory(), configurable: true});
    Object.defineProperty(globalThis, 'IDBKeyRange', {value: FakeIDBKeyRange, configurable: true});
    Object.defineProperty(globalThis, 'structuredClone', {value: structuredCloneWithJsdomBlobs, configurable: true});
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'structuredClone', {value: nativeStructuredClone, configurable: true});
  });

  it('round-trips blobs and derives byteSize after compression', async () => {
    const repository = new IndexedDbPhotoRepository();
    const source = photo('photo-1', 'camera payload');

    const saved = await repository.save(source);
    const loaded = await repository.load(source.photoId);

    expect(saved.byteSize).toBe(source.blob.size);
    expect(loaded).toMatchObject({
      photoId: source.photoId,
      inspectionId: source.inspectionId,
      projectId: source.projectId,
      mimeType: source.mimeType,
      createdAt: source.createdAt,
      byteSize: source.blob.size,
    });
    expect(await readBlobText(loaded?.blob)).toBe('camera payload');
    expect(loaded?.blob.type).toBe('image/jpeg');
  });

  it('lists only the requested inspection and totals only the requested project', async () => {
    const repository = new IndexedDbPhotoRepository();
    await repository.save(photo('photo-1', '123', {inspectionId: 'inspection-a', projectId: 'project-a'}));
    await repository.save(photo('photo-2', '12345', {inspectionId: 'inspection-a', projectId: 'project-a'}));
    await repository.save(photo('photo-3', '1234567', {inspectionId: 'inspection-b', projectId: 'project-b'}));

    const inspectionPhotos = await repository.listByInspection('inspection-a');

    expect(inspectionPhotos.map(item => item.photoId)).toEqual(['photo-1', 'photo-2']);
    await expect(repository.getProjectByteSize('project-a')).resolves.toBe(8);
    await expect(repository.getProjectByteSize('project-b')).resolves.toBe(7);
    await expect(repository.getProjectByteSize('project-without-photos')).resolves.toBe(0);
  });

  it('uses the overwrite delta rather than double-counting an existing photo', async () => {
    const repository = new IndexedDbPhotoRepository(limits(10, 10));
    await repository.save(photoOfSize('photo-1', 6));
    await repository.save(photoOfSize('photo-2', 4));

    await repository.save(photoOfSize('photo-1', 5));
    await repository.save(photoOfSize('photo-3', 1));

    await expect(repository.getProjectByteSize('project-a')).resolves.toBe(10);
    await expect(repository.load('photo-1')).resolves.toMatchObject({byteSize: 5});
  });

  it('updates both project totals when an existing photo moves projects', async () => {
    const repository = new IndexedDbPhotoRepository(limits(10, 10));
    await repository.save(photoOfSize('photo-1', 6, {projectId: 'project-a'}));

    await repository.save(photoOfSize('photo-1', 4, {projectId: 'project-b'}));

    await expect(repository.getProjectByteSize('project-a')).resolves.toBe(0);
    await expect(repository.getProjectByteSize('project-b')).resolves.toBe(4);
  });

  it('enforces the five MiB post-compression default and exposes the 100 MiB project default', async () => {
    expect(MAX_PHOTO_BLOB_BYTES).toBe(5 * 1024 * 1024);
    expect(MAX_PROJECT_PHOTO_BYTES).toBe(100 * 1024 * 1024);
    const repository = new IndexedDbPhotoRepository();

    await expect(repository.save(photoOfSize('too-large', MAX_PHOTO_BLOB_BYTES + 1))).rejects.toMatchObject({
      name: 'QuotaExceededError',
    });
    await expect(repository.load('too-large')).resolves.toBeNull();
  });

  it('allows the exact project quota and atomically rejects the next byte', async () => {
    const repository = new IndexedDbPhotoRepository(limits(6, 10));
    await repository.save(photoOfSize('photo-1', 6));
    await repository.save(photoOfSize('photo-2', 4));

    await expect(repository.save(photoOfSize('photo-3', 1))).rejects.toMatchObject({name: 'QuotaExceededError'});
    await expect(repository.getProjectByteSize('project-a')).resolves.toBe(10);
    await expect(repository.load('photo-3')).resolves.toBeNull();

    await expect(repository.save(photoOfSize('photo-4', 6, {projectId: 'project-b'}))).resolves.toMatchObject({
      byteSize: 6,
    });
  });

  it('removes blobs and resolves only after the removal transaction completes', async () => {
    const repository = new IndexedDbPhotoRepository();
    await repository.save(photo('photo-1', 'remove me'));

    await repository.remove('photo-1');

    await expect(repository.load('photo-1')).resolves.toBeNull();
    await expect(repository.listByInspection('inspection-a')).resolves.toEqual([]);
    await expect(repository.getProjectByteSize('project-a')).resolves.toBe(0);
  });

  it('closes and resets the separate photo database for isolated reuse', async () => {
    const repository = new IndexedDbPhotoRepository();
    await repository.save(photo('photo-1', 'persisted'));

    await repository.close();
    expect(await repository.load('photo-1')).not.toBeNull();
    await repository.reset();

    await expect(repository.load('photo-1')).resolves.toBeNull();
  });

  it('does not resolve save until the readwrite transaction completes', async () => {
    const harness = installControlledPhotoDatabase();
    const repository = new IndexedDbPhotoRepository(limits(10, 100));
    let resolved = false;
    const pendingSave = repository.save(photoOfSize('photo-1', 3)).then(() => {
      resolved = true;
    });
    await vi.waitFor(() => expect(harness.openKeyCursor).toHaveBeenCalledOnce());

    harness.finishQuotaScan();
    await vi.waitFor(() => expect(harness.put).toHaveBeenCalledOnce());
    expect(resolved).toBe(false);

    harness.complete();
    await pendingSave;
    expect(resolved).toBe(true);
  });

  it('propagates quota cursor request errors', async () => {
    const harness = installControlledPhotoDatabase();
    const repository = new IndexedDbPhotoRepository(limits(10, 100));
    const pendingSave = repository.save(photoOfSize('photo-1', 3));
    await vi.waitFor(() => expect(harness.openKeyCursor).toHaveBeenCalledOnce());

    harness.failCursorRequest(new DOMException('Usage lookup failed', 'UnknownError'));

    await expect(pendingSave).rejects.toThrow('Usage lookup failed');
  });

  it('propagates put request errors', async () => {
    const harness = installControlledPhotoDatabase();
    const repository = new IndexedDbPhotoRepository(limits(10, 100));
    const pendingSave = repository.save(photoOfSize('photo-1', 3));
    await vi.waitFor(() => expect(harness.openKeyCursor).toHaveBeenCalledOnce());
    harness.finishQuotaScan();
    await vi.waitFor(() => expect(harness.put).toHaveBeenCalledOnce());

    harness.failPutRequest(new DOMException('Blob write failed', 'DataError'));

    await expect(pendingSave).rejects.toThrow('Blob write failed');
  });

  it('propagates transaction errors and abort reasons', async () => {
    const errorHarness = installControlledPhotoDatabase();
    const errorRepository = new IndexedDbPhotoRepository(limits(10, 100));
    const failedSave = errorRepository.save(photoOfSize('photo-1', 3));
    await vi.waitFor(() => expect(errorHarness.openKeyCursor).toHaveBeenCalledOnce());
    errorHarness.failTransaction(new DOMException('Transaction failed', 'UnknownError'));
    await expect(failedSave).rejects.toThrow('Transaction failed');

    const abortHarness = installControlledPhotoDatabase();
    const abortRepository = new IndexedDbPhotoRepository(limits(10, 100));
    const abortedSave = abortRepository.save(photoOfSize('photo-2', 3));
    await vi.waitFor(() => expect(abortHarness.openKeyCursor).toHaveBeenCalledOnce());
    abortHarness.abort(new DOMException('Storage aborted', 'AbortError'));
    await expect(abortedSave).rejects.toThrow('Storage aborted');
  });

  it('propagates read request errors and read transaction aborts', async () => {
    const requestHarness = installControlledPhotoDatabase();
    const requestRepository = new IndexedDbPhotoRepository();
    const failedLoad = requestRepository.load('photo-1');
    await vi.waitFor(() => expect(requestHarness.get).toHaveBeenCalledOnce());
    requestHarness.failGetRequest(new DOMException('Blob read failed', 'UnknownError'));
    await expect(failedLoad).rejects.toThrow('Blob read failed');

    const abortHarness = installControlledPhotoDatabase();
    const abortRepository = new IndexedDbPhotoRepository();
    const abortedLoad = abortRepository.load('photo-1');
    await vi.waitFor(() => expect(abortHarness.get).toHaveBeenCalledOnce());
    abortHarness.abort(new DOMException('Read aborted', 'AbortError'));
    await expect(abortedLoad).rejects.toThrow('Read aborted');
  });

  it('propagates remove and inspection-list request errors', async () => {
    const removeHarness = installControlledPhotoDatabase();
    const removeRepository = new IndexedDbPhotoRepository();
    const failedRemove = removeRepository.remove('photo-1');
    await vi.waitFor(() => expect(removeHarness.deletePhoto).toHaveBeenCalledOnce());
    removeHarness.failDeleteRequest(new DOMException('Blob delete failed', 'UnknownError'));
    await expect(failedRemove).rejects.toThrow('Blob delete failed');

    const listHarness = installControlledPhotoDatabase();
    const listRepository = new IndexedDbPhotoRepository();
    const failedList = listRepository.listByInspection('inspection-a');
    await vi.waitFor(() => expect(listHarness.getAll).toHaveBeenCalledOnce());
    listHarness.failListRequest(new DOMException('Blob list failed', 'UnknownError'));
    await expect(failedList).rejects.toThrow('Blob list failed');
  });

  it('propagates project-usage cursor errors and aborts malformed index data', async () => {
    const requestHarness = installControlledPhotoDatabase();
    const requestRepository = new IndexedDbPhotoRepository();
    const failedUsage = requestRepository.getProjectByteSize('project-a');
    await vi.waitFor(() => expect(requestHarness.openKeyCursor).toHaveBeenCalledOnce());
    requestHarness.failCursorRequest(new DOMException('Usage cursor failed', 'UnknownError'));
    await expect(failedUsage).rejects.toThrow('Usage cursor failed');

    const malformedHarness = installControlledPhotoDatabase();
    const malformedRepository = new IndexedDbPhotoRepository();
    const malformedUsage = malformedRepository.getProjectByteSize('project-a');
    await vi.waitFor(() => expect(malformedHarness.openKeyCursor).toHaveBeenCalledOnce());
    malformedHarness.abortTransaction.mockImplementationOnce(() => {
      throw new DOMException('Already inactive', 'InvalidStateError');
    });
    malformedHarness.returnMalformedCursor();
    expect(malformedHarness.abortTransaction).toHaveBeenCalledOnce();
    malformedHarness.abort(new DOMException('Transaction aborted', 'AbortError'));
    await expect(malformedUsage).rejects.toThrow('invalid key');
  });

  it('propagates transaction construction failures from each operation', async () => {
    installTransactionFailureDatabase(new DOMException('Cannot create transaction', 'InvalidStateError'));
    const repository = new IndexedDbPhotoRepository(limits(10, 100));

    await expect(repository.save(photoOfSize('photo-1', 1))).rejects.toThrow('Cannot create transaction');
    await expect(repository.load('photo-1')).rejects.toThrow('Cannot create transaction');
    await expect(repository.remove('photo-1')).rejects.toThrow('Cannot create transaction');
    await expect(repository.listByInspection('inspection-a')).rejects.toThrow('Cannot create transaction');
    await expect(repository.getProjectByteSize('project-a')).rejects.toThrow('Cannot create transaction');
  });

  it('rejects malformed metadata before opening IndexedDB', async () => {
    const open = vi.fn();
    Object.defineProperty(globalThis, 'indexedDB', {value: {open}, configurable: true});
    const repository = new IndexedDbPhotoRepository();

    await expect(repository.save({...photo('photo-1', 'x'), photoId: ' '})).rejects.toThrow('photoId');
    await expect(repository.save({...photo('photo-1', 'x'), inspectionId: ''})).rejects.toThrow('inspectionId');
    await expect(repository.save({...photo('photo-1', 'x'), projectId: ''})).rejects.toThrow('projectId');
    await expect(repository.save({...photo('photo-1', 'x'), mimeType: ''})).rejects.toThrow('mimeType');
    await expect(repository.save({...photo('photo-1', 'x'), createdAt: ''})).rejects.toThrow('createdAt');
    await expect(repository.save({...photo('photo-1', 'x'), blob: 'not-a-blob' as unknown as Blob})).rejects.toThrow('Blob');
    await expect(repository.load('')).rejects.toThrow('photoId');
    await expect(repository.remove('')).rejects.toThrow('photoId');
    await expect(repository.listByInspection('')).rejects.toThrow('inspectionId');
    await expect(repository.getProjectByteSize('')).rejects.toThrow('projectId');
    expect(open).not.toHaveBeenCalled();
  });

  it('surfaces open failures and clears the cached failure for retry', async () => {
    const workingFactory = new IDBFactory();
    const openRequest = {
      error: new DOMException('Photo database unavailable', 'UnknownError'),
      onerror: null as EventHandler<IDBOpenDBRequest>,
      onblocked: null as EventHandler<IDBOpenDBRequest>,
      onupgradeneeded: null as EventHandler<IDBOpenDBRequest>,
      onsuccess: null as EventHandler<IDBOpenDBRequest>,
    };
    Object.defineProperty(globalThis, 'indexedDB', {
      value: {
        open: vi.fn(() => {
          queueMicrotask(() => openRequest.onerror?.call(openRequest as unknown as IDBOpenDBRequest, new Event('error')));
          return openRequest as unknown as IDBOpenDBRequest;
        }),
      },
      configurable: true,
    });
    const repository = new IndexedDbPhotoRepository();

    await expect(repository.load('photo-1')).rejects.toThrow('Photo database unavailable');
    Object.defineProperty(globalThis, 'indexedDB', {value: workingFactory, configurable: true});
    await expect(repository.load('photo-1')).resolves.toBeNull();
  });

  it('closes a stale success arriving after an open failure', async () => {
    const close = vi.fn();
    const request = controlledOpenRequest({close} as unknown as IDBDatabase);
    Object.defineProperty(globalThis, 'indexedDB', {
      value: {
        open: vi.fn(() => {
          queueMicrotask(() => {
            request.error = new DOMException('Open failed first', 'UnknownError');
            request.onerror?.call(request as unknown as IDBOpenDBRequest, new Event('error'));
            request.onsuccess?.call(request as unknown as IDBOpenDBRequest, new Event('success'));
          });
          return request as unknown as IDBOpenDBRequest;
        }),
      },
      configurable: true,
    });

    await expect(new IndexedDbPhotoRepository().load('photo-1')).rejects.toThrow('Open failed first');
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  });

  it('surfaces blocked database opens', async () => {
    const request = controlledOpenRequest({close: vi.fn()} as unknown as IDBDatabase);
    Object.defineProperty(globalThis, 'indexedDB', {
      value: {
        open: vi.fn(() => {
          queueMicrotask(() => request.onblocked?.call(request as unknown as IDBOpenDBRequest, new Event('blocked')));
          return request as unknown as IDBOpenDBRequest;
        }),
      },
      configurable: true,
    });

    await expect(new IndexedDbPhotoRepository().load('photo-1')).rejects.toThrow('blocked');
  });

  it('surfaces reset errors and blocked resets', async () => {
    await expect(resetFailure('error')).rejects.toThrow('Reset failed');
    await expect(resetFailure('blocked')).rejects.toThrow('blocked');
  });
});

function photo(
  photoId: string,
  content: string,
  overrides: Partial<Omit<PhotoBlobSaveInput, 'photoId' | 'blob'>> = {},
): PhotoBlobSaveInput {
  return {
    photoId,
    inspectionId: 'inspection-a',
    projectId: 'project-a',
    mimeType: 'image/jpeg',
    createdAt: '2026-09-02T00:00:00.000Z',
    blob: new Blob([content], {type: 'image/jpeg'}),
    ...overrides,
  };
}

function photoOfSize(
  photoId: string,
  byteSize: number,
  overrides: Partial<Omit<PhotoBlobSaveInput, 'photoId' | 'blob'>> = {},
): PhotoBlobSaveInput {
  return {
    ...photo(photoId, '', overrides),
    blob: new Blob([new Uint8Array(byteSize)], {type: 'image/jpeg'}),
  };
}

function limits(maxPhotoBytes: number, maxProjectBytes: number): PhotoStorageLimits {
  return {maxPhotoBytes, maxProjectBytes};
}

function structuredCloneWithJsdomBlobs<T>(value: T): T {
  if (value instanceof Blob) return value.slice(0, value.size, value.type) as T;
  if (Array.isArray(value)) return value.map(item => structuredCloneWithJsdomBlobs(item)) as T;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, structuredCloneWithJsdomBlobs(item)]),
    ) as T;
  }
  return value;
}

function readBlobText(blob: Blob | undefined): Promise<string> {
  if (!blob) return Promise.reject(new Error('Expected a stored Blob.'));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read stored Blob.'));
    reader.readAsText(blob);
  });
}

type EventHandler<T> = ((this: T, event: Event) => unknown) | null;

function installControlledPhotoDatabase(): {
  openKeyCursor: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  getAll: ReturnType<typeof vi.fn>;
  deletePhoto: ReturnType<typeof vi.fn>;
  abortTransaction: ReturnType<typeof vi.fn>;
  finishQuotaScan: () => void;
  returnMalformedCursor: () => void;
  complete: () => void;
  failCursorRequest: (error: DOMException) => void;
  failPutRequest: (error: DOMException) => void;
  failGetRequest: (error: DOMException) => void;
  failDeleteRequest: (error: DOMException) => void;
  failListRequest: (error: DOMException) => void;
  failTransaction: (error: DOMException) => void;
  abort: (error: DOMException) => void;
} {
  const cursorRequest = requestHarness<IDBCursor | null>(null);
  const putRequest = requestHarness<IDBValidKey>('photo-1');
  const getRequest = requestHarness<unknown>(undefined);
  const deleteRequest = requestHarness<undefined>(undefined);
  const listRequest = requestHarness<unknown[]>([]);
  const openKeyCursor = vi.fn(() => cursorRequest as unknown as IDBRequest<IDBCursor | null>);
  const put = vi.fn(() => putRequest as unknown as IDBRequest<IDBValidKey>);
  const get = vi.fn(() => getRequest as unknown as IDBRequest<unknown>);
  const deletePhoto = vi.fn(() => deleteRequest as unknown as IDBRequest<undefined>);
  const getAll = vi.fn(() => listRequest as unknown as IDBRequest<unknown[]>);
  const index = vi.fn(() => ({openKeyCursor, getAll} as unknown as IDBIndex));
  const store = {index, put, get, delete: deletePhoto} as unknown as IDBObjectStore;
  const transaction = {
    error: null as DOMException | null,
    oncomplete: null as EventHandler<IDBTransaction>,
    onerror: null as EventHandler<IDBTransaction>,
    onabort: null as EventHandler<IDBTransaction>,
    objectStore: vi.fn(() => store),
    abort: vi.fn(),
  };
  const database = {
    transaction: vi.fn(() => transaction as unknown as IDBTransaction),
    close: vi.fn(),
    onversionchange: null as EventHandler<IDBDatabase>,
  };
  const openRequest = {
    result: database as unknown as IDBDatabase,
    error: null as DOMException | null,
    onsuccess: null as EventHandler<IDBOpenDBRequest>,
    onerror: null as EventHandler<IDBOpenDBRequest>,
    onblocked: null as EventHandler<IDBOpenDBRequest>,
    onupgradeneeded: null as EventHandler<IDBOpenDBRequest>,
  };
  Object.defineProperty(globalThis, 'indexedDB', {
    value: {
      open: vi.fn(() => {
        queueMicrotask(() => openRequest.onsuccess?.call(openRequest as unknown as IDBOpenDBRequest, new Event('success')));
        return openRequest as unknown as IDBOpenDBRequest;
      }),
    },
    configurable: true,
  });

  return {
    openKeyCursor,
    put,
    get,
    getAll,
    deletePhoto,
    abortTransaction: transaction.abort,
    finishQuotaScan: () => {
      cursorRequest.result = null;
      cursorRequest.onsuccess?.call(cursorRequest as unknown as IDBRequest, new Event('success'));
    },
    returnMalformedCursor: () => {
      cursorRequest.result = {
        key: ['project-a', 'not-a-number'],
        primaryKey: 'photo-1',
        continue: vi.fn(),
      } as unknown as IDBCursor;
      cursorRequest.onsuccess?.call(cursorRequest as unknown as IDBRequest, new Event('success'));
    },
    complete: () => transaction.oncomplete?.call(transaction as unknown as IDBTransaction, new Event('complete')),
    failCursorRequest: error => failRequest(cursorRequest, error),
    failPutRequest: error => failRequest(putRequest, error),
    failGetRequest: error => failRequest(getRequest, error),
    failDeleteRequest: error => failRequest(deleteRequest, error),
    failListRequest: error => failRequest(listRequest, error),
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

function installTransactionFailureDatabase(error: DOMException): void {
  const database = {
    transaction: vi.fn(() => {
      throw error;
    }),
    close: vi.fn(),
    onversionchange: null as EventHandler<IDBDatabase>,
  };
  const request = controlledOpenRequest(database as unknown as IDBDatabase);
  Object.defineProperty(globalThis, 'indexedDB', {
    value: {
      open: vi.fn(() => {
        queueMicrotask(() => request.onsuccess?.call(request as unknown as IDBOpenDBRequest, new Event('success')));
        return request as unknown as IDBOpenDBRequest;
      }),
    },
    configurable: true,
  });
}

function controlledOpenRequest(database: IDBDatabase): {
  result: IDBDatabase;
  error: DOMException | null;
  onsuccess: EventHandler<IDBOpenDBRequest>;
  onerror: EventHandler<IDBOpenDBRequest>;
  onblocked: EventHandler<IDBOpenDBRequest>;
  onupgradeneeded: EventHandler<IDBOpenDBRequest>;
} {
  return {
    result: database,
    error: null,
    onsuccess: null,
    onerror: null,
    onblocked: null,
    onupgradeneeded: null,
  };
}

function requestHarness<T>(result: T): {
  result: T;
  error: DOMException | null;
  onsuccess: EventHandler<IDBRequest>;
  onerror: EventHandler<IDBRequest>;
} {
  return {result, error: null, onsuccess: null, onerror: null};
}

function failRequest(request: ReturnType<typeof requestHarness>, error: DOMException): void {
  request.error = error;
  request.onerror?.call(request as unknown as IDBRequest, new Event('error'));
}

function resetFailure(mode: 'error' | 'blocked'): Promise<void> {
  const request = {
    error: new DOMException('Reset failed', 'UnknownError'),
    onsuccess: null as EventHandler<IDBOpenDBRequest>,
    onerror: null as EventHandler<IDBOpenDBRequest>,
    onblocked: null as EventHandler<IDBOpenDBRequest>,
  };
  Object.defineProperty(globalThis, 'indexedDB', {
    value: {
      deleteDatabase: vi.fn(() => {
        queueMicrotask(() => {
          if (mode === 'error') request.onerror?.call(request as unknown as IDBOpenDBRequest, new Event('error'));
          else request.onblocked?.call(request as unknown as IDBOpenDBRequest, new Event('blocked'));
        });
        return request as unknown as IDBOpenDBRequest;
      }),
    },
    configurable: true,
  });

  return new IndexedDbPhotoRepository().reset();
}
