import {TestBed} from '@angular/core/testing';
import {
  MAX_EVIDENCE_PHOTO_BYTES,
  PhotoEvidenceComponent,
  validateEvidenceFile,
} from './photo-evidence.component';

describe('PhotoEvidenceComponent', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    TestBed.resetTestingModule();
  });

  it('rejects unsupported and oversized files before reading them', () => {
    expect(validateEvidenceFile(new File(['text'], 'evidence.txt', {type: 'text/plain'}))).toEqual({
      code: 'unsupported-type', message: 'Choose a JPEG, PNG or WebP image.',
    });
    const large = new File(['x'], 'large.jpg', {type: 'image/jpeg'});
    Object.defineProperty(large, 'size', {value: MAX_EVIDENCE_PHOTO_BYTES + 1});
    expect(validateEvidenceFile(large)).toEqual({code: 'too-large', message: 'Choose an image no larger than 10 MB.'});
    expect(validateEvidenceFile(new File(['x'], 'valid.webp', {type: 'image/webp'}))).toBeNull();
  });

  it('emits validation failures and exposes them as an alert', async () => {
    await TestBed.configureTestingModule({imports: [PhotoEvidenceComponent]}).compileComponents();
    const fixture = TestBed.createComponent(PhotoEvidenceComponent);
    fixture.componentRef.setInput('photos', []);
    const failed = vi.fn();
    fixture.componentInstance.photoProcessingFailed.subscribe(failed);
    fixture.detectChanges();
    const input = fileInput(new File(['text'], 'evidence.txt', {type: 'text/plain'}));

    await fixture.componentInstance.selectPhoto({target: input} as unknown as Event);
    fixture.detectChanges();

    expect(failed).toHaveBeenCalledWith(expect.objectContaining({code: 'unsupported-type'}));
    expect(fixture.nativeElement.querySelector('[role="alert"]')?.textContent).toContain('JPEG, PNG or WebP');
    expect(input.value).toBe('');
  });

  it('emits compressed photo content without metadata when disabled', async () => {
    await TestBed.configureTestingModule({imports: [PhotoEvidenceComponent]}).compileComponents();
    const fixture = TestBed.createComponent(PhotoEvidenceComponent);
    fixture.componentRef.setInput('photos', []);
    fixture.componentRef.setInput('metadataEnabled', false);
    const component = fixture.componentInstance;
    vi.spyOn(component as unknown as {readAsDataUrl(blob: Blob): Promise<string>}, 'readAsDataUrl').mockResolvedValue('data:image/jpeg;base64,raw');
    vi.spyOn(component as unknown as {compress(source: string, type: string): Promise<string>}, 'compress').mockResolvedValue('data:image/jpeg;base64,compressed');
    const added = vi.fn();
    component.photoAdded.subscribe(added);

    await component.selectPhoto({target: fileInput(new File(['image'], 'evidence.jpg', {type: 'image/jpeg'}))} as unknown as Event);

    expect(added).toHaveBeenCalledWith({source: 'data:image/jpeg;base64,compressed', name: 'evidence.jpg', metadata: null});
    expect(component.processing()).toBe(false);
  });

  it('forwards canvas compression failure as a typed event', async () => {
    await TestBed.configureTestingModule({imports: [PhotoEvidenceComponent]}).compileComponents();
    const fixture = TestBed.createComponent(PhotoEvidenceComponent);
    fixture.componentRef.setInput('photos', []);
    const component = fixture.componentInstance;
    vi.spyOn(component as unknown as {readAsDataUrl(blob: Blob): Promise<string>}, 'readAsDataUrl').mockResolvedValue('data:image/jpeg;base64,raw');
    vi.spyOn(component as unknown as {compress(source: string, type: string): Promise<string>}, 'compress').mockRejectedValue(new Error('canvas failed'));
    const failed = vi.fn();
    component.photoProcessingFailed.subscribe(failed);

    await component.selectPhoto({target: fileInput(new File(['image'], 'evidence.jpg', {type: 'image/jpeg'}))} as unknown as Event);

    expect(failed).toHaveBeenCalledWith(expect.objectContaining({code: 'compression-failed'}));
    expect(component.errorMessage()).toContain('could not be compressed');
  });

  it('reads local blobs and reports FileReader errors', async () => {
    await TestBed.configureTestingModule({imports: [PhotoEvidenceComponent]}).compileComponents();
    const fixture = TestBed.createComponent(PhotoEvidenceComponent);
    fixture.componentRef.setInput('photos', []);
    const component = fixture.componentInstance as unknown as {readAsDataUrl(blob: Blob): Promise<string>};

    await expect(component.readAsDataUrl(new Blob(['evidence'], {type: 'image/jpeg'}))).resolves.toMatch(/^data:image\/jpeg;base64,/);

    class FailedFileReader {
      result: string | ArrayBuffer | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      readAsDataURL(): void { queueMicrotask(() => this.onerror?.()); }
    }
    vi.stubGlobal('FileReader', FailedFileReader);
    await expect(component.readAsDataUrl(new Blob(['bad']))).rejects.toThrow('could not be read');
  });

  it('resizes wide images and returns a compressed data URL', async () => {
    await TestBed.configureTestingModule({imports: [PhotoEvidenceComponent]}).compileComponents();
    const fixture = TestBed.createComponent(PhotoEvidenceComponent);
    fixture.componentRef.setInput('photos', []);
    const component = fixture.componentInstance as unknown as {compress(source: string, type: string): Promise<string>};
    const drawImage = vi.fn();
    const toBlob = vi.fn((callback: BlobCallback, type?: string) => callback(new Blob(['compressed'], {type})));
    const canvas = document.createElement('canvas');
    Object.defineProperty(canvas, 'getContext', {value: () => ({drawImage})});
    Object.defineProperty(canvas, 'toBlob', {value: toBlob});
    vi.spyOn(document, 'createElement').mockReturnValue(canvas);
    class LoadedImage {
      naturalWidth = 3840;
      naturalHeight = 1920;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_source: string) { queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal('Image', LoadedImage);

    await expect(component.compress('data:image/jpeg;base64,AA==', 'image/jpeg')).resolves.toMatch(/^data:image\/jpeg;base64,/);
    expect(canvas.width).toBe(1920);
    expect(canvas.height).toBe(960);
    expect(drawImage).toHaveBeenCalledOnce();
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.82);
  });

  it('reports decode and unavailable-canvas compression failures', async () => {
    await TestBed.configureTestingModule({imports: [PhotoEvidenceComponent]}).compileComponents();
    const fixture = TestBed.createComponent(PhotoEvidenceComponent);
    fixture.componentRef.setInput('photos', []);
    const component = fixture.componentInstance as unknown as {compress(source: string, type: string): Promise<string>};
    class FailedImage {
      naturalWidth = 100;
      naturalHeight = 100;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_source: string) { queueMicrotask(() => this.onerror?.()); }
    }
    vi.stubGlobal('Image', FailedImage);
    await expect(component.compress('data:image/jpeg;base64,AA==', 'image/jpeg')).rejects.toThrow('could not be decoded');

    class LoadedImage extends FailedImage {
      override set src(_source: string) { queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal('Image', LoadedImage);
    const canvas = document.createElement('canvas');
    Object.defineProperty(canvas, 'getContext', {value: () => null});
    vi.spyOn(document, 'createElement').mockReturnValue(canvas);
    await expect(component.compress('data:image/png;base64,AA==', 'image/png')).rejects.toThrow('could not be compressed in this browser');
  });

  it('states that location is not collected and conditionally renders capture time', async () => {
    await TestBed.configureTestingModule({imports: [PhotoEvidenceComponent]}).compileComponents();
    const fixture = TestBed.createComponent(PhotoEvidenceComponent);
    fixture.componentRef.setInput('photos', [{id: 'p1', name: 'Evidence', source: 'data:image/png;base64,AA==', storageKey: 'p1', mimeType: 'image/png', byteSize: 1, checksum: null, capturedAt: '10:42', location: 'Location not collected'}]);
    fixture.componentRef.setInput('metadataEnabled', false);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Device location is not collected or requested');
    expect(fixture.nativeElement.querySelector('figcaption span')?.textContent).toBe('Location not collected by Fieldnote');
    expect(fixture.nativeElement.querySelector('input[type="file"]')?.accept).toBe('image/jpeg,image/png,image/webp');
  });

  it('renders an honest placeholder when remote photo bytes are not on this device', async () => {
    await TestBed.configureTestingModule({imports: [PhotoEvidenceComponent]}).compileComponents();
    const fixture = TestBed.createComponent(PhotoEvidenceComponent);
    fixture.componentRef.setInput('photos', [{
      id: 'remote-photo',
      name: 'Remote evidence',
      source: '',
      storageKey: null,
      mimeType: 'image/jpeg',
      byteSize: 0,
      checksum: 'abc123',
      capturedAt: '2026-09-02T01:00:00.000Z',
      location: 'West access',
    }]);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('img')).toBeNull();
    expect(fixture.nativeElement.querySelector('[role="img"]')?.getAttribute('aria-label'))
      .toBe('Remote evidence preview unavailable on this device');
    expect(fixture.nativeElement.textContent).toContain('Preview unavailable on this device');
  });
});

function fileInput(file: File): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'file';
  Object.defineProperty(input, 'files', {value: [file], configurable: true});
  return input;
}
