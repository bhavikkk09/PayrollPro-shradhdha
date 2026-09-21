import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import ExcelJS from 'exceljs';
import * as B from './builders';
import { safeCell, toCsv } from './csv';
import { gratuityFor, serviceOf } from './gratuity';
import { payslipsPdf } from './payslip-pdf';
import { latin, toPdf } from './pdf';
import { ReportContext } from './types';
import { amountInWords } from './words';
import { toXlsx } from './xlsx';

const ctx: ReportContext = { company: { name: 'ABC Industries', address: 'Rajkot' }, subtitle: 'June 2025', provisional: false };
const emp = (o: Partial<B.PayEmp> & Pick<B.PayEmp, 'code' | 'name'>): B.PayEmp => ({
  department: 'Prod', designation: 'Operator', uan: '', pfNumber: '', esiNumber: '', bankName: 'HDFC', bankAccount: '123', ifsc: 'HDFC0001234',
  paidDays: 30, lopDays: 0, otHours: 0, gross: 30000, totalDeductions: 1440, net: 28560,
  earnings: [{ code: 'BASIC', name: 'Basic', amount: 12000 }, { code: 'HRA', name: 'HRA', amount: 6000 }, { code: 'SPECIAL', name: 'Special', amount: 12000 }],
  deductions: [{ code: 'PF', name: 'PF', amount: 1440, employer: 1440 }], trace: [{ step: 'pf', detail: { wage: 12000 } }], ...o,
});

test('amount in words uses Indian numbering', () => {
  assert.equal(amountInWords(28560), 'Rupees Twenty Eight Thousand Five Hundred Sixty Only');
  assert.equal(amountInWords(125000), 'Rupees One Lakh Twenty Five Thousand Only');
  assert.equal(amountInWords(10000000), 'Rupees One Crore Only');
  assert.equal(amountInWords(1500.5), 'Rupees One Thousand Five Hundred and Fifty Paise Only');
  assert.equal(amountInWords(0), 'Rupees Zero Only');
});

test('CSV neutralises formula injection but leaves real numbers alone', () => {
  assert.equal(safeCell('=HYPERLINK("http://evil")'), `'=HYPERLINK("http://evil")`);
  assert.equal(safeCell('+91 98765'), `'+91 98765`);
  assert.equal(safeCell('@SUM(A1)'), `'@SUM(A1)`);
  assert.equal(safeCell(-500), '-500');
  assert.equal(safeCell('Asha'), 'Asha');
  const r = B.payrollRegister(ctx, [emp({ code: 'E1', name: '=cmd|calc' })]);
  const csv = toCsv(r);
  assert.ok(csv.includes(`'=cmd|calc`));
  assert.ok(csv.startsWith('﻿'));
});

test('CSV quotes commas, quotes and newlines', () => {
  const r = B.payrollRegister(ctx, [emp({ code: 'E1', name: 'Patel, "Asha"\nJi' })]);
  assert.ok(toCsv(r).includes('"Patel, ""Asha""\nJi"'));
});

test('payroll register totals add up', () => {
  const r = B.payrollRegister(ctx, [emp({ code: 'E1', name: 'A' }), emp({ code: 'E2', name: 'B', gross: 20000, totalDeductions: 0, net: 20000 })]);
  assert.equal(r.totals!.gross, 50000);
  assert.equal(r.totals!.net, 48560);
  assert.equal(r.totals!.code, 'Total');
});

test('salary register builds one column per earning/deduction code, in stable order', () => {
  const a = emp({ code: 'E1', name: 'A' });
  const b = emp({ code: 'E2', name: 'B', earnings: [{ code: 'BASIC', name: 'Basic', amount: 5000 }, { code: 'BONUS', name: 'Bonus', amount: 1000 }], deductions: [{ code: 'LOAN', name: 'Loan', amount: 500, employer: null }] });
  const r = B.salaryRegister(ctx, [a, b]);
  assert.deepEqual(r.columns.map((c) => c.key).filter((k) => k.startsWith('e_') || k.startsWith('d_')), ['e_BASIC', 'e_HRA', 'e_SPECIAL', 'e_BONUS', 'd_PF', 'd_LOAN']);
  assert.equal(r.rows[1].e_HRA, 0);
  assert.equal(r.rows[1].e_BONUS, 1000);
});

test('PF report lists only PF employees with wages from the calculation trace and flags missing UAN', () => {
  const r = B.pfReport(ctx, [emp({ code: 'E1', name: 'A', uan: '123456789012' }), emp({ code: 'E2', name: 'B', deductions: [], trace: [] })]);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].wage, 12000);
  assert.equal(r.rows[0].total, 2880);
  const noUan = B.pfReport(ctx, [emp({ code: 'E1', name: 'A' })]);
  assert.ok(noUan.notes[0].includes('no UAN'));
});

