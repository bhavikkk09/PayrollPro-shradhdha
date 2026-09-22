import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { NotFoundException } from '@nestjs/common';
import { AuthUser } from '../common/auth.types';
import { NotificationsService } from './notifications.service';

// ── in-memory database ──
interface U { id: string; type: 'CONSULTANT' | 'CLIENT'; consultantId: string | null; active: boolean; roleKeys: string[]; companyIds: string[] }
const users: U[] = [
  { id: 'admin1', type: 'CONSULTANT', consultantId: 'C1', active: true, roleKeys: ['CONSULTANT_ADMIN'], companyIds: [] }, // firm admin: sees every company of C1
  { id: 'staffA', type: 'CONSULTANT', consultantId: 'C1', active: true, roleKeys: ['CONSULTANT_STAFF'], companyIds: ['A'] },
  { id: 'staffOther', type: 'CONSULTANT', consultantId: 'C1', active: true, roleKeys: ['CONSULTANT_STAFF'], companyIds: ['X'] }, // not linked to A
  { id: 'inactiveA', type: 'CONSULTANT', consultantId: 'C1', active: false, roleKeys: ['CONSULTANT_STAFF'], companyIds: ['A'] },
  { id: 'clientAdminA', type: 'CLIENT', consultantId: null, active: true, roleKeys: ['CLIENT_ADMIN'], companyIds: ['A'] },
  { id: 'clientHrA', type: 'CLIENT', consultantId: null, active: true, roleKeys: ['CLIENT_HR'], companyIds: ['A'] },
];
const companies: Record<string, { id: string; consultantId: string; status: string; deletedAt: null; settings: { attendanceEnabled: boolean } | null }> = {
  A: { id: 'A', consultantId: 'C1', status: 'ACTIVE', deletedAt: null, settings: { attendanceEnabled: true } },
  X: { id: 'X', consultantId: 'C1', status: 'ACTIVE', deletedAt: null, settings: { attendanceEnabled: false } },
};
const activeEmployees = new Set(['A', 'X']); // companies with at least one active employee
let notifications: any[] = [];
let seq = 0;
const complianceTasks: any[] = [];
const cdocs: any[] = [];
const edocs: any[] = [];
const attSummaries: any[] = [];
const payrollRuns: any[] = [];

const prisma: any = {
  company: {
    findUnique: async ({ where }: any) => companies[where.id] ?? null,
    findMany: async ({ where }: any) => Object.values(companies).filter((c) => c.status === where.status && activeEmployees.has(c.id)),
  },
  user: {
    findMany: async ({ where }: any) => users
      .filter((u) => u.active)
      .filter((u) => where.OR.some((cond: any) => {
        if (cond.type === 'CONSULTANT' && cond.roles) return u.type === 'CONSULTANT' && u.consultantId === cond.consultantId && u.roleKeys.includes('CONSULTANT_ADMIN');
        if (cond.type === 'CONSULTANT') return u.type === 'CONSULTANT' && u.companyIds.includes(cond.companyAccess.some.companyId);
        if (cond.type === 'CLIENT') return u.type === 'CLIENT' && u.companyIds.includes(cond.companyAccess.some.companyId);
        return false;
      }))
      .map((u) => ({ id: u.id, type: u.type, roles: u.roleKeys.map((k) => ({ role: { key: k } })) })),
  },
  notification: {
    createMany: async ({ data, skipDuplicates }: any) => {
      let count = 0;
      for (const row of data) {
        if (skipDuplicates && row.dedupeKey != null && notifications.some((n) => n.dedupeKey === row.dedupeKey)) continue;
        notifications.push({ id: 'n' + seq++, readAt: null, createdAt: new Date(), ...row });
        count++;
      }
      return { count };
    },
    count: async ({ where }: any) => notifications.filter((n) => n.userId === where.userId && (where.readAt === undefined || n.readAt === where.readAt)).length,
    findMany: async ({ where }: any) => notifications.filter((n) => n.userId === where.userId && (where.readAt === undefined || n.readAt === where.readAt)).sort((a, b) => b.createdAt - a.createdAt),
    updateMany: async ({ where, data }: any) => {
      const rows = notifications.filter((n) => (where.id ? n.id === where.id : true) && n.userId === where.userId && (where.readAt === undefined || n.readAt === where.readAt));
      rows.forEach((n) => Object.assign(n, data));
      return { count: rows.length };
    },
    deleteMany: async ({ where }: any) => {
      const before = notifications.length;
      notifications = notifications.filter((n) => !(n.readAt && n.readAt < where.readAt.lt));
      return { count: before - notifications.length };
    },
  },
  complianceTask: { findMany: async () => complianceTasks },
  document: { findMany: async () => cdocs },
  employeeDocument: { findMany: async () => edocs },
  attendanceSummary: { groupBy: async () => attSummaries },
  payrollRun: { findMany: async () => payrollRuns },
};

