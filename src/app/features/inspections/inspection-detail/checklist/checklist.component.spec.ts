import {TestBed} from '@angular/core/testing';
import {ChecklistItem} from '../../../../core/models/inspection.models';
import {ChecklistComponent} from './checklist.component';

describe('ChecklistComponent', () => {
  const items: ChecklistItem[] = [
    {id: 7, title: 'Guardrail is secure', required: true, answer: 'pass', note: ''},
    {id: 8, title: 'Emergency access is clear', required: false, answer: 'fail', note: 'Remove obstruction'},
  ];

  afterEach(() => TestBed.resetTestingModule());

  it('labels each answer group and exposes selected answers with aria-pressed', async () => {
    await TestBed.configureTestingModule({imports: [ChecklistComponent]}).compileComponents();
    const fixture = TestBed.createComponent(ChecklistComponent);
    fixture.componentRef.setInput('items', items);
    fixture.detectChanges();

    const groups = fixture.nativeElement.querySelectorAll('article[role="group"]') as NodeListOf<HTMLElement>;
    const firstButtons = groups[0].querySelectorAll('.answers button');
    expect(groups[0].getAttribute('aria-labelledby')).toBe('checklist-item-7');
    expect(groups[0].querySelector('#checklist-item-7')?.textContent).toContain('Guardrail is secure');
    expect(firstButtons[0].getAttribute('aria-pressed')).toBe('true');
    expect(firstButtons[1].getAttribute('aria-pressed')).toBe('false');
    expect(groups[0].querySelector('.answers')?.getAttribute('aria-label')).toBe('Answer for Guardrail is secure');
    expect(groups[0].querySelector('.visually-hidden')?.textContent).toBe('Required');
  });

  it('emits answer changes and renders labelled corrective action content', async () => {
    await TestBed.configureTestingModule({imports: [ChecklistComponent]}).compileComponents();
    const fixture = TestBed.createComponent(ChecklistComponent);
    fixture.componentRef.setInput('items', items);
    const emitted = vi.fn();
    fixture.componentInstance.answerChanged.subscribe(emitted);
    fixture.detectChanges();

    (fixture.nativeElement.querySelectorAll('article')[0].querySelector('.answer-fail') as HTMLButtonElement).click();

    expect(emitted).toHaveBeenCalledWith({itemId: 7, answer: 'fail'});
    expect(fixture.nativeElement.querySelector('.failure textarea')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.failure')?.textContent).toContain('corrective action note is required');
    expect(fixture.componentInstance.answerLabel('na')).toBe('Not applicable');
  });

  it('disables every answer and note control when the inspection is locked', async () => {
    await TestBed.configureTestingModule({imports: [ChecklistComponent]}).compileComponents();
    const fixture = TestBed.createComponent(ChecklistComponent);
    fixture.componentRef.setInput('items', items);
    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const answerButtons = fixture.nativeElement.querySelectorAll('.answers button') as NodeListOf<HTMLButtonElement>;
    expect(answerButtons).toHaveLength(6);
    expect(fixture.nativeElement.querySelectorAll('.answers button:disabled')).toHaveLength(6);
    expect((fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement).disabled).toBe(true);
  });
});
