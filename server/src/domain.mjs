import {createHash, randomUUID} from 'node:crypto';

export class DomainError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'DomainError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function assert(condition, status, code, message, details) {
  if (!condition) throw new DomainError(status, code, message, details);
}

export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function requireObject(value, field = 'body') {
  assert(isPlainObject(value), 400, 'INVALID_REQUEST', `${field} must be a JSON object.`);
  return value;
}

export function requireString(value, field, {min = 1, max = 200, pattern} = {}) {
  assert(typeof value === 'string', 422, 'VALIDATION_ERROR', `${field} must be a string.`);
  const trimmed = value.trim();
  assert(trimmed.length >= min, 422, 'VALIDATION_ERROR', `${field} is required.`);
  assert(trimmed.length <= max, 422, 'VALIDATION_ERROR', `${field} must be at most ${max} characters.`);
  assert(!pattern || pattern.test(trimmed), 422, 'VALIDATION_ERROR', `${field} has an invalid format.`);
  return trimmed;
}

export function requireRevision(value, {allowZero = false} = {}) {
  const minimum = allowZero ? 0 : 1;
  assert(Number.isSafeInteger(value) && value >= minimum, 422, 'VALIDATION_ERROR', `baseRevision must be an integer greater than or equal to ${minimum}.`);
  return value;
}

export function requireOperationId(value) {
  return requireString(value, 'operationId', {
    max: 128,
    pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
  });
}

export function requireIdempotencyKey(value) {
  return requireString(value, 'idempotencyKey', {
    max: 200,
    pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
  });
}

export function requireInspectionId(value) {
  return requireString(value, 'inspectionId', {
    max: 128,
    pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
  });
}

export function requireProjectId(value) {
  return requireString(value, 'projectId', {
    max: 100,
    pattern: /^[a-z0-9][a-z0-9-]*$/,
  });
}

export function serverTimestamp(clock = () => new Date()) {
  const value = clock();
  assert(value instanceof Date && !Number.isNaN(value.valueOf()), 500, 'CLOCK_ERROR', 'The server clock returned an invalid value.');
  return value.toISOString();
}

export function createAuditEvent({action, actor, inspection, timestamp, detail}) {
  return {
    id: randomUUID(),
    projectId: inspection.projectId,
    inspectionId: inspection.id,
    action,
    actor: {id: actor.id, name: actor.name, role: actor.role},
    serverTimestamp: timestamp,
    revision: inspection.revision,
    ...(detail === undefined ? {} : {detail}),
  };
}

export function canonicalStringify(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function operationFingerprint(operation) {
  return createHash('sha256').update(canonicalStringify({
    kind: operation.kind,
    inspectionId: operation.inspectionId,
    baseRevision: operation.baseRevision,
    payload: operation.payload,
  })).digest('hex');
}

export function errorPayload(error) {
  if (error instanceof DomainError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : {details: error.details}),
    };
  }
  return {code: 'INTERNAL_ERROR', message: 'An unexpected server error occurred.'};
}

export function clone(value) {
  return structuredClone(value);
}
