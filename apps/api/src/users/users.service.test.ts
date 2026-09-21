import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { AuthUser } from '../common/auth.types';
import { UsersService } from './users.service';

// Tiny in-memory database.
const roles = ['CONSULTANT_ADMIN', 'CONSULTANT_STAFF', 'CLIENT_ADMIN', 'CLIENT_HR', 'READ_ONLY', 'PAYROLL_OPERATOR', 'COMPLIANCE_OPERATOR', 'SUPER_ADMIN'].map((key) => ({ id: 'role-' + key, key }));
const companies: Record<string, { id: string; name: string; code: string; consultantId: string }> = {
  A1: { id: 'A1', name: 'ABC', code: 'ABC', consultantId: 'C1' }, A2: { id: 'A2', name: 'XYZ', code: 'XYZ', consultantId: 'C1' }, B1: { id: 'B1', name: 'Other', code: 'OTH', consultantId: 'C2' },
};
interface U { id: string; name: string; email: string; type: string; consultantId: string | null; active: boolean; mustChangePassword: boolean; passwordHash: string; lastLoginAt: null; roleKeys: string[]; links: string[] }
const users: U[] = [
  { id: 'admin1', name: 'Admin One', email: 'a1@firm.in', type: 'CONSULTANT', consultantId: 'C1', active: true, mustChangePassword: false, passwordHash: 'x', lastLoginAt: null, roleKeys: ['CONSULTANT_ADMIN'], links: [] },
  { id: 'staff1', name: 'Staff', email: 's1@firm.in', type: 'CONSULTANT', consultantId: 'C1', active: true, mustChangePassword: false, passwordHash: 'x', lastLoginAt: null, roleKeys: ['CONSULTANT_STAFF'], links: ['A1'] },
  { id: 'foreign', name: 'Foreign admin', email: 'f@other.in', type: 'CONSULTANT', consultantId: 'C2', active: true, mustChangePassword: false, passwordHash: 'x', lastLoginAt: null, roleKeys: ['CONSULTANT_ADMIN'], links: [] },
  { id: 'foreignClient', name: 'Other client', email: 'oc@other.in', type: 'CLIENT', consultantId: null, active: true, mustChangePassword: false, passwordHash: 'x', lastLoginAt: null, roleKeys: ['CLIENT_ADMIN'], links: ['B1'] },
];
const revoked: string[] = [];
const audits: any[] = [];

