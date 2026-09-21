import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min } from 'class-validator';
import { Request } from 'express';
import { AuthUser } from '../common/auth.types';
import { CurrentUser, InternalOnly, RequirePermissions } from '../common/decorators';
import { UsersService } from './users.service';

const ALL_ROLES = ['CONSULTANT_ADMIN', 'CONSULTANT_STAFF', 'PAYROLL_OPERATOR', 'COMPLIANCE_OPERATOR', 'READ_ONLY', 'CLIENT_ADMIN', 'CLIENT_HR'];

class ListQuery {
  @IsOptional() @IsString() search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 25;
}
class CreateUserDto {
  @IsString() @Length(2, 100) name: string;
  @IsEmail() @MaxLength(200) email: string;
  @IsIn(['CONSULTANT', 'CLIENT']) type: 'CONSULTANT' | 'CLIENT';
  @IsIn(ALL_ROLES) roleKey: string;
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsUUID('all', { each: true }) companyIds?: string[];
  @IsOptional() @IsString() @MaxLength(128) password?: string;
}
class UpdateUserDto {
  @IsOptional() @IsString() @Length(2, 100) name?: string;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsIn(ALL_ROLES) roleKey?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsUUID('all', { each: true }) companyIds?: string[];
}

@ApiTags('Users')
@ApiBearerAuth()
@InternalOnly()
@Controller('users')
export class UsersController {
  constructor(private svc: UsersService) {}

  @Get() @RequirePermissions('users.manage')
  list(@CurrentUser() u: AuthUser, @Query() q: ListQuery) { return this.svc.list(u, q); }

  @Get('roles') @RequirePermissions('users.manage')
  roles() { return this.svc.roleOptions(); }

  @Post() @RequirePermissions('users.manage')
  create(@CurrentUser() u: AuthUser, @Body() d: CreateUserDto, @Req() r: Request) { return this.svc.create(u, d, r.ip); }

  @Patch(':id') @RequirePermissions('users.manage')
  update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() d: UpdateUserDto, @Req() r: Request) { return this.svc.update(u, id, d, r.ip); }

  @Post(':id/reset-password') @RequirePermissions('users.manage')
  reset(@CurrentUser() u: AuthUser, @Param('id') id: string, @Req() r: Request) { return this.svc.resetPassword(u, id, r.ip); }
}
