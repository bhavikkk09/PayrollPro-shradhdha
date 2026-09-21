import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Employee, Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth.types';
import { decrypt, encrypt, mask } from '../common/crypto';
import { PrismaService } from '../prisma/prisma.service';

const REF_FIELDS = [
  ['branchId', 'branch'], ['departmentId', 'department'], ['designationId', 'designation'],
  ['locationId', 'location'], ['reportingManagerId', 'employee'],
] as const;

export interface ListQuery { search?: string; status?: string; branchId?: string; departmentId?: string; page: number; pageSize: number }

@Injectable()
export class EmployeesService {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  async list(companyId: string, q: ListQuery) {
    const s = q.search?.trim();
    const where: Prisma.EmployeeWhereInput = {
      companyId, deletedAt: null,
      ...(q.status ? { status: q.status as any } : {}),
      ...(q.branchId ? { branchId: q.branchId } : {}),
      ...(q.departmentId ? { departmentId: q.departmentId } : {}),
      ...(s ? { OR: [
        { code: { contains: s, mode: 'insensitive' } }, { firstName: { contains: s, mode: 'insensitive' } },
        { lastName: { contains: s, mode: 'insensitive' } }, { uan: { contains: s } }, { mobile: { contains: s } },
      ] } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.employee.count({ where }),
      this.prisma.employee.findMany({
        where, orderBy: { code: 'asc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize,
        include: { department: { select: { name: true } }, designation: { select: { name: true } }, branch: { select: { name: true } } },
      }),
    ]);
    return { total, page: q.page, pageSize: q.pageSize, items: rows.map((r) => this.present(r, false)) };
  }

  async get(companyId: string, id: string, reveal: boolean) {
    const e = await this.prisma.employee.findFirst({ where: { id, companyId, deletedAt: null } });
    if (!e) throw new NotFoundException('Employee not found');
    return this.present(e, reveal);
  }

  async create(u: AuthUser, companyId: string, dto: Record<string, any>, ip?: string) {
    await this.assertRefs(companyId, dto);
    this.assertDates(dto);
    try {
      const e = await this.prisma.employee.create({ data: this.toData(dto, companyId) as Prisma.EmployeeUncheckedCreateInput });
      await this.audit.log({ userId: u.id, companyId, action: 'EMPLOYEE_CREATED', module: 'employee', recordId: e.id, newValue: this.present(e, false), ip });
      return this.present(e, false);
    } catch (x: any) {
      if (x.code === 'P2002') throw new ConflictException('Employee code already exists in this company');
      throw x;
    }
  }

  async update(u: AuthUser, companyId: string, id: string, dto: Record<string, any>, ip?: string) {
    const old = await this.prisma.employee.findFirst({ where: { id, companyId, deletedAt: null } });
    if (!old) throw new NotFoundException('Employee not found');
    await this.assertRefs(companyId, dto, id);
    this.assertDates({ doj: dto.doj ?? old.doj, dol: dto.dol !== undefined ? dto.dol : old.dol });
    try {
      const e = await this.prisma.employee.update({ where: { id }, data: this.toData(dto) });
      await this.audit.log({
        userId: u.id, companyId, action: 'EMPLOYEE_UPDATED', module: 'employee', recordId: id,
        oldValue: this.present(old, false), newValue: this.present(e, false), ip,
      });
      return this.present(e, false);
    } catch (x: any) {
      if (x.code === 'P2002') throw new ConflictException('Employee code already exists in this company');
      throw x;
    }
  }

  /** Soft delete so payroll history stays intact. */
  async remove(u: AuthUser, companyId: string, id: string, ip?: string) {
    const old = await this.prisma.employee.findFirst({ where: { id, companyId, deletedAt: null } });
    if (!old) throw new NotFoundException('Employee not found');
    const payslips = await this.prisma.payrollDetail.count({ where: { companyId, employeeId: id } });
    if (payslips) throw new ConflictException('Employee has payroll history. Mark as LEFT instead of deleting.');
    await this.prisma.employee.update({ where: { id }, data: { deletedAt: new Date(), status: 'INACTIVE' } });
    await this.audit.log({ userId: u.id, companyId, action: 'EMPLOYEE_DELETED', module: 'employee', recordId: id, oldValue: this.present(old, false), ip });
    return { ok: true };
  }

  /** Every referenced master must belong to the SAME company (blocks cross-tenant linking). */
  private async assertRefs(companyId: string, dto: Record<string, any>, selfId?: string) {
    for (const [field, model] of REF_FIELDS) {
      const v = dto[field];
      if (!v) continue;
      if (field === 'reportingManagerId' && v === selfId) throw new BadRequestException('Employee cannot report to themselves');
      const found = await (this.prisma as any)[model].findFirst({ where: { id: v, companyId }, select: { id: true } });
      if (!found) throw new BadRequestException(`Invalid ${field}`);
    }
  }

  private assertDates(d: { doj?: any; dol?: any }) {
    if (d.dol && d.doj && new Date(d.dol) < new Date(d.doj)) throw new BadRequestException('Date of leaving cannot be before date of joining');
  }

  private toData(dto: Record<string, any>, companyId?: string) {
    const { bankAccount, pan, aadhaarRef, doj, dol, dob, ...rest } = dto;
    const data: Record<string, any> = { ...rest };
    if (companyId) data.companyId = companyId;
    if (doj) data.doj = new Date(doj);
    if (dol !== undefined) data.dol = dol ? new Date(dol) : null;
    if (dob !== undefined) data.dob = dob ? new Date(dob) : null;
    if (bankAccount !== undefined) data.bankAccountEnc = encrypt(bankAccount);
    if (pan !== undefined) data.panEnc = encrypt(pan);
    if (aadhaarRef !== undefined) data.aadhaarRefEnc = encrypt(aadhaarRef);
    return data;
  }

  /** Strips ciphertext columns; exposes masked values, or clear text only when reveal=true. */
  private present(e: Employee & Record<string, any>, reveal: boolean) {
    const { bankAccountEnc, panEnc, aadhaarRefEnc, ...safe } = e;
    const pick = (enc: string | null) => (reveal ? decrypt(enc) : mask(decrypt(enc)));
    return { ...safe, bankAccount: pick(bankAccountEnc), pan: pick(panEnc), aadhaarRef: pick(aadhaarRefEnc), sensitiveRevealed: reveal };
  }
}
