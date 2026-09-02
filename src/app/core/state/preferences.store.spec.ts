import {DEFAULT_FIELD_PREFERENCES, PreferencesStore} from './preferences.store';

describe('PreferencesStore', () => {
  beforeEach(() => localStorage.clear());

  it('exposes safe defaults through typed selectors', () => {
    const store = new PreferencesStore();

    expect(store.preferences()).toEqual(DEFAULT_FIELD_PREFERENCES);
    expect(store.defaultInspector()).toBe('Henry Kim');
    expect(store.autoSync()).toBe(true);
    expect(store.wifiOnly()).toBe(false);
    expect(store.photoMetadata()).toBe(true);
    expect(store.compactRegister()).toBe(false);
    expect(store.snapshot()).not.toBe(store.preferences());
  });

  it('normalizes, persists and reloads preferences', () => {
    const store = new PreferencesStore();

    expect(store.save({defaultInspector: '  Olivia Lee  ', autoSync: false, wifiOnly: true, photoMetadata: false, compactRegister: true})).toBe(true);
    expect(store.preferences()).toEqual({defaultInspector: 'Olivia Lee', autoSync: false, wifiOnly: true, photoMetadata: false, compactRegister: true});
    expect(store.storageError()).toBeNull();
    expect(new PreferencesStore().preferences()).toEqual(store.preferences());
  });

  it('repairs malformed stored fields and invalid JSON', () => {
    localStorage.setItem('fieldnote-preferences', JSON.stringify({defaultInspector: ' ', autoSync: 'yes', wifiOnly: true}));
    expect(new PreferencesStore().preferences()).toEqual({...DEFAULT_FIELD_PREFERENCES, wifiOnly: true});

    localStorage.setItem('fieldnote-preferences', '{bad json');
    expect(new PreferencesStore().preferences()).toEqual(DEFAULT_FIELD_PREFERENCES);
  });

  it('restores and persists defaults', () => {
    const store = new PreferencesStore();
    store.save({defaultInspector: 'Jack Park', autoSync: false, wifiOnly: true, photoMetadata: false, compactRegister: true});

    expect(store.reset()).toBe(true);
    expect(store.preferences()).toEqual(DEFAULT_FIELD_PREFERENCES);
    expect(JSON.parse(localStorage.getItem('fieldnote-preferences') ?? '{}')).toEqual(DEFAULT_FIELD_PREFERENCES);
  });

  it('keeps current preferences and reports device storage failures', () => {
    const store = new PreferencesStore();
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exhausted', 'QuotaExceededError');
    });

    expect(store.save({defaultInspector: 'Jack Park', autoSync: false, wifiOnly: true, photoMetadata: false, compactRegister: true})).toBe(false);
    expect(store.preferences()).toEqual(DEFAULT_FIELD_PREFERENCES);
    expect(store.storageError()).toContain('Quota exhausted');
    expect(store.reset()).toBe(false);

    setItem.mockRestore();
  });
});
