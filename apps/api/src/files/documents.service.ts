import { BadRequestException, Injectable, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { IMAGE_EXT, validateUpload } from './file-validate';
import { FileStorage } from './storage';

export const COMPANY_CATEGORIES = ['REGISTRATION_CERTIFICATE', 'PF', 'ESI', 'LABOUR_LICENSE', 'EMPLOYEE', 'PAYROLL', 'COMPLIANCE', 'OTHER'];
export const EMPLOYEE_CATEGORIES = ['ID_PROOF', 'ADDRESS_PROOF', 'EDUCATION', 'APPOINTMENT_LETTER', 'BANK', 'MEDICAL', 'OTHER'];
// Read at call time (not module load) so it can be tuned by redeploying env without a code change.
const quotaBytes = () => Number(process.env.MAX_COMPANY_STORAGE_MB ?? 500) * 1024 * 1024;
const LOGO_MAX = 500 * 1024;
const day = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00.000Z`);

export type Scope =
  | { kind: 'company'; companyId: string }
  | { kind: 'employee'; companyId: string; employeeId: string }
  | { kind: 'task'; companyId: string; taskId: string };

export interface Meta { category?: string; title?: string; expiryDate?: string; reminderDaysBefore?: number }
export interface DocItem { id: string; title: string; category: string; fileName: string; mimeType: string; sizeBytes: number; expiryDate: string | null; reminderDaysBefore: number | null; createdAt: Date }

@Injectable()
export class DocumentsService {
  constructor(private prisma: PrismaService, private storage: FileStorage, private audit: AuditService) {}

  // The three kinds live in three tables; these helpers hide the differences.
  private db(s: Scope): any { return s.kind === 'company' ? this.prisma.document : s.kind === 'employee' ? this.prisma.employeeDocument : this.prisma.complianceDocument; }
  private where(s: Scope): any {
    return s.kind === 'company' ? { companyId: s.companyId } : s.kind === 'employee' ? { companyId: s.companyId, employeeId: s.employeeId } : { task: { id: s.taskId, companyId: s.companyId } };
  }
  private present(s: Scope, r: any): DocItem {
    return {
      id: r.id, title: r.title ?? r.fileName, category: s.kind === 'task' ? 'COMPLIANCE' : r.category, fileName: r.fileName, mimeType: r.mimeType, sizeBytes: r.sizeBytes,
      expiryDate: r.expiryDate ? r.expiryDate.toISOString().slice(0, 10) : null, reminderDaysBefore: r.reminderDaysBefore ?? null, createdAt: r.createdAt,
    };
  }
  private categories(s: Scope) { return s.kind === 'employee' ? EMPLOYEE_CATEGORIES : COMPANY_CATEGORIES; }

  /** Employees and tasks must belong to the authorised company, or the request looks like it does not exist. */
  private async assertParent(s: Scope) {
    if (s.kind === 'employee') { if (!(await this.prisma.employee.findFirst({ where: { id: s.employeeId, companyId: s.companyId, deletedAt: null }, select: { id: true } }))) throw new NotFoundException('Employee not found'); }
    if (s.kind === 'task') { if (!(await this.prisma.complianceTask.findFirst({ where: { id: s.taskId, companyId: s.companyId }, select: { id: true } }))) throw new NotFoundException('Task not found'); }
  }

  async list(s: Scope, q: { category?: string; search?: string; expiringInDays?: number; page: number; pageSize: number }) {
    await this.assertParent(s);
    const where: any = { ...this.where(s) };
    if (q.category && s.kind !== 'task') where.category = q.category;
    if (q.search) where[s.kind === 'company' ? 'title' : 'fileName'] = { contains: q.search, mode: 'insensitive' };
    if (q.expiringInDays != null && s.kind !== 'task') where.expiryDate = { not: null, lte: new Date(Date.now() + q.expiringInDays * 86_400_000) };
    const [total, rows] = await Promise.all([
      this.db(s).count({ where }),
      this.db(s).findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { total, page: q.page, pageSize: q.pageSize, items: rows.map((r: any) => this.present(s, r)) };
  }

  private async usedBytes(companyId: string) {
    const [a, b, c] = await Promise.all([
      this.prisma.document.aggregate({ where: { companyId }, _sum: { sizeBytes: true } }),
      this.prisma.employeeDocument.aggregate({ where: { companyId }, _sum: { sizeBytes: true } }),
      this.prisma.complianceDocument.aggregate({ where: { task: { companyId } }, _sum: { sizeBytes: true } }),
    ]);
    return (a._sum.sizeBytes ?? 0) + (b._sum.sizeBytes ?? 0) + (c._sum.sizeBytes ?? 0);
  }

  async upload(u: AuthUser, s: Scope, file: { originalname: string; buffer: Buffer } | undefined, meta: Meta, ip?: string): Promise<DocItem> {
    await this.assertParent(s);
    const checked = validateUpload(file?.originalname ?? '', file?.buffer);
    const category = s.kind === 'task' ? 'COMPLIANCE' : meta.category ?? 'OTHER';
    if (!this.categories(s).includes(category) && s.kind !== 'task') throw new BadRequestException(`Category must be one of: ${this.categories(s).join(', ')}`);
    if ((await this.usedBytes(s.companyId)) + checked.size > quotaBytes()) throw new PayloadTooLargeException('Storage limit for this company is reached');

    const key = `${s.companyId}/${randomUUID()}`; // never derived from user input
    await this.storage.put(key, file!.buffer);
    try {
      const base = { fileKey: key, fileName: checked.name, mimeType: checked.mime, sizeBytes: checked.size, uploadedBy: u.id };
      const row = await this.db(s).create({
        data: s.kind === 'company'
          ? { ...base, companyId: s.companyId, category, title: (meta.title?.trim() || checked.name).slice(0, 150), expiryDate: meta.expiryDate ? day(meta.expiryDate) : null, reminderDaysBefore: meta.reminderDaysBefore ?? null }
          : s.kind === 'employee'
            ? { ...base, companyId: s.companyId, employeeId: s.employeeId, category, expiryDate: meta.expiryDate ? day(meta.expiryDate) : null }
            : { ...base, taskId: s.taskId },
      });
      await this.audit.log({ userId: u.id, companyId: s.companyId, action: 'DOCUMENT_UPLOADED', module: 'documents', recordId: row.id, newValue: { scope: s.kind, category, fileName: checked.name, sizeBytes: checked.size }, ip });
      return this.present(s, row);
    } catch (e) {
      await this.storage.delete(key); // no orphaned file if the record could not be saved
      throw e;
    }
  }

  private async find(s: Scope, id: string) {
    await this.assertParent(s);
    const row = await this.db(s).findFirst({ where: { id, ...this.where(s) } });
    if (!row) throw new NotFoundException('Document not found');
    return row;
  }

  async read(u: AuthUser, s: Scope, id: string, ip?: string) {
    const row = await this.find(s, id);
    const data = await this.storage.get(row.fileKey);
    if (!data) throw new NotFoundException('The stored file is missing');
    if (s.kind === 'employee') await this.audit.log({ userId: u.id, companyId: s.companyId, action: 'EMPLOYEE_DOCUMENT_DOWNLOADED', module: 'documents', recordId: id, ip });
    const ext = row.fileName.split('.').pop()?.toLowerCase() ?? '';
    return { data, mime: row.mimeType as string, name: row.fileName as string, inlineOk: ['pdf', ...IMAGE_EXT].includes(ext) };
  }

  async update(u: AuthUser, s: Scope, id: string, d: Meta, ip?: string) {
    if (s.kind === 'task') throw new BadRequestException('Task files cannot be edited');
    const old = await this.find(s, id);
    if (d.category && !this.categories(s).includes(d.category)) throw new BadRequestException(`Category must be one of: ${this.categories(s).join(', ')}`);
    const data: any = {};
    if (d.category) data.category = d.category;
    if (d.title !== undefined && s.kind === 'company') data.title = d.title.trim().slice(0, 150) || old.title;
    if (d.expiryDate !== undefined) data.expiryDate = d.expiryDate ? day(d.expiryDate) : null;
    if (d.reminderDaysBefore !== undefined && s.kind === 'company') data.reminderDaysBefore = d.reminderDaysBefore;
    const row = await this.db(s).update({ where: { id }, data });
    await this.audit.log({ userId: u.id, companyId: s.companyId, action: 'DOCUMENT_UPDATED', module: 'documents', recordId: id, oldValue: { category: old.category, title: old.title, expiryDate: old.expiryDate }, newValue: data, ip });
    return this.present(s, row);
  }

  async remove(u: AuthUser, s: Scope, id: string, ip?: string) {
    const row = await this.find(s, id);
    await this.db(s).delete({ where: { id } });
    await this.storage.delete(row.fileKey);
    await this.audit.log({ userId: u.id, companyId: s.companyId, action: 'DOCUMENT_DELETED', module: 'documents', recordId: id, oldValue: { scope: s.kind, fileName: row.fileName, category: row.category }, ip });
    return { ok: true };
  }

  // ───────── Company logo (used on payslips) ─────────
  async setLogo(u: AuthUser, companyId: string, file: { originalname: string; buffer: Buffer } | undefined, ip?: string) {
    const checked = validateUpload(file?.originalname ?? '', file?.buffer, IMAGE_EXT);
    if (checked.size > LOGO_MAX) throw new PayloadTooLargeException('Logo must be under 500 KB');
    const key = `${companyId}/logo-${randomUUID()}`;
    await this.storage.put(key, file!.buffer);
    const old = await this.prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { logoUrl: true } });
    await this.prisma.company.update({ where: { id: companyId }, data: { logoUrl: `blob:${key}` } });
    if (old.logoUrl?.startsWith('blob:')) await this.storage.delete(old.logoUrl.slice(5));
    await this.audit.log({ userId: u.id, companyId, action: 'COMPANY_LOGO_CHANGED', module: 'company', recordId: companyId, ip });
    return { ok: true };
  }

  async getLogo(companyId: string): Promise<{ data: Buffer; mime: string } | null> {
    const c = await this.prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { logoUrl: true } });
    if (!c.logoUrl?.startsWith('blob:')) return null;
    const data = await this.storage.get(c.logoUrl.slice(5));
    if (!data) return null;
    return { data, mime: data[0] === 0x89 ? 'image/png' : 'image/jpeg' };
  }

  async removeLogo(u: AuthUser, companyId: string, ip?: string) {
    const c = await this.prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { logoUrl: true } });
    if (c.logoUrl?.startsWith('blob:')) await this.storage.delete(c.logoUrl.slice(5));
    await this.prisma.company.update({ where: { id: companyId }, data: { logoUrl: null } });
    await this.audit.log({ userId: u.id, companyId, action: 'COMPANY_LOGO_REMOVED', module: 'company', recordId: companyId, ip });
    return { ok: true };
  }
}
