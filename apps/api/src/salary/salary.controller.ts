import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUUID, Length, Matches, Max, Min, ValidateNested,
} from 'class-validator';
import { Request } from 'express';
import { AuthUser } from '../common/auth.types';
import { CompanyAccessGuard } from '../common/company-access';
import { CurrentUser, RequirePermissions } from '../common/decorators';
import { SalaryService } from './salary.service';

const METHODS = ['FIXED', 'PERCENTAGE', 'FORMULA', 'HOURLY'];

class ComponentDto {
  @Matches(/^[A-Z][A-Z0-9_]{0,19}$/, { message: 'Code: A-Z, 0-9, _ ; starts with a letter (used in formulas)' }) code: string;
  @IsString() @Length(1, 100) name: string;
  @IsIn(['EARNING', 'DEDUCTION', 'EMPLOYER_CONTRIBUTION']) type: string;
  @IsOptional() @IsBoolean() isFixed?: boolean;
  @IsOptional() @IsBoolean() taxable?: boolean;
  @IsOptional() @IsBoolean() pfApplicable?: boolean;
  @IsOptional() @IsBoolean() esiApplicable?: boolean;
  @IsOptional() @IsBoolean() ptApplicable?: boolean;
  @IsOptional() @IsBoolean() bonusApplicable?: boolean;
  @IsOptional() @IsBoolean() gratuityApplicable?: boolean;
  @IsOptional() @IsBoolean() prorateByAttendance?: boolean;
  @IsOptional() @IsIn(METHODS) calcMethod?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(1000) percentage?: number;
  @IsOptional() @Matches(/^[A-Z][A-Z0-9_]{0,19}$/) percentOf?: string;
  @IsOptional() @IsNumber() @Min(0) fixedAmount?: number;
  @IsOptional() @IsString() @Length(1, 500) formula?: string;
  @IsDateString() effectiveFrom: string;
  @IsOptional() @IsDateString() effectiveTo?: string;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsInt() sortOrder?: number;
}
class UpdateComponentDto extends PartialType(ComponentDto) {}

class ItemDto {
  @IsUUID() componentId: string;
  @IsInt() @Min(1) sequence: number;
  @IsOptional() @IsIn(METHODS) calcMethod?: any;
  @IsOptional() @IsNumber() @Min(0) @Max(1000) percentage?: number;
  @IsOptional() @Matches(/^[A-Za-z][A-Za-z0-9_]{0,19}$/) percentOf?: string;
  @IsOptional() @IsNumber() @Min(0) fixedAmount?: number;
  @IsOptional() @IsString() @Length(1, 500) formula?: string;
}
class StructureDto {
  @IsString() @Length(1, 100) name: string;
  @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => ItemDto) items: ItemDto[];
}
class UpdateStructureDto {
  @IsOptional() @IsString() @Length(1, 100) name?: string;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => ItemDto) items?: ItemDto[];
}
class PreviewDto {
  @IsNumber() @Min(0) @Max(100000000) gross: number;
  @IsOptional() @IsObject() overrides?: Record<string, number>;
}
class AssignDto {
  @IsUUID() structureId: string;
  @IsNumber() @Min(0) @Max(100000000) grossMonthly: number;
  @IsDateString() effectiveFrom: string;
  @IsOptional() @IsIn(['JOINING', 'INCREMENT', 'REVISION']) reason?: string;
  @IsOptional() @IsObject() overrides?: Record<string, number>;
}

@ApiTags('Salary')
@ApiBearerAuth()
@UseGuards(CompanyAccessGuard)
@Controller('companies/:companyId')
export class SalaryController {
  constructor(private svc: SalaryService) {}

  @Get('salary-components') @RequirePermissions('salary.view')
  components(@Param('companyId') c: string) { return this.svc.listComponents(c); }
  @Post('salary-components') @RequirePermissions('salary.manage')
  addComponent(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Body() d: ComponentDto, @Req() r: Request) { return this.svc.createComponent(u, c, d, r.ip); }
  @Patch('salary-components/:id') @RequirePermissions('salary.manage')
  editComponent(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Param('id') id: string, @Body() d: UpdateComponentDto, @Req() r: Request) { return this.svc.updateComponent(u, c, id, d, r.ip); }
  @Delete('salary-components/:id') @RequirePermissions('salary.manage')
  delComponent(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Param('id') id: string, @Req() r: Request) { return this.svc.deleteComponent(u, c, id, r.ip); }

  @Get('salary-structures') @RequirePermissions('salary.view')
  structures(@Param('companyId') c: string) { return this.svc.listStructures(c); }
  @Get('salary-structures/:id') @RequirePermissions('salary.view')
  structure(@Param('companyId') c: string, @Param('id') id: string) { return this.svc.getStructure(c, id); }
  @Post('salary-structures') @RequirePermissions('salary.manage')
  addStructure(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Body() d: StructureDto, @Req() r: Request) { return this.svc.createStructure(u, c, d, r.ip); }
  @Patch('salary-structures/:id') @RequirePermissions('salary.manage')
  editStructure(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Param('id') id: string, @Body() d: UpdateStructureDto, @Req() r: Request) { return this.svc.updateStructure(u, c, id, d, r.ip); }
  @Delete('salary-structures/:id') @RequirePermissions('salary.manage')
  delStructure(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Param('id') id: string, @Req() r: Request) { return this.svc.deleteStructure(u, c, id, r.ip); }
  @Post('salary-structures/:id/preview') @RequirePermissions('salary.view')
  preview(@Param('companyId') c: string, @Param('id') id: string, @Body() d: PreviewDto) { return this.svc.preview(c, id, d.gross, d.overrides); }

  @Get('employees/:employeeId/salary') @RequirePermissions('salary.view')
  history(@Param('companyId') c: string, @Param('employeeId') e: string) { return this.svc.history(c, e); }
  @Post('employees/:employeeId/salary') @RequirePermissions('salary.manage')
  assign(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Param('employeeId') e: string, @Body() d: AssignDto, @Req() r: Request) { return this.svc.assign(u, c, e, d, r.ip); }
}
