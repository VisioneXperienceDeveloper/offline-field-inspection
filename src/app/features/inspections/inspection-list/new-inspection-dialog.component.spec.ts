import {signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {InspectionTemplateSnapshot, TemplateStore, VersionedInspectionTemplate} from '../../../core/state/template.store';
import {NewInspectionDialogComponent} from './new-inspection-dialog.component';

const template: VersionedInspectionTemplate = {
  id: 'tpl-active', name: 'Active template', category: 'Safety', description: 'Published template',
  checklist: [{id: 1, title: 'Check access', required: true}], requiresPhotos: false, approvalSteps: 1, active: true,
  version: 2, publishedAt: '2026-09-01T00:00:00.000Z', hasUnpublishedChanges: false,
};
const snapshot: InspectionTemplateSnapshot = {
  ...template,
  templateVersion: 2,
  templatePublishedAt: template.publishedAt,
  snapshotAt: '2026-09-02T00:00:00.000Z',
};

describe('NewInspectionDialogComponent', () => {
  let templateStore: {templates: ReturnType<typeof signal<VersionedInspectionTemplate[]>>; snapshot: ReturnType<typeof vi.fn>};

  beforeEach(() => {
    templateStore = {templates: signal([template, {...template, id: 'tpl-inactive', active: false}]), snapshot: vi.fn(() => snapshot)};
    TestBed.configureTestingModule({
      imports: [NewInspectionDialogComponent],
      providers: [{provide: TemplateStore, useValue: templateStore}],
    });
  });

  afterEach(() => TestBed.resetTestingModule());

  it('focuses search first and lists only active published templates', async () => {
    const fixture = TestBed.createComponent(NewInspectionDialogComponent);
    fixture.detectChanges();
    await fixture.whenStable();

    const search = fixture.nativeElement.querySelector('input[type="search"]') as HTMLInputElement;
    expect(document.activeElement).toBe(search);
    expect(fixture.nativeElement.querySelectorAll('.template-options>button')).toHaveLength(1);
    expect(fixture.nativeElement.textContent).toContain('v2');
  });

  it('closes on Escape with a focus-restore-friendly reason', () => {
    const fixture = TestBed.createComponent(NewInspectionDialogComponent);
    const cancelled = vi.fn();
    const dismissed = vi.fn();
    fixture.componentInstance.cancelled.subscribe(cancelled);
    fixture.componentInstance.dismissed.subscribe(dismissed);
    fixture.detectChanges();

    const event = new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true});
    fixture.nativeElement.querySelector('.dialog').dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(dismissed).toHaveBeenCalledWith('escape');
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('traps forward and reverse Tab navigation inside the dialog', () => {
    const fixture = TestBed.createComponent(NewInspectionDialogComponent);
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector('.dialog') as HTMLElement;
    const controls = dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])');
    const first = controls[0];
    const last = controls[controls.length - 1];
    last.focus();

    fixture.componentInstance.handleKeydown(new KeyboardEvent('keydown', {key: 'Tab', cancelable: true}));
    expect(document.activeElement).toBe(first);

    first.focus();
    fixture.componentInstance.handleKeydown(new KeyboardEvent('keydown', {key: 'Tab', shiftKey: true, cancelable: true}));
    expect(document.activeElement).toBe(last);
  });

  it('emits a versioned snapshot when an inspection starts', () => {
    const fixture = TestBed.createComponent(NewInspectionDialogComponent);
    const started = vi.fn();
    fixture.componentInstance.started.subscribe(started);
    fixture.detectChanges();

    fixture.componentInstance.start();

    expect(templateStore.snapshot).toHaveBeenCalledWith('tpl-active');
    expect(started).toHaveBeenCalledWith(snapshot);
  });

  it('does not start a hidden selection after search removes it', () => {
    const fixture = TestBed.createComponent(NewInspectionDialogComponent);
    const started = vi.fn();
    fixture.componentInstance.started.subscribe(started);
    fixture.detectChanges();

    fixture.componentInstance.query.set('no matching template');
    fixture.componentInstance.start();

    expect(fixture.componentInstance.selectedTemplate()).toBeUndefined();
    expect(started).not.toHaveBeenCalled();
  });
});
