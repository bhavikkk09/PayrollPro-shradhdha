import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { CalcMethod, dateKey, daysInMonth, monthSalaryDivisor } from '../attendance/attendance-summary';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth.types';
import { CompanyAccessService } from '../common/company-access';
import { PrismaService } from '../prisma/prisma.service';
import { Adjustment, calculateEmployeePayroll, EmployeeInput, ENGINE_VERSION, EngineConfig, SalaryLineSnap } from './payroll-engine';
import { StatRule } from './statutory';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const ymd = (s: string) => new Date(`${s}T00:00:00.000Z`);
const n = (d: Prisma.Decimal | number | null | undefined) => Number(d ?? 0);
const period = (y: number, m: number) => ({ start: dateKey(y, m, 1), end: dateKey(y, m, daysInMonth(y, m)) });
const EDITABLE = ['DRAFT', 'CALCULATED', 'REVIEW'];
export interface Issue { employeeId: string; code: string; level: 'ERROR' | 'WARNING'; message: string }

@Injectable()
export class PayrollService {
  private log = new Logger('Payroll');
  constructor(private prisma: PrismaService, private audit: AuditService, private access: CompanyAccessService) {}

  // ───────── Runs ─────────
  listRuns(companyId: string, year?: number) {
    return this.prisma.payrollRun.findMany({ where: { companyId, ...(year ? { year } : {}) }, orderBy: [{ year: 'desc' }, { month: 'desc' }], take: 60, select: {
      id: true, year: true, month: true, type: true, status: true, totalGross: true, totalDeductions: true, totalNet: true, updatedAt: true, _count: { select: { details: true } },
    } });
  }

  async getRun(companyId: string, id: string) {
    const run = await this.prisma.payrollRun.findFirst({ where: { id, companyId }, include: { _count: { select: { details: true } } } });
    if (!run) throw new NotFoundException('Payroll run not found');
    return run;
  }

  async createRun(u: AuthUser, companyId: string, year: number, month: number, ip?: string) {
    try {
      const run = await this.prisma.payrollRun.create({ data: { companyId, year, month, type: 'MONTHLY', status: 'DRAFT', createdBy: u.id } });
      await this.audit.log({ userId: u.id, companyId, action: 'PAYROLL_RUN_CREATED', module: 'payroll', recordId: run.id, newValue: { year, month }, ip });
      return run;
    } catch (e: any) {
      if (e.code === 'P2002') throw new ConflictException('A payroll run already exists for this month');
      throw e;
    }
  }

  async deleteRun(u: AuthUser, companyId: string, id: string, ip?: string) {
    const run = await this.getRun(companyId, id);
    if (run.status !== 'DRAFT') throw new ConflictException('Only DRAFT runs can be deleted');
    await this.prisma.payrollRun.delete({ where: { id } });
    await this.audit.log({ userId: u.id, companyId, action: 'PAYROLL_RUN_DELETED', module: 'payroll', recordId: id, oldValue: { year: run.year, month: run.month }, ip });
    return { ok: true };
  }

  async details(companyId: string, runId: string, q: { page: number; pageSize: number; search?: string; warningsOnly?: boolean }) {
    await this.getRun(companyId, runId);
    const where: Prisma.PayrollDetailWhereInput = {
      payrollRunId: runId, companyId, ...(q.warningsOnly ? { hasWarnings: true } : {}),
      ...(q.search ? { employee: { OR: [{ code: { contains: q.search, mode: 'insensitive' } }, { firstName: { contains: q.search, mode: 'insensitive' } }, { lastName: { contains: q.search, mode: 'insensitive' } }] } } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.payrollDetail.count({ where }),
      this.prisma.payrollDetail.findMany({
        where, orderBy: { employee: { code: 'asc' } }, skip: (q.page - 1) * q.pageSize, take: q.pageSize,
        select: { id: true, employeeId: true, paidDays: true, lopDays: true, otHours: true, gross: true, totalDeductions: true, net: true, hasWarnings: true, employee: { select: { code: true, firstName: true, lastName: true } } },
      }),
    ]);
    return { total, page: q.page, pageSize: q.pageSize, items: rows };
  }

