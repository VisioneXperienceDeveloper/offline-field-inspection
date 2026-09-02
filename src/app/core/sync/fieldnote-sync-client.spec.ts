import {TestBed} from '@angular/core/testing';
import {AuthService} from '../auth/auth.service';
import {
  FIELDNOTE_API_BASE_URL,
  FieldnoteSyncClient,
  SyncHttpError,
  SyncInvalidResponseError,
  SyncNetworkError,
  SyncTimeoutError,
  SyncValidationError,
} from './fieldnote-sync-client';
import {OutboxOperation} from './sync.models';

function operation(operationId = 'op-001', overrides: Partial<OutboxOperation> = {}): OutboxOperation {
  return {
    operationId,
    idempotencyKey: `idem-${operationId}`,
    kind: 'create',
    identityId: 'demo-inspector',
    projectId: 'project-c3',
    inspectionId: 'INSP-100',
    baseRevision: 0,
    payload: {id: 'INSP-100', title: 'Safety inspection'},
    createdAt: '2026-09-02T01:00:00.000Z',
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
    ...overrides,
  };
}

function ack(operationId = 'op-001', overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operationId,
    idempotencyKey: `idem-${operationId}`,
    status: 'acked',
    projectId: 'project-c3',
    inspectionId: 'INSP-100',
    revision: 1,
    serverTimestamp: '2026-09-02T01:00:01.000Z',
    inspection: {id: 'INSP-100', revision: 1},
    ...overrides,
  };
}

function remoteInspection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'INSP-100',
    projectId: 'project-c3',
    title: 'Remote safety inspection',
    templateId: 'tpl-safety',
    templateName: 'Safety inspection',
    zone: 'North access',
    inspectionDate: '2026-09-02',
    weather: 'Rain',
    requiresPhotos: true,
    photos: [{
      id: 'photo-1',
      name: 'Guardrail',
      capturedAt: '2026-09-02T01:00:00.000Z',
      location: 'North access',
      checksum: 'abc123',
    }],
    checklist: [{id: 1, title: 'Guardrail secure?', answer: 'pass', note: '', required: true}],
    status: 'Submitted',
    createdBy: 'demo-inspector',
    approvedBy: null,
    revision: 3,
    createdAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T01:30:00.000Z',
    ...overrides,
  };
}

