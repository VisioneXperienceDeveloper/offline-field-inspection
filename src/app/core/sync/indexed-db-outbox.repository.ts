import {Injectable} from '@angular/core';
import {EnqueueOutboxOperation, OutboxOperation, OutboxOperationKind} from './sync.models';

export const FIELDNOTE_OUTBOX_DATABASE_NAME = 'fieldnote-sync-outbox-db';
export const FIELDNOTE_OUTBOX_DATABASE_VERSION = 1;

const OPERATION_STORE_NAME = 'operations';
const OPERATION_ID_INDEX_NAME = 'by-operation-id';
const PROJECT_INDEX_NAME = 'by-project';
const VALID_KINDS = new Set<OutboxOperationKind>(['create', 'update', 'transition', 'delete']);

interface StoredOutboxOperation extends OutboxOperation {
  queueSequence?: number;
}

@Injectable({providedIn: 'root'})
export class IndexedDbOutboxRepository {
  private databasePromise?: Promise<IDBDatabase>;

  async enqueue(input: EnqueueOutboxOperation): Promise<OutboxOperation> {
    const operation = normalizeOperation(input);
    const database = await this.open();

    return new Promise((resolve, reject) => {
      let transaction: IDBTransaction;
      let operationError: unknown;

      try {
        transaction = database.transaction(OPERATION_STORE_NAME, 'readwrite');
      } catch (error) {
        reject(error);
        return;
      }

      transaction.oncomplete = () => resolve(operation);
      transaction.onerror = () => reject(
        transaction.error ?? operationError ?? outboxError('Outbox enqueue transaction failed.'),
      );
      transaction.onabort = () => reject(
        operationError ?? transaction.error ?? outboxError('Outbox enqueue transaction was aborted.', 'AbortError'),
      );

      try {
        const request = transaction.objectStore(OPERATION_STORE_NAME).add(operation as StoredOutboxOperation);
        request.onerror = () => {
          operationError ??= request.error ?? outboxError(`Unable to enqueue operation ${operation.operationId}.`);
        };
      } catch (error) {
        operationError = error;
        abortTransaction(transaction);
      }
    });
  }

  /** Returns this project's operations in their original enqueue order. */
  async list(projectId: string): Promise<OutboxOperation[]> {
    requireNonEmptyString(projectId, 'projectId');
    const database = await this.open();

    return new Promise((resolve, reject) => {
      let rows: StoredOutboxOperation[] = [];
      let operationError: unknown;
      let transaction: IDBTransaction;

      try {
        transaction = database.transaction(OPERATION_STORE_NAME, 'readonly');
        const request = transaction.objectStore(OPERATION_STORE_NAME)
          .index(PROJECT_INDEX_NAME)
          .getAll(IDBKeyRange.only(projectId));
        request.onsuccess = () => {
          rows = request.result as StoredOutboxOperation[];
        };
        request.onerror = () => {
          operationError = request.error ?? outboxError(`Unable to list outbox operations for ${projectId}.`);
        };
      } catch (error) {
        reject(error);
        return;
      }

      // Keep project isolation as an application-level invariant as well as an
      // IndexedDB index constraint. This also protects callers if an older or
      // damaged browser index returns an out-of-range row.
      transaction.oncomplete = () => resolve(
        rows.filter(row => row.projectId === projectId).map(publicOperation),
      );
      transaction.onerror = () => reject(
        transaction.error ?? operationError ?? outboxError('Outbox list transaction failed.'),
      );
      transaction.onabort = () => reject(
        operationError ?? transaction.error ?? outboxError('Outbox list transaction was aborted.', 'AbortError'),
      );
    });
  }

