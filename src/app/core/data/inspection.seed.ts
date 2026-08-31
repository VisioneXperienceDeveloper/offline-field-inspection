import {AuditEvent, ChecklistItem, Inspection, InspectionTemplate, Project} from '../models/inspection.models';

const audit = (action: string, occurredAt: string, detail?: string): AuditEvent => ({
  id: crypto.randomUUID(), action, actor: 'Henry Kim', occurredAt, detail,
});

const SAFETY_CHECKLIST: ChecklistItem[] = [
  {id: 1, title: 'Are access routes and emergency exits clear?', answer: 'pass', note: '', required: true},
  {id: 2, title: 'Are temporary guardrails and fall protection secure?', answer: 'fail', note: 'Loose clamp found on the west guardrail. Repair required before the next shift.', required: true},
  {id: 3, title: 'Has the pre-start risk assessment been completed?', answer: 'pass', note: '', required: true},
  {id: 4, title: 'Are fire extinguishers and emergency equipment accessible?', answer: null, note: '', required: true},
  {id: 5, title: 'Is task lighting adequate across the work area?', answer: null, note: '', required: true},
];

const seed = (partial: Partial<Inspection> & Pick<Inspection, 'id' | 'title' | 'status'>): Inspection => ({
  templateId: 'tpl-safety-weekly',
  templateName: 'Weekly Safety Inspection',
  projectId: 'project-c3',
  projectName: 'Sydney Metro · C3',
  zone: 'Tunnel excavation C3-2',
  inspector: 'Henry Kim',
  syncStatus: 'synced',
  updatedAt: 'Today, 10:42',
  inspectionDate: '2026-08-30',
  weather: 'Clear',
  requiresPhotos: false,
  photos: [],
  checklist: structuredClone(SAFETY_CHECKLIST),
  auditTrail: [audit('Created the inspection', '10:12'), audit('Completed site details', '10:13')],
  ...partial,
});

export const PROJECTS: Project[] = [
  {id: 'project-c3', name: 'Sydney Metro · C3'},
  {id: 'project-p2', name: 'Western Harbour · P2'},
  {id: 'project-north', name: 'North Link · Package 4'},
];

export const INSPECTION_TEMPLATES: InspectionTemplate[] = [
  {id: 'tpl-safety-weekly', name: 'Weekly Safety Inspection', category: 'Safety', description: 'A structured weekly review of access, controls and emergency readiness.', checklist: SAFETY_CHECKLIST.map(({id, title, required}) => ({id, title, required})), requiresPhotos: true, approvalSteps: 1, active: true},
  {id: 'tpl-concrete-prepour', name: 'Pre-pour Concrete Inspection', category: 'Quality', description: 'Verify reinforcement, formwork and hold points before a concrete pour.', checklist: [
    {id: 1, title: 'Are approved drawings available at the work face?', required: true},
    {id: 2, title: 'Are reinforcement size and spacing compliant?', required: true},
    {id: 3, title: 'Is formwork clean, secure and dimensionally correct?', required: true},
    {id: 4, title: 'Have all embedded items been checked?', required: true},
  ], requiresPhotos: true, approvalSteps: 1, active: true},
  {id: 'tpl-equipment-daily', name: 'Daily Equipment Check', category: 'Equipment', description: 'Daily pre-start equipment condition and safety controls check.', checklist: [
    {id: 1, title: 'Are guards and emergency stops operational?', required: true},
    {id: 2, title: 'Are fluid levels and tyres within limits?', required: true},
    {id: 3, title: 'Are warning devices and lights operational?', required: true},
  ], requiresPhotos: false, approvalSteps: 1, active: true},
  {id: 'tpl-environment', name: 'Environmental Site Walk', category: 'Environment', description: 'Inspect erosion, dust, noise and waste controls.', checklist: [
    {id: 1, title: 'Are erosion and sediment controls effective?', required: true},
    {id: 2, title: 'Are waste streams correctly segregated?', required: true},
    {id: 3, title: 'Are dust and noise controls in place?', required: true},
  ], requiresPhotos: true, approvalSteps: 1, active: true},
];

export const SEED_INSPECTIONS: Inspection[] = [
  seed({id: 'INSP-2026-0084', title: 'Weekly Safety Inspection', status: 'Draft', syncStatus: 'pending', requiresPhotos: true, photos: [
    {id: 'photo-1', name: 'West guardrail clamp', source: 'assets/inspection-railing.png', capturedAt: '10:36', location: 'GPS captured'},
    {id: 'photo-2', name: 'Tunnel access walkway', source: 'assets/inspection-tunnel.png', capturedAt: '10:37', location: 'GPS captured'},
  ], auditTrail: [audit('Created the inspection', '10:12'), audit('Completed site details', '10:13'), audit('Updated three checklist responses', '10:42', 'Work area safety')]}),
  seed({id: 'INSP-2026-0083', title: 'Pre-pour Concrete Inspection', status: 'Draft', templateId: 'tpl-concrete-prepour', templateName: 'Pre-pour Concrete Inspection', zone: 'Platform section A', inspector: 'Olivia Lee', updatedAt: 'Today, 09:48', weather: 'Cloudy', syncStatus: 'pending', requiresPhotos: true, photos: [], auditTrail: [audit('Created the inspection', '09:48')]}),
  seed({id: 'INSP-2026-0082', title: 'Excavation Quality Inspection', status: 'Submitted', templateName: 'Quality Inspection', zone: 'Underground excavation', inspector: 'Jack Park', updatedAt: 'Yesterday, 16:32', auditTrail: [audit('Submitted for approval', 'Yesterday, 16:32')]}),
  seed({id: 'INSP-2026-0081', title: 'Daily Equipment Check', status: 'Submitted', templateId: 'tpl-equipment-daily', templateName: 'Daily Equipment Check', zone: 'Equipment laydown', inspector: 'Sophie Choi', updatedAt: 'Yesterday, 14:05', auditTrail: [audit('Submitted for approval', 'Yesterday, 14:05')]}),
  seed({id: 'INSP-2026-0080', title: 'Electrical Insulation Test', status: 'Approved', templateName: 'Electrical Inspection', zone: 'Electrical room L1', inspector: 'Olivia Lee', updatedAt: 'Aug 28, 11:22', auditTrail: [audit('Approved the inspection', 'Aug 28, 11:22')]}),
  seed({id: 'INSP-2026-0079', title: 'Fire Safety Inspection', status: 'Approved', templateName: 'Fire Safety', zone: 'Office and amenities', updatedAt: 'Aug 27, 17:40', weather: 'Rain', auditTrail: [audit('Approved the inspection', 'Aug 27, 17:40')]}),
  seed({id: 'INSP-2026-0078', title: 'Temporary Fence Inspection', status: 'Draft', zone: 'Site perimeter', inspector: 'Jack Park', updatedAt: 'Aug 27, 10:12', auditTrail: [audit('Saved a draft', 'Aug 27, 10:12')]}),
  seed({id: 'INSP-2026-0077', title: 'Concrete Strength Verification', status: 'Approved', templateName: 'Quality ITP', zone: 'Structure zone 2', inspector: 'Sophie Choi', updatedAt: 'Aug 26, 15:33', auditTrail: [audit('Approved the inspection', 'Aug 26, 15:33')]}),
];