function response(body: unknown, options: {ok?: boolean; status?: number} = {}): Response {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    text: vi.fn().mockResolvedValue(typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

describe('FieldnoteSyncClient', () => {
  const auth = {bearerToken: vi.fn(() => 'current-session-token')};

  beforeEach(() => {
    auth.bearerToken.mockClear();
    TestBed.configureTestingModule({
      providers: [
        FieldnoteSyncClient,
        {provide: AuthService, useValue: auth},
        {provide: FIELDNOTE_API_BASE_URL, useValue: 'https://fieldnote.example/api/'},
      ],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('posts the backend batch contract and strips local-only outbox metadata', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({results: [ack()]}));
    vi.stubGlobal('fetch', fetchMock);
    const client = TestBed.inject(FieldnoteSyncClient);

    const result = await client.push('project-c3', [operation()]);

    expect(result.results[0]).toMatchObject({status: 'acked', revision: 1});
    expect(auth.bearerToken).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://fieldnote.example/api/v1/projects/project-c3/sync/batch');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      Accept: 'application/json',
      Authorization: 'Bearer current-session-token',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(init.body))).toEqual({
      operations: [{
        operationId: 'op-001',
        idempotencyKey: 'idem-op-001',
        kind: 'create',
        inspectionId: 'INSP-100',
        baseRevision: 0,
        payload: {id: 'INSP-100', title: 'Safety inspection'},
      }],
    });
  });

  it('uses an explicit token override without consulting the current session', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({results: [ack()]}));
    vi.stubGlobal('fetch', fetchMock);
    const client = TestBed.inject(FieldnoteSyncClient);

    await client.push('project-c3', [operation()], {token: 'original-actor-token'});

    expect(auth.bearerToken).not.toHaveBeenCalled();
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({Authorization: 'Bearer original-actor-token'});
  });

  it('loads and validates the exact server inspection selected for conflict recovery', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({data: remoteInspection()}));
    vi.stubGlobal('fetch', fetchMock);

    const result = await TestBed.inject(FieldnoteSyncClient).fetchInspection('project-c3', 'INSP-100');

    expect(result).toMatchObject({
      id: 'INSP-100',
      projectId: 'project-c3',
      status: 'Submitted',
      revision: 3,
      photos: [expect.objectContaining({checksum: 'abc123'})],
      checklist: [expect.objectContaining({answer: 'pass'})],
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://fieldnote.example/api/v1/projects/project-c3/inspections/INSP-100');
    expect(init).toMatchObject({
      method: 'GET',
      headers: {Accept: 'application/json', Authorization: 'Bearer current-session-token'},
    });
  });

  it('accepts every valid optional remote snapshot variant without inventing metadata', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({data: remoteInspection({
      status: 'Approved',
      approvedBy: 'demo-reviewer',
      requiresPhotos: false,
      checklist: [{id: 1, title: 'Guardrail secure?', answer: 'na', note: '', required: false}],
      photos: [{
        id: 'photo-1',
        name: 'Guardrail',
        capturedAt: '2026-09-02T01:00:00.000Z',
        location: '',
        uploadId: 'upload-1',
      }],
    })})));

    const result = await TestBed.inject(FieldnoteSyncClient).fetchInspection('project-c3', 'INSP-100');

    expect(result).toMatchObject({
      status: 'Approved',
      approvedBy: 'demo-reviewer',
      requiresPhotos: false,
      checklist: [expect.objectContaining({answer: 'na', required: false})],
      photos: [expect.objectContaining({uploadId: 'upload-1'})],
    });
    expect(result.photos[0]).not.toHaveProperty('checksum');
  });

  it.each([
    [{}, 'data object'],
    [{data: remoteInspection({id: 'INSP-OTHER'})}, 'does not match'],
    [{data: remoteInspection({status: 'Archived'})}, 'data.status'],
    [{data: remoteInspection({revision: 0})}, 'data.revision'],
    [{data: remoteInspection({requiresPhotos: 'yes'})}, 'requiresPhotos'],
    [{data: remoteInspection({checklist: {}})}, 'must be arrays'],
    [{data: remoteInspection({photos: {}})}, 'must be arrays'],
    [{data: remoteInspection({approvedBy: ''})}, 'approvedBy'],
    [{data: remoteInspection({approvedBy: 42})}, 'approvedBy'],
    [{data: remoteInspection({title: 42})}, 'data.title'],
    [{data: remoteInspection({createdAt: 'yesterday'})}, 'ISO timestamp'],
    [{data: remoteInspection({checklist: [null]})}, 'must be an object'],
    [{data: remoteInspection({checklist: [{id: 'one', title: 'Bad', answer: null, note: '', required: true}]})}, 'id must be an integer'],
    [{data: remoteInspection({checklist: [{id: 1, title: 'Bad', answer: 'unknown', note: '', required: true}]})}, 'answer is invalid'],
    [{data: remoteInspection({checklist: [{id: 1, title: 'Bad', answer: null, note: '', required: 'yes'}]})}, 'required must be a boolean'],
    [{data: remoteInspection({photos: [null]})}, 'must be an object'],
    [{data: remoteInspection({photos: [{id: 'photo-1', name: 'Bad', capturedAt: '', location: '', checksum: ''}]})}, 'checksum'],
    [{data: remoteInspection({photos: [{id: 'photo-1', name: 'Bad', capturedAt: '', location: '', uploadId: ''}]})}, 'uploadId'],
  ])('rejects malformed conflict-recovery inspection responses (%s)', async (body, message) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(body)));

    await expect(TestBed.inject(FieldnoteSyncClient).fetchInspection('project-c3', 'INSP-100'))
      .rejects.toThrow(String(message));
  });

  it('validates conflict-recovery ids and preserves typed HTTP errors', async () => {
    const client = TestBed.inject(FieldnoteSyncClient);
    await expect(client.fetchInspection('project-c3', '')).rejects.toBeInstanceOf(SyncValidationError);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      error: {code: 'INSPECTION_NOT_FOUND', message: 'Missing.'},
    }, {ok: false, status: 404})));
    await expect(client.fetchInspection('project-c3', 'INSP-100')).rejects.toMatchObject({
      kind: 'http',
      status: 404,
      serverError: {code: 'INSPECTION_NOT_FOUND'},
    });
  });

  it('types acknowledged, conflict, and rejected results', async () => {
    const operations = [
      operation('op-ack'),
      operation('op-conflict', {idempotencyKey: 'idem-op-conflict'}),
      operation('op-rejected', {idempotencyKey: 'idem-op-rejected'}),
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      results: [
        ack('op-ack', {idempotencyKey: 'idem-op-ack'}),
        {
          operationId: 'op-conflict',
          idempotencyKey: 'idem-op-conflict',
          status: 'conflict',
          projectId: 'project-c3',
          inspectionId: 'INSP-100',
          serverTimestamp: '2026-09-02T01:00:01.000Z',
          error: {
            code: 'REVISION_CONFLICT',
            message: 'Revision changed.',
            details: {expectedRevision: 1, currentRevision: 2},
          },
        },
        {
          operationId: 'op-rejected',
          idempotencyKey: 'idem-op-rejected',
          status: 'rejected',
          projectId: 'project-c3',
          inspectionId: 'INSP-100',
          error: {code: 'PERMISSION_DENIED', message: 'Not allowed.'},
        },
      ],
    })));

    const result = await TestBed.inject(FieldnoteSyncClient).push('project-c3', operations);

    expect(result.results.map(item => item.status)).toEqual(['acked', 'conflict', 'rejected']);
    expect(result.results[1]).toMatchObject({
      status: 'conflict',
      error: {code: 'REVISION_CONFLICT', details: {currentRevision: 2}},
    });
    expect(result.results[2]).toMatchObject({
      status: 'rejected',
      error: {code: 'PERMISSION_DENIED'},
    });
  });

  it('preserves the optional delete acknowledgement flag', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      results: [ack('op-delete', {
        idempotencyKey: 'idem-op-delete',
        deleted: true,
      })],
    })));

    const result = await TestBed.inject(FieldnoteSyncClient).push('project-c3', [
      operation('op-delete', {idempotencyKey: 'idem-op-delete', kind: 'delete'}),
    ]);

    expect(result.results[0]).toMatchObject({status: 'acked', deleted: true});
  });

  it('returns a typed HTTP error with the server error body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      error: {
        code: 'AUTH_REQUIRED',
        message: 'A Bearer token is required.',
        details: {reason: 'expired'},
      },
      requestId: 'req-1',
    }, {ok: false, status: 401})));

    const promise = TestBed.inject(FieldnoteSyncClient).push('project-c3', [operation()]);

    await expect(promise).rejects.toMatchObject({
      name: 'SyncHttpError',
      kind: 'http',
      status: 401,
      serverError: {code: 'AUTH_REQUIRED', details: {reason: 'expired'}},
    });
    await expect(promise).rejects.toBeInstanceOf(SyncHttpError);
  });

  it('keeps non-JSON HTTP failures typed as HTTP errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response('Gateway unavailable', {
      ok: false,
      status: 503,
    })));

    await expect(TestBed.inject(FieldnoteSyncClient).push('project-c3', [operation()]))
      .rejects.toMatchObject({kind: 'http', status: 503, serverError: null});
  });

  it('wraps fetch and response-stream failures as typed network errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(TestBed.inject(FieldnoteSyncClient).push('project-c3', [operation()]))
      .rejects.toBeInstanceOf(SyncNetworkError);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockRejectedValue(new TypeError('Socket closed')),
    } as unknown as Response));
    await expect(TestBed.inject(FieldnoteSyncClient).push('project-c3', [operation()]))
      .rejects.toMatchObject({kind: 'network', message: 'The sync response could not be read.'});
  });

  it('aborts requests at the configured timeout and reports a typed timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })));
    const promise = TestBed.inject(FieldnoteSyncClient)
      .push('project-c3', [operation()], {timeoutMs: 25})
      .catch(error => error as Error);

    await vi.advanceTimersByTimeAsync(25);

    await expect(promise).resolves.toBeInstanceOf(SyncTimeoutError);
    await expect(promise).resolves.toMatchObject({kind: 'timeout', timeoutMs: 25});
  });

  it.each([
    ['not-json', 'invalid JSON'],
    [JSON.stringify({data: []}), 'results array'],
    [JSON.stringify({results: []}), 'result count'],
    [JSON.stringify({results: [null]}), 'must be an object'],
    [JSON.stringify({results: [ack('op-001', {operationId: 42})]}), 'operationId'],
    [JSON.stringify({results: [ack('op-001', {idempotencyKey: ''})]}), 'idempotencyKey'],
    [JSON.stringify({results: [ack('another-operation')]}), 'does not match'],
    [JSON.stringify({results: [ack('op-001', {idempotencyKey: 'different'})]}), 'does not match'],
    [JSON.stringify({results: [ack('op-001', {projectId: 'project-p2'})]}), 'does not match'],
    [JSON.stringify({results: [ack('op-001', {inspectionId: 'INSP-OTHER'})]}), 'does not match'],
    [JSON.stringify({results: [ack('op-001', {status: 'maybe'})]}), 'status'],
    [JSON.stringify({results: [ack('op-001', {revision: 0})]}), 'revision'],
    [JSON.stringify({results: [ack('op-001', {inspection: null})]}), 'inspection'],
    [JSON.stringify({results: [ack('op-001', {serverTimestamp: undefined})]}), 'serverTimestamp'],
    [JSON.stringify({results: [ack('op-001', {deleted: 'yes'})]}), 'deleted'],
    [JSON.stringify({results: [{...ack('op-001'), status: 'rejected', error: null}]}), 'error object'],
    [JSON.stringify({results: [{...ack('op-001'), status: 'rejected', error: {code: '', message: 'No'}}]}), 'error.code'],
    [JSON.stringify({results: [{...ack('op-001'), status: 'rejected', error: {code: 'NO', message: ''}}]}), 'error.message'],
  ])('rejects invalid successful responses (%s)', async (body, message) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(body)));

    const promise = TestBed.inject(FieldnoteSyncClient).push('project-c3', [operation()]);

    await expect(promise).rejects.toBeInstanceOf(SyncInvalidResponseError);
    await expect(promise).rejects.toThrow(String(message));
  });

  it.each([
    ['', [operation()], {}, 'projectId'],
    ['project-c3', [], {}, '1 to 100'],
    ['project-c3', [operation('op-wrong', {projectId: 'project-p2'})], {}, 'belongs to'],
    ['project-c3', [operation('op-no-id', {operationId: ''})], {}, 'requires'],
    ['project-c3', [operation('op-revision', {baseRevision: -1})], {}, 'baseRevision'],
    ['project-c3', [operation()], {token: ''}, 'Bearer token'],
    ['project-c3', [operation()], {timeoutMs: 0}, 'timeoutMs'],
  ])('rejects invalid requests before calling fetch (%s)', async (projectId, operations, options, message) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const promise = TestBed.inject(FieldnoteSyncClient).push(projectId, operations, options);

    await expect(promise).rejects.toBeInstanceOf(SyncValidationError);
    await expect(promise).rejects.toThrow(String(message));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('encodes project ids as a single URL path segment', async () => {
    const projectId = 'project / special';
    const fetchMock = vi.fn().mockResolvedValue(response({
      results: [ack('op-encoded', {
        idempotencyKey: 'idem-op-encoded',
        projectId,
      })],
    }));
    vi.stubGlobal('fetch', fetchMock);

    await TestBed.inject(FieldnoteSyncClient).push(projectId, [operation('op-encoded', {
      idempotencyKey: 'idem-op-encoded',
      projectId,
    })]);

    expect(fetchMock.mock.calls[0]?.[0]).toContain('/projects/project%20%2F%20special/sync/batch');
  });

  it.each([
    ['   ', 'non-empty URL'],
    ['ftp://fieldnote.example', 'invalid'],
  ])('rejects unsafe API base URLs (%s)', (baseUrl, message) => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({providers: [
      FieldnoteSyncClient,
      {provide: AuthService, useValue: auth},
      {provide: FIELDNOTE_API_BASE_URL, useValue: baseUrl},
    ]});

    expect(() => TestBed.inject(FieldnoteSyncClient)).toThrow(String(message));
  });
});
