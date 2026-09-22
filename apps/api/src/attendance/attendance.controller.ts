import { Body, Controller, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Request } from 'express';
import { AuthUser } from '../common/auth.types';
import { CompanyAccessGuard } from '../common/company-access';
import { CurrentUser, RequirePermissions, InternalOnly } from '../common/decorators';
import { STATUSES } from './attendance-summary';
import { AttendanceService } from './attendance.service';

class MonthQuery {
  @Type(() => Number) @IsInt() @Min(2000) @Max(2100) year: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(12) month: number;
  @IsOptional() @IsString() search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) pageSize = 50;
}
class EntryDto {
  @IsUUID() employeeId: string;
  @IsDateString() date: string;
  @IsIn(STATUSES) status: any;
  @IsOptional() @IsNumber() @Min(0) @Max(24) otHours?: number;
}
class SaveDto { @IsArray() @ArrayMaxSize(5000) @ValidateNested({ each: true }) @Type(() => EntryDto) entries: EntryDto[]; }
class RowDto {
  @IsOptional() employeeCode?: unknown;
  @IsOptional() date?: unknown;
  @IsOptional() status?: unknown;
  @IsOptional() otHours?: unknown;
}
class ValidateDto {
  @IsString() @MaxLength(200) fileName: string;
  @IsArray() @ArrayMaxSize(20000) @ValidateNested({ each: true }) @Type(() => RowDto) rows: RowDto[];
}
class ConfirmDto { @IsOptional() @IsBoolean() skipInvalid?: boolean; }
class QuickRowDto {
  @IsOptional() employeeCode?: unknown;
  @IsOptional() paidDays?: unknown;
  @IsOptional() otHours?: unknown;
}
class QuickValidateDto {
  @IsString() @MaxLength(200) fileName: string;
  @IsInt() @Min(2000) @Max(2100) year: number;
  @IsInt() @Min(1) @Max(12) month: number;
  @IsArray() @ArrayMaxSize(2000) @ValidateNested({ each: true }) @Type(() => QuickRowDto) rows: QuickRowDto[];
}
class FinalizeDto {
  @IsInt() @Min(2000) @Max(2100) year: number;
  @IsInt() @Min(1) @Max(12) month: number;
  @IsOptional() @IsIn(STATUSES) unmarkedAs?: any;
}
class ReopenDto {
  @IsInt() @Min(2000) @Max(2100) year: number;
  @IsInt() @Min(1) @Max(12) month: number;
}

@ApiTags('Attendance')
@ApiBearerAuth()
@UseGuards(CompanyAccessGuard)
@Controller('companies/:companyId/attendance')
export class AttendanceController {
  constructor(private svc: AttendanceService) {}

  @Get() @RequirePermissions('attendance.view')
  grid(@Param('companyId') c: string, @Query() q: MonthQuery) { return this.svc.grid(c, q.year, q.month, q); }

  @Put() @RequirePermissions('attendance.manage')
  save(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Body() d: SaveDto, @Req() r: Request) { return this.svc.saveEntries(u, c, d.entries, r.ip); }

  @Post('import/validate') @RequirePermissions('attendance.manage')
  validate(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Body() d: ValidateDto) { return this.svc.importValidate(u, c, d.fileName, d.rows); }

  @Post('import/:jobId/confirm') @RequirePermissions('attendance.manage')
  confirm(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Param('jobId') j: string, @Body() d: ConfirmDto, @Req() r: Request) { return this.svc.importConfirm(u, c, j, !!d.skipInvalid, r.ip); }

  /** For consultants who only get a total "days worked" per employee, not a daily register. */
  @Post('quick-import/validate') @RequirePermissions('attendance.manage')
  quickValidate(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Body() d: QuickValidateDto) { return this.svc.quickImportValidate(u, c, d.fileName, d.year, d.month, d.rows); }

  @Post('quick-import/:jobId/confirm') @RequirePermissions('attendance.manage')
  quickConfirm(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Param('jobId') j: string, @Body() d: ConfirmDto, @Req() r: Request) { return this.svc.quickImportConfirm(u, c, j, !!d.skipInvalid, r.ip); }

  @InternalOnly() @Post('finalize') @RequirePermissions('attendance.manage')
  finalize(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Body() d: FinalizeDto, @Req() r: Request) { return this.svc.finalize(u, c, d.year, d.month, d.unmarkedAs, r.ip); }

  @InternalOnly() @Post('reopen') @RequirePermissions('attendance.manage')
  reopen(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Body() d: ReopenDto, @Req() r: Request) { return this.svc.reopen(u, c, d.year, d.month, r.ip); }
}