  async detail(companyId: string, runId: string, employeeId: string) {
    const d = await this.prisma.payrollDetail.findFirst({
      where: { payrollRunId: runId, employeeId, companyId },
      include: { earnings: true, deductions: true, employee: { select: { code: true, firstName: true, lastName: true } } },
    });
    if (!d) throw new NotFoundException('Payroll detail not found');
    return d;
  }

  // ───────── Calculation ─────────
  /** Recalculates the whole run. Allowed only before approval; the previous calculation is replaced atomically. */
  async process(u: AuthUser, companyId: string, runId: string, ip?: string) {
    const run = await this.getRun(companyId, runId);
    if (!EDITABLE.includes(run.status)) throw new ForbiddenException(`Payroll is ${run.status}; it cannot be recalculated`);
    await this.prisma.payrollRun.update({ where: { id: runId }, data: { status: 'PROCESSING' } });
    try {
      const out = await this.calculate(u, companyId, run.id, run.year, run.month);
      await this.audit.log({ userId: u.id, companyId, action: 'PAYROLL_PROCESSED', module: 'payroll', recordId: runId, newValue: out.summary, ip });
      return out.summary;
    } catch (e) {
      // Leave the run recalculable, and never keep a half-written state.
      await this.prisma.payrollRun.update({ where: { id: runId }, data: { status: 'DRAFT' } });
      throw e;
    }
  }

