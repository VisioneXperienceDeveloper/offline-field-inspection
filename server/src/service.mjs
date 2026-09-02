import {randomUUID} from 'node:crypto';
import {requirePermission} from './auth.mjs';
import {
  assert,
  clone,
  createAuditEvent,
  DomainError,
  errorPayload,
  isPlainObject,
  operationFingerprint,
  requireIdempotencyKey,
  requireInspectionId,
  requireObject,
  requireOperationId,
  requireProjectId,
  requireRevision,
  requireString,
  serverTimestamp,
} from './domain.mjs';

const KINDS = new Set(['create', 'update', 'transition', 'delete']);
const STATUS_VALUES = new Set(['Draft', 'Submitted', 'Approved']);
const ANSWER_VALUES = new Set(['pass', 'fail', 'na', null]);
const CREATE_FIELDS = new Set([
  'id', 'projectId', 'title', 'templateId', 'templateName', 'zone', 'inspectionDate', 'weather',
  'requiresPhotos', 'photos', 'checklist', 'status',
]);
const UPDATE_FIELDS = new Set([
  'title', 'zone', 'inspectionDate', 'weather', 'requiresPhotos', 'photos', 'checklist',
]);

function operationIndexKey(identity, projectId, value) {
  return JSON.stringify([identity.id, projectId, value]);
}

function projectRecords(state, projectId) {
  state.inspections[projectId] ??= {};
  return state.inspections[projectId];
}

function projectAudits(state, projectId) {
  state.audits[projectId] ??= {};
  return state.audits[projectId];
}

function inspectionAudits(state, projectId, inspectionId) {
  const audits = projectAudits(state, projectId);
  audits[inspectionId] ??= [];
  return audits[inspectionId];
}

function activeRecord(state, projectId, inspectionId) {
  const inspection = state.inspections[projectId]?.[inspectionId];
  if (!inspection || inspection.deleted) {
    throw new DomainError(404, 'INSPECTION_NOT_FOUND', 'The inspection was not found in this project.');
  }
  return inspection;
}

function assertNoUnknownFields(value, allowed, field) {
  for (const key of Object.keys(value)) {
    assert(allowed.has(key), 422, 'IMMUTABLE_OR_UNKNOWN_FIELD', `${field}.${key} cannot be written by the client.`);
  }
}

function optionalString(value, field, {max = 200, fallback = ''} = {}) {
  if (value === undefined || value === null) return fallback;
  assert(typeof value === 'string', 422, 'VALIDATION_ERROR', `${field} must be a string.`);
  assert(value.length <= max, 422, 'VALIDATION_ERROR', `${field} must be at most ${max} characters.`);
  return value;
}

function normalizeChecklist(value = []) {
  assert(Array.isArray(value), 422, 'VALIDATION_ERROR', 'checklist must be an array.');
  assert(value.length <= 500, 422, 'VALIDATION_ERROR', 'checklist may contain at most 500 items.');
  const ids = new Set();
  return value.map((raw, index) => {
    const item = requireObject(raw, `checklist[${index}]`);
    assertNoUnknownFields(item, new Set(['id', 'title', 'answer', 'note', 'required']), `checklist[${index}]`);
    const id = typeof item.id === 'number' && Number.isSafeInteger(item.id) ? item.id : requireString(item.id, `checklist[${index}].id`, {max: 100});
    assert(!ids.has(String(id)), 422, 'VALIDATION_ERROR', `checklist contains duplicate id ${id}.`);
    ids.add(String(id));
    const answer = item.answer === undefined ? null : item.answer;
    assert(ANSWER_VALUES.has(answer), 422, 'VALIDATION_ERROR', `checklist[${index}].answer is invalid.`);
    assert(typeof item.required === 'boolean', 422, 'VALIDATION_ERROR', `checklist[${index}].required must be a boolean.`);
    return {
      id,
      title: requireString(item.title, `checklist[${index}].title`, {max: 300}),
      answer,
      note: optionalString(item.note, `checklist[${index}].note`, {max: 4000}),
      required: item.required,
    };
  });
}

