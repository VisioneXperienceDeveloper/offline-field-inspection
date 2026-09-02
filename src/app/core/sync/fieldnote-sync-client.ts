import {Injectable, InjectionToken, inject} from '@angular/core';
import {AuthService} from '../auth/auth.service';
import {
  OutboxOperation,
  RemoteInspectionSnapshot,
  SyncAcknowledgedResult,
  SyncBatchOperation,
  SyncBatchResult,
  SyncConflictResult,
  SyncOperationResult,
  SyncPushOptions,
  SyncRejectedResult,
  SyncServerError,
} from './sync.models';

const DEFAULT_API_BASE_URL = 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 15_000;

export const FIELDNOTE_API_BASE_URL = new InjectionToken<string>('FIELDNOTE_API_BASE_URL', {
  providedIn: 'root',
  factory: () => DEFAULT_API_BASE_URL,
});

export type SyncClientErrorKind = 'validation' | 'timeout' | 'network' | 'http' | 'invalid-response';

export class FieldnoteSyncClientError extends Error {
  constructor(
    readonly kind: SyncClientErrorKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'FieldnoteSyncClientError';
  }
}

export class SyncValidationError extends FieldnoteSyncClientError {
  constructor(message: string) {
    super('validation', message);
    this.name = 'SyncValidationError';
  }
}

export class SyncTimeoutError extends FieldnoteSyncClientError {
  constructor(readonly timeoutMs: number, options?: ErrorOptions) {
    super('timeout', `The sync request timed out after ${timeoutMs} ms.`, options);
    this.name = 'SyncTimeoutError';
  }
}

export class SyncNetworkError extends FieldnoteSyncClientError {
  constructor(message = 'The sync server could not be reached.', options?: ErrorOptions) {
    super('network', message, options);
    this.name = 'SyncNetworkError';
  }
}

export class SyncHttpError extends FieldnoteSyncClientError {
  constructor(
    readonly status: number,
    readonly serverError: SyncServerError | null,
    message: string,
  ) {
    super('http', message);
    this.name = 'SyncHttpError';
  }
}

export class SyncInvalidResponseError extends FieldnoteSyncClientError {
  constructor(message: string, options?: ErrorOptions) {
    super('invalid-response', message, options);
    this.name = 'SyncInvalidResponseError';
  }
}

@Injectable({providedIn: 'root'})
export class FieldnoteSyncClient {
  private readonly auth = inject(AuthService);
  private readonly apiBaseUrl = normalizeBaseUrl(inject(FIELDNOTE_API_BASE_URL));

  async push(
    projectId: string,
    operations: readonly OutboxOperation[],
    options: SyncPushOptions = {},
  ): Promise<SyncBatchResult> {
    const requestOperations = validateRequest(projectId, operations);
    const token = options.token ?? this.auth.bearerToken();
    if (!token.trim()) throw new SyncValidationError('A non-empty Bearer token is required.');

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new SyncValidationError('timeoutMs must be a positive finite number.');
    }

