import {Injectable, computed, effect, inject, signal} from '@angular/core';
import {SEED_INSPECTIONS} from '../data/inspection.seed';
import {IndexedDbInspectionRepository} from '../data/indexed-db.repository';
import {AuditEvent, Inspection, InspectionAnswer, InspectionFilters, InspectionStatus, InspectionTemplate} from '../models/inspection.models';
import {ConnectivityService} from '../services/connectivity.service';
import {ProjectContextService} from './project-context.service';

@Injectable({providedIn: 'root'})
export class InspectionStore {
  private readonly repository = inject(IndexedDbInspectionRepository);
  private readonly connectivity = inject(ConnectivityService);
  private readonly projectContext = inject(ProjectContextService);
  private readonly inspectionsState = signal<Inspection[]>(structuredClone(SEED_INSPECTIONS));
  private readonly initializedState = signal(false);

  readonly inspections = this.inspectionsState.asReadonly();
  readonly initialized = this.initializedState.asReadonly();
  readonly pendingCount = computed(() => this.inspectionsState().filter(item => item.syncStatus !== 'synced').length);
  readonly draftCount = computed(() => this.inspectionsState().filter(item => item.status === 'Draft').length);
  readonly submittedCount = computed(() => this.inspectionsState().filter(item => item.status === 'Submitted').length);
  readonly approvedCount = computed(() => this.inspectionsState().filter(item => item.status === 'Approved').length);
  readonly auditEvents = computed(() => this.inspectionsState()
    .flatMap(inspection => inspection.auditTrail.map(event => ({...event, inspectionId: inspection.id, inspectionTitle: inspection.title})))
    .reverse());

  constructor() {
    void this.initialize();
    effect(() => {
      if (this.connectivity.online() && this.initializedState()) queueMicrotask(() => this.syncPending());
    });
  }

  getById(id: string): Inspection | undefined { return this.inspectionsState().find(item => item.id === id); }

  filter(filters: InspectionFilters): Inspection[] {
    const query = filters.query.trim().toLowerCase();
    return this.inspectionsState()
      .filter(item => filters.status === 'All' || item.status === filters.status)
      .filter(item => !query || `${item.title} ${item.id} ${item.zone} ${item.inspector}`.toLowerCase().includes(query))
      .sort((a, b) => filters.sort === 'title' ? a.title.localeCompare(b.title) : filters.sort === 'updated-asc' ? a.updatedAt.localeCompare(b.updatedAt) : b.updatedAt.localeCompare(a.updatedAt));
  }

  createFromTemplate(template: InspectionTemplate): Inspection {
    const sequence = 85 + this.inspectionsState().length;
    const project = this.projectContext.activeProject();
    const now = this.time();
    const inspection: Inspection = {
      id: `INSP-2026-${String(sequence).padStart(4, '0')}`,
      title: template.name,
      templateId: template.id,
      templateName: template.name,
      projectId: project.id,
      projectName: project.name,
      zone: 'Select a site zone',
      inspector: 'Henry Kim',
      status: 'Draft',
      syncStatus: this.connectivity.online() ? 'syncing' : 'pending',
      updatedAt: `Today, ${now}`,
      inspectionDate: new Date().toISOString().slice(0, 10),
      weather: 'Clear',
      requiresPhotos: template.requiresPhotos,
      photos: [],
      checklist: template.checklist.map(item => ({...item, answer: null, note: ''})),
      auditTrail: [this.audit('Created the inspection', now, template.name)],
    };
    this.inspectionsState.update(items => [inspection, ...items]);
    this.persist(inspection);
    return inspection;
  }

  updateDetails(id: string, changes: Partial<Pick<Inspection, 'title' | 'inspectionDate' | 'zone' | 'weather'>>): void {
    this.update(id, inspection => ({...inspection, ...changes}), 'Updated inspection details');
  }

  updateAnswer(id: string, checklistId: number, answer: InspectionAnswer): void {
    this.update(id, inspection => ({
      ...inspection,
      checklist: inspection.checklist.map(item => item.id === checklistId ? {...item, answer} : item),
    }), `Updated checklist item ${checklistId}`);
  }

  updateNote(id: string, checklistId: number, note: string): void {
    this.update(id, inspection => ({
      ...inspection,
      checklist: inspection.checklist.map(item => item.id === checklistId ? {...item, note} : item),
    }), 'Updated a corrective action note');
  }

  addPhoto(id: string, source: string, name: string): void {
    this.update(id, inspection => ({
      ...inspection,
      photos: [...inspection.photos, {id: crypto.randomUUID(), name, source, capturedAt: this.time(), location: 'GPS captured'}],
    }), 'Attached photo evidence');
  }

