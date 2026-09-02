import {Injectable, signal} from '@angular/core';
import {INSPECTION_TEMPLATES} from '../data/inspection.seed';
import {ChecklistItem, InspectionTemplate} from '../models/inspection.models';

export type TemplateChecklistItem = Pick<ChecklistItem, 'id' | 'title' | 'required'>;

export interface VersionedInspectionTemplate extends InspectionTemplate {
  version: number;
  publishedAt: string | null;
  hasUnpublishedChanges: boolean;
  draftChecklist?: TemplateChecklistItem[];
}

export interface InspectionTemplateSnapshot extends InspectionTemplate {
  templateVersion: number;
  templatePublishedAt: string | null;
  snapshotAt: string;
}

@Injectable({providedIn: 'root'})
export class TemplateStore {
  private readonly storageKey = 'fieldnote-templates';
  private readonly templatesState = signal<VersionedInspectionTemplate[]>(this.load());
  readonly templates = this.templatesState.asReadonly();

  create(name: string, category: InspectionTemplate['category'], description: string): VersionedInspectionTemplate {
    const checklist = [{id: 1, title: 'Add your first inspection requirement', required: true}];
    const template: VersionedInspectionTemplate = {
      id: `tpl-${crypto.randomUUID()}`,
      name,
      category,
      description,
      checklist,
      draftChecklist: structuredClone(checklist),
      requiresPhotos: false,
      approvalSteps: 1,
      active: false,
      version: 0,
      publishedAt: null,
      hasUnpublishedChanges: true,
    };
    this.templatesState.update(items => [template, ...items]);
    this.persist();
    return template;
  }

  toggle(id: string): void {
    this.templatesState.update(items => items.map(item => item.id === id && item.version > 0 ? {...item, active: !item.active} : item));
    this.persist();
  }

  editableChecklist(id: string): TemplateChecklistItem[] {
    const template = this.templatesState().find(item => item.id === id);
    return structuredClone(template?.draftChecklist ?? template?.checklist ?? []);
  }

  updateChecklist(id: string, checklist: TemplateChecklistItem[]): VersionedInspectionTemplate | undefined {
    const normalized = this.normalizeChecklist(checklist);
    if (!normalized.length) return undefined;
    let updated: VersionedInspectionTemplate | undefined;
    this.templatesState.update(items => items.map(item => {
      if (item.id !== id) return item;
      updated = {
        ...item,
        checklist: item.version === 0 ? structuredClone(normalized) : item.checklist,
        draftChecklist: structuredClone(normalized),
        hasUnpublishedChanges: true,
      };
      return updated;
    }));
    if (updated) this.persist();
    return updated;
  }

  publish(id: string): VersionedInspectionTemplate | undefined {
    let published: VersionedInspectionTemplate | undefined;
    this.templatesState.update(items => items.map(item => {
      if (item.id !== id) return item;
      const checklist = this.normalizeChecklist(item.draftChecklist ?? item.checklist);
      if (!checklist.length) return item;
      published = {
        ...item,
        checklist,
        draftChecklist: undefined,
        version: item.version + 1,
        publishedAt: new Date().toISOString(),
        hasUnpublishedChanges: false,
        active: true,
      };
      return published;
    }));
    if (published) this.persist();
    return published;
  }

  snapshot(id: string): InspectionTemplateSnapshot | undefined {
    const template = this.templatesState().find(item => item.id === id && item.active && item.version > 0);
    if (!template) return undefined;
    const {draftChecklist: _draftChecklist, hasUnpublishedChanges: _hasUnpublishedChanges, version, publishedAt, ...published} = template;
    return structuredClone({
      ...published,
      checklist: template.checklist,
      templateVersion: version,
      templatePublishedAt: publishedAt,
      snapshotAt: new Date().toISOString(),
    });
  }

  private load(): VersionedInspectionTemplate[] {
    const saved = localStorage.getItem(this.storageKey);
    if (!saved) return INSPECTION_TEMPLATES.map(template => this.normalizeTemplate(template));
    try {
      const parsed = JSON.parse(saved) as unknown;
      if (!Array.isArray(parsed)) return INSPECTION_TEMPLATES.map(template => this.normalizeTemplate(template));
      const templates = parsed.flatMap(value => this.isTemplate(value) ? [this.normalizeTemplate(value)] : []);
      return templates.length ? templates : INSPECTION_TEMPLATES.map(template => this.normalizeTemplate(template));
    } catch {
      return INSPECTION_TEMPLATES.map(template => this.normalizeTemplate(template));
    }
  }

  private normalizeTemplate(template: InspectionTemplate | VersionedInspectionTemplate): VersionedInspectionTemplate {
    const versioned = template as Partial<VersionedInspectionTemplate>;
    const version = typeof versioned.version === 'number' && versioned.version >= 0 ? Math.floor(versioned.version) : 1;
    const draftChecklist = Array.isArray(versioned.draftChecklist) ? this.normalizeChecklist(versioned.draftChecklist) : undefined;
    return {
      ...structuredClone(template),
      checklist: this.normalizeChecklist(template.checklist),
      version,
      publishedAt: typeof versioned.publishedAt === 'string' ? versioned.publishedAt : null,
      hasUnpublishedChanges: versioned.hasUnpublishedChanges === true,
      draftChecklist: draftChecklist?.length ? draftChecklist : undefined,
      active: version === 0 ? false : template.active,
    };
  }

  private normalizeChecklist(checklist: TemplateChecklistItem[]): TemplateChecklistItem[] {
    return checklist
      .filter(item => typeof item.title === 'string' && item.title.trim().length > 0)
      .map((item, index) => ({id: index + 1, title: item.title.trim(), required: item.required !== false}));
  }

  private isTemplate(value: unknown): value is InspectionTemplate | VersionedInspectionTemplate {
    if (typeof value !== 'object' || value === null) return false;
    const candidate = value as Partial<InspectionTemplate>;
    return typeof candidate.id === 'string' && typeof candidate.name === 'string' && typeof candidate.description === 'string'
      && ['Safety', 'Quality', 'Equipment', 'Environment'].includes(candidate.category ?? '') && Array.isArray(candidate.checklist)
      && typeof candidate.requiresPhotos === 'boolean' && typeof candidate.approvalSteps === 'number' && typeof candidate.active === 'boolean';
  }

  private persist(): void {
    localStorage.setItem(this.storageKey, JSON.stringify(this.templatesState()));
  }
}
