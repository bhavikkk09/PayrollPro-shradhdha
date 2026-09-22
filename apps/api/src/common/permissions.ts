// Single source of truth for permission keys and the default role matrix.
// Seeded into the DB; the DB (roles/permissions tables) is authoritative at runtime.
export const PERMISSIONS = [
  'company.view', 'company.create', 'company.edit', 'company.delete',
  'branch.manage', 'employee.view', 'employee.create', 'employee.edit', 'employee.delete', 'employee.sensitive',
  'salary.view', 'salary.manage', 'attendance.view', 'attendance.manage',
  'leave.view', 'leave.manage', 'leave.approve',
  'payroll.view', 'payroll.process', 'payroll.approve', 'payroll.lock', 'payroll.unlock',
  'compliance.view', 'compliance.manage', 'compliance.config',
  'reports.view', 'reports.export', 'documents.view', 'documents.manage',
  'users.manage', 'settings.manage', 'audit.view', 'dashboard.view',
] as const;
export type PermissionKey = (typeof PERMISSIONS)[number];

const ALL: PermissionKey[] = [...PERMISSIONS];
const VIEW = ALL.filter((p) => p.endsWith('.view'));

export const ROLE_MATRIX: Record<string, { name: string; permissions: PermissionKey[] }> = {
  SUPER_ADMIN: { name: 'Super Admin', permissions: ALL },
  CONSULTANT_ADMIN: { name: 'Consultant Admin', permissions: ALL },
  CONSULTANT_STAFF: {
    name: 'Consultant Staff',
    permissions: ALL.filter(
      (p) => !['company.delete', 'users.manage', 'settings.manage', 'payroll.unlock', 'compliance.config', 'employee.delete', 'employee.sensitive', 'audit.view'].includes(p),
    ),
  },
  CLIENT_ADMIN: {
    name: 'Client Admin',
    permissions: ['company.view', 'employee.view', 'attendance.view', 'attendance.manage', 'payroll.view', 'reports.view', 'reports.export', 'documents.view', 'documents.manage', 'compliance.view', 'dashboard.view'],
  },
  CLIENT_HR: {
    name: 'Client HR/User',
    permissions: ['company.view', 'employee.view', 'employee.create', 'employee.edit', 'attendance.view', 'attendance.manage', 'leave.view', 'leave.manage', 'documents.view', 'dashboard.view'],
  },
  PAYROLL_OPERATOR: {
    name: 'Payroll Operator',
    permissions: ['company.view', 'employee.view', 'salary.view', 'salary.manage', 'attendance.view', 'attendance.manage', 'leave.view', 'payroll.view', 'payroll.process', 'reports.view', 'reports.export', 'dashboard.view'],
  },
  COMPLIANCE_OPERATOR: {
    name: 'Compliance Operator',
    permissions: ['company.view', 'employee.view', 'compliance.view', 'compliance.manage', 'reports.view', 'reports.export', 'documents.view', 'documents.manage', 'dashboard.view'],
  },
  READ_ONLY: { name: 'Read Only User', permissions: VIEW },
};
