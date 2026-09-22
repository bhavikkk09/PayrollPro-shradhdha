import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { AttendanceStatus, Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth.types';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { validateAttendanceRows, RawRow, ValidRow } from './attendance-import';
import { buildQuickEntries, QuickRawRow } from './attendance-quick-import';
import { CalcMethod, dateKey, daysInMonth, MonthSummary, Status, summarizeMonth, workingDatesBetween } from './attendance-summary';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const ymd = (s: string) => new Date(`${s}T00:00:00.000Z`);
const monthOf = (s: string) => s.slice(0, 7);
export interface Entry { employeeId: string; date: string; status: Status; otHours?: number }

@Injectable()
export class AttendanceService {
  constructor(private prisma: PrismaService, private audit: AuditService, @Optional() private notifications?: NotificationsService) {}

  async settings(companyId: string) {
    const s = await this.prisma.companySettings.findUnique({ where: { companyId } });
    return {
      attendanceEnabled: s?.attendanceEnabled ?? true, lopEnabled: s?.lopEnabled ?? true, otEnabled: s?.overtimeEnabled ?? false,
      weeklyOff: s?.weeklyOff ?? ['SUN'], calcMethod: (s?.salaryCalcMethod ?? 'CALENDAR_DAYS') as CalcMethod,
    };
  }

  private async holidaySet(companyId: string, year: number, month: number) {
    const rows = await this.prisma.holiday.findMany({
      where: { companyId, date: { gte: ymd(dateKey(year, month, 1)), lte: ymd(dateKey(year, month, daysInMonth(year, month))) } },
    });
    return new Set(rows.map((h) => iso(h.date)));
  }

  private employeesInMonth(companyId: string, year: number, month: number): Prisma.EmployeeWhereInput {
    return {
      companyId, deletedAt: null,
      doj: { lte: ymd(dateKey(year, month, daysInMonth(year, month))) },
      OR: [{ dol: null }, { dol: { gte: ymd(dateKey(year, month, 1)) } }],
    };
  }

  /** Paginated month grid: one row per employee with day statuses and a computed summary. */
  async grid(companyId: string, year: number, month: number, q: { search?: string; page: number; pageSize: number }) {
    const st = await this.settings(companyId);
    const holidays = await this.holidaySet(companyId, year, month);
    const where: Prisma.EmployeeWhereInput = {
      ...this.employeesInMonth(companyId, year, month),
      ...(q.search ? { OR: [{ code: { contains: q.search, mode: 'insensitive' } }, { firstName: { contains: q.search, mode: 'insensitive' } }, { lastName: { contains: q.search, mode: 'insensitive' } }] } : {}),
    };
    const [total, emps] = await Promise.all([
      this.prisma.employee.count({ where }),
      this.prisma.employee.findMany({ where, orderBy: { code: 'asc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, select: { id: true, code: true, firstName: true, lastName: true, doj: true, dol: true } }),
    ]);
    const from = ymd(dateKey(year, month, 1));
    const to = ymd(dateKey(year, month, daysInMonth(year, month)));
    const [att, sums] = await Promise.all([
      this.prisma.attendance.findMany({ where: { companyId, employeeId: { in: emps.map((e) => e.id) }, date: { gte: from, lte: to } } }),
      this.prisma.attendanceSummary.findMany({ where: { companyId, year, month, employeeId: { in: emps.map((e) => e.id) } }, select: { finalized: true } }),
    ]);
    const byEmp = new Map<string, Map<string, { status: Status; otHours: number }>>();
    for (const a of att) {
      if (!byEmp.has(a.employeeId)) byEmp.set(a.employeeId, new Map());
      byEmp.get(a.employeeId)!.set(iso(a.date), { status: a.status as Status, otHours: Number(a.otHours) });
    }
    return {
      year, month, total, page: q.page, pageSize: q.pageSize, finalized: sums.some((s) => s.finalized),
      holidays: [...holidays], weeklyOff: st.weeklyOff, otEnabled: st.otEnabled,
      items: emps.map((e) => {
        const records = byEmp.get(e.id) ?? new Map();
        return {
          id: e.id, code: e.code, name: [e.firstName, e.lastName].filter(Boolean).join(' '), doj: iso(e.doj), dol: e.dol ? iso(e.dol) : null,
          days: Object.fromEntries([...records].map(([d, r]) => [d, r])),
          summary: summarizeMonth({ year, month, records, weeklyOff: st.weeklyOff, holidays, doj: iso(e.doj), dol: e.dol ? iso(e.dol) : null, calcMethod: st.calcMethod, lopEnabled: st.lopEnabled, otEnabled: st.otEnabled }),
        };
      }),
    };
  }

  /** Month is editable only if not finalized and no payroll run for it is APPROVED/LOCKED. */
  async assertEditable(companyId: string, months: Iterable<string>) {
    for (const m of new Set(months)) {
      const [year, month] = m.split('-').map(Number);
      const [fin, run] = await Promise.all([
        this.prisma.attendanceSummary.count({ where: { companyId, year, month, finalized: true } }),
        this.prisma.payrollRun.count({ where: { companyId, year, month, status: { in: ['APPROVED', 'LOCKED'] } } }),
      ]);
      if (run) throw new ForbiddenException(`Payroll for ${m} is approved/locked; attendance cannot be changed`);
      if (fin) throw new ForbiddenException(`Attendance for ${m} is finalized. Reopen the month to edit.`);
    }
  }

  /** Bulk save from the grid. Every employee must belong to this company. */
  async saveEntries(u: AuthUser, companyId: string, entries: Entry[], ip?: string) {
    if (!entries.length) return { saved: 0 };
    const st = await this.settings(companyId);
    if (!st.attendanceEnabled) throw new BadRequestException('Attendance is disabled for this company');
    const ids = [...new Set(entries.map((e) => e.employeeId))];
    const emps = await this.prisma.employee.findMany({ where: { companyId, id: { in: ids }, deletedAt: null }, select: { id: true, doj: true, dol: true } });
    if (emps.length !== ids.length) throw new BadRequestException('Unknown employee in request');
    const win = new Map(emps.map((e) => [e.id, e]));
    for (const e of entries) {
      const w = win.get(e.employeeId)!;
      if (e.date < iso(w.doj) || (w.dol && e.date > iso(w.dol))) throw new BadRequestException(`${e.date} is outside the employee's employment period`);
      if ((e.otHours ?? 0) > 0 && !st.otEnabled) throw new BadRequestException('Overtime is not enabled for this company');
    }
    await this.assertEditable(companyId, entries.map((e) => monthOf(e.date)));
    await this.write(companyId, entries.map((e) => ({ ...e, otHours: e.otHours ?? 0 })), 'MANUAL');
    await this.audit.log({ userId: u.id, companyId, action: 'ATTENDANCE_SAVED', module: 'attendance', newValue: { rows: entries.length }, ip });
    return { saved: entries.length };
  }

  private async write(companyId: string, rows: { employeeId: string; date: string; status: Status; otHours: number }[], source: string) {
    for (let i = 0; i < rows.length; i += 500) {
      await this.prisma.$transaction(rows.slice(i, i + 500).map((r) => this.prisma.attendance.upsert({
        where: { employeeId_date: { employeeId: r.employeeId, date: ymd(r.date) } },
        update: { status: r.status as AttendanceStatus, otHours: r.otHours, source },
        create: { companyId, employeeId: r.employeeId, date: ymd(r.date), status: r.status as AttendanceStatus, otHours: r.otHours, source },
      })));
    }
  }

  // ───────── Import: upload -> validate -> preview -> confirm ─────────
  async importValidate(u: AuthUser, companyId: string, fileName: string, rows: RawRow[]) {
    const st = await this.settings(companyId);
    const emps = await this.prisma.employee.findMany({ where: { companyId, deletedAt: null }, select: { id: true, code: true, doj: true, dol: true } });
    const map = new Map(emps.map((e) => [e.code.toUpperCase(), { id: e.id, doj: iso(e.doj), dol: e.dol ? iso(e.dol) : null }]));
    const { valid, errors } = validateAttendanceRows(rows, map, st.otEnabled);
    const months = [...new Set(valid.map((v) => monthOf(v.date)))];
    const lockedMonths: string[] = [];
    for (const m of months) { try { await this.assertEditable(companyId, [m]); } catch { lockedMonths.push(m); } }
    const usable = valid.filter((v) => !lockedMonths.includes(monthOf(v.date)));
    const allErrors = [...errors, ...lockedMonths.map((m) => ({ row: 0, message: `Month ${m} is finalized or payroll is approved/locked; those rows will not be imported` }))];

    const job = await this.prisma.importJob.create({
      data: {
        companyId, kind: 'ATTENDANCE', fileName: fileName.slice(0, 200), status: allErrors.length ? 'HAS_ERRORS' : 'VALIDATED',
        totalRows: rows.length, validRows: usable.length, errorRows: errors.length, errors: allErrors.slice(0, 500) as any,
        stagedData: usable as any, createdBy: u.id,
      },
    });
    if (errors.length) this.notifications?.safe(() => this.notifications!.notifyUser(u.id, companyId, 'IMPORT_ERROR', { title: `Attendance import has ${errors.length} error${errors.length === 1 ? '' : 's'}`, body: fileName.slice(0, 100), link: 'attendance' }));
    return {
      jobId: job.id, totalRows: rows.length, validRows: usable.length, errorRows: errors.length, errors: allErrors.slice(0, 200),
      preview: usable.slice(0, 20), months,
    };
  }

  async importConfirm(u: AuthUser, companyId: string, jobId: string, skipInvalid: boolean, ip?: string) {
    const job = await this.prisma.importJob.findFirst({ where: { id: jobId, companyId, kind: 'ATTENDANCE' } });
    if (!job) throw new NotFoundException('Import not found');
    if (job.status === 'CONFIRMED') throw new ConflictException('This import was already applied');
    if (job.status === 'HAS_ERRORS' && !skipInvalid) throw new BadRequestException('The file has errors. Fix and re-upload, or import only the valid rows.');
    const rows = (job.stagedData as unknown as ValidRow[]) ?? [];
    await this.assertEditable(companyId, rows.map((r) => monthOf(r.date))); // re-check: state may have changed since validation
    await this.write(companyId, rows, 'IMPORT');
    await this.prisma.importJob.update({ where: { id: jobId }, data: { status: 'CONFIRMED', stagedData: Prisma.DbNull } });
    await this.audit.log({ userId: u.id, companyId, action: 'ATTENDANCE_IMPORTED', module: 'attendance', recordId: jobId, newValue: { rows: rows.length, skipped: job.errorRows }, ip });
    return { imported: rows.length, skipped: job.errorRows };
  }

  // ───────── Quick import: "employee worked N days this month", no daily grid needed ─────────
  // Salary itself is never part of this file - payroll always reads the employee's assigned
  // salary structure, the same as when attendance is entered day-by-day.
  async quickImportValidate(u: AuthUser, companyId: string, fileName: string, year: number, month: number, rows: QuickRawRow[]) {
    const monthKey = `${year}-${String(month).padStart(2, '0')}`;
    let lockedMessage: string | null = null;
    try { await this.assertEditable(companyId, [monthKey]); } catch (e) { lockedMessage = (e as Error).message; }

    const st = await this.settings(companyId);
    const holidays = await this.holidaySet(companyId, year, month);
    const monthStart = dateKey(year, month, 1);
    const monthEnd = dateKey(year, month, daysInMonth(year, month));
    const emps = await this.prisma.employee.findMany({ where: this.employeesInMonth(companyId, year, month), select: { id: true, code: true, doj: true, dol: true } });
    const employeeMap = new Map(emps.map((e) => {
      const from = iso(e.doj) > monthStart ? iso(e.doj) : monthStart;
      const to = e.dol && iso(e.dol) < monthEnd ? iso(e.dol) : monthEnd;
      return [e.code.toUpperCase(), { id: e.id, workingDates: workingDatesBetween(from, to, st.weeklyOff, holidays) }];
    }));

    const { valid, errors } = buildQuickEntries(rows, employeeMap, st.otEnabled);
    const usable = lockedMessage ? [] : valid;
    const allErrors = lockedMessage ? [...errors, { row: 0, message: lockedMessage }] : errors;

    const job = await this.prisma.importJob.create({
      data: {
        companyId, kind: 'ATTENDANCE_QUICK', fileName: fileName.slice(0, 200), status: allErrors.length ? 'HAS_ERRORS' : 'VALIDATED',
        totalRows: rows.length, validRows: new Set(usable.map((v) => v.employeeId)).size, errorRows: allErrors.length,
        errors: allErrors.slice(0, 500) as any, stagedData: { year, month, entries: usable } as any, createdBy: u.id,
      },
    });
    if (errors.length) this.notifications?.safe(() => this.notifications!.notifyUser(u.id, companyId, 'IMPORT_ERROR', { title: `Attendance quick-import has ${errors.length} error${errors.length === 1 ? '' : 's'}`, body: fileName.slice(0, 100), link: 'attendance' }));

    const codeById = new Map(emps.map((e) => [e.id, e.code]));
    const daysByEmp = new Map<string, number>();
    for (const e of usable) daysByEmp.set(e.employeeId, (daysByEmp.get(e.employeeId) ?? 0) + (e.status === 'ABSENT' ? 0 : e.status === 'HALF_DAY' ? 0.5 : 1));
    const preview = [...daysByEmp.entries()].slice(0, 20).map(([id, paidDays]) => ({ employeeCode: codeById.get(id), paidDays }));

    return { jobId: job.id, totalRows: rows.length, validRows: daysByEmp.size, errorRows: allErrors.length, errors: allErrors.slice(0, 200), preview, year, month };
  }

  async quickImportConfirm(u: AuthUser, companyId: string, jobId: string, skipInvalid: boolean, ip?: string) {
    const job = await this.prisma.importJob.findFirst({ where: { id: jobId, companyId, kind: 'ATTENDANCE_QUICK' } });
    if (!job) throw new NotFoundException('Import not found');
    if (job.status === 'CONFIRMED') throw new ConflictException('This import was already applied');
    if (job.status === 'HAS_ERRORS' && !skipInvalid) throw new BadRequestException('The file has errors. Fix and re-upload, or import only the valid rows.');
    const staged = job.stagedData as unknown as { year: number; month: number; entries: { employeeId: string; date: string; status: Status; otHours: number }[] };
    await this.assertEditable(companyId, [`${staged.year}-${String(staged.month).padStart(2, '0')}`]); // re-check: state may have changed since validation
    await this.write(companyId, staged.entries, 'QUICK_IMPORT');
    await this.prisma.importJob.update({ where: { id: jobId }, data: { status: 'CONFIRMED', stagedData: Prisma.DbNull } });
    const employeeCount = new Set(staged.entries.map((e) => e.employeeId)).size;
    await this.audit.log({ userId: u.id, companyId, action: 'ATTENDANCE_QUICK_IMPORTED', module: 'attendance', recordId: jobId, newValue: { employees: employeeCount }, ip });
    return { imported: employeeCount };
  }

  // ───────── Month close ─────────
  async finalize(u: AuthUser, companyId: string, year: number, month: number, unmarkedAs: Status | undefined, ip?: string) {
    await this.assertEditable(companyId, [`${year}-${String(month).padStart(2, '0')}`]);
    const st = await this.settings(companyId);
    const holidays = await this.holidaySet(companyId, year, month);
    const emps = await this.prisma.employee.findMany({ where: this.employeesInMonth(companyId, year, month), select: { id: true, doj: true, dol: true } });
    const att = await this.prisma.attendance.findMany({
      where: { companyId, date: { gte: ymd(dateKey(year, month, 1)), lte: ymd(dateKey(year, month, daysInMonth(year, month))) } },
    });
    const byEmp = new Map<string, Map<string, { status: Status; otHours: number }>>();
    for (const a of att) {
      if (!byEmp.has(a.employeeId)) byEmp.set(a.employeeId, new Map());
      byEmp.get(a.employeeId)!.set(iso(a.date), { status: a.status as Status, otHours: Number(a.otHours) });
    }
    const compute = (e: (typeof emps)[number], unmarked?: Status): MonthSummary => summarizeMonth({
      year, month, records: byEmp.get(e.id) ?? new Map(), weeklyOff: st.weeklyOff, holidays, doj: iso(e.doj), dol: e.dol ? iso(e.dol) : null,
      calcMethod: st.calcMethod, lopEnabled: st.lopEnabled, otEnabled: st.otEnabled, unmarkedAs: unmarked,
    });

    const pending = emps.map((e) => compute(e)).reduce((n, s) => n + s.unmarked, 0);
    if (pending && !unmarkedAs) throw new BadRequestException({ message: `${pending} day(s) are not marked. Mark them, or choose how to treat unmarked days.`, unmarkedDays: pending });

    // Materialise the chosen default so the muster roll matches the summary.
    if (pending && unmarkedAs) {
      const fill: { employeeId: string; date: string; status: Status; otHours: number }[] = [];
      for (const e of emps) for (const d of compute(e).unmarkedDates) fill.push({ employeeId: e.id, date: d, status: unmarkedAs, otHours: 0 });
      await this.write(companyId, fill, 'FINALIZE_DEFAULT');
      for (const f of fill) { if (!byEmp.has(f.employeeId)) byEmp.set(f.employeeId, new Map()); byEmp.get(f.employeeId)!.set(f.date, { status: f.status, otHours: 0 }); }
    }

    await this.prisma.$transaction(emps.map((e) => {
      const s = compute(e);
      const data = {
        workingDays: s.workingDays, presentDays: s.present, absentDays: s.absent, paidLeave: s.paidLeave, unpaidLeave: s.unpaidLeave,
        weeklyOffs: s.weeklyOffs, holidays: s.holidays, lopDays: s.lopDays, otHours: s.otHours, paidDays: s.paidDays, finalized: true,
      };
      return this.prisma.attendanceSummary.upsert({
        where: { employeeId_year_month: { employeeId: e.id, year, month } }, update: data, create: { companyId, employeeId: e.id, year, month, ...data },
      });
    }));
    await this.audit.log({ userId: u.id, companyId, action: 'ATTENDANCE_FINALIZED', module: 'attendance', recordId: `${year}-${month}`, newValue: { employees: emps.length, unmarkedAs: unmarkedAs ?? null }, ip });
    return { finalized: emps.length };
  }

  async reopen(u: AuthUser, companyId: string, year: number, month: number, ip?: string) {
    const locked = await this.prisma.payrollRun.count({ where: { companyId, year, month, status: { in: ['APPROVED', 'LOCKED'] } } });
    if (locked) throw new ForbiddenException('Payroll for this month is approved/locked; it must be unlocked first');
    const r = await this.prisma.attendanceSummary.updateMany({ where: { companyId, year, month }, data: { finalized: false } });
    await this.audit.log({ userId: u.id, companyId, action: 'ATTENDANCE_REOPENED', module: 'attendance', recordId: `${year}-${month}`, ip });
    return { reopened: r.count };
  }
}
