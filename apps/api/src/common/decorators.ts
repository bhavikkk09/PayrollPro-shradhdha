import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { AuthUser } from './auth.types';

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Route is for the consultant firm only. Client-portal users get 403 even if they hold the permission. */
export const INTERNAL = 'internalOnly';
export const InternalOnly = () => SetMetadata(INTERNAL, true);
/** Route stays usable while the user must still change a temporary password. */
export const ALLOW_PWD = 'allowPasswordChange';
export const AllowPasswordChange = () => SetMetadata(ALLOW_PWD, true);
export const PERMS = 'permissions';
export const RequirePermissions = (...p: string[]) => SetMetadata(PERMS, p);

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user,
);
export const ClientIp = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): string => ctx.switchToHttp().getRequest().ip,
);
