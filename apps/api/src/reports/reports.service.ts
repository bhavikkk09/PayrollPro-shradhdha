import { BadRequestException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AttendanceService } from '../attendance/attendance.service';
import { dateKey, daysInMonth, weekday } from '../attendance/attendance-summary';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth.types';
import { decrypt, mask } from '../common/crypto';
import { FileStorage } from '../files/storage';
import { toStatRule } from '../compliance/compliance.service';
import { pickRule } from '../payroll/statutory';
import { PrismaService } from '../prisma/prisma.service';
import * as B from './builders';
import { toCsv } from './csv';
import { GratuityRule } from './gratuity';
import { Branding, PayslipData, payslipsPdf } from './payslip-pdf';
import { toPdf } from './pdf';
import { ReportContext, ReportResult } from './types';
import { toXlsx } from './xlsx';

export const CATALOG = [
  { kind: 'payroll-register', name: 'Payroll Register', group: 'Payroll', needs: 'month' },
  { kind: 'salary-register', name: 'Salary Register', group: 'Payroll', needs: 'month' },
  { kind: 'wage-register', name: 'Wage Register', group: 'Payroll', needs: 'month' },
  { kind: 'deduction-register', name: 'Deduction Register', group: 'Payroll', needs: 'month' },
  { kind: 'bank-statement', name: 'Bank Salary Statement', group: 'Payroll', needs: 'month' },
  { kind: 'ot-register', name: 'Overtime Register', group: 'Payroll', needs: 'month' },
  { kind: 'pf-report', name: 'PF Report', group: 'Statutory', needs: 'month' },
  { kind: 'esi-report', name: 'ESI Report', group: 'Statutory', needs: 'month' },
  { kind: 'pt-report', name: 'Professional Tax Report', group: 'Statutory', needs: 'month' },
  { kind: 'lwf-report', name: 'LWF Report', group: 'Statutory', needs: 'month' },
  { kind: 'bonus-report', name: 'Bonus Report', group: 'Statutory', needs: 'fy' },
  { kind: 'gratuity-report', name: 'Gratuity Report', group: 'Statutory', needs: 'month' },
  { kind: 'attendance-register', name: 'Attendance Register', group: 'Attendance', needs: 'month' },
  { kind: 'muster-roll', name: 'Muster Roll', group: 'Attendance', needs: 'month' },
  { kind: 'leave-register', name: 'Leave Register', group: 'Attendance', needs: 'year' },
  { kind: 'employee-ledger', name: 'Employee Ledger', group: 'Employee', needs: 'employee' },
] as const;
export type Kind = (typeof CATALOG)[number]['kind'];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SHORT: Record<string, string> = { PRESENT: 'P', ABSENT: 'A', PAID_LEAVE: 'PL', UNPAID_LEAVE: 'UL', WEEKLY_OFF: 'WO', HOLIDAY: 'H', HALF_DAY: 'HD', LOP: 'LOP' };
const FINAL: ('APPROVED' | 'LOCKED')[] = ['APPROVED', 'LOCKED'];
const MAX_FILE_ROWS = 20_000;
const n = (d: Prisma.Decimal | number | null | undefined) => Number(d ?? 0);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const fullName = (e: { firstName: string; middleName?: string | null; lastName?: string | null }) => [e.firstName, e.middleName, e.lastName].filter(Boolean).join(' ');

export interface Query { kind: Kind; year: number; month: number; employeeId?: string; fyStart?: number }

@Injectable()
export class ReportsService {
  constructor(private prisma: PrismaService, private audit: AuditService, private attendance: AttendanceService, @Optional() private storage?: FileStorage) {}

  catalog() { return CATALOG; }

