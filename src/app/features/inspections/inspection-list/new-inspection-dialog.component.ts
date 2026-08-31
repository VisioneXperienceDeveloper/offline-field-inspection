import {ChangeDetectionStrategy, Component, inject, output, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {InspectionTemplate} from '../../../core/models/inspection.models';
import {TemplateStore} from '../../../core/state/template.store';

@Component({
  selector: 'app-new-inspection-dialog',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="backdrop" role="presentation" (click)="cancelled.emit()"></div>
    <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="new-inspection-title">
      <header><div><h2 id="new-inspection-title">Start a new inspection</h2><p>Select the template that matches today’s work.</p></div><button type="button" aria-label="Close dialog" (click)="cancelled.emit()">×</button></header>
      <label class="search"><span>⌕</span><input type="search" [(ngModel)]="query" placeholder="Search templates"></label>
      <div class="template-options">
        @for (template of filtered(); track template.id) {
          <button type="button" [class.selected]="selectedId() === template.id" (click)="selectedId.set(template.id)">
            <span class="template-mark" [class]="'template-mark ' + template.category.toLowerCase()">{{ template.category.slice(0, 2).toUpperCase() }}</span>
            <span><strong>{{ template.name }}</strong><small>{{ template.description }}</small><em>{{ template.checklist.length }} items · {{ template.requiresPhotos ? 'Photo evidence' : 'Photos optional' }}</em></span><i>{{ selectedId() === template.id ? '✓' : '' }}</i>
          </button>
        } @empty { <p class="empty">No templates match your search.</p> }
      </div>
      <footer><button type="button" class="secondary" (click)="cancelled.emit()">Cancel</button><button type="button" class="primary" [disabled]="!selectedTemplate()" (click)="start()">Start inspection</button></footer>
    </section>
  `,
  styleUrl: './new-inspection-dialog.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NewInspectionDialogComponent {
  private readonly templateStore = inject(TemplateStore);
  readonly cancelled = output<void>();
  readonly started = output<InspectionTemplate>();
  readonly selectedId = signal('tpl-safety-weekly');
  query = '';
  filtered = () => this.templateStore.templates().filter(template => template.active && (!this.query.trim() || `${template.name} ${template.category}`.toLowerCase().includes(this.query.toLowerCase())));
  selectedTemplate = () => this.templateStore.templates().find(template => template.id === this.selectedId());
  start(): void { const selected = this.selectedTemplate(); if (selected) this.started.emit(selected); }
}