  private async calculate(u: AuthUser, companyId: string, runId: string, year: number, month: number) {
    const { start, end } = period(year, month);
    const [company, settings] = await Promise.all([
      this.prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { state: true } }),
      this.prisma.companySettings.findUnique({ where: { companyId } }),
    ]);
    const st = {
      attendanceEnabled: settings?.attendanceEnabled ?? true, method: (settings?.salaryCalcMethod ?? 'CALENDAR_DAYS') as CalcMethod,
      weeklyOff: settings?.weeklyOff ?? ['SUN'], rounding: (settings?.roundingRule === 'NONE' ? 'NONE' : 'NEAREST_RUPEE') as 'NEAREST_RUPEE' | 'NONE',
      pf: settings?.pfEnabled ?? false, esi: settings?.esiEnabled ?? false, pt: settings?.ptEnabled ?? false, lwf: settings?.lwfEnabled ?? false, tds: settings?.tdsEnabled ?? false,
    };
    const holidays = new Set((await this.prisma.holiday.findMany({ where: { companyId, date: { gte: ymd(start), lte: ymd(end) } } })).map((h) => iso(h.date)));
    const divisor = monthSalaryDivisor(st.method, year, month, st.weeklyOff, holidays);

    const employees = await this.prisma.employee.findMany({
      where: { companyId, deletedAt: null, doj: { lte: ymd(end) }, OR: [{ dol: null }, { dol: { gte: ymd(start) } }] },
      orderBy: { code: 'asc' },
      select: { id: true, code: true, firstName: true, lastName: true, dol: true, pfApplicable: true, esiApplicable: true, ptApplicable: true, lwfApplicable: true,
        branch: { select: { state: true, pfApplicable: true, esiApplicable: true, ptApplicable: true, lwfApplicable: true } } },
    });
    const ids = employees.map((e) => e.id);
    const [salaries, sums, inputs, loans, dbRules] = await Promise.all([
      this.prisma.employeeSalary.findMany({ where: { companyId, employeeId: { in: ids }, effectiveFrom: { lte: ymd(end) }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: ymd(start) } }] }, orderBy: { effectiveFrom: 'asc' } }),
      this.prisma.attendanceSummary.findMany({ where: { companyId, year, month, employeeId: { in: ids } } }),
      this.prisma.payrollInput.findMany({ where: { companyId, year, month, employeeId: { in: ids } } }),
      this.prisma.loan.findMany({ where: { companyId, employeeId: { in: ids }, status: 'ACTIVE', startMonth: { lte: ymd(end) }, balance: { gt: 0 } } }),
      this.prisma.complianceRule.findMany({ where: { effectiveFrom: { lte: ymd(end) } } }),
    ]);
    const rules: StatRule[] = dbRules.map((r) => ({
      id: r.id, module: r.module, state: r.state, version: r.version, effectiveFrom: iso(r.effectiveFrom), effectiveTo: r.effectiveTo ? iso(r.effectiveTo) : null,
      wageCeiling: r.wageCeiling == null ? null : n(r.wageCeiling), threshold: r.threshold == null ? null : n(r.threshold),
      employeePercent: r.employeePercent == null ? null : n(r.employeePercent), employerPercent: r.employerPercent == null ? null : n(r.employerPercent),
      slabs: r.slabs, rules: r.rules as Record<string, any> | null,
    }));
    const cfg: EngineConfig = { rounding: st.rounding, rules, asOf: end };

    const by = <T extends { employeeId: string }>(rows: T[]) => { const m = new Map<string, T[]>(); for (const r of rows) m.set(r.employeeId, [...(m.get(r.employeeId) ?? []), r]); return m; };
    const salBy = by(salaries), sumBy = new Map(sums.map((s) => [s.employeeId, s])), inBy = by(inputs), loanBy = by(loans);

    const issues: Issue[] = [];
    const detailRows: any[] = [], earnRows: any[] = [], dedRows: any[] = [];
    let tg = 0, td = 0, tn = 0;
    const now = new Date();

    for (const e of employees) {
      const name = [e.firstName, e.lastName].filter(Boolean).join(' ');
      const asOf = e.dol && iso(e.dol) < end ? iso(e.dol) : end;
      const list = salBy.get(e.id) ?? [];
      const sal = [...list].reverse().find((s) => iso(s.effectiveFrom) <= asOf && (!s.effectiveTo || iso(s.effectiveTo) >= asOf));
      const fail = (message: string) => issues.push({ employeeId: e.id, code: e.code, level: 'ERROR', message });
      if (!sal) { fail('No salary assigned for this month'); continue; }
      const snap = sal.components as any;
      if (!snap?.lines?.length) { fail('Salary record has no calculated breakup'); continue; }
      const sum = sumBy.get(e.id);
      if (st.attendanceEnabled && !sum?.finalized) { fail('Attendance is not finalized'); continue; }
      if (list.some((s) => iso(s.effectiveFrom) > start && iso(s.effectiveFrom) <= asOf)) issues.push({ employeeId: e.id, code: e.code, level: 'WARNING', message: 'Salary revised during this month; the latest rate is applied to the whole month' });

      const b = e.branch;
      const input: EmployeeInput = {
        employeeId: e.id, code: e.code, name, year, month, daysInMonth: daysInMonth(year, month),
        monthlyLines: snap.lines as SalaryLineSnap[],
        attendance: st.attendanceEnabled && sum ? { paidDays: n(sum.paidDays), salaryDivisor: divisor, lopDays: n(sum.lopDays), otHours: n(sum.otHours), presentDays: n(sum.presentDays) } : null,
        adjustments: (inBy.get(e.id) ?? []).map((a): Adjustment => ({ kind: a.kind as Adjustment['kind'], name: a.name, amount: n(a.amount) })),
        loans: (loanBy.get(e.id) ?? []).map((l) => ({ loanId: l.id, type: l.type, emi: n(l.emi), balance: n(l.balance) })),
        state: b?.state ?? company.state,
        applicable: { pf: st.pf && e.pfApplicable && (b?.pfApplicable ?? true), esi: st.esi && e.esiApplicable && (b?.esiApplicable ?? true), pt: st.pt && e.ptApplicable && (b?.ptApplicable ?? true), lwf: st.lwf && e.lwfApplicable && (b?.lwfApplicable ?? true) },
        tdsEnabled: st.tds,
      };
      const out = calculateEmployeePayroll(input, cfg);
      if (out.errors.length) { out.errors.forEach(fail); continue; }
      out.warnings.forEach((message) => issues.push({ employeeId: e.id, code: e.code, level: 'WARNING', message }));

      const id = randomUUID();
      detailRows.push({
        id, companyId, payrollRunId: runId, employeeId: e.id, paidDays: out.paidDays, lopDays: out.lopDays, otHours: out.otHours,
        gross: out.gross, totalDeductions: out.totalDeductions, net: out.net, inputs: { ...input, salaryRecordId: sal.id, ruleIds: out.deductions.filter((d) => d.ruleId).map((d) => [d.code, d.ruleId, d.ruleVersion]) } as any,
        calculation: { earnings: out.earnings, deductions: out.deductions, ratio: out.ratio, employerContribution: out.employerContribution, trace: out.trace } as any,
        formulaVersion: ENGINE_VERSION, calculatedAt: now, hasWarnings: out.warnings.length > 0, warnings: out.warnings as any,
      });
      out.earnings.forEach((x) => earnRows.push({ id: randomUUID(), detailId: id, code: x.code, name: x.name, amount: x.amount }));
      out.deductions.forEach((x) => dedRows.push({ id: randomUUID(), detailId: id, code: x.code, name: x.name, amount: x.amount, employerAmount: x.employer ?? null }));
      tg += out.gross; td += out.totalDeductions; tn += out.net;
    }

    const chunk = <T,>(a: T[]) => Array.from({ length: Math.ceil(a.length / 1000) }, (_, i) => a.slice(i * 1000, (i + 1) * 1000));
    const usedRuleIds = new Set(detailRows.flatMap((d) => (d.inputs.ruleIds as any[]).map((r) => r[1])));
    const summary = { employees: employees.length, calculated: detailRows.length, errors: issues.filter((i) => i.level === 'ERROR').length, warnings: issues.filter((i) => i.level === 'WARNING').length, gross: tg, deductions: td, net: tn };

    await this.prisma.$transaction(async (tx) => {
      await tx.payrollDetail.deleteMany({ where: { payrollRunId: runId } }); // cascades to earnings/deductions
      for (const c of chunk(detailRows)) await tx.payrollDetail.createMany({ data: c });
      for (const c of chunk(earnRows)) await tx.payrollEarning.createMany({ data: c });
      for (const c of chunk(dedRows)) await tx.payrollDeduction.createMany({ data: c });
      await tx.payrollRun.update({ where: { id: runId }, data: {
        status: 'CALCULATED', engineVersion: ENGINE_VERSION, totalGross: tg, totalDeductions: td, totalNet: tn, issues: issues as any,
        rulesSnapshot: { engineVersion: ENGINE_VERSION, generatedAt: now.toISOString(), settings: st, divisor, holidays: [...holidays], rules: rules.filter((r) => usedRuleIds.has(r.id)) } as any,
      } });
    }, { timeout: 120_000, maxWait: 10_000 });
    return { summary };
  }

  // ───────── Status workflow ─────────
  private async move(u: AuthUser, companyId: string, id: string, from: string[], to: 'REVIEW' | 'APPROVED' | 'LOCKED' | 'CALCULATED', action: string, extra: Prisma.PayrollRunUpdateInput = {}, meta?: object, ip?: string) {
    const run = await this.getRun(companyId, id);
    if (!from.includes(run.status)) throw new ConflictException(`Payroll is ${run.status}; expected ${from.join(' or ')}`);
    const updated = await this.prisma.payrollRun.update({ where: { id }, data: { status: to, ...extra } });
    await this.audit.log({ userId: u.id, companyId, action, module: 'payroll', recordId: id, oldValue: { status: run.status }, newValue: { status: to, ...meta }, ip });
    return updated;
  }

  toReview(u: AuthUser, c: string, id: string, ip?: string) { return this.move(u, c, id, ['CALCULATED'], 'REVIEW', 'PAYROLL_SENT_TO_REVIEW', {}, undefined, ip); }
  reopenCalc(u: AuthUser, c: string, id: string, ip?: string) { return this.move(u, c, id, ['REVIEW'], 'CALCULATED', 'PAYROLL_REVIEW_REOPENED', {}, undefined, ip); }

  async approve(u: AuthUser, companyId: string, id: string, ackSkipped: boolean, ip?: string) {
    const run = await this.getRun(companyId, id);
    if (run.status !== 'REVIEW') throw new ConflictException(`Payroll is ${run.status}; it must be in REVIEW to approve`);
    const errs = ((run.issues as unknown as Issue[]) ?? []).filter((i) => i.level === 'ERROR');
    if (errs.length && !ackSkipped) throw new BadRequestException({ message: `${errs.length} employee(s) were skipped due to errors. Fix them and recalculate, or approve while acknowledging they are excluded.`, skipped: errs.length });
    if (run.status === 'REVIEW' && (run._count.details ?? 0) === 0) throw new BadRequestException('Nothing to approve: no employee was calculated');
    await this.prisma.$transaction(async (tx) => {
      const dets = await tx.payrollDetail.findMany({ where: { payrollRunId: id }, select: { calculation: true } });
      const date = ymd(period(run.year, run.month).end);
      for (const d of dets) for (const ded of ((d.calculation as any)?.deductions ?? []) as { loanId?: string; amount: number }[]) {
        if (!ded.loanId) continue;
        const loan = await tx.loan.update({ where: { id: ded.loanId }, data: { balance: { decrement: ded.amount } } });
        await tx.loanTransaction.create({ data: { loanId: ded.loanId, payrollRunId: id, amount: ded.amount, date, note: 'Payroll recovery' } });
        if (n(loan.balance) <= 0) await tx.loan.update({ where: { id: ded.loanId }, data: { status: 'CLOSED' } });
      }
      await tx.payrollRun.update({ where: { id }, data: { status: 'APPROVED', approvedBy: u.id, approvedAt: new Date() } });
    }, { timeout: 60_000 });
    await this.audit.log({ userId: u.id, companyId, action: 'PAYROLL_APPROVED', module: 'payroll', recordId: id, oldValue: { status: 'REVIEW' }, newValue: { status: 'APPROVED', totalNet: n(run.totalNet), skipped: errs.length }, ip });
    return { ok: true };
  }

  /** APPROVED -> REVIEW: restores loan balances taken at approval. */
  async unapprove(u: AuthUser, companyId: string, id: string, ip?: string) {
    const run = await this.getRun(companyId, id);
    if (run.status !== 'APPROVED') throw new ConflictException(`Payroll is ${run.status}; only APPROVED can be reopened`);
    await this.prisma.$transaction(async (tx) => {
      const txns = await tx.loanTransaction.findMany({ where: { payrollRunId: id } });
      for (const t of txns) await tx.loan.update({ where: { id: t.loanId }, data: { balance: { increment: t.amount }, status: 'ACTIVE' } });
      await tx.loanTransaction.deleteMany({ where: { payrollRunId: id } });
      await tx.payrollRun.update({ where: { id }, data: { status: 'REVIEW', approvedBy: null, approvedAt: null } });
    });
    await this.audit.log({ userId: u.id, companyId, action: 'PAYROLL_UNAPPROVED', module: 'payroll', recordId: id, oldValue: { status: 'APPROVED' }, newValue: { status: 'REVIEW' }, ip });
    return { ok: true };
  }

  lock(u: AuthUser, c: string, id: string, ip?: string) { return this.move(u, c, id, ['APPROVED'], 'LOCKED', 'PAYROLL_LOCKED', { lockedBy: u.id, lockedAt: new Date() }, undefined, ip); }

  /** Requires payroll.unlock (checked on the route) and a written reason; always audited. */
  async unlock(u: AuthUser, companyId: string, id: string, reason: string, ip?: string) {
    if (!reason || reason.trim().length < 10) throw new BadRequestException('A reason of at least 10 characters is required to unlock payroll');
    return this.move(u, companyId, id, ['LOCKED'], 'APPROVED', 'PAYROLL_UNLOCKED', { lockedBy: null, lockedAt: null }, { reason: reason.trim() }, ip);
  }

  // ───────── One-time inputs ─────────
  listInputs(companyId: string, year: number, month: number) {
    return this.prisma.payrollInput.findMany({ where: { companyId, year, month }, orderBy: { createdAt: 'asc' }, include: { employee: { select: { code: true, firstName: true, lastName: true } } } });
  }

  private async assertInputsEditable(companyId: string, year: number, month: number) {
    const run = await this.prisma.payrollRun.findFirst({ where: { companyId, year, month, type: 'MONTHLY' } });
    if (run && !EDITABLE.includes(run.status)) throw new ForbiddenException(`Payroll for ${month}/${year} is ${run.status}; inputs cannot change`);
    // A change after calculation makes the numbers stale, so send the run back to DRAFT for recalculation.
    if (run && (run.status === 'CALCULATED' || run.status === 'REVIEW')) await this.prisma.payrollRun.update({ where: { id: run.id }, data: { status: 'DRAFT' } });
  }

  async addInput(u: AuthUser, companyId: string, d: { employeeId: string; year: number; month: number; kind: string; name: string; amount: number; note?: string }, ip?: string) {
    const emp = await this.prisma.employee.findFirst({ where: { id: d.employeeId, companyId, deletedAt: null }, select: { id: true } });
    if (!emp) throw new NotFoundException('Employee not found');
    await this.assertInputsEditable(companyId, d.year, d.month);
    const row = await this.prisma.payrollInput.create({ data: { ...d, companyId, createdBy: u.id } });
    await this.audit.log({ userId: u.id, companyId, action: 'PAYROLL_INPUT_ADDED', module: 'payroll', recordId: row.id, newValue: d, ip });
    return row;
  }

  async deleteInput(u: AuthUser, companyId: string, id: string, ip?: string) {
    const row = await this.prisma.payrollInput.findFirst({ where: { id, companyId } });
    if (!row) throw new NotFoundException('Input not found');
    await this.assertInputsEditable(companyId, row.year, row.month);
    await this.prisma.payrollInput.delete({ where: { id } });
    await this.audit.log({ userId: u.id, companyId, action: 'PAYROLL_INPUT_DELETED', module: 'payroll', recordId: id, oldValue: row, ip });
    return { ok: true };
  }

  // ───────── Bulk payroll: each company is independent ─────────
  async startBulk(u: AuthUser, companyIds: string[], year: number, month: number, ip?: string) {
    const ids = [...new Set(companyIds)];
    const companies = [];
    for (const id of ids) companies.push(await this.access.assertAccess(u, id)); // 404 if not accessible; nothing is created
    const consultantId = u.consultantId ?? companies[0].consultantId;
    const job = await this.prisma.bulkPayrollJob.create({ data: { consultantId, year, month, createdBy: u.id, items: { create: ids.map((companyId) => ({ companyId })) } }, include: { items: true } });
    await this.audit.log({ userId: u.id, action: 'BULK_PAYROLL_STARTED', module: 'payroll', recordId: job.id, newValue: { year, month, companies: ids.length }, ip });
    // In-process background loop. A durable queue (Redis) replaces this in the deployment phase.
    setImmediate(() => { this.runBulk(u, job.id, job.items.map((i) => ({ id: i.id, companyId: i.companyId })), year, month, ip).catch((e) => this.log.error(`bulk ${job.id}: ${e?.stack ?? e}`)); });
    return { jobId: job.id, companies: ids.length };
  }

  private async runBulk(u: AuthUser, jobId: string, items: { id: string; companyId: string }[], year: number, month: number, ip?: string) {
    for (const it of items) {
      await this.prisma.bulkPayrollItem.update({ where: { id: it.id }, data: { status: 'RUNNING' } });
      try {
        let run = await this.prisma.payrollRun.findFirst({ where: { companyId: it.companyId, year, month, type: 'MONTHLY' } });
        if (!run) run = await this.createRun(u, it.companyId, year, month, ip);
        const s = await this.process(u, it.companyId, run.id, ip);
        await this.prisma.bulkPayrollItem.update({ where: { id: it.id }, data: { status: 'DONE', runId: run.id, employees: s.employees, success: s.calculated, errors: s.errors, warnings: s.warnings } });
      } catch (e: any) {
        const errorId = randomUUID();
        this.log.error(`[${errorId}] bulk company ${it.companyId}: ${e?.stack ?? e}`);
        const known = e instanceof ForbiddenException || e instanceof ConflictException || e instanceof BadRequestException;
        await this.prisma.bulkPayrollItem.update({ where: { id: it.id }, data: { status: 'FAILED', errorDetail: known ? e.message : `Unexpected error (ref ${errorId})` } });
      }
    }
  }

  async getBulk(u: AuthUser, jobId: string) {
    const job = await this.prisma.bulkPayrollJob.findUnique({ where: { id: jobId }, include: { items: true } });
    if (!job || (u.type !== 'SUPER_ADMIN' && job.consultantId !== u.consultantId)) throw new NotFoundException('Job not found');
    const ids = await this.access.accessibleCompanyIds(u);
    const items = job.items.filter((i) => ids === 'ALL' || ids.includes(i.companyId));
    const names = new Map((await this.prisma.company.findMany({ where: { id: { in: items.map((i) => i.companyId) } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
    return { id: job.id, year: job.year, month: job.month, done: items.every((i) => i.status === 'DONE' || i.status === 'FAILED'), items: items.map((i) => ({ ...i, company: names.get(i.companyId) })) };
  }
}
