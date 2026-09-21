import { Injectable, Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditEntry {
  userId?: string;
  companyId?: string;
  action: string;
  module: string;
  recordId?: string;
  oldValue?: unknown;
  newValue?: unknown;
  ip?: string;
}

@Injectable()
export class AuditService {
  constructor(private prisma: PrismaService) {}

  /** Append-only. There is intentionally no update/delete API for audit logs. */
  log(e: AuditEntry) {
    return this.prisma.auditLog.create({
      data: {
        userId: e.userId,
        companyId: e.companyId,
        action: e.action,
        module: e.module,
        recordId: e.recordId,
        oldValue: e.oldValue as any,
        newValue: e.newValue as any,
        ip: e.ip,
      },
    });
  }
}

@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
