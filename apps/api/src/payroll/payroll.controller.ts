import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { Request } from 'express';
import { AuthUser } from '../common/auth.types';
import { CompanyAccessGuard } from '../common/company-access';
import { CurrentUser, RequirePermissions } from '../common/decorators';
import { PayrollService } from './payroll.service';

class YearQuery { @IsOptional() @Type(() => Number) @IsInt() year?: number; }
class RunDto {
  @IsInt() @Min(2000) @Max(2100) year: number;
  @IsInt() @Min(1) @Max(12) month: number;
}
class DetailsQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) pageSize = 50;
  @IsOptional() @IsString() search?: string;
  @IsOptional() @Transform(({ value }) => value === 'true') @IsBoolean() warningsOnly?: boolean;
}
class ApproveDto { @IsOptional() @IsBoolean() acknowledgeSkipped?: boolean; }
class UnlockDto { @IsString() @Length(10, 500) reason: string; }
class MonthQuery {
  @Type(() => Number) @IsInt() @Min(2000) @Max(2100) year: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(12) month: number;
}
class InputDto {
  @IsUUID() employeeId: string;
  @IsInt() @Min(2000) @Max(2100) year: number;
  @IsInt() @Min(1) @Max(12) month: number;
  @IsIn(['ARREAR', 'BONUS', 'INCENTIVE', 'OTHER_EARNING', 'OTHER_DEDUCTION']) kind: string;
  @IsString() @Length(1, 100) name: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(100000000) amount: number;
  @IsOptional() @IsString() @Length(0, 300) note?: string;
}
class BulkDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @IsUUID('all', { each: true }) companyIds: string[];
  @IsInt() @Min(2000) @Max(2100) year: number;
  @IsInt() @Min(1) @Max(12) month: number;
}

@ApiTags('Payroll')
@ApiBearerAuth()
@UseGuards(CompanyAccessGuard)
@Controller('companies/:companyId/payroll')
export class PayrollController {
  constructor(private svc: PayrollService) {}

  @Get('runs') @RequirePermissions('payroll.view')
  runs(@Param('companyId') c: string, @Query() q: YearQuery) { return this.svc.listRuns(c, q.year); }
  @Post('runs') @RequirePermissions('payroll.process')
  create(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Body() d: RunDto, @Req() r: Request) { return this.svc.createRun(u, c, d.year, d.month, r.ip); }
  @Get('runs/:id') @RequirePermissions('payroll.view')
  run(@Param('companyId') c: string, @Param('id') id: string) { return this.svc.getRun(c, id); }
  @Delete('runs/:id') @RequirePermissions('payroll.process')
  remove(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Param('id') id: string, @Req() r: Request) { return this.svc.deleteRun(u, c, id, r.ip); }

  @Get('runs/:id/details') @RequirePermissions('payroll.view')
  details(@Param('companyId') c: string, @Param('id') id: string, @Query() q: DetailsQuery) { return this.svc.details(c, id, q); }
  @Get('runs/:id/details/:employeeId') @RequirePermissions('payroll.view')
  detail(@Param('companyId') c: string, @Param('id') id: string, @Param('employeeId') e: string) { return this.svc.detail(c, id, e); }

  @Post('runs/:id/process') @RequirePermissions('payroll.process')
  process(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Param('id') id: string, @Req() r: Request) { return this.svc.process(u, c, id, r.ip); }
  @Post('runs/:id/review') @RequirePermissions('payroll.process')
  review(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Param('id') id: string, @Req() r: Request) { return this.svc.toReview(u, c, id, r.ip); }
  @Post('runs/:id/back-to-calculated') @RequirePermissions('payroll.process')
  back(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Param('id') id: string, @Req() r: Request) { return this.svc.reopenCalc(u, c, id, r.ip); }
  @Post('runs/:id/approve') @RequirePermissions('payroll.approve')
  approve(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Param('id') id: string, @Body() d: ApproveDto, @Req() r: Request) { return this.svc.approve(u, c, id, !!d.acknowledgeSkipped, r.ip); }
  @Post('runs/:id/unapprove') @RequirePermissions('payroll.approve')
  unapprove(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Param('id') id: string, @Req() r: Request) { return this.svc.unapprove(u, c, id, r.ip); }
  @Post('runs/:id/lock') @RequirePermissions('payroll.lock')
  lock(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Param('id') id: string, @Req() r: Request) { return this.svc.lock(u, c, id, r.ip); }
  @Post('runs/:id/unlock') @RequirePermissions('payroll.unlock')
  unlock(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Param('id') id: string, @Body() d: UnlockDto, @Req() r: Request) { return this.svc.unlock(u, c, id, d.reason, r.ip); }

  @Get('inputs') @RequirePermissions('payroll.view')
  inputs(@Param('companyId') c: string, @Query() q: MonthQuery) { return this.svc.listInputs(c, q.year, q.month); }
  @Post('inputs') @RequirePermissions('payroll.process')
  addInput(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Body() d: InputDto, @Req() r: Request) { return this.svc.addInput(u, c, d, r.ip); }
  @Delete('inputs/:id') @RequirePermissions('payroll.process')
  delInput(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Param('id') id: string, @Req() r: Request) { return this.svc.deleteInput(u, c, id, r.ip); }
}

/** Multi-company payroll. Company access is checked per company inside the service, never trusted from the body. */
@ApiTags('Payroll')
@ApiBearerAuth()
@Controller('payroll/bulk')
export class BulkPayrollController {
  constructor(private svc: PayrollService) {}

  @Post() @RequirePermissions('payroll.process')
  start(@CurrentUser() u: AuthUser, @Body() d: BulkDto, @Req() r: Request) { return this.svc.startBulk(u, d.companyIds, d.year, d.month, r.ip); }
  @Get(':jobId') @RequirePermissions('payroll.view')
  status(@CurrentUser() u: AuthUser, @Param('jobId') id: string) { return this.svc.getBulk(u, id); }
}
