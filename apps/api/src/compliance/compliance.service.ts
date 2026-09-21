import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ComplianceModule, Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth.types';
import { CompanyAccessService } from '../common/company-access';
import { PrismaService } from '../prisma/prisma.service';
import { calcESI, calcLWF, calcPF, calcPT, calcTDS, Module, pickRule, StatRule } from '../payroll/statutory';
import { addDays, computeStatus, DUE_SOON_DAYS, dueDateFor } from './compliance-tasks';
import { RuleBody, validateRule } from './rule-validate';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const ymd = (s: string) => new Date(`${s}T00:00:00.000Z`);
const n = (d: Prisma.Decimal | number | null | undefined) => (d == null ? null : Number(d));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const PAYROLL_BASED: ComplianceModule[] = ['PF', 'ESI', 'PT', 'LWF', 'TDS'];
const SETTING_FLAG: Record<string, string> = { PF: 'pfEnabled', ESI: 'esiEnabled', PT: 'ptEnabled', LWF: 'lwfEnabled', TDS: 'tdsEnabled', BONUS: 'bonusEnabled', GRATUITY: 'gratuityEnabled', MINIMUM_WAGE: 'minimumWageEnabled' };

export const toStatRule = (r: any, own: boolean): StatRule => ({
  id: r.id, module: r.module, state: r.state, version: r.version, effectiveFrom: iso(r.effectiveFrom), effectiveTo: r.effectiveTo ? iso(r.effectiveTo) : null,
  wageCeiling: n(r.wageCeiling), threshold: n(r.threshold), employeePercent: n(r.employeePercent), employerPercent: n(r.employerPercent),
  slabs: r.slabs, rules: r.rules, own,
});

@Injectable()
export class ComplianceService {
  constructor(private prisma: PrismaService, private audit: AuditService, private access: CompanyAccessService) {}

  // ───────── Compliance master: versioned rules ─────────
  /** Platform defaults plus the caller's own consultant rules. Never another consultant's. */
  private visibleWhere(u: AuthUser): Prisma.ComplianceRuleWhereInput {
    return { OR: [{ consultantId: null }, ...(u.consultantId ? [{ consultantId: u.consultantId }] : [])] };
  }

  async listRules(u: AuthUser, q: { module?: string; state?: string }) {
    const rows = await this.prisma.complianceRule.findMany({
      where: { AND: [this.visibleWhere(u), q.module ? { module: q.module as ComplianceModule } : {}, q.state ? { state: { equals: q.state, mode: 'insensitive' } } : {}] },
      orderBy: [{ module: 'asc' }, { state: 'asc' }, { version: 'desc' }],
    });
    return rows.map((r) => ({ ...r, scope: r.consultantId ? 'OWN' : 'PLATFORM', editable: u.type === 'SUPER_ADMIN' ? !r.consultantId : r.consultantId === u.consultantId }));
  }

  /**
   * Rules are immutable. A change is a NEW version that takes effect from a date; the previous version is closed the
   * day before. Super admins maintain platform defaults; consultants maintain only their own overrides.
   */
  async createRule(u: AuthUser, d: RuleBody & { notes?: string }, ip?: string) {
    const errors = validateRule(d);
    if (errors.length) throw new BadRequestException({ message: errors.join('; '), errors });
    const consultantId = u.type === 'SUPER_ADMIN' ? null : u.consultantId;
    if (u.type !== 'SUPER_ADMIN' && !consultantId) throw new ForbiddenException();
    const state = d.state?.trim() ? d.state.trim() : null;
    const from = ymd(d.effectiveFrom);

    const row = await this.prisma.$transaction(async (tx) => {
      const latest = await tx.complianceRule.findFirst({ where: { consultantId, module: d.module as ComplianceModule, state }, orderBy: { version: 'desc' } });
      if (latest && from <= latest.effectiveFrom) throw new BadRequestException(`Effective date must be after the current version starts (${iso(latest.effectiveFrom)})`);
      if (latest && (!latest.effectiveTo || latest.effectiveTo >= from)) {
        await tx.complianceRule.update({ where: { id: latest.id }, data: { effectiveTo: new Date(from.getTime() - 86_400_000) } });
      }
      const created = await tx.complianceRule.create({
        data: {
          consultantId, module: d.module as ComplianceModule, state, version: (latest?.version ?? 0) + 1, effectiveFrom: from,
          wageCeiling: d.wageCeiling ?? null, threshold: d.threshold ?? null, employeePercent: d.employeePercent ?? null, employerPercent: d.employerPercent ?? null,
          slabs: (d.slabs ?? Prisma.DbNull) as any, rules: (d.rules ?? Prisma.DbNull) as any, notes: d.notes, createdBy: u.id,
        },
      });
      await tx.auditLog.create({ data: { userId: u.id, action: 'COMPLIANCE_RULE_CREATED', module: 'compliance', recordId: created.id, oldValue: latest as any, newValue: created as any, ip } });
      return created;
    });
    return row;
  }

