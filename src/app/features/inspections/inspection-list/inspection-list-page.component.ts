import {ChangeDetectionStrategy, Component, ElementRef, computed, inject, signal, viewChild} from '@angular/core';
import {DatePipe} from '@angular/common';
import {FormsModule} from '@angular/forms';
import {ActivatedRoute, Router} from '@angular/router';
import {InspectionFilters, InspectionStatus, InspectionTemplate} from '../../../core/models/inspection.models';
import {ConnectivityService} from '../../../core/services/connectivity.service';
import {ToastService} from '../../../core/services/toast.service';
import {InspectionStore} from '../../../core/state/inspection.store';
import {PreferencesStore} from '../../../core/state/preferences.store';
import {SyncCoordinatorService} from '../../../core/sync/sync-coordinator.service';
import {StatusBadgeComponent} from '../../../shared/ui/status-badge/status-badge.component';
import {NewInspectionDialogComponent} from './new-inspection-dialog.component';

type StatusTab = 'All' | InspectionStatus;

@Component({
  selector: 'app-inspection-list-page',
  standalone: true,
  imports: [DatePipe, FormsModule, StatusBadgeComponent, NewInspectionDialogComponent],
  templateUrl: './inspection-list-page.component.html',
  styleUrl: './inspection-list-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InspectionListPageComponent {
  readonly store = inject(InspectionStore);
  readonly connectivity = inject(ConnectivityService);
  readonly preferences = inject(PreferencesStore);
  readonly sync = inject(SyncCoordinatorService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly toast = inject(ToastService);

  readonly query = signal('');
  readonly status = signal<StatusTab>('All');
  readonly sort = signal<InspectionFilters['sort']>('updated-desc');
  readonly dialogOpen = signal(false);
  readonly statusTabs: StatusTab[] = ['All', 'Draft', 'Submitted', 'Approved'];
  readonly filtered = computed(() => this.store.filter({query: this.query(), status: this.status(), sort: this.sort()}));
  readonly recentEvents = computed(() => this.store.auditEvents().slice(0, 5));
  private readonly newInspectionButton = viewChild<ElementRef<HTMLButtonElement>>('newInspectionButton');

  constructor() {
    const requestedStatus = this.route.snapshot.queryParamMap.get('status');
    if (requestedStatus === 'Draft' || requestedStatus === 'Submitted' || requestedStatus === 'Approved') this.status.set(requestedStatus);
  }

  count(tab: StatusTab): number {
    if (tab === 'All') return this.store.inspections().length;
    return this.store.inspections().filter(item => item.status === tab).length;
  }

  startInspection(template: InspectionTemplate): void {
    let inspection;
    try {
      inspection = this.store.createFromTemplate(template);
    } catch {
      this.toast.show('Your current role cannot create inspections in this project.', 'warning');
      this.closeDialog();
      return;
    }
    this.dialogOpen.set(false);
    this.toast.show('Inspection created. Saving it on this device now.', 'info');
    void this.router.navigate(['/inspections', inspection.id]);
  }

  closeDialog(): void {
    this.dialogOpen.set(false);
    queueMicrotask(() => this.newInspectionButton()?.nativeElement.focus());
  }

  openInspection(id: string): void { void this.router.navigate(['/inspections', id]); }
  viewAudit(): void { void this.router.navigateByUrl('/audit-log'); }
  viewSubmitted(): void { this.status.set('Submitted'); }
  clearFilters(): void { this.query.set(''); this.status.set('All'); this.sort.set('updated-desc'); }
  async syncNow(): Promise<void> {
    const failed = this.store.inspections().filter(item => item.localSaveStatus === 'failed');
    if (failed.length) {
      const results = await Promise.all(failed.map(item => this.store.retrySave(item.id)));
      if (!results.every(Boolean)) {
        this.toast.show('Some changes still could not be saved on this device.', 'warning');
        return;
      }
    }
    const result = await this.sync.syncNow();
    if (result.conflicts) this.toast.show(`${result.conflicts} remote conflict(s) need review before retrying.`, 'warning');
    else if (result.rejected) this.toast.show(this.sync.lastError() ?? `${result.rejected} remote operation(s) were rejected.`, 'warning');
    else if (result.acknowledged) this.toast.show(`${result.acknowledged} remote operation(s) confirmed by the server.`, 'success');
    else if (result.remaining) this.toast.show(this.sync.lastError() ?? 'Remote operations remain queued.', 'info');
    else this.toast.show('No remote operations are waiting for this project.', 'info');
  }
}
