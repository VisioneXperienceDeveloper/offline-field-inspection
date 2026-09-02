import {Inject, Injectable, InjectionToken, Optional} from '@angular/core';

export const FIELDNOTE_PHOTO_DATABASE_NAME = 'fieldnote-photo-blob-db';
export const FIELDNOTE_PHOTO_DATABASE_VERSION = 1;
export const MAX_PHOTO_BLOB_BYTES = 5 * 1024 * 1024;
export const MAX_PROJECT_PHOTO_BYTES = 100 * 1024 * 1024;

const PHOTO_STORE_NAME = 'photo-blobs';
const INSPECTION_INDEX_NAME = 'by-inspection-id';
const PROJECT_INDEX_NAME = 'by-project-id';
const PROJECT_BYTES_INDEX_NAME = 'by-project-byte-size';

export interface PhotoBlobRecord {
  photoId: string;
  inspectionId: string;
  projectId: string;
  mimeType: string;
  createdAt: string;
  blob: Blob;
  byteSize: number;
}

export type PhotoBlobSaveInput = Omit<PhotoBlobRecord, 'byteSize'>;

export interface PhotoStorageLimits {
  maxPhotoBytes: number;
  maxProjectBytes: number;
}

export const PHOTO_STORAGE_LIMITS = new InjectionToken<PhotoStorageLimits>('PHOTO_STORAGE_LIMITS');

const DEFAULT_LIMITS: PhotoStorageLimits = {
  maxPhotoBytes: MAX_PHOTO_BLOB_BYTES,
  maxProjectBytes: MAX_PROJECT_PHOTO_BYTES,
};

@Injectable({providedIn: 'root'})
export class IndexedDbPhotoRepository {
  private databasePromise?: Promise<IDBDatabase>;
  private readonly limits: PhotoStorageLimits;

  constructor(
    @Optional() @Inject(PHOTO_STORAGE_LIMITS) limits: PhotoStorageLimits | null = null,
  ) {
    this.limits = limits ?? DEFAULT_LIMITS;
  }

