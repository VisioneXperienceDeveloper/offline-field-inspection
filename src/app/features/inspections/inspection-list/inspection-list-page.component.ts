import {ChangeDetectionStrategy, Component, computed, inject, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {ActivatedRoute, Router} from '@angular/router';
import {InspectionFilters, InspectionStatus, InspectionTemplate} from '../../../core/models/inspection.models';
import {ConnectivityService} from '../../../core/services/connectivity.service';
import {ToastService} from '../../../core/services/toast.service';
import {InspectionStore} from '../../../core/state/inspection.store';
import {StatusBadgeComponent} from '../../../shared/ui/status-badge/status-badge.component';
import {NewInspectionDialogComponent} from './new-inspection-dialog.component';

type StatusTab = 'All' | InspectionStatus;

@Component({
  selector: 'app-inspection-list-page',
  standalone: true,
  imports: [FormsModule, StatusBadgeComponent, NewInspectionDialogComponent],
  templateUrl: './inspection-list-page.component.html',
  styleUrl: './inspection-list-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InspectionListPageComponent {
  readonly store = inject(InspectionStore);
  readonly connectivity = inject(ConnectivityService);
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

  constructor() {
    const requestedStatus = this.route.snapshot.queryParamMap.get('status');
    if (requestedStatus === 'Draft' || requestedStatus === 'Submitted' || requestedStatus === 'Approved') this.status.set(requestedStatus);
  }

  count(tab: StatusTab): number {
    if (tab === 'All') return this.store.inspections().length;
    return this.store.inspections().filter(item => item.status === tab).length;
  }

  startInspection(template: InspectionTemplate): void {
    const inspection = this.store.createFromTemplate(template);
    this.dialogOpen.set(false);
    this.toast.show(this.connectivity.online() ? 'Inspection created. Syncing now.' : 'Inspection created and saved to this device.', this.connectivity.online() ? 'success' : 'warning');
    void this.router.navigate(['/inspections', inspection.id]);
  }

  openInspection(id: string): void { void this.router.navigate(['/inspections', id]); }
  viewAudit(): void { void this.router.navigateByUrl('/audit-log'); }
  viewSubmitted(): void { this.status.set('Submitted'); }
  clearFilters(): void { this.query.set(''); this.status.set('All'); this.sort.set('updated-desc'); }
  syncNow(): void {
    if (!this.connectivity.online()) { this.toast.show('Connect to a network before syncing.', 'warning'); return; }
    this.store.syncPending();
    this.toast.show(this.store.pendingCount() ? 'Sync started.' : 'Everything is already up to date.', 'info');
  }
}
