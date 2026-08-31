import {ChangeDetectionStrategy, Component, HostListener, computed, inject, signal} from '@angular/core';
import {Router, RouterLink, RouterLinkActive, RouterOutlet} from '@angular/router';
import {ConnectivityService} from '../../core/services/connectivity.service';
import {ToastService} from '../../core/services/toast.service';
import {InspectionStore} from '../../core/state/inspection.store';
import {ProjectContextService} from '../../core/state/project-context.service';
import {ToastComponent} from '../../shared/ui/toast/toast.component';

@Component({
  selector: 'app-shell',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, ToastComponent],
  templateUrl: './app-shell.component.html',
  styleUrl: './app-shell.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppShellComponent {
  readonly connectivity = inject(ConnectivityService);
  readonly inspections = inject(InspectionStore);
  readonly projects = inject(ProjectContextService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);

  readonly mobileOpen = signal(false);
  readonly projectMenuOpen = signal(false);
  readonly notificationsOpen = signal(false);
  readonly profileOpen = signal(false);
  readonly notificationCount = computed(() => this.inspections.submittedCount() + (this.inspections.pendingCount() ? 1 : 0));

  toggleOffline(): void {
    this.connectivity.toggleTestMode();
    if (this.connectivity.online()) {
      this.inspections.syncPending();
      this.toast.show('Connection restored. Pending changes are syncing.');
    } else {
      this.toast.show('Offline test mode enabled. Changes will stay on this device.', 'warning');
    }
  }

  selectProject(projectId: string): void {
    this.projects.select(projectId);
    this.projectMenuOpen.set(false);
    this.toast.show(`Project changed to ${this.projects.activeProject().name}.`, 'info');
  }

  navigate(path: string): void {
    this.closeMenus();
    void this.router.navigateByUrl(path);
  }

  closeMenus(): void {
    this.mobileOpen.set(false);
    this.projectMenuOpen.set(false);
    this.notificationsOpen.set(false);
    this.profileOpen.set(false);
  }

  @HostListener('document:keydown.escape') onEscape(): void { this.closeMenus(); }
}
