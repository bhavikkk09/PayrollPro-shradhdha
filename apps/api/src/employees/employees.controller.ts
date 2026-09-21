import { Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';
import { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth.types';
import { CompanyAccessGuard } from '../common/company-access';
import { CurrentUser, RequirePermissions } from '../common/decorators';
import { EmployeesService } from './employees.service';

const STATUS = ['ACTIVE', 'INACTIVE', 'LEFT', 'SUSPENDED'];

class ListQuery {
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsIn(STATUS) status?: string;
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @IsUUID() departmentId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 25;
}

export class EmployeeDto {
  @IsString() @Length(1, 30) code: string;
  @IsString() @Length(1, 80) firstName: string;
  @IsOptional() @IsString() middleName?: string;
  @IsOptional() @IsString() lastName?: string;
  @IsOptional() @IsIn(['MALE', 'FEMALE', 'OTHER']) gender?: string;
  @IsOptional() @IsDateString() dob?: string;
  @IsOptional() @IsIn(['SINGLE', 'MARRIED', 'DIVORCED', 'WIDOWED']) maritalStatus?: string;
  @IsOptional() @Matches(/^[6-9]\d{9}$/, { message: 'Mobile must be 10 digits' }) mobile?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() state?: string;
  @IsOptional() @Matches(/^\d{6}$/, { message: 'Pincode must be 6 digits' }) pincode?: string;

  @IsDateString() doj: string;
  @IsOptional() @IsDateString() dol?: string;
  @IsOptional() @IsString() reasonForLeaving?: string;
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @IsUUID() departmentId?: string;
  @IsOptional() @IsUUID() designationId?: string;
  @IsOptional() @IsUUID() locationId?: string;
  @IsOptional() @IsString() employmentType?: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() grade?: string;
  @IsOptional() @IsString() costCenter?: string;
  @IsOptional() @IsUUID() reportingManagerId?: string;
  @IsOptional() @IsIn(STATUS) status?: string;

  @IsOptional() @IsString() bankName?: string;
  @IsOptional() @Matches(/^\d{6,20}$/, { message: 'Invalid account number' }) bankAccount?: string;
  @IsOptional() @Matches(/^[A-Z]{4}0[A-Z0-9]{6}$/, { message: 'Invalid IFSC' }) ifsc?: string;
  @IsOptional() @IsString() bankBranch?: string;

  @IsOptional() @Matches(/^\d{12}$/, { message: 'UAN must be 12 digits' }) uan?: string;
  @IsOptional() @IsString() pfNumber?: string;
  @IsOptional() @IsString() esiNumber?: string;
  @IsOptional() @Matches(/^[A-Z]{5}\d{4}[A-Z]$/, { message: 'Invalid PAN' }) pan?: string;
  @IsOptional() @Matches(/^\d{4}$|^\d{12}$/, { message: 'Aadhaar reference: last 4 or 12 digits' }) aadhaarRef?: string;
  @IsOptional() @IsBoolean() ptApplicable?: boolean;
  @IsOptional() @IsBoolean() lwfApplicable?: boolean;
  @IsOptional() @IsBoolean() pfApplicable?: boolean;
  @IsOptional() @IsBoolean() esiApplicable?: boolean;
}
class UpdateEmployeeDto extends PartialType(EmployeeDto) {}

@ApiTags('Employees')
@ApiBearerAuth()
@UseGuards(CompanyAccessGuard)
@Controller('companies/:companyId/employees')
export class EmployeesController {
  constructor(private svc: EmployeesService, private audit: AuditService) {}

  @Get() @RequirePermissions('employee.view')
  list(@Param('companyId') c: string, @Query() q: ListQuery) { return this.svc.list(c, q); }

  /** ?reveal=true returns clear-text bank/PAN/Aadhaar and requires employee.sensitive; every reveal is audited. */
  @Get(':id') @RequirePermissions('employee.view')
  async get(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Param('id') id: string, @Query('reveal') reveal?: string, @Req() r?: Request) {
    const wantReveal = reveal === 'true';
    if (wantReveal) {
      if (!u.permissions.includes('employee.sensitive')) throw new ForbiddenException('Insufficient permission');
      await this.audit.log({ userId: u.id, companyId: c, action: 'SENSITIVE_DATA_REVEALED', module: 'employee', recordId: id, ip: r?.ip });
    }
    return this.svc.get(c, id, wantReveal);
  }

  @Post() @RequirePermissions('employee.create')
  create(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Body() d: EmployeeDto, @Req() r: Request) { return this.svc.create(u, c, d, r.ip); }

  @Patch(':id') @RequirePermissions('employee.edit')
  update(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Param('id') id: string, @Body() d: UpdateEmployeeDto, @Req() r: Request) { return this.svc.update(u, c, id, d, r.ip); }

  @Delete(':id') @RequirePermissions('employee.delete')
  remove(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Param('id') id: string, @Req() r: Request) { return this.svc.remove(u, c, id, r.ip); }
}
