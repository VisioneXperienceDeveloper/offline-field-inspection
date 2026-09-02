import {DestroyRef, Injectable, computed, inject, signal} from '@angular/core';
import {AuthService} from '../auth/auth.service';
import {ProjectPermission} from '../auth/auth.models';
import {SEED_INSPECTIONS} from '../data/inspection.seed';
import {IndexedDbPhotoRepository} from '../data/indexed-db-photo.repository';
import {IndexedDbInspectionRepository, QuarantinedInspectionRow} from '../data/indexed-db.repository';
import {AuditEvent, Inspection, InspectionAnswer, InspectionFilters, InspectionStatus, InspectionTemplate} from '../models/inspection.models';
import {PreferencesStore} from './preferences.store';
import {ProjectContextService} from './project-context.service';
import {InspectionTemplateSnapshot} from './template.store';
import {IndexedDbOutboxRepository} from '../sync/indexed-db-outbox.repository';
import {OutboxOperationKind, RemoteInspectionSnapshot} from '../sync/sync.models';

@Injectable({providedIn: 'root'})
export class InspectionStore {
  private readonly repository = inject(IndexedDbInspectionRepository);
  private readonly photoRepository = inject(IndexedDbPhotoRepository);
  private readonly outbox = inject(IndexedDbOutboxRepository);
  private readonly destroyRef = inject(DestroyRef);
  private readonly projectContext = inject(ProjectContextService);
  private readonly auth = inject(AuthService);
  private readonly preferences = inject(PreferencesStore);
  private readonly inspectionsState = signal<Inspection[]>(structuredClone(SEED_INSPECTIONS));
  private readonly initializedState = signal(false);
  private readonly storageErrorState = signal<string | null>(null);
  private readonly quarantinedRowsState = signal<QuarantinedInspectionRow[]>([]);
  private readonly outboxRevisionState = signal(0);
  private readonly mutationsDuringHydration = new Set<string>();
  private readonly writeQueues = new Map<string, Promise<void>>();
  private readonly photoObjectUrls = new Map<string, string>();
  private readonly outboxQueues = new Map<string, Promise<void>>();

