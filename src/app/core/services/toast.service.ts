import {Injectable, signal} from '@angular/core';

export type ToastKind = 'success' | 'warning' | 'info';
export interface ToastMessage { id: string; message: string; kind: ToastKind; }

@Injectable({providedIn: 'root'})
export class ToastService {
  private readonly currentToast = signal<ToastMessage | null>(null);
  readonly toast = this.currentToast.asReadonly();

  show(message: string, kind: ToastKind = 'success'): void {
    const toast = {id: crypto.randomUUID(), message, kind};
    this.currentToast.set(toast);
    window.setTimeout(() => {
      if (this.currentToast()?.id === toast.id) this.currentToast.set(null);
    }, 3600);
  }

  dismiss(): void { this.currentToast.set(null); }
}
