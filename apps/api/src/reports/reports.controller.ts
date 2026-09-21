import { Controller, Get, NotFoundException, Param, Query, Req, Res, StreamableFile, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { Request, Response } from 'express';
import { AuthUser } from '../common/auth.types';
import { CompanyAccessGuard } from '../common/company-access';
import { CurrentUser, RequirePermissions } from '../common/decorators';
import { CATALOG, Kind, ReportsService } from './reports.service';

const KINDS = CATALOG.map((c) => c.kind);

class ReportQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(2000) @Max(2100) year: number = new Date().getFullYear();
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(12) month: number = new Date().getMonth() + 1;
  @IsOptional() @IsUUID() employeeId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(12) fyStart?: number;
  @IsOptional() @IsIn(['json', 'csv', 'xlsx', 'pdf']) format: 'json' | 'csv' | 'xlsx' | 'pdf' = 'json';
}
class PayslipQuery { @IsOptional() @IsUUID() employeeId?: string; }

function send(res: Response, f: { body: Buffer; contentType: string; filename: string }) {
  res.set({ 'Content-Type': f.contentType, 'Content-Disposition': `attachment; filename="${f.filename}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  return new StreamableFile(f.body);
}

@ApiTags('Reports')
@ApiBearerAuth()
@UseGuards(CompanyAccessGuard)
@Controller('companies/:companyId')
export class ReportsController {
  constructor(private svc: ReportsService) {}

  @Get('reports') @RequirePermissions('reports.view')
  catalog() { return this.svc.catalog(); }

  /** format=json for the on-screen view; csv/xlsx/pdf download (needs reports.export). */
  @Get('reports/:kind') @RequirePermissions('reports.view')
  async report(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Param('kind') kind: string, @Query() q: ReportQuery, @Req() r: Request, @Res({ passthrough: true }) res: Response) {
    if (!(KINDS as string[]).includes(kind)) throw new NotFoundException('Unknown report');
    const out = await this.svc.export(u, c, { kind: kind as Kind, year: q.year, month: q.month, employeeId: q.employeeId, fyStart: q.fyStart }, q.format, r.ip);
    return 'report' in out ? out.report : send(res, out.file);
  }

  @Get('payslips/:runId') @RequirePermissions('payroll.view', 'reports.export')
  async payslips(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Param('runId') runId: string, @Query() q: PayslipQuery, @Req() r: Request, @Res({ passthrough: true }) res: Response) {
    return send(res, await this.svc.payslips(u, c, runId, q.employeeId, r.ip));
  }
}