function normalizePhotos(value = []) {
  assert(Array.isArray(value), 422, 'VALIDATION_ERROR', 'photos must be an array.');
  assert(value.length <= 50, 422, 'VALIDATION_ERROR', 'photos may contain at most 50 items.');
  return value.map((raw, index) => {
    const photo = requireObject(raw, `photos[${index}]`);
    assertNoUnknownFields(photo, new Set(['id', 'name', 'capturedAt', 'location', 'checksum', 'uploadId']), `photos[${index}]`);
    return {
      id: requireString(photo.id, `photos[${index}].id`, {max: 128}),
      name: requireString(photo.name, `photos[${index}].name`, {max: 255}),
      capturedAt: optionalString(photo.capturedAt, `photos[${index}].capturedAt`, {max: 50}),
      location: optionalString(photo.location, `photos[${index}].location`, {max: 300}),
      ...(photo.checksum === undefined ? {} : {checksum: requireString(photo.checksum, `photos[${index}].checksum`, {max: 128})}),
      ...(photo.uploadId === undefined ? {} : {uploadId: requireString(photo.uploadId, `photos[${index}].uploadId`, {max: 128})}),
    };
  });
}

function normalizeCreate(payload, projectId, actor, timestamp) {
  const input = requireObject(payload, 'payload');
  assertNoUnknownFields(input, CREATE_FIELDS, 'payload');
  if (input.projectId !== undefined) {
    assert(input.projectId === projectId, 422, 'PROJECT_MISMATCH', 'payload.projectId must match the project in the URL.');
  }
  assert(input.status === undefined || input.status === 'Draft', 422, 'INVALID_INITIAL_STATUS', 'A new inspection must start as Draft.');
  if (input.requiresPhotos !== undefined) {
    assert(typeof input.requiresPhotos === 'boolean', 422, 'VALIDATION_ERROR', 'payload.requiresPhotos must be a boolean.');
  }
  return {
    id: requireInspectionId(input.id),
    projectId,
    title: requireString(input.title, 'payload.title', {max: 200}),
    templateId: optionalString(input.templateId, 'payload.templateId', {max: 128}),
    templateName: optionalString(input.templateName, 'payload.templateName', {max: 200}),
    zone: optionalString(input.zone, 'payload.zone', {max: 200, fallback: 'Select a site zone'}),
    inspectionDate: optionalString(input.inspectionDate, 'payload.inspectionDate', {max: 50}),
    weather: optionalString(input.weather, 'payload.weather', {max: 100}),
    requiresPhotos: input.requiresPhotos === undefined ? false : input.requiresPhotos,
    photos: normalizePhotos(input.photos),
    checklist: normalizeChecklist(input.checklist),
    status: 'Draft',
    createdBy: actor.id,
    approvedBy: null,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    deleted: false,
  };
}

function normalizeChanges(payload) {
  const changes = requireObject(payload, 'payload');
  assertNoUnknownFields(changes, UPDATE_FIELDS, 'payload');
  assert(Object.keys(changes).length > 0, 422, 'VALIDATION_ERROR', 'At least one writable field is required.');
  const normalized = {};
  if ('title' in changes) normalized.title = requireString(changes.title, 'payload.title', {max: 200});
  if ('zone' in changes) normalized.zone = optionalString(changes.zone, 'payload.zone', {max: 200});
  if ('inspectionDate' in changes) normalized.inspectionDate = optionalString(changes.inspectionDate, 'payload.inspectionDate', {max: 50});
  if ('weather' in changes) normalized.weather = optionalString(changes.weather, 'payload.weather', {max: 100});
  if ('requiresPhotos' in changes) {
    assert(typeof changes.requiresPhotos === 'boolean', 422, 'VALIDATION_ERROR', 'payload.requiresPhotos must be a boolean.');
    normalized.requiresPhotos = changes.requiresPhotos;
  }
  if ('photos' in changes) normalized.photos = normalizePhotos(changes.photos);
  if ('checklist' in changes) normalized.checklist = normalizeChecklist(changes.checklist);
  return normalized;
}

function assertCurrentRevision(inspection, baseRevision) {
  if (inspection.revision !== baseRevision) {
    throw new DomainError(409, 'REVISION_CONFLICT', 'The inspection changed after this operation was created.', {
      expectedRevision: baseRevision,
      currentRevision: inspection.revision,
    });
  }
}

