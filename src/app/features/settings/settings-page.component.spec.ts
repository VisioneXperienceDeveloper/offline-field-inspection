import {signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {ConnectivityService} from '../../core/services/connectivity.service';
import {ToastService} from '../../core/services/toast.service';
import {PreferencesStore} from '../../core/state/preferences.store';
import {SettingsPageComponent} from './settings-page.component';

describe('SettingsPageComponent', () => {
  let toast: {show: ReturnType<typeof vi.fn>};

  beforeEach(() => {
    localStorage.clear();
    toast = {show: vi.fn()};
    TestBed.configureTestingModule({
      imports: [SettingsPageComponent],
      providers: [
        PreferencesStore,
        {provide: ConnectivityService, useValue: {online: signal(true), setSimulatedOffline: vi.fn()}},
        {provide: ToastService, useValue: toast},
      ],
    });
  });

  afterEach(() => TestBed.resetTestingModule());

  it('saves settings through the shared preference contract', () => {
    const fixture = TestBed.createComponent(SettingsPageComponent);
    const component = fixture.componentInstance;
    const store = TestBed.inject(PreferencesStore);
    component.prefs = {defaultInspector: ' Olivia Lee ', autoSync: false, wifiOnly: true, photoMetadata: false, compactRegister: true};

    component.save();

    expect(store.preferences()).toEqual({defaultInspector: 'Olivia Lee', autoSync: false, wifiOnly: true, photoMetadata: false, compactRegister: true});
    expect(component.prefs.defaultInspector).toBe('Olivia Lee');
    expect(toast.show).toHaveBeenCalledWith('Settings saved. New inspections will use these preferences.', 'success');
  });

  it('restores and immediately applies defaults', () => {
    const fixture = TestBed.createComponent(SettingsPageComponent);
    const component = fixture.componentInstance;
    component.prefs.defaultInspector = 'Changed';

    component.reset();

    expect(component.prefs.defaultInspector).toBe('Henry Kim');
    expect(toast.show).toHaveBeenCalledWith('Default settings restored and applied.', 'info');
  });

  it('reports storage failures instead of claiming success', () => {
    const fixture = TestBed.createComponent(SettingsPageComponent);
    const component = fixture.componentInstance;
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exhausted', 'QuotaExceededError');
    });

    component.save();
    component.reset();

    expect(toast.show).toHaveBeenCalledWith(expect.stringContaining('Quota exhausted'), 'warning');
    expect(toast.show).toHaveBeenCalledTimes(2);
    setItem.mockRestore();
  });
});
