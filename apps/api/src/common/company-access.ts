import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from './auth.types';

/**
 * Tenant isolation core. The company id is NEVER trusted from the client alone:
 * it is checked against what the authenticated user may access.
 *  - SUPER_ADMIN: any company
 *  - Consultant Admin: all companies of their own consultant
 *  - everyone else (consultant staff, client users): only companies linked in company_users
 */
@Injectable()
export class CompanyAccessService {
  constructor(private prisma: PrismaService) {}

  async accessibleCompanyIds(user: AuthUser): Promise<string[] | 'ALL'> {
    if (user.type === 'SUPER_ADMIN') return 'ALL';
    if (user.type === 'CONSULTANT' && user.roles.includes('CONSULTANT_ADMIN')) {
      const rows = await this.prisma.company.findMany({
        where: { consultantId: user.consultantId ?? '__none__', deletedAt: null },
        select: { id: true },
      });
      return rows.map((r) => r.id);
    }
    const links = await this.prisma.companyUser.findMany({ where: { userId: user.id }, select: { companyId: true } });
    return links.map((l) => l.companyId);
  }

  /** Throws 404 (not 403) so the existence of other tenants' companies is not leaked. */
  async assertAccess(user: AuthUser, companyId: string) {
    const ids = await this.accessibleCompanyIds(user);
    if (ids !== 'ALL' && !ids.includes(companyId)) throw new NotFoundException('Company not found');
    const company = await this.prisma.company.findFirst({ where: { id: companyId, deletedAt: null } });
    if (!company) throw new NotFoundException('Company not found');
    return company;
  }
}

/** Put on any route that has :companyId. Resolves and authorises the company server-side. */
@Injectable()
export class CompanyAccessGuard implements CanActivate {
  constructor(private access: CompanyAccessService) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    req.company = await this.access.assertAccess(req.user, req.params.companyId);
    return true;
  }
}
