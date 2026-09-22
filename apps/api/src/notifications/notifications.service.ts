import { Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { NotificationType, Prisma } from '@prisma/client';
import { AuthUser } from '../common/auth.types';
import { ComplianceService } from '../compliance/compliance.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Future delivery channels (email, SMS, WhatsApp) implement this and are registered under CHANNELS.
 * The in-app inbox is always written first; a failing channel never blocks or loses a notification.
 */
export interface NotificationChannel { readonly name: string; send(userId: string, n: { type: NotificationType; title: string; body?: string }): Promise<void> }
export const CHANNELS = 'NOTIFICATION_CHANNELS';

type Client = 'CLIENT_ADMIN' | 'CLIENT_HR';
/** Who is told about what. Anything not listed for clients is firm-internal. */
const CLIENT_ROLES: Partial<Record<NotificationType, Client[]>> = {
  ATTENDANCE_PENDING: ['CLIENT_ADMIN', 'CLIENT_HR'], PAYROLL_APPROVED: ['CLIENT_ADMIN'], PAYROLL_LOCKED: ['CLIENT_ADMIN'],
  COMPLIANCE_DUE: ['CLIENT_ADMIN'], COMPLIANCE_OVERDUE: ['CLIENT_ADMIN'], DOCUMENT_EXPIRY: ['CLIENT_ADMIN', 'CLIENT_HR'],
};

export interface Payload { title: string; body?: string; link?: string; refKey?: string }
const iso = (d: Date) => d.toISOString().slice(0, 10);
const PENDING_AFTER_DAY = Number(process.env.PENDING_AFTER_DAY ?? 3);

@Injectable()
export class NotificationsService {
  private log = new Logger('Notifications');
  constructor(
    private prisma: PrismaService,
    @Optional() private compliance?: ComplianceService,
    @Optional() @Inject(CHANNELS) private channels: NotificationChannel[] = [],
  ) {}

  // ───────── Recipients ─────────
  /** Firm admins, staff linked to the company, and (for client-facing types) the company's client users. */
  async recipients(companyId: string, type: NotificationType): Promise<string[]> {
    const company = await this.prisma.company.findUnique({ where: { id: companyId }, select: { consultantId: true } });
    if (!company) return [];
    const clientRoles = CLIENT_ROLES[type];
    const users = await this.prisma.user.findMany({
      where: {
        active: true,
        OR: [
          { type: 'CONSULTANT', consultantId: company.consultantId, roles: { some: { role: { key: 'CONSULTANT_ADMIN' } } } },
          { type: 'CONSULTANT', companyAccess: { some: { companyId } } },
          ...(clientRoles ? [{ type: 'CLIENT' as const, companyAccess: { some: { companyId } } }] : []),
        ],
      },
      select: { id: true, type: true, roles: { select: { role: { select: { key: true } } } } },
    });
    return users.filter((u) => u.type !== 'CLIENT' || u.roles.some((r) => clientRoles?.includes(r.role.key as Client))).map((u) => u.id);
  }

  /** Writes one inbox row per recipient. With a refKey the call is idempotent: the same event never notifies twice. */
  async notify(companyId: string, type: NotificationType, p: Payload): Promise<number> {
    const ids = await this.recipients(companyId, type);
    return this.write(ids, companyId, type, p);
  }

  notifyUser(userId: string, companyId: string | null, type: NotificationType, p: Payload) {
    return this.write([userId], companyId, type, p);
  }

  private async write(userIds: string[], companyId: string | null, type: NotificationType, p: Payload): Promise<number> {
    if (!userIds.length) return 0;
    const res = await this.prisma.notification.createMany({
      data: userIds.map((userId) => ({ userId, companyId, type, title: p.title.slice(0, 200), body: p.body?.slice(0, 500), link: p.link, dedupeKey: p.refKey ? `${p.refKey}:${userId}` : null })),
      skipDuplicates: true,
    });
    for (const ch of this.channels ?? []) for (const userId of userIds) ch.send(userId, { type, title: p.title, body: p.body }).catch((e) => this.log.warn(`${ch.name}: ${e?.message ?? e}`));
    return res.count;
  }

  /** Fire-and-forget for business events: a notification problem must never fail the action that triggered it. */
  safe(fn: () => Promise<unknown>) { fn().catch((e) => this.log.warn(`notification failed: ${e?.message ?? e}`)); }

  // ───────── Inbox (always the caller's own) ─────────
  async list(u: AuthUser, q: { unread?: boolean; page: number; pageSize: number }) {
    const where: Prisma.NotificationWhereInput = { userId: u.id, ...(q.unread ? { readAt: null } : {}) };
    const [total, unread, items] = await Promise.all([
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { userId: u.id, readAt: null } }),
      this.prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { total, unread, page: q.page, pageSize: q.pageSize, items };
  }

  unreadCount(u: AuthUser) { return this.prisma.notification.count({ where: { userId: u.id, readAt: null } }).then((count) => ({ count })); }

  async markRead(u: AuthUser, id: string) {
    const r = await this.prisma.notification.updateMany({ where: { id, userId: u.id }, data: { readAt: new Date() } });
    if (!r.count) throw new NotFoundException('Notification not found'); // someone else's notification looks like it does not exist
    return { ok: true };
  }

  async markAllRead(u: AuthUser) {
    const r = await this.prisma.notification.updateMany({ where: { userId: u.id, readAt: null }, data: { readAt: new Date() } });
    return { marked: r.count };
  }

  // ───────── Scheduled checks ─────────
  /** Idempotent: safe to run as often as you like, or from several servers at once. */
  async sweep(now = new Date()) {
    const out = { compliance: 0, documents: 0, attendance: 0, payroll: 0, cleaned: 0 };
    const today = iso(now);
    if (this.compliance) await this.compliance.refreshStatuses('ALL');

    // Compliance filings due soon / overdue
    const tasks = await this.prisma.complianceTask.findMany({ where: { status: { in: ['DUE_SOON', 'OVERDUE'] } }, take: 2000, select: { id: true, companyId: true, name: true, dueDate: true, status: true } });
    for (const t of tasks) {
      const overdue = t.status === 'OVERDUE';
      out.compliance += await this.notify(t.companyId, overdue ? 'COMPLIANCE_OVERDUE' : 'COMPLIANCE_DUE', {
        title: `${t.name} ${overdue ? 'is overdue' : 'is due soon'}`, body: `Due ${iso(t.dueDate)}`, link: 'compliance', refKey: `cmp-${overdue ? 'overdue' : 'due'}:${t.id}`,
      });
    }

    // Documents expiring (or expired)
    const horizon = new Date(now.getTime() + 90 * 86_400_000);
    const [cdocs, edocs] = await Promise.all([
      this.prisma.document.findMany({ where: { expiryDate: { not: null, lte: horizon } }, take: 2000, select: { id: true, companyId: true, title: true, expiryDate: true, reminderDaysBefore: true } }),
      this.prisma.employeeDocument.findMany({ where: { expiryDate: { not: null, lte: horizon } }, take: 2000, select: { id: true, companyId: true, fileName: true, expiryDate: true, employee: { select: { code: true } } } }),
    ]);
    const docs = [
      ...cdocs.map((d) => ({ kind: 'c', id: d.id, companyId: d.companyId, label: d.title, expiry: d.expiryDate!, remind: d.reminderDaysBefore ?? 30 })),
      ...edocs.map((d) => ({ kind: 'e', id: d.id, companyId: d.companyId, label: `${d.fileName} (${d.employee.code})`, expiry: d.expiryDate!, remind: 30 })),
    ];
    for (const d of docs) {
      const days = Math.ceil((d.expiry.getTime() - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
      if (days > d.remind) continue;
      const expired = days < 0;
      out.documents += await this.notify(d.companyId, 'DOCUMENT_EXPIRY', {
        title: expired ? `Document expired: ${d.label}` : `Document expiring in ${days} day${days === 1 ? '' : 's'}: ${d.label}`, body: `Expiry date ${iso(d.expiry)}`, link: 'documents', refKey: `docexp:${d.kind}${d.id}:${expired ? 'expired' : 'soon'}`,
      });
    }

    // Last month's attendance / payroll still open after the grace day
    if (now.getUTCDate() >= PENDING_AFTER_DAY) {
      const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      const y = prev.getUTCFullYear(), m = prev.getUTCMonth() + 1, label = `${prev.toLocaleString('en', { month: 'long', timeZone: 'UTC' })} ${y}`;
      const [companies, fin, runs] = await Promise.all([
        this.prisma.company.findMany({ where: { status: 'ACTIVE', deletedAt: null, employees: { some: { status: 'ACTIVE', deletedAt: null } } }, select: { id: true, name: true, settings: { select: { attendanceEnabled: true } } }, take: 5000 }),
        this.prisma.attendanceSummary.groupBy({ by: ['companyId'], where: { year: y, month: m, finalized: true } }),
        this.prisma.payrollRun.findMany({ where: { year: y, month: m, type: 'MONTHLY', status: { in: ['APPROVED', 'LOCKED'] } }, select: { companyId: true } }),
      ]);
      const attDone = new Set(fin.map((f) => f.companyId)), payDone = new Set(runs.map((r) => r.companyId));
      for (const c of companies) {
        if ((c.settings?.attendanceEnabled ?? true) && !attDone.has(c.id)) out.attendance += await this.notify(c.id, 'ATTENDANCE_PENDING', { title: `Attendance for ${label} is not finalized`, body: c.name, link: 'attendance', refKey: `att-pending:${c.id}:${y}-${m}` });
        if (!payDone.has(c.id)) out.payroll += await this.notify(c.id, 'PAYROLL_PENDING', { title: `Payroll for ${label} is not approved`, body: c.name, link: 'payroll', refKey: `pay-pending:${c.id}:${y}-${m}` });
      }
    }

    // Read notifications are kept 60 days
    out.cleaned = (await this.prisma.notification.deleteMany({ where: { readAt: { not: null, lt: new Date(now.getTime() - 60 * 86_400_000) } } })).count;
    return out;
  }
}
