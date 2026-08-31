import {DestroyRef, Injectable, computed, inject, signal} from '@angular/core';

@Injectable({providedIn: 'root'})
export class ConnectivityService {
  private readonly destroyRef = inject(DestroyRef);
  private readonly browserOnline = signal(navigator.onLine);
  private readonly simulatedOffline = signal(false);

  readonly online = computed(() => this.browserOnline() && !this.simulatedOffline());
  readonly testMode = this.simulatedOffline.asReadonly();

  constructor() {
    const onlineHandler = () => this.browserOnline.set(true);
    const offlineHandler = () => this.browserOnline.set(false);
    window.addEventListener('online', onlineHandler);
    window.addEventListener('offline', offlineHandler);
    this.destroyRef.onDestroy(() => {
      window.removeEventListener('online', onlineHandler);
      window.removeEventListener('offline', offlineHandler);
    });
  }

  toggleTestMode(): void {
    this.simulatedOffline.update(value => !value);
  }

  setSimulatedOffline(offline: boolean): void {
    this.simulatedOffline.set(offline);
  }
}