const shape = (x: U) => ({
  ...x, lastLoginAt: null,
  roles: x.roleKeys.map((k) => ({ role: roles.find((r) => r.key === k)! })),
  companyAccess: x.links.map((id) => ({ companyId: id, company: companies[id] })),
});
const inScope = (x: U, cid: string) => x.consultantId === cid || (x.type === 'CLIENT' && x.links.some((l) => companies[l].consultantId === cid));
const prisma: any = {
  user: {
    findFirst: async ({ where }: any) => {
      const id = where.AND[0].id;
      const cid = where.AND[1].OR[0].consultantId;
      const x = users.find((u) => u.id === id && inScope(u, cid));
      return x ? shape(x) : null;
    },
    findUnique: async ({ where }: any) => users.find((u) => u.email === where.email) ?? null,
    count: async ({ where }: any) => (where.roles ? users.filter((u) => u.consultantId === where.consultantId && u.active && u.id !== where.id.not && u.roleKeys.includes('CONSULTANT_ADMIN')).length : 0),
    findMany: async ({ where }: any) => users.filter((u) => inScope(u, where.AND[0].OR[0].consultantId)).map(shape),
    create: async ({ data }: any) => {
      const u: U = { id: 'new' + users.length, name: data.name, email: data.email, type: data.type, consultantId: data.consultantId, active: true, mustChangePassword: data.mustChangePassword, passwordHash: data.passwordHash, lastLoginAt: null,
        roleKeys: [roles.find((r) => r.id === data.roles.create[0].roleId)!.key], links: (data.companyAccess?.create ?? []).map((c: any) => c.companyId) };
      users.push(u); return shape(u);
    },
    update: async ({ where, data }: any) => { const u = users.find((x) => x.id === where.id)!; Object.assign(u, data); return u; },
  },
  role: { findUniqueOrThrow: async ({ where }: any) => roles.find((r) => r.key === where.key)! },
  userRole: {
    deleteMany: async ({ where }: any) => { users.find((u) => u.id === where.userId)!.roleKeys = []; },
    create: async ({ data }: any) => { users.find((u) => u.id === data.userId)!.roleKeys = [roles.find((r) => r.id === data.roleId)!.key]; },
  },
  companyUser: {
    deleteMany: async ({ where }: any) => { users.find((u) => u.id === where.userId)!.links = []; },
    createMany: async ({ data }: any) => { users.find((u) => u.id === data[0].userId)!.links = data.map((d: any) => d.companyId); },
  },
  refreshToken: { updateMany: async ({ where }: any) => { revoked.push(where.userId); return { count: 1 }; } },
  $transaction: async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg)),
};
const access: any = {
  assertAccess: async (_u: AuthUser, id: string) => { if (companies[id]?.consultantId !== 'C1') throw new NotFoundException('Company not found'); return companies[id]; },
  accessibleCompanyIds: async () => ['A1', 'A2'],
};
const svc = new UsersService(prisma, { log: async (e: any) => { audits.push(e); } } as any, access);
const admin: AuthUser = { id: 'admin1', type: 'CONSULTANT', consultantId: 'C1', roles: ['CONSULTANT_ADMIN'], permissions: ['users.manage'] };

test('creating a client user: correct type, no firm id, hashed one-time password, no secrets in audit', async () => {
  const r: any = await svc.create(admin, { name: 'Client Boss', email: 'Boss@ClientCo.in ', type: 'CLIENT', roleKey: 'CLIENT_ADMIN', companyIds: ['A1'] });
  assert.equal(r.user.email, 'boss@clientco.in');
  assert.equal(r.user.type, 'CLIENT');
  assert.equal(r.user.mustChangePassword, true);
  assert.ok(r.temporaryPassword);
  const stored = users.find((u) => u.email === 'boss@clientco.in')!;
  assert.equal(stored.consultantId, null);
  assert.notEqual(stored.passwordHash, r.temporaryPassword);
  assert.ok(await bcrypt.compare(r.temporaryPassword, stored.passwordHash));
  assert.ok(!JSON.stringify(audits).includes(r.temporaryPassword));
});

test('cannot hand out roles that do not fit, or a super admin role', async () => {
  await assert.rejects(svc.create(admin, { name: 'X', email: 'x1@c.in', type: 'CLIENT', roleKey: 'CONSULTANT_ADMIN', companyIds: ['A1'] }), BadRequestException);
  await assert.rejects(svc.create(admin, { name: 'X', email: 'x2@c.in', type: 'CONSULTANT', roleKey: 'CLIENT_ADMIN', companyIds: ['A1'] }), BadRequestException);
  await assert.rejects(svc.create(admin, { name: 'X', email: 'x3@c.in', type: 'CONSULTANT', roleKey: 'SUPER_ADMIN', companyIds: ['A1'] }), BadRequestException);
});

test('cannot link a user to a company outside the admin\'s firm', async () => {
  await assert.rejects(svc.create(admin, { name: 'X', email: 'x4@c.in', type: 'CLIENT', roleKey: 'CLIENT_ADMIN', companyIds: ['B1'] }), NotFoundException);
  await assert.rejects(svc.create(admin, { name: 'X', email: 'x5@c.in', type: 'CLIENT', roleKey: 'CLIENT_ADMIN', companyIds: [] }), BadRequestException);
});

