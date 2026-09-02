import {timingSafeEqual} from 'node:crypto';
import {DomainError, requireProjectId} from './domain.mjs';

const ALL_PERMISSIONS = Object.freeze({read: true, write: true, export: true, approve: true});

function member(permissions) {
  return Object.freeze({...permissions});
}

export function createDemoIdentities(environment = process.env) {
  return Object.freeze([
    Object.freeze({
      id: 'demo-inspector',
      name: 'Henry Kim',
      role: 'Inspector',
      token: environment.FIELDNOTE_DEMO_INSPECTOR_TOKEN ?? 'demo-inspector-token',
      memberships: Object.freeze({
        'project-c3': member({read: true, write: true, export: true, approve: false}),
      }),
    }),
    Object.freeze({
      id: 'demo-reviewer',
      name: 'Rina Park',
      role: 'Reviewer',
      token: environment.FIELDNOTE_DEMO_REVIEWER_TOKEN ?? 'demo-reviewer-token',
      memberships: Object.freeze({
        'project-c3': member({read: true, write: false, export: true, approve: true}),
      }),
    }),
    Object.freeze({
      id: 'demo-admin',
      name: 'Alex Morgan',
      role: 'Admin',
      token: environment.FIELDNOTE_DEMO_ADMIN_TOKEN ?? 'demo-admin-token',
      memberships: Object.freeze({
        'project-c3': member(ALL_PERMISSIONS),
        'project-p2': member(ALL_PERMISSIONS),
        'project-north': member(ALL_PERMISSIONS),
      }),
    }),
  ]);
}

function tokensEqual(actual, expected) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function authenticate(authorization, identities) {
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
    throw new DomainError(401, 'AUTH_REQUIRED', 'A Bearer token is required.');
  }
  const token = authorization.slice('Bearer '.length).trim();
  const identity = identities.find(candidate => tokensEqual(token, candidate.token));
  if (!identity) throw new DomainError(401, 'INVALID_TOKEN', 'The Bearer token is invalid.');
  const {token: _token, ...safeIdentity} = identity;
  return safeIdentity;
}

export function requirePermission(identity, projectId, permission) {
  requireProjectId(projectId);
  const membership = identity.memberships[projectId];
  if (!membership) {
    throw new DomainError(403, 'PROJECT_ACCESS_DENIED', 'The authenticated user is not a member of this project.');
  }
  if (!membership[permission]) {
    throw new DomainError(403, 'PERMISSION_DENIED', `The ${permission} permission is required for this project.`);
  }
  if (permission === 'approve' && identity.role !== 'Reviewer' && identity.role !== 'Admin') {
    throw new DomainError(403, 'PERMISSION_DENIED', 'Only a Reviewer or Admin may approve or return an inspection.');
  }
  return membership;
}
