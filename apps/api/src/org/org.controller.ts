import { Body, ConflictException, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags, PartialType } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, Length } from 'class-validator';
import { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth.types';
import { CompanyAccessGuard } from '../common/company-access';
import { CurrentUser, RequirePermissions } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';

class BranchDto {
  @IsString() @Length(1, 20) code: string;
  @IsString() @Length(1, 150) name: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() state?: string;
  @IsOptional() @IsString() establishmentCode?: string;
  @IsOptional() @IsBoolean() pfApplicable?: boolean;
  @IsOptional() @IsBoolean() esiApplicable?: boolean;
  @IsOptional() @IsBoolean() ptApplicable?: boolean;
  @IsOptional() @IsBoolean() lwfApplicable?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
}
class DepartmentDto {
  @IsString() @Length(1, 20) code: string;
  @IsString() @Length(1, 150) name: string;
}
class NameDto {
  @IsString() @Length(1, 150) name: string;
}
class UpdateBranchDto extends PartialType(BranchDto) {}
class UpdateDepartmentDto extends PartialType(DepartmentDto) {}

type Kind = 'branch' | 'department' | 'designation' | 'location';

/**
 * Organisation masters (Company -> Branch / Department / Designation / Location).
 * Every query is scoped by the company resolved by CompanyAccessGuard, never by a client-sent id alone.
 */
@ApiTags('Organisation')
@ApiBearerAuth()
@UseGuards(CompanyAccessGuard)
@Controller('companies/:companyId')
export class OrgController {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  private db(kind: Kind): any {
    return this.prisma[kind];
  }

  private async list(kind: Kind, companyId: string) {
    return this.db(kind).findMany({ where: { companyId }, orderBy: { name: 'asc' }, take: 500 });
  }

  private async create(kind: Kind, u: AuthUser, companyId: string, data: object, ip?: string) {
    try {
      const row = await this.db(kind).create({ data: { ...data, companyId } });
      await this.audit.log({ userId: u.id, companyId, action: `${kind.toUpperCase()}_CREATED`, module: kind, recordId: row.id, newValue: row, ip });
      return row;
    } catch (e: any) {
      if (e.code === 'P2002') throw new ConflictException(`${kind} with this code/name already exists`);
      throw e;
    }
  }

  private async update(kind: Kind, u: AuthUser, companyId: string, id: string, data: object, ip?: string) {
    const old = await this.db(kind).findFirst({ where: { id, companyId } });
    if (!old) throw new NotFoundException();
    try {
      const row = await this.db(kind).update({ where: { id }, data });
      await this.audit.log({ userId: u.id, companyId, action: `${kind.toUpperCase()}_UPDATED`, module: kind, recordId: id, oldValue: old, newValue: row, ip });
      return row;
    } catch (e: any) {
      if (e.code === 'P2002') throw new ConflictException(`${kind} with this code/name already exists`);
      throw e;
    }
  }

  private async remove(kind: Kind, u: AuthUser, companyId: string, id: string, ip?: string) {
    const old = await this.db(kind).findFirst({ where: { id, companyId } });
    if (!old) throw new NotFoundException();
    const field = `${kind}Id`;
    const inUse = await this.prisma.employee.count({ where: { companyId, [field]: id, deletedAt: null } });
    if (inUse) throw new ConflictException(`Cannot delete: used by ${inUse} employee(s)`);
    await this.db(kind).delete({ where: { id } });
    await this.audit.log({ userId: u.id, companyId, action: `${kind.toUpperCase()}_DELETED`, module: kind, recordId: id, oldValue: old, ip });
    return { ok: true };
  }

  // Branches
  @Get('branches') @RequirePermissions('company.view')
  branches(@Param('companyId') c: string) { return this.list('branch', c); }
  @Post('branches') @RequirePermissions('branch.manage')
  addBranch(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Body() d: BranchDto, @Req() r: Request) { return this.create('branch', u, c, d, r.ip); }
  @Patch('branches/:id') @RequirePermissions('branch.manage')
  editBranch(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Param('id') id: string, @Body() d: UpdateBranchDto, @Req() r: Request) { return this.update('branch', u, c, id, d, r.ip); }
  @Delete('branches/:id') @RequirePermissions('branch.manage')
  delBranch(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Param('id') id: string, @Req() r: Request) { return this.remove('branch', u, c, id, r.ip); }

  // Departments
  @Get('departments') @RequirePermissions('company.view')
  departments(@Param('companyId') c: string) { return this.list('department', c); }
  @Post('departments') @RequirePermissions('branch.manage')
  addDept(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Body() d: DepartmentDto, @Req() r: Request) { return this.create('department', u, c, d, r.ip); }
  @Patch('departments/:id') @RequirePermissions('branch.manage')
  editDept(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Param('id') id: string, @Body() d: UpdateDepartmentDto, @Req() r: Request) { return this.update('department', u, c, id, d, r.ip); }
  @Delete('departments/:id') @RequirePermissions('branch.manage')
  delDept(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Param('id') id: string, @Req() r: Request) { return this.remove('department', u, c, id, r.ip); }

  // Designations
  @Get('designations') @RequirePermissions('company.view')
  designations(@Param('companyId') c: string) { return this.list('designation', c); }
  @Post('designations') @RequirePermissions('branch.manage')
  addDesig(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Body() d: NameDto, @Req() r: Request) { return this.create('designation', u, c, d, r.ip); }
  @Patch('designations/:id') @RequirePermissions('branch.manage')
  editDesig(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Param('id') id: string, @Body() d: NameDto, @Req() r: Request) { return this.update('designation', u, c, id, d, r.ip); }
  @Delete('designations/:id') @RequirePermissions('branch.manage')
  delDesig(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Param('id') id: string, @Req() r: Request) { return this.remove('designation', u, c, id, r.ip); }

  // Locations
  @Get('locations') @RequirePermissions('company.view')
  locations(@Param('companyId') c: string) { return this.list('location', c); }
  @Post('locations') @RequirePermissions('branch.manage')
  addLoc(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Body() d: NameDto, @Req() r: Request) { return this.create('location', u, c, d, r.ip); }
  @Patch('locations/:id') @RequirePermissions('branch.manage')
  editLoc(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Param('id') id: string, @Body() d: NameDto, @Req() r: Request) { return this.update('location', u, c, id, d, r.ip); }
  @Delete('locations/:id') @RequirePermissions('branch.manage')
  delLoc(@CurrentUser() u: AuthUser, @Param('companyId') c: string, @Param('id') id: string, @Req() r: Request) { return this.remove('location', u, c, id, r.ip); }
}
