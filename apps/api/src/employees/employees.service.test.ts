import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { EmployeesService } from './employees.service';
import { AuthUser } from '../common/auth.types';

process.env.ENCRYPTION_KEY = 'b'.repeat(64);

// Masters: dept D-A belongs to company A only.
const masters: Record<string, { id: string; companyId: string }[]> = {
  department: [{ id: 'D-A', companyId: 'A' }],
  branch: [], designation: [], location: [], employee: [],
};
const created: any[] = [];
const fakeModel = (name: string) => ({
  findFirst: async ({ where }: any) => masters[name].find((m) => m.id === where.id && m.companyId === where.companyId) ?? null,
});
const prisma: any = {
  ...Object.fromEntries(Object.keys(masters).map((k) => [k, fakeModel(k)])),
  employee: {
    ...fakeModel('employee'),
    create: async ({ data }: any) => {
      if (created.some((c) => c.companyId === data.companyId && c.code === data.code)) throw Object.assign(new Error('dup'), { code: 'P2002' });
      const row = { id: 'E' + created.length, ...data };
      created.push(row);
      return row;
    },
  },
};
const audit: any = { log: async () => undefined };
const svc = new EmployeesService(prisma, audit);
const u: AuthUser = { id: 'u', type: 'CONSULTANT', consultantId: 'C', roles: [], permissions: [] };

test('cannot link an employee to another company\'s department', async () => {
  await assert.rejects(svc.create(u, 'B', { code: '1', firstName: 'X', doj: '2024-01-01', departmentId: 'D-A' }), BadRequestException);
});

test('sensitive fields are stored encrypted and returned masked', async () => {
  const r: any = await svc.create(u, 'A', { code: '2', firstName: 'Y', doj: '2024-01-01', pan: 'ABCDE1234F', bankAccount: '123456789012' });
  const stored = created.find((c) => c.code === '2');
  assert.ok(!JSON.stringify(stored).includes('ABCDE1234F'));
  assert.ok(!JSON.stringify(stored).includes('123456789012'));
  assert.equal(r.pan, '******234F');
  assert.equal(r.bankAccount, '********9012');
  assert.equal(r.panEnc, undefined);
});

test('duplicate code in same company conflicts; leaving before joining rejected', async () => {
  await assert.rejects(svc.create(u, 'A', { code: '2', firstName: 'Z', doj: '2024-01-01' }), ConflictException);
  await assert.rejects(svc.create(u, 'A', { code: '3', firstName: 'Z', doj: '2024-06-01', dol: '2024-01-01' }), BadRequestException);
});
