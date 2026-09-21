import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { PayrollService } from './payroll.service';
import { AuthUser } from '../common/auth.types';

const D = (s: string) => new Date(`${s}T00:00:00.000Z`);
const flags = (pf: boolean) => ({ pf, esi: false, pt: false, bonus: false, gratuity: false, taxable: true });
const snap = { lines: [
  { code: 'BASIC', name: 'Basic', type: 'EARNING', amount: 20000, method: 'FIXED', flags: flags(true) },
  { code: 'HRA', name: 'HRA', type: 'EARNING', amount: 10000, method: 'FIXED', flags: flags(false) },
] };

// ── in-memory database ──
const db = {
  run: { id: 'r1', companyId: 'A', year: 2025, month: 6, type: 'MONTHLY', status: 'DRAFT', issues: null as any, totalNet: 0 } as any,
  details: [] as any[], earnings: [] as any[], deductions: [] as any[], loanTxns: [] as any[], audits: [] as any[],
  loan: { id: 'L1', companyId: 'A', employeeId: 'e1', type: 'LOAN', emi: 2000, balance: 3000, status: 'ACTIVE', startMonth: D('2025-01-01') } as any,
  employees: [
    { id: 'e1', code: 'E1', firstName: 'Asha', lastName: 'P', dol: null, pfApplicable: true, esiApplicable: true, ptApplicable: true, lwfApplicable: false, branch: null },
    { id: 'e2', code: 'E2', firstName: 'Ravi', lastName: 'S', dol: null, pfApplicable: true, esiApplicable: true, ptApplicable: true, lwfApplicable: false, branch: null },
    { id: 'e3', code: 'E3', firstName: 'No', lastName: 'Salary', dol: null, pfApplicable: true, esiApplicable: true, ptApplicable: true, lwfApplicable: false, branch: null },
  ],
  finalized: new Set(['e1']), // e2 attendance not finalized
};
const cnt = (o: any) => o.count ?? 0;
const prisma: any = {
  payrollRun: {
    findFirst: async ({ where }: any) => (where.id ? (where.id === db.run.id && where.companyId === db.run.companyId ? { ...db.run, _count: { details: db.details.length } } : null) : db.run),
    update: async ({ data }: any) => Object.assign(db.run, data),
    create: async ({ data }: any) => Object.assign(db.run, { id: 'r1', ...data }),
    delete: async () => undefined,
  },
  company: { findUniqueOrThrow: async () => ({ state: 'Gujarat' }) },
  companySettings: { findUnique: async () => ({ attendanceEnabled: true, salaryCalcMethod: 'CALENDAR_DAYS', weeklyOff: ['SUN'], roundingRule: 'NEAREST_RUPEE', pfEnabled: true, esiEnabled: false, ptEnabled: false, lwfEnabled: false, tdsEnabled: false }) },
  holiday: { findMany: async () => [] },
  employee: { findMany: async () => db.employees, findFirst: async ({ where }: any) => db.employees.find((e) => e.id === where.id) ?? null },
  employeeSalary: { findMany: async () => [{ id: 's1', employeeId: 'e1', effectiveFrom: D('2025-01-01'), effectiveTo: null, components: snap }, { id: 's2', employeeId: 'e2', effectiveFrom: D('2025-01-01'), effectiveTo: null, components: snap }] },
  attendanceSummary: { findMany: async () => [
    { employeeId: 'e1', paidDays: 27, lopDays: 3, otHours: 0, presentDays: 24, finalized: true },
    { employeeId: 'e2', paidDays: 30, lopDays: 0, otHours: 0, presentDays: 26, finalized: false },
  ] },
  payrollInput: { findMany: async () => [{ employeeId: 'e1', kind: 'BONUS', name: 'Diwali', amount: 1000 }] },
  loan: { findMany: async () => [db.loan], update: async ({ data }: any) => { if (data.balance?.decrement) db.loan.balance -= data.balance.decrement; if (data.balance?.increment) db.loan.balance += data.balance.increment; if (data.status) db.loan.status = data.status; return db.loan; } },
  complianceRule: { findMany: async () => [{ id: 'pf1', module: 'PF', state: null, version: 1, effectiveFrom: D('2024-04-01'), effectiveTo: null, wageCeiling: 15000, threshold: null, employeePercent: 12, employerPercent: 12, slabs: null, rules: null }] },
  payrollDetail: {
    deleteMany: async () => { db.details = []; db.earnings = []; db.deductions = []; },
    createMany: async ({ data }: any) => { db.details.push(...data); },
    findMany: async () => db.details.map((d) => ({ calculation: d.calculation })),
  },
  payrollEarning: { createMany: async ({ data }: any) => { db.earnings.push(...data); } },
  payrollDeduction: { createMany: async ({ data }: any) => { db.deductions.push(...data); } },
  loanTransaction: {
    create: async ({ data }: any) => { db.loanTxns.push(data); },
    findMany: async () => db.loanTxns, deleteMany: async () => { db.loanTxns = []; },
  },
  $transaction: async (cb: any) => cb(prisma),
};
const audit: any = { log: async (e: any) => { db.audits.push(e); } };
const access: any = {};
const svc = new PayrollService(prisma, audit, access);
const u: AuthUser = { id: 'u1', type: 'CONSULTANT', consultantId: 'C', roles: [], permissions: [] };