  readonly initialized = this.initializedState.asReadonly();
  readonly storageError = this.storageErrorState.asReadonly();
  readonly quarantinedRows = this.quarantinedRowsState.asReadonly();
  readonly outboxRevision = this.outboxRevisionState.asReadonly();
  readonly inspections = computed(() => this.inspectionsState().filter(item => item.projectId === this.projectContext.activeProject().id));
  readonly pendingCount = computed(() => this.inspections().filter(item => item.syncStatus !== 'synced').length);
  readonly unsavedCount = computed(() => this.inspections().filter(item => item.localSaveStatus !== 'saved').length);
  readonly saveFailedCount = computed(() => this.inspections().filter(item => item.localSaveStatus === 'failed').length);
  readonly draftCount = computed(() => this.inspections().filter(item => item.status === 'Draft').length);
  readonly submittedCount = computed(() => this.inspections().filter(item => item.status === 'Submitted').length);
  readonly approvedCount = computed(() => this.inspections().filter(item => item.status === 'Approved').length);
  readonly auditEvents = computed(() => this.inspections()
    .flatMap(inspection => inspection.auditTrail.map(event => ({...event, inspectionId: inspection.id, inspectionTitle: inspection.title})))
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)));

  constructor() {
    this.destroyRef.onDestroy(() => {
      if (typeof URL.revokeObjectURL === 'function') {
        for (const url of this.photoObjectUrls.values()) URL.revokeObjectURL(url);
      }
      this.photoObjectUrls.clear();
    });
    void this.initialize();
  }

  getById(id: string): Inspection | undefined {
    return this.inspections().find(item => item.id === id);
  }

  can(permission: ProjectPermission): boolean {
    return this.auth.can(permission, this.projectContext.activeProject().id);
  }

  filter(filters: InspectionFilters): Inspection[] {
    const query = filters.query.trim().toLowerCase();
    return this.inspections()
      .filter(item => filters.status === 'All' || item.status === filters.status)
      .filter(item => !query || `${item.title} ${item.id} ${item.zone} ${item.inspector}`.toLowerCase().includes(query))
      .sort((a, b) => filters.sort === 'title' ? a.title.localeCompare(b.title) : filters.sort === 'updated-asc' ? a.updatedAt.localeCompare(b.updatedAt) : b.updatedAt.localeCompare(a.updatedAt));
  }

  createFromTemplate(template: InspectionTemplate): Inspection {
    const project = this.projectContext.activeProject();
    if (!this.auth.can('write', project.id)) throw new Error('Write permission is required to create an inspection.');
    const identity = this.auth.identity();
    const snapshot = template as Partial<InspectionTemplateSnapshot>;
    const now = this.timestamp();
    const inspection: Inspection = {
      id: `INSP-${now.slice(0, 4)}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      title: template.name,
      templateId: template.id,
      templateName: template.name,
      templateVersion: snapshot.templateVersion ?? 1,
      templatePublishedAt: snapshot.templatePublishedAt ?? null,
      templateSnapshotAt: snapshot.snapshotAt ?? null,
      projectId: project.id,
      projectName: project.name,
      zone: 'Select a site zone',
      inspector: this.preferences.defaultInspector().trim() || identity.name,
      createdBy: identity.id,
      approvedBy: null,
      status: 'Draft',
      localSaveStatus: 'saving',
      localRevision: 1,
      syncStatus: 'pending',
      serverRevision: null,
      lastServerAckAt: null,
      updatedAt: now,
      inspectionDate: now.slice(0, 10),
      weather: 'Clear',
      requiresPhotos: template.requiresPhotos,
      photos: [],
      checklist: template.checklist.map(item => ({...item, answer: null, note: ''})),
      auditTrail: [this.audit('Created the inspection', now, template.name)],
    };
    this.inspectionsState.update(items => [inspection, ...items]);
    this.markHydrationMutation(inspection.id);
    void this.persist(inspection).then(saved => {
      if (saved) return this.enqueueMutation(inspection, 'create', this.createPayload(inspection), identity.id);
      return undefined;
    });
    return inspection;
  }

  updateDetails(id: string, changes: Partial<Pick<Inspection, 'title' | 'inspectionDate' | 'zone' | 'weather'>>): Promise<boolean> {
    return this.update(id, inspection => ({...inspection, ...changes}), 'Updated inspection details');
  }

  updateAnswer(id: string, checklistId: number, answer: InspectionAnswer): Promise<boolean> {
    return this.update(id, inspection => ({
      ...inspection,
      checklist: inspection.checklist.map(item => item.id === checklistId ? {...item, answer} : item),
    }), `Updated checklist item ${checklistId}`);
  }

  updateNote(id: string, checklistId: number, note: string): Promise<boolean> {
    return this.update(id, inspection => ({
      ...inspection,
      checklist: inspection.checklist.map(item => item.id === checklistId ? {...item, note} : item),
    }), 'Updated a corrective action note');
  }

  async addPhoto(id: string, source: string, name: string, metadata?: {capturedAt: string; location: string} | null): Promise<boolean> {
    const inspection = this.getById(id);
    if (!inspection || inspection.status !== 'Draft' || !this.auth.can('write', inspection.projectId)) return false;
    const photoId = crypto.randomUUID();
    let blob: Blob;
    try {
      blob = this.dataUrlToBlob(source);
      const checksum = await this.checksum(blob);
      await this.photoRepository.save({
        photoId,
        inspectionId: inspection.id,
        projectId: inspection.projectId,
        mimeType: blob.type,
        createdAt: metadata?.capturedAt ?? this.timestamp(),
        blob,
      });
      const preview = this.objectUrl(photoId, blob, source);
      const saved = await this.update(id, current => ({
        ...current,
        photos: [...current.photos, {
          id: photoId,
          name,
          source: preview,
          storageKey: photoId,
          mimeType: blob.type,
          byteSize: blob.size,
          checksum,
          capturedAt: metadata?.capturedAt ?? '',
          location: metadata?.location ?? 'Location not collected',
        }],
      }), 'Attached photo evidence');
      if (saved) return true;
      await this.photoRepository.remove(photoId).catch(() => undefined);
      this.revokePhotoUrl(photoId);
      const failed = this.getAnyById(id);
      if (failed) this.setItem({...failed, photos: inspection.photos});
      return false;
    } catch (error) {
      this.storageErrorState.set(this.errorMessage(error, 'Photo evidence could not be stored separately on this device.'));
      return false;
    }
  }

  async removePhoto(id: string, photoId: string): Promise<boolean> {
    const inspection = this.getById(id);
    const photo = inspection?.photos.find(item => item.id === photoId);
    if (!inspection || !photo) return false;
    const saved = await this.update(id, current => ({...current, photos: current.photos.filter(item => item.id !== photoId)}), 'Removed photo evidence');
    if (!saved) {
      const failed = this.getAnyById(id);
      if (failed) this.setItem({...failed, photos: inspection.photos});
      return false;
    }
    if (photo.storageKey) {
      try {
        await this.photoRepository.remove(photo.storageKey);
      } catch (error) {
        this.storageErrorState.set(this.errorMessage(error, 'The photo record was removed, but device storage cleanup must be retried.'));
      }
    }
    this.revokePhotoUrl(photoId);
    return true;
  }

  saveDraft(id: string): Promise<boolean> {
    return this.update(id, inspection => inspection, 'Saved the draft manually');
  }

  async transition(id: string, status: InspectionStatus): Promise<{ok: boolean; message: string}> {
    const inspection = this.getById(id);
    if (!inspection) return {ok: false, message: 'Inspection not found.'};
    if (inspection.syncStatus === 'conflicted') {
      return {ok: false, message: 'Resolve the remote conflict before changing this inspection workflow.'};
    }
    const allowed = inspection.status === 'Draft' && status === 'Submitted' || inspection.status === 'Submitted' && (status === 'Draft' || status === 'Approved');
    if (!allowed) return {ok: false, message: `A ${inspection.status.toLowerCase()} inspection cannot move directly to ${status.toLowerCase()}.`};
    const permission = status === 'Submitted' ? 'write' : 'approve';
    if (!this.auth.can(permission, inspection.projectId)) {
      return {ok: false, message: status === 'Submitted' ? 'Write permission is required to submit this inspection.' : 'Reviewer permission is required for this workflow change.'};
    }
    if (status === 'Approved' && inspection.createdBy === this.auth.identity().id) {
      return {ok: false, message: 'The inspection author cannot approve their own inspection.'};
    }
    if (status === 'Submitted') {
      if (inspection.zone === 'Select a site zone') return {ok: false, message: 'Select a site zone before submitting.'};
      const missing = inspection.checklist.filter(item => item.required && item.answer === null).length;
      if (missing) return {ok: false, message: `Complete ${missing} required item${missing === 1 ? '' : 's'} before submitting.`};
      if (inspection.checklist.some(item => item.answer === 'fail' && !item.note.trim())) return {ok: false, message: 'Add a corrective action note to every failed item.'};
      if (inspection.requiresPhotos && !inspection.photos.length) return {ok: false, message: 'Attach at least one photo before submitting this inspection.'};
    }

    const action = status === 'Submitted' ? 'Submitted the inspection for approval' : status === 'Approved' ? 'Approved the inspection' : 'Returned the inspection to draft';
    const identityId = this.auth.identity().id;
    const now = this.timestamp();
    const next: Inspection = {
      ...inspection,
      status,
      approvedBy: status === 'Approved' ? this.auth.identity().id : null,
      localSaveStatus: 'saving',
      localRevision: inspection.localRevision + 1,
      syncStatus: 'pending',
      updatedAt: now,
      auditTrail: [...inspection.auditTrail, this.audit(action, now)],
    };
    this.setItem(next);
    this.markHydrationMutation(id);
    const saved = await this.persist(next);
    if (!saved) {
      this.setItem({...inspection, localSaveStatus: 'failed', localRevision: next.localRevision});
      return {ok: false, message: 'The workflow change could not be saved. Retry after checking device storage.'};
    }
    await this.enqueueMutation(next, 'transition', {status}, identityId);
    return {ok: true, message: status === 'Submitted' ? 'Inspection submitted for approval.' : status === 'Approved' ? 'Inspection approved and locked.' : 'Inspection returned to draft.'};
  }

  async retrySave(id: string): Promise<boolean> {
    const inspection = this.getAnyById(id);
    if (!inspection) return false;
    const next = {...inspection, localSaveStatus: 'saving' as const};
    this.setItem(next);
    return this.persist(next);
  }

  clearStorageError(): void {
    this.storageErrorState.set(null);
  }

  async markSyncing(inspectionIds: readonly string[]): Promise<void> {
    await Promise.all(inspectionIds.map(async id => {
      const current = this.getAnyById(id);
      if (!current || current.syncStatus === 'conflicted') return;
      const next = {...current, syncStatus: 'syncing' as const};
      this.setItem(next);
      await this.persist(next);
    }));
  }

  async acknowledgeSync(inspectionId: string, revision: number, serverTimestamp: string, hasPendingOperations: boolean): Promise<boolean> {
    const current = this.getAnyById(inspectionId);
    if (!current) return false;
    const next: Inspection = {
      ...current,
      serverRevision: Math.max(current.serverRevision ?? 0, revision),
      lastServerAckAt: serverTimestamp,
      syncStatus: hasPendingOperations ? 'pending' : 'synced',
    };
    this.setItem(next);
    return this.persist(next);
  }

  async markSyncProblem(inspectionId: string, status: 'failed' | 'conflicted', message: string): Promise<void> {
    const current = this.getAnyById(inspectionId);
    if (!current) return;
    const next = {...current, syncStatus: status};
    this.setItem(next);
    this.storageErrorState.set(message);
    await this.persist(next);
  }

  /**
   * Stages a user-selected server version locally. It deliberately remains in
   * `conflicted` until the coordinator has removed the durable stale outbox.
   */
  async replaceWithRemoteSnapshot(snapshot: RemoteInspectionSnapshot): Promise<boolean> {
    const current = this.getAnyById(snapshot.id);
    if (!current || current.projectId !== snapshot.projectId || current.syncStatus !== 'conflicted') return false;

    const localPhotos = new Map(current.photos.map(photo => [photo.id, photo]));
    const reusablePhotoIds = new Set<string>();
    const now = this.timestamp();
    const next: Inspection = {
      ...current,
      title: snapshot.title,
      templateId: snapshot.templateId || current.templateId,
      templateName: snapshot.templateName || current.templateName,
      zone: snapshot.zone,
      inspector: this.identityName(snapshot.createdBy),
      createdBy: snapshot.createdBy,
      approvedBy: snapshot.approvedBy,
      status: snapshot.status,
      localSaveStatus: 'saving',
      localRevision: current.localRevision + 1,
      syncStatus: 'conflicted',
      serverRevision: snapshot.revision,
      lastServerAckAt: snapshot.updatedAt,
      updatedAt: snapshot.updatedAt,
      inspectionDate: snapshot.inspectionDate,
      weather: snapshot.weather,
      requiresPhotos: snapshot.requiresPhotos,
      photos: snapshot.photos.map(photo => {
        const local = localPhotos.get(photo.id);
        const canReuseLocalBlob = Boolean(local && (!photo.checksum || local.checksum === photo.checksum));
        if (canReuseLocalBlob) reusablePhotoIds.add(photo.id);
        return {
          id: photo.id,
          name: photo.name,
          source: canReuseLocalBlob ? local!.source : '',
          storageKey: canReuseLocalBlob ? local!.storageKey : null,
          mimeType: canReuseLocalBlob ? local!.mimeType : 'image/jpeg',
          byteSize: canReuseLocalBlob ? local!.byteSize : 0,
          checksum: photo.checksum ?? (canReuseLocalBlob ? local!.checksum : null),
          capturedAt: photo.capturedAt,
          location: photo.location,
        };
      }),
      checklist: snapshot.checklist.map(item => ({...item})),
      auditTrail: [
        ...current.auditTrail,
        this.audit('Selected the remote version to resolve a conflict', now, `Server revision ${snapshot.revision}`),
      ],
    };
    this.setItem(next);
    this.markHydrationMutation(next.id);
    const saved = await this.persist(next);
    if (!saved) return false;

    for (const photo of current.photos) {
      if (reusablePhotoIds.has(photo.id)) continue;
      if (photo.storageKey) {
        try {
          await this.photoRepository.remove(photo.storageKey);
        } catch (error) {
          this.storageErrorState.set(this.errorMessage(error, 'The remote version was saved, but discarded photo storage cleanup must be retried.'));
        }
      }
      this.revokePhotoUrl(photo.id);
    }
    return true;
  }

  exportCsv(): boolean {
    if (!this.can('export')) return false;
    const header = ['ID', 'Inspection', 'Project', 'Zone', 'Inspector', 'Status', 'Device save', 'Remote sync', 'Updated'];
    const rows = this.inspections().map(item => [item.id, item.title, item.projectName, item.zone, item.inspector, item.status, item.localSaveStatus, item.syncStatus, item.updatedAt]);
    const csv = [header, ...rows].map(row => row.map(cell => this.csvCell(cell)).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], {type: 'text/csv'}));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `fieldnote-inspections-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    return true;
  }

  private async initialize(): Promise<void> {
    try {
      const report = await this.repository.loadAllWithReport();
      const stored = await Promise.all(report.inspections.map(item => this.hydratePhotoSources(this.normalize(item))));
      this.quarantinedRowsState.set(report.quarantinedRows);
      const storedMap = new Map(stored.map(item => [item.id, item]));
      const seedIds = new Set(SEED_INSPECTIONS.map(item => item.id));
      const hydrated = SEED_INSPECTIONS.map(item => storedMap.get(item.id) ?? item).concat(stored.filter(item => !seedIds.has(item.id)));
      const current = new Map(this.inspectionsState().map(item => [item.id, item]));
      this.inspectionsState.set(hydrated.map(item => this.mutationsDuringHydration.has(item.id) ? current.get(item.id) ?? item : item)
        .concat([...current.values()].filter(item => this.mutationsDuringHydration.has(item.id) && !hydrated.some(hydratedItem => hydratedItem.id === item.id))));
    } catch (error) {
      this.storageErrorState.set(this.errorMessage(error, 'Stored inspections could not be loaded. Seed data is still available.'));
    } finally {
      this.initializedState.set(true);
    }
  }

  private async update(id: string, transform: (inspection: Inspection) => Inspection, action: string): Promise<boolean> {
    const current = this.getById(id);
    if (!current || current.status !== 'Draft' || current.syncStatus === 'conflicted' || !this.auth.can('write', current.projectId)) return false;
    const identityId = this.auth.identity().id;
    const now = this.timestamp();
    const next: Inspection = {
      ...transform(current),
      localSaveStatus: 'saving',
      localRevision: current.localRevision + 1,
      syncStatus: 'pending',
      updatedAt: now,
      auditTrail: [...current.auditTrail, this.audit(action, now)],
    };
    this.setItem(next);
    this.markHydrationMutation(id);
    const saved = await this.persist(next);
    if (saved) await this.enqueueMutation(next, 'update', this.updatePayload(next), identityId);
    return saved;
  }

  private async persist(inspection: Inspection): Promise<boolean> {
    const snapshot = this.persistenceSnapshot(inspection);
    const previous = this.writeQueues.get(inspection.id) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => this.repository.save(snapshot));
    this.writeQueues.set(inspection.id, operation);
    try {
      await operation;
      const current = this.getAnyById(inspection.id);
      if (current?.localRevision === inspection.localRevision) this.setItem({...current, localSaveStatus: 'saved'});
      this.storageErrorState.set(null);
      return true;
    } catch (error) {
      const current = this.getAnyById(inspection.id);
      if (current?.localRevision === inspection.localRevision) this.setItem({...current, localSaveStatus: 'failed'});
      this.storageErrorState.set(this.errorMessage(error, 'Changes could not be saved on this device.'));
      return false;
    } finally {
      if (this.writeQueues.get(inspection.id) === operation) this.writeQueues.delete(inspection.id);
    }
  }

  private async enqueueMutation(
    inspection: Inspection,
    kind: OutboxOperationKind,
    payload: Readonly<Record<string, unknown>>,
    identityId: string,
  ): Promise<void> {
    const previous = this.outboxQueues.get(inspection.id) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      const existing = (await this.outbox.list(inspection.projectId)).filter(item => item.inspectionId === inspection.id);
      let pending = existing;
      const hasCreate = pending.some(item => item.kind === 'create');
      if (inspection.serverRevision === null && !hasCreate) {
        const create = this.outboxOperation(inspection, 'create', this.createPayload(inspection), inspection.createdBy, 0);
        await this.outbox.enqueue(create);
        this.outboxRevisionState.update(value => value + 1);
        pending = [...pending, {...create, attempts: 0, lastAttemptAt: null, lastError: null}];
        if (kind === 'create' || kind === 'update') return;
      } else if (kind === 'create') {
        return;
      }
      const projectedRevision = pending.reduce(
        (revision, item) => Math.max(revision, item.baseRevision + 1),
        inspection.serverRevision ?? 0,
      );
      await this.outbox.enqueue(this.outboxOperation(inspection, kind, payload, identityId, projectedRevision));
      this.outboxRevisionState.update(value => value + 1);
    });
    this.outboxQueues.set(inspection.id, operation);
    try {
      await operation;
    } catch (error) {
      const current = this.getAnyById(inspection.id);
      if (current) {
        const failed = {...current, syncStatus: 'failed' as const};
        this.setItem(failed);
        await this.persist(failed);
      }
      this.storageErrorState.set(this.errorMessage(error, 'The change was saved on this device but could not be queued for remote sync.'));
    } finally {
      if (this.outboxQueues.get(inspection.id) === operation) this.outboxQueues.delete(inspection.id);
    }
  }

  private outboxOperation(
    inspection: Inspection,
    kind: OutboxOperationKind,
    payload: Readonly<Record<string, unknown>>,
    identityId: string,
    baseRevision: number,
  ) {
    const operationId = crypto.randomUUID();
    return {
      operationId,
      idempotencyKey: `idem-${operationId}`,
      kind,
      identityId,
      projectId: inspection.projectId,
      inspectionId: inspection.id,
      baseRevision,
      payload,
      createdAt: this.timestamp(),
    };
  }

  private createPayload(inspection: Inspection): Readonly<Record<string, unknown>> {
    return {
      id: inspection.id,
      projectId: inspection.projectId,
      title: inspection.title,
      templateId: inspection.templateId,
      templateName: inspection.templateName,
      zone: inspection.zone,
      inspectionDate: inspection.inspectionDate,
      weather: inspection.weather,
      requiresPhotos: inspection.requiresPhotos,
      photos: this.syncPhotos(inspection),
      checklist: inspection.checklist,
    };
  }

  private updatePayload(inspection: Inspection): Readonly<Record<string, unknown>> {
    return {
      title: inspection.title,
      zone: inspection.zone,
      inspectionDate: inspection.inspectionDate,
      weather: inspection.weather,
      requiresPhotos: inspection.requiresPhotos,
      photos: this.syncPhotos(inspection),
      checklist: inspection.checklist,
    };
  }

  private syncPhotos(inspection: Inspection): Readonly<Record<string, unknown>>[] {
    return inspection.photos.map(photo => ({
      id: photo.id,
      name: photo.name,
      capturedAt: photo.capturedAt,
      location: photo.location,
      ...(photo.checksum ? {checksum: photo.checksum} : {}),
    }));
  }

  private normalize(inspection: Inspection): Inspection {
    const legacy = inspection as Inspection & {
      approvedBy?: string | null;
      createdBy?: string;
      lastServerAckAt?: string | null;
      localSaveStatus?: Inspection['localSaveStatus'];
      localRevision?: number;
      serverRevision?: number | null;
      templatePublishedAt?: string | null;
      templateSnapshotAt?: string | null;
      templateVersion?: number;
    };
    const updatedAt = this.normalizeTimestamp(inspection.updatedAt, '2026-09-02');
    return {
      ...inspection,
      auditTrail: inspection.auditTrail.map(event => ({
        ...event,
        occurredAt: this.normalizeTimestamp(event.occurredAt, updatedAt.slice(0, 10)),
      })),
      approvedBy: legacy.approvedBy ?? null,
      createdBy: legacy.createdBy ?? (inspection.inspector === 'Henry Kim' ? 'demo-inspector' : `legacy:${inspection.inspector.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}`),
      lastServerAckAt: legacy.lastServerAckAt ?? null,
      localSaveStatus: legacy.localSaveStatus ?? 'saved',
      localRevision: legacy.localRevision ?? 0,
      serverRevision: legacy.serverRevision ?? null,
      templatePublishedAt: legacy.templatePublishedAt ?? null,
      templateSnapshotAt: legacy.templateSnapshotAt ?? null,
      templateVersion: legacy.templateVersion ?? 1,
      updatedAt,
      photos: inspection.photos.map(photo => ({
        ...photo,
        byteSize: typeof photo.byteSize === 'number' ? photo.byteSize : 0,
        capturedAt: photo.capturedAt ? this.normalizeTimestamp(photo.capturedAt, updatedAt.slice(0, 10)) : '',
        checksum: typeof photo.checksum === 'string' ? photo.checksum : null,
        mimeType: typeof photo.mimeType === 'string' ? photo.mimeType : this.mimeTypeFromDataUrl(photo.source) ?? 'image/jpeg',
        storageKey: typeof photo.storageKey === 'string' ? photo.storageKey : null,
      })),
    };
  }

  private persistenceSnapshot(inspection: Inspection): Inspection {
    return structuredClone({
      ...inspection,
      localSaveStatus: 'saved' as const,
      photos: inspection.photos.map(photo => photo.storageKey ? {...photo, source: ''} : photo),
    });
  }

  private async hydratePhotoSources(inspection: Inspection): Promise<Inspection> {
    let migrated = false;
    const photos = await Promise.all(inspection.photos.map(async photo => {
      try {
        let storageKey = photo.storageKey;
        if (!storageKey && photo.source.startsWith('data:')) {
          const blob = this.dataUrlToBlob(photo.source);
          storageKey = photo.id;
          await this.photoRepository.save({
            photoId: storageKey,
            inspectionId: inspection.id,
            projectId: inspection.projectId,
            mimeType: blob.type,
            createdAt: photo.capturedAt || inspection.updatedAt,
            blob,
          });
          migrated = true;
          return {
            ...photo,
            source: this.objectUrl(photo.id, blob, photo.source),
            storageKey,
            mimeType: blob.type,
            byteSize: blob.size,
            checksum: await this.checksum(blob),
          };
        }
        if (!storageKey) return photo;
        const record = await this.photoRepository.load(storageKey);
        if (!record) throw new DOMException(`Stored photo blob ${storageKey} is missing.`, 'NotFoundError');
        return {
          ...photo,
          source: this.objectUrl(photo.id, record.blob, photo.source),
          mimeType: record.mimeType,
          byteSize: record.byteSize,
        };
      } catch (error) {
        this.storageErrorState.set(this.errorMessage(error, `Photo ${photo.name} could not be restored from device storage.`));
        return photo;
      }
    }));
    const hydrated = {...inspection, photos};
    if (migrated) {
      try {
        await this.repository.save(this.persistenceSnapshot(hydrated));
      } catch (error) {
        this.storageErrorState.set(this.errorMessage(error, 'Migrated photo metadata could not be saved.'));
      }
    }
    return hydrated;
  }

  private normalizeTimestamp(value: string, fallbackDate: string): string {
    if (/^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))) return value;
    // The pre-schema-v2 demo artifact was published on 2026-09-02 and persisted these relative labels.
    const relative = value.match(/^(Today|Yesterday),\s*(\d{2}):(\d{2})$/);
    if (relative) {
      const date = relative[1] === 'Today' ? '2026-09-02' : '2026-09-01';
      return `${date}T${relative[2]}:${relative[3]}:00+10:00`;
    }
    const august = value.match(/^Aug\s+(\d{1,2}),\s*(\d{2}):(\d{2})$/);
    if (august) return `2026-08-${august[1].padStart(2, '0')}T${august[2]}:${august[3]}:00+10:00`;
    const time = value.match(/^(\d{2}):(\d{2})$/);
    if (time) return `${fallbackDate}T${time[1]}:${time[2]}:00+10:00`;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : `${fallbackDate}T00:00:00+10:00`;
  }

  private setItem(inspection: Inspection): void {
    this.inspectionsState.update(items => items.map(item => item.id === inspection.id ? inspection : item));
  }

  private getAnyById(id: string): Inspection | undefined {
    return this.inspectionsState().find(item => item.id === id);
  }

  private markHydrationMutation(id: string): void {
    if (!this.initializedState()) this.mutationsDuringHydration.add(id);
  }

  private audit(action: string, occurredAt: string, detail?: string): AuditEvent {
    return {id: crypto.randomUUID(), action, actor: this.auth.identity().name, occurredAt, detail};
  }

  private identityName(identityId: string): string {
    return this.auth.demoIdentities.find(identity => identity.id === identityId)?.name ?? identityId;
  }

  private csvCell(value: unknown): string {
    const raw = String(value);
    const safe = /^[=+\-@]/.test(raw.trimStart()) ? `'${raw}` : raw;
    return `"${safe.replaceAll('"', '""')}"`;
  }

  private dataUrlToBlob(source: string): Blob {
    const match = source.match(/^data:([^;,]+)(;base64)?,(.*)$/s);
    if (!match) throw new TypeError('Photo evidence must be a valid data URL.');
    const bytes = match[2]
      ? Uint8Array.from(atob(match[3]), character => character.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(match[3]));
    return new Blob([bytes], {type: match[1]});
  }

  private mimeTypeFromDataUrl(source: string): string | null {
    return source.match(/^data:([^;,]+)/)?.[1] ?? null;
  }

  private objectUrl(photoId: string, blob: Blob, fallback: string): string {
    this.revokePhotoUrl(photoId);
    if (typeof URL.createObjectURL !== 'function') return fallback;
    const url = URL.createObjectURL(blob);
    this.photoObjectUrls.set(photoId, url);
    return url;
  }

  private revokePhotoUrl(photoId: string): void {
    const url = this.photoObjectUrls.get(photoId);
    if (url && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
    this.photoObjectUrls.delete(photoId);
  }

  private async checksum(blob: Blob): Promise<string | null> {
    if (!crypto.subtle) return null;
    try {
      const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
      return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    } catch {
      return null;
    }
  }

  private errorMessage(error: unknown, fallback: string): string {
    const message = typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string' ? error.message : '';
    return message ? `${fallback} ${message}` : fallback;
  }

  private timestamp(): string {
    return new Date().toISOString();
  }
}
