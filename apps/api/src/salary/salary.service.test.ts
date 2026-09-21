import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { SalaryService } from './salary.service';
import { AuthUser } from '../common/auth.types';

const comp = (id: string, companyId: string, code: string, extra: object = {}) => ({
  id, companyId, code, name: code, type: 'EARNING', calcMethod: 'FIXED', percentage: null, percentOf: null, fixedAmount: null, formula: null, ...extra,
});
const components = [
  comp('c-basic', 'A', 'BASIC', { calcMethod: 'PERCENTAGE', percentage: 40 }),
  comp('c-hra', 'A', 'HRA', { calcMethod: 'PERCENTAGE', percentage: 50, percentOf: 'BASIC' }),
  comp('c-spl', 'A', 'SPECIAL', { calcMethod: 'FORMULA', formula: 'GROSS - BASIC - HRA' }),
  comp('c-other', 'B', 'BASIC'),
];
const salaries: any[] = [];
const structure = {
  id: 's1', companyId: 'A', name: 'Std',
  items: [{ componentId: 'c-basic', sequence: 1 }, { componentId: 'c-hra', sequence: 2 }, { componentId: 'c-spl', sequence: 3 }]
    .map((i) => ({ ...i, component: components.find((c) => c.id === i.componentId) })),
};
const prisma: any = {
  salaryComponent: { findMany: async ({ where }: any) => components.filter((c) => where.id.in.includes(c.id) && c.companyId === where.companyId) },
  salaryStructure: { findFirst: async ({ where }: any) => (where.id === 's1' && where.companyId === 'A' ? structure : null) },
  employee: { findFirst: async ({ where }: any) => (where.id === 'e1' && where.companyId === 'A' ? { id: 'e1' } : null) },
  employeeSalary: {
    findFirst: async () => [...salaries].sort((a, b) => +b.effectiveFrom - +a.effectiveFrom)[0] ?? null,
    update: async ({ where, data }: any) => Object.assign(salaries.find((s) => s.id === where.id), data),
    create: async ({ data }: any) => { const r = { id: 'sal' + salaries.length, effectiveTo: null, ...data }; salaries.push(r); return r; },
  },
  $transaction: async (cb: any) => cb(prisma),
};
const svc = new SalaryService(prisma, { log: async () => undefined } as any);
const u: AuthUser = { id: 'u', type: 'CONSULTANT', consultantId: 'C', roles: [], permissions: [] };

test('structure cannot use another company\'s component', async () => {
  await assert.rejects(svc.createStructure(u, 'A', { name: 'X', items: [{ componentId: 'c-other', sequence: 1 }] }), BadRequestException);
});

test('structure with a bad formula reference is rejected before saving', async () => {
  const bad = [comp('c-bad', 'A', 'BAD', { calcMethod: 'FORMULA', formula: 'NOPE * 2' })];
  components.push(bad[0]);
  await assert.rejects(svc.createStructure(u, 'A', { name: 'Y', items: [{ componentId: 'c-bad', sequence: 1 }] }), BadRequestException);
});

test('preview computes the example structure', async () => {
  const r = await svc.preview('A', 's1', 30000);
  assert.deepEqual(r.lines.map((l) => l.amount), [12000, 6000, 12000]);
});

test('assign snapshots the breakup and closes the previous record', async () => {
  const first: any = await svc.assign(u, 'A', 'e1', { structureId: 's1', grossMonthly: 30000, effectiveFrom: '2025-04-01' });
  assert.equal(first.reason, 'JOINING');
  assert.equal((first.components as any).gross, 30000);
  const second: any = await svc.assign(u, 'A', 'e1', { structureId: 's1', grossMonthly: 36000, effectiveFrom: '2026-04-01' });
  assert.equal(second.reason, 'REVISION');
  assert.equal(salaries[0].effectiveTo.toISOString().slice(0, 10), '2026-03-31');
  assert.equal((salaries[0].components as any).gross, 30000); // history untouched
});

test('effective date must be after the current one; other company blocked', async () => {
  await assert.rejects(svc.assign(u, 'A', 'e1', { structureId: 's1', grossMonthly: 40000, effectiveFrom: '2026-01-01' }), BadRequestException);
  await assert.rejects(svc.assign(u, 'B', 'e1', { structureId: 's1', grossMonthly: 40000, effectiveFrom: '2027-01-01' }));
});

test('invalid override values are rejected', async () => {
  await assert.rejects(svc.preview('A', 's1', 30000, { BASIC: -5 }), BadRequestException);
  await assert.rejects(svc.preview('A', 's1', 30000, { 'bad key': 1 } as any), BadRequestException);
});
