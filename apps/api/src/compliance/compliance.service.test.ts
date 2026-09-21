import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ComplianceService } from './compliance.service';
import { AuthUser } from '../common/auth.types';

const D = (s: string) => new Date(`${s}T00:00:00.000Z`);
const db = {
  rules: [] as any[], tasks: [] as any[], audits: [] as any[],
  payrollApproved: false,
  settings: { pfEnabled: true, esiEnabled: false, ptEnabled: true, lwfEnabled: true, tdsEnabled: false } as any,
};
const prisma: any = {
  complianceRule: {
    findFirst: async ({ where }: any) => db.rules.filter((r) => r.consultantId === where.consultantId && r.module === where.module && r.state === where.state).sort((a, b) => b.version - a.version)[0] ?? null,
    update: async ({ where, data }: any) => Object.assign(db.rules.find((r) => r.id === where.id), data),
    create: async ({ data }: any) => { const r = { id: 'r' + db.rules.length, effectiveTo: null, ...data }; db.rules.push(r); return r; },
    findMany: async () => db.rules,
  },
  auditLog: { create: async ({ data }: any) => { db.audits.push(data); } },
  company: { findUniqueOrThrow: async () => ({ state: 'Gujarat', consultantId: 'C1' }) },
  companySettings: { findUnique: async () => db.settings },
  complianceTask: {
    findMany: async () => db.tasks,
    create: async ({ data }: any) => { const t = { id: 't' + db.tasks.length, ...data }; db.tasks.push(t); return t; },
    findUnique: async ({ where }: any) => db.tasks.find((t) => t.id === where.id) ?? null,
    update: async ({ where, data }: any) => Object.assign(db.tasks.find((t) => t.id === where.id), data),
  },
  payrollRun: { findFirst: async () => (db.payrollApproved ? { id: 'run' } : null) },
  $transaction: async (cb: any) => cb(prisma),
};
const access: any = {
  assertAccess: async (u: AuthUser, id: string) => { if (id !== 'A') throw new NotFoundException(); return { id }; },
  accessibleCompanyIds: async () => ['A'],
};
const audit: any = { log: async (e: any) => { db.audits.push(e); } };
const svc = new ComplianceService(prisma, audit, access);
const consultant: AuthUser = { id: 'u1', type: 'CONSULTANT', consultantId: 'C1', roles: ['CONSULTANT_ADMIN'], permissions: [] };
const superAdmin: AuthUser = { id: 'sa', type: 'SUPER_ADMIN', consultantId: null, roles: ['SUPER_ADMIN'], permissions: [] };
const pf = (from: string, extra: any = {}) => ({ module: 'PF', effectiveFrom: from, employeePercent: 12, employerPercent: 12, wageCeiling: 15000, rules: { dueDay: 15 }, ...extra });

test('a consultant creates rules only in their own scope; super admin creates platform rules', async () => {
  const mine: any = await svc.createRule(consultant, pf('2025-04-01'));
  assert.equal(mine.consultantId, 'C1');
  const platform: any = await svc.createRule(superAdmin, pf('2025-04-01'));
  assert.equal(platform.consultantId, null);
  assert.equal(mine.version, 1);
  assert.equal(platform.version, 1); // versions are counted per scope
});

test('new version closes the previous one the day before and bumps the version', async () => {
  const v2: any = await svc.createRule(consultant, pf('2026-04-01', { employeePercent: 11 }));
  assert.equal(v2.version, 2);
  const v1 = db.rules.find((r) => r.consultantId === 'C1' && r.version === 1);
  assert.equal(v1.effectiveTo.toISOString().slice(0, 10), '2026-03-31');
  assert.equal(v1.employeePercent, 12); // the old version is untouched
});

test('a new version cannot start on or before the current one', async () => {
  await assert.rejects(svc.createRule(consultant, pf('2026-04-01')), BadRequestException);
  await assert.rejects(svc.createRule(consultant, pf('2025-01-01')), BadRequestException);
});

test('invalid rule shapes are rejected with readable errors, and every creation is audited', async () => {
  await assert.rejects(svc.createRule(consultant, { module: 'PT', effectiveFrom: '2027-01-01', slabs: [] } as any), BadRequestException);
  assert.ok(db.audits.some((a) => a.action === 'COMPLIANCE_RULE_CREATED'));
});

test('generate: due dates come from rules; modules without rule or due day are reported, not invented', async () => {
  db.rules.length = 0;
  db.rules.push({ id: 'pfr', consultantId: null, module: 'PF', state: null, version: 1, effectiveFrom: D('2025-04-01'), effectiveTo: null, rules: { dueDay: 15 } });
  db.rules.push({ id: 'ptr', consultantId: null, module: 'PT', state: null, version: 1, effectiveFrom: D('2025-04-01'), effectiveTo: null, rules: {} }); // no dueDay
  const r = await svc.generate(consultant, 'A', 2025, 6);
  assert.deepEqual(r.created, ['PF']);
  assert.equal(db.tasks[0].dueDate.toISOString().slice(0, 10), '2025-07-15');
  assert.ok(r.skipped.some((s) => s.module === 'PT' && s.reason.includes('due day')));
  assert.ok(r.skipped.some((s) => s.module === 'LWF' && s.reason.includes('No rule')));
  const again = await svc.generate(consultant, 'A', 2025, 6);
  assert.equal(db.tasks.length, 1); // idempotent
  void again;
});

test('LWF only creates a task in the months its rule lists', async () => {
  db.rules.push({ id: 'lw', consultantId: null, module: 'LWF', state: null, version: 1, effectiveFrom: D('2025-04-01'), effectiveTo: null, rules: { dueDay: 15, months: [6, 12] } });
  db.tasks.length = 0;
  const jul = await svc.generate(consultant, 'A', 2025, 7);
  assert.ok(!jul.created.includes('LWF'));
  const jun = await svc.generate(consultant, 'A', 2025, 6);
  assert.ok(jun.created.includes('LWF'));
});

test('cannot complete a payroll-based filing until that payroll is approved', async () => {
  const task = db.tasks.find((t) => t.module === 'PF');
  await assert.rejects(svc.complete(consultant, task.id, { challanRef: 'CH-1' }), ConflictException);
  db.payrollApproved = true;
  const done: any = await svc.complete(consultant, task.id, { challanRef: ' CH-1 ' });
  assert.equal(done.status, 'COMPLETED');
  assert.equal(done.challanRef, 'CH-1');
  await assert.rejects(svc.complete(consultant, task.id, {}), ConflictException);
});

test('reopen restores a derived status and clears the challan', async () => {
  const task = db.tasks.find((t) => t.module === 'PF');
  const r: any = await svc.reopen(consultant, task.id);
  assert.notEqual(r.status, 'COMPLETED');
  assert.equal(r.challanRef, null);
});

test('tasks of another tenant look like they do not exist', async () => {
  db.tasks.push({ id: 'foreign', companyId: 'B', module: 'PF', status: 'PENDING', periodYear: 2025, periodMonth: 6, dueDate: D('2025-07-15') });
  await assert.rejects(svc.complete(consultant, 'foreign', {}), NotFoundException);
  await assert.rejects(svc.assign(consultant, 'foreign', null), NotFoundException);
});

test('a user without consultant cannot create consultant rules', async () => {
  await assert.rejects(svc.createRule({ ...consultant, consultantId: null }, pf('2030-01-01')), ForbiddenException);
});
