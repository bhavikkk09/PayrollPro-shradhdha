import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuditModule } from './audit/audit.service';
import { AttendanceController } from './attendance/attendance.controller';
import { AttendanceService } from './attendance/attendance.service';
import { LeaveController } from './leave/leave.controller';
import { LeaveService } from './leave/leave.service';
import { ShiftController } from './shift/shift.controller';
import { BulkPayrollController, PayrollController } from './payroll/payroll.controller';
import { PayrollService } from './payroll/payroll.service';
import { ComplianceController, CompanyComplianceController } from './compliance/compliance.controller';
import { ComplianceService } from './compliance/compliance.service';
import { HealthController } from './health.controller';
import { ReportsController } from './reports/reports.controller';
import { ReportsService } from './reports/reports.service';
import { UsersController } from './users/users.controller';
import { UsersService } from './users/users.service';
import { DocumentsController, TaskDocumentsController } from './files/documents.controller';
import { DocumentsService } from './files/documents.service';
import { TaskAccess } from './files/task-access';
import { StorageModule } from './files/storage';
import { NotificationsController, NotificationsScheduler } from './notifications/notifications.controller';
import { NotificationsService } from './notifications/notifications.service';
import { AuditController, AuditQueryService } from './audit/audit.controller';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { CompanyAccessGuard, CompanyAccessService } from './common/company-access';
import { JwtAuthGuard, PermissionsGuard } from './common/guards';
import { CompaniesController } from './companies/companies.controller';
import { CompaniesService } from './companies/companies.service';
import { DashboardController } from './dashboard/dashboard.controller';
import { EmployeesController } from './employees/employees.controller';
import { EmployeesService } from './employees/employees.service';
import { OrgController } from './org/org.controller';
import { SalaryController } from './salary/salary.controller';
import { SalaryService } from './salary/salary.service';
import { PrismaModule } from './prisma/prisma.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 200 }]),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (c: ConfigService) => {
        const secret = c.get<string>('JWT_SECRET');
        if (!secret || secret.length < 32) throw new Error('JWT_SECRET must be set (32+ chars)');
        if (!/^[0-9a-f]{64}$/i.test(c.get<string>('ENCRYPTION_KEY') ?? '')) throw new Error('ENCRYPTION_KEY must be 64 hex chars (openssl rand -hex 32)');
        return { secret, signOptions: { expiresIn: '15m' } };
      },
    }),
    PrismaModule,
    AuditModule,
    StorageModule,
  ],
  controllers: [HealthController, AuthController, CompaniesController, DashboardController, OrgController, EmployeesController, SalaryController, AttendanceController, LeaveController, ShiftController, PayrollController, BulkPayrollController, ComplianceController, CompanyComplianceController, ReportsController, UsersController, DocumentsController, TaskDocumentsController, NotificationsController, AuditController],
  providers: [
    AuthService, CompaniesService, EmployeesService, SalaryService, AttendanceService, LeaveService, PayrollService, ComplianceService, ReportsService, UsersService, DocumentsService, TaskAccess, NotificationsService, NotificationsScheduler, AuditQueryService, CompanyAccessService, CompanyAccessGuard,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