  async save(input: PhotoBlobSaveInput): Promise<PhotoBlobRecord> {
    validateInput(input);

    const record: PhotoBlobRecord = {...input, byteSize: input.blob.size};
    if (record.byteSize > this.limits.maxPhotoBytes) {
      throw quotaError(
        `Photo ${record.photoId} is ${record.byteSize} bytes; the per-photo limit is ${this.limits.maxPhotoBytes} bytes.`,
      );
    }

    const database = await this.open();

    return new Promise((resolve, reject) => {
      let transaction: IDBTransaction;
      let operationError: unknown;

      try {
        transaction = database.transaction(PHOTO_STORE_NAME, 'readwrite');
      } catch (error) {
        reject(error);
        return;
      }

      transaction.oncomplete = () => resolve(record);
      transaction.onerror = () => reject(transaction.error ?? operationError ?? photoDatabaseError('Photo write transaction failed.'));
      transaction.onabort = () => reject(
        operationError ?? transaction.error ?? photoDatabaseError('Photo write transaction was aborted.', 'AbortError'),
      );

      try {
        const store = transaction.objectStore(PHOTO_STORE_NAME);
        const request = store.index(PROJECT_BYTES_INDEX_NAME).openKeyCursor(projectByteRange(record.projectId));
        let existingProjectBytes = 0;

        request.onerror = () => {
          operationError ??= request.error ?? photoDatabaseError('Unable to calculate project photo usage.');
          reject(operationError);
        };
        request.onsuccess = () => {
          try {
            const cursor = request.result;
            if (cursor) {
              if (cursor.primaryKey !== record.photoId) existingProjectBytes += byteSizeFromIndexKey(cursor.key);
              cursor.continue();
              return;
            }

            const nextProjectBytes = existingProjectBytes + record.byteSize;
            if (nextProjectBytes > this.limits.maxProjectBytes) {
              operationError = quotaError(
                `Project ${record.projectId} would use ${nextProjectBytes} bytes; the project limit is ${this.limits.maxProjectBytes} bytes.`,
              );
              transaction.abort();
              return;
            }

            const putRequest = store.put(record);
            putRequest.onerror = () => {
              operationError ??= putRequest.error ?? photoDatabaseError(`Unable to save photo ${record.photoId}.`);
              reject(operationError);
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

  async load(photoId: string): Promise<PhotoBlobRecord | null> {
    requireNonEmptyString(photoId, 'photoId');
    const database = await this.open();

    return new Promise((resolve, reject) => {
      let result: PhotoBlobRecord | undefined;
      let requestError: unknown;
      let transaction: IDBTransaction;

      try {
        transaction = database.transaction(PHOTO_STORE_NAME, 'readonly');
        const request = transaction.objectStore(PHOTO_STORE_NAME).get(photoId);
        request.onsuccess = () => {
          result = request.result as PhotoBlobRecord | undefined;
        };
        request.onerror = () => {
          requestError = request.error ?? photoDatabaseError(`Unable to load photo ${photoId}.`);
          reject(requestError);
        };
      } catch (error) {
        reject(error);
        return;
      }

      transaction.oncomplete = () => resolve(result ?? null);
      transaction.onerror = () => reject(transaction.error ?? requestError ?? photoDatabaseError('Photo read transaction failed.'));
      transaction.onabort = () => reject(
        transaction.error ?? requestError ?? photoDatabaseError('Photo read transaction was aborted.', 'AbortError'),
      );
    });
  }

  async remove(photoId: string): Promise<void> {
    requireNonEmptyString(photoId, 'photoId');
    const database = await this.open();

    return new Promise((resolve, reject) => {
      let transaction: IDBTransaction;
      let requestError: unknown;

      try {
        transaction = database.transaction(PHOTO_STORE_NAME, 'readwrite');
        const request = transaction.objectStore(PHOTO_STORE_NAME).delete(photoId);
        request.onerror = () => {
          requestError = request.error ?? photoDatabaseError(`Unable to remove photo ${photoId}.`);
          reject(requestError);
        };
      } catch (error) {
        reject(error);
        return;
      }

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? requestError ?? photoDatabaseError('Photo removal transaction failed.'));
      transaction.onabort = () => reject(
        transaction.error ?? requestError ?? photoDatabaseError('Photo removal transaction was aborted.', 'AbortError'),
      );
    });
  }

  async listByInspection(inspectionId: string): Promise<PhotoBlobRecord[]> {
    requireNonEmptyString(inspectionId, 'inspectionId');
    const database = await this.open();

    return new Promise((resolve, reject) => {
      let result: PhotoBlobRecord[] = [];
      let requestError: unknown;
      let transaction: IDBTransaction;

      try {
        transaction = database.transaction(PHOTO_STORE_NAME, 'readonly');
        const request = transaction.objectStore(PHOTO_STORE_NAME)
          .index(INSPECTION_INDEX_NAME)
          .getAll(IDBKeyRange.only(inspectionId));
        request.onsuccess = () => {
          result = request.result as PhotoBlobRecord[];
        };
        request.onerror = () => {
          requestError = request.error ?? photoDatabaseError(`Unable to list photos for inspection ${inspectionId}.`);
          reject(requestError);
        };
      } catch (error) {
        reject(error);
        return;
      }

      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error ?? requestError ?? photoDatabaseError('Photo list transaction failed.'));
      transaction.onabort = () => reject(
        transaction.error ?? requestError ?? photoDatabaseError('Photo list transaction was aborted.', 'AbortError'),
      );
    });
  }

  async getProjectByteSize(projectId: string): Promise<number> {
    requireNonEmptyString(projectId, 'projectId');
    const database = await this.open();

    return new Promise((resolve, reject) => {
      let totalBytes = 0;
      let requestError: unknown;
      let transaction: IDBTransaction;

      try {
        transaction = database.transaction(PHOTO_STORE_NAME, 'readonly');
        const request = transaction.objectStore(PHOTO_STORE_NAME)
          .index(PROJECT_BYTES_INDEX_NAME)
          .openKeyCursor(projectByteRange(projectId));
        request.onsuccess = () => {
          try {
            const cursor = request.result;
            if (!cursor) return;
            totalBytes += byteSizeFromIndexKey(cursor.key);
            cursor.continue();
          } catch (error) {
            requestError = error;
            abortTransaction(transaction);
          }
        };
        request.onerror = () => {
          requestError = request.error ?? photoDatabaseError(`Unable to calculate photo usage for project ${projectId}.`);
          reject(requestError);
        };
      } catch (error) {
        reject(error);
        return;
      }

      transaction.oncomplete = () => resolve(totalBytes);
      transaction.onerror = () => reject(transaction.error ?? requestError ?? photoDatabaseError('Photo usage transaction failed.'));
      transaction.onabort = () => reject(
        requestError ?? transaction.error ?? photoDatabaseError('Photo usage transaction was aborted.', 'AbortError'),
      );
    });
  }

  /** Closes this repository's cached database connection without deleting data. */
  async close(): Promise<void> {
    const pendingDatabase = this.databasePromise;
    this.databasePromise = undefined;
    if (!pendingDatabase) return;

    try {
      (await pendingDatabase).close();
    } catch {
      // The open caller receives the original failure; there is no connection to close.
    }
  }

  /** Deletes photo blobs after closing this repository's connection. Intended for explicit reset and tests. */
  async reset(): Promise<void> {
    await this.close();

    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(FIELDNOTE_PHOTO_DATABASE_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? photoDatabaseError('Unable to reset the photo database.'));
      request.onblocked = () => reject(
        photoDatabaseError('Photo database reset is blocked by another open connection.', 'InvalidStateError'),
      );
    });
  }

  private open(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise;

    let settled = false;
    const pendingDatabase = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(FIELDNOTE_PHOTO_DATABASE_NAME, FIELDNOTE_PHOTO_DATABASE_VERSION);
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      request.onupgradeneeded = () => {
        try {
          migratePhotoDatabase(request);
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
      request.onerror = () => fail(request.error ?? photoDatabaseError('Unable to open the photo database.'));
      request.onblocked = () => fail(
        photoDatabaseError('Photo database upgrade is blocked by another open connection.', 'InvalidStateError'),
      );
    });

    this.databasePromise = pendingDatabase;
    void pendingDatabase.catch(() => {
      if (this.databasePromise === pendingDatabase) this.databasePromise = undefined;
    });
    return pendingDatabase;
  }
}

function migratePhotoDatabase(request: IDBOpenDBRequest): void {
  const database = request.result;
  const store = database.createObjectStore(PHOTO_STORE_NAME, {keyPath: 'photoId'});
  store.createIndex(INSPECTION_INDEX_NAME, 'inspectionId', {unique: false});
  store.createIndex(PROJECT_INDEX_NAME, 'projectId', {unique: false});
  store.createIndex(PROJECT_BYTES_INDEX_NAME, ['projectId', 'byteSize'], {unique: false});
}

function validateInput(input: PhotoBlobSaveInput): void {
  requireNonEmptyString(input.photoId, 'photoId');
  requireNonEmptyString(input.inspectionId, 'inspectionId');
  requireNonEmptyString(input.projectId, 'projectId');
  requireNonEmptyString(input.mimeType, 'mimeType');
  requireNonEmptyString(input.createdAt, 'createdAt');
  if (!(input.blob instanceof Blob)) throw new TypeError('blob must be a Blob.');
}

function requireNonEmptyString(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${field} must be a non-empty string.`);
}

function projectByteRange(projectId: string): IDBKeyRange {
  return IDBKeyRange.bound([projectId, 0], [projectId, MAX_PROJECT_PHOTO_BYTES]);
}

function byteSizeFromIndexKey(key: IDBValidKey): number {
  if (!Array.isArray(key) || typeof key[1] !== 'number') {
    throw photoDatabaseError('Photo byte-size index contains an invalid key.', 'DataError');
  }
  return key[1];
}

function abortTransaction(transaction: IDBTransaction): void {
  try {
    transaction.abort();
  } catch {
    // A request failure may already have aborted the transaction.
  }
}

function quotaError(message: string): DOMException {
  return photoDatabaseError(message, 'QuotaExceededError');
}

function photoDatabaseError(message: string, name = 'UnknownError'): DOMException {
  return new DOMException(message, name);
}