test('duplicate email and weak chosen passwords are rejected', async () => {
  await assert.rejects(svc.create(admin, { name: 'X', email: 'S1@firm.in', type: 'CONSULTANT', roleKey: 'CONSULTANT_STAFF', companyIds: ['A1'] }), ConflictException);
  await assert.rejects(svc.create(admin, { name: 'X', email: 'weak@c.in', type: 'CLIENT', roleKey: 'CLIENT_HR', companyIds: ['A1'], password: 'short' }), BadRequestException);
});

test('user lists never expose another firm\'s people', async () => {
  const l: any = await svc.list(admin, { page: 1, pageSize: 50 });
  const ids = l.items.map((i: any) => i.id);
  assert.ok(ids.includes('staff1'));
  assert.ok(!ids.includes('foreign'));
  assert.ok(!ids.includes('foreignClient'));
  await assert.rejects(svc.update(admin, 'foreign', { active: false }), NotFoundException);
  await assert.rejects(svc.resetPassword(admin, 'foreignClient'), NotFoundException);
});

test('only firm admins can manage users; clients and other types are refused', async () => {
  await assert.rejects(svc.list({ ...admin, type: 'CLIENT', consultantId: null }, { page: 1, pageSize: 10 }), ForbiddenException);
  await assert.rejects(svc.create({ ...admin, type: 'SUPER_ADMIN', consultantId: null }, { name: 'X', email: 'x6@c.in', type: 'CLIENT', roleKey: 'CLIENT_ADMIN', companyIds: ['A1'] }), ForbiddenException);
});

test('role or company changes end the user\'s sessions and are audited as permission changes', async () => {
  revoked.length = 0; audits.length = 0;
  const r: any = await svc.update(admin, 'staff1', { roleKey: 'PAYROLL_OPERATOR', companyIds: ['A1', 'A2'] });
  assert.deepEqual(r.roles, ['PAYROLL_OPERATOR']);
  assert.equal(r.companies.length, 2);
  assert.ok(revoked.includes('staff1'));
  assert.ok(audits.some((a) => a.action === 'USER_PERMISSION_CHANGED'));
});

test('you cannot demote or deactivate yourself', async () => {
  await assert.rejects(svc.update(admin, 'admin1', { active: false }), BadRequestException);
  await assert.rejects(svc.update(admin, 'admin1', { roleKey: 'CONSULTANT_STAFF' }), BadRequestException);
});

test('the last active consultant admin cannot be demoted or deactivated by someone else', async () => {
  // A delegate with users.manage (not an admin) acts on admin1. With a second active admin it is allowed; without, refused.
  const delegate: AuthUser = { id: 'delegate', type: 'CONSULTANT', consultantId: 'C1', roles: ['CONSULTANT_STAFF'], permissions: ['users.manage'] };
  users.push({ id: 'admin2', name: 'Second', email: 'a2@firm.in', type: 'CONSULTANT', consultantId: 'C1', active: true, mustChangePassword: false, passwordHash: 'x', lastLoginAt: null, roleKeys: ['CONSULTANT_ADMIN'], links: [] });
  await svc.update(delegate, 'admin2', { active: false }); // admin1 is still active, so this is fine
  await assert.rejects(svc.update(delegate, 'admin1', { active: false }), (e: any) => e instanceof BadRequestException && e.message.includes('At least one active consultant admin'));
  await assert.rejects(svc.update(delegate, 'admin1', { roleKey: 'CONSULTANT_STAFF' }), BadRequestException);
});

test('password reset issues a new one-time password, forces a change and ends sessions', async () => {
  revoked.length = 0;
  const r = await svc.resetPassword(admin, 'staff1');
  assert.ok(r.temporaryPassword);
  const s = users.find((u) => u.id === 'staff1')!;
  assert.equal(s.mustChangePassword, true);
  assert.ok(await bcrypt.compare(r.temporaryPassword, s.passwordHash));
  assert.ok(revoked.includes('staff1'));
  await assert.rejects(svc.resetPassword(admin, 'admin1'), BadRequestException); // own account
});
