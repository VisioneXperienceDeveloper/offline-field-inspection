import {Injectable, computed, signal} from '@angular/core';

export interface FieldPreferences {
  defaultInspector: string;
  autoSync: boolean;
  wifiOnly: boolean;
  photoMetadata: boolean;
  compactRegister: boolean;
}

export const DEFAULT_FIELD_PREFERENCES: Readonly<FieldPreferences> = {
  defaultInspector: 'Henry Kim',
  autoSync: true,
  wifiOnly: false,
  photoMetadata: true,
  compactRegister: false,
};

@Injectable({providedIn: 'root'})
export class PreferencesStore {
  private readonly storageKey = 'fieldnote-preferences';
  private readonly preferencesState = signal<FieldPreferences>(this.load());
  private readonly storageErrorState = signal<string | null>(null);

  readonly preferences = this.preferencesState.asReadonly();
  readonly storageError = this.storageErrorState.asReadonly();
  readonly defaultInspector = computed(() => this.preferencesState().defaultInspector);
  readonly autoSync = computed(() => this.preferencesState().autoSync);
  readonly wifiOnly = computed(() => this.preferencesState().wifiOnly);
  readonly photoMetadata = computed(() => this.preferencesState().photoMetadata);
  readonly compactRegister = computed(() => this.preferencesState().compactRegister);

  snapshot(): FieldPreferences {
    return {...this.preferencesState()};
  }

  defaultValues(): FieldPreferences {
    return {...DEFAULT_FIELD_PREFERENCES};
  }

  save(preferences: FieldPreferences): boolean {
    const normalized = this.normalize(preferences);
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(normalized));
      this.preferencesState.set(normalized);
      this.storageErrorState.set(null);
      return true;
    } catch (error) {
      this.storageErrorState.set(this.errorMessage(error));
      return false;
    }
  }

  reset(): boolean {
    return this.save(this.defaultValues());
  }

  private load(): FieldPreferences {
    try {
      const stored = localStorage.getItem(this.storageKey);
      return stored ? this.normalize(JSON.parse(stored) as unknown) : this.defaultValues();
    } catch {
      return this.defaultValues();
    }
  }

  private normalize(value: unknown): FieldPreferences {
    const candidate = typeof value === 'object' && value !== null ? value as Partial<FieldPreferences> : {};
    const defaults = DEFAULT_FIELD_PREFERENCES;
    const inspector = typeof candidate.defaultInspector === 'string' ? candidate.defaultInspector.trim() : '';
    return {
      defaultInspector: inspector || defaults.defaultInspector,
      autoSync: typeof candidate.autoSync === 'boolean' ? candidate.autoSync : defaults.autoSync,
      wifiOnly: typeof candidate.wifiOnly === 'boolean' ? candidate.wifiOnly : defaults.wifiOnly,
      photoMetadata: typeof candidate.photoMetadata === 'boolean' ? candidate.photoMetadata : defaults.photoMetadata,
      compactRegister: typeof candidate.compactRegister === 'boolean' ? candidate.compactRegister : defaults.compactRegister,
    };
  }

  private errorMessage(error: unknown): string {
    const message = typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string' ? error.message : '';
    const detail = message ? ` ${message}` : '';
    return `Preferences could not be saved on this device.${detail}`;
  }
}
