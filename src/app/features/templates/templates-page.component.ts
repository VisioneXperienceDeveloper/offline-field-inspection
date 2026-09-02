import {ChangeDetectionStrategy, Component, computed, inject, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Router} from '@angular/router';
import {InspectionTemplate} from '../../core/models/inspection.models';
import {ToastService} from '../../core/services/toast.service';
import {InspectionStore} from '../../core/state/inspection.store';
import {
  TemplateChecklistItem,
  TemplateStore,
  VersionedInspectionTemplate,
} from '../../core/state/template.store';

@Component({
  selector: 'app-templates-page',
  standalone: true,
  imports: [FormsModule],
  template: `
    <main class="page">
      <header>
        <div><h1>Inspection templates</h1><p>Standardise field work with versioned checklists and approval rules.</p></div>
        @if (inspections.can('write')) { <button class="primary" type="button" (click)="dialogOpen.set(true)">＋ New template</button> }
      </header>

      <section class="toolbar">
        <label>⌕<input aria-label="Search templates" placeholder="Search templates" [ngModel]="query()" (ngModelChange)="query.set($event)"></label>
        <select aria-label="Filter by category" [ngModel]="category()" (ngModelChange)="category.set($event)"><option>All categories</option><option>Safety</option><option>Quality</option><option>Equipment</option><option>Environment</option></select>
        <span>{{ filtered().length }} templates</span>
      </section>

      <section class="cards">
        @for (template of filtered(); track template.id) {
          <article [class.inactive]="!template.active">
            <div class="card-head">
              <span [attr.data-category]="template.category">{{ template.category[0] }}</span>
              <div><small>{{ template.category }} · v{{ template.version }}</small><h2>{{ template.name }}</h2></div>
              <button type="button" class="switch" [class.on]="template.active" [disabled]="template.version === 0 || !inspections.can('write')" (click)="toggle(template)" [attr.aria-label]="template.active ? 'Deactivate template' : 'Activate template'" [attr.aria-pressed]="template.active"><i></i></button>
            </div>
            <p>{{ template.description }}</p>
            @if (template.hasUnpublishedChanges) { <p class="draft-status" role="status">Unpublished checklist changes</p> }
            <dl>
              <div><dt>Published checklist</dt><dd>{{ template.checklist.length }} items</dd></div>
              <div><dt>Photo evidence</dt><dd>{{ template.requiresPhotos ? 'Required' : 'Optional' }}</dd></div>
              <div><dt>Approval steps</dt><dd>{{ template.approvalSteps }}</dd></div>
            </dl>
            <div class="card-actions">
              <button type="button" [disabled]="!inspections.can('write')" (click)="beginEdit(template)">Edit checklist</button>
              <button type="button" class="use" [disabled]="!template.active || template.version === 0 || !inspections.can('write')" (click)="use(template)">Use template</button>
            </div>
          </article>
        }
      </section>

      @if (!filtered().length) {
        <section class="empty"><span>⌕</span><h2>No matching templates</h2><p>Adjust your search or create a new template.</p><button type="button" (click)="query.set(''); category.set('All categories')">Clear filters</button></section>
      }
    </main>

    @if (dialogOpen()) {
      <div class="backdrop" role="presentation" (click)="dialogOpen.set(false)">
        <form role="dialog" aria-modal="true" aria-labelledby="create-template-title" (click)="$event.stopPropagation()" (ngSubmit)="create()">
          <header><div><h2 id="create-template-title">Create template</h2><p>Create a draft, then review and publish its checklist.</p></div><button type="button" aria-label="Close create template dialog" (click)="dialogOpen.set(false)">×</button></header>
          <label><span>Template name</span><input required name="name" [(ngModel)]="draftName" placeholder="e.g. Daily site walk"></label>
          <label><span>Category</span><select name="category" [(ngModel)]="draftCategory"><option>Safety</option><option>Quality</option><option>Equipment</option><option>Environment</option></select></label>
          <label><span>Description</span><textarea name="description" [(ngModel)]="draftDescription" placeholder="Describe when this template should be used"></textarea></label>
          <footer><button type="button" (click)="dialogOpen.set(false)">Cancel</button><button class="primary" [disabled]="!draftName.trim()">Create draft</button></footer>
        </form>
      </div>
    }

    @if (editing(); as template) {
      <div class="backdrop" role="presentation" (click)="closeEditor()">
        <form class="editor" role="dialog" aria-modal="true" aria-labelledby="edit-checklist-title" (click)="$event.stopPropagation()" (ngSubmit)="publishEditing(template)">
          <header><div><h2 id="edit-checklist-title">Edit checklist</h2><p>{{ template.name }} · next version v{{ template.version + 1 }}</p></div><button type="button" aria-label="Close checklist editor" (click)="closeEditor()">×</button></header>
          <div class="editor-body">
            @for (item of checklistDraft; track $index; let index = $index) {
              <div class="checklist-editor-row">
                <span>{{ index + 1 }}</span>
                <label><span>Requirement</span><input required [name]="'item-' + index" [(ngModel)]="item.title"></label>
                <label class="required"><input type="checkbox" [name]="'required-' + index" [(ngModel)]="item.required"> Required</label>
                <button type="button" aria-label="Remove checklist item" [disabled]="checklistDraft.length === 1" (click)="removeChecklistItem(index)">×</button>
              </div>
            }
            <button type="button" class="add-item" (click)="addChecklistItem()">＋ Add checklist item</button>
            <p class="snapshot-note">Publishing creates a new version. Inspections already started keep their original checklist snapshot.</p>
          </div>
          <footer><button type="button" (click)="saveChecklistDraft(template)">Save draft</button><button class="primary" [disabled]="!validChecklist()">Publish v{{ template.version + 1 }}</button></footer>
        </form>
      </div>
    }
  `,
  styleUrl: './templates-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TemplatesPageComponent {
  readonly templates = inject(TemplateStore);
  readonly inspections = inject(InspectionStore);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  readonly query = signal('');
  readonly category = signal('All categories');
  readonly dialogOpen = signal(false);
  readonly editing = signal<VersionedInspectionTemplate | null>(null);
  draftName = '';
  draftCategory: InspectionTemplate['category'] = 'Safety';
  draftDescription = '';
  checklistDraft: TemplateChecklistItem[] = [];

  readonly filtered = computed(() => {
    const query = this.query().trim().toLowerCase();
    return this.templates.templates().filter(template =>
      (this.category() === 'All categories' || template.category === this.category())
      && (!query || `${template.name} ${template.description}`.toLowerCase().includes(query)),
    );
  });

  toggle(template: VersionedInspectionTemplate): void {
    this.templates.toggle(template.id);
    this.toast.show(`${template.name} ${template.active ? 'deactivated' : 'activated'}.`, 'info');
  }

  use(template: VersionedInspectionTemplate): void {
    const snapshot = this.templates.snapshot(template.id);
    if (!snapshot) {
      this.toast.show('Publish and activate this template before using it.', 'warning');
      return;
    }
    let item;
    try {
      item = this.inspections.createFromTemplate(snapshot);
    } catch {
      this.toast.show('Your current role cannot start inspections in this project.', 'warning');
      return;
    }
    void this.router.navigate(['/inspections', item.id]);
  }

  create(): void {
    if (!this.draftName.trim()) return;
    const template = this.templates.create(
      this.draftName.trim(),
      this.draftCategory,
      this.draftDescription.trim() || 'Custom field inspection template.',
    );
    this.dialogOpen.set(false);
    this.draftName = '';
    this.draftDescription = '';
    this.beginEdit(template);
    this.toast.show('Template draft created. Review its checklist before publishing.', 'info');
  }

  beginEdit(template: VersionedInspectionTemplate): void {
    this.checklistDraft = this.templates.editableChecklist(template.id);
    this.editing.set(template);
  }

  closeEditor(): void {
    this.editing.set(null);
    this.checklistDraft = [];
  }

  addChecklistItem(): void {
    this.checklistDraft = [...this.checklistDraft, {id: this.checklistDraft.length + 1, title: '', required: true}];
  }

  removeChecklistItem(index: number): void {
    if (this.checklistDraft.length === 1) return;
    this.checklistDraft = this.checklistDraft.filter((_, itemIndex) => itemIndex !== index);
  }

  validChecklist(): boolean {
    return this.checklistDraft.length > 0 && this.checklistDraft.every(item => item.title.trim().length > 0);
  }

  saveChecklistDraft(template: VersionedInspectionTemplate): void {
    if (!this.validChecklist() || !this.templates.updateChecklist(template.id, this.checklistDraft)) {
      this.toast.show('Each checklist item needs a requirement.', 'warning');
      return;
    }
    this.closeEditor();
    this.toast.show('Checklist draft saved. Publish it when the review is complete.', 'info');
  }

  publishEditing(template: VersionedInspectionTemplate): void {
    if (!this.validChecklist() || !this.templates.updateChecklist(template.id, this.checklistDraft)) {
      this.toast.show('Each checklist item needs a requirement.', 'warning');
      return;
    }
    const published = this.templates.publish(template.id);
    if (!published) {
      this.toast.show('The template could not be published.', 'warning');
      return;
    }
    this.closeEditor();
    this.toast.show(`${published.name} v${published.version} published.`, 'success');
  }
}
