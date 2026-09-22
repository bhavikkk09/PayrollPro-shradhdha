import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { LeaveTxnType, Prisma } from '@prisma/client';
import { AttendanceService } from '../attendance/attendance.service';
import { daysInMonth, dateKey, workingDatesBetween } from '../attendance/attendance-summary';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth.types';
import { PrismaService } from '../prisma/prisma.service';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const ymd = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00.000Z`);
const n = (d: Prisma.Decimal | number) => Number(d);
const r2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;

type Tx = Prisma.TransactionClient;

@Injectable()
export class LeaveService {
  constructor(private prisma: PrismaService, private audit: AuditService, private attendance: AttendanceService) {}

  // ───────── Types & policies ─────────
  listTypes(companyId: string) { return this.prisma.leaveType.findMany({ where: { companyId }, orderBy: { code: 'asc' } }); }

  async createType(u: AuthUser, companyId: string, d: { code: string; name: string; paid?: boolean; encashable?: boolean }, ip?: string) {
    try {
      const row = await this.prisma.leaveType.create({ data: { ...d, code: d.code.toUpperCase(), companyId } });
      await this.audit.log({ userId: u.id, companyId, action: 'LEAVE_TYPE_CREATED', module: 'leave', recordId: row.id, newValue: row, ip });
      return row;
    } catch (e: any) {
      if (e.code === 'P2002') throw new ConflictException('Leave type code already exists');
      throw e;
    }
  }

  async updateType(u: AuthUser, companyId: string, id: string, d: Record<string, any>, ip?: string) {
    const old = await this.prisma.leaveType.findFirst({ where: { id, companyId } });
    if (!old) throw new NotFoundException('Leave type not found');
    const row = await this.prisma.leaveType.update({ where: { id }, data: d });
    await this.audit.log({ userId: u.id, companyId, action: 'LEAVE_TYPE_UPDATED', module: 'leave', recordId: id, oldValue: old, newValue: row, ip });
    return row;
  }

  async deleteType(u: AuthUser, companyId: string, id: string, ip?: string) {
    const old = await this.prisma.leaveType.findFirst({ where: { id, companyId } });
    if (!old) throw new NotFoundException('Leave type not found');
    const used = (await this.prisma.leaveTransaction.count({ where: { companyId, leaveTypeId: id } })) + (await this.prisma.leaveRequest.count({ where: { companyId, leaveTypeId: id } }));
    if (used) throw new ConflictException('Leave type has history and cannot be deleted');
    await this.prisma.$transaction([this.prisma.leavePolicy.deleteMany({ where: { companyId, leaveTypeId: id } }), this.prisma.leaveType.delete({ where: { id } })]);
    await this.audit.log({ userId: u.id, companyId, action: 'LEAVE_TYPE_DELETED', module: 'leave', recordId: id, oldValue: old, ip });
    return { ok: true };
  }

  listPolicies(companyId: string) { return this.prisma.leavePolicy.findMany({ where: { companyId }, include: { leaveType: { select: { code: true, name: true } } } }); }

  async savePolicy(u: AuthUser, companyId: string, d: { leaveTypeId: string; name: string; annualQuota: number; accrualRule?: object; carryForward?: number; maxAccumulation?: number }, ip?: string) {
    const type = await this.prisma.leaveType.findFirst({ where: { id: d.leaveTypeId, companyId } });
    if (!type) throw new BadRequestException('Unknown leave type');
    // One active policy per leave type: replace it.
    const old = await this.prisma.leavePolicy.findFirst({ where: { companyId, leaveTypeId: d.leaveTypeId } });
    const data = { name: d.name, annualQuota: d.annualQuota, accrualRule: (d.accrualRule ?? Prisma.DbNull) as any, carryForward: d.carryForward ?? 0, maxAccumulation: d.maxAccumulation ?? null };
    const row = old
      ? await this.prisma.leavePolicy.update({ where: { id: old.id }, data })
      : await this.prisma.leavePolicy.create({ data: { ...data, companyId, leaveTypeId: d.leaveTypeId } });
    await this.audit.log({ userId: u.id, companyId, action: 'LEAVE_POLICY_SAVED', module: 'leave', recordId: row.id, oldValue: old, newValue: row, ip });
    return row;
  }

  // ───────── Ledger & balances ─────────
  /** Every balance change is a ledger row plus a cached LeaveBalance update, in one transaction. */
  private async post(tx: Tx, companyId: string, employeeId: string, leaveTypeId: string, type: LeaveTxnType, days: number, date: string, note: string | null, by: string | null) {
    const year = Number(date.slice(0, 4));
    await tx.leaveTransaction.create({ data: { companyId, employeeId, leaveTypeId, type, days, date: ymd(date), note, createdBy: by } });
    const cur = await tx.leaveBalance.findUnique({ where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year } } });
    const balance = r2((cur ? n(cur.balance) : 0) + days);
    await tx.leaveBalance.upsert({
      where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year } },
      update: { balance }, create: { companyId, employeeId, leaveTypeId, year, balance },
    });
    return balance;
  }

  private async balanceOf(employeeId: string, leaveTypeId: string, year: number) {
    const b = await this.prisma.leaveBalance.findUnique({ where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year } } });
    return b ? n(b.balance) : 0;
  }

  private async employee(companyId: string, id: string) {
    const e = await this.prisma.employee.findFirst({ where: { id, companyId, deletedAt: null }, select: { id: true, doj: true, dol: true } });
    if (!e) throw new NotFoundException('Employee not found');
    return e;
  }
  private async type(companyId: string, id: string) {
    const t = await this.prisma.leaveType.findFirst({ where: { id, companyId } });
    if (!t) throw new BadRequestException('Unknown leave type');
    return t;
  }

  async balances(companyId: string, employeeId: string, year: number) {
    await this.employee(companyId, employeeId);
    const [types, bals] = await Promise.all([
      this.listTypes(companyId),
      this.prisma.leaveBalance.findMany({ where: { companyId, employeeId, year } }),
    ]);
    const m = new Map(bals.map((b) => [b.leaveTypeId, n(b.balance)]));
    return types.map((t) => ({ leaveTypeId: t.id, code: t.code, name: t.name, paid: t.paid, encashable: t.encashable, balance: m.get(t.id) ?? 0 }));
  }

  async ledger(companyId: string, employeeId: string, leaveTypeId?: string) {
    await this.employee(companyId, employeeId);
    return this.prisma.leaveTransaction.findMany({ where: { companyId, employeeId, ...(leaveTypeId ? { leaveTypeId } : {}) }, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], take: 200 });
  }

  async opening(u: AuthUser, companyId: string, d: { employeeId: string; leaveTypeId: string; year: number; days: number }, ip?: string) {
    await this.employee(companyId, d.employeeId); await this.type(companyId, d.leaveTypeId);
    const exists = await this.prisma.leaveTransaction.count({ where: { companyId, employeeId: d.employeeId, leaveTypeId: d.leaveTypeId, type: 'OPENING', date: { gte: ymd(`${d.year}-01-01`), lte: ymd(`${d.year}-12-31`) } } });
    if (exists) throw new ConflictException('Opening balance already set for this year. Use an adjustment to change it.');
    const bal = await this.prisma.$transaction((tx) => this.post(tx, companyId, d.employeeId, d.leaveTypeId, 'OPENING', d.days, `${d.year}-01-01`, 'Opening balance', u.id));
    await this.audit.log({ userId: u.id, companyId, action: 'LEAVE_OPENING_SET', module: 'leave', recordId: d.employeeId, newValue: d, ip });
    return { balance: bal };
  }

  async adjust(u: AuthUser, companyId: string, d: { employeeId: string; leaveTypeId: string; date: string; days: number; note: string }, ip?: string) {
    await this.employee(companyId, d.employeeId); await this.type(companyId, d.leaveTypeId);
    const bal = await this.prisma.$transaction((tx) => this.post(tx, companyId, d.employeeId, d.leaveTypeId, 'ADJUSTMENT', d.days, d.date, d.note, u.id));
    await this.audit.log({ userId: u.id, companyId, action: 'LEAVE_ADJUSTED', module: 'leave', recordId: d.employeeId, newValue: d, ip });
    return { balance: bal };
  }

  /**
   * Idempotent monthly accrual: re-running the same month never double-credits.
   * Balances for the whole policy are batch-read once and the writes for all employees are
   * grouped into a handful of transactions, instead of one $transaction per employee - at
   * 10k+ employees that used to mean tens of thousands of sequential round trips per run.
   */
  async accrue(u: AuthUser, companyId: string, year: number, month: number, ip?: string) {
    const policies = await this.prisma.leavePolicy.findMany({ where: { companyId } });
    const monthEnd = ymd(dateKey(year, month, daysInMonth(year, month)));
    const monthStart = ymd(dateKey(year, month, 1));
    const emps = await this.prisma.employee.findMany({
      where: { companyId, deletedAt: null, doj: { lte: monthEnd }, OR: [{ dol: null }, { dol: { gte: monthStart } }] }, select: { id: true },
    });
    const period = `${year}-${String(month).padStart(2, '0')}`;
    const accrualDate = dateKey(year, month, 1);
    let credited = 0;
    for (const p of policies) {
      const rule = (p.accrualRule as { frequency?: string; perPeriod?: number } | null) ?? {};
      const freq = rule.frequency ?? 'MONTHLY';
      if (freq === 'YEARLY' && month !== 1) continue;
      const amount = freq === 'YEARLY' ? n(p.annualQuota) : rule.perPeriod ?? r2(n(p.annualQuota) / 12);
      if (!(amount > 0)) continue;
      const key = `accrual:${period}`;
      const done = new Set((await this.prisma.leaveTransaction.findMany({ where: { companyId, leaveTypeId: p.leaveTypeId, type: 'ACCRUAL', note: key }, select: { employeeId: true } })).map((x) => x.employeeId));
      const pending = emps.filter((e) => !done.has(e.id));
      if (!pending.length) continue;
      const cap = p.maxAccumulation == null ? null : n(p.maxAccumulation);
      const bals = await this.prisma.leaveBalance.findMany({ where: { companyId, leaveTypeId: p.leaveTypeId, year, employeeId: { in: pending.map((e) => e.id) } } });
      const balBy = new Map(bals.map((b) => [b.employeeId, n(b.balance)]));
      const ops: Prisma.PrismaPromise<any>[] = [];
      for (const e of pending) {
        const have = balBy.get(e.id) ?? 0;
        const give = cap == null ? amount : Math.max(0, Math.min(amount, cap - have));
        if (!(give > 0)) continue;
        const newBalance = r2(have + give);
        ops.push(this.prisma.leaveTransaction.create({ data: { companyId, employeeId: e.id, leaveTypeId: p.leaveTypeId, type: 'ACCRUAL', days: give, date: ymd(accrualDate), note: key, createdBy: u.id } }));
        ops.push(this.prisma.leaveBalance.upsert({
          where: { employeeId_leaveTypeId_year: { employeeId: e.id, leaveTypeId: p.leaveTypeId, year } },
          update: { balance: newBalance }, create: { companyId, employeeId: e.id, leaveTypeId: p.leaveTypeId, year, balance: newBalance },
        }));
        credited++;
      }
      // Chunked so one policy's writes never sit in a single unbounded transaction at very large scale.
      for (let i = 0; i < ops.length; i += 2000) await this.prisma.$transaction(ops.slice(i, i + 2000));
    }
    await this.audit.log({ userId: u.id, companyId, action: 'LEAVE_ACCRUED', module: 'leave', recordId: period, newValue: { credited }, ip });
    return { period, credited };
  }

  async encash(u: AuthUser, companyId: string, d: { employeeId: string; leaveTypeId: string; days: number; date: string; note?: string }, ip?: string) {
    await this.employee(companyId, d.employeeId);
    const t = await this.type(companyId, d.leaveTypeId);
    if (!t.encashable) throw new BadRequestException(`${t.code} is not encashable`);
    const year = Number(d.date.slice(0, 4));
    if ((await this.balanceOf(d.employeeId, d.leaveTypeId, year)) < d.days) throw new BadRequestException('Insufficient leave balance to encash');
    // The payout amount is computed by the payroll engine from this ledger row.
    const bal = await this.prisma.$transaction((tx) => this.post(tx, companyId, d.employeeId, d.leaveTypeId, 'ENCASHMENT', -d.days, d.date, d.note ?? 'Encashment', u.id));
    await this.audit.log({ userId: u.id, companyId, action: 'LEAVE_ENCASHED', module: 'leave', recordId: d.employeeId, newValue: d, ip });
    return { balance: bal };
  }

  // ───────── Requests ─────────
  async listRequests(companyId: string, q: { status?: string; employeeId?: string; page: number; pageSize: number }) {
    const where: Prisma.LeaveRequestWhereInput = { companyId, ...(q.status ? { status: q.status as any } : {}), ...(q.employeeId ? { employeeId: q.employeeId } : {}) };
    const [total, items] = await Promise.all([
      this.prisma.leaveRequest.count({ where }),
      this.prisma.leaveRequest.findMany({
        where, orderBy: { fromDate: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize,
        include: { employee: { select: { code: true, firstName: true, lastName: true } }, leaveType: { select: { code: true, name: true } } },
      }),
    ]);
    return { total, page: q.page, pageSize: q.pageSize, items };
  }

  private async workingDates(companyId: string, from: string, to: string) {
    const s = await this.attendance.settings(companyId);
    const hol = await this.prisma.holiday.findMany({ where: { companyId, date: { gte: ymd(from), lte: ymd(to) } } });
    return workingDatesBetween(from, to, s.weeklyOff, new Set(hol.map((h) => iso(h.date))));
  }

  async request(u: AuthUser, companyId: string, d: { employeeId: string; leaveTypeId: string; fromDate: string; toDate: string; reason?: string }, ip?: string) {
    const emp = await this.employee(companyId, d.employeeId); await this.type(companyId, d.leaveTypeId);
    const from = d.fromDate.slice(0, 10), to = d.toDate.slice(0, 10);
    if (to < from) throw new BadRequestException('To date is before From date');
    if (from.slice(0, 4) !== to.slice(0, 4)) throw new BadRequestException('A request cannot span two calendar years. Split it in two.');
    if (from < iso(emp.doj) || (emp.dol && to > iso(emp.dol))) throw new BadRequestException('Dates are outside the employment period');
    const dates = await this.workingDates(companyId, from, to);
    if (!dates.length) throw new BadRequestException('No working days in the selected range (weekly offs/holidays only)');
    const overlap = await this.prisma.leaveRequest.count({ where: { companyId, employeeId: d.employeeId, status: { in: ['PENDING', 'APPROVED'] }, fromDate: { lte: ymd(to) }, toDate: { gte: ymd(from) } } });
    if (overlap) throw new ConflictException('This overlaps another pending/approved leave request');
    const row = await this.prisma.leaveRequest.create({ data: { companyId, employeeId: d.employeeId, leaveTypeId: d.leaveTypeId, fromDate: ymd(from), toDate: ymd(to), days: dates.length, reason: d.reason } });
    await this.audit.log({ userId: u.id, companyId, action: 'LEAVE_REQUESTED', module: 'leave', recordId: row.id, newValue: row, ip });
    return row;
  }

  private async load(companyId: string, id: string) {
    const r = await this.prisma.leaveRequest.findFirst({ where: { id, companyId }, include: { leaveType: true } });
    if (!r) throw new NotFoundException('Leave request not found');
    return r;
  }

  async approve(u: AuthUser, companyId: string, id: string, ip?: string) {
    const r = await this.load(companyId, id);
    if (r.status !== 'PENDING') throw new ConflictException(`Request is already ${r.status.toLowerCase()}`);
    const from = iso(r.fromDate), to = iso(r.toDate);
    const dates = await this.workingDates(companyId, from, to);
    const year = Number(from.slice(0, 4));
    if (r.leaveType.paid && (await this.balanceOf(r.employeeId, r.leaveTypeId, year)) < dates.length) throw new BadRequestException('Insufficient leave balance');
    await this.attendance.assertEditable(companyId, dates.map((x) => x.slice(0, 7)));
    const status = r.leaveType.paid ? 'PAID_LEAVE' : 'UNPAID_LEAVE';
    await this.prisma.$transaction(async (tx) => {
      await tx.leaveRequest.update({ where: { id }, data: { status: 'APPROVED', decidedBy: u.id, decidedAt: new Date(), days: dates.length } });
      if (r.leaveType.paid) await this.post(tx, companyId, r.employeeId, r.leaveTypeId, 'TAKEN', -dates.length, from, `request:${id}`, u.id);
      for (const dt of dates) {
        await tx.attendance.upsert({
          where: { employeeId_date: { employeeId: r.employeeId, date: ymd(dt) } },
          update: { status, source: 'LEAVE' }, create: { companyId, employeeId: r.employeeId, date: ymd(dt), status, source: 'LEAVE' },
        });
      }
    });
    await this.audit.log({ userId: u.id, companyId, action: 'LEAVE_APPROVED', module: 'leave', recordId: id, ip });
    return { ok: true };
  }

  async reject(u: AuthUser, companyId: string, id: string, ip?: string) {
    const r = await this.load(companyId, id);
    if (r.status !== 'PENDING') throw new ConflictException(`Request is already ${r.status.toLowerCase()}`);
    await this.prisma.leaveRequest.update({ where: { id }, data: { status: 'REJECTED', decidedBy: u.id, decidedAt: new Date() } });
    await this.audit.log({ userId: u.id, companyId, action: 'LEAVE_REJECTED', module: 'leave', recordId: id, ip });
    return { ok: true };
  }

  /** Cancelling an approved request restores the balance and clears the leave attendance it created. */
  async cancel(u: AuthUser, companyId: string, id: string, ip?: string) {
    const r = await this.load(companyId, id);
    if (r.status !== 'PENDING' && r.status !== 'APPROVED') throw new ConflictException(`Request is already ${r.status.toLowerCase()}`);
    if (r.status === 'PENDING') {
      await this.prisma.leaveRequest.update({ where: { id }, data: { status: 'CANCELLED', decidedBy: u.id, decidedAt: new Date() } });
    } else {
      const from = iso(r.fromDate), to = iso(r.toDate);
      const months: string[] = [];
      for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) months.push(new Date(t).toISOString().slice(0, 7));
      await this.attendance.assertEditable(companyId, months);
      await this.prisma.$transaction(async (tx) => {
        await tx.leaveRequest.update({ where: { id }, data: { status: 'CANCELLED', decidedBy: u.id, decidedAt: new Date() } });
        if (r.leaveType.paid) await this.post(tx, companyId, r.employeeId, r.leaveTypeId, 'ADJUSTMENT', n(r.days), from, `cancel:${id}`, u.id);
        await tx.attendance.deleteMany({ where: { companyId, employeeId: r.employeeId, date: { gte: r.fromDate, lte: r.toDate }, source: 'LEAVE' } });
      });
    }
    await this.audit.log({ userId: u.id, companyId, action: 'LEAVE_CANCELLED', module: 'leave', recordId: id, ip });
    return { ok: true };
  }
}
