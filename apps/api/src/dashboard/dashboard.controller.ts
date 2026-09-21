import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermissions } from '../common/decorators';
import { AuthUser } from '../common/auth.types';
import { CompanyAccessService } from '../common/company-access';
import { ComplianceService } from '../compliance/compliance.service';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('Dashboard')
@ApiBearerAuth()
@Controller('dashboard')
export class DashboardController {
  constructor(private prisma: PrismaService, private access: CompanyAccessService, private compliance: ComplianceService) {}

  @Get('summary')
  @RequirePermissions('dashboard.view')
  async summary(@CurrentUser() u: AuthUser) {
    const ids = await this.access.accessibleCompanyIds(u);
    await this.compliance.refreshStatuses(ids); // keep OVERDUE/DUE_SOON current before counting
    const scope = ids === 'ALL' ? {} : { companyId: { in: ids } };
    const companyScope = ids === 'ALL' ? { deletedAt: null } : { deletedAt: null, id: { in: ids } };
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const soon = new Date(Date.now() + 7 * 86_400_000);

    const [companies, employees, runs, tasks, dueSoon, recentRuns, activity, attendance] = await Promise.all([
      this.prisma.company.findMany({
        where: companyScope, orderBy: { name: 'asc' }, take: 200,
        select: { id: true, name: true, code: true, status: true, _count: { select: { employees: { where: { status: 'ACTIVE' } } } } },
      }),
      this.prisma.employee.count({ where: { ...scope, status: 'ACTIVE', deletedAt: null } }),
      this.prisma.payrollRun.groupBy({ by: ['companyId', 'status'], where: { ...scope, year, month }, _count: true }),
      this.prisma.complianceTask.groupBy({ by: ['module', 'status'], where: { ...scope, status: { in: ['PENDING', 'OVERDUE', 'DUE_SOON'] } }, _count: true }),
      this.prisma.complianceTask.findMany({
        where: { ...scope, status: { not: 'COMPLETED' }, dueDate: { lte: soon } }, orderBy: { dueDate: 'asc' }, take: 10,
        include: { company: { select: { name: true } } },
      }),
      this.prisma.payrollRun.findMany({
        where: { ...scope, status: { in: ['APPROVED', 'LOCKED'] } }, orderBy: { updatedAt: 'desc' }, take: 5,
        include: { company: { select: { name: true } } },
      }),
      this.prisma.auditLog.findMany({ where: ids === 'ALL' ? {} : { companyId: { in: ids } }, orderBy: { createdAt: 'desc' }, take: 10 }),
      this.prisma.attendanceSummary.groupBy({ by: ['companyId'], where: { ...scope, year, month, finalized: true }, _count: true }),
    ]);

    const runByCompany = new Map(runs.map((r) => [r.companyId, r.status]));
    const attDone = new Set(attendance.map((a) => a.companyId));
    const compPending = new Map<string, number>();
    for (const t of tasks) compPending.set(t.module, (compPending.get(t.module) ?? 0) + t._count);

    const rows = companies.map((c) => {
      const payroll = runByCompany.get(c.id);
      const done = payroll === 'APPROVED' || payroll === 'LOCKED';
      return {
        id: c.id, name: c.name, employees: c._count.employees,
        attendance: attDone.has(c.id) ? 'Completed' : 'Pending',
        payroll: done ? 'Completed' : payroll ? 'In Progress' : 'Pending',
        status: done && attDone.has(c.id) ? 'OK' : !attDone.has(c.id) ? 'Action Required' : 'Warning',
      };
    });

    return {
      period: { year, month },
      totals: {
        companies: companies.length,
        activeCompanies: companies.filter((c) => c.status === 'ACTIVE').length,
        employees,
        payrollCompleted: rows.filter((r) => r.payroll === 'Completed').length,
        payrollPending: rows.filter((r) => r.payroll !== 'Completed').length,
        attendancePending: rows.filter((r) => r.attendance === 'Pending').length,
      },
      compliancePending: {
        PF: compPending.get('PF') ?? 0, ESI: compPending.get('ESI') ?? 0, PT: compPending.get('PT') ?? 0,
        LWF: compPending.get('LWF') ?? 0, TDS: compPending.get('TDS') ?? 0,
      },
      upcomingDue: dueSoon.map((t) => ({ id: t.id, company: t.company.name, name: t.name, module: t.module, dueDate: t.dueDate, status: t.status })),
      recentPayroll: recentRuns.map((r) => ({ id: r.id, company: r.company.name, year: r.year, month: r.month, status: r.status })),
      recentActivity: u.type === 'CLIENT' ? [] : activity.map((a) => ({ id: String(a.id), action: a.action, module: a.module, at: a.createdAt })),
      companies: rows,
    };
  }
}