  async markAttempt(
    operationId: string,
    lastError: string | null,
    attemptedAt = new Date().toISOString(),
  ): Promise<OutboxOperation> {
    requireNonEmptyString(operationId, 'operationId');
    if (lastError !== null) requireNonEmptyString(lastError, 'lastError');
    requireIsoTimestamp(attemptedAt, 'attemptedAt');

    const database = await this.open();

    return new Promise((resolve, reject) => {
      let updated: StoredOutboxOperation | undefined;
      let operationError: unknown;
      let transaction: IDBTransaction;

      try {
        transaction = database.transaction(OPERATION_STORE_NAME, 'readwrite');
      } catch (error) {
        reject(error);
        return;
      }

      transaction.oncomplete = () => {
        if (!updated) {
          reject(outboxError(`Outbox operation ${operationId} does not exist.`, 'NotFoundError'));
          return;
        }
        resolve(publicOperation(updated));
      };
      transaction.onerror = () => reject(
        transaction.error ?? operationError ?? outboxError('Outbox attempt transaction failed.'),
      );
      transaction.onabort = () => reject(
        operationError ?? transaction.error ?? outboxError('Outbox attempt transaction was aborted.', 'AbortError'),
      );

      try {
        const store = transaction.objectStore(OPERATION_STORE_NAME);
        const request = store.index(OPERATION_ID_INDEX_NAME).get(operationId);
        request.onerror = () => {
          operationError = request.error ?? outboxError(`Unable to load operation ${operationId}.`);
        };
        request.onsuccess = () => {
          try {
            const current = request.result as StoredOutboxOperation | undefined;
            if (!current) return;
            updated = {
              ...current,
              attempts: current.attempts + 1,
              lastAttemptAt: attemptedAt,
              lastError,
            };
            const putRequest = store.put(updated);
            putRequest.onerror = () => {
              operationError ??= putRequest.error ?? outboxError(`Unable to update operation ${operationId}.`);
            };
          } catch (error) {
            operationError = error;
            abortTransaction(transaction);
          }
        };
      } catch (error) {
        operationError = error;
        abortTransaction(transaction);
      }
    });
  }

  async remove(operationId: string): Promise<void> {
    requireNonEmptyString(operationId, 'operationId');
    const database = await this.open();

    return new Promise((resolve, reject) => {
      let operationError: unknown;
      let transaction: IDBTransaction;

      try {
        transaction = database.transaction(OPERATION_STORE_NAME, 'readwrite');
      } catch (error) {
        reject(error);
        return;
      }

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(
        transaction.error ?? operationError ?? outboxError('Outbox removal transaction failed.'),
      );
      transaction.onabort = () => reject(
        operationError ?? transaction.error ?? outboxError('Outbox removal transaction was aborted.', 'AbortError'),
      );

      try {
        const store = transaction.objectStore(OPERATION_STORE_NAME);
        const request = store.index(OPERATION_ID_INDEX_NAME).getKey(operationId);
        request.onerror = () => {
          operationError = request.error ?? outboxError(`Unable to find operation ${operationId}.`);
        };
        request.onsuccess = () => {
          if (request.result === undefined) return;
          const deleteRequest = store.delete(request.result);
          deleteRequest.onerror = () => {
            operationError ??= deleteRequest.error ?? outboxError(`Unable to remove operation ${operationId}.`);
          };
        };
      } catch (error) {
        operationError = error;
        abortTransaction(transaction);
      }
    });
  }

