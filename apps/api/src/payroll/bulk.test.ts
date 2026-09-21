import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ForbiddenException } from '@nestjs/common';
import { PayrollService } from './payroll.service';
import { AuthUser } from '../common/auth.types';

const items = new Map<string, any>([['i1', {}], ['i2', {}], ['i3', {}]]);
const prisma: any = {
  bulkPayrollItem: { update: async ({ where, data }: any) => { Object.assign(items.get(where.id), data); } },
  payrollRun: { findFirst: async () => ({ id: 'run' }) },
};
const svc: any = new PayrollService(prisma, { log: async () => undefined } as any, {} as any);
const u: AuthUser = { id: 'u', type: 'CONSULTANT', consultantId: 'C', roles: [], permissions: [] };

test('bulk: a failing company is recorded and does not stop or corrupt the others', async () => {
  svc.process = async (_u: AuthUser, companyId: string) => {
    if (companyId === 'B') throw new Error('database exploded: secret internals');
    if (companyId === 'C') throw new ForbiddenException('Payroll is LOCKED; it cannot be recalculated');
    return { employees: 10, calculated: 9, errors: 1, warnings: 3 };
  };
  await svc.runBulk(u, 'job', [{ id: 'i1', companyId: 'A' }, { id: 'i2', companyId: 'B' }, { id: 'i3', companyId: 'C' }], 2025, 6);

  assert.equal(items.get('i1').status, 'DONE');
  assert.equal(items.get('i1').success, 9);
  assert.equal(items.get('i1').errors, 1);

  assert.equal(items.get('i2').status, 'FAILED');
  assert.ok(!items.get('i2').errorDetail.includes('secret internals')); // raw errors are never shown to users
  assert.ok(items.get('i2').errorDetail.includes('ref'));

  assert.equal(items.get('i3').status, 'FAILED');
  assert.ok(items.get('i3').errorDetail.includes('LOCKED')); // known business errors are explained
});

test('bulk start refuses if any selected company is not accessible, creating nothing', async () => {
  let created = false;
  const s: any = new PayrollService(
    { bulkPayrollJob: { create: async () => { created = true; } } } as any,
    { log: async () => undefined } as any,
    { assertAccess: async (_u: AuthUser, id: string) => { if (id === 'other-tenant') throw new Error('not found'); return { id, consultantId: 'C' }; } } as any,
  );
  await assert.rejects(s.startBulk(u, ['mine', 'other-tenant'], 2025, 6));
  assert.equal(created, false);
});
