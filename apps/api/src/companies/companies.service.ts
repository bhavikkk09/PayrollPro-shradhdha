import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth.types';
import { CompanyAccessService } from '../common/company-access';

@Injectable()
export class CompaniesService {
  constructor(private prisma: PrismaService, private access: CompanyAccessService, private audit: AuditService) {}

  /** Lists only companies the caller may access, paginated. */
  async list(user: AuthUser, q: { search?: string; status?: string; page: number; pageSize: number }) {
    const ids = await this.access.accessibleCompanyIds(user);
    const where: Prisma.CompanyWhereInput = {
      deletedAt: null,
      ...(ids === 'ALL' ? {} : { id: { in: ids } }),
      ...(q.status ? { status: q.status as any } : {}),
      ...(q.search
        ? { OR: [{ name: { contains: q.search, mode: 'insensitive' } }, { code: { contains: q.search, mode: 'insensitive' } }] }
        : {}),
    };
    const [total, items] = await Promise.all([
      this.prisma.company.count({ where }),
      this.prisma.company.findMany({
        where, orderBy: { name: 'asc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize,
        include: { _count: { select: { employees: { where: { status: 'ACTIVE' } } } } },
      }),
    ]);
    return { total, page: q.page, pageSize: q.pageSize, items };
  }

  get(companyId: string) {
    return this.prisma.company.findUniqueOrThrow({ where: { id: companyId }, include: { settings: true, registrations: true } });
  }

  async create(user: AuthUser, data: Prisma.CompanyUncheckedCreateInput, ip?: string) {
    if (!user.consultantId && user.type !== 'SUPER_ADMIN') throw new ForbiddenException();
    const consultantId = user.consultantId ?? data.consultantId;
    const dup = await this.prisma.company.findUnique({ where: { consultantId_code: { consultantId, code: data.code } } });
    if (dup) throw new ConflictException('Company code already exists');
    const company = await this.prisma.company.create({
      data: { ...data, consultantId, settings: { create: {} } }, // settings default: shift OFF
      include: { settings: true },
    });
    await this.audit.log({ userId: user.id, companyId: company.id, action: 'COMPANY_CREATED', module: 'company', recordId: company.id, newValue: company, ip });
    return company;
  }

  async update(user: AuthUser, companyId: string, data: Prisma.CompanyUpdateInput, ip?: string) {
    const old = await this.get(companyId);
    const updated = await this.prisma.company.update({ where: { id: companyId }, data });
    await this.audit.log({ userId: user.id, companyId, action: 'COMPANY_UPDATED', module: 'company', recordId: companyId, oldValue: old, newValue: updated, ip });
    return updated;
  }

  async updateSettings(user: AuthUser, companyId: string, data: Prisma.CompanySettingsUpdateInput, ip?: string) {
    const old = await this.prisma.companySettings.findUnique({ where: { companyId } });
    const updated = await this.prisma.companySettings.upsert({
      where: { companyId }, update: data, create: { ...(data as any), companyId },
    });
    await this.audit.log({ userId: user.id, companyId, action: 'COMPANY_SETTINGS_CHANGED', module: 'company', recordId: companyId, oldValue: old, newValue: updated, ip });
    return updated;
  }
}