  /** Try a rule on a hypothetical wage without touching any payroll. */
  async preview(u: AuthUser, d: { module: string; state?: string; asOf: string; wage: number; month: number; annualTaxable?: number; tdsYtd?: number; monthsRemaining?: number }) {
    const rows = await this.prisma.complianceRule.findMany({ where: { AND: [this.visibleWhere(u), { module: d.module as ComplianceModule }] } });
    const rules = rows.map((r) => toStatRule(r, r.consultantId !== null));
    const rule = pickRule(rules, d.module as Module, d.state ?? null, d.asOf);
    if (!rule) return { found: false, message: `No ${d.module} rule in force for ${d.state || 'central'} on ${d.asOf}` };
    let res: { employee: number; employer: number; note?: string } | null = null;
    if (d.module === 'PF') res = calcPF(d.wage, rule);
    else if (d.module === 'ESI') res = calcESI(d.wage, rule);
    else if (d.module === 'PT') res = calcPT(d.wage, d.month, rule);
    else if (d.module === 'LWF') res = calcLWF(d.month, rule);
    else if (d.module === 'TDS') res = calcTDS({ annualTaxable: d.annualTaxable ?? d.wage * 12, tdsYtd: d.tdsYtd ?? 0, monthsRemaining: d.monthsRemaining ?? 12 }, rule);
    else return { found: true, ruleId: rule.id, version: rule.version, message: 'This module has no automatic calculation' };
    return { found: true, ruleId: rule.id, version: rule.version, covered: res !== null, employee: res?.employee ?? 0, employer: res?.employer ?? 0, note: res?.note };
  }

  // ───────── Registrations ─────────
  listRegistrations(companyId: string) { return this.prisma.complianceRegistration.findMany({ where: { companyId }, orderBy: [{ module: 'asc' }, { state: 'asc' }] }); }

  async saveRegistration(u: AuthUser, companyId: string, d: { id?: string; module: string; number: string; state?: string; details?: object }, ip?: string) {
    const data = { module: d.module as ComplianceModule, number: d.number.trim(), state: d.state?.trim() || null, details: (d.details ?? Prisma.DbNull) as any };
    let row;
    if (d.id) {
      const old = await this.prisma.complianceRegistration.findFirst({ where: { id: d.id, companyId } });
      if (!old) throw new NotFoundException('Registration not found');
      row = await this.prisma.complianceRegistration.update({ where: { id: d.id }, data });
      await this.audit.log({ userId: u.id, companyId, action: 'COMPLIANCE_REGISTRATION_UPDATED', module: 'compliance', recordId: d.id, oldValue: old, newValue: row, ip });
    } else {
      row = await this.prisma.complianceRegistration.create({ data: { ...data, companyId } });
      await this.audit.log({ userId: u.id, companyId, action: 'COMPLIANCE_REGISTRATION_CREATED', module: 'compliance', recordId: row.id, newValue: row, ip });
    }
    return row;
  }

  async deleteRegistration(u: AuthUser, companyId: string, id: string, ip?: string) {
    const old = await this.prisma.complianceRegistration.findFirst({ where: { id, companyId } });
    if (!old) throw new NotFoundException('Registration not found');
    await this.prisma.complianceRegistration.delete({ where: { id } });
    await this.audit.log({ userId: u.id, companyId, action: 'COMPLIANCE_REGISTRATION_DELETED', module: 'compliance', recordId: id, oldValue: old, ip });
    return { ok: true };
  }

