import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { LeaveService } from './leave.service';
import { AuthUser } from '../common/auth.types';

// Minimal in-memory Prisma for the tables the leave service touches.
const db = {
  txns: [] as any[], balances: [] as any[], requests: [] as any[], attendance: [] as any[],
  emp: { id: 'e1', doj: new Date('2024-01-01T00:00:00Z'), dol: null },
  types: [{ id: 'cl', companyId: 'A', code: 'CL', paid: true, encashable: false }, { id: 'el', companyId: 'A', code: 'EL', paid: true, encashable: true }],
  policies: [{ companyId: 'A', leaveTypeId: 'cl', annualQuota: 12, accrualRule: null, maxAccumulation: null }],
};
const key = (w: any) => w.employeeId_leaveTypeId_year;
const prisma: any = {
  employee: {
    findFirst: async ({ where }: any) => (where.companyId === 'A' && where.id === 'e1' ? db.emp : null),
    findMany: async () => [db.emp],
  },
  leaveType: { findFirst: async ({ where }: any) => db.types.find((t) => t.id === where.id && t.companyId === where.companyId) ?? null },
  leavePolicy: { findMany: async () => db.policies },
  leaveTransaction: {
    create: async ({ data }: any) => { db.txns.push(data); },
    findMany: async ({ where }: any) => db.txns.filter((t) => t.type === where.type && t.note === where.note && t.leaveTypeId === where.leaveTypeId),
  },
  leaveBalance: {
    findUnique: async ({ where }: any) => db.balances.find((b) => b.employeeId === key(where).employeeId && b.leaveTypeId === key(where).leaveTypeId && b.year === key(where).year) ?? null,
    upsert: async ({ where, update, create }: any) => {
      const k = key(where); const b = db.balances.find((x) => x.employeeId === k.employeeId && x.leaveTypeId === k.leaveTypeId && x.year === k.year);
      if (b) Object.assign(b, update); else db.balances.push(create);
    },
  },
  leaveRequest: {
    count: async () => 0,
    create: async ({ data }: any) => { const r = { id: 'r' + db.requests.length, status: 'PENDING', ...data }; db.requests.push(r); return r; },
    findFirst: async ({ where }: any) => { const r = db.requests.find((x) => x.id === where.id); return r ? { ...r, leaveType: db.types.find((t) => t.id === r.leaveTypeId) } : null; },
    update: async ({ where, data }: any) => Object.assign(db.requests.find((x) => x.id === where.id), data),
  },
  attendance: {
    upsert: async ({ create }: any) => { db.attendance.push(create); },
    deleteMany: async () => { db.attendance.length = 0; },
  },
  holiday: { findMany: async () => [] },
  $transaction: async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg)),
};
const attendance: any = { settings: async () => ({ weeklyOff: ['SUN'] }), assertEditable: async () => undefined };
const svc = new LeaveService(prisma, { log: async () => undefined } as any, attendance);
const u: AuthUser = { id: 'u', type: 'CONSULTANT', consultantId: 'C', roles: [], permissions: [] };
const bal = (id = 'cl') => db.balances.find((b) => b.leaveTypeId === id)?.balance;

test('monthly accrual credits quota/12 and is idempotent', async () => {
  await svc.accrue(u, 'A', 2025, 6);
  assert.equal(bal(), 1);
  await svc.accrue(u, 'A', 2025, 6); // same month again
  assert.equal(bal(), 1);
  assert.equal(db.txns.filter((t) => t.type === 'ACCRUAL').length, 1);
  await svc.accrue(u, 'A', 2025, 7);
  assert.equal(bal(), 2);
});

test('maxAccumulation caps accrual', async () => {
  db.policies[0].maxAccumulation = 2.5 as any;
  await svc.accrue(u, 'A', 2025, 8);
  assert.equal(bal(), 2.5);
  db.policies[0].maxAccumulation = null;
});

test('request needs working days and is blocked across years', async () => {
  await assert.rejects(svc.request(u, 'A', { employeeId: 'e1', leaveTypeId: 'cl', fromDate: '2025-06-15', toDate: '2025-06-15' }), BadRequestException); // Sunday only
  await assert.rejects(svc.request(u, 'A', { employeeId: 'e1', leaveTypeId: 'cl', fromDate: '2025-12-30', toDate: '2026-01-02' }), BadRequestException);
});

test('approval is refused when balance is short; succeeds after adjustment, deducts and writes attendance', async () => {
  const r: any = await svc.request(u, 'A', { employeeId: 'e1', leaveTypeId: 'cl', fromDate: '2025-06-16', toDate: '2025-06-18' });
  assert.equal(r.days, 3);
  await assert.rejects(svc.approve(u, 'A', r.id), BadRequestException); // balance 2.5 < 3
  await svc.adjust(u, 'A', { employeeId: 'e1', leaveTypeId: 'cl', date: '2025-06-01', days: 2, note: 'test top-up' });
  await svc.approve(u, 'A', r.id);
  assert.equal(bal(), 1.5);
  assert.equal(db.attendance.length, 3);
  assert.equal(db.attendance[0].status, 'PAID_LEAVE');
  await assert.rejects(svc.approve(u, 'A', r.id), ConflictException); // cannot approve twice
});

test('cancelling an approved request restores balance and clears leave attendance', async () => {
  await svc.cancel(u, 'A', 'r0');
  assert.equal(bal(), 4.5);
  assert.equal(db.attendance.length, 0);
});

test('encashment only for encashable types and within balance', async () => {
  await assert.rejects(svc.encash(u, 'A', { employeeId: 'e1', leaveTypeId: 'cl', date: '2025-06-30', days: 1 }), BadRequestException);
  await assert.rejects(svc.encash(u, 'A', { employeeId: 'e1', leaveTypeId: 'el', date: '2025-06-30', days: 1 }), BadRequestException); // no EL balance
});

test('other company cannot touch this employee', async () => {
  await assert.rejects(svc.adjust(u, 'B', { employeeId: 'e1', leaveTypeId: 'cl', date: '2025-06-01', days: 1, note: 'nope' }));
});