  /** Atomically removes this inspection's queued work after explicit conflict resolution. */
  async removeForInspection(projectId: string, inspectionId: string): Promise<number> {
    requireNonEmptyString(projectId, 'projectId');
    requireNonEmptyString(inspectionId, 'inspectionId');
    const database = await this.open();

    return new Promise((resolve, reject) => {
      let removed = 0;
      let operationError: unknown;
      let transaction: IDBTransaction;

      try {
        transaction = database.transaction(OPERATION_STORE_NAME, 'readwrite');
      } catch (error) {
        reject(error);
        return;
      }

      transaction.oncomplete = () => resolve(removed);
      transaction.onerror = () => reject(
        transaction.error ?? operationError ?? outboxError('Conflict queue cleanup transaction failed.'),
      );
      transaction.onabort = () => reject(
        operationError ?? transaction.error ?? outboxError('Conflict queue cleanup was aborted.', 'AbortError'),
      );

      try {
        const request = transaction.objectStore(OPERATION_STORE_NAME)
          .index(PROJECT_INDEX_NAME)
          .openCursor(IDBKeyRange.only(projectId));
        request.onerror = () => {
          operationError = request.error ?? outboxError(`Unable to inspect queued operations for ${inspectionId}.`);
        };
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          const row = cursor.value as StoredOutboxOperation;
          if (row.projectId === projectId && row.inspectionId === inspectionId) {
            const deleteRequest = cursor.delete();
            deleteRequest.onerror = () => {
              operationError ??= deleteRequest.error ?? outboxError(`Unable to remove queued work for ${inspectionId}.`);
            };
            removed += 1;
          }
          cursor.continue();
        };
      } catch (error) {
        operationError = error;
        abortTransaction(transaction);
      }
    });
  }

  /** Closes the cached connection without deleting queued work. */
  async close(): Promise<void> {
    const pendingDatabase = this.databasePromise;
    this.databasePromise = undefined;
    if (!pendingDatabase) return;

    try {
      (await pendingDatabase).close();
    } catch {
      // A failed open has no connection to close; its original caller receives that error.
    }
  }

  /** Deletes every queued operation. Intended for explicit local reset and test isolation. */
  async reset(): Promise<void> {
    await this.close();

    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(FIELDNOTE_OUTBOX_DATABASE_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? outboxError('Unable to reset the outbox database.'));
      request.onblocked = () => reject(
        outboxError('Outbox database reset is blocked by another open connection.', 'InvalidStateError'),
      );
    });
  }

  private open(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise;

    let settled = false;
    const pendingDatabase = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(FIELDNOTE_OUTBOX_DATABASE_NAME, FIELDNOTE_OUTBOX_DATABASE_VERSION);
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      request.onupgradeneeded = () => {
        try {
          const database = request.result;
          if (database.objectStoreNames.contains(OPERATION_STORE_NAME)) return;
          const store = database.createObjectStore(OPERATION_STORE_NAME, {
            keyPath: 'queueSequence',
            autoIncrement: true,
          });
          store.createIndex(OPERATION_ID_INDEX_NAME, 'operationId', {unique: true});
          // Duplicate index keys are returned in primary-key order. The auto-increment
          // primary key therefore preserves enqueue order inside each project.
          store.createIndex(PROJECT_INDEX_NAME, 'projectId', {unique: false});
        } catch (error) {
          request.transaction?.abort();
          fail(error);
        }
      };
      request.onsuccess = () => {
        if (settled) {
          request.result.close();
          return;
        }

        settled = true;
        const database = request.result;
        database.onversionchange = () => {
          database.close();
          if (this.databasePromise === pendingDatabase) this.databasePromise = undefined;
        };
        resolve(database);
      };
      request.onerror = () => fail(request.error ?? outboxError('Unable to open the outbox database.'));
      request.onblocked = () => fail(
        outboxError('Outbox database upgrade is blocked by another open connection.', 'InvalidStateError'),
      );
    });

    this.databasePromise = pendingDatabase;
    void pendingDatabase.catch(() => {
      if (this.databasePromise === pendingDatabase) this.databasePromise = undefined;
    });
    return pendingDatabase;
  }
}

function normalizeOperation(input: EnqueueOutboxOperation): OutboxOperation {
  requireNonEmptyString(input.operationId, 'operationId');
  requireNonEmptyString(input.idempotencyKey, 'idempotencyKey');
  if (!VALID_KINDS.has(input.kind)) throw new TypeError('kind must be create, update, transition, or delete.');
  requireNonEmptyString(input.identityId, 'identityId');
  requireNonEmptyString(input.projectId, 'projectId');
  requireNonEmptyString(input.inspectionId, 'inspectionId');
  if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0) {
    throw new TypeError('baseRevision must be a non-negative safe integer.');
  }
  if (!isPlainObject(input.payload)) throw new TypeError('payload must be a plain object.');
  requireIsoTimestamp(input.createdAt, 'createdAt');

  const attempts = input.attempts ?? 0;
  if (!Number.isSafeInteger(attempts) || attempts < 0) {
    throw new TypeError('attempts must be a non-negative safe integer.');
  }
  if (input.lastAttemptAt !== undefined && input.lastAttemptAt !== null) {
    requireIsoTimestamp(input.lastAttemptAt, 'lastAttemptAt');
  }
  if (input.lastError !== undefined && input.lastError !== null) {
    requireNonEmptyString(input.lastError, 'lastError');
  }

  return {
    operationId: input.operationId,
    idempotencyKey: input.idempotencyKey,
    kind: input.kind,
    identityId: input.identityId,
    projectId: input.projectId,
    inspectionId: input.inspectionId,
    baseRevision: input.baseRevision,
    payload: input.payload,
    createdAt: input.createdAt,
    attempts,
    lastAttemptAt: input.lastAttemptAt ?? null,
    lastError: input.lastError ?? null,
  };
}

function publicOperation(stored: StoredOutboxOperation): OutboxOperation {
  const {queueSequence: _queueSequence, ...operation} = stored;
  return operation;
}

function requireNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
}

function requireIsoTimestamp(value: unknown, field: string): asserts value is string {
  requireNonEmptyString(value, field);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${field} must be an ISO-8601 UTC timestamp.`);
  }
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function abortTransaction(transaction: IDBTransaction): void {
  try {
    transaction.abort();
  } catch {
    // The transaction may already be aborting. Its event handler retains the original error.
  }
}

function outboxError(message: string, name = 'UnknownError'): DOMException {
  return new DOMException(message, name);
}
