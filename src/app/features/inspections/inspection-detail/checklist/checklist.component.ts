import {ChangeDetectionStrategy, Component, input, output} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {ChecklistItem, InspectionAnswer} from '../../../../core/models/inspection.models';

@Component({
  selector: 'app-inspection-checklist',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './checklist.component.html',
  styleUrl: './checklist.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChecklistComponent {
  readonly items = input.required<ChecklistItem[]>();
  readonly disabled = input(false);
  readonly answerChanged = output<{itemId: number; answer: InspectionAnswer}>();
  readonly noteChanged = output<{itemId: number; note: string}>();

  answerLabel(answer: Exclude<InspectionAnswer, null>): string { return ({pass: 'Pass', fail: 'Fail', na: 'Not applicable'})[answer]; }
}
