import {ChangeDetectionStrategy, Component, input} from '@angular/core';
import {InspectionStatus, LocalSaveStatus, SyncStatus} from '../../../core/models/inspection.models';

@Component({
  selector: 'app-status-badge',
  standalone: true,
  template: `<span class="badge" [class]="'badge ' + value().toLowerCase()"><i></i>{{ value() }}</span>`,
  styleUrl: './status-badge.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StatusBadgeComponent { readonly value = input.required<InspectionStatus | LocalSaveStatus | SyncStatus>(); }