test('process: calculates eligible employees and reports the rest as errors, never silently', async () => {
  const s = await svc.process(u, 'A', 'r1');
  assert.equal(s.employees, 3);
  assert.equal(s.calculated, 1); // only e1
  assert.equal(s.errors, 2); // e2 attendance not finalized, e3 no salary
  const issues = db.run.issues as any[];
  assert.ok(issues.some((i) => i.code === 'E2' && i.message.includes('Attendance is not finalized')));
  assert.ok(issues.some((i) => i.code === 'E3' && i.message.includes('No salary')));
  assert.equal(db.run.status, 'CALCULATED');
});

test('e1 numbers: LOP proration, bonus, PF on flagged wage, loan EMI; stored with inputs and version', async () => {
  const d = db.details[0];
  // 27/30 of 30000 = 27000 (+1000 bonus) = 28000 gross. PF wage = 18000 capped 15000 -> 1800. Loan 2000.
  assert.equal(d.gross, 28000);
  assert.equal(db.deductions.find((x) => x.code === 'PF').amount, 1800);
  assert.equal(db.deductions.find((x) => x.code === 'LOAN').amount, 2000);
  assert.equal(d.net, 28000 - 1800 - 2000);
  assert.equal(d.formulaVersion, '1.0.0');
  assert.equal(d.inputs.attendance.paidDays, 27);
  assert.ok(Array.isArray(d.calculation.trace));
  assert.equal(db.run.totalNet, d.net); // run total equals the sum of details (one employee)
  assert.equal(db.run.rulesSnapshot.rules[0].id, 'pf1'); // rules used are frozen into the run
});

test('recalculating replaces the previous result instead of duplicating', async () => {
  await svc.process(u, 'A', 'r1');
  assert.equal(db.details.length, 1);
});

test('workflow order is enforced: cannot approve before review, lock before approve', async () => {
  await assert.rejects(svc.approve(u, 'A', 'r1', true), ConflictException);
  await assert.rejects(svc.lock(u, 'A', 'r1'), ConflictException);
  await svc.toReview(u, 'A', 'r1');
  assert.equal(db.run.status, 'REVIEW');
});

test('approval is blocked while employees were skipped unless acknowledged', async () => {
  await assert.rejects(svc.approve(u, 'A', 'r1', false), BadRequestException);
});

test('approve applies the loan recovery; unapprove restores it', async () => {
  await svc.approve(u, 'A', 'r1', true);
  assert.equal(db.run.status, 'APPROVED');
  assert.equal(db.loan.balance, 1000);
  assert.equal(db.loanTxns.length, 1);
  await svc.unapprove(u, 'A', 'r1');
  assert.equal(db.run.status, 'REVIEW');
  assert.equal(db.loan.balance, 3000);
  assert.equal(db.loanTxns.length, 0);
  await svc.approve(u, 'A', 'r1', true);
});

test('approved or locked payroll cannot be recalculated or have inputs changed', async () => {
  await assert.rejects(svc.process(u, 'A', 'r1'), ForbiddenException);
  await svc.lock(u, 'A', 'r1');
  assert.equal(db.run.status, 'LOCKED');
  await assert.rejects(svc.process(u, 'A', 'r1'), ForbiddenException);
  await assert.rejects(svc.addInput(u, 'A', { employeeId: 'e1', year: 2025, month: 6, kind: 'BONUS', name: 'x', amount: 5 }), ForbiddenException);
});

test('unlock needs a real reason and always writes an audit entry with it', async () => {
  await assert.rejects(svc.unlock(u, 'A', 'r1', 'short'), BadRequestException);
  await svc.unlock(u, 'A', 'r1', 'Correct wrong bonus for E1');
  assert.equal(db.run.status, 'APPROVED');
  const a = db.audits.find((x) => x.action === 'PAYROLL_UNLOCKED');
  assert.ok(a);
  assert.equal(a.newValue.reason, 'Correct wrong bonus for E1');
  assert.equal(a.oldValue.status, 'LOCKED');
});

test('another company cannot see or touch this run', async () => {
  await assert.rejects(svc.process(u, 'B', 'r1'));
});