    const controller = new AbortController();
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      let response: Response;
      try {
        response = await fetch(`${this.apiBaseUrl}/v1/projects/${encodeURIComponent(projectId)}/sync/batch`, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({operations: requestOperations}),
          signal: controller.signal,
        });
      } catch (error) {
        if (timedOut) throw new SyncTimeoutError(timeoutMs, {cause: error});
        throw new SyncNetworkError('The sync server could not be reached.', {cause: error});
      }

      let responseBody: string;
      try {
        responseBody = await response.text();
      } catch (error) {
        throw new SyncNetworkError('The sync response could not be read.', {cause: error});
      }

      if (!response.ok) {
        const parsedError = tryParseJson(responseBody);
        const serverError = readServerError(parsedError);
        throw new SyncHttpError(
          response.status,
          serverError,
          serverError?.message ?? `The sync server returned HTTP ${response.status}.`,
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(responseBody) as unknown;
      } catch (error) {
        throw new SyncInvalidResponseError('The sync server returned invalid JSON.', {cause: error});
      }

      return parseBatchResult(parsed, projectId, requestOperations);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  async fetchInspection(
    projectId: string,
    inspectionId: string,
    options: SyncPushOptions = {},
  ): Promise<RemoteInspectionSnapshot> {
    if (!projectId.trim()) throw new SyncValidationError('projectId must be a non-empty string.');
    if (!inspectionId.trim()) throw new SyncValidationError('inspectionId must be a non-empty string.');
    const token = options.token ?? this.auth.bearerToken();
    if (!token.trim()) throw new SyncValidationError('A non-empty Bearer token is required.');

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new SyncValidationError('timeoutMs must be a positive finite number.');
    }

    const controller = new AbortController();
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      let response: Response;
      try {
        response = await fetch(
          `${this.apiBaseUrl}/v1/projects/${encodeURIComponent(projectId)}/inspections/${encodeURIComponent(inspectionId)}`,
          {
            method: 'GET',
            headers: {Accept: 'application/json', Authorization: `Bearer ${token}`},
            signal: controller.signal,
          },
        );
      } catch (error) {
        if (timedOut) throw new SyncTimeoutError(timeoutMs, {cause: error});
        throw new SyncNetworkError('The sync server could not be reached.', {cause: error});
      }

      let responseBody: string;
      try {
        responseBody = await response.text();
      } catch (error) {
        throw new SyncNetworkError('The sync response could not be read.', {cause: error});
      }

      if (!response.ok) {
        const parsedError = tryParseJson(responseBody);
        const serverError = readServerError(parsedError);
        throw new SyncHttpError(
          response.status,
          serverError,
          serverError?.message ?? `The sync server returned HTTP ${response.status}.`,
        );
      }

      const parsed = tryParseJson(responseBody);
      if (!isPlainObject(parsed) || !isPlainObject(parsed['data'])) {
        throw new SyncInvalidResponseError('The inspection response must contain a data object.');
      }
      return parseRemoteInspection(parsed['data'], projectId, inspectionId);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}

function validateRequest(
  projectId: string,
  operations: readonly OutboxOperation[],
): SyncBatchOperation[] {
  if (!projectId.trim()) throw new SyncValidationError('projectId must be a non-empty string.');
  if (operations.length < 1 || operations.length > 100) {
    throw new SyncValidationError('A sync batch must contain from 1 to 100 operations.');
  }

  return operations.map(operation => {
    if (operation.projectId !== projectId) {
      throw new SyncValidationError(
        `Operation ${operation.operationId} belongs to ${operation.projectId}, not ${projectId}.`,
      );
    }
    if (!operation.operationId || !operation.idempotencyKey || !operation.inspectionId) {
      throw new SyncValidationError('Every operation requires operationId, idempotencyKey, and inspectionId.');
    }
    if (!Number.isSafeInteger(operation.baseRevision) || operation.baseRevision < 0) {
      throw new SyncValidationError(`Operation ${operation.operationId} has an invalid baseRevision.`);
    }

    return {
      operationId: operation.operationId,
      idempotencyKey: operation.idempotencyKey,
      kind: operation.kind,
      inspectionId: operation.inspectionId,
      baseRevision: operation.baseRevision,
      payload: operation.payload,
    };
  });
}

function parseBatchResult(
  value: unknown,
  projectId: string,
  operations: readonly SyncBatchOperation[],
): SyncBatchResult {
  if (!isPlainObject(value) || !Array.isArray(value['results'])) {
    throw new SyncInvalidResponseError('The sync response must contain a results array.');
  }
  if (value['results'].length !== operations.length) {
    throw new SyncInvalidResponseError('The sync response result count does not match the request.');
  }

  const results = value['results'].map((raw, index) => {
    const expected = operations[index];
    if (!expected) throw new SyncInvalidResponseError('The sync response contains an unexpected result.');
    const result = parseOperationResult(raw);
    if (
      result.operationId !== expected.operationId
      || result.idempotencyKey !== expected.idempotencyKey
      || result.projectId !== projectId
      || result.inspectionId !== expected.inspectionId
    ) {
      throw new SyncInvalidResponseError(`The result at index ${index} does not match its queued operation.`);
    }
    return result;
  });

  return {results};
}

