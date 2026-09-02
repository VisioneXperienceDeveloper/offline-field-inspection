import {createServer} from 'node:http';
import {performance} from 'node:perf_hooks';
import {randomUUID} from 'node:crypto';
import {authenticate} from './auth.mjs';
import {DomainError, errorPayload, requireIdempotencyKey, requireObject, requireProjectId} from './domain.mjs';
import {InspectionService, toOperation} from './service.mjs';
import {Metrics} from './metrics.mjs';

const ALLOWED_METHODS = 'GET,POST,PATCH,DELETE,OPTIONS';
const ALLOWED_HEADERS = 'Authorization,Content-Type,Idempotency-Key,X-Request-Id';

function decodeSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new DomainError(400, 'INVALID_PATH', 'The URL contains invalid percent encoding.');
  }
}

function match(pathname, expression) {
  const result = pathname.match(expression);
  return result ? result.slice(1).map(decodeSegment) : null;
}

function requestId(request) {
  const candidate = request.headers['x-request-id'];
  return typeof candidate === 'string' && /^[A-Za-z0-9._:-]{1,100}$/.test(candidate) ? candidate : randomUUID();
}

function setCors(request, response, config) {
  const origin = request.headers.origin;
  if (origin === undefined) return;
  if (typeof origin !== 'string' || !config.corsOrigins.has(origin)) {
    throw new DomainError(403, 'CORS_ORIGIN_DENIED', 'This Origin is not allowed to call the API.');
  }
  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Vary', 'Origin');
  response.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
  response.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
  response.setHeader('Access-Control-Max-Age', '600');
}

async function readJson(request, limit) {
  const contentType = request.headers['content-type'];
  if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
    throw new DomainError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
  }
  const announcedLength = Number(request.headers['content-length']);
  if (Number.isFinite(announcedLength) && announcedLength > limit) {
    request.resume();
    throw new DomainError(413, 'BODY_TOO_LARGE', `The JSON body exceeds the ${limit} byte limit.`);
  }
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    request.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > limit) {
        chunks.length = 0;
        request.resume();
        fail(new DomainError(413, 'BODY_TOO_LARGE', `The JSON body exceeds the ${limit} byte limit.`));
        return;
      }
      if (!settled) chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return reject(new DomainError(400, 'INVALID_JSON', 'A JSON body is required.'));
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new DomainError(400, 'INVALID_JSON', 'The request body is not valid JSON.'));
      }
    });
    request.on('error', fail);
    request.on('aborted', () => fail(new DomainError(400, 'REQUEST_ABORTED', 'The client aborted the request.')));
  });
}

function writeJson(response, status, value, id) {
  const body = Buffer.from(JSON.stringify(value));
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', String(body.length));
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Request-Id', id);
  response.end(body);
}

function writeText(response, status, value, type, id, extraHeaders = {}) {
  const body = Buffer.from(value);
  response.statusCode = status;
  response.setHeader('Content-Type', type);
  response.setHeader('Content-Length', String(body.length));
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Request-Id', id);
  for (const [key, headerValue] of Object.entries(extraHeaders)) response.setHeader(key, headerValue);
  response.end(body);
}

function idempotencyHeader(request) {
  const value = request.headers['idempotency-key'];
  if (Array.isArray(value)) throw new DomainError(400, 'INVALID_IDEMPOTENCY_KEY', 'Exactly one Idempotency-Key header is required.');
  return requireIdempotencyKey(value);
}

