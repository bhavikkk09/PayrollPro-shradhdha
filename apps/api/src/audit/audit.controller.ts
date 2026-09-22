import { Controller, Get, Injectable, Query, Req, Res, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { Request, Response } from 'express';
import { AuthUser } from '../common/auth.types';
import { CompanyAccessService } from '../common/company-access';
import { CurrentUser, InternalOnly, RequirePermissions } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { toCsv } from '../reports/csv';
import { makeReport } from '../reports/types';
import { AuditService } from './audit.service';

class AuditQuery {
  @IsOptional() @IsUUID() companyId?: string;
  @IsOptional() @IsUUID() userId?: string;
  @IsOptional() @IsString() @MaxLength(40) module?: string;
  @IsOptional() @IsString() @MaxLength(60) action?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsIn(['json', 'csv']) format: 'json' | 'csv' = 'json';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) pageSize = 50;
}

/** Read-only. There is deliberately no way to change or delete an audit entry through the API (or the database). */
@Injectable()
export class AuditQueryService {
  constructor(private prisma: PrismaService, private access: CompanyAccessService, private audit: AuditService) {}

  /** Entries about companies the caller may access, plus activity of the firm's staff and its client users (sign-ins, user changes). */
  private async scope(u: AuthUser, companyId?: string) {
    if (companyId) { await this.access.assertAccess(u, companyId); return { companyId }; }
    if (u.type === 'SUPER_ADMIN') return {};
    const [ids, firm] = await Promise.all([
      this.access.accessibleCompanyIds(u),
      this.prisma.user.findMany({ where: { OR: [{ consultantId: u.consultantId ?? '__none__' }, { type: 'CLIENT', companyAccess: { some: { company: { consultantId: u.consultantId ?? '__none__' } } } }] }, select: { id: true } }),
    ]);
    return { OR: [{ companyId: { in: ids === 'ALL' ? [] : ids } }, { userId: { in: firm.map((x) => x.id) } }] };
  }

  private async where(u: AuthUser, q: AuditQuery) {
    return {
      AND: [
        await this.scope(u, q.companyId),
        q.userId ? { userId: q.userId } : {}, q.module ? { module: q.module } : {}, q.action ? { action: { contains: q.action, mode: 'insensitive' as const } } : {},
        q.from || q.to ? { createdAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } } : {},
      ],
    };
  }

  private async decorate(rows: { id: bigint; userId: string | null; companyId: string | null; action: string; module: string; recordId: string | null; oldValue: unknown; newValue: unknown; ip: string | null; createdAt: Date }[]) {
    const uids = [...new Set(rows.map((r) => r.userId).filter(Boolean) as string[])];
    const cids = [...new Set(rows.map((r) => r.companyId).filter(Boolean) as string[])];
    const [users, companies] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: uids } }, select: { id: true, name: true, email: true } }),
      this.prisma.company.findMany({ where: { id: { in: cids } }, select: { id: true, name: true } }),
    ]);
    const un = new Map(users.map((x) => [x.id, `${x.name} <${x.email}>`])), cn = new Map(companies.map((x) => [x.id, x.name]));
    return rows.map((r) => ({ ...r, id: String(r.id), user: r.userId ? un.get(r.userId) ?? r.userId : null, company: r.companyId ? cn.get(r.companyId) ?? null : null }));
  }

  async list(u: AuthUser, q: AuditQuery) {
    const where = await this.where(u, q);
    const [total, rows] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({ where, orderBy: { id: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { total, page: q.page, pageSize: q.pageSize, items: await this.decorate(rows) };
  }

  async modules(u: AuthUser) {
    const rows = await this.prisma.auditLog.groupBy({ by: ['module'], where: await this.scope(u), orderBy: { module: 'asc' } });
    return rows.map((r) => r.module);
  }

  async export(u: AuthUser, q: AuditQuery, ip?: string) {
    const where = await this.where(u, q);
    const rows = await this.decorate(await this.prisma.auditLog.findMany({ where, orderBy: { id: 'desc' }, take: 10_000 }));
    const report = makeReport('audit-log', 'Audit log', { company: { name: 'LabourConsultPro' }, subtitle: `${rows.length} entries`, provisional: false },
      ['time', 'user', 'company', 'module', 'action', 'record', 'ip', 'old value', 'new value'].map((l) => ({ key: l, label: l, type: 'text' as const })),
      rows.map((r) => ({ time: r.createdAt.toISOString(), user: r.user, company: r.company, module: r.module, action: r.action, record: r.recordId, ip: r.ip,
        'old value': r.oldValue == null ? '' : JSON.stringify(r.oldValue), 'new value': r.newValue == null ? '' : JSON.stringify(r.newValue) })));
    await this.audit.log({ userId: u.id, companyId: q.companyId, action: 'AUDIT_LOG_EXPORTED', module: 'audit', newValue: { rows: rows.length }, ip });
    return Buffer.from(toCsv(report), 'utf8');
  }
}

@ApiTags('Audit')
@ApiBearerAuth()
@InternalOnly()
@Controller('audit')
export class AuditController {
  constructor(private svc: AuditQueryService) {}

  @Get() @RequirePermissions('audit.view')
  async list(@CurrentUser() u: AuthUser, @Query() q: AuditQuery, @Req() r: Request, @Res({ passthrough: true }) res: Response) {
    if (q.format === 'csv') {
      res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="audit-log.csv"', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
      return new StreamableFile(await this.svc.export(u, q, r.ip));
    }
    return this.svc.list(u, q);
  }

  @Get('modules') @RequirePermissions('audit.view')
  modules(@CurrentUser() u: AuthUser) { return this.svc.modules(u); }
}
