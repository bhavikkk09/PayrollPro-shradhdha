import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { NotFoundException } from '@nestjs/common';
import { CompanyAccessService } from './company-access';
import { AuthUser } from './auth.types';

// In-memory fake of the Prisma calls the service uses.
const companies = [
  { id: 'A1', consultantId: 'C1', deletedAt: null },
  { id: 'B1', consultantId: 'C2', deletedAt: null },
  { id: 'A2', consultantId: 'C1', deletedAt: null },
];
const links = [{ userId: 'clientA', companyId: 'A1' }];
const prisma: any = {
  company: {
    findMany: async ({ where }: any) => companies.filter((c) => c.consultantId === where.consultantId),
    findFirst: async ({ where }: any) => companies.find((c) => c.id === where.id) ?? null,
  },
  companyUser: { findMany: async ({ where }: any) => links.filter((l) => l.userId === where.userId) },
};
const svc = new CompanyAccessService(prisma);
const user = (o: Partial<AuthUser>): AuthUser => ({ id: 'u', type: 'CONSULTANT', consultantId: 'C1', roles: [], permissions: [], ...o });

test('consultant admin sees only their own consultant companies', async () => {
  const u = user({ roles: ['CONSULTANT_ADMIN'] });
  assert.deepEqual(await svc.accessibleCompanyIds(u), ['A1', 'A2']);
  await assert.rejects(svc.assertAccess(u, 'B1'), NotFoundException);
});

test('client user is limited to linked companies (Company A cannot read Company B)', async () => {
  const u = user({ id: 'clientA', type: 'CLIENT', consultantId: null, roles: ['CLIENT_ADMIN'] });
  assert.deepEqual(await svc.accessibleCompanyIds(u), ['A1']);
  await svc.assertAccess(u, 'A1');
  await assert.rejects(svc.assertAccess(u, 'A2'), NotFoundException); // same consultant, not linked
  await assert.rejects(svc.assertAccess(u, 'B1'), NotFoundException);
});

test('consultant staff without links sees nothing', async () => {
  const u = user({ id: 'staff', roles: ['CONSULTANT_STAFF'] });
  assert.deepEqual(await svc.accessibleCompanyIds(u), []);
});

test('super admin sees all', async () => {
  assert.equal(await svc.accessibleCompanyIds(user({ type: 'SUPER_ADMIN' })), 'ALL');
});
