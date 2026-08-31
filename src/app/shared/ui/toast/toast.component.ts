import {ChangeDetectionStrategy, Component, inject} from '@angular/core';
import {ToastService} from '../../../core/services/toast.service';

@Component({
  selector: 'app-toast',
  standalone: true,
  template: `
    @if (toasts.toast(); as toast) {
      <div class="toast" [class]="'toast ' + toast.kind" role="status">
        <span class="toast-mark">{{ toast.kind === 'warning' ? '!' : '✓' }}</span>
        <span>{{ toast.message }}</span>
        <button type="button" aria-label="Dismiss notification" (click)="toasts.dismiss()">×</button>
      </div>
    }
  `,
  styleUrl: './toast.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToastComponent { readonly toasts = inject(ToastService); }