  removePhoto(id: string, photoId: string): void {
    this.update(id, inspection => ({...inspection, photos: inspection.photos.filter(photo => photo.id !== photoId)}), 'Removed photo evidence');
  }

  saveDraft(id: string): void {
    this.update(id, inspection => inspection, 'Saved the draft manually');
  }

  transition(id: string, status: InspectionStatus): {ok: boolean; message: string} {
    const inspection = this.getById(id);
    if (!inspection) return {ok: false, message: 'Inspection not found.'};
    const allowed = inspection.status === 'Draft' && status === 'Submitted' || inspection.status === 'Submitted' && (status === 'Draft' || status === 'Approved');
    if (!allowed) return {ok: false, message: `A ${inspection.status.toLowerCase()} inspection cannot move directly to ${status.toLowerCase()}.`};
    if (status === 'Submitted') {
      if (inspection.zone === 'Select a site zone') return {ok: false, message: 'Select a site zone before submitting.'};
      const missing = inspection.checklist.filter(item => item.required && item.answer === null).length;
      if (missing) return {ok: false, message: `Complete ${missing} required item${missing === 1 ? '' : 's'} before submitting.`};
      const failedWithoutNote = inspection.checklist.some(item => item.answer === 'fail' && !item.note.trim());
      if (failedWithoutNote) return {ok: false, message: 'Add a corrective action note to every failed item.'};
      if (inspection.requiresPhotos && !inspection.photos.length) return {ok: false, message: 'Attach at least one photo before submitting this inspection.'};
    }
    const action = status === 'Submitted' ? 'Submitted the inspection for approval' : status === 'Approved' ? 'Approved the inspection' : 'Returned the inspection to draft';
    this.update(id, item => ({...item, status}), action);
    return {ok: true, message: status === 'Submitted' ? 'Inspection submitted for approval.' : status === 'Approved' ? 'Inspection approved and locked.' : 'Inspection returned to draft.'};
  }

  syncPending(): void {
    if (!this.connectivity.online()) return;
    const pending = this.inspectionsState().filter(item => item.syncStatus !== 'synced');
    if (!pending.length) return;
    this.inspectionsState.update(items => items.map(item => pending.some(value => value.id === item.id) ? {...item, syncStatus: 'syncing'} : item));
    pending.forEach((inspection, index) => window.setTimeout(() => this.markSynced(inspection.id), 500 + index * 280));
  }

  exportCsv(): void {
    const header = ['ID', 'Inspection', 'Project', 'Zone', 'Inspector', 'Status', 'Sync status', 'Updated'];
    const rows = this.inspectionsState().map(item => [item.id, item.title, item.projectName, item.zone, item.inspector, item.status, item.syncStatus, item.updatedAt]);
    const csv = [header, ...rows].map(row => row.map(cell => `"${String(cell).replaceAll('"', '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], {type: 'text/csv'}));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `fieldnote-inspections-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  private async initialize(): Promise<void> {
    try {
      const stored = await this.repository.loadAll();
      const storedMap = new Map(stored.map(item => [item.id, item]));
      const seedIds = new Set(SEED_INSPECTIONS.map(item => item.id));
      const merged = SEED_INSPECTIONS.map(item => storedMap.get(item.id) ?? item).concat(stored.filter(item => !seedIds.has(item.id)));
      this.inspectionsState.set(merged);
    } finally {
      this.initializedState.set(true);
    }
  }

  private update(id: string, transform: (inspection: Inspection) => Inspection, action: string): void {
    const current = this.getById(id);
    if (!current || current.status !== 'Draft' && action.startsWith('Updated')) return;
    const now = this.time();
    const next = {
      ...transform(current),
      syncStatus: this.connectivity.online() ? 'syncing' as const : 'pending' as const,
      updatedAt: `Today, ${now}`,
      auditTrail: [...current.auditTrail, this.audit(action, now)],
    };
    this.inspectionsState.update(items => items.map(item => item.id === id ? next : item));
    this.persist(next);
  }

  private markSynced(id: string): void {
    const item = this.getById(id);
    if (!item) return;
    const next = {...item, syncStatus: 'synced' as const};
    this.inspectionsState.update(items => items.map(value => value.id === id ? next : value));
    void this.repository.save(next);
  }

  private persist(inspection: Inspection): void {
    void this.repository.save(inspection);
    if (this.connectivity.online()) window.setTimeout(() => this.markSynced(inspection.id), 700);
  }

  private audit(action: string, occurredAt: string, detail?: string): AuditEvent {
    return {id: crypto.randomUUID(), action, actor: 'Henry Kim', occurredAt, detail};
  }

  private time(): string { return new Date().toLocaleTimeString('en-AU', {hour: '2-digit', minute: '2-digit', hour12: false}); }
}
