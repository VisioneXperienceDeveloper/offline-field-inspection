import {Injectable} from '@angular/core';
import {Inspection} from '../models/inspection.models';

export const FIELDNOTE_DATABASE_NAME = 'fieldnote-production-db';
export const FIELDNOTE_DATABASE_VERSION = 2;

const INSPECTION_STORE_NAME = 'inspections';
const PROJECT_INDEX_NAME = 'by-project-id';

export interface QuarantinedInspectionRow {
  rowIndex: number;
  recordId: string | null;
  reason: string;
}

export interface InspectionLoadReport {
  inspections: Inspection[];
  quarantinedRows: QuarantinedInspectionRow[];
}

@Injectable({providedIn: 'root'})
export class IndexedDbInspectionRepository {
  private databasePromise?: Promise<IDBDatabase>;

  async loadAll(): Promise<Inspection[]> {
    return (await this.loadAllWithReport()).inspections;
  }

  async loadAllWithReport(): Promise<InspectionLoadReport> {
    const database = await this.open();

    return new Promise((resolve, reject) => {
      let rows: unknown[] = [];
      let requestError: DOMException | null = null;
      let transaction: IDBTransaction;

      try {
        transaction = database.transaction(INSPECTION_STORE_NAME, 'readonly');
        const request = transaction.objectStore(INSPECTION_STORE_NAME).getAll();
        request.onsuccess = () => {
          rows = request.result as unknown[];
        };
        request.onerror = () => {
          requestError = request.error;
          reject(request.error ?? indexedDbError('Unable to read saved inspections.'));
        };
      } catch (error) {
        reject(error);
        return;
      }

      transaction.oncomplete = () => resolve(validateRows(rows));
      transaction.onerror = () => {
        reject(transaction.error ?? requestError ?? indexedDbError('Inspection read transaction failed.'));
      };
      transaction.onabort = () => {
        reject(transaction.error ?? requestError ?? indexedDbError('Inspection read transaction was aborted.', 'AbortError'));
      };
    });
  }

  async save(inspection: Inspection): Promise<void> {
    await this.write([inspection]);
  }

  async saveMany(inspections: Inspection[]): Promise<void> {
    await this.write(inspections);
  }

  /** Closes the cached connection. Safe to call after a failed open attempt. */
  async close(): Promise<void> {
    const pendingDatabase = this.databasePromise;
    this.databasePromise = undefined;

    if (!pendingDatabase) return;

    try {
      (await pendingDatabase).close();
    } catch {
      // A failed open has no connection to close. Its original caller receives the error.
    }
  }

  /** Deletes local data after closing this repository's connection. Intended for explicit reset and test isolation. */
  async reset(): Promise<void> {
    await this.close();

    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(FIELDNOTE_DATABASE_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? indexedDbError('Unable to reset the inspection database.'));
      request.onblocked = () => reject(indexedDbError('Inspection database reset is blocked by another open connection.', 'InvalidStateError'));
    });
  }

  private async write(inspections: Inspection[]): Promise<void> {
    const database = await this.open();

    return new Promise((resolve, reject) => {
      let transaction: IDBTransaction;
      let requestError: DOMException | null = null;

      try {
        transaction = database.transaction(INSPECTION_STORE_NAME, 'readwrite');
      } catch (error) {
        reject(error);
        return;
      }

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => {
        reject(transaction.error ?? requestError ?? indexedDbError('Inspection write transaction failed.'));
      };
      transaction.onabort = () => {
        reject(transaction.error ?? requestError ?? indexedDbError('Inspection write transaction was aborted.', 'AbortError'));
      };

      try {
        const store = transaction.objectStore(INSPECTION_STORE_NAME);
        for (const inspection of inspections) {
          const request = store.put(inspection);
          request.onerror = () => {
            requestError ??= request.error;
            reject(request.error ?? indexedDbError(`Unable to save inspection ${inspection.id}.`));
          };
        }
      } catch (error) {
        try {
          transaction.abort();
        } finally {
          reject(error);
        }
      }
    });
  }

  private open(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise;

    let settled = false;
    const pendingDatabase = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(FIELDNOTE_DATABASE_NAME, FIELDNOTE_DATABASE_VERSION);
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      request.onupgradeneeded = event => {
        try {
          migrateDatabase(request, (event as IDBVersionChangeEvent).oldVersion);
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
      request.onerror = () => fail(request.error ?? indexedDbError('Unable to open the inspection database.'));
      request.onblocked = () => fail(indexedDbError('Inspection database upgrade is blocked by another open connection.', 'InvalidStateError'));
    });

    this.databasePromise = pendingDatabase;
    void pendingDatabase.catch(() => {
      if (this.databasePromise === pendingDatabase) this.databasePromise = undefined;
    });
    return pendingDatabase;
  }
}

function migrateDatabase(request: IDBOpenDBRequest, oldVersion: number): void {
  const database = request.result;
  const transaction = request.transaction;
  if (!transaction) throw indexedDbError('Database migration transaction is unavailable.');

  const store = oldVersion < 1 || !database.objectStoreNames.contains(INSPECTION_STORE_NAME)
    ? database.createObjectStore(INSPECTION_STORE_NAME, {keyPath: 'id'})
    : transaction.objectStore(INSPECTION_STORE_NAME);

  if (oldVersion < 2 && !store.indexNames.contains(PROJECT_INDEX_NAME)) {
    store.createIndex(PROJECT_INDEX_NAME, 'projectId', {unique: false});
  }
}

function validateRows(rows: unknown[]): InspectionLoadReport {
  const inspections: Inspection[] = [];
  const quarantinedRows: QuarantinedInspectionRow[] = [];

  rows.forEach((row, rowIndex) => {
    const reason = invalidInspectionReason(row);
    if (!reason) {
      inspections.push(row as Inspection);
      return;
    }

    quarantinedRows.push({
      rowIndex,
      recordId: recordId(row),
      reason,
    });
  });

  return {inspections, quarantinedRows};
}

function invalidInspectionReason(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'Row is not an object.';

  const row = value as Record<string, unknown>;
  for (const field of ['id', 'title', 'templateId', 'projectId'] as const) {
    if (typeof row[field] !== 'string' || row[field].length === 0) return `Missing or invalid ${field}.`;
  }

  if (!['Draft', 'Submitted', 'Approved'].includes(String(row['status']))) return 'Missing or invalid status.';
  if (!['synced', 'pending', 'syncing', 'failed', 'conflicted'].includes(String(row['syncStatus']))) return 'Missing or invalid syncStatus.';
  if (!Array.isArray(row['checklist'])) return 'Missing or invalid checklist.';
  if (!Array.isArray(row['photos'])) return 'Missing or invalid photos.';
  if (!Array.isArray(row['auditTrail'])) return 'Missing or invalid auditTrail.';

  return null;
}

function recordId(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = (value as Record<string, unknown>)['id'];
  return typeof id === 'string' ? id : null;
}

function indexedDbError(message: string, name = 'UnknownError'): DOMException {
  return new DOMException(message, name);
}
