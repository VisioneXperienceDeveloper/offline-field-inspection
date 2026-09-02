export type UserRole = 'Inspector' | 'Reviewer' | 'Admin';
export type ProjectPermission = 'read' | 'write' | 'export' | 'approve';

export interface ProjectPermissions {
  read: boolean;
  write: boolean;
  export: boolean;
  approve: boolean;
}

export interface FieldnoteIdentity {
  id: string;
  name: string;
  role: UserRole;
  memberships: Readonly<Record<string, Readonly<ProjectPermissions>>>;
}

export interface DemoIdentity extends FieldnoteIdentity {
  token: string;
}
