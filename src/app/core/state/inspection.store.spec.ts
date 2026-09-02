import {TestBed} from '@angular/core/testing';
import {signal} from '@angular/core';
import {AuthService} from '../auth/auth.service';
import {FieldnoteIdentity, ProjectPermissions} from '../auth/auth.models';
import {IndexedDbInspectionRepository} from '../data/indexed-db.repository';
import {IndexedDbPhotoRepository, PhotoBlobSaveInput, PhotoBlobRecord} from '../data/indexed-db-photo.repository';
import {IndexedDbOutboxRepository} from '../sync/indexed-db-outbox.repository';
import {EnqueueOutboxOperation, OutboxOperation, RemoteInspectionSnapshot} from '../sync/sync.models';
import {SEED_INSPECTIONS} from '../data/inspection.seed';
import {Inspection, InspectionTemplate, Project} from '../models/inspection.models';
import {InspectionStore} from './inspection.store';
import {ProjectContextService} from './project-context.service';

const equipmentTemplate: InspectionTemplate = {
  id: 'tpl-test-equipment',
  name: 'Test equipment check',
  category: 'Equipment',
  description: 'Test fixture',
  checklist: [
    {id: 1, title: 'First required check', required: true},
    {id: 2, title: 'Second required check', required: true},
  ],
  requiresPhotos: false,
  approvalSteps: 1,
  active: true,
};

const photoTemplate: InspectionTemplate = {...equipmentTemplate, id: 'tpl-test-photo', requiresPhotos: true};

