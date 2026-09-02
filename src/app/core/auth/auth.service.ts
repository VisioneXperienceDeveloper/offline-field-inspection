import {Injectable, computed, signal} from '@angular/core';
import {DemoIdentity, FieldnoteIdentity, ProjectPermission} from './auth.models';

const MEMBER = Object.freeze({read: true, write: true, export: true, approve: false});
const REVIEWER = Object.freeze({read: true, write: false, export: true, approve: true});
const ADMIN = Object.freeze({read: true, write: true, export: true, approve: true});
const SESSION_KEY = 'fieldnote-demo-identity';

export const DEMO_IDENTITIES: readonly DemoIdentity[] = Object.freeze([
  Object.freeze({
    id: 'demo-inspector',
    name: 'Henry Kim',
    role: 'Inspector',
    token: 'demo-inspector-token',
    memberships: Object.freeze({'project-c3': MEMBER}),
  }),
  Object.freeze({
    id: 'demo-reviewer',
    name: 'Rina Park',
    role: 'Reviewer',
    token: 'demo-reviewer-token',
    memberships: Object.freeze({'project-c3': REVIEWER}),
  }),
  Object.freeze({
    id: 'demo-admin',
    name: 'Alex Morgan',
    role: 'Admin',
    token: 'demo-admin-token',
    memberships: Object.freeze({
      'project-c3': ADMIN,
      'project-p2': ADMIN,
      'project-north': ADMIN,
    }),
  }),
]);

@Injectable({providedIn: 'root'})
export class AuthService {
  private readonly activeIdentityId = signal(this.restoreIdentityId());
  private readonly activeDemoIdentity = computed(() =>
    DEMO_IDENTITIES.find(identity => identity.id === this.activeIdentityId()) ?? DEMO_IDENTITIES[0],
  );

  readonly demoIdentities = DEMO_IDENTITIES.map(({token: _token, ...identity}) => identity);
  readonly identity = computed<FieldnoteIdentity>(() => {
    const {token: _token, ...identity} = this.activeDemoIdentity();
    return identity;
  });

  can(permission: ProjectPermission, projectId: string): boolean {
    return this.identity().memberships[projectId]?.[permission] === true;
  }

  bearerToken(): string {
    return this.activeDemoIdentity().token;
  }

  bearerTokenFor(identityId: string): string | undefined {
    return DEMO_IDENTITIES.find(identity => identity.id === identityId)?.token;
  }

  selectDemoIdentity(identityId: string): boolean {
    if (!DEMO_IDENTITIES.some(identity => identity.id === identityId)) return false;
    this.activeIdentityId.set(identityId);
    try {
      sessionStorage.setItem(SESSION_KEY, identityId);
    } catch {
      // A private or locked-down browser may deny session storage. The in-memory session remains usable.
    }
    return true;
  }

  initials(): string {
    return this.identity().name.split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase();
  }

  private restoreIdentityId(): string {
    try {
      const stored = sessionStorage.getItem(SESSION_KEY);
      return DEMO_IDENTITIES.some(identity => identity.id === stored) ? stored! : DEMO_IDENTITIES[0].id;
    } catch {
      return DEMO_IDENTITIES[0].id;
    }
  }
}
