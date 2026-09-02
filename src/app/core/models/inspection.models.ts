export type InspectionStatus = 'Draft' | 'Submitted' | 'Approved';
export type SyncStatus = 'synced' | 'pending' | 'syncing' | 'failed' | 'conflicted';
export type LocalSaveStatus = 'saving' | 'saved' | 'failed';
export type InspectionAnswer = 'pass' | 'fail' | 'na' | null;

export interface ChecklistItem {
  id: number;
  title: string;
  answer: InspectionAnswer;
  note: string;
  required: boolean;
}

export interface AuditEvent {
  id: string;
  action: string;
  actor: string;
  occurredAt: string;
  detail?: string;
}

export interface Inspection {
  id: string;
  title: string;
  templateId: string;
  templateName: string;
  templateVersion: number;
  templatePublishedAt: string | null;
  templateSnapshotAt: string | null;
  projectId: string;
  projectName: string;
  zone: string;
  inspector: string;
  createdBy: string;
  approvedBy: string | null;
  status: InspectionStatus;
  localSaveStatus: LocalSaveStatus;
  localRevision: number;
  syncStatus: SyncStatus;
  serverRevision: number | null;
  lastServerAckAt: string | null;
  updatedAt: string;
  inspectionDate: string;
  weather: string;
  requiresPhotos: boolean;
  photos: InspectionPhoto[];
  checklist: ChecklistItem[];
  auditTrail: AuditEvent[];
}

export interface InspectionPhoto {
  id: string;
  name: string;
  source: string;
  storageKey: string | null;
  mimeType: string;
  byteSize: number;
  checksum: string | null;
  capturedAt: string;
  location: string;
}

export interface InspectionTemplate {
  id: string;
  name: string;
  category: 'Safety' | 'Quality' | 'Equipment' | 'Environment';
  description: string;
  checklist: Array<Pick<ChecklistItem, 'id' | 'title' | 'required'>>;
  requiresPhotos: boolean;
  approvalSteps: number;
  active: boolean;
}

export interface Project {
  id: string;
  name: string;
}

export interface InspectionFilters {
  query: string;
  status: 'All' | InspectionStatus;
  sort: 'updated-desc' | 'updated-asc' | 'title';
}
