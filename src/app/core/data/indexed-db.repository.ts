import {Injectable} from '@angular/core';
import {Inspection} from '../models/inspection.models';

@Injectable({providedIn: 'root'})
export class IndexedDbInspectionRepository {
  private databasePromise?: Promise<IDBDatabase>;

  async loadAll(): Promise<Inspection[]> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const request = database.transaction('inspections', 'readonly').objectStore('inspections').getAll();
      request.onsuccess = () => resolve(request.result as Inspection[]);
      request.onerror = () => reject(request.error);
    });
  }

  async save(inspection: Inspection): Promise<void> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const request = database.transaction('inspections', 'readwrite').objectStore('inspections').put(inspection);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async saveMany(inspections: Inspection[]): Promise<void> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('inspections', 'readwrite');
      const store = transaction.objectStore('inspections');
      inspections.forEach(inspection => store.put(inspection));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  private open(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise;
    this.databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open('fieldnote-production-db', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('inspections', {keyPath: 'id'});
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this.databasePromise;
  }
}
