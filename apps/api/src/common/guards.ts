import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ALLOW_PWD, INTERNAL, IS_PUBLIC, PERMS } from './decorators';
import { AuthUser } from './auth.types';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private jwt: JwtService, private reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest();
    const header: string = req.headers['authorization'] ?? '';
    if (!header.startsWith('Bearer ')) throw new UnauthorizedException('Missing token');
    try {
      const p = this.jwt.verify(header.slice(7));
      const user: AuthUser = { id: p.sub, type: p.type, consultantId: p.cid ?? null, roles: p.roles, permissions: p.perms };
      user.mustChangePassword = p.mcp === true;
      req.user = user;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    // A temporary password must be replaced before anything else works.
    if (req.user.mustChangePassword && !this.reflector.getAllAndOverride<boolean>(ALLOW_PWD, [ctx.getHandler(), ctx.getClass()])) {
      throw new ForbiddenException({ message: 'You must change your temporary password first', code: 'PASSWORD_CHANGE_REQUIRED' });
    }
    return true;
  }
}

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (this.reflector.getAllAndOverride<boolean>(INTERNAL, [ctx.getHandler(), ctx.getClass()])) {
      const u: AuthUser | undefined = ctx.switchToHttp().getRequest().user;
      if (u?.type === 'CLIENT') throw new ForbiddenException('Not available in the client portal');
    }
    const need = this.reflector.getAllAndOverride<string[]>(PERMS, [ctx.getHandler(), ctx.getClass()]);
    if (!need?.length) return true;
    const user: AuthUser | undefined = ctx.switchToHttp().getRequest().user;
    if (!user) throw new UnauthorizedException();
    if (!need.every((p) => user.permissions.includes(p))) throw new ForbiddenException('Insufficient permission');
    return true;
  }
}
