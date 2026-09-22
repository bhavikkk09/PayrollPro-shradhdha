import { Injectable, NotFoundException } from '@nestjs/common';
import { AuthUser } from '../common/auth.types';
import { CompanyAccessService } from '../common/company-access';
import { PrismaService } from '../prisma/prisma.service';
import { Scope } from './documents.service';

/** Resolves a task id to a document scope only if the caller may access the task's company. */
@Injectable()
export class TaskAccess {
  constructor(private prisma: PrismaService, private access: CompanyAccessService) {}
  async scope(u: AuthUser, taskId: string): Promise<Scope> {
    const t = await this.prisma.complianceTask.findUnique({ where: { id: taskId }, select: { companyId: true } });
    if (!t) throw new NotFoundException('Task not found');
    await this.access.assertAccess(u, t.companyId); // 404 for other tenants' tasks
    return { kind: 'task', companyId: t.companyId, taskId };
  }
}