function parseOperationResult(value: unknown): SyncOperationResult {
  if (!isPlainObject(value)) throw new SyncInvalidResponseError('Each sync result must be an object.');

  const operationId = requiredString(value['operationId'], 'operationId');
  const idempotencyKey = requiredString(value['idempotencyKey'], 'idempotencyKey');
  const projectId = requiredString(value['projectId'], 'projectId');
  const inspectionId = requiredString(value['inspectionId'], 'inspectionId');
  const status = value['status'];
  const serverTimestamp = optionalString(value['serverTimestamp'], 'serverTimestamp');

  const base = {operationId, idempotencyKey, projectId, inspectionId, serverTimestamp};
  if (status === 'acked') {
    const revision = value['revision'];
    if (!Number.isSafeInteger(revision) || (revision as number) < 1) {
      throw new SyncInvalidResponseError('An acknowledged result requires a positive integer revision.');
    }
    if (!serverTimestamp) {
      throw new SyncInvalidResponseError('An acknowledged result requires serverTimestamp.');
    }
    if (!isPlainObject(value['inspection'])) {
      throw new SyncInvalidResponseError('An acknowledged result requires an inspection object.');
    }
    const result: SyncAcknowledgedResult = {
      ...base,
      status,
      revision: revision as number,
      serverTimestamp,
      inspection: value['inspection'],
    };
    if (value['deleted'] !== undefined) {
      if (typeof value['deleted'] !== 'boolean') {
        throw new SyncInvalidResponseError('deleted must be a boolean when provided.');
      }
      result.deleted = value['deleted'];
    }
    return result;
  }

  if (status !== 'conflict' && status !== 'rejected') {
    throw new SyncInvalidResponseError('A sync result status must be acked, conflict, or rejected.');
  }
  const error = requiredServerError(value['error']);
  if (status === 'conflict') {
    const result: SyncConflictResult = {...base, status, error};
    return result;
  }
  const result: SyncRejectedResult = {...base, status, error};
  return result;
}

function parseRemoteInspection(
  value: Record<string, unknown>,
  projectId: string,
  inspectionId: string,
): RemoteInspectionSnapshot {
  const id = requiredString(value['id'], 'data.id');
  const responseProjectId = requiredString(value['projectId'], 'data.projectId');
  if (id !== inspectionId || responseProjectId !== projectId) {
    throw new SyncInvalidResponseError('The remote inspection does not match the requested project and id.');
  }

  const status = value['status'];
  if (status !== 'Draft' && status !== 'Submitted' && status !== 'Approved') {
    throw new SyncInvalidResponseError('data.status must be Draft, Submitted, or Approved.');
  }
  const revision = value['revision'];
  if (!Number.isSafeInteger(revision) || (revision as number) < 1) {
    throw new SyncInvalidResponseError('data.revision must be a positive integer.');
  }
  if (typeof value['requiresPhotos'] !== 'boolean') {
    throw new SyncInvalidResponseError('data.requiresPhotos must be a boolean.');
  }
  if (!Array.isArray(value['checklist']) || !Array.isArray(value['photos'])) {
    throw new SyncInvalidResponseError('data.checklist and data.photos must be arrays.');
  }

  const approvedBy = value['approvedBy'];
  if (approvedBy !== null && (typeof approvedBy !== 'string' || approvedBy.length === 0)) {
    throw new SyncInvalidResponseError('data.approvedBy must be a non-empty string or null.');
  }

  return {
    id,
    projectId: responseProjectId,
    title: requiredString(value['title'], 'data.title'),
    templateId: stringValue(value['templateId'], 'data.templateId'),
    templateName: stringValue(value['templateName'], 'data.templateName'),
    zone: stringValue(value['zone'], 'data.zone'),
    inspectionDate: stringValue(value['inspectionDate'], 'data.inspectionDate'),
    weather: stringValue(value['weather'], 'data.weather'),
    requiresPhotos: value['requiresPhotos'],
    photos: value['photos'].map((photo, index) => parseRemotePhoto(photo, index)),
    checklist: value['checklist'].map((item, index) => parseRemoteChecklistItem(item, index)),
    status,
    createdBy: requiredString(value['createdBy'], 'data.createdBy'),
    approvedBy,
    revision: revision as number,
    createdAt: isoTimestamp(value['createdAt'], 'data.createdAt'),
    updatedAt: isoTimestamp(value['updatedAt'], 'data.updatedAt'),
  };
}