function assertSubmittable(inspection) {
  assert(inspection.zone && inspection.zone !== 'Select a site zone', 422, 'SUBMISSION_INCOMPLETE', 'Select a site zone before submitting.', {field: 'zone'});
  const missing = inspection.checklist.filter(item => item.required && item.answer === null);
  assert(missing.length === 0, 422, 'SUBMISSION_INCOMPLETE', 'Complete all required checklist items before submitting.', {missingChecklistIds: missing.map(item => item.id)});
  const failuresWithoutNotes = inspection.checklist.filter(item => item.answer === 'fail' && !item.note.trim());
  assert(failuresWithoutNotes.length === 0, 422, 'SUBMISSION_INCOMPLETE', 'Add a corrective action note to every failed item.', {checklistIds: failuresWithoutNotes.map(item => item.id)});
  assert(!inspection.requiresPhotos || inspection.photos.length > 0, 422, 'SUBMISSION_INCOMPLETE', 'Attach at least one photo before submitting this inspection.', {field: 'photos'});
}

function normalizeOperation(raw, projectId) {
  const input = requireObject(raw, 'operation');
  const kind = requireString(input.kind, 'kind', {max: 20});
  assert(KINDS.has(kind), 422, 'VALIDATION_ERROR', 'kind must be create, update, transition, or delete.');
  const operationId = requireOperationId(input.operationId);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const payload = input.payload ?? {};
  let inspectionId = input.inspectionId;
  if (kind === 'create' && inspectionId === undefined && isPlainObject(payload)) inspectionId = payload.id;
  inspectionId = requireInspectionId(inspectionId);
  const baseRevision = requireRevision(input.baseRevision, {allowZero: kind === 'create'});
  if (kind === 'create') assert(baseRevision === 0, 422, 'VALIDATION_ERROR', 'A create operation must use baseRevision 0.');
  return {operationId, idempotencyKey, kind, inspectionId, baseRevision, payload, projectId};
}

