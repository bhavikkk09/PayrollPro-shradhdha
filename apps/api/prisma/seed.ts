import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PERMISSIONS, ROLE_MATRIX } from '../src/common/permissions';

const prisma = new PrismaClient();

async function main() {
  // Permissions + roles
  for (const key of PERMISSIONS) {
    await prisma.permission.upsert({ where: { key }, update: {}, create: { key, module: key.split('.')[0] } });
  }
  for (const [key, def] of Object.entries(ROLE_MATRIX)) {
    const role = await prisma.role.upsert({ where: { key }, update: { name: def.name }, create: { key, name: def.name } });
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    const perms = await prisma.permission.findMany({ where: { key: { in: def.permissions } } });
    await prisma.rolePermission.createMany({ data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })) });
  }
  const roleId = async (key: string) => (await prisma.role.findUniqueOrThrow({ where: { key } })).id;

  // Demo consultant + admin (DEMO ONLY: change password immediately in real use)
  const consultant = await prisma.consultant.upsert({
    where: { email: 'office@demo-consultant.in' }, update: {},
    create: { name: 'Demo Labour Consultants', email: 'office@demo-consultant.in' },
  });
  const hash = await bcrypt.hash(process.env.SEED_ADMIN_PASSWORD ?? 'Admin@12345', 12);
  const admin = await prisma.user.upsert({
    where: { email: 'admin@demo-consultant.in' }, update: {},
    create: { email: 'admin@demo-consultant.in', name: 'Consultant Admin', type: 'CONSULTANT', consultantId: consultant.id, passwordHash: hash },
  });
  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: admin.id, roleId: await roleId('CONSULTANT_ADMIN') } },
    update: {}, create: { userId: admin.id, roleId: await roleId('CONSULTANT_ADMIN') },
  });

  // Demo companies (shift management stays disabled by default)
  const demo = [
    { code: 'ABC', name: 'ABC Industries', city: 'Rajkot', state: 'Gujarat' },
    { code: 'XYZ', name: 'XYZ Pvt Ltd', city: 'Ahmedabad', state: 'Gujarat' },
    { code: 'SHREE', name: 'Shree Engineering', city: 'Surat', state: 'Gujarat' },
  ];
  for (const c of demo) {
    await prisma.company.upsert({
      where: { consultantId_code: { consultantId: consultant.id, code: c.code } }, update: {},
      create: { ...c, consultantId: consultant.id, settings: { create: {} } },
    });
  }

  // Versioned compliance rules. SAMPLE VALUES ONLY: a compliance administrator must
  // verify against current law and add new versions (never edit old ones) when rates change.
  const rules = [
    { module: 'PF', state: null, version: 1, wageCeiling: 15000, employeePercent: 12, employerPercent: 12, notes: 'SAMPLE - verify against current EPFO rules' },
    { module: 'ESI', state: null, version: 1, wageCeiling: 21000, employeePercent: 0.75, employerPercent: 3.25, notes: 'SAMPLE - verify against current ESIC rules' },
  ] as const;
  for (const r of rules) {
    const exists = await prisma.complianceRule.findFirst({ where: { module: r.module, state: r.state, version: r.version } });
    if (!exists) await prisma.complianceRule.create({ data: { ...r, effectiveFrom: new Date('2024-04-01') } });
  }
  console.log('Seed complete. Login: admin@demo-consultant.in');
}

main().finally(() => prisma.$disconnect());
