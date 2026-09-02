import {TestBed} from '@angular/core/testing';
import {AuthService} from './auth.service';

describe('AuthService', () => {
  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({providers: [AuthService]});
  });

  afterEach(() => TestBed.resetTestingModule());

  it('starts with the least-privileged inspector demo session', () => {
    const service = TestBed.inject(AuthService);

    expect(service.identity()).toMatchObject({id: 'demo-inspector', name: 'Henry Kim', role: 'Inspector'});
    expect(service.can('write', 'project-c3')).toBe(true);
    expect(service.can('approve', 'project-c3')).toBe(false);
    expect(service.can('read', 'project-p2')).toBe(false);
    expect(service.bearerToken()).toBe('demo-inspector-token');
    expect(service.bearerTokenFor('demo-reviewer')).toBe('demo-reviewer-token');
    expect(service.bearerTokenFor('unknown')).toBeUndefined();
    expect(service.initials()).toBe('HK');
  });

  it('switches to the reviewer and restores the session without exposing tokens in identities', () => {
    const service = TestBed.inject(AuthService);

    expect(service.selectDemoIdentity('demo-reviewer')).toBe(true);
    expect(service.identity()).toMatchObject({id: 'demo-reviewer', role: 'Reviewer'});
    expect(service.can('approve', 'project-c3')).toBe(true);
    expect(service.can('write', 'project-c3')).toBe(false);
    expect(service.demoIdentities.some(identity => 'token' in identity)).toBe(false);

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({providers: [AuthService]});
    expect(TestBed.inject(AuthService).identity().id).toBe('demo-reviewer');
  });

  it('grants the admin membership across every configured project and rejects unknown identities', () => {
    const service = TestBed.inject(AuthService);

    expect(service.selectDemoIdentity('demo-admin')).toBe(true);
    expect(service.can('approve', 'project-p2')).toBe(true);
    expect(service.can('write', 'project-north')).toBe(true);
    expect(service.selectDemoIdentity('unknown')).toBe(false);
    expect(service.identity().id).toBe('demo-admin');
  });
});