  private async company(companyId: string) {
    const c = await this.prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { code: true, name: true, address: true, city: true, state: true, pincode: true, consultantId: true, logoUrl: true } });
    return { ...c, fullAddress: [c.address, c.city, c.state, c.pincode].filter(Boolean).join(', ') };
  }

  // ───────── Build ─────────
  async build(u: AuthUser, companyId: string, q: Query): Promise<ReportResult> {
    const c = await this.company(companyId);
    const label = `${MONTHS[q.month - 1]} ${q.year}`;
    const base = { company: { name: c.name, address: c.fullAddress } };
    const plain: ReportContext = { ...base, subtitle: label, provisional: false };

    switch (q.kind) {
      case 'attendance-register': case 'muster-roll': {
        const { rows } = await this.attendanceRows(companyId, q.year, q.month);
        return q.kind === 'muster-roll' ? B.musterRoll(plain, rows, daysInMonth(q.year, q.month)) : B.attendanceRegister(plain, rows);
      }
      case 'leave-register': return this.leaveRegister({ ...plain, subtitle: `Year ${q.year}` }, companyId, q.year);
      case 'employee-ledger': return this.ledger(companyId, base, q);
      case 'bonus-report': return this.bonus(companyId, base, q);
      case 'gratuity-report': return this.gratuity(companyId, c, base, q);
      default: {
        const wantsTrace = ['pf-report', 'esi-report', 'pt-report', 'lwf-report', 'ot-register'].includes(q.kind);
        const revealBank = q.kind === 'bank-statement' && u.permissions.includes('employee.sensitive');
        const { run, emps } = await this.payroll(companyId, q.year, q.month, wantsTrace, q.kind === 'bank-statement', revealBank);
        const ctx: ReportContext = { ...base, subtitle: `${label} (payroll ${run.status.toLowerCase()})`, provisional: !(FINAL as string[]).includes(run.status) };
        const fn = { 'payroll-register': B.payrollRegister, 'salary-register': B.salaryRegister, 'wage-register': B.wageRegister, 'deduction-register': B.deductionRegister,
          'bank-statement': B.bankStatement, 'ot-register': B.otRegister, 'pf-report': B.pfReport, 'esi-report': B.esiReport, 'pt-report': B.ptReport, 'lwf-report': B.lwfReport }[q.kind as string];
        if (!fn) throw new BadRequestException('Unknown report');
        const r = fn(ctx, emps);
        if (q.kind === 'bank-statement' && !revealBank) r.notes.push('Account numbers are masked. Full numbers need the sensitive-data permission.');
        return r;
      }
    }
  }

  private async payroll(companyId: string, year: number, month: number, trace: boolean, bank: boolean, reveal: boolean) {
    const run = await this.prisma.payrollRun.findFirst({ where: { companyId, year, month, type: 'MONTHLY' } });
    if (!run) throw new NotFoundException(`No payroll run for ${MONTHS[month - 1]} ${year}`);
    const rows = await this.prisma.payrollDetail.findMany({
      where: { payrollRunId: run.id, companyId }, orderBy: { employee: { code: 'asc' } }, take: 50_000,
      select: {
        paidDays: true, lopDays: true, otHours: true, gross: true, totalDeductions: true, net: true, ...(trace ? { calculation: true } : {}),
        earnings: { select: { code: true, name: true, amount: true } }, deductions: { select: { code: true, name: true, amount: true, employerAmount: true } },
        employee: { select: { code: true, firstName: true, middleName: true, lastName: true, uan: true, pfNumber: true, esiNumber: true, bankName: true, bankAccountEnc: true, ifsc: true, department: { select: { name: true } }, designation: { select: { name: true } } } },
      },
    });
    const emps: B.PayEmp[] = rows.map((d: any) => {
      const calc = d.calculation as { earnings?: { code: string; source?: string }[]; trace?: { step: string; detail: unknown }[] } | undefined;
      const src = new Map((calc?.earnings ?? []).map((e) => [e.code, e.source]));
      const acct = bank ? decrypt(d.employee.bankAccountEnc) : null;
      return {
        code: d.employee.code, name: fullName(d.employee), department: d.employee.department?.name ?? '', designation: d.employee.designation?.name ?? '',
        uan: d.employee.uan ?? '', pfNumber: d.employee.pfNumber ?? '', esiNumber: d.employee.esiNumber ?? '', bankName: d.employee.bankName ?? '',
        bankAccount: acct ? (reveal ? acct : mask(acct) ?? '') : '', ifsc: d.employee.ifsc ?? '',
        paidDays: n(d.paidDays), lopDays: n(d.lopDays), otHours: n(d.otHours), gross: n(d.gross), totalDeductions: n(d.totalDeductions), net: n(d.net),
        earnings: d.earnings.map((e: any) => ({ code: e.code, name: e.name, amount: n(e.amount), source: src.get(e.code) })),
        deductions: d.deductions.map((x: any) => ({ code: x.code, name: x.name, amount: n(x.amount), employer: x.employerAmount == null ? null : n(x.employerAmount) })),
        trace: calc?.trace ?? [],
      };
    });
    return { run, emps };
  }

  private async attendanceRows(companyId: string, year: number, month: number) {
    const N = daysInMonth(year, month);
    const rows: B.AttRow[] = [];
    for (let page = 1; ; page++) {
      const g = await this.attendance.grid(companyId, year, month, { page, pageSize: 200 });
      const off = new Set(g.weeklyOff), hol = new Set(g.holidays);
      for (const e of g.items) {
        const days: Record<string, string> = {};
        for (let d = 1; d <= N; d++) {
          const k = dateKey(year, month, d);
          if (k < e.doj || (e.dol && k > e.dol)) continue;
          const st = (e.days as any)[k]?.status as string | undefined;
          days[String(d)] = st ? SHORT[st] ?? '' : off.has(weekday(k)) ? 'WO' : hol.has(k) ? 'H' : '';
        }
        const s = e.summary;
        rows.push({ code: e.code, name: e.name, present: s.present, absent: s.absent, paidLeave: s.paidLeave, unpaidLeave: s.unpaidLeave, weeklyOffs: s.weeklyOffs, holidays: s.holidays, lopDays: s.lopDays, otHours: s.otHours, paidDays: s.paidDays, days });
      }
      if (page * 200 >= g.total) break;
    }
    return { rows };
  }

  private async leaveRegister(ctx: ReportContext, companyId: string, year: number) {
    const [types, emps] = await Promise.all([
      this.prisma.leaveType.findMany({ where: { companyId }, orderBy: { code: 'asc' } }),
      this.prisma.employee.findMany({ where: { companyId, deletedAt: null, status: { not: 'INACTIVE' } }, orderBy: { code: 'asc' }, take: 50_000, select: { code: true, firstName: true, middleName: true, lastName: true, leaveBalances: { where: { year }, select: { leaveTypeId: true, balance: true } } } }),
    ]);
    return B.leaveRegister(ctx, types, emps.map((e) => ({ code: e.code, name: fullName(e), balances: Object.fromEntries(e.leaveBalances.map((b) => [b.leaveTypeId, n(b.balance)])) })));
  }

  private fyMonths(year: number, fyStart: number) {
    return Array.from({ length: 12 }, (_, i) => { const idx = year * 12 + (fyStart - 1) + i; return { y: Math.floor(idx / 12), m: (idx % 12) + 1 }; });
  }

  private async ledger(companyId: string, base: { company: { name: string; address: string } }, q: Query) {
    if (!q.employeeId) throw new BadRequestException('employeeId is required for the employee ledger');
    const emp = await this.prisma.employee.findFirst({ where: { id: q.employeeId, companyId, deletedAt: null }, select: { code: true, firstName: true, middleName: true, lastName: true } });
    if (!emp) throw new NotFoundException('Employee not found');
    const fy = this.fyMonths(q.year, q.fyStart ?? 4);
    const runs = await this.prisma.payrollRun.findMany({ where: { companyId, type: 'MONTHLY', year: { gte: fy[0].y, lte: fy[11].y } }, select: { id: true, year: true, month: true, status: true } });
    const wanted = runs.filter((r) => fy.some((x) => x.y === r.year && x.m === r.month));
    const dets = await this.prisma.payrollDetail.findMany({ where: { companyId, employeeId: q.employeeId, payrollRunId: { in: wanted.map((r) => r.id) } }, select: { payrollRunId: true, paidDays: true, gross: true, totalDeductions: true, net: true } });
    const byRun = new Map(dets.map((d) => [d.payrollRunId, d]));
    const months = fy.flatMap(({ y, m }) => {
      const run = wanted.find((r) => r.year === y && r.month === m);
      const d = run && byRun.get(run.id);
      return run && d ? [{ label: `${MONTHS[m - 1]} ${y}`, paidDays: n(d.paidDays), gross: n(d.gross), deductions: n(d.totalDeductions), net: n(d.net), status: run.status }] : [];
    });
    const provisional = months.some((m) => !(FINAL as string[]).includes(m.status));
    const r = B.employeeLedger({ ...base, subtitle: `${emp.code} ${fullName(emp)} - FY ${fy[0].y}-${String(fy[11].y).slice(2)}`, provisional }, months);
    return r;
  }

  private async bonus(companyId: string, base: { company: { name: string; address: string } }, q: Query) {
    const fy = this.fyMonths(q.year, q.fyStart ?? 4);
    const runs = await this.prisma.payrollRun.findMany({ where: { companyId, type: 'MONTHLY', status: { in: FINAL }, year: { gte: fy[0].y, lte: fy[11].y } }, select: { id: true, year: true, month: true } });
    const ids = runs.filter((r) => fy.some((x) => x.y === r.year && x.m === r.month)).map((r) => r.id);
    const comps = await this.prisma.salaryComponent.findMany({ where: { companyId, bonusApplicable: true }, select: { code: true } });
    const wageCodes = [...new Set(comps.map((c) => c.code))];
    const dets = await this.prisma.payrollDetail.findMany({
      where: { payrollRunId: { in: ids }, companyId }, take: 200_000,
      select: { employeeId: true, employee: { select: { code: true, firstName: true, middleName: true, lastName: true } }, earnings: { where: { code: { in: [...wageCodes, 'BONUS'] } }, select: { code: true, amount: true } } },
    });
    const by = new Map<string, { code: string; name: string; wages: number; paid: number }>();
    for (const d of dets) {
      const cur = by.get(d.employeeId) ?? { code: d.employee.code, name: fullName(d.employee), wages: 0, paid: 0 };
      for (const e of d.earnings) { if (e.code === 'BONUS') cur.paid += n(e.amount); if (wageCodes.includes(e.code)) cur.wages += n(e.amount); }
      by.set(d.employeeId, cur);
    }
    const rows = [...by.values()].sort((a, b) => a.code.localeCompare(b.code));
    const r = B.bonusReport({ ...base, subtitle: `FY ${fy[0].y}-${String(fy[11].y).slice(2)} (approved payrolls only)`, provisional: false }, rows);
    if (!wageCodes.length) r.notes.push('No salary component is marked bonus-applicable.');
    return r;
  }

  private async gratuity(companyId: string, c: { state: string | null; consultantId: string }, base: { company: { name: string; address: string } }, q: Query) {
    const asOf = dateKey(q.year, q.month, daysInMonth(q.year, q.month));
    const dbRules = await this.prisma.complianceRule.findMany({ where: { module: 'GRATUITY', effectiveFrom: { lte: new Date(`${asOf}T00:00:00Z`) }, OR: [{ consultantId: null }, { consultantId: c.consultantId }] } });
    const rule = pickRule(dbRules.map((r) => toStatRule(r, r.consultantId !== null)), 'GRATUITY', c.state, asOf);
    const gr = rule?.rules as Partial<GratuityRule> | undefined;
    const usable: GratuityRule | null = gr && Number(gr.daysPerYear) > 0 && Number(gr.monthlyDivisor) > 0 ? (gr as GratuityRule) : null;
    const emps = await this.prisma.employee.findMany({
      where: { companyId, deletedAt: null, status: 'ACTIVE', doj: { lte: new Date(`${asOf}T00:00:00Z`) } }, orderBy: { code: 'asc' }, take: 50_000,
      select: { code: true, firstName: true, middleName: true, lastName: true, doj: true, salaries: { orderBy: { effectiveFrom: 'desc' }, take: 1, select: { components: true } } },
    });
    const rows = emps.map((e) => {
      const lines = ((e.salaries[0]?.components as any)?.lines ?? []) as { type: string; amount: number; flags?: { gratuity?: boolean } }[];
      const wage = lines.filter((l) => l.type === 'EARNING' && l.flags?.gratuity).reduce((s, l) => s + l.amount, 0);
      return { code: e.code, name: fullName(e), doj: iso(e.doj), wage };
    });
    return B.gratuityReport({ ...base, subtitle: `As on ${asOf}`, provisional: false }, rows, asOf, usable);
  }

  // ───────── Export ─────────
  async export(u: AuthUser, companyId: string, q: Query, format: 'json' | 'csv' | 'xlsx' | 'pdf', ip?: string) {
    if (format !== 'json' && !u.permissions.includes('reports.export')) throw new ForbiddenException('Insufficient permission');
    const report = await this.build(u, companyId, q);
    if (format === 'json') return { report };
    if ((format === 'pdf' || format === 'xlsx') && report.rows.length > MAX_FILE_ROWS) throw new BadRequestException(`Too many rows for ${format.toUpperCase()} (${report.rows.length}). Use CSV.`);
    const c = await this.company(companyId);
    const stamp = q.kind === 'leave-register' || q.kind === 'bonus-report' || q.kind === 'employee-ledger' ? `${q.year}` : `${q.year}-${String(q.month).padStart(2, '0')}`;
    const filename = `${q.kind}-${c.code}-${stamp}.${format}`.replace(/[^A-Za-z0-9._-]/g, '_');
    const body = format === 'csv' ? Buffer.from(toCsv(report), 'utf8') : format === 'xlsx' ? await toXlsx(report) : await toPdf(report);
    const revealed = q.kind === 'bank-statement' && u.permissions.includes('employee.sensitive');
    await this.audit.log({ userId: u.id, companyId, action: revealed ? 'SENSITIVE_REPORT_EXPORTED' : 'REPORT_EXPORTED', module: 'reports', recordId: q.kind, newValue: { ...q, format, rows: report.rows.length }, ip });
    const contentType = { csv: 'text/csv; charset=utf-8', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pdf: 'application/pdf' }[format];
    return { file: { body, contentType, filename } };
  }

  // ───────── Payslips ─────────
  async payslips(u: AuthUser, companyId: string, runId: string, employeeId: string | undefined, ip?: string) {
    const run = await this.prisma.payrollRun.findFirst({ where: { id: runId, companyId } });
    if (!run) throw new NotFoundException('Payroll run not found');
    const [c, settings] = await Promise.all([this.company(companyId), this.prisma.companySettings.findUnique({ where: { companyId }, select: { branding: true } })]);
    const details = await this.prisma.payrollDetail.findMany({
      where: { payrollRunId: runId, companyId, ...(employeeId ? { employeeId } : {}) }, orderBy: { employee: { code: 'asc' } }, take: 2000,
      select: {
        paidDays: true, lopDays: true, otHours: true, gross: true, totalDeductions: true, net: true, inputs: true,
        earnings: { select: { name: true, amount: true } }, deductions: { select: { name: true, amount: true } },
        employee: { select: { code: true, firstName: true, middleName: true, lastName: true, doj: true, uan: true, pfNumber: true, esiNumber: true, bankName: true, bankAccountEnc: true, department: { select: { name: true } }, designation: { select: { name: true } } } },
      },
    });
    if (!details.length) throw new NotFoundException(employeeId ? 'No payslip for this employee in this run' : 'This run has no calculated payslips');
    const logo = c.logoUrl?.startsWith('blob:') && this.storage ? (await this.storage.get(c.logoUrl.slice(5))) ?? undefined : undefined;
    const divisor = ((run.rulesSnapshot as any)?.divisor as number | undefined) ?? daysInMonth(run.year, run.month);
    const list: PayslipData[] = details.map((d) => {
      const acct = decrypt(d.employee.bankAccountEnc);
      return {
        company: { name: c.name, address: c.fullAddress }, period: `${MONTHS[run.month - 1]} ${run.year}`, draft: !(FINAL as string[]).includes(run.status),
        employee: { code: d.employee.code, name: fullName(d.employee), department: d.employee.department?.name ?? '', designation: d.employee.designation?.name ?? '', doj: iso(d.employee.doj),
          bank: [d.employee.bankName, acct ? mask(acct) : ''].filter(Boolean).join(' '), uan: d.employee.uan ?? '', pfNumber: d.employee.pfNumber ?? '', esiNumber: d.employee.esiNumber ?? '' },
        attendance: { workingDays: divisor, paidDays: n(d.paidDays), lopDays: n(d.lopDays), otHours: n(d.otHours) },
        earnings: d.earnings.map((e) => ({ name: e.name, amount: n(e.amount) })), deductions: d.deductions.map((e) => ({ name: e.name, amount: n(e.amount) })),
        gross: n(d.gross), totalDeductions: n(d.totalDeductions), net: n(d.net), logo,
      };
    });
    const pdf = await payslipsPdf(list, (settings?.branding as Branding | null) ?? {});
    await this.audit.log({ userId: u.id, companyId, action: 'PAYSLIPS_GENERATED', module: 'reports', recordId: runId, newValue: { count: list.length, employeeId: employeeId ?? null, draft: !(FINAL as string[]).includes(run.status) }, ip });
    const name = `payslip-${c.code}-${run.year}-${String(run.month).padStart(2, '0')}${employeeId ? `-${list[0].employee.code}` : ''}.pdf`.replace(/[^A-Za-z0-9._-]/g, '_');
    return { body: pdf, contentType: 'application/pdf', filename: name };
  }
}
