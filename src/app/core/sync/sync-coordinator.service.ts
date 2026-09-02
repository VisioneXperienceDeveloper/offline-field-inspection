import {DestroyRef, Injectable, effect, inject, signal} from '@angular/core';
import {AuthService} from '../auth/auth.service';
import {ConnectivityService} from '../services/connectivity.service';
import {InspectionStore} from '../state/inspection.store';
import {PreferencesStore} from '../state/preferences.store';
import {ProjectContextService} from '../state/project-context.service';
import {FieldnoteSyncClient, FieldnoteSyncClientError, SyncHttpError} from './fieldnote-sync-client';
import {IndexedDbOutboxRepository} from './indexed-db-outbox.repository';
import {OutboxOperation} from './sync.models';

export interface SyncRunResult {
  attempted: number;
  acknowledged: number;
  conflicts: number;
  rejected: number;
  remaining: number;
}

@Injectable({providedIn: 'root'})
export class SyncCoordinatorService {
  private readonly auth = inject(AuthService);
  private readonly client = inject(FieldnoteSyncClient);
  private readonly connectivity = inject(ConnectivityService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly inspections = inject(InspectionStore);
  private readonly outbox = inject(IndexedDbOutboxRepository);
  private readonly preferences = inject(PreferencesStore);
  private readonly projects = inject(ProjectContextService);
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryAttempt = 0;

  readonly inFlight = signal(false);
  readonly lastError = signal<string | null>(null);
  readonly queuedCount = signal(0);

  constructor() {
    effect(() => {
      const ready = this.inspections.initialized();
      const outboxRevision = this.inspections.outboxRevision();
      const revisionMarker = this.inspections.inspections().map(item => `${item.id}:${item.localRevision}:${item.syncStatus}`).join('|');
      const projectId = this.projects.activeProject().id;
      if (!ready || !revisionMarker || outboxRevision < 1 || !projectId || !this.preferences.autoSync() || !this.connectivity.online() || !this.connectionAllowed()) return;
      queueMicrotask(() => void this.syncNow(projectId));
    });
    queueMicrotask(async () => {
      const projectId = this.projects.activeProject().id;
      const queued = await this.refreshQueuedCount(projectId);
      if (queued && this.preferences.autoSync() && this.connectivity.online() && this.connectionAllowed()) void this.syncNow(projectId);
    });
    this.destroyRef.onDestroy(() => {
      if (this.retryTimer) clearTimeout(this.retryTimer);
    });
  }

  async refreshQueuedCount(projectId = this.projects.activeProject().id): Promise<number> {
    if (!projectId) {
      this.queuedCount.set(0);
      return 0;
    }
    const count = (await this.outbox.list(projectId)).length;
    this.queuedCount.set(count);
    return count;
  }

  async syncNow(projectId = this.projects.activeProject().id): Promise<SyncRunResult> {
    const empty = {attempted: 0, acknowledged: 0, conflicts: 0, rejected: 0, remaining: 0};
    if (this.inFlight() || !projectId) return empty;
    if (!this.connectivity.online()) {
      this.lastError.set('Remote sync is paused while this device is offline.');
      return {...empty, remaining: await this.refreshQueuedCount(projectId)};
    }
    if (!this.connectionAllowed()) {
      this.lastError.set('Remote sync is waiting for a Wi-Fi or wired connection.');
      return {...empty, remaining: await this.refreshQueuedCount(projectId)};
    }

    this.inFlight.set(true);
    this.lastError.set(null);
    let attempted = 0;
    let acknowledged = 0;
    let conflicts = 0;
    let rejected = 0;
    try {
      const queuedOperations = await this.outbox.list(projectId);
      this.queuedCount.set(queuedOperations.length);
      if (!queuedOperations.length) return empty;
      const conflictedInspectionIds = new Set(
        this.inspections.inspections()
          .filter(inspection => inspection.syncStatus === 'conflicted')
          .map(inspection => inspection.id),
      );
      const operations = queuedOperations.filter(operation => !conflictedInspectionIds.has(operation.inspectionId));
      if (!operations.length) {
        this.lastError.set('Queued work is paused until its remote conflict is resolved.');
        return {...empty, remaining: queuedOperations.length};
      }
      await this.inspections.markSyncing([...new Set(operations.map(operation => operation.inspectionId))]);

      for (const group of contiguousGroups(operations)) {
        const token = this.auth.bearerTokenFor(group[0].identityId);
        if (!token) {
          const message = `The queued identity ${group[0].identityId} is no longer available. Sign in again to retry.`;
          await this.failGroup(group, message);
          rejected += group.length;
          attempted += group.length;
          this.lastError.set(message);
          continue;
        }

        attempted += group.length;
        let batch;
        try {
          batch = await this.client.push(projectId, group, {token});
        } catch (error) {
          const message = syncErrorMessage(error);
          await this.failGroup(group, message);
          rejected += group.length;
          this.lastError.set(message);
          if (isRetryableSyncError(error)) this.scheduleRetry(projectId);
          break;
        }

        const conflictsInGroup = new Set<string>();
        for (let index = 0; index < group.length; index += 1) {
          const operation = group[index];
          const result = batch.results[index];
          if (result.status === 'acked') {
            await this.outbox.markAttempt(operation.operationId, null);
            const hasPending = (await this.outbox.list(projectId)).some(item =>
              item.operationId !== operation.operationId && item.inspectionId === operation.inspectionId,
            );
            const ackPersisted = await this.inspections.acknowledgeSync(
              operation.inspectionId,
              result.revision,
              result.serverTimestamp,
              hasPending,
            );
            if (!ackPersisted) {
              const message = `Remote ACK for ${operation.inspectionId} could not be saved on this device.`;
              await this.outbox.markAttempt(operation.operationId, message);
              this.lastError.set(message);
              rejected += 1;
              continue;
            }
            acknowledged += 1;
            try {
              await this.outbox.remove(operation.operationId);
            } catch (error) {
              const message = syncErrorMessage(error);
              await this.outbox.markAttempt(operation.operationId, message).catch(() => undefined);
              this.lastError.set(`The server confirmed ${operation.inspectionId}, but its local queue cleanup failed. ${message}`);
              this.scheduleRetry(projectId);
            }
          } else {
            const message = `${result.error.code}: ${result.error.message}`;
            await this.outbox.markAttempt(operation.operationId, message);
            if (result.status === 'conflict') {
              conflictsInGroup.add(operation.inspectionId);
              await this.inspections.markSyncProblem(operation.inspectionId, 'conflicted', message);
              conflicts += 1;
            } else {
              if (!conflictsInGroup.has(operation.inspectionId)) {
                await this.inspections.markSyncProblem(operation.inspectionId, 'failed', message);
              }
              rejected += 1;
            }
          }
        }
      }

      const remaining = await this.refreshQueuedCount(projectId);
      if (!remaining) {
        this.retryAttempt = 0;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
      }
      return {attempted, acknowledged, conflicts, rejected, remaining};
    } finally {
      this.inFlight.set(false);
    }
  }

  /** Discards the conflicted local edit only after the user explicitly chooses the server version. */
  async acceptServerVersion(
    inspectionId: string,
    projectId = this.projects.activeProject().id,
  ): Promise<boolean> {
    if (this.inFlight() || !projectId) return false;
    const inspection = this.inspections.getById(inspectionId);
    if (!inspection || inspection.projectId !== projectId || inspection.syncStatus !== 'conflicted') {
      this.lastError.set('Only a conflicted inspection can be replaced with the server version.');
      return false;
    }
    if (!this.connectivity.online() || !this.connectionAllowed()) {
      this.lastError.set('Connect using an allowed network before loading the server version.');
      return false;
    }

    this.inFlight.set(true);
    this.lastError.set(null);
    try {
      const snapshot = await this.client.fetchInspection(projectId, inspectionId);
      if (!await this.inspections.replaceWithRemoteSnapshot(snapshot)) {
        this.lastError.set('The server version could not be saved on this device. Local queued work was preserved.');
        return false;
      }
      await this.outbox.removeForInspection(projectId, inspectionId);
      if (!await this.inspections.acknowledgeSync(inspectionId, snapshot.revision, snapshot.updatedAt, false)) {
        this.lastError.set('The remote version was loaded, but its final local sync state could not be saved.');
        return false;
      }
      await this.refreshQueuedCount(projectId);
      return true;
    } catch (error) {
      this.lastError.set(syncErrorMessage(error));
      await this.refreshQueuedCount(projectId).catch(() => undefined);
      return false;
    } finally {
      this.inFlight.set(false);
    }
  }

  private async failGroup(group: readonly OutboxOperation[], message: string): Promise<void> {
    await Promise.all(group.map(async operation => {
      await this.outbox.markAttempt(operation.operationId, message);
      await this.inspections.markSyncProblem(operation.inspectionId, 'failed', message);
    }));
    await this.refreshQueuedCount(group[0].projectId);
  }

  private connectionAllowed(): boolean {
    if (!this.preferences.wifiOnly()) return true;
    const connection = (navigator as Navigator & {connection?: {type?: string}}).connection;
    return !connection?.type || connection.type === 'wifi' || connection.type === 'ethernet';
  }

  private scheduleRetry(projectId: string): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const delay = Math.min(60_000, 1_000 * 2 ** Math.min(this.retryAttempt, 6));
    this.retryAttempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.connectivity.online() && this.preferences.autoSync() && this.connectionAllowed()) void this.syncNow(projectId);
    }, delay);
  }
}

function contiguousGroups(operations: readonly OutboxOperation[]): OutboxOperation[][] {
  const groups: OutboxOperation[][] = [];
  for (const operation of operations) {
    const current = groups.at(-1);
    if (!current || current.length === 100 || current[0].identityId !== operation.identityId) groups.push([operation]);
    else current.push(operation);
  }
  return groups;
}

function syncErrorMessage(error: unknown): string {
  if (error instanceof FieldnoteSyncClientError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Remote sync failed unexpectedly.';
}

function isRetryableSyncError(error: unknown): boolean {
  if (error instanceof SyncHttpError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return error instanceof FieldnoteSyncClientError
    && (error.kind === 'network' || error.kind === 'timeout' || error.kind === 'invalid-response');
}
