import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsIn, IsOptional, IsString, Length, Max, Min, Matches, ValidateNested } from 'class-validator';
import { Request } from 'express';
import { CurrentUser, RequirePermissions } from '../common/decorators';
import { AuthUser } from '../common/auth.types';
import { CompanyAccessGuard } from '../common/company-access';
import { CompaniesService } from './companies.service';

class ListQuery {
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsIn(['ACTIVE', 'INACTIVE', 'SUSPENDED']) status?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 20;
}

class CompanyDto {
  @IsString() @Length(1, 20) code: string;
  @IsString() @Length(1, 200) name: string;
  @IsOptional() @IsString() legalName?: string;
  @IsOptional() @IsString() tradeName?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() state?: string;
  @IsOptional() @Matches(/^\d{6}$/) pincode?: string;
  @IsOptional() @IsString() contactPerson?: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() website?: string;
  @IsOptional() @IsString() industry?: string;
  @IsOptional() @IsString() natureOfBusiness?: string;
  @IsOptional() @IsString() establishmentType?: string;
  @IsOptional() @IsString() registrationNumber?: string;
  @IsOptional() @Matches(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, { message: 'Invalid GSTIN' }) gstin?: string;
  @IsOptional() @Matches(/^[A-Z]{5}[0-9]{4}[A-Z]$/, { message: 'Invalid PAN' }) pan?: string;
  @IsOptional() @Matches(/^[A-Z]{4}[0-9]{5}[A-Z]$/, { message: 'Invalid TAN' }) tan?: string;
}

class UpdateCompanyDto {
  @IsOptional() @IsString() @Length(1, 200) name?: string;
  @IsOptional() @IsString() legalName?: string;
  @IsOptional() @IsString() tradeName?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() state?: string;
  @IsOptional() @Matches(/^\d{6}$/) pincode?: string;
  @IsOptional() @IsString() contactPerson?: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() website?: string;
  @IsOptional() @IsString() industry?: string;
  @IsOptional() @IsIn(['ACTIVE', 'INACTIVE', 'SUSPENDED']) status?: any;
}

class BrandingDto {
  @IsOptional() @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'primaryColor must be a hex colour like #1e293b' }) primaryColor?: string;
  @IsOptional() @IsString() @Length(0, 200) footerText?: string;
  @IsOptional() @IsString() @Length(0, 40) title?: string;
}

/** Whitelisted settings; shiftEnabled defaults to false in the schema. */
class SettingsDto {
  @IsOptional() @IsString() payrollFrequency?: string;
  @IsOptional() @IsIn(['CALENDAR_DAYS', 'FIXED_30', 'WORKING_DAYS']) salaryCalcMethod?: string;
  @IsOptional() @IsString() roundingRule?: string;
  @IsOptional() @IsBoolean() attendanceEnabled?: boolean;
  @IsOptional() @IsBoolean() shiftEnabled?: boolean;
  @IsOptional() @IsBoolean() overtimeEnabled?: boolean;
  @IsOptional() @IsBoolean() lateCalcEnabled?: boolean;
  @IsOptional() @IsBoolean() lopEnabled?: boolean;
  @IsOptional() @IsBoolean() leaveEnabled?: boolean;
  @IsOptional() @IsBoolean() pfEnabled?: boolean;
  @IsOptional() @IsBoolean() esiEnabled?: boolean;
  @IsOptional() @IsBoolean() ptEnabled?: boolean;
  @IsOptional() @IsBoolean() lwfEnabled?: boolean;
  @IsOptional() @IsBoolean() tdsEnabled?: boolean;
  @IsOptional() @IsBoolean() bonusEnabled?: boolean;
  @IsOptional() @IsBoolean() gratuityEnabled?: boolean;
  @IsOptional() @IsBoolean() minimumWageEnabled?: boolean;
  @IsOptional() @ValidateNested() @Type(() => BrandingDto) branding?: BrandingDto;
}

@ApiTags('Companies')
@ApiBearerAuth()
@Controller('companies')
export class CompaniesController {
  constructor(private svc: CompaniesService) {}

  @Get()
  @RequirePermissions('company.view')
  list(@CurrentUser() u: AuthUser, @Query() q: ListQuery) {
    return this.svc.list(u, q);
  }

  @Post()
  @RequirePermissions('company.create')
  create(@CurrentUser() u: AuthUser, @Body() d: CompanyDto, @Req() r: Request) {
    return this.svc.create(u, d as any, r.ip);
  }

  @Get(':companyId')
  @UseGuards(CompanyAccessGuard)
  @RequirePermissions('company.view')
  get(@Param('companyId') id: string) {
    return this.svc.get(id);
  }

  @Patch(':companyId')
  @UseGuards(CompanyAccessGuard)
  @RequirePermissions('company.edit')
  update(@CurrentUser() u: AuthUser, @Param('companyId') id: string, @Body() d: UpdateCompanyDto, @Req() r: Request) {
    return this.svc.update(u, id, d, r.ip);
  }

  @Patch(':companyId/settings')
  @UseGuards(CompanyAccessGuard)
  @RequirePermissions('settings.manage')
  settings(@CurrentUser() u: AuthUser, @Param('companyId') id: string, @Body() d: SettingsDto, @Req() r: Request) {
    return this.svc.updateSettings(u, id, { ...d, branding: d.branding ? { ...d.branding } : undefined }, r.ip);
  }
}