  // ───────── Tasks / calendar ─────────
  /** Creates the month's filing tasks for every enabled module, using due days stored on the rules (never hard-coded). */
  async generate(u: AuthUser, companyId: string, year: number, month: number, ip?: string) {
    const [company, settings] = await Promise.all([
      this.prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { state: true, consultantId: true } }),
      this.prisma.companySettings.findUnique({ where: { companyId } }),
    ]);
    const end = `${year}-${String(month).padStart(2, '0')}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, '0')}`;
    const rows = await this.prisma.complianceRule.findMany({ where: { effectiveFrom: { lte: ymd(end) }, OR: [{ consultantId: null }, { consultantId: company.consultantId }] } });
    const rules = rows.map((r) => toStatRule(r, r.consultantId !== null));
    const existing = new Set((await this.prisma.complianceTask.findMany({ where: { companyId, periodYear: year, periodMonth: month }, select: { module: true } })).map((t) => t.module));
    const created: string[] = [];
    const skipped: { module: string; reason: string }[] = [];
    const today = iso(new Date());

    for (const [module, flag] of Object.entries(SETTING_FLAG)) {
      if (!(settings as any)?.[flag]) continue;
      if (existing.has(module as ComplianceModule)) { skipped.push({ module, reason: 'Already generated' }); continue; }
      const rule = pickRule(rules, module as Module, company.state, end);
      const dueDay = rule?.rules?.dueDay;
      if (!rule) { skipped.push({ module, reason: 'No rule configured' }); continue; }
      if (!dueDay) { skipped.push({ module, reason: 'Rule has no due day (rules.dueDay)' }); continue; }
      const months: number[] | undefined = rule.rules?.months;
      if (months && !months.includes(month)) { skipped.push({ module, reason: 'Not due for this period' }); continue; }
      const dueDate = dueDateFor(year, month, Number(dueDay), Number(rule.rules?.dueMonthOffset ?? 1));
      await this.prisma.complianceTask.create({ data: { companyId, module: module as ComplianceModule, name: `${module} - ${MONTHS[month - 1]} ${year}`, periodYear: year, periodMonth: month, dueDate: ymd(dueDate), status: computeStatus(today, dueDate, year, month, false) } });
      created.push(module);
    }
    await this.audit.log({ userId: u.id, companyId, action: 'COMPLIANCE_TASKS_GENERATED', module: 'compliance', recordId: `${year}-${month}`, newValue: { created, skipped }, ip });
    return { created, skipped };
  }

  /** Persists derived statuses so dashboards and filters can rely on the column. */
  async refreshStatuses(companyIds: string[] | 'ALL') {
    const today = iso(new Date());
    const soon = ymd(addDays(today, DUE_SOON_DAYS));
    const t = ymd(today);
    const [y, m] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
    const scope: Prisma.ComplianceTaskWhereInput = { status: { not: 'COMPLETED' }, ...(companyIds === 'ALL' ? {} : { companyId: { in: companyIds } }) };
    const ended: Prisma.ComplianceTaskWhereInput = { OR: [{ periodYear: { lt: y } }, { periodYear: y, periodMonth: { lt: m } }] };
    await this.prisma.$transaction([
      this.prisma.complianceTask.updateMany({ where: { ...scope, dueDate: { lt: t } }, data: { status: 'OVERDUE' } }),
      this.prisma.complianceTask.updateMany({ where: { ...scope, dueDate: { gte: t, lte: soon } }, data: { status: 'DUE_SOON' } }),
      this.prisma.complianceTask.updateMany({ where: { AND: [scope, ended], dueDate: { gt: soon } }, data: { status: 'PENDING' } }),
      this.prisma.complianceTask.updateMany({ where: { AND: [scope, { NOT: ended }], dueDate: { gt: soon } }, data: { status: 'UPCOMING' } }),
    ]);
  }

  /** Central calendar across every company the caller may access, optionally narrowed to one company. */
  async calendar(u: AuthUser, q: { companyId?: string; year?: number; month?: number; status?: string; module?: string; page: number; pageSize: number }) {
    let scope: string[] | 'ALL';
    if (q.companyId) { await this.access.assertAccess(u, q.companyId); scope = [q.companyId]; } else scope = await this.access.accessibleCompanyIds(u);
    await this.refreshStatuses(scope);
    const where: Prisma.ComplianceTaskWhereInput = {
      ...(scope === 'ALL' ? {} : { companyId: { in: scope } }),
      ...(q.status ? { status: q.status as any } : {}), ...(q.module ? { module: q.module as ComplianceModule } : {}),
      ...(q.year && q.month ? { dueDate: { gte: ymd(`${q.year}-${String(q.month).padStart(2, '0')}-01`), lt: ymd(new Date(Date.UTC(q.year, q.month, 1)).toISOString().slice(0, 10)) } } : {}),
    };
    const [total, items] = await Promise.all([
      this.prisma.complianceTask.count({ where }),
      this.prisma.complianceTask.findMany({ where, orderBy: [{ dueDate: 'asc' }, { module: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { company: { select: { name: true, code: true } } } }),
    ]);
    const uids = [...new Set(items.map((i) => i.assignedTo).filter(Boolean) as string[])];
    const users = new Map((await this.prisma.user.findMany({ where: { id: { in: uids } }, select: { id: true, name: true } })).map((x) => [x.id, x.name]));
    return { total, page: q.page, pageSize: q.pageSize, items: items.map((i) => (u.type === 'CLIENT' ? { ...i, assignedTo: null, assignedName: null } : { ...i, assignedName: i.assignedTo ? users.get(i.assignedTo) ?? null : null })) };
  }

  private async task(u: AuthUser, id: string) {
    const t = await this.prisma.complianceTask.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Task not found');
    await this.access.assertAccess(u, t.companyId); // 404 if the caller cannot access that company
    return t;
  }

  /** People who could be assigned: the consultant's admins plus users explicitly linked to the company. */
  async assignees(u: AuthUser, id: string) {
    const t = await this.task(u, id);
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: t.companyId }, select: { consultantId: true } });
    return this.prisma.user.findMany({
      where: { active: true, OR: [{ companyAccess: { some: { companyId: t.companyId } } }, { consultantId: company.consultantId, roles: { some: { role: { key: 'CONSULTANT_ADMIN' } } } }] },
      select: { id: true, name: true }, orderBy: { name: 'asc' }, take: 100,
    });
  }

  async assign(u: AuthUser, id: string, userId: string | null, ip?: string) {
    const t = await this.task(u, id);
    if (userId) {
      const target = await this.prisma.user.findFirst({ where: { id: userId, active: true }, include: { roles: { include: { role: true } } } });
      if (!target) throw new BadRequestException('Unknown user');
      const ids = await this.access.accessibleCompanyIds({ id: target.id, type: target.type, consultantId: target.consultantId, roles: target.roles.map((r) => r.role.key), permissions: [] });
      if (ids !== 'ALL' && !ids.includes(t.companyId)) throw new BadRequestException('That user has no access to this company');
    }
    const row = await this.prisma.complianceTask.update({ where: { id }, data: { assignedTo: userId } });
    await this.audit.log({ userId: u.id, companyId: t.companyId, action: 'COMPLIANCE_TASK_ASSIGNED', module: 'compliance', recordId: id, oldValue: { assignedTo: t.assignedTo }, newValue: { assignedTo: userId }, ip });
    return row;
  }

  async complete(u: AuthUser, id: string, d: { challanRef?: string }, ip?: string) {
    const t = await this.task(u, id);
    if (t.status === 'COMPLETED') throw new ConflictException('Already completed');
    if (PAYROLL_BASED.includes(t.module) && t.periodMonth) {
      const run = await this.prisma.payrollRun.findFirst({ where: { companyId: t.companyId, year: t.periodYear, month: t.periodMonth, type: 'MONTHLY', status: { in: ['APPROVED', 'LOCKED'] } } });
      if (!run) throw new ConflictException(`Payroll for ${t.periodMonth}/${t.periodYear} must be approved before this filing can be marked complete`);
    }
    const row = await this.prisma.complianceTask.update({ where: { id }, data: { status: 'COMPLETED', completedAt: new Date(), challanRef: d.challanRef?.trim() || null } });
    await this.audit.log({ userId: u.id, companyId: t.companyId, action: 'COMPLIANCE_COMPLETED', module: 'compliance', recordId: id, oldValue: { status: t.status }, newValue: { status: 'COMPLETED', challanRef: row.challanRef }, ip });
    return row;
  }

  async reopen(u: AuthUser, id: string, ip?: string) {
    const t = await this.task(u, id);
    if (t.status !== 'COMPLETED') throw new ConflictException('Task is not completed');
    const dueDate = iso(t.dueDate);
    const status = computeStatus(iso(new Date()), dueDate, t.periodYear, t.periodMonth, false);
    const row = await this.prisma.complianceTask.update({ where: { id }, data: { status, completedAt: null, challanRef: null } });
    await this.audit.log({ userId: u.id, companyId: t.companyId, action: 'COMPLIANCE_REOPENED', module: 'compliance', recordId: id, oldValue: { status: 'COMPLETED', challanRef: t.challanRef }, newValue: { status }, ip });
    return row;
  }

  // ───────── Statutory totals for a period (feeds returns; full reports arrive in Phase 7) ─────────
  async summary(companyId: string, year: number, month: number) {
    const run = await this.prisma.payrollRun.findFirst({ where: { companyId, year, month, type: 'MONTHLY' }, select: { id: true, status: true } });
    if (!run) return { runStatus: null, modules: [] };
    const g = await this.prisma.payrollDeduction.groupBy({
      by: ['code'], where: { code: { in: ['PF', 'ESI', 'PT', 'LWF', 'TDS'] }, detail: { payrollRunId: run.id } },
      _sum: { amount: true, employerAmount: true }, _count: { _all: true },
    });
    return {
      runStatus: run.status, final: run.status === 'APPROVED' || run.status === 'LOCKED',
      modules: g.map((r) => {
        const employee = Number(r._sum.amount ?? 0), employer = Number(r._sum.employerAmount ?? 0);
        return { module: r.code, employees: r._count._all, employee, employer, total: employee + employer };
      }),
    };
  }
}