describe('InspectionStore', () => {
  let store: InspectionStore;
  let repository: {
    loadAll: ReturnType<typeof vi.fn<() => Promise<Inspection[]>>>;
    loadAllWithReport: ReturnType<typeof vi.fn<() => Promise<{inspections: Inspection[]; quarantinedRows: []}>>>;
    save: ReturnType<typeof vi.fn<(inspection: Inspection) => Promise<void>>>;
  };
  let activeProject: ReturnType<typeof signal<Project>>;
  let outboxRows: OutboxOperation[];
  let outbox: {
    enqueue: ReturnType<typeof vi.fn<(input: EnqueueOutboxOperation) => Promise<OutboxOperation>>>;
    list: ReturnType<typeof vi.fn<(projectId: string) => Promise<OutboxOperation[]>>>;
  };
  let photoRepository: {
    load: ReturnType<typeof vi.fn<(photoId: string) => Promise<PhotoBlobRecord | null>>>;
    remove: ReturnType<typeof vi.fn<(photoId: string) => Promise<void>>>;
    save: ReturnType<typeof vi.fn<(input: PhotoBlobSaveInput) => Promise<PhotoBlobRecord>>>;
  };
  let activeIdentity: ReturnType<typeof signal<FieldnoteIdentity>>;
  let auth: {
    identity: typeof activeIdentity;
    demoIdentities: Array<Pick<FieldnoteIdentity, 'id' | 'name'>>;
    can: ReturnType<typeof vi.fn<(permission: keyof ProjectPermissions, projectId: string) => boolean>>;
  };

  beforeEach(async () => {
    localStorage.clear();
    repository = {
      loadAll: vi.fn<() => Promise<Inspection[]>>().mockResolvedValue([]),
      loadAllWithReport: vi.fn<() => Promise<{inspections: Inspection[]; quarantinedRows: []}>>().mockResolvedValue({inspections: [], quarantinedRows: []}),
      save: vi.fn<(inspection: Inspection) => Promise<void>>().mockResolvedValue(),
    };
    photoRepository = {
      load: vi.fn<(photoId: string) => Promise<PhotoBlobRecord | null>>().mockResolvedValue(null),
      remove: vi.fn<(photoId: string) => Promise<void>>().mockResolvedValue(),
      save: vi.fn<(input: PhotoBlobSaveInput) => Promise<PhotoBlobRecord>>().mockImplementation(async input => ({...input, byteSize: input.blob.size})),
    };
    outboxRows = [];
    outbox = {
      enqueue: vi.fn<(input: EnqueueOutboxOperation) => Promise<OutboxOperation>>().mockImplementation(async input => {
        const operation = {...input, attempts: input.attempts ?? 0, lastAttemptAt: input.lastAttemptAt ?? null, lastError: input.lastError ?? null};
        outboxRows.push(operation);
        return operation;
      }),
      list: vi.fn<(projectId: string) => Promise<OutboxOperation[]>>().mockImplementation(async projectId => outboxRows.filter(item => item.projectId === projectId)),
    };
    activeProject = signal({id: 'project-c3', name: 'Sydney Metro · C3'});
    activeIdentity = signal(inspectorIdentity());
    auth = {
      identity: activeIdentity,
      demoIdentities: [inspectorIdentity(), reviewerIdentity(), adminIdentity()],
      can: vi.fn((permission, projectId) => activeIdentity().memberships[projectId]?.[permission] === true),
    };
    TestBed.configureTestingModule({
      providers: [
        InspectionStore,
        {provide: AuthService, useValue: auth},
        {provide: IndexedDbPhotoRepository, useValue: photoRepository},
        {provide: IndexedDbOutboxRepository, useValue: outbox},
        {provide: IndexedDbInspectionRepository, useValue: repository},
        {provide: ProjectContextService, useValue: {activeProject}},
      ],
    });
    store = TestBed.inject(InspectionStore);
    await vi.waitFor(() => expect(store.initialized()).toBe(true));
  });

  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  async function createReady(template = equipmentTemplate): Promise<Inspection> {
    const inspection = store.createFromTemplate(template);
    await store.updateDetails(inspection.id, {zone: 'North access'});
    for (const item of inspection.checklist) await store.updateAnswer(inspection.id, item.id, 'pass');
    if (template.requiresPhotos) await store.addPhoto(inspection.id, 'data:image/png;base64,AA==', 'evidence.png');
    return store.getById(inspection.id)!;
  }

  function useReviewer(): void {
    activeIdentity.set(reviewerIdentity());
  }

  function useInspector(): void {
    activeIdentity.set(inspectorIdentity());
  }

  it('creates a project-scoped draft from a template and persists it', async () => {
    activeProject.set({id: 'project-p2', name: 'Western Harbour · P2'});

    const created = store.createFromTemplate(equipmentTemplate);

    expect(created).toMatchObject({
      projectId: 'project-p2',
      projectName: 'Western Harbour · P2',
      status: 'Draft',
      localSaveStatus: 'saving',
      localRevision: 1,
      syncStatus: 'pending',
      createdBy: 'demo-inspector',
      approvedBy: null,
      serverRevision: null,
      zone: 'Select a site zone',
    });
    expect(created.checklist.every(item => item.answer === null && item.note === '')).toBe(true);
    await vi.waitFor(() => expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({id: created.id, localSaveStatus: 'saved'})));
    expect(store.getById(created.id)?.localSaveStatus).toBe('saved');
  });

  it('queues ordered create and update operations with projected server revisions', async () => {
    const created = store.createFromTemplate(equipmentTemplate);
    await vi.waitFor(() => expect(outboxRows).toHaveLength(1));

    await store.updateDetails(created.id, {zone: 'North access'});

    expect(outboxRows).toHaveLength(2);
    expect(outboxRows[0]).toMatchObject({
      kind: 'create',
      identityId: 'demo-inspector',
      baseRevision: 0,
      inspectionId: created.id,
      payload: expect.objectContaining({id: created.id, projectId: 'project-c3'}),
    });
    expect(outboxRows[1]).toMatchObject({
      kind: 'update',
      identityId: 'demo-inspector',
      baseRevision: 1,
      payload: expect.objectContaining({zone: 'North access'}),
    });
    expect(outboxRows[1].payload).not.toHaveProperty('auditTrail');
  });

  it('stores uploaded image bytes separately and strips previews from inspection persistence', async () => {
    const id = 'INSP-2026-0084';

    await expect(store.addPhoto(id, 'data:image/png;base64,AA==', 'evidence.png', {
      capturedAt: '2026-09-02T01:00:00.000Z',
      location: 'Location not collected',
    })).resolves.toBe(true);

    expect(photoRepository.save).toHaveBeenCalledWith(expect.objectContaining({
      inspectionId: id,
      projectId: 'project-c3',
      mimeType: 'image/png',
    }));
    const photo = store.getById(id)?.photos.at(-1);
    expect(photo).toMatchObject({name: 'evidence.png', storageKey: expect.any(String), byteSize: 1});
    expect(repository.save).toHaveBeenLastCalledWith(expect.objectContaining({
      photos: expect.arrayContaining([expect.objectContaining({name: 'evidence.png', source: ''})]),
    }));
  });

  it('keeps inspection metadata unchanged when photo quota or inspection persistence fails', async () => {
    const id = 'INSP-2026-0084';
    const originalCount = store.getById(id)!.photos.length;
    photoRepository.save.mockRejectedValueOnce(new DOMException('Project photo quota exceeded', 'QuotaExceededError'));

    await expect(store.addPhoto(id, 'data:image/png;base64,AA==', 'quota.png')).resolves.toBe(false);
    expect(store.getById(id)?.photos).toHaveLength(originalCount);
    expect(store.storageError()).toContain('Project photo quota exceeded');

    repository.save.mockRejectedValueOnce(new DOMException('Inspection write failed', 'UnknownError'));
    await expect(store.addPhoto(id, 'data:image/png;base64,AA==', 'rollback.png')).resolves.toBe(false);
    expect(photoRepository.remove).toHaveBeenCalled();
    expect(store.getById(id)?.photos).toHaveLength(originalCount);
  });

  it('rejects submission until a site zone is selected', async () => {
    const inspection = store.createFromTemplate(equipmentTemplate);

    await expect(store.transition(inspection.id, 'Submitted')).resolves.toEqual({ok: false, message: 'Select a site zone before submitting.'});
  });

  it('rejects submission while required checklist answers are missing', async () => {
    const inspection = store.createFromTemplate(equipmentTemplate);
    await store.updateDetails(inspection.id, {zone: 'North access'});
    await store.updateAnswer(inspection.id, 1, 'pass');

    await expect(store.transition(inspection.id, 'Submitted')).resolves.toEqual({ok: false, message: 'Complete 1 required item before submitting.'});
  });

  it('requires a corrective action note for every failed item', async () => {
    const inspection = store.createFromTemplate(equipmentTemplate);
    await store.updateDetails(inspection.id, {zone: 'North access'});
    await store.updateAnswer(inspection.id, 1, 'fail');
    await store.updateAnswer(inspection.id, 2, 'na');

    await expect(store.transition(inspection.id, 'Submitted')).resolves.toEqual({ok: false, message: 'Add a corrective action note to every failed item.'});
    await store.updateNote(inspection.id, 1, 'Guard must be repaired before use.');
    expect((await store.transition(inspection.id, 'Submitted')).ok).toBe(true);
  });

  it('requires evidence when the selected template requires photos', async () => {
    const inspection = store.createFromTemplate(photoTemplate);
    await store.updateDetails(inspection.id, {zone: 'North access'});
    for (const item of inspection.checklist) await store.updateAnswer(inspection.id, item.id, 'pass');

    await expect(store.transition(inspection.id, 'Submitted')).resolves.toEqual({ok: false, message: 'Attach at least one photo before submitting this inspection.'});
    await store.addPhoto(inspection.id, 'data:image/png;base64,AA==', 'evidence.png');
    expect((await store.transition(inspection.id, 'Submitted')).ok).toBe(true);
  });

  it('allows Draft → Submitted → Draft and Draft → Submitted → Approved', async () => {
    const inspection = await createReady();

    await expect(store.transition(inspection.id, 'Submitted')).resolves.toEqual({ok: true, message: 'Inspection submitted for approval.'});
    useReviewer();
    await expect(store.transition(inspection.id, 'Draft')).resolves.toEqual({ok: true, message: 'Inspection returned to draft.'});
    useInspector();
    expect((await store.transition(inspection.id, 'Submitted')).ok).toBe(true);
    useReviewer();
    await expect(store.transition(inspection.id, 'Approved')).resolves.toEqual({ok: true, message: 'Inspection approved and locked.'});
    expect(store.getById(inspection.id)?.approvedBy).toBe('demo-reviewer');
    expect(outboxRows.filter(operation => operation.kind === 'transition').map(operation => ({
      identityId: operation.identityId,
      status: operation.payload['status'],
    }))).toEqual([
      {identityId: 'demo-inspector', status: 'Submitted'},
      {identityId: 'demo-reviewer', status: 'Draft'},
      {identityId: 'demo-inspector', status: 'Submitted'},
      {identityId: 'demo-reviewer', status: 'Approved'},
    ]);
  });

  it('enforces project permissions and separation of duties in the local workflow', async () => {
    const inspection = await createReady();
    await store.transition(inspection.id, 'Submitted');

    await expect(store.transition(inspection.id, 'Approved')).resolves.toEqual({
      ok: false,
      message: 'Reviewer permission is required for this workflow change.',
    });
    useReviewer();
    await expect(store.updateDetails(inspection.id, {title: 'Reviewer edit'})).resolves.toBe(false);
    await expect(store.transition(inspection.id, 'Approved')).resolves.toMatchObject({ok: true});

    activeIdentity.set(adminIdentity());
    const authoredByAdmin = await createReady();
    await store.transition(authoredByAdmin.id, 'Submitted');
    await expect(store.transition(authoredByAdmin.id, 'Approved')).resolves.toEqual({
      ok: false,
      message: 'The inspection author cannot approve their own inspection.',
    });
  });

  it('rejects missing records and forbidden direct transitions', async () => {
    const inspection = store.createFromTemplate(equipmentTemplate);

    await expect(store.transition('missing', 'Submitted')).resolves.toEqual({ok: false, message: 'Inspection not found.'});
    await expect(store.transition(inspection.id, 'Approved')).resolves.toEqual({
      ok: false,
      message: 'A draft inspection cannot move directly to approved.',
    });
  });

  it('prevents every content mutation after approval', async () => {
    const inspection = await createReady();
    await store.transition(inspection.id, 'Submitted');
    useReviewer();
    await store.transition(inspection.id, 'Approved');
    const approved = structuredClone(store.getById(inspection.id)!);

    await store.updateDetails(inspection.id, {title: 'Changed after approval'});
    await store.updateAnswer(inspection.id, 1, 'fail');
    await store.updateNote(inspection.id, 1, 'Changed note');
    await store.addPhoto(inspection.id, 'data:image/png;base64,AA==', 'late.png');
    await store.removePhoto(inspection.id, 'missing-photo');
    await store.saveDraft(inspection.id);

    expect(store.getById(inspection.id)).toEqual(approved);
  });

  it('filters by status and query and applies each supported sort', () => {
    const result = store.filter({query: 'temporary fence', status: 'Draft', sort: 'title'});

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('INSP-2026-0078');
    expect(store.filter({query: '', status: 'All', sort: 'updated-asc'})).toHaveLength(store.inspections().length);
    expect(store.filter({query: '', status: 'Approved', sort: 'updated-desc'}).every(item => item.status === 'Approved')).toBe(true);
  });

  it('computes register totals and exports an escaped CSV snapshot', async () => {
    const inspection = store.createFromTemplate(equipmentTemplate);
    await store.updateDetails(inspection.id, {title: 'Quoted "inspection"'});
    const createObjectUrl = vi.fn(() => 'blob:fieldnote-export');
    const revokeObjectUrl = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    Object.defineProperty(URL, 'createObjectURL', {value: createObjectUrl, configurable: true});
    Object.defineProperty(URL, 'revokeObjectURL', {value: revokeObjectUrl, configurable: true});

    expect(store.draftCount() + store.submittedCount() + store.approvedCount()).toBe(store.inspections().length);
    expect(store.pendingCount()).toBeGreaterThan(0);
    expect(store.auditEvents()).toContainEqual(expect.objectContaining({inspectionId: inspection.id, inspectionTitle: 'Quoted "inspection"'}));

    store.exportCsv();

    expect(createObjectUrl).toHaveBeenCalledWith(expect.any(Blob));
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:fieldnote-export');
  });

  it('surfaces device write failures and supports retry', async () => {
    repository.save.mockRejectedValueOnce(new DOMException('Quota exceeded', 'QuotaExceededError'));
    const inspection = store.createFromTemplate(equipmentTemplate);

    await vi.waitFor(() => expect(store.getById(inspection.id)?.localSaveStatus).toBe('failed'));
    expect(store.saveFailedCount()).toBe(1);
    expect(store.storageError()).toContain('Quota exceeded');

    repository.save.mockResolvedValue();
    await expect(store.retrySave(inspection.id)).resolves.toBe(true);
    expect(store.getById(inspection.id)?.localSaveStatus).toBe('saved');
    store.clearStorageError();
    expect(store.storageError()).toBeNull();
  });

  it('only marks remote sync complete after an ACK and no queued operation remains', async () => {
    const id = 'INSP-2026-0084';

    await store.markSyncing([id]);
    expect(store.getById(id)?.syncStatus).toBe('syncing');

    await store.acknowledgeSync(id, 3, '2026-09-02T02:00:00.000Z', true);
    expect(store.getById(id)).toMatchObject({syncStatus: 'pending', serverRevision: 3});

    await store.acknowledgeSync(id, 3, '2026-09-02T02:00:00.000Z', false);
    expect(store.getById(id)).toMatchObject({
      syncStatus: 'synced',
      serverRevision: 3,
      lastServerAckAt: '2026-09-02T02:00:00.000Z',
    });

    await store.markSyncProblem(id, 'conflicted', 'REVISION_CONFLICT: server revision changed');
    expect(store.getById(id)?.syncStatus).toBe('conflicted');
  });

  it('keeps a remote ACK queued when its local acknowledgement cannot be persisted', async () => {
    const id = 'INSP-2026-0084';
    repository.save.mockRejectedValueOnce(new DOMException('ACK storage failed', 'UnknownError'));

    await expect(store.acknowledgeSync(id, 4, '2026-09-02T02:10:00.000Z', false)).resolves.toBe(false);

    expect(store.getById(id)).toMatchObject({localSaveStatus: 'failed', serverRevision: 4});
    expect(store.storageError()).toContain('ACK storage failed');
  });

  it('stages an explicit server version for conflict recovery and removes discarded photo blobs', async () => {
    const id = 'INSP-2026-0084';
    await store.addPhoto(id, 'data:image/png;base64,AA==', 'local-only.png');
    const localOnly = store.getById(id)!.photos.find(photo => photo.name === 'local-only.png')!;
    await store.markSyncProblem(id, 'conflicted', 'REVISION_CONFLICT: server revision changed');
    const current = store.getById(id)!;
    const snapshot: RemoteInspectionSnapshot = {
      id,
      projectId: 'project-c3',
      title: 'Server-selected title',
      templateId: current.templateId,
      templateName: current.templateName,
      zone: 'Loading bay',
      inspectionDate: '2026-09-01',
      weather: 'Rain',
      requiresPhotos: true,
      photos: [{
        id: 'photo-1',
        name: 'Remote guardrail evidence',
        capturedAt: '2026-09-02T01:00:00.000Z',
        location: 'West access',
        checksum: 'abc123',
      }],
      checklist: current.checklist.map(item => ({...item, answer: 'pass'})),
      status: 'Submitted',
      createdBy: 'demo-inspector',
      approvedBy: null,
      revision: 7,
      createdAt: '2026-09-02T00:00:00.000Z',
      updatedAt: '2026-09-02T02:15:00.000Z',
    };

    await expect(store.replaceWithRemoteSnapshot(snapshot)).resolves.toBe(true);

    expect(store.getById(id)).toMatchObject({
      title: 'Server-selected title',
      zone: 'Loading bay',
      inspector: 'Henry Kim',
      status: 'Submitted',
      syncStatus: 'conflicted',
      serverRevision: 7,
      photos: [expect.objectContaining({
        id: 'photo-1',
        name: 'Remote guardrail evidence',
        checksum: 'abc123',
        source: '',
        storageKey: null,
      })],
    });
    expect(photoRepository.remove).toHaveBeenCalledWith(localOnly.storageKey);
    await expect(store.transition(id, 'Approved')).resolves.toEqual({
      ok: false,
      message: 'Resolve the remote conflict before changing this inspection workflow.',
    });
  });

  it('serializes writes and never lets an older completion mark a newer edit saved', async () => {
    let resolveFirst!: () => void;
    let resolveSecond!: () => void;
    const firstWrite = new Promise<void>(resolve => { resolveFirst = resolve; });
    const secondWrite = new Promise<void>(resolve => { resolveSecond = resolve; });
    repository.save.mockReset().mockImplementationOnce(() => firstWrite).mockImplementationOnce(() => secondWrite);
    const id = 'INSP-2026-0084';

    const first = store.updateDetails(id, {title: 'First edit'});
    const second = store.updateDetails(id, {title: 'Newest edit'});
    await vi.waitFor(() => expect(repository.save).toHaveBeenCalledTimes(1));

    resolveFirst();
    await first;
    await vi.waitFor(() => expect(repository.save).toHaveBeenCalledTimes(2));
    expect(store.getById(id)).toMatchObject({title: 'Newest edit', localSaveStatus: 'saving'});

    resolveSecond();
    await second;
    expect(store.getById(id)).toMatchObject({title: 'Newest edit', localSaveStatus: 'saved'});
  });

  it('rolls back a workflow transition when the device write fails', async () => {
    const inspection = await createReady();
    repository.save.mockRejectedValueOnce(new DOMException('Write failed', 'UnknownError'));

    await expect(store.transition(inspection.id, 'Submitted')).resolves.toEqual({
      ok: false,
      message: 'The workflow change could not be saved. Retry after checking device storage.',
    });
    expect(store.getById(inspection.id)).toMatchObject({status: 'Draft', localSaveStatus: 'failed'});
  });

  it('preserves edits made while delayed hydration is still loading', async () => {
    TestBed.resetTestingModule();
    let resolveLoad!: (value: {inspections: Inspection[]; quarantinedRows: []}) => void;
    const delayedLoad = new Promise<{inspections: Inspection[]; quarantinedRows: []}>(resolve => { resolveLoad = resolve; });
    const delayedRepository = {
      loadAllWithReport: vi.fn(() => delayedLoad),
      save: vi.fn<(inspection: Inspection) => Promise<void>>().mockResolvedValue(),
    };
    const delayedProject = signal<Project>({id: 'project-c3', name: 'Sydney Metro · C3'});
    TestBed.configureTestingModule({providers: [
      InspectionStore,
      {provide: AuthService, useValue: auth},
      {provide: IndexedDbPhotoRepository, useValue: photoRepository},
      {provide: IndexedDbOutboxRepository, useValue: outbox},
      {provide: IndexedDbInspectionRepository, useValue: delayedRepository},
      {provide: ProjectContextService, useValue: {activeProject: delayedProject}},
    ]});
    const delayedStore = TestBed.inject(InspectionStore);
    const id = 'INSP-2026-0084';
    await delayedStore.updateDetails(id, {title: 'Edited before hydration'});
    const staleStored = {...structuredClone(SEED_INSPECTIONS[0]), title: 'Stale stored title'};

    resolveLoad({inspections: [staleStored], quarantinedRows: []});
    await vi.waitFor(() => expect(delayedStore.initialized()).toBe(true));

    expect(delayedStore.getById(id)?.title).toBe('Edited before hydration');
  });

  it('migrates legacy relative and time-only timestamps to sortable ISO values', async () => {
    TestBed.resetTestingModule();
    const legacy = {
      ...structuredClone(SEED_INSPECTIONS[0]),
      updatedAt: 'Today, 10:42',
      photos: [{...structuredClone(SEED_INSPECTIONS[0].photos[0]), source: 'data:image/png;base64,AA==', storageKey: null, capturedAt: '10:36'}],
      auditTrail: [{...structuredClone(SEED_INSPECTIONS[0].auditTrail[0]), occurredAt: 'Yesterday, 16:32'}],
    };
    const legacyRepository = {
      loadAllWithReport: vi.fn().mockResolvedValue({inspections: [legacy], quarantinedRows: []}),
      save: vi.fn<(inspection: Inspection) => Promise<void>>().mockResolvedValue(),
    };
    TestBed.configureTestingModule({providers: [
      InspectionStore,
      {provide: AuthService, useValue: auth},
      {provide: IndexedDbPhotoRepository, useValue: photoRepository},
      {provide: IndexedDbOutboxRepository, useValue: outbox},
      {provide: IndexedDbInspectionRepository, useValue: legacyRepository},
      {provide: ProjectContextService, useValue: {activeProject}},
    ]});

    const legacyStore = TestBed.inject(InspectionStore);
    await vi.waitFor(() => expect(legacyStore.initialized()).toBe(true));

    expect(legacyStore.getById(legacy.id)).toMatchObject({
      updatedAt: '2026-09-02T10:42:00+10:00',
      photos: [expect.objectContaining({capturedAt: '2026-09-02T10:36:00+10:00'})],
      auditTrail: [expect.objectContaining({occurredAt: '2026-09-01T16:32:00+10:00'})],
    });
    expect(photoRepository.save).toHaveBeenCalledWith(expect.objectContaining({photoId: 'photo-1', inspectionId: legacy.id}));
    expect(legacyRepository.save).toHaveBeenCalledWith(expect.objectContaining({
      photos: [expect.objectContaining({storageKey: 'photo-1', source: ''})],
    }));
  });

  it('isolates list and direct record access to the active project', () => {
    activeProject.set({id: 'project-p2', name: 'Western Harbour · P2'});
    const projectBRecord = store.createFromTemplate(equipmentTemplate);
    activeProject.set({id: 'project-c3', name: 'Sydney Metro · C3'});

    expect(store.filter({query: '', status: 'All', sort: 'updated-desc'}).every(item => item.projectId === 'project-c3')).toBe(true);
    expect(store.getById(projectBRecord.id)).toBeUndefined();
  });
});

function permissions(approve: boolean, write: boolean): ProjectPermissions {
  return {read: true, write, export: true, approve};
}

function inspectorIdentity(): FieldnoteIdentity {
  const member = permissions(false, true);
  return {
    id: 'demo-inspector',
    name: 'Henry Kim',
    role: 'Inspector',
    memberships: {'project-c3': member, 'project-p2': member, 'project-north': member},
  };
}

function reviewerIdentity(): FieldnoteIdentity {
  const member = permissions(true, false);
  return {
    id: 'demo-reviewer',
    name: 'Rina Park',
    role: 'Reviewer',
    memberships: {'project-c3': member, 'project-p2': member, 'project-north': member},
  };
}

function adminIdentity(): FieldnoteIdentity {
  const member = permissions(true, true);
  return {
    id: 'demo-admin',
    name: 'Alex Morgan',
    role: 'Admin',
    memberships: {'project-c3': member, 'project-p2': member, 'project-north': member},
  };
}
