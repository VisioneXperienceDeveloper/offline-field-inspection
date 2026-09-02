import {ChangeDetectionStrategy, Component, computed, ElementRef, inject, input, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Router, RouterLink} from '@angular/router';
import {InspectionStatus} from '../../../core/models/inspection.models';
import {ConnectivityService} from '../../../core/services/connectivity.service';
import {ToastService} from '../../../core/services/toast.service';
import {InspectionStore} from '../../../core/state/inspection.store';
import {PreferencesStore} from '../../../core/state/preferences.store';
import {SyncCoordinatorService} from '../../../core/sync/sync-coordinator.service';
import {StatusBadgeComponent} from '../../../shared/ui/status-badge/status-badge.component';
import {ActivityTimelineComponent} from './activity-timeline/activity-timeline.component';
import {ChecklistComponent} from './checklist/checklist.component';
import {PhotoAddedEvent, PhotoEvidenceComponent, PhotoProcessingFailure} from './photo-evidence/photo-evidence.component';

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
  readonly preferences = inject(PreferencesStore);
  readonly sync = inject(SyncCoordinatorService);
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
  readonly confirmRemoteReplacement = signal(false);

  async save(): Promise<void> {
    const item = this.inspection();
    if (!item) return;
    const saved = await this.store.saveDraft(item.id);
    this.toast.show(saved ? 'Draft saved on this device.' : 'Draft could not be saved. Check device storage and retry.', saved ? 'success' : 'warning');
  }

  async transition(status: InspectionStatus): Promise<void> {
    const result = await this.store.transition(this.id(), status);
    this.toast.show(result.message, result.ok ? 'success' : 'warning');
  }

  async addPhoto(event: PhotoAddedEvent): Promise<void> {
    const saved = await this.store.addPhoto(this.id(), event.source, event.name, event.metadata);
    this.toast.show(saved ? 'Photo evidence saved on this device.' : 'Photo could not be saved. Free device space and retry.', saved ? 'success' : 'warning');
  }

  photoProcessingFailed(failure: PhotoProcessingFailure): void {
    this.toast.show(failure.message, 'warning');
  }

  async removePhoto(photoId: string): Promise<void> {
    const saved = await this.store.removePhoto(this.id(), photoId);
    this.toast.show(saved ? 'Photo removed.' : 'Photo removal could not be saved.', saved ? 'info' : 'warning');
  }

  async retrySave(): Promise<void> {
    const saved = await this.store.retrySave(this.id());
    this.toast.show(saved ? 'Changes saved on this device.' : 'Save failed again. Check available device storage.', saved ? 'success' : 'warning');
  }

  async syncNow(): Promise<void> {
    const result = await this.sync.syncNow();
    const message = result.acknowledged
      ? `${result.acknowledged} remote operation(s) confirmed.`
      : this.sync.lastError() ?? (result.remaining ? 'Remote operations remain queued.' : 'No remote operations are waiting.');
    this.toast.show(message, result.conflicts || result.rejected ? 'warning' : result.acknowledged ? 'success' : 'info');
  }

  async acceptServerVersion(): Promise<void> {
    const replaced = await this.sync.acceptServerVersion(this.id());
    if (replaced) this.confirmRemoteReplacement.set(false);
    this.toast.show(
      replaced ? 'The server version replaced the conflicted local version.' : this.sync.lastError() ?? 'The conflict could not be resolved.',
      replaced ? 'success' : 'warning',
    );
  }

  scrollTo(sectionId: string): void {
    this.host.nativeElement.querySelector(`#${sectionId}`)?.scrollIntoView({behavior: 'smooth', block: 'start'});
  }

  goBack(): void { void this.router.navigateByUrl('/inspections'); }
}
