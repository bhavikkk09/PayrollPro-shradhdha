import { Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Query, Req, Res, StreamableFile, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { Request, Response } from 'express';
import { AuthUser } from '../common/auth.types';
import { CompanyAccessGuard } from '../common/company-access';
import { CurrentUser, RequirePermissions } from '../common/decorators';
import { contentDisposition, MAX_UPLOAD_BYTES } from './file-validate';
import { DocumentsService, Scope } from './documents.service';
import { TaskAccess } from './task-access';

class ListQuery {
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(3650) expiringInDays?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 25;
}
class UploadDto {
  @IsOptional() @IsString() @Length(1, 30) category?: string;
  @IsOptional() @IsString() @Length(0, 150) title?: string;
  @IsOptional() @IsDateString() expiryDate?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(365) reminderDaysBefore?: number;
}
class UpdateDto {
  @IsOptional() @IsString() @Length(1, 30) category?: string;
  @IsOptional() @IsString() @Length(0, 150) title?: string;
  @IsOptional() @Transform(({ value }) => (value === '' ? null : value)) @IsDateString() expiryDate?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(365) reminderDaysBefore?: number;
}
class FileQuery { @IsOptional() inline?: string; }

const upload = () => UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 8 } }));

/** Files are always sent as attachments unless the type is safe to show (pdf, images). Never sniffed, never run. */
function send(res: Response, f: { data: Buffer; mime: string; name: string; inlineOk: boolean }, wantInline: boolean) {
  const inline = wantInline && f.inlineOk;
  res.set({
    'Content-Type': f.mime, 'Content-Disposition': contentDisposition(f.name, inline), 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'", 'Cache-Control': 'private, no-store',
  });
  return new StreamableFile(f.data);
}

@ApiTags('Documents')
@ApiBearerAuth()
@UseGuards(CompanyAccessGuard)
@Controller('companies/:companyId')
export class DocumentsController {
  constructor(private svc: DocumentsService) {}
  private co = (companyId: string): Scope => ({ kind: 'company', companyId });
  private emp = (companyId: string, employeeId: string): Scope => ({ kind: 'employee', companyId, employeeId });

  // Company documents
  @Get('documents') @RequirePermissions('documents.view')
  list(@Param('companyId') c: string, @Query() q: ListQuery) { return this.svc.list(this.co(c), q); }
  @Post('documents') @RequirePermissions('documents.manage') @upload()
  add(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @UploadedFile() f: any, @Body() d: UploadDto, @Req() r: Request) { return this.svc.upload(u, this.co(c), f, d, r.ip); }
  @Get('documents/:id/file') @RequirePermissions('documents.view')
  async file(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Param('id') id: string, @Query() q: FileQuery, @Req() r: Request, @Res({ passthrough: true }) res: Response) { return send(res, await this.svc.read(u, this.co(c), id, r.ip), q.inline === 'true'); }
  @Patch('documents/:id') @RequirePermissions('documents.manage')
  edit(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Param('id') id: string, @Body() d: UpdateDto, @Req() r: Request) { return this.svc.update(u, this.co(c), id, d as any, r.ip); }
  @Delete('documents/:id') @RequirePermissions('documents.manage')
  del(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Param('id') id: string, @Req() r: Request) { return this.svc.remove(u, this.co(c), id, r.ip); }

  // Employee documents
  @Get('employees/:employeeId/documents') @RequirePermissions('documents.view', 'employee.view')
  empList(@Param('companyId') c: string, @Param('employeeId') e: string, @Query() q: ListQuery) { return this.svc.list(this.emp(c, e), q); }
  @Post('employees/:employeeId/documents') @RequirePermissions('documents.manage', 'employee.edit') @upload()
  empAdd(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Param('employeeId') e: string, @UploadedFile() f: any, @Body() d: UploadDto, @Req() r: Request) { return this.svc.upload(u, this.emp(c, e), f, d, r.ip); }
  @Get('employees/:employeeId/documents/:id/file') @RequirePermissions('documents.view', 'employee.view')
  async empFile(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Param('employeeId') e: string, @Param('id') id: string, @Query() q: FileQuery, @Req() r: Request, @Res({ passthrough: true }) res: Response) { return send(res, await this.svc.read(u, this.emp(c, e), id, r.ip), q.inline === 'true'); }
  @Patch('employees/:employeeId/documents/:id') @RequirePermissions('documents.manage', 'employee.edit')
  empEdit(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Param('employeeId') e: string, @Param('id') id: string, @Body() d: UpdateDto, @Req() r: Request) { return this.svc.update(u, this.emp(c, e), id, d as any, r.ip); }
  @Delete('employees/:employeeId/documents/:id') @RequirePermissions('documents.manage', 'employee.edit')
  empDel(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Param('employeeId') e: string, @Param('id') id: string, @Req() r: Request) { return this.svc.remove(u, this.emp(c, e), id, r.ip); }

  // Company logo (shown on payslips)
  @Post('logo') @RequirePermissions('company.edit') @upload()
  setLogo(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @UploadedFile() f: any, @Req() r: Request) { return this.svc.setLogo(u, c, f, r.ip); }
  @Get('logo') @RequirePermissions('company.view')
  async logo(@Param('companyId') c: string, @Res({ passthrough: true }) res: Response) {
    const l = await this.svc.getLogo(c);
    if (!l) throw new NotFoundException('No logo');
    return send(res, { data: l.data, mime: l.mime, name: 'logo', inlineOk: true }, true);
  }
  @Delete('logo') @RequirePermissions('company.edit')
  delLogo(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Req() r: Request) { return this.svc.removeLogo(u, c, r.ip); }
}

/** Files attached to a compliance filing (challans, acknowledgements). Clients may view; only the firm uploads. */
@ApiTags('Documents')
@ApiBearerAuth()
@Controller('compliance/tasks/:taskId/documents')
export class TaskDocumentsController {
  constructor(private svc: DocumentsService, private prismaAccess: TaskAccess) {}

  @Get() @RequirePermissions('compliance.view')
  async list(@CurrentUser() u: AuthUser, @Param('taskId') t: string, @Query() q: ListQuery) { return this.svc.list(await this.prismaAccess.scope(u, t), q); }
  @Post() @RequirePermissions('compliance.manage') @upload()
  async add(@CurrentUser() u: AuthUser, @Param('taskId') t: string, @UploadedFile() f: any, @Req() r: Request) { return this.svc.upload(u, await this.prismaAccess.scope(u, t), f, {}, r.ip); }
  @Get(':id/file') @RequirePermissions('compliance.view')
  async file(@CurrentUser() u: AuthUser, @Param('taskId') t: string, @Param('id') id: string, @Query() q: FileQuery, @Req() r: Request, @Res({ passthrough: true }) res: Response) { return send(res, await this.svc.read(u, await this.prismaAccess.scope(u, t), id, r.ip), q.inline === 'true'); }
  @Delete(':id') @RequirePermissions('compliance.manage')
  async del(@CurrentUser() u: AuthUser, @Param('taskId') t: string, @Param('id') id: string, @Req() r: Request) { return this.svc.remove(u, await this.prismaAccess.scope(u, t), id, r.ip); }
}
