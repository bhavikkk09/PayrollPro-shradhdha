import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';
import { Request } from 'express';
import { AuthUser } from '../common/auth.types';
import { CompanyAccessGuard } from '../common/company-access';
import { CurrentUser, RequirePermissions, InternalOnly } from '../common/decorators';
import { LeaveService } from './leave.service';

class TypeDto {
  @Matches(/^[A-Za-z][A-Za-z0-9_]{0,9}$/) code: string;
  @IsString() @Length(1, 60) name: string;
  @IsOptional() @IsBoolean() paid?: boolean;
  @IsOptional() @IsBoolean() encashable?: boolean;
}
class UpdateTypeDto extends PartialType(TypeDto) {}
class PolicyDto {
  @IsUUID() leaveTypeId: string;
  @IsString() @Length(1, 100) name: string;
  @IsNumber() @Min(0) @Max(366) annualQuota: number;
  @IsOptional() @IsObject() accrualRule?: { frequency?: string; perPeriod?: number };
  @IsOptional() @IsNumber() @Min(0) carryForward?: number;
  @IsOptional() @IsNumber() @Min(0) maxAccumulation?: number;
}
class OpeningDto {
  @IsUUID() employeeId: string; @IsUUID() leaveTypeId: string;
  @IsInt() @Min(2000) @Max(2100) year: number;
  @IsNumber() @Min(0) @Max(366) days: number;
}
class AdjustDto {
  @IsUUID() employeeId: string; @IsUUID() leaveTypeId: string; @IsDateString() date: string;
  @IsNumber() @Min(-366) @Max(366) days: number;
  @IsString() @Length(3, 200) note: string;
}
class AccrueDto {
  @IsInt() @Min(2000) @Max(2100) year: number;
  @IsInt() @Min(1) @Max(12) month: number;
}
class EncashDto {
  @IsUUID() employeeId: string; @IsUUID() leaveTypeId: string; @IsDateString() date: string;
  @IsNumber() @Min(0.5) @Max(366) days: number;
  @IsOptional() @IsString() @Length(0, 200) note?: string;
}
class RequestDto {
  @IsUUID() employeeId: string; @IsUUID() leaveTypeId: string;
  @IsDateString() fromDate: string; @IsDateString() toDate: string;
  @IsOptional() @IsString() @Length(0, 300) reason?: string;
}
class RequestsQuery {
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsUUID() employeeId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 25;
}
class BalanceQuery {
  @IsUUID() employeeId: string;
  @Type(() => Number) @IsInt() @Min(2000) @Max(2100) year: number;
}
class LedgerQuery {
  @IsUUID() employeeId: string;
  @IsOptional() @IsUUID() leaveTypeId?: string;
}

@ApiTags('Leave')
@ApiBearerAuth()
@UseGuards(CompanyAccessGuard)
@Controller('companies/:companyId/leave')
export class LeaveController {
  constructor(private svc: LeaveService) {}

  @Get('types') @RequirePermissions('leave.view')
  types(@Param('companyId') c: string) { return this.svc.listTypes(c); }
  @InternalOnly() @Post('types') @RequirePermissions('leave.manage')
  addType(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Body() d: TypeDto, @Req() r: Request) { return this.svc.createType(u, c, d, r.ip); }
  @InternalOnly() @Patch('types/:id') @RequirePermissions('leave.manage')
  editType(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Param('id') id: string, @Body() d: UpdateTypeDto, @Req() r: Request) { return this.svc.updateType(u, c, id, d, r.ip); }
  @InternalOnly() @Delete('types/:id') @RequirePermissions('leave.manage')
  delType(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Param('id') id: string, @Req() r: Request) { return this.svc.deleteType(u, c, id, r.ip); }

  @InternalOnly() @Get('policies') @RequirePermissions('leave.view')
  policies(@Param('companyId') c: string) { return this.svc.listPolicies(c); }
  @InternalOnly() @Put('policies') @RequirePermissions('leave.manage')
  savePolicy(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Body() d: PolicyDto, @Req() r: Request) { return this.svc.savePolicy(u, c, d, r.ip); }

  @Get('balances') @RequirePermissions('leave.view')
  balances(@Param('companyId') c: string, @Query() q: BalanceQuery) { return this.svc.balances(c, q.employeeId, q.year); }
  @Get('ledger') @RequirePermissions('leave.view')
  ledger(@Param('companyId') c: string, @Query() q: LedgerQuery) { return this.svc.ledger(c, q.employeeId, q.leaveTypeId); }
  @InternalOnly() @Post('opening') @RequirePermissions('leave.manage')
  opening(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Body() d: OpeningDto, @Req() r: Request) { return this.svc.opening(u, c, d, r.ip); }
  @InternalOnly() @Post('adjust') @RequirePermissions('leave.manage')
  adjust(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Body() d: AdjustDto, @Req() r: Request) { return this.svc.adjust(u, c, d, r.ip); }
  @InternalOnly() @Post('accrue') @RequirePermissions('leave.manage')
  accrue(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Body() d: AccrueDto, @Req() r: Request) { return this.svc.accrue(u, c, d.year, d.month, r.ip); }
  @InternalOnly() @Post('encash') @RequirePermissions('leave.manage')
  encash(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Body() d: EncashDto, @Req() r: Request) { return this.svc.encash(u, c, d, r.ip); }

  @Get('requests') @RequirePermissions('leave.view')
  requests(@Param('companyId') c: string, @Query() q: RequestsQuery) { return this.svc.listRequests(c, q); }
  @Post('requests') @RequirePermissions('leave.manage')
  request(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Body() d: RequestDto, @Req() r: Request) { return this.svc.request(u, c, d, r.ip); }
  @Post('requests/:id/approve') @RequirePermissions('leave.approve')
  approve(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Param('id') id: string, @Req() r: Request) { return this.svc.approve(u, c, id, r.ip); }
  @Post('requests/:id/reject') @RequirePermissions('leave.approve')
  reject(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Param('id') id: string, @Req() r: Request) { return this.svc.reject(u, c, id, r.ip); }
  @Post('requests/:id/cancel') @RequirePermissions('leave.manage')
  cancel(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Param('id') id: string, @Req() r: Request) { return this.svc.cancel(u, c, id, r.ip); }
}