function parseRemoteChecklistItem(value: unknown, index: number): RemoteInspectionSnapshot['checklist'][number] {
  if (!isPlainObject(value)) throw new SyncInvalidResponseError(`data.checklist[${index}] must be an object.`);
  const id = value['id'];
  const answer = value['answer'];
  if (!Number.isSafeInteger(id)) throw new SyncInvalidResponseError(`data.checklist[${index}].id must be an integer.`);
  if (answer !== null && answer !== 'pass' && answer !== 'fail' && answer !== 'na') {
    throw new SyncInvalidResponseError(`data.checklist[${index}].answer is invalid.`);
  }
  if (typeof value['required'] !== 'boolean') {
    throw new SyncInvalidResponseError(`data.checklist[${index}].required must be a boolean.`);
  }
  return {
    id: id as number,
    title: requiredString(value['title'], `data.checklist[${index}].title`),
    answer,
    note: stringValue(value['note'], `data.checklist[${index}].note`),
    required: value['required'],
  };
}

function parseRemotePhoto(value: unknown, index: number): RemoteInspectionSnapshot['photos'][number] {
  if (!isPlainObject(value)) throw new SyncInvalidResponseError(`data.photos[${index}] must be an object.`);
  const checksum = value['checksum'];
  const uploadId = value['uploadId'];
  if (checksum !== undefined && (typeof checksum !== 'string' || !checksum.length)) {
    throw new SyncInvalidResponseError(`data.photos[${index}].checksum must be a non-empty string.`);
  }
  if (uploadId !== undefined && (typeof uploadId !== 'string' || !uploadId.length)) {
    throw new SyncInvalidResponseError(`data.photos[${index}].uploadId must be a non-empty string.`);
  }
  return {
    id: requiredString(value['id'], `data.photos[${index}].id`),
    name: requiredString(value['name'], `data.photos[${index}].name`),
    capturedAt: stringValue(value['capturedAt'], `data.photos[${index}].capturedAt`),
    location: stringValue(value['location'], `data.photos[${index}].location`),
    ...(checksum === undefined ? {} : {checksum}),
    ...(uploadId === undefined ? {} : {uploadId}),
  };
}

function normalizeBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, '');
  if (!normalized) throw new SyncValidationError('FIELDNOTE_API_BASE_URL must be a non-empty URL.');
  try {
    const url = new URL(normalized);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol');
    return url.toString().replace(/\/$/, '');
  } catch (error) {
    throw new SyncValidationError(`FIELDNOTE_API_BASE_URL is invalid: ${String(error)}`);
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SyncInvalidResponseError(`The sync result requires ${field}.`);
  }
  return value;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new SyncInvalidResponseError(`${field} must be a string.`);
  return value;
}

function isoTimestamp(value: unknown, field: string): string {
  const timestamp = requiredString(value, field);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) {
    throw new SyncInvalidResponseError(`${field} must be an ISO timestamp.`);
  }
  return timestamp;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, field);
}

function requiredServerError(value: unknown): SyncServerError {
  if (!isPlainObject(value)) throw new SyncInvalidResponseError('A rejected result requires an error object.');
  const error: SyncServerError = {
    code: requiredString(value['code'], 'error.code'),
    message: requiredString(value['message'], 'error.message'),
  };
  if (value['details'] !== undefined) error.details = value['details'];
  return error;
}

function readServerError(value: unknown): SyncServerError | null {
  if (!isPlainObject(value) || !isPlainObject(value['error'])) return null;
  const error = value['error'];
  if (typeof error['code'] !== 'string' || typeof error['message'] !== 'string') return null;
  return {
    code: error['code'],
    message: error['message'],
    ...(error['details'] === undefined ? {} : {details: error['details']}),
  };
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
