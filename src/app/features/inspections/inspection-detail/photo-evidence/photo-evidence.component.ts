import {ChangeDetectionStrategy, Component, input, output} from '@angular/core';
import {InspectionPhoto} from '../../../../core/models/inspection.models';

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
  readonly photoAdded = output<{source: string; name: string}>();
  readonly photoRemoved = output<string>();

  selectPhoto(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { input.value = ''; return; }
    const reader = new FileReader();
    reader.onload = () => this.photoAdded.emit({source: String(reader.result), name: file.name});
    reader.readAsDataURL(file);
    input.value = '';
  }
}
