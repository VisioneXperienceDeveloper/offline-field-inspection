import {Injectable, signal} from '@angular/core';
import {INSPECTION_TEMPLATES} from '../data/inspection.seed';
import {InspectionTemplate} from '../models/inspection.models';

@Injectable({providedIn: 'root'})
export class TemplateStore {
  private readonly storageKey = 'fieldnote-templates';
  private readonly templatesState = signal<InspectionTemplate[]>(this.load());
  readonly templates = this.templatesState.asReadonly();

  create(name: string, category: InspectionTemplate['category'], description: string): InspectionTemplate {
    const template: InspectionTemplate = {
      id: `tpl-${crypto.randomUUID()}`, name, category, description,
      checklist: [{id: 1, title: 'Add your first inspection requirement', required: true}],
      requiresPhotos: false, approvalSteps: 1, active: true,
    };
    this.templatesState.update(items => [template, ...items]);
    this.persist();
    return template;
  }

  toggle(id: string): void {
    this.templatesState.update(items => items.map(item => item.id === id ? {...item, active: !item.active} : item));
    this.persist();
  }

  private load(): InspectionTemplate[] {
    const saved = localStorage.getItem(this.storageKey);
    if (!saved) return INSPECTION_TEMPLATES;
    try { return JSON.parse(saved) as InspectionTemplate[]; } catch { return INSPECTION_TEMPLATES; }
  }

  private persist(): void { localStorage.setItem(this.storageKey, JSON.stringify(this.templatesState())); }
}
