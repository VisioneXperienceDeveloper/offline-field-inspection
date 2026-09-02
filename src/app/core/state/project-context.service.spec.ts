import {TestBed} from '@angular/core/testing';
import {AuthService} from '../auth/auth.service';
import {ProjectContextService} from './project-context.service';

describe('ProjectContextService', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    TestBed.configureTestingModule({providers: [AuthService, ProjectContextService]});
  });

  afterEach(() => TestBed.resetTestingModule());

  it('only exposes projects allowed by the active identity', () => {
    const service = TestBed.inject(ProjectContextService);

    expect(service.projects.map(project => project.id)).toEqual(['project-c3']);
    expect(service.select('project-p2')).toBe(false);
    expect(service.activeProject().id).toBe('project-c3');
  });

  it('reacts to an identity change and persists an authorized selection', () => {
    const auth = TestBed.inject(AuthService);
    const service = TestBed.inject(ProjectContextService);

    auth.selectDemoIdentity('demo-admin');
    expect(service.projects.map(project => project.id)).toEqual(['project-c3', 'project-p2', 'project-north']);
    expect(service.select('project-p2')).toBe(true);
    expect(service.activeProject().id).toBe('project-p2');
    expect(localStorage.getItem('fieldnote-project')).toBe('project-p2');
  });

  it('falls back to the first permitted project when a session loses membership', () => {
    const auth = TestBed.inject(AuthService);
    const service = TestBed.inject(ProjectContextService);

    auth.selectDemoIdentity('demo-admin');
    service.select('project-north');
    auth.selectDemoIdentity('demo-inspector');

    expect(service.activeProject().id).toBe('project-c3');
  });

  it('never falls back to real project data when the identity has no memberships', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({providers: [
      ProjectContextService,
      {provide: AuthService, useValue: {can: () => false}},
    ]});

    const service = TestBed.inject(ProjectContextService);

    expect(service.projects).toEqual([]);
    expect(service.activeProject()).toEqual({id: '', name: 'No project access'});
    expect(service.select('project-c3')).toBe(false);
  });
});
