import {ChangeDetectionStrategy, Component, inject} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {ConnectivityService} from '../../core/services/connectivity.service';
import {ToastService} from '../../core/services/toast.service';
import {FieldPreferences, PreferencesStore} from '../../core/state/preferences.store';

@Component({
  selector: 'app-settings-page',
  standalone: true,
  imports: [FormsModule],
  template: `
    <main class="page">
      <header><h1>Settings</h1><p>Configure field data, offline behaviour and workspace preferences.</p></header>
      <form (ngSubmit)="save()">
        <section>
          <header><span>◎</span><div><h2>Field profile</h2><p>Defaults applied when a new inspection is created.</p></div></header>
          <div class="fields">
            <label><span>Default inspector</span><input name="inspector" [(ngModel)]="prefs.defaultInspector" autocomplete="name"></label>
            <label><span>Date and time format</span><select disabled><option>English (Australia)</option></select></label>
          </div>
        </section>
        <section>
          <header><span>↻</span><div><h2>Offline and sync</h2><p>Choose when the app may attempt to send pending changes.</p></div></header>
          <label class="toggle"><div><strong>Automatic sync</strong><small>Allow pending changes to be sent when a network is available.</small></div><input type="checkbox" name="autoSync" [(ngModel)]="prefs.autoSync"><i></i></label>
          <label class="toggle"><div><strong>Sync on Wi-Fi only</strong><small>Avoid sending photo evidence over a metered mobile connection.</small></div><input type="checkbox" name="wifiOnly" [(ngModel)]="prefs.wifiOnly"><i></i></label>
          <div class="connection"><i [class.online]="connectivity.online()"></i><div><strong>{{connectivity.online() ? 'Connection available' : 'Offline test mode enabled'}}</strong><small>{{connectivity.online() ? 'The network is available; server acknowledgement is shown separately.' : 'Pending changes stay on this device until connectivity returns.'}}</small></div><button type="button" (click)="connectivity.setSimulatedOffline(connectivity.online())">{{connectivity.online() ? 'Test offline mode' : 'Return online'}}</button></div>
        </section>
        <section>
          <header><span>▣</span><div><h2>Evidence and display</h2><p>Choose what is stored with field records.</p></div></header>
          <label class="toggle"><div><strong>Store photo metadata</strong><small>Keep capture time and the original filename. Device location is not collected.</small></div><input type="checkbox" name="photoMetadata" [(ngModel)]="prefs.photoMetadata"><i></i></label>
          <label class="toggle"><div><strong>Compact inspection register</strong><small>Reduce row height to show more records on screen.</small></div><input type="checkbox" name="compactRegister" [(ngModel)]="prefs.compactRegister"><i></i></label>
        </section>
        <footer><button type="button" (click)="reset()">Restore defaults</button><button class="primary">Save settings</button></footer>
      </form>
    </main>
  `,
  styleUrl: './settings-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsPageComponent {
  readonly connectivity = inject(ConnectivityService);
  private readonly toast = inject(ToastService);
  private readonly preferences = inject(PreferencesStore);
  prefs: FieldPreferences = this.preferences.snapshot();

  save(): void {
    if (this.preferences.save(this.prefs)) {
      this.prefs = this.preferences.snapshot();
      this.toast.show('Settings saved. New inspections will use these preferences.', 'success');
      return;
    }
    this.toast.show(this.preferences.storageError() ?? 'Settings could not be saved.', 'warning');
  }

  reset(): void {
    if (this.preferences.reset()) {
      this.prefs = this.preferences.snapshot();
      this.toast.show('Default settings restored and applied.', 'info');
      return;
    }
    this.toast.show(this.preferences.storageError() ?? 'Default settings could not be restored.', 'warning');
  }
}
