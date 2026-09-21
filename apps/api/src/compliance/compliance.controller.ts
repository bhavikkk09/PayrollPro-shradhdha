import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { Request } from 'express';
import { AuthUser } from '../common/auth.types';
import { CompanyAccessGuard } from '../common/company-access';
import { CurrentUser, RequirePermissions, InternalOnly } from '../common/decorators';
import { ComplianceService } from './compliance.service';
import { MODULES } from './rule-validate';

const MOD = [...MODULES];

class RulesQuery { @IsOptional() @IsIn(MOD) module?: string; @IsOptional() @IsString() state?: string; }
class RuleDto {
  @IsIn(MOD) module: string;
  @IsOptional() @IsString() @Length(0, 60) state?: string;
  @IsString() effectiveFrom: string;
  @IsOptional() @IsNumber() wageCeiling?: number;
  @IsOptional() @IsNumber() threshold?: number;
  @IsOptional() @IsNumber() employeePercent?: number;
  @IsOptional() @IsNumber() employerPercent?: number;
  @IsOptional() slabs?: unknown;
  @IsOptional() @IsObject() rules?: Record<string, any>;
  @IsOptional() @IsString() @Length(0, 500) notes?: string;
}
class PreviewDto {
  @IsIn(MOD) module: string;
  @IsOptional() @IsString() state?: string;
  @IsString() asOf: string;
  @IsNumber() @Min(0) wage: number;
  @IsInt() @Min(1) @Max(12) month: number;
  @IsOptional() @IsNumber() annualTaxable?: number;
  @IsOptional() @IsNumber() tdsYtd?: number;
  @IsOptional() @IsInt() @Min(1) @Max(12) monthsRemaining?: number;
}
class CalendarQuery {
  @IsOptional() @IsUUID() companyId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(2000) @Max(2100) year?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(12) month?: number;
  @IsOptional() @IsIn(['UPCOMING', 'DUE_SOON', 'PENDING', 'COMPLETED', 'OVERDUE']) status?: string;
  @IsOptional() @IsIn(MOD) module?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) pageSize = 50;
}
class AssignDto { @IsOptional() @IsUUID() userId?: string; }
class CompleteDto { @IsOptional() @IsString() @Length(0, 100) challanRef?: string; }
class GenerateDto {
  @IsInt() @Min(2000) @Max(2100) year: number;
  @IsInt() @Min(1) @Max(12) month: number;
}
class RegDto {
  @IsOptional() @IsUUID() id?: string;
  @IsIn(MOD) module: string;
  @IsString() @Length(1, 60) number: string;
  @IsOptional() @IsString() @Length(0, 60) state?: string;
  @IsOptional() @IsObject() details?: object;
}
class PeriodQuery {
  @Type(() => Number) @IsInt() @Min(2000) @Max(2100) year: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(12) month: number;
}

/** Consultant-wide: rule master and the central calendar. */
@ApiTags('Compliance')
@ApiBearerAuth()
@Controller('compliance')
export class ComplianceController {
  constructor(private svc: ComplianceService) {}

  @InternalOnly() @Get('rules') @RequirePermissions('compliance.view')
  rules(@CurrentUser() u: AuthUser, @Query() q: RulesQuery) { return this.svc.listRules(u, q); }
  @InternalOnly() @Post('rules') @RequirePermissions('compliance.config')
  createRule(@CurrentUser() u: AuthUser, @Body() d: RuleDto, @Req() r: Request) { return this.svc.createRule(u, d as any, r.ip); }
  @InternalOnly() @Post('calc-preview') @RequirePermissions('compliance.view')
  preview(@CurrentUser() u: AuthUser, @Body() d: PreviewDto) { return this.svc.preview(u, d); }

  @Get('calendar') @RequirePermissions('compliance.view')
  calendar(@CurrentUser() u: AuthUser, @Query() q: CalendarQuery) { return this.svc.calendar(u, q); }
  @InternalOnly() @Get('tasks/:id/assignees') @RequirePermissions('compliance.view')
  assignees(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.assignees(u, id); }
  @Post('tasks/:id/assign') @RequirePermissions('compliance.manage')
  assign(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() d: AssignDto, @Req() r: Request) { return this.svc.assign(u, id, d.userId ?? null, r.ip); }
  @Post('tasks/:id/complete') @RequirePermissions('compliance.manage')
  complete(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() d: CompleteDto, @Req() r: Request) { return this.svc.complete(u, id, d, r.ip); }
  @Post('tasks/:id/reopen') @RequirePermissions('compliance.manage')
  reopen(@CurrentUser() u: AuthUser, @Param('id') id: string, @Req() r: Request) { return this.svc.reopen(u, id, r.ip); }
}

@ApiTags('Compliance')
@ApiBearerAuth()
@UseGuards(CompanyAccessGuard)
@Controller('companies/:companyId/compliance')
export class CompanyComplianceController {
  constructor(private svc: ComplianceService) {}

  @Get('registrations') @RequirePermissions('compliance.view')
  regs(@Param('companyId') c: string) { return this.svc.listRegistrations(c); }
  @Put('registrations') @RequirePermissions('compliance.manage')
  saveReg(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Body() d: RegDto, @Req() r: Request) { return this.svc.saveRegistration(u, c, d, r.ip); }
  @Delete('registrations/:id') @RequirePermissions('compliance.manage')
  delReg(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Param('id') id: string, @Req() r: Request) { return this.svc.deleteRegistration(u, c, id, r.ip); }

  @Post('tasks/generate') @RequirePermissions('compliance.manage')
  generate(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Body() d: GenerateDto, @Req() r: Request) { return this.svc.generate(u, c, d.year, d.month, r.ip); }
  @Get('summary') @RequirePermissions('compliance.view')
  summary(@Param('companyId') c: string, @Query() q: PeriodQuery) { return this.svc.summary(c, q.year, q.month); }
}
