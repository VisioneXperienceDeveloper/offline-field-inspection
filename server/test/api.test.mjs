import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {loadConfig} from '../src/config.mjs';
import {createFieldnoteServer} from '../src/http.mjs';
import {createMemoryStorage} from '../src/storage.mjs';

const TOKENS = {
  inspector: 'demo-inspector-token',
  reviewer: 'demo-reviewer-token',
  admin: 'demo-admin-token',
};

let server;
let baseUrl;

before(async () => {
  const config = {
    ...loadConfig({
      FIELDNOTE_PORT: '0',
      FIELDNOTE_BODY_LIMIT_BYTES: '2048',
      FIELDNOTE_CORS_ORIGINS: 'http://localhost:4200',
    }),
    dataFile: null,
  };
  server = createFieldnoteServer({
    config,
    storage: createMemoryStorage(),
    logger: {error() {}},
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

async function api(path, {method = 'GET', token, body, key, origin} = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (key) headers['Idempotency-Key'] = key;
  if (origin) headers.Origin = origin;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const contentType = response.headers.get('content-type') ?? '';
  const value = contentType.includes('application/json') ? await response.json() : await response.text();
  return {response, value};
}

function inspection(id, overrides = {}) {
  return {
    id,
    title: `Safety inspection ${id}`,
    zone: 'Zone A',
    requiresPhotos: false,
    photos: [],
    checklist: [{id: 1, title: 'Guard rail is secure', answer: 'pass', note: '', required: true}],
    ...overrides,
  };
}

async function create(projectId, id, token = TOKENS.inspector, suffix = id) {
  return api(`/v1/projects/${projectId}/inspections`, {
    method: 'POST',
    token,
    key: `idem-create-${suffix}`,
    body: {operationId: `op-create-${suffix}`, baseRevision: 0, inspection: inspection(id)},
  });
}

async function transition(projectId, id, status, baseRevision, token, suffix) {
  return api(`/v1/projects/${projectId}/inspections/${id}/transitions`, {
    method: 'POST',
    token,
    key: `idem-transition-${suffix}`,
    body: {operationId: `op-transition-${suffix}`, baseRevision, status},
  });
}

test('Bearer authentication is required and valid demo identities can read their project', async () => {
  const missing = await api('/v1/projects/project-c3/inspections');
  assert.equal(missing.response.status, 401);
  assert.equal(missing.value.error.code, 'AUTH_REQUIRED');
  assert.match(missing.response.headers.get('www-authenticate'), /^Bearer/);

  const invalid = await api('/v1/projects/project-c3/inspections', {token: 'not-a-token'});
  assert.equal(invalid.response.status, 401);
  assert.equal(invalid.value.error.code, 'INVALID_TOKEN');

  const valid = await api('/v1/projects/project-c3/inspections', {token: TOKENS.inspector});
  assert.equal(valid.response.status, 200);
  assert.ok(Array.isArray(valid.value.data));
});

test('project membership isolates list, detail, and export access', async () => {
  const created = await create('project-p2', 'INSP-P2-1', TOKENS.admin, 'p2-1');
  assert.equal(created.response.status, 201);

  for (const path of [
    '/v1/projects/project-p2/inspections',
    '/v1/projects/project-p2/inspections/INSP-P2-1',
    '/v1/projects/project-p2/inspections/export',
  ]) {
    const denied = await api(path, {token: TOKENS.inspector});
    assert.equal(denied.response.status, 403);
    assert.equal(denied.value.error.code, 'PROJECT_ACCESS_DENIED');
  }
});

test('an Inspector cannot approve, the denial is audited, and a Reviewer can approve', async () => {
  const id = 'INSP-APPROVAL-1';
  assert.equal((await create('project-c3', id, TOKENS.inspector, 'approval-1')).response.status, 201);
  const submitted = await transition('project-c3', id, 'Submitted', 1, TOKENS.inspector, 'submit-approval-1');
  assert.equal(submitted.response.status, 200);
  assert.equal(submitted.value.revision, 2);

  const denied = await transition('project-c3', id, 'Approved', 2, TOKENS.inspector, 'deny-approval-1');
  assert.equal(denied.response.status, 403);
  assert.equal(denied.value.status, 'rejected');
  assert.equal(denied.value.error.code, 'PERMISSION_DENIED');

  const auditAfterDenial = await api(`/v1/projects/project-c3/inspections/${id}/audit`, {token: TOKENS.reviewer});
  assert.equal(auditAfterDenial.response.status, 200);
  assert.ok(auditAfterDenial.value.data.some(event =>
    event.action === 'inspection.transition_rejected'
    && event.actor.id === 'demo-inspector'
    && event.revision === 2
    && event.detail.code === 'PERMISSION_DENIED'));

  const approved = await transition('project-c3', id, 'Approved', 2, TOKENS.reviewer, 'approve-approval-1');
  assert.equal(approved.response.status, 200);
  assert.equal(approved.value.inspection.status, 'Approved');
  assert.equal(approved.value.inspection.approvedBy, 'demo-reviewer');
  assert.equal(approved.value.revision, 3);
});

test('the author cannot approve their own submitted inspection even as Admin', async () => {
  const id = 'INSP-SOD-1';
  assert.equal((await create('project-c3', id, TOKENS.admin, 'sod-1')).response.status, 201);
  assert.equal((await transition('project-c3', id, 'Submitted', 1, TOKENS.admin, 'submit-sod-1')).response.status, 200);
  const denied = await transition('project-c3', id, 'Approved', 2, TOKENS.admin, 'approve-sod-1');
  assert.equal(denied.response.status, 403);
  assert.equal(denied.value.error.code, 'SEPARATION_OF_DUTIES');
});

test('duplicate operation and idempotency key return the exact original ACK once', async () => {
  const id = 'INSP-IDEMPOTENT-1';
  const request = {
    method: 'POST',
    token: TOKENS.inspector,
    key: 'idem-create-idempotent-1',
    body: {operationId: 'op-create-idempotent-1', baseRevision: 0, inspection: inspection(id)},
  };
  const first = await api('/v1/projects/project-c3/inspections', request);
  const replay = await api('/v1/projects/project-c3/inspections', request);
  assert.equal(first.response.status, 201);
  assert.equal(replay.response.status, 201);
  assert.deepEqual(replay.value, first.value);

  const list = await api('/v1/projects/project-c3/inspections', {token: TOKENS.inspector});
  assert.equal(list.value.data.filter(item => item.id === id).length, 1);
  const audit = await api(`/v1/projects/project-c3/inspections/${id}/audit`, {token: TOKENS.inspector});
  assert.equal(audit.value.data.filter(event => event.action === 'inspection.created').length, 1);

  const reused = await api('/v1/projects/project-c3/inspections', {
    ...request,
    body: {...request.body, inspection: inspection('INSP-IDEMPOTENT-CHANGED')},
  });
  assert.equal(reused.response.status, 409);
  assert.equal(reused.value.error.code, 'OPERATION_ID_REUSED');
});

test('stale optimistic revision is rejected with 409 and the current revision', async () => {
  const id = 'INSP-CONFLICT-1';
  assert.equal((await create('project-c3', id, TOKENS.inspector, 'conflict-1')).response.status, 201);
  const updated = await api(`/v1/projects/project-c3/inspections/${id}`, {
    method: 'PATCH', token: TOKENS.inspector, key: 'idem-update-conflict-1',
    body: {operationId: 'op-update-conflict-1', baseRevision: 1, changes: {weather: 'Rain'}},
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.value.revision, 2);

  const conflict = await api(`/v1/projects/project-c3/inspections/${id}`, {
    method: 'PATCH', token: TOKENS.inspector, key: 'idem-update-conflict-2',
    body: {operationId: 'op-update-conflict-2', baseRevision: 1, changes: {weather: 'Wind'}},
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.value.status, 'conflict');
  assert.equal(conflict.value.error.code, 'REVISION_CONFLICT');
  assert.deepEqual(conflict.value.error.details, {expectedRevision: 1, currentRevision: 2});

  const current = await api(`/v1/projects/project-c3/inspections/${id}`, {token: TOKENS.inspector});
  assert.equal(current.value.data.weather, 'Rain');
  assert.equal(current.value.data.revision, 2);
});

test('submission validation and Draft deletion are enforced by the server state machine', async () => {
  const incompleteId = 'INSP-INCOMPLETE-1';
  const incomplete = await api('/v1/projects/project-c3/inspections', {
    method: 'POST', token: TOKENS.inspector, key: 'idem-create-incomplete-1',
    body: {
      operationId: 'op-create-incomplete-1', baseRevision: 0,
      inspection: inspection(incompleteId, {
        zone: 'Select a site zone',
        requiresPhotos: true,
        checklist: [{id: 1, title: 'Required answer', answer: null, note: '', required: true}],
      }),
    },
  });
  assert.equal(incomplete.response.status, 201);
  const rejected = await transition('project-c3', incompleteId, 'Submitted', 1, TOKENS.inspector, 'incomplete-1');
  assert.equal(rejected.response.status, 422);
  assert.equal(rejected.value.error.code, 'SUBMISSION_INCOMPLETE');

  const deleteId = 'INSP-DELETE-1';
  assert.equal((await create('project-c3', deleteId, TOKENS.inspector, 'delete-1')).response.status, 201);
  const deleted = await api(`/v1/projects/project-c3/inspections/${deleteId}`, {
    method: 'DELETE', token: TOKENS.inspector, key: 'idem-delete-1',
    body: {operationId: 'op-delete-1', baseRevision: 1},
  });
  assert.equal(deleted.response.status, 200);
  assert.equal(deleted.value.deleted, true);
  assert.equal(deleted.value.revision, 2);
  const missing = await api(`/v1/projects/project-c3/inspections/${deleteId}`, {token: TOKENS.inspector});
  assert.equal(missing.response.status, 404);
  const audit = await api(`/v1/projects/project-c3/inspections/${deleteId}/audit`, {token: TOKENS.inspector});
  assert.deepEqual(audit.value.data.map(event => event.action), ['inspection.created', 'inspection.deleted']);
});

test('audit is server-authored, append-only, actor-attributed, and revision-linked', async () => {
  const id = 'INSP-AUDIT-1';
  assert.equal((await create('project-c3', id, TOKENS.inspector, 'audit-1')).response.status, 201);
  const update = await api(`/v1/projects/project-c3/inspections/${id}`, {
    method: 'PATCH', token: TOKENS.inspector, key: 'idem-update-audit-1',
    body: {operationId: 'op-update-audit-1', baseRevision: 1, changes: {weather: 'Cloudy'}},
  });
  assert.equal(update.response.status, 200);
  assert.equal((await transition('project-c3', id, 'Submitted', 2, TOKENS.inspector, 'submit-audit-1')).response.status, 200);
  assert.equal((await transition('project-c3', id, 'Approved', 3, TOKENS.reviewer, 'approve-audit-1')).response.status, 200);

  const audit = await api(`/v1/projects/project-c3/inspections/${id}/audit`, {token: TOKENS.inspector});
  assert.equal(audit.response.status, 200);
  assert.deepEqual(audit.value.data.map(event => event.revision), [1, 2, 3, 4]);
  assert.deepEqual(audit.value.data.map(event => event.actor.id), [
    'demo-inspector', 'demo-inspector', 'demo-inspector', 'demo-reviewer',
  ]);
  for (const event of audit.value.data) {
    assert.match(event.serverTimestamp, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(event.projectId, 'project-c3');
    assert.equal(event.inspectionId, id);
  }

  const draftId = 'INSP-AUDIT-CLIENT-WRITE';
  assert.equal((await create('project-c3', draftId, TOKENS.inspector, 'audit-client-write')).response.status, 201);
  const clientAuditOverwrite = await api(`/v1/projects/project-c3/inspections/${draftId}`, {
    method: 'PATCH', token: TOKENS.inspector, key: 'idem-update-audit-overwrite',
    body: {operationId: 'op-update-audit-overwrite', baseRevision: 1, changes: {auditTrail: []}},
  });
  assert.equal(clientAuditOverwrite.response.status, 422);
  assert.equal(clientAuditOverwrite.value.error.code, 'IMMUTABLE_OR_UNKNOWN_FIELD');
});

test('batch outbox applies ordered operations and replays identical per-operation ACKs', async () => {
  const id = 'INSP-BATCH-1';
  const body = {
    operations: [
      {
        operationId: 'op-batch-create-1', idempotencyKey: 'idem-batch-create-1', kind: 'create',
        inspectionId: id, baseRevision: 0, payload: inspection(id),
      },
      {
        operationId: 'op-batch-update-1', idempotencyKey: 'idem-batch-update-1', kind: 'update',
        inspectionId: id, baseRevision: 1, payload: {weather: 'Storm'},
      },
    ],
  };
  const first = await api('/v1/projects/project-c3/sync/batch', {method: 'POST', token: TOKENS.inspector, body});
  assert.equal(first.response.status, 200);
  assert.deepEqual(first.value.results.map(item => item.status), ['acked', 'acked']);
  assert.deepEqual(first.value.results.map(item => item.revision), [1, 2]);

  const replay = await api('/v1/projects/project-c3/sync/batch', {method: 'POST', token: TOKENS.inspector, body});
  assert.equal(replay.response.status, 200);
  assert.deepEqual(replay.value, first.value);

  const current = await api(`/v1/projects/project-c3/inspections/${id}`, {token: TOKENS.inspector});
  assert.equal(current.value.data.weather, 'Storm');
  assert.equal(current.value.data.revision, 2);
});

test('health, metrics, CORS allowlist, and JSON body limit are enforced', async () => {
  const health = await api('/healthz');
  assert.equal(health.response.status, 200);
  assert.equal(health.value.status, 'ok');

  const allowed = await api('/v1/projects/project-c3/inspections', {
    token: TOKENS.inspector, origin: 'http://localhost:4200',
  });
  assert.equal(allowed.response.status, 200);
  assert.equal(allowed.response.headers.get('access-control-allow-origin'), 'http://localhost:4200');

  const blocked = await api('/v1/projects/project-c3/inspections', {
    token: TOKENS.inspector, origin: 'https://attacker.example',
  });
  assert.equal(blocked.response.status, 403);
  assert.equal(blocked.value.error.code, 'CORS_ORIGIN_DENIED');

  const tooLarge = await api('/v1/projects/project-c3/inspections', {
    method: 'POST', token: TOKENS.inspector, key: 'idem-too-large',
    body: {
      operationId: 'op-too-large', baseRevision: 0,
      inspection: inspection('INSP-TOO-LARGE', {title: 'x'.repeat(3000)}),
    },
  });
  assert.equal(tooLarge.response.status, 413);
  assert.equal(tooLarge.value.error.code, 'BODY_TOO_LARGE');

  const metrics = await api('/metrics');
  assert.equal(metrics.response.status, 200);
  assert.match(metrics.value, /fieldnote_http_requests_total/);
  assert.match(metrics.value, /fieldnote_sync_operations_total\{status="acked"\}/);
});
