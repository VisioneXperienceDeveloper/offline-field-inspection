import {ChangeDetectionStrategy, Component, input, output, signal} from '@angular/core';
import {InspectionPhoto} from '../../../../core/models/inspection.models';

export const MAX_EVIDENCE_PHOTO_BYTES = 10 * 1024 * 1024;
export const SUPPORTED_EVIDENCE_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export type PhotoProcessingFailureCode = 'unsupported-type' | 'too-large' | 'read-failed' | 'compression-failed';
export interface PhotoProcessingFailure { code: PhotoProcessingFailureCode; message: string; }
export interface PhotoAddedEvent {
  source: string;
  name: string;
  metadata: {capturedAt: string; location: 'Location not collected'} | null;
}

class PhotoProcessingError extends Error {
  constructor(readonly code: Extract<PhotoProcessingFailureCode, 'read-failed' | 'compression-failed'>, message: string) {
    super(message);
  }
}

export function validateEvidenceFile(file: File): PhotoProcessingFailure | null {
  if (!(SUPPORTED_EVIDENCE_IMAGE_TYPES as readonly string[]).includes(file.type)) {
    return {code: 'unsupported-type', message: 'Choose a JPEG, PNG or WebP image.'};
  }
  if (file.size > MAX_EVIDENCE_PHOTO_BYTES) {
    return {code: 'too-large', message: 'Choose an image no larger than 10 MB.'};
  }
  return null;
}

@Component({
  selector: 'app-photo-evidence',
  standalone: true,
  templateUrl: './photo-evidence.component.html',
  styleUrl: './photo-evidence.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PhotoEvidenceComponent {
  readonly photos = input.required<InspectionPhoto[]>();
  readonly disabled = input(false);
  readonly metadataEnabled = input(true);
  readonly photoAdded = output<PhotoAddedEvent>();
  readonly photoRemoved = output<string>();
  readonly photoProcessingFailed = output<PhotoProcessingFailure>();
  readonly processing = signal(false);
  readonly errorMessage = signal<string | null>(null);

  async selectPhoto(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const validationFailure = validateEvidenceFile(file);
    if (validationFailure) {
      this.fail(validationFailure);
      return;
    }

    this.processing.set(true);
    this.errorMessage.set(null);
    try {
      const source = await this.readAsDataUrl(file);
      const compressed = await this.compress(source, file.type);
      this.photoAdded.emit({
        source: compressed,
        name: file.name,
        metadata: this.metadataEnabled() ? {capturedAt: new Date().toISOString(), location: 'Location not collected'} : null,
      });
    } catch (error) {
      const failure = error instanceof PhotoProcessingError
        ? {code: error.code, message: error.message}
        : {code: 'compression-failed' as const, message: 'The image could not be compressed. Choose a different image and retry.'};
      this.fail(failure);
    } finally {
      this.processing.set(false);
    }
  }

  private readAsDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new PhotoProcessingError('read-failed', 'The image could not be read from this device.'));
      reader.onabort = () => reject(new PhotoProcessingError('read-failed', 'Reading the image was cancelled.'));
      reader.readAsDataURL(blob);
    });
  }

  private compress(source: string, originalType: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onerror = () => reject(new PhotoProcessingError('compression-failed', 'The selected image format could not be decoded.'));
      image.onload = () => {
        try {
          const maximumDimension = 1920;
          const scale = Math.min(1, maximumDimension / Math.max(image.naturalWidth, image.naturalHeight));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
          const context = canvas.getContext('2d');
          if (!context) throw new Error('Canvas rendering is unavailable.');
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          const outputType = originalType === 'image/png' ? 'image/png' : 'image/jpeg';
          canvas.toBlob(blob => {
            if (!blob) {
              reject(new PhotoProcessingError('compression-failed', 'The image could not be compressed.'));
              return;
            }
            this.readAsDataUrl(blob).then(resolve).catch(reject);
          }, outputType, 0.82);
        } catch {
          reject(new PhotoProcessingError('compression-failed', 'The image could not be compressed in this browser.'));
        }
      };
      image.src = source;
    });
  }

  private fail(failure: PhotoProcessingFailure): void {
    this.errorMessage.set(failure.message);
    this.photoProcessingFailed.emit(failure);
  }
}
