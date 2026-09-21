import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AuthUser } from '../common/auth.types';
import { encrypt } from '../common/crypto';
import { ReportsService } from './reports.service';

process.env.ENCRYPTION_KEY = 'c'.repeat(64);

const audits: any[] = [];
let runStatus = 'APPROVED';
const detail = (code: string, first: string, net: number, acct: string) => ({
  paidDays: 30, lopDays: 0, otHours: 0, gross: net + 1440, totalDeductions: 1440, net, inputs: {},
  calculation: { earnings: [{ code: 'BASIC', source: 'SALARY' }], trace: [{ step: 'pf', detail: { wage: 12000 } }] },
  earnings: [{ code: 'BASIC', name: 'Basic', amount: net + 1440 }], deductions: [{ code: 'PF', name: 'PF', amount: 1440, employerAmount: 1440 }],
  employee: { code, firstName: first, middleName: null, lastName: 'P', doj: new Date('2024-01-01T00:00:00Z'), uan: '123456789012', pfNumber: 'PF1', esiNumber: '', bankName: 'HDFC', bankAccountEnc: encrypt(acct), ifsc: 'HDFC0001234', department: { name: 'Prod' }, designation: { name: 'Op' } },
});
let lastWhere: any;
const prisma: any = {
  company: { findUniqueOrThrow: async () => ({ code: 'ABC', name: 'ABC Industries', address: 'GIDC', city: 'Rajkot', state: 'Gujarat', pincode: '360001', consultantId: 'C1' }) },
  companySettings: { findUnique: async () => ({ branding: { primaryColor: '#0f766e' } }) },
  payrollRun: { findFirst: async ({ where }: any) => (where.companyId === 'A' ? { id: 'r1', year: 2025, month: 6, status: runStatus, rulesSnapshot: { divisor: 26 } } : null) },
  payrollDetail: {
    findMany: async ({ where }: any) => { lastWhere = where; return [detail('E1', 'Asha', 28560, '123456789012'), detail('E2', 'Ravi', 20000, '999988887777')]; },
  },
};
const svc = new ReportsService(prisma, { log: async (e: any) => { audits.push(e); } } as any, {} as any);
const user = (perms: string[]): AuthUser => ({ id: 'u', type: 'CONSULTANT', consultantId: 'C1', roles: [], permissions: perms });
const q = { kind: 'payroll-register' as const, year: 2025, month: 6 };

test('JSON view works with reports.view; downloads need reports.export', async () => {
  const j: any = await svc.export(user(['reports.view']), 'A', q, 'json');
  assert.equal(j.report.rows.length, 2);
  await assert.rejects(svc.export(user(['reports.view']), 'A', q, 'csv'), ForbiddenException);
  const f: any = await svc.export(user(['reports.view', 'reports.export']), 'A', q, 'csv');
  assert.equal(f.file.contentType, 'text/csv; charset=utf-8');
  assert.equal(f.file.filename, 'payroll-register-ABC-2025-06.csv');
});

test('every export is audited with what was exported', async () => {
  const a = audits.find((x) => x.action === 'REPORT_EXPORTED');
  assert.ok(a);
  assert.equal(a.newValue.format, 'csv');
});

test('queries are always scoped to the authorised company', async () => {
  await svc.export(user(['reports.view']), 'A', q, 'json');
  assert.equal(lastWhere.companyId, 'A');
});

test('a company with no payroll run gets a clear 404', async () => {
  await assert.rejects(svc.export(user(['reports.view']), 'B', q, 'json'), NotFoundException);
});

test('provisional payroll is flagged on the report', async () => {
  runStatus = 'CALCULATED';
  const j: any = await svc.export(user(['reports.view']), 'A', q, 'json');
  assert.equal(j.report.provisional, true);
  runStatus = 'APPROVED';
  assert.equal(((await svc.export(user(['reports.view']), 'A', q, 'json')) as any).report.provisional, false);
});

test('bank statement masks account numbers unless the user has the sensitive permission, and reveals are audited', async () => {
  const bank = { ...q, kind: 'bank-statement' as const };
  const masked: any = await svc.export(user(['reports.view', 'reports.export']), 'A', bank, 'json');
  assert.equal(masked.report.rows[0].account, '********9012');
  assert.ok(masked.report.notes.some((n: string) => n.includes('masked')));
  const full: any = await svc.export(user(['reports.view', 'reports.export', 'employee.sensitive']), 'A', bank, 'json');
  assert.equal(full.report.rows[0].account, '123456789012');
  audits.length = 0;
  await svc.export(user(['reports.view', 'reports.export', 'employee.sensitive']), 'A', bank, 'csv');
  assert.ok(audits.some((a) => a.action === 'SENSITIVE_REPORT_EXPORTED'));
});

test('PF report uses the stored calculation trace for wages', async () => {
  const r: any = await svc.export(user(['reports.view']), 'A', { ...q, kind: 'pf-report' }, 'json');
  assert.equal(r.report.rows[0].wage, 12000);
  assert.equal(r.report.rows[0].employer, 1440);
});

test('employee ledger requires an employee id', async () => {
  await assert.rejects(svc.export(user(['reports.view']), 'A', { ...q, kind: 'employee-ledger' }, 'json'), BadRequestException);
});

test('payslips: draft watermark data for unapproved runs, PDF returned, generation audited', async () => {
  runStatus = 'CALCULATED';
  audits.length = 0;
  const p = await svc.payslips(user(['payroll.view', 'reports.export']), 'A', 'r1', undefined);
  assert.equal(p.body.subarray(0, 5).toString(), '%PDF-');
  assert.equal(p.filename, 'payslip-ABC-2025-06.pdf');
  const a = audits.find((x) => x.action === 'PAYSLIPS_GENERATED');
  assert.equal(a.newValue.count, 2);
  assert.equal(a.newValue.draft, true);
  runStatus = 'APPROVED';
  await assert.rejects(svc.payslips(user([]), 'B', 'r1', undefined), NotFoundException); // other company
});
