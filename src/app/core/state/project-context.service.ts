import {Injectable, computed, signal} from '@angular/core';
import {PROJECTS} from '../data/inspection.seed';

@Injectable({providedIn: 'root'})
export class ProjectContextService {
  readonly projects = PROJECTS;
  private readonly selectedId = signal(localStorage.getItem('fieldnote-project') ?? PROJECTS[0].id);
  readonly activeProject = computed(() => PROJECTS.find(project => project.id === this.selectedId()) ?? PROJECTS[0]);

  select(projectId: string): void {
    this.selectedId.set(projectId);
    localStorage.setItem('fieldnote-project', projectId);
  }
}
