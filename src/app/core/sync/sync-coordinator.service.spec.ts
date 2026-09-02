import {signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {AuthService} from '../auth/auth.service';
import {ConnectivityService} from '../services/connectivity.service';
import {InspectionStore} from '../state/inspection.store';
import {PreferencesStore} from '../state/preferences.store';
import {ProjectContextService} from '../state/project-context.service';
import {FieldnoteSyncClient, SyncHttpError, SyncNetworkError} from './fieldnote-sync-client';
import {IndexedDbOutboxRepository} from './indexed-db-outbox.repository';
import {SyncCoordinatorService} from './sync-coordinator.service';
import {OutboxOperation, SyncOperationResult} from './sync.models';

describe('SyncCoordinatorService', () => {
  let rows: OutboxOperation[];
  let online: ReturnType<typeof signal<boolean>>;
  let autoSync: ReturnType<typeof signal<boolean>>;
  let wifiOnly: ReturnType<typeof signal<boolean>>;
  let client: {push: ReturnType<typeof vi.fn>; fetchInspection: ReturnType<typeof vi.fn>};
  let store: {
    initialized: ReturnType<typeof signal<boolean>>;
    inspections: ReturnType<typeof signal<Array<{id: string; localRevision: number; syncStatus: string}>>>;
    outboxRevision: ReturnType<typeof signal<number>>;
    acknowledgeSync: ReturnType<typeof vi.fn>;
    markSyncProblem: ReturnType<typeof vi.fn>;
    markSyncing: ReturnType<typeof vi.fn>;
    getById: ReturnType<typeof vi.fn>;
    replaceWithRemoteSnapshot: ReturnType<typeof vi.fn>;
  };
  let outbox: {
    list: ReturnType<typeof vi.fn>;
    markAttempt: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    removeForInspection: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    rows = [operation('op-create', 'demo-inspector', 0), operation('op-update', 'demo-inspector', 1)];
    online = signal(true);
    autoSync = signal(false);
    wifiOnly = signal(false);
    client = {push: vi.fn(), fetchInspection: vi.fn()};
    store = {
      initialized: signal(true),
      inspections: signal([{id: 'INSP-1', localRevision: 2, syncStatus: 'pending'}]),
      outboxRevision: signal(0),
      acknowledgeSync: vi.fn().mockResolvedValue(true),
      markSyncProblem: vi.fn().mockResolvedValue(undefined),
      markSyncing: vi.fn().mockResolvedValue(undefined),
      getById: vi.fn(() => ({id: 'INSP-1', projectId: 'project-c3', syncStatus: 'conflicted'})),
      replaceWithRemoteSnapshot: vi.fn().mockResolvedValue(true),
    };
    outbox = {
      list: vi.fn(async (projectId: string) => rows.filter(row => row.projectId === projectId)),
      markAttempt: vi.fn(async (operationId: string) => rows.find(row => row.operationId === operationId)),
      remove: vi.fn(async (operationId: string) => {
        rows = rows.filter(row => row.operationId !== operationId);
      }),
      removeForInspection: vi.fn(async (projectId: string, inspectionId: string) => {
        const previous = rows.length;
        rows = rows.filter(row => row.projectId !== projectId || row.inspectionId !== inspectionId);
        return previous - rows.length;
      }),
    };
    TestBed.configureTestingModule({providers: [
      SyncCoordinatorService,
      {provide: AuthService, useValue: {
        bearerTokenFor: (identityId: string) => identityId === 'missing' ? undefined : `${identityId}-token`,
      }},
      {provide: FieldnoteSyncClient, useValue: client},
      {provide: ConnectivityService, useValue: {online}},
      {provide: InspectionStore, useValue: store},
      {provide: IndexedDbOutboxRepository, useValue: outbox},
      {provide: PreferencesStore, useValue: {autoSync, wifiOnly}},
      {provide: ProjectContextService, useValue: {activeProject: signal({id: 'project-c3', name: 'C3'})}},
    ]});
  });

  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  it('persists ACK state before removing operations and only finishes synced when none remain', async () => {
    client.push.mockResolvedValue({results: [acked('op-create', 1), acked('op-update', 2)]});
    const coordinator = TestBed.inject(SyncCoordinatorService);

    const result = await coordinator.syncNow();

    expect(result).toEqual({attempted: 2, acknowledged: 2, conflicts: 0, rejected: 0, remaining: 0});
    expect(store.markSyncing).toHaveBeenCalledWith(['INSP-1']);
    expect(store.acknowledgeSync).toHaveBeenNthCalledWith(1, 'INSP-1', 1, expect.any(String), true);
    expect(store.acknowledgeSync).toHaveBeenLastCalledWith('INSP-1', 2, expect.any(String), false);
    expect(outbox.remove).toHaveBeenCalledTimes(2);
    expect(coordinator.queuedCount()).toBe(0);
  });

  it('keeps conflicts and rejections durable and marks their inspections for recovery', async () => {
    client.push.mockResolvedValue({results: [
      problem('op-create', 'conflict', 'REVISION_CONFLICT'),
      problem('op-update', 'rejected', 'PERMISSION_DENIED'),
    ]});
    const coordinator = TestBed.inject(SyncCoordinatorService);

    const result = await coordinator.syncNow();

    expect(result).toMatchObject({attempted: 2, conflicts: 1, rejected: 1, remaining: 2});
    expect(outbox.remove).not.toHaveBeenCalled();
    expect(store.markSyncProblem).toHaveBeenCalledWith('INSP-1', 'conflicted', expect.stringContaining('REVISION_CONFLICT'));
    expect(store.markSyncProblem).not.toHaveBeenCalledWith('INSP-1', 'failed', expect.stringContaining('PERMISSION_DENIED'));
  });

  it('retains the same operation ids after a network failure and records attempts', async () => {
    vi.useFakeTimers();
    client.push.mockRejectedValue(new SyncNetworkError());
    const coordinator = TestBed.inject(SyncCoordinatorService);

    const result = await coordinator.syncNow();

    expect(result).toMatchObject({attempted: 2, rejected: 2, remaining: 2});
    expect(rows.map(row => row.operationId)).toEqual(['op-create', 'op-update']);
    expect(outbox.markAttempt).toHaveBeenCalledWith('op-create', 'The sync server could not be reached.');
    expect(store.markSyncProblem).toHaveBeenCalledWith('INSP-1', 'failed', 'The sync server could not be reached.');
  });

  it('does not automatically retry a permanent HTTP validation failure', async () => {
    vi.useFakeTimers();
    client.push.mockRejectedValue(new SyncHttpError(
      422,
      {code: 'VALIDATION_ERROR', message: 'Payload is invalid.'},
      'Payload is invalid.',
    ));
    const coordinator = TestBed.inject(SyncCoordinatorService);
    const timersBeforeSync = vi.getTimerCount();

    await coordinator.syncNow();

    expect(client.push).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(timersBeforeSync);
    expect(coordinator.lastError()).toBe('Payload is invalid.');
  });

  it('never removes a server-ACKed operation when the ACK cannot be persisted locally', async () => {
    rows = [operation('op-create', 'demo-inspector', 0)];
    client.push.mockResolvedValue({results: [acked('op-create', 1)]});
    store.acknowledgeSync.mockResolvedValue(false);
    const coordinator = TestBed.inject(SyncCoordinatorService);

    const result = await coordinator.syncNow();

    expect(result).toMatchObject({attempted: 1, acknowledged: 0, rejected: 1, remaining: 1});
    expect(outbox.remove).not.toHaveBeenCalled();
    expect(outbox.markAttempt).toHaveBeenLastCalledWith('op-create', expect.stringContaining('could not be saved'));
  });

  it('uses the original queued actor token and preserves contiguous actor order', async () => {
    rows = [operation('op-create', 'demo-inspector', 0), operation('op-approve', 'demo-reviewer', 1)];
    client.push
      .mockResolvedValueOnce({results: [acked('op-create', 1)]})
      .mockResolvedValueOnce({results: [acked('op-approve', 2)]});
    const coordinator = TestBed.inject(SyncCoordinatorService);

    await coordinator.syncNow();

    expect(client.push).toHaveBeenNthCalledWith(1, 'project-c3', [expect.objectContaining({operationId: 'op-create'})], {token: 'demo-inspector-token'});
    expect(client.push).toHaveBeenNthCalledWith(2, 'project-c3', [expect.objectContaining({operationId: 'op-approve'})], {token: 'demo-reviewer-token'});
  });

  it('pauses offline and honours the Wi-Fi-only preference without dropping work', async () => {
    const coordinator = TestBed.inject(SyncCoordinatorService);
    online.set(false);

    await expect(coordinator.syncNow()).resolves.toMatchObject({attempted: 0, remaining: 2});
    expect(client.push).not.toHaveBeenCalled();

    online.set(true);
    wifiOnly.set(true);
    Object.defineProperty(navigator, 'connection', {value: {type: 'cellular'}, configurable: true});
    await expect(coordinator.syncNow()).resolves.toMatchObject({attempted: 0, remaining: 2});
    expect(coordinator.lastError()).toContain('Wi-Fi');
  });

  it('marks operations whose original identity is unavailable without calling the server', async () => {
    rows = [operation('op-orphaned', 'missing', 0)];
    const coordinator = TestBed.inject(SyncCoordinatorService);

    const result = await coordinator.syncNow();

    expect(result).toMatchObject({attempted: 1, rejected: 1, remaining: 1});
    expect(client.push).not.toHaveBeenCalled();
    expect(coordinator.lastError()).toContain('Sign in again');
  });

  it('does not automatically replay an inspection already marked conflicted', async () => {
    store.inspections.set([{id: 'INSP-1', localRevision: 2, syncStatus: 'conflicted'}]);
    const coordinator = TestBed.inject(SyncCoordinatorService);

    await expect(coordinator.syncNow()).resolves.toEqual({
      attempted: 0,
      acknowledged: 0,
      conflicts: 0,
      rejected: 0,
      remaining: 2,
    });

    expect(client.push).not.toHaveBeenCalled();
    expect(store.markSyncing).not.toHaveBeenCalled();
    expect(coordinator.lastError()).toContain('conflict is resolved');
  });

  it('replaces a conflict with the validated server snapshot before clearing its queue', async () => {
    const snapshot = {id: 'INSP-1', projectId: 'project-c3', revision: 4, updatedAt: '2026-09-02T02:00:00.000Z'};
    client.fetchInspection.mockResolvedValue(snapshot);
    const coordinator = TestBed.inject(SyncCoordinatorService);

    await expect(coordinator.acceptServerVersion('INSP-1')).resolves.toBe(true);

    expect(client.fetchInspection).toHaveBeenCalledWith('project-c3', 'INSP-1');
    expect(store.replaceWithRemoteSnapshot).toHaveBeenCalledWith(snapshot);
    expect(outbox.removeForInspection).toHaveBeenCalledWith('project-c3', 'INSP-1');
    expect(store.acknowledgeSync).toHaveBeenCalledWith('INSP-1', 4, snapshot.updatedAt, false);
    expect(coordinator.queuedCount()).toBe(0);
  });

  it('preserves queued work when the server version cannot be stored locally', async () => {
    client.fetchInspection.mockResolvedValue({
      id: 'INSP-1', projectId: 'project-c3', revision: 4, updatedAt: '2026-09-02T02:00:00.000Z',
    });
    store.replaceWithRemoteSnapshot.mockResolvedValue(false);
    const coordinator = TestBed.inject(SyncCoordinatorService);

    await expect(coordinator.acceptServerVersion('INSP-1')).resolves.toBe(false);

    expect(outbox.removeForInspection).not.toHaveBeenCalled();
    expect(rows).toHaveLength(2);
    expect(coordinator.lastError()).toContain('could not be saved');
  });
});

function operation(operationId: string, identityId: string, baseRevision: number): OutboxOperation {
  return {
    operationId,
    idempotencyKey: `idem-${operationId}`,
    kind: operationId.includes('approve') ? 'transition' : baseRevision === 0 ? 'create' : 'update',
    identityId,
    projectId: 'project-c3',
    inspectionId: 'INSP-1',
    baseRevision,
    payload: operationId.includes('approve') ? {status: 'Approved'} : {id: 'INSP-1'},
    createdAt: '2026-09-02T01:00:00.000Z',
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
  };
}

function acked(operationId: string, revision: number): SyncOperationResult {
  return {
    operationId,
    idempotencyKey: `idem-${operationId}`,
    projectId: 'project-c3',
    inspectionId: 'INSP-1',
    status: 'acked',
    revision,
    serverTimestamp: `2026-09-02T01:00:0${revision}.000Z`,
    inspection: {},
  };
}

function problem(operationId: string, status: 'conflict' | 'rejected', code: string): SyncOperationResult {
  return {
    operationId,
    idempotencyKey: `idem-${operationId}`,
    projectId: 'project-c3',
    inspectionId: 'INSP-1',
    status,
    error: {code, message: `${code} message`},
  };
}
