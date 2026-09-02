import {ChangeDetectionStrategy, Component, ElementRef, afterNextRender, computed, inject, output, signal, viewChild} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {InspectionTemplateSnapshot, TemplateStore} from '../../../core/state/template.store';

export type InspectionDialogDismissReason = 'cancel' | 'backdrop' | 'escape';

@Component({
  selector: 'app-new-inspection-dialog',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="backdrop" role="presentation" (click)="close('backdrop')"></div>
    <section #dialog class="dialog" role="dialog" aria-modal="true" aria-labelledby="new-inspection-title" (keydown)="handleKeydown($event)">
      <header><div><h2 id="new-inspection-title">Start a new inspection</h2><p>Select the published template that matches today’s work.</p></div><button type="button" aria-label="Close dialog" (click)="close('cancel')">×</button></header>
      <label class="search"><span aria-hidden="true">⌕</span><input #searchInput type="search" aria-label="Search published templates" [ngModel]="query()" (ngModelChange)="query.set($event)" placeholder="Search templates"></label>
      <div class="template-options">
        @for (template of filtered(); track template.id) {
          <button type="button" [class.selected]="selectedId() === template.id" [attr.aria-pressed]="selectedId() === template.id" (click)="selectedId.set(template.id)">
            <span class="template-mark" [class]="'template-mark ' + template.category.toLowerCase()">{{ template.category.slice(0, 2).toUpperCase() }}</span>
            <span><strong>{{ template.name }}</strong><small>{{ template.description }}</small><em>v{{ template.version }} · {{ template.checklist.length }} items · {{ template.requiresPhotos ? 'Photo evidence' : 'Photos optional' }}</em></span><i>{{ selectedId() === template.id ? '✓' : '' }}</i>
          </button>
        } @empty { <p class="empty">No published templates match your search.</p> }
      </div>
      <footer><button type="button" class="secondary" (click)="close('cancel')">Cancel</button><button type="button" class="primary" [disabled]="!selectedTemplate()" (click)="start()">Start inspection</button></footer>
    </section>
  `,
  styleUrl: './new-inspection-dialog.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NewInspectionDialogComponent {
  private readonly templateStore = inject(TemplateStore);
  private readonly dialog = viewChild.required<ElementRef<HTMLElement>>('dialog');
  private readonly searchInput = viewChild.required<ElementRef<HTMLInputElement>>('searchInput');
  readonly cancelled = output<void>();
  readonly dismissed = output<InspectionDialogDismissReason>();
  readonly started = output<InspectionTemplateSnapshot>();
  readonly query = signal('');
  readonly selectedId = signal(this.templateStore.templates().find(template => template.active && template.version > 0)?.id ?? '');
  readonly filtered = computed(() => {
    const query = this.query().trim().toLowerCase();
    return this.templateStore.templates().filter(template => template.active && template.version > 0
      && (!query || `${template.name} ${template.category}`.toLowerCase().includes(query)));
  });
  readonly selectedTemplate = computed(() => this.filtered().find(template => template.id === this.selectedId()));

  constructor() {
    afterNextRender(() => this.searchInput().nativeElement.focus());
  }

  close(reason: InspectionDialogDismissReason): void {
    this.dismissed.emit(reason);
    this.cancelled.emit();
  }

  start(): void {
    const selected = this.selectedTemplate();
    const snapshot = selected ? this.templateStore.snapshot(selected.id) : undefined;
    if (snapshot) this.started.emit(snapshot);
  }

  handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close('escape');
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(this.dialog().nativeElement.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )).filter(element => !element.hasAttribute('hidden'));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !this.dialog().nativeElement.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }
}