export function createFieldnoteServer({config, storage, clock, logger = console, metrics = new Metrics()}) {
  const service = new InspectionService({storage, clock, metrics});
  return createServer(async (request, response) => {
    const startedAt = performance.now();
    const id = requestId(request);
    let route = 'unmatched';
    try {
      setCors(request, response, config);
      if (request.method === 'OPTIONS') {
        route = 'preflight';
        response.statusCode = 204;
        response.setHeader('X-Request-Id', id);
        response.end();
        return;
      }

      const url = new URL(request.url ?? '/', 'http://fieldnote.local');
      if (request.method === 'GET' && (url.pathname === '/health' || url.pathname === '/healthz')) {
        route = '/healthz';
        writeJson(response, 200, {
          status: 'ok',
          version: config.buildVersion,
          storage: config.dataFile ? 'file' : 'in-memory',
          serverTimestamp: new Date().toISOString(),
        }, id);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/metrics') {
        route = '/metrics';
        writeText(response, 200, metrics.render(), 'text/plain; version=0.0.4; charset=utf-8', id);
        return;
      }

      const identity = authenticate(request.headers.authorization, config.identities);
      let values;

      values = match(url.pathname, /^\/v1\/projects\/([^/]+)\/inspections$/);
      if (values && request.method === 'GET') {
        route = '/v1/projects/:projectId/inspections';
        const projectId = requireProjectId(values[0]);
        writeJson(response, 200, {data: await service.list(identity, projectId)}, id);
        return;
      }
      if (values && request.method === 'POST') {
        route = '/v1/projects/:projectId/inspections';
        const projectId = requireProjectId(values[0]);
        const body = await readJson(request, config.bodyLimitBytes);
        const result = await service.applyOperation(identity, projectId, toOperation({
          kind: 'create', body, idempotencyKey: idempotencyHeader(request),
        }));
        writeJson(response, result.httpStatus, result.body, id);
        return;
      }

      values = match(url.pathname, /^\/v1\/projects\/([^/]+)\/inspections\/export$/);
      if (values && request.method === 'GET') {
        route = '/v1/projects/:projectId/inspections/export';
        const projectId = requireProjectId(values[0]);
        const csv = await service.exportCsv(identity, projectId);
        writeText(response, 200, csv, 'text/csv; charset=utf-8', id, {
          'Content-Disposition': `attachment; filename="fieldnote-${projectId}-inspections.csv"`,
        });
        return;
      }

      values = match(url.pathname, /^\/v1\/projects\/([^/]+)\/inspections\/([^/]+)\/audit$/);
      if (values && request.method === 'GET') {
        route = '/v1/projects/:projectId/inspections/:inspectionId/audit';
        writeJson(response, 200, {data: await service.audit(identity, values[0], values[1])}, id);
        return;
      }

      values = match(url.pathname, /^\/v1\/projects\/([^/]+)\/inspections\/([^/]+)\/transitions$/);
      if (values && request.method === 'POST') {
        route = '/v1/projects/:projectId/inspections/:inspectionId/transitions';
        const body = await readJson(request, config.bodyLimitBytes);
        const result = await service.applyOperation(identity, values[0], toOperation({
          kind: 'transition', inspectionId: values[1], body, idempotencyKey: idempotencyHeader(request),
        }));
        writeJson(response, result.httpStatus, result.body, id);
        return;
      }

      values = match(url.pathname, /^\/v1\/projects\/([^/]+)\/inspections\/([^/]+)$/);
      if (values && request.method === 'GET') {
        route = '/v1/projects/:projectId/inspections/:inspectionId';
        writeJson(response, 200, {data: await service.get(identity, values[0], values[1])}, id);
        return;
      }
      if (values && (request.method === 'PATCH' || request.method === 'DELETE')) {
        route = '/v1/projects/:projectId/inspections/:inspectionId';
        const body = await readJson(request, config.bodyLimitBytes);
        const result = await service.applyOperation(identity, values[0], toOperation({
          kind: request.method === 'PATCH' ? 'update' : 'delete',
          inspectionId: values[1],
          body,
          idempotencyKey: idempotencyHeader(request),
        }));
        writeJson(response, result.httpStatus, result.body, id);
        return;
      }

      values = match(url.pathname, /^\/v1\/projects\/([^/]+)\/sync\/batch$/);
      if (values && request.method === 'POST') {
        route = '/v1/projects/:projectId/sync/batch';
        const projectId = requireProjectId(values[0]);
        const body = requireObject(await readJson(request, config.bodyLimitBytes));
        if (!Array.isArray(body.operations) || body.operations.length < 1 || body.operations.length > 100) {
          throw new DomainError(422, 'VALIDATION_ERROR', 'operations must contain from 1 to 100 operations.');
        }
        const results = [];
        for (const operation of body.operations) {
          try {
            const result = await service.applyOperation(identity, projectId, operation);
            results.push(result.body);
          } catch (error) {
            const payload = errorPayload(error);
            results.push({
              operationId: typeof operation?.operationId === 'string' ? operation.operationId : null,
              idempotencyKey: typeof operation?.idempotencyKey === 'string' ? operation.idempotencyKey : null,
              status: error instanceof DomainError && error.status === 409 ? 'conflict' : 'rejected',
              projectId,
              error: payload,
            });
          }
        }
        writeJson(response, 200, {results}, id);
        return;
      }

      throw new DomainError(404, 'ROUTE_NOT_FOUND', 'No API route matches this request.');
    } catch (error) {
      const normalized = error instanceof DomainError ? error : new DomainError(500, 'INTERNAL_ERROR', 'An unexpected server error occurred.');
      if (normalized.status === 401) response.setHeader('WWW-Authenticate', 'Bearer realm="fieldnote"');
      if (normalized.status >= 500) logger.error(JSON.stringify({
        level: 'error', event: 'request_failed', requestId: id, method: request.method, route, code: normalized.code,
      }));
      if (!response.headersSent) writeJson(response, normalized.status, {error: errorPayload(normalized), requestId: id}, id);
      else response.destroy();
    } finally {
      metrics.request(request.method ?? 'UNKNOWN', route, response.statusCode, performance.now() - startedAt);
    }
  });
}
