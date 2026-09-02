import {signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {Router} from '@angular/router';
import {ToastService} from '../../core/services/toast.service';
import {InspectionStore} from '../../core/state/inspection.store';
import {TemplateStore} from '../../core/state/template.store';
import {TemplatesPageComponent} from './templates-page.component';

describe('TemplatesPageComponent', () => {
  let inspectionStore: {createFromTemplate: ReturnType<typeof vi.fn>};
  let router: {navigate: ReturnType<typeof vi.fn>};
  let toast: {show: ReturnType<typeof vi.fn>};

  beforeEach(() => {
    localStorage.clear();
    inspectionStore = {createFromTemplate: vi.fn(() => ({id: 'INSP-NEW'}))};
    router = {navigate: vi.fn(() => Promise.resolve(true))};
    toast = {show: vi.fn()};
    TestBed.configureTestingModule({
      imports: [TemplatesPageComponent],
      providers: [
        TemplateStore,
        {provide: InspectionStore, useValue: inspectionStore},
        {provide: Router, useValue: router},
        {provide: ToastService, useValue: toast},
      ],
    });
  });

  afterEach(() => TestBed.resetTestingModule());

  it('filters templates by query and category', () => {
    const fixture = TestBed.createComponent(TemplatesPageComponent);
    const component = fixture.componentInstance;

    component.query.set('concrete');
    expect(component.filtered().map(item => item.id)).toEqual(['tpl-concrete-prepour']);
    component.query.set('');
    component.category.set('Equipment');
    expect(component.filtered().map(item => item.category)).toEqual(['Equipment']);
  });

  it('creates a draft and opens its checklist editor', () => {
    const fixture = TestBed.createComponent(TemplatesPageComponent);
    const component = fixture.componentInstance;
    const originalCount = component.templates.templates().length;
    component.create();
    expect(component.templates.templates()).toHaveLength(originalCount);

    component.draftName = '  Daily access walk  ';
    component.draftDescription = '';
    component.create();

    expect(component.templates.templates()).toHaveLength(originalCount + 1);
    expect(component.editing()).toMatchObject({name: 'Daily access walk', version: 0, active: false});
    expect(component.checklistDraft).toHaveLength(1);
    expect(component.dialogOpen()).toBe(false);
  });

  it('adds, removes, validates, saves and publishes checklist versions', () => {
    const fixture = TestBed.createComponent(TemplatesPageComponent);
    const component = fixture.componentInstance;
    const template = component.templates.templates()[0];
    component.beginEdit(template);
    component.addChecklistItem();
    expect(component.validChecklist()).toBe(false);
    component.checklistDraft[component.checklistDraft.length - 1].title = 'Check temporary lighting';
    expect(component.validChecklist()).toBe(true);
    const length = component.checklistDraft.length;
    component.removeChecklistItem(length - 1);
    expect(component.checklistDraft).toHaveLength(length - 1);

    component.addChecklistItem();
    component.checklistDraft[component.checklistDraft.length - 1].title = 'Check temporary lighting';
    component.publishEditing(template);

    expect(component.templates.templates()[0]).toMatchObject({version: 2, hasUnpublishedChanges: false});
    expect(component.templates.templates()[0].checklist.at(-1)?.title).toBe('Check temporary lighting');
    expect(component.editing()).toBeNull();
  });

  it('keeps valid edits as a draft without publishing', () => {
    const fixture = TestBed.createComponent(TemplatesPageComponent);
    const component = fixture.componentInstance;
    const template = component.templates.templates()[0];
    component.beginEdit(template);
    component.checklistDraft[0].title = 'Updated draft item';

    component.saveChecklistDraft(template);

    expect(component.templates.templates()[0]).toMatchObject({version: 1, hasUnpublishedChanges: true});
    expect(component.templates.editableChecklist(template.id)[0].title).toBe('Updated draft item');
    expect(component.editing()).toBeNull();
  });

  it('uses only a published active snapshot and toggles published templates', () => {
    const fixture = TestBed.createComponent(TemplatesPageComponent);
    const component = fixture.componentInstance;
    const published = component.templates.templates()[0];

    component.use(published);

    expect(inspectionStore.createFromTemplate).toHaveBeenCalledWith(expect.objectContaining({templateVersion: 1}));
    expect(router.navigate).toHaveBeenCalledWith(['/inspections', 'INSP-NEW']);

    component.toggle(published);
    const inactive = component.templates.templates()[0];
    expect(inactive.active).toBe(false);
    component.use(inactive);
    expect(inspectionStore.createFromTemplate).toHaveBeenCalledOnce();
    expect(toast.show).toHaveBeenCalledWith('Publish and activate this template before using it.', 'warning');
  });

  it('does not remove the final editor item or save an invalid checklist', () => {
    const fixture = TestBed.createComponent(TemplatesPageComponent);
    const component = fixture.componentInstance;
    const template = component.templates.create('Draft', 'Safety', 'Draft');
    component.beginEdit(template);
    component.checklistDraft[0].title = '';
    component.removeChecklistItem(0);
    expect(component.checklistDraft).toHaveLength(1);

    component.saveChecklistDraft(template);
    expect(component.editing()).not.toBeNull();
    expect(toast.show).toHaveBeenCalledWith('Each checklist item needs a requirement.', 'warning');
    component.closeEditor();
    expect(component.checklistDraft).toEqual([]);
  });
});
