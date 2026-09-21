import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, Injectable, NotFoundException, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags, PartialType } from '@nestjs/swagger';
import { IsDateString, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';
import { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth.types';
import { CompanyAccessGuard } from '../common/company-access';
import { CurrentUser, RequirePermissions } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ymd = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00.000Z`);

class ShiftDto {
  @Matches(/^[A-Za-z0-9_]{1,10}$/) code: string;
  @IsString() @Length(1, 60) name: string;
  @IsOptional() @IsIn(['GENERAL', 'MORNING', 'NIGHT', 'ROTATIONAL']) type?: string;
  @Matches(HHMM, { message: 'Start time must be HH:MM' }) startTime: string;
  @Matches(HHMM, { message: 'End time must be HH:MM' }) endTime: string;
  @IsOptional() @IsInt() @Min(0) @Max(240) graceMinutes?: number;
  @IsOptional() @IsInt() @Min(0) @Max(240) breakMinutes?: number;
  @IsOptional() @IsObject() otRules?: object;
}
class UpdateShiftDto extends PartialType(ShiftDto) {}
class AssignDto {
  @IsUUID() employeeId: string;
  @IsUUID() shiftId: string;
  @IsDateString() fromDate: string;
}

/** Shift management is a per-company feature flag (default OFF). When off, every route here refuses. */
@Injectable()
class ShiftService {
  constructor(public prisma: PrismaService, public audit: AuditService) {}
  async requireEnabled(companyId: string) {
    const s = await this.prisma.companySettings.findUnique({ where: { companyId }, select: { shiftEnabled: true } });
    if (!s?.shiftEnabled) throw new ForbiddenException('Shift management is disabled for this company');
  }
}

@ApiTags('Shift (optional)')
@ApiBearerAuth()
@UseGuards(CompanyAccessGuard)
@Controller('companies/:companyId/shifts')
export class ShiftController {
  private svc: ShiftService;
  constructor(prisma: PrismaService, audit: AuditService) { this.svc = new ShiftService(prisma, audit); }
  private get db() { return this.svc.prisma; }

  @Get() @RequirePermissions('attendance.view')
  async list(@Param('companyId') c: string) {
    await this.svc.requireEnabled(c);
    return this.db.shift.findMany({ where: { companyId: c }, orderBy: { code: 'asc' }, include: { _count: { select: { assignments: true } } } });
  }

  @Post() @RequirePermissions('attendance.manage')
  async create(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Body() d: ShiftDto, @Req() r: Request) {
    await this.svc.requireEnabled(c);
    try {
      const row = await this.db.shift.create({ data: { ...d, code: d.code.toUpperCase(), companyId: c, otRules: d.otRules as any } });
      await this.svc.audit.log({ userId: u.id, companyId: c, action: 'SHIFT_CREATED', module: 'shift', recordId: row.id, newValue: row, ip: r.ip });
      return row;
    } catch (e: any) {
      if (e.code === 'P2002') throw new ConflictException('Shift code already exists');
      throw e;
    }
  }

  @Patch(':id') @RequirePermissions('attendance.manage')
  async update(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Param('id') id: string, @Body() d: UpdateShiftDto, @Req() r: Request) {
    await this.svc.requireEnabled(c);
    const old = await this.db.shift.findFirst({ where: { id, companyId: c } });
    if (!old) throw new NotFoundException('Shift not found');
    const { code, ...rest } = d;
    if (code && code.toUpperCase() !== old.code) throw new BadRequestException('Shift code cannot be changed');
    const row = await this.db.shift.update({ where: { id }, data: { ...rest, otRules: rest.otRules as any } });
    await this.svc.audit.log({ userId: u.id, companyId: c, action: 'SHIFT_UPDATED', module: 'shift', recordId: id, oldValue: old, newValue: row, ip: r.ip });
    return row;
  }

  @Delete(':id') @RequirePermissions('attendance.manage')
  async remove(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Param('id') id: string, @Req() r: Request) {
    await this.svc.requireEnabled(c);
    const old = await this.db.shift.findFirst({ where: { id, companyId: c } });
    if (!old) throw new NotFoundException('Shift not found');
    if (await this.db.shiftAssignment.count({ where: { companyId: c, shiftId: id } })) throw new ConflictException('Shift is assigned to employees');
    await this.db.shift.delete({ where: { id } });
    await this.svc.audit.log({ userId: u.id, companyId: c, action: 'SHIFT_DELETED', module: 'shift', recordId: id, oldValue: old, ip: r.ip });
    return { ok: true };
  }

  /** Assignment is optional per employee; attendance never requires one. */
  @Post('assign') @RequirePermissions('attendance.manage')
  async assign(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Body() d: AssignDto, @Req() r: Request) {
    await this.svc.requireEnabled(c);
    const [emp, shift] = await Promise.all([
      this.db.employee.findFirst({ where: { id: d.employeeId, companyId: c, deletedAt: null }, select: { id: true } }),
      this.db.shift.findFirst({ where: { id: d.shiftId, companyId: c }, select: { id: true } }),
    ]);
    if (!emp || !shift) throw new BadRequestException('Unknown employee or shift');
    const from = ymd(d.fromDate);
    const cur = await this.db.shiftAssignment.findFirst({ where: { companyId: c, employeeId: d.employeeId, toDate: null }, orderBy: { fromDate: 'desc' } });
    if (cur && from <= cur.fromDate) throw new BadRequestException('From date must be after the current assignment start');
    const row = await this.db.$transaction(async (tx) => {
      if (cur) await tx.shiftAssignment.update({ where: { id: cur.id }, data: { toDate: new Date(from.getTime() - 86_400_000) } });
      return tx.shiftAssignment.create({ data: { companyId: c, employeeId: d.employeeId, shiftId: d.shiftId, fromDate: from } });
    });
    await this.svc.audit.log({ userId: u.id, companyId: c, action: 'SHIFT_ASSIGNED', module: 'shift', recordId: d.employeeId, newValue: d, ip: r.ip });
    return row;
  }

  @Get('assignments/:employeeId') @RequirePermissions('attendance.view')
  async assignments(@Param('companyId') c: string, @Param('employeeId') e: string) {
    await this.svc.requireEnabled(c);
    return this.db.shiftAssignment.findMany({ where: { companyId: c, employeeId: e }, orderBy: { fromDate: 'desc' }, include: { shift: { select: { code: true, name: true } } } });
  }
}
