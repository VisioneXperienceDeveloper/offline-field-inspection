import {InspectionTemplate} from '../models/inspection.models';
import {TemplateStore, VersionedInspectionTemplate} from './template.store';

describe('TemplateStore', () => {
  beforeEach(() => localStorage.clear());

  it('migrates seed templates to published version one and returns an immutable snapshot', () => {
    const store = new TemplateStore();
    const template = store.templates()[0];

    expect(template).toMatchObject({version: 1, active: true, hasUnpublishedChanges: false});
    const snapshot = store.snapshot(template.id)!;
    expect(snapshot).toMatchObject({id: template.id, templateVersion: 1, templatePublishedAt: null});
    snapshot.checklist[0].title = 'Changed outside the store';
    expect(store.templates()[0].checklist[0].title).not.toBe('Changed outside the store');
  });

  it('creates an unusable draft and publishes its normalized checklist as version one', () => {
    const store = new TemplateStore();
    const draft = store.create('Daily walk', 'Safety', 'Daily checks');

    expect(draft).toMatchObject({version: 0, active: false, hasUnpublishedChanges: true});
    expect(store.snapshot(draft.id)).toBeUndefined();
    store.toggle(draft.id);
    expect(store.templates().find(item => item.id === draft.id)?.active).toBe(false);

    expect(store.updateChecklist(draft.id, [
      {id: 8, title: '  Check access  ', required: true},
      {id: 9, title: 'Check lighting', required: false},
    ])?.checklist).toEqual([
      {id: 1, title: 'Check access', required: true},
      {id: 2, title: 'Check lighting', required: false},
    ]);
    const published = store.publish(draft.id)!;
    expect(published).toMatchObject({version: 1, active: true, hasUnpublishedChanges: false});
    expect(store.snapshot(draft.id)?.checklist).toEqual(published.checklist);
  });

  it('keeps the published checklist live while a next-version draft is edited', () => {
    const store = new TemplateStore();
    const original = store.templates()[0];
    const originalChecklist = structuredClone(original.checklist);

    store.updateChecklist(original.id, [{id: 22, title: 'Next version requirement', required: true}]);

    const editing = store.templates()[0];
    expect(editing.checklist).toEqual(originalChecklist);
    expect(store.editableChecklist(original.id)).toEqual([{id: 1, title: 'Next version requirement', required: true}]);
    expect(store.snapshot(original.id)?.checklist).toEqual(originalChecklist);
    expect(store.publish(original.id)).toMatchObject({version: 2, checklist: [{id: 1, title: 'Next version requirement', required: true}]});
  });

  it('rejects empty edits and missing template ids, and toggles only published templates', () => {
    const store = new TemplateStore();
    const template = store.templates()[0];

    expect(store.updateChecklist(template.id, [{id: 1, title: ' ', required: true}])).toBeUndefined();
    expect(store.updateChecklist('missing', [{id: 1, title: 'Valid', required: true}])).toBeUndefined();
    expect(store.publish('missing')).toBeUndefined();
    expect(store.editableChecklist('missing')).toEqual([]);
    store.toggle(template.id);
    expect(store.templates()[0].active).toBe(false);
    expect(store.snapshot(template.id)).toBeUndefined();
  });

  it('loads legacy persisted templates and falls back from corrupt storage', () => {
    const legacy: InspectionTemplate = {
      id: 'tpl-legacy', name: 'Legacy', category: 'Quality', description: 'Stored before versioning',
      checklist: [{id: 9, title: ' Legacy item ', required: true}], requiresPhotos: false, approvalSteps: 1, active: true,
    };
    localStorage.setItem('fieldnote-templates', JSON.stringify([legacy, {id: 'bad'}]));

    expect(new TemplateStore().templates()).toEqual([expect.objectContaining({id: 'tpl-legacy', version: 1, checklist: [{id: 1, title: 'Legacy item', required: true}]})]);

    localStorage.setItem('fieldnote-templates', '{bad json');
    expect(new TemplateStore().templates().length).toBeGreaterThan(1);
    localStorage.setItem('fieldnote-templates', JSON.stringify({not: 'an array'}));
    expect(new TemplateStore().templates().length).toBeGreaterThan(1);
    localStorage.setItem('fieldnote-templates', JSON.stringify([{id: 'bad'}]));
    expect(new TemplateStore().templates().length).toBeGreaterThan(1);
  });

  it('normalizes persisted draft-only version data', () => {
    const draft = {
      id: 'tpl-draft', name: 'Draft', category: 'Environment', description: 'Draft data',
      checklist: [{id: 3, title: 'Draft item', required: true}], requiresPhotos: true, approvalSteps: 1, active: true,
      version: 0.8, publishedAt: 12, hasUnpublishedChanges: true,
      draftChecklist: [{id: 4, title: ' Edited item ', required: false}],
    } as unknown as VersionedInspectionTemplate;
    localStorage.setItem('fieldnote-templates', JSON.stringify([draft]));

    expect(new TemplateStore().templates()[0]).toMatchObject({
      version: 0, active: false, publishedAt: null,
      draftChecklist: [{id: 1, title: 'Edited item', required: false}],
    });
  });
});
