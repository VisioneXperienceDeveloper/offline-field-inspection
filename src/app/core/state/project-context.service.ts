import {Injectable, computed, inject, signal} from '@angular/core';
import {AuthService} from '../auth/auth.service';
import {PROJECTS} from '../data/inspection.seed';
import {Project} from '../models/inspection.models';

const NO_AUTHORIZED_PROJECT: Readonly<Project> = {id: '', name: 'No project access'};

@Injectable({providedIn: 'root'})
export class ProjectContextService {
  private readonly auth = inject(AuthService);
  private readonly selectedId = signal(this.restoreProjectId());
  private readonly authorizedProjects = computed(() => PROJECTS.filter(project => this.auth.can('read', project.id)));
  readonly activeProject = computed(() => {
    const projects = this.authorizedProjects();
    return projects.find(project => project.id === this.selectedId()) ?? projects[0] ?? NO_AUTHORIZED_PROJECT;
  });

  get projects(): readonly Project[] {
    return this.authorizedProjects();
  }

  select(projectId: string): boolean {
    if (!this.authorizedProjects().some(project => project.id === projectId)) return false;
    this.selectedId.set(projectId);
    try {
      localStorage.setItem('fieldnote-project', projectId);
    } catch {
      // Keep the current in-memory project if browser storage is unavailable.
    }
    return true;
  }

  private restoreProjectId(): string {
    try {
      return localStorage.getItem('fieldnote-project') ?? PROJECTS[0].id;
    } catch {
      return PROJECTS[0].id;
    }
  }
}