const svc = new NotificationsService(prisma); // no compliance service, no channels — exercises the Optional() paths

test('recipients: firm admin sees every company of the firm; staff only their linked companies; inactive users excluded', async () => {
  const ids = await svc.recipients('A', 'PAYROLL_APPROVED'); // client-facing type, but only CLIENT_ADMIN gets it
  assert.ok(ids.includes('admin1'));
  assert.ok(ids.includes('staffA'));
  assert.ok(!ids.includes('staffOther'));
  assert.ok(!ids.includes('inactiveA'));
});

test('recipients: client visibility is type-specific and role-specific', async () => {
  const payrollApproved = await svc.recipients('A', 'PAYROLL_APPROVED');
  assert.ok(payrollApproved.includes('clientAdminA'));
  assert.ok(!payrollApproved.includes('clientHrA')); // PAYROLL_APPROVED is admin-only

  const attendancePending = await svc.recipients('A', 'ATTENDANCE_PENDING');
  assert.ok(attendancePending.includes('clientAdminA'));
  assert.ok(attendancePending.includes('clientHrA')); // both client roles get this one

  const internal = await svc.recipients('A', 'EMPLOYEE_JOINING'); // not in CLIENT_ROLES at all
  assert.ok(!internal.includes('clientAdminA'));
  assert.ok(!internal.includes('clientHrA'));
  assert.ok(internal.includes('admin1'));
});

test('an unknown company has no recipients', async () => {
  assert.deepEqual(await svc.recipients('does-not-exist', 'PAYROLL_APPROVED'), []);
});

test('notify with a refKey is idempotent: calling it twice never double-notifies the same recipient', async () => {
  notifications = [];
  const first = await svc.notify('A', 'PAYROLL_LOCKED', { title: 'Payroll locked', refKey: 'lock:run1' });
  const second = await svc.notify('A', 'PAYROLL_LOCKED', { title: 'Payroll locked', refKey: 'lock:run1' });
  assert.ok(first > 0);
  assert.equal(second, 0);
  assert.equal(notifications.filter((n) => n.dedupeKey?.startsWith('lock:run1')).length, first);
});

test('inbox: a user only ever sees and marks their own notifications', async () => {
  notifications = [];
  await svc.notifyUser('clientAdminA', 'A', 'DOCUMENT_EXPIRY', { title: 'Doc expiring' });
  await svc.notifyUser('staffA', 'A', 'DOCUMENT_EXPIRY', { title: 'Other person\'s notification' });
  const uClient: AuthUser = { id: 'clientAdminA', type: 'CLIENT', consultantId: null, roles: [], permissions: [] };
  const list = await svc.list(uClient, { page: 1, pageSize: 10 });
  assert.equal(list.total, 1);
  assert.equal((await svc.unreadCount(uClient)).count, 1);
  const otherId = notifications.find((n) => n.userId === 'staffA')!.id;
  await assert.rejects(svc.markRead(uClient, otherId), NotFoundException);
  await svc.markRead(uClient, list.items[0].id);
  assert.equal((await svc.unreadCount(uClient)).count, 0);
});

test('markAllRead only touches the caller\'s own unread notifications', async () => {
  notifications = [];
  await svc.notifyUser('clientAdminA', 'A', 'DOCUMENT_EXPIRY', { title: 'a' });
  await svc.notifyUser('clientAdminA', 'A', 'DOCUMENT_EXPIRY', { title: 'b' });
  await svc.notifyUser('staffA', 'A', 'DOCUMENT_EXPIRY', { title: 'c' });
  const uClient: AuthUser = { id: 'clientAdminA', type: 'CLIENT', consultantId: null, roles: [], permissions: [] };
  const r = await svc.markAllRead(uClient);
  assert.equal(r.marked, 2);
  assert.ok(notifications.find((n) => n.userId === 'staffA')!.readAt === null);
});

