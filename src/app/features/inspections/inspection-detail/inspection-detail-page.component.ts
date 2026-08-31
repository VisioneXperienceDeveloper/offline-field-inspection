import {ChangeDetectionStrategy, Component, computed, ElementRef, inject, input} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Router, RouterLink} from '@angular/router';
import {InspectionStatus} from '../../../core/models/inspection.models';
import {ConnectivityService} from '../../../core/services/connectivity.service';
import {ToastService} from '../../../core/services/toast.service';
import {InspectionStore} from '../../../core/state/inspection.store';
import {StatusBadgeComponent} from '../../../shared/ui/status-badge/status-badge.component';
import {ActivityTimelineComponent} from './activity-timeline/activity-timeline.component';
import {ChecklistComponent} from './checklist/checklist.component';
import {PhotoEvidenceComponent} from './photo-evidence/photo-evidence.component';

@Component({
  selector: 'app-inspection-detail-page',
  standalone: true,
  imports: [FormsModule, RouterLink, StatusBadgeComponent, ActivityTimelineComponent, ChecklistComponent, PhotoEvidenceComponent],
  templateUrl: './inspection-detail-page.component.html',
  styleUrl: './inspection-detail-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InspectionDetailPageComponent {
  readonly id = input.required<string>();
  readonly store = inject(InspectionStore);
  readonly connectivity = inject(ConnectivityService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);
  private readonly host = inject(ElementRef<HTMLElement>);

  readonly inspection = computed(() => this.store.getById(this.id()));
  readonly completed = computed(() => this.inspection()?.checklist.filter(item => item.answer !== null).length ?? 0);
  readonly required = computed(() => this.inspection()?.checklist.filter(item => item.required).length ?? 0);
  readonly progress = computed(() => {
    const item = this.inspection();
    return item?.checklist.length ? Math.round(this.completed() / item.checklist.length * 100) : 0;
  });

  save(): void {
    const item = this.inspection();
    if (!item) return;
    this.store.saveDraft(item.id);
    this.toast.show(this.connectivity.online() ? 'Draft saved. Syncing changes.' : 'Draft saved securely on this device.', 'success');
  }

  transition(status: InspectionStatus): void {
    const result = this.store.transition(this.id(), status);
    this.toast.show(result.message, result.ok ? 'success' : 'warning');
  }

  addPhoto(event: {source: string; name: string}): void {
    this.store.addPhoto(this.id(), event.source, event.name);
    this.toast.show('Photo evidence attached.', 'success');
  }

  removePhoto(photoId: string): void {
    this.store.removePhoto(this.id(), photoId);
    this.toast.show('Photo removed.', 'info');
  }

  scrollTo(sectionId: string): void {
    this.host.nativeElement.querySelector(`#${sectionId}`)?.scrollIntoView({behavior: 'smooth', block: 'start'});
  }

  goBack(): void { void this.router.navigateByUrl('/inspections'); }
}
