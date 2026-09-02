export type OutboxOperationKind = 'create' | 'update' | 'transition' | 'delete';

/**
 * A durable mutation captured at the moment a local change is made.
 *
 * `identityId` deliberately travels with the operation. A later demo-session
 * switch must not change the server actor that originally made an offline edit.
 */
export interface OutboxOperation {
  operationId: string;
  idempotencyKey: string;
  kind: OutboxOperationKind;
  identityId: string;
  projectId: string;
  inspectionId: string;
  baseRevision: number;
  payload: Readonly<Record<string, unknown>>;
  createdAt: string;
  attempts: number;
  lastAttemptAt: string | null;
  lastError: string | null;
}

export type EnqueueOutboxOperation = Omit<
  OutboxOperation,
  'attempts' | 'lastAttemptAt' | 'lastError'
> & Partial<Pick<OutboxOperation, 'attempts' | 'lastAttemptAt' | 'lastError'>>;

/** The exact operation shape accepted by the companion backend batch API. */
export type SyncBatchOperation = Pick<
  OutboxOperation,
  'operationId' | 'idempotencyKey' | 'kind' | 'inspectionId' | 'baseRevision' | 'payload'
>;

export interface SyncServerError {
  code: string;
  message: string;
  details?: unknown;
}

interface SyncResultBase {
  operationId: string;
  idempotencyKey: string;
  projectId: string;
  inspectionId: string;
  serverTimestamp?: string;
}

export interface SyncAcknowledgedResult extends SyncResultBase {
  status: 'acked';
  revision: number;
  serverTimestamp: string;
  inspection: Readonly<Record<string, unknown>>;
  deleted?: boolean;
}

export interface SyncConflictResult extends SyncResultBase {
  status: 'conflict';
  error: SyncServerError;
}

export interface SyncRejectedResult extends SyncResultBase {
  status: 'rejected';
  error: SyncServerError;
}

export type SyncOperationResult =
  | SyncAcknowledgedResult
  | SyncConflictResult
  | SyncRejectedResult;

export interface SyncBatchResult {
  results: SyncOperationResult[];
}

export interface SyncPushOptions {
  /** Overrides the current AuthService token so queued operations retain their original actor. */
  token?: string;
  timeoutMs?: number;
}

export interface RemoteChecklistItem {
  id: number;
  title: string;
  answer: 'pass' | 'fail' | 'na' | null;
  note: string;
  required: boolean;
}

export interface RemotePhotoMetadata {
  id: string;
  name: string;
  capturedAt: string;
  location: string;
  checksum?: string;
  uploadId?: string;
}

/** A validated server record used only for explicit conflict recovery. */
export interface RemoteInspectionSnapshot {
  id: string;
  projectId: string;
  title: string;
  templateId: string;
  templateName: string;
  zone: string;
  inspectionDate: string;
  weather: string;
  requiresPhotos: boolean;
  photos: RemotePhotoMetadata[];
  checklist: RemoteChecklistItem[];
  status: 'Draft' | 'Submitted' | 'Approved';
  createdBy: string;
  approvedBy: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