function csvCell(value) {
  const raw = String(value ?? '');
  const safe = /^[=+\-@]/.test(raw.trimStart()) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

export class InspectionService {
  constructor({storage, clock = () => new Date(), metrics}) {
    this.storage = storage;
    this.clock = clock;
    this.metrics = metrics;
  }

  async list(identity, projectId) {
    requireProjectId(projectId);
    requirePermission(identity, projectId, 'read');
    const state = await this.storage.snapshot();
    return Object.values(state.inspections[projectId] ?? {})
      .filter(inspection => !inspection.deleted)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(clone);
  }

  async get(identity, projectId, inspectionId) {
    requireProjectId(projectId);
    requirePermission(identity, projectId, 'read');
    const state = await this.storage.snapshot();
    return clone(activeRecord(state, projectId, requireInspectionId(inspectionId)));
  }

  async audit(identity, projectId, inspectionId) {
    requireProjectId(projectId);
    requirePermission(identity, projectId, 'read');
    const state = await this.storage.snapshot();
    const id = requireInspectionId(inspectionId);
    const inspection = state.inspections[projectId]?.[id];
    if (!inspection) throw new DomainError(404, 'INSPECTION_NOT_FOUND', 'The inspection was not found in this project.');
    return clone(state.audits[projectId]?.[id] ?? []);
  }

  async exportCsv(identity, projectId) {
    requireProjectId(projectId);
    requirePermission(identity, projectId, 'export');
    const inspections = await this.list({...identity, memberships: {...identity.memberships, [projectId]: {...identity.memberships[projectId], read: true}}}, projectId);
    const rows = [
      ['ID', 'Project', 'Title', 'Zone', 'Status', 'Created by', 'Approved by', 'Revision', 'Updated at'],
      ...inspections.map(item => [item.id, item.projectId, item.title, item.zone, item.status, item.createdBy, item.approvedBy, item.revision, item.updatedAt]),
    ];
    return `${rows.map(row => row.map(csvCell).join(',')).join('\n')}\n`;
  }

  async applyOperation(identity, projectId, rawOperation) {
    requireProjectId(projectId);
    const operation = normalizeOperation(rawOperation, projectId);
    const fingerprint = operationFingerprint(operation);
    return this.storage.transaction(state => {
      const operationKey = operationIndexKey(identity, projectId, operation.operationId);
      const idempotencyKey = operationIndexKey(identity, projectId, operation.idempotencyKey);
      const existingOperation = state.operations.byOperation[operationKey];
      if (existingOperation) {
        if (existingOperation.fingerprint === fingerprint) return existingOperation.result;
        return this.#collision(operation, 'OPERATION_ID_REUSED', 'operationId was already used for a different request.');
      }
      const keyedOperation = state.operations.byIdempotencyKey[idempotencyKey];
      if (keyedOperation) {
        const existing = state.operations.byOperation[keyedOperation];
        if (existing?.fingerprint === fingerprint) return existing.result;
        return this.#collision(operation, 'IDEMPOTENCY_KEY_REUSED', 'The idempotency key was already used for a different request.');
      }

      let result;
      try {
        result = this.#execute(state, identity, operation);
      } catch (error) {
        result = this.#rejection(state, identity, operation, error);
      }
      state.operations.byOperation[operationKey] = {fingerprint, result};
      state.operations.byIdempotencyKey[idempotencyKey] = operationKey;
      this.metrics?.operation(result.body.status);
      return result;
    });
  }

  #execute(state, identity, operation) {
    const timestamp = serverTimestamp(this.clock);
    if (operation.kind === 'create') return this.#create(state, identity, operation, timestamp);
    if (operation.kind === 'update') return this.#update(state, identity, operation, timestamp);
    if (operation.kind === 'transition') return this.#transition(state, identity, operation, timestamp);
    return this.#delete(state, identity, operation, timestamp);
  }

  #create(state, identity, operation, timestamp) {
    requirePermission(identity, operation.projectId, 'write');
    const records = projectRecords(state, operation.projectId);
    assert(!records[operation.inspectionId], 409, 'INSPECTION_ALREADY_EXISTS', 'An inspection with this id already exists.');
    const inspection = normalizeCreate(operation.payload, operation.projectId, identity, timestamp);
    assert(inspection.id === operation.inspectionId, 422, 'INSPECTION_ID_MISMATCH', 'inspectionId must match payload.id.');
    records[inspection.id] = inspection;
    inspectionAudits(state, inspection.projectId, inspection.id).push(createAuditEvent({
      action: 'inspection.created', actor: identity, inspection, timestamp,
    }));
    return this.#success(operation, inspection, timestamp);
  }

  #update(state, identity, operation, timestamp) {
    requirePermission(identity, operation.projectId, 'write');
    const inspection = activeRecord(state, operation.projectId, operation.inspectionId);
    assertCurrentRevision(inspection, operation.baseRevision);
    assert(inspection.status === 'Draft', 409, 'INSPECTION_LOCKED', 'Only a Draft inspection may be edited.');
    const changes = normalizeChanges(operation.payload);
    Object.assign(inspection, changes, {revision: inspection.revision + 1, updatedAt: timestamp});
    inspectionAudits(state, inspection.projectId, inspection.id).push(createAuditEvent({
      action: 'inspection.updated', actor: identity, inspection, timestamp, detail: {fields: Object.keys(changes).sort()},
    }));
    return this.#success(operation, inspection, timestamp);
  }

  #transition(state, identity, operation, timestamp) {
    const payload = requireObject(operation.payload, 'payload');
    assertNoUnknownFields(payload, new Set(['status']), 'payload');
    assert(STATUS_VALUES.has(payload.status), 422, 'VALIDATION_ERROR', 'payload.status must be Draft, Submitted, or Approved.');
    const permission = payload.status === 'Submitted' ? 'write' : 'approve';
    requirePermission(identity, operation.projectId, permission);
    const inspection = activeRecord(state, operation.projectId, operation.inspectionId);
    assertCurrentRevision(inspection, operation.baseRevision);
    const allowed = inspection.status === 'Draft' && payload.status === 'Submitted'
      || inspection.status === 'Submitted' && (payload.status === 'Draft' || payload.status === 'Approved');
    assert(allowed, 409, 'INVALID_STATE_TRANSITION', `An inspection cannot move from ${inspection.status} to ${payload.status}.`);
    if (payload.status === 'Submitted') assertSubmittable(inspection);
    if (payload.status === 'Approved') {
      assert(identity.id !== inspection.createdBy, 403, 'SEPARATION_OF_DUTIES', 'The inspection author cannot approve their own inspection.');
    }
    inspection.status = payload.status;
    inspection.revision += 1;
    inspection.updatedAt = timestamp;
    inspection.approvedBy = payload.status === 'Approved' ? identity.id : null;
    const action = payload.status === 'Submitted' ? 'inspection.submitted'
      : payload.status === 'Approved' ? 'inspection.approved' : 'inspection.returned_to_draft';
    inspectionAudits(state, inspection.projectId, inspection.id).push(createAuditEvent({action, actor: identity, inspection, timestamp}));
    return this.#success(operation, inspection, timestamp);
  }

  #delete(state, identity, operation, timestamp) {
    requirePermission(identity, operation.projectId, 'write');
    const inspection = activeRecord(state, operation.projectId, operation.inspectionId);
    assertCurrentRevision(inspection, operation.baseRevision);
    assert(inspection.status === 'Draft', 409, 'INSPECTION_LOCKED', 'Only a Draft inspection may be deleted.');
    inspection.deleted = true;
    inspection.deletedAt = timestamp;
    inspection.revision += 1;
    inspection.updatedAt = timestamp;
    inspectionAudits(state, inspection.projectId, inspection.id).push(createAuditEvent({
      action: 'inspection.deleted', actor: identity, inspection, timestamp,
    }));
    return this.#success(operation, inspection, timestamp, {deleted: true});
  }

  #success(operation, inspection, timestamp, extra = {}) {
    return {
      httpStatus: operation.kind === 'create' ? 201 : 200,
      body: {
        operationId: operation.operationId,
        idempotencyKey: operation.idempotencyKey,
        status: 'acked',
        projectId: operation.projectId,
        inspectionId: inspection.id,
        revision: inspection.revision,
        serverTimestamp: timestamp,
        inspection: clone(inspection),
        ...extra,
      },
    };
  }

  #collision(operation, code, message) {
    const timestamp = serverTimestamp(this.clock);
    this.metrics?.operation('conflict');
    return {
      httpStatus: 409,
      body: {
        operationId: operation.operationId,
        idempotencyKey: operation.idempotencyKey,
        status: 'conflict',
        projectId: operation.projectId,
        inspectionId: operation.inspectionId,
        serverTimestamp: timestamp,
        error: {code, message},
      },
    };
  }

  #rejection(state, identity, operation, error) {
    const normalized = error instanceof DomainError ? error : new DomainError(500, 'INTERNAL_ERROR', 'An unexpected server error occurred.');
    const timestamp = serverTimestamp(this.clock);
    const inspection = state.inspections[operation.projectId]?.[operation.inspectionId];
    const audit = {
      id: randomUUID(),
      projectId: operation.projectId,
      inspectionId: operation.inspectionId,
      action: `inspection.${operation.kind}_rejected`,
      actor: {id: identity.id, name: identity.name, role: identity.role},
      serverTimestamp: timestamp,
      revision: inspection?.revision ?? 0,
      detail: {code: normalized.code},
    };
    state.securityAudit.push(audit);
    if (inspection) inspectionAudits(state, operation.projectId, operation.inspectionId).push(audit);
    return {
      httpStatus: normalized.status,
      body: {
        operationId: operation.operationId,
        idempotencyKey: operation.idempotencyKey,
        status: normalized.status === 409 ? 'conflict' : 'rejected',
        projectId: operation.projectId,
        inspectionId: operation.inspectionId,
        serverTimestamp: timestamp,
        error: errorPayload(normalized),
      },
    };
  }
}

export function toOperation({kind, inspectionId, body, idempotencyKey}) {
  const input = requireObject(body);
  return {
    kind,
    operationId: input.operationId,
    idempotencyKey,
    inspectionId: inspectionId ?? input.inspection?.id,
    baseRevision: input.baseRevision,
    payload: kind === 'create' ? input.inspection
      : kind === 'update' ? input.changes
        : kind === 'transition' ? {status: input.status} : {},
  };
}
