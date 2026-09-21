import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, UserType } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth.types';
import { CompanyAccessService } from '../common/company-access';
import { generateTempPassword, passwordProblems } from '../common/password';
import { PrismaService } from '../prisma/prisma.service';

/** Roles a firm admin may hand out. SUPER_ADMIN is never assignable through the API. */
export const ROLES_FOR: Record<'CONSULTANT' | 'CLIENT', string[]> = {
  CONSULTANT: ['CONSULTANT_ADMIN', 'CONSULTANT_STAFF', 'PAYROLL_OPERATOR', 'COMPLIANCE_OPERATOR', 'READ_ONLY'],
  CLIENT: ['CLIENT_ADMIN', 'CLIENT_HR', 'READ_ONLY'],
};

const include = { roles: { include: { role: true } }, companyAccess: { include: { company: { select: { id: true, name: true, code: true } } } } } satisfies Prisma.UserInclude;
type UserRow = Prisma.UserGetPayload<{ include: typeof include }>;

const present = (u: UserRow) => ({
  id: u.id, name: u.name, email: u.email, type: u.type, active: u.active, mustChangePassword: u.mustChangePassword, lastLoginAt: u.lastLoginAt,
  roles: u.roles.map((r) => r.role.key), companies: u.companyAccess.map((c) => c.company),
});

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService, private audit: AuditService, private access: CompanyAccessService) {}

  /** Only firm admins with a consultant account manage users, and only within their own firm. */
  private firm(u: AuthUser): string {
    if (u.type !== 'CONSULTANT' || !u.consultantId) throw new ForbiddenException('Only a consultant admin can manage users');
    return u.consultantId;
  }

  /** The firm's staff, plus client users linked to the firm's companies. Nobody else is ever visible. */
  private scope(consultantId: string): Prisma.UserWhereInput {
    return { OR: [{ consultantId }, { type: 'CLIENT', companyAccess: { some: { company: { consultantId } } } }] };
  }

  async list(u: AuthUser, q: { search?: string; page: number; pageSize: number }) {
    const where: Prisma.UserWhereInput = {
      AND: [this.scope(this.firm(u)), q.search ? { OR: [{ name: { contains: q.search, mode: 'insensitive' } }, { email: { contains: q.search, mode: 'insensitive' } }] } : {}],
    };
    const [total, rows] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({ where, include, orderBy: { name: 'asc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { total, page: q.page, pageSize: q.pageSize, items: rows.map(present) };
  }

  roleOptions() { return ROLES_FOR; }

  private async checkCompanies(u: AuthUser, ids: string[]) {
    for (const id of ids) await this.access.assertAccess(u, id); // 404 for companies the admin cannot see
  }

  private async load(u: AuthUser, id: string) {
    const row = await this.prisma.user.findFirst({ where: { AND: [{ id }, this.scope(this.firm(u))] }, include });
    if (!row) throw new NotFoundException('User not found');
    return row;
  }

  private async otherActiveAdmins(consultantId: string, exceptId: string) {
    return this.prisma.user.count({ where: { consultantId, active: true, id: { not: exceptId }, roles: { some: { role: { key: 'CONSULTANT_ADMIN' } } } } });
  }

  async create(u: AuthUser, d: { name: string; email: string; type: 'CONSULTANT' | 'CLIENT'; roleKey: string; companyIds?: string[]; password?: string }, ip?: string) {
    const consultantId = this.firm(u);
    if (!ROLES_FOR[d.type].includes(d.roleKey)) throw new BadRequestException(`${d.roleKey} cannot be given to a ${d.type.toLowerCase()} user`);
    const companyIds = [...new Set(d.companyIds ?? [])];
    const needsCompanies = !(d.type === 'CONSULTANT' && d.roleKey === 'CONSULTANT_ADMIN');
    if (needsCompanies && companyIds.length === 0) throw new BadRequestException('Choose at least one company for this user');
    await this.checkCompanies(u, companyIds);

    const email = d.email.toLowerCase().trim();
    if (await this.prisma.user.findUnique({ where: { email }, select: { id: true } })) throw new ConflictException('A user with this email already exists');
    if (d.password) {
      const p = passwordProblems(d.password, email);
      if (p.length) throw new BadRequestException({ message: p.join('. '), errors: p });
    }
    const temporary = d.password ? null : generateTempPassword();
    const role = await this.prisma.role.findUniqueOrThrow({ where: { key: d.roleKey } });
    const created = await this.prisma.user.create({
      data: {
        name: d.name.trim(), email, type: d.type as UserType, consultantId: d.type === 'CONSULTANT' ? consultantId : null, // client users hold no firm id
        passwordHash: await bcrypt.hash(d.password ?? temporary!, 12), mustChangePassword: true,
        roles: { create: [{ roleId: role.id }] },
        companyAccess: needsCompanies ? { create: companyIds.map((companyId) => ({ companyId })) } : undefined,
      },
      include,
    });
    await this.audit.log({ userId: u.id, action: 'USER_CREATED', module: 'users', recordId: created.id, newValue: { email, type: d.type, role: d.roleKey, companies: companyIds }, ip });
    return { user: present(created), ...(temporary ? { temporaryPassword: temporary } : {}) };
  }

  async update(u: AuthUser, id: string, d: { name?: string; active?: boolean; roleKey?: string; companyIds?: string[] }, ip?: string) {
    const consultantId = this.firm(u);
    const target = await this.load(u, id);
    const oldRole = target.roles[0]?.role.key;
    const roleChanges = d.roleKey !== undefined && d.roleKey !== oldRole;
    const deactivating = d.active === false && target.active;
    if (target.id === u.id && (roleChanges || d.active === false)) throw new BadRequestException('You cannot change your own role or deactivate yourself');

    const kind = target.type === 'CLIENT' ? 'CLIENT' : 'CONSULTANT';
    if (roleChanges && !ROLES_FOR[kind].includes(d.roleKey!)) throw new BadRequestException(`${d.roleKey} cannot be given to a ${kind.toLowerCase()} user`);
    if (oldRole === 'CONSULTANT_ADMIN' && (roleChanges || deactivating) && (await this.otherActiveAdmins(consultantId, target.id)) === 0) {
      throw new BadRequestException('At least one active consultant admin must remain');
    }

    // Links to companies this admin cannot see are left untouched; the rest follow the request.
    let links: string[] | undefined;
    if (d.companyIds) {
      const wanted = [...new Set(d.companyIds)];
      await this.checkCompanies(u, wanted);
      const visible = await this.access.accessibleCompanyIds(u);
      const hidden = target.companyAccess.map((c) => c.companyId).filter((cid) => visible !== 'ALL' && !visible.includes(cid));
      links = [...new Set([...wanted, ...hidden])];
      if (links.length === 0 && oldRole !== 'CONSULTANT_ADMIN') throw new BadRequestException('Choose at least one company for this user');
    }
    const role = roleChanges ? await this.prisma.role.findUniqueOrThrow({ where: { key: d.roleKey! } }) : null;
    const sessionsMustEnd = roleChanges || deactivating || links !== undefined;

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { ...(d.name ? { name: d.name.trim() } : {}), ...(d.active !== undefined ? { active: d.active } : {}) } });
      if (role) { await tx.userRole.deleteMany({ where: { userId: id } }); await tx.userRole.create({ data: { userId: id, roleId: role.id } }); }
      if (links) { await tx.companyUser.deleteMany({ where: { userId: id } }); await tx.companyUser.createMany({ data: links.map((companyId) => ({ userId: id, companyId })) }); }
      // Permissions are baked into short-lived tokens, so end refresh capability to make the change bite within minutes.
      if (sessionsMustEnd) await tx.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    });
    const fresh = await this.load(u, id);
    await this.audit.log({
      userId: u.id, action: roleChanges ? 'USER_PERMISSION_CHANGED' : 'USER_UPDATED', module: 'users', recordId: id,
      oldValue: { role: oldRole, active: target.active, companies: target.companyAccess.map((c) => c.companyId) },
      newValue: { role: fresh.roles[0]?.role.key, active: fresh.active, companies: fresh.companyAccess.map((c) => c.companyId) }, ip,
    });
    return present(fresh);
  }

  /** Issues a new one-time password. The user must replace it at next sign-in. */
  async resetPassword(u: AuthUser, id: string, ip?: string) {
    this.firm(u);
    const target = await this.load(u, id);
    if (target.id === u.id) throw new BadRequestException('Use "Change password" for your own account');
    const temporary = generateTempPassword();
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id }, data: { passwordHash: await bcrypt.hash(temporary, 12), mustChangePassword: true, failedLogins: 0, lockedUntil: null } }),
      this.prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    await this.audit.log({ userId: u.id, action: 'USER_PASSWORD_RESET', module: 'users', recordId: id, ip });
    return { temporaryPassword: temporary };
  }
}