test('bank statement skips zero-net employees and warns about missing bank details', () => {
  const r = B.bankStatement(ctx, [emp({ code: 'E1', name: 'A' }), emp({ code: 'E2', name: 'B', net: 0 }), emp({ code: 'E3', name: 'C', ifsc: '' })]);
  assert.equal(r.rows.length, 2);
  assert.equal(r.totals!.net, 57120);
  assert.ok(r.notes[0].includes('1 employee'));
});

test('OT register only lists employees with overtime and sums overtime lines', () => {
  const r = B.otRegister(ctx, [emp({ code: 'E1', name: 'A', otHours: 10, earnings: [{ code: 'OT', name: 'OT', amount: 2500, source: 'OVERTIME' }] }), emp({ code: 'E2', name: 'B' })]);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].amount, 2500);
});

test('muster roll has one column per day', () => {
  const r = B.musterRoll(ctx, [{ code: 'E1', name: 'A', present: 2, absent: 0, paidLeave: 0, unpaidLeave: 0, weeklyOffs: 1, holidays: 0, lopDays: 0, otHours: 0, paidDays: 3, days: { '1': 'P', '2': 'P', '3': 'WO' } }], 30);
  assert.equal(r.columns.filter((c) => /^d\d+$/.test(c.key)).length, 30);
  assert.equal(r.rows[0].d3, 'WO');
  assert.equal(r.rows[0].d4, '');
});

test('gratuity is rule-driven: eligibility, rounding of months and cap', () => {
  assert.deepEqual(serviceOf('2020-01-15', '2025-07-20'), { years: 5, months: 6 });
  const rule = { daysPerYear: 15, monthlyDivisor: 26, minYears: 5, roundUpAfterMonths: 5 };
  const g = gratuityFor('2020-01-15', '2025-07-20', 26000, rule); // 5y 6m, rounds to 6 years
  assert.equal(g.countedYears, 6);
  assert.equal(g.amount, 26000 * 15 * 6 / 26);
  assert.equal(gratuityFor('2023-01-01', '2025-07-01', 26000, rule).eligible, false);
  assert.equal(gratuityFor('2023-01-01', '2025-07-01', 26000, rule).amount, 0);
  assert.equal(gratuityFor('2000-01-01', '2025-07-01', 100000, { ...rule, maxAmount: 500000 }).amount, 500000);
  const rep = B.gratuityReport(ctx, [{ code: 'E1', name: 'A', doj: '2020-01-15', wage: 26000 }], '2025-07-20', null);
  assert.ok(!rep.columns.some((c) => c.key === 'amount'));
  assert.ok(rep.notes[0].includes('No GRATUITY rule'));
});

test('PDF: valid file, paginates a long report, and sanitises non-Latin text', async () => {
  const emps = Array.from({ length: 120 }, (_, i) => emp({ code: `E${i}`, name: `Employee ${i} અશા` }));
  const pdf = await toPdf(B.payrollRegister({ ...ctx, provisional: true }, emps));
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  const pages = (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;
  assert.ok(pages >= 3, `expected multiple pages, got ${pages}`);
  assert.equal(latin('₹ 500 અ'), 'Rs. 500 ?');
});

test('XLSX: numbers stay numbers, formula-looking text stays text', async () => {
  const buf = await toXlsx(B.payrollRegister(ctx, [emp({ code: 'E1', name: '=1+1' })]));
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  const ws = wb.worksheets[0];
  const head = ws.getRow(4).values as any[];
  assert.ok(head.includes('Gross'));
  const row = ws.getRow(5);
  const nameCell = row.getCell(2);
  assert.ok(!(nameCell.value as any)?.formula, 'text must not become a formula');
  assert.equal(typeof row.getCell(7).value, 'number');
  assert.equal(row.getCell(7).value, 30000);
});

test('payslip PDF renders one page per employee, with a draft watermark path', async () => {
  const p = { company: { name: 'ABC', address: 'Rajkot' }, period: 'June 2025', draft: true,
    employee: { code: 'E1', name: 'Asha Patel', department: 'Prod', designation: 'Op', doj: '2024-01-01', bank: 'HDFC ****9012', uan: '1', pfNumber: '', esiNumber: '' },
    attendance: { workingDays: 26, paidDays: 30, lopDays: 0, otHours: 0 }, earnings: [{ name: 'Basic', amount: 12000 }], deductions: [{ name: 'PF', amount: 1440 }],
    gross: 12000, totalDeductions: 1440, net: 10560 };
  const pdf = await payslipsPdf([p, { ...p, draft: false }], { primaryColor: '#0f766e', footerText: 'Thank you' });
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.equal((pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length, 2);
  await assert.doesNotReject(payslipsPdf([{ ...p, earnings: [] }], { primaryColor: 'not-a-color' })); // bad colour falls back
});