test('sweep: compliance due/overdue produce distinct notifications, and re-running never duplicates', async () => {
  notifications = [];
  complianceTasks.length = 0;
  complianceTasks.push(
    { id: 't1', companyId: 'A', name: 'PF return', dueDate: new Date('2025-07-14'), status: 'DUE_SOON' },
    { id: 't2', companyId: 'A', name: 'ESI return', dueDate: new Date('2025-07-01'), status: 'OVERDUE' },
  );
  const now = new Date('2025-07-10T00:00:00Z');
  const r1 = await svc.sweep(now);
  assert.ok(r1.compliance > 0);
  const r2 = await svc.sweep(now);
  assert.equal(r2.compliance, 0); // idempotent re-run
  assert.ok(notifications.some((n) => n.title.includes('is due soon')));
  assert.ok(notifications.some((n) => n.title.includes('is overdue')));
  complianceTasks.length = 0;
});

test('sweep: documents expiring inside the reminder window notify; ones far in the future do not', async () => {
  notifications = [];
  cdocs.length = 0; edocs.length = 0;
  const now = new Date('2025-07-10T00:00:00Z');
  cdocs.push(
    { id: 'd1', companyId: 'A', title: 'PF licence', expiryDate: new Date('2025-07-20'), reminderDaysBefore: 30 }, // inside window
    { id: 'd2', companyId: 'A', title: 'Far off licence', expiryDate: new Date('2026-07-20'), reminderDaysBefore: 30 }, // excluded by the query horizon itself
    { id: 'd3', companyId: 'A', title: 'Just expired', expiryDate: new Date('2025-07-05'), reminderDaysBefore: 30 },
  );
  await svc.sweep(now);
  assert.ok(notifications.some((n) => n.title.includes('expiring in') && n.title.includes('PF licence')));
  assert.ok(notifications.some((n) => n.title.includes('expired') && n.title.includes('Just expired')));
  assert.ok(!notifications.some((n) => n.title.includes('Far off licence')));
  cdocs.length = 0; edocs.length = 0;
});

test('sweep: last month\'s attendance/payroll pending only fires after the grace day, and only for companies still open', async () => {
  notifications = [];
  attSummaries.length = 0; payrollRuns.length = 0;
  const early = new Date('2025-07-02T00:00:00Z'); // before PENDING_AFTER_DAY (3)
  const r0 = await svc.sweep(early);
  assert.equal(r0.attendance, 0);
  assert.equal(r0.payroll, 0);

  const late = new Date('2025-07-10T00:00:00Z');
  const r1 = await svc.sweep(late);
  // Company A has attendance enabled and no June finalization/approval recorded -> both fire. Company X has attendance disabled -> only payroll fires.
  assert.ok(r1.attendance >= 1);
  assert.ok(r1.payroll >= 2);
  assert.ok(notifications.some((n) => n.companyId === 'A' && n.type === 'ATTENDANCE_PENDING'));
  assert.ok(!notifications.some((n) => n.companyId === 'X' && n.type === 'ATTENDANCE_PENDING'));

  notifications.length = 0;
  attSummaries.push({ companyId: 'A' });
  payrollRuns.push({ companyId: 'A' }, { companyId: 'X' });
  const r2 = await svc.sweep(late);
  assert.equal(r2.attendance, 0); // A is now finalized
  assert.equal(r2.payroll, 0); // both approved
  attSummaries.length = 0; payrollRuns.length = 0;
});

test('sweep cleans up read notifications older than 60 days but leaves recent and unread ones', async () => {
  notifications = [
    { id: 'old-read', userId: 'staffA', readAt: new Date('2025-01-01'), createdAt: new Date('2025-01-01') },
    { id: 'recent-read', userId: 'staffA', readAt: new Date('2025-07-01'), createdAt: new Date('2025-07-01') },
    { id: 'unread', userId: 'staffA', readAt: null, createdAt: new Date('2025-01-01') },
  ];
  // Day 2 skips the attendance/payroll-pending block (verified separately above); compliance/document
  // sources are already empty from earlier tests, so this run only exercises the cleanup.
  const r = await svc.sweep(new Date('2025-07-02T00:00:00Z'));
  assert.equal(r.cleaned, 1);
  assert.deepEqual(notifications.map((n) => n.id).sort(), ['recent-read', 'unread']);
});
