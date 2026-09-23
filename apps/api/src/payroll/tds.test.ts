import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { calculateEmployeePayroll, EmployeeInput } from './payroll-engine';
import { monthsLeftInFy } from './payroll.service';
import { calcTDS, pickRule, slabTax, StatRule } from './statutory';

// TEST FIXTURE: slab numbers below are invented for arithmetic checks, not real tax rates.
const SLABS = [{ from: 0, to: 100000, rate: 0 }, { from: 100000, to: 200000, rate: 10 }, { from: 200000, to: null, rate: 20 }];
const rule = (o: Partial<StatRule> = {}): StatRule => ({
  id: 'tds1', module: 'TDS', state: null, version: 1, effectiveFrom: '2024-04-01', effectiveTo: null, wageCeiling: null, threshold: null,
  employeePercent: null, employerPercent: null, slabs: SLABS, rules: { standardDeduction: 50000, cessPercent: 4, rebate: { incomeLimit: 100000, maxAmount: 5000 }, fyStartMonth: 4 }, ...o,
});

test('slab tax applies each rate to its own band only', () => {
  assert.equal(slabTax(50000, SLABS), 0);
  assert.equal(slabTax(150000, SLABS), 5000); // 50000 x 10%
  assert.equal(slabTax(300000, SLABS), 10000 + 20000); // 100000 x 10% + 100000 x 20%
});

test('TDS: standard deduction, cess, and spreading over remaining months', () => {
  // annual 400000 - 50000 std = 350000 -> tax 10000 + 30000 = 40000; +4% cess = 41600; 10 months left -> 4160
  const r = calcTDS({ annualTaxable: 400000, tdsYtd: 0, monthsRemaining: 10 }, rule());
  assert.equal(r.employee, 4160);
});

test('TDS: already deducted amount reduces what remains', () => {
  const r = calcTDS({ annualTaxable: 400000, tdsYtd: 20800, monthsRemaining: 5 }, rule());
  assert.equal(r.employee, 4160); // (41600 - 20800) / 5
  assert.equal(calcTDS({ annualTaxable: 400000, tdsYtd: 99999, monthsRemaining: 5 }, rule()).employee, 0); // over-deducted -> no negative TDS
});

test('TDS: rebate wipes out tax when income is within the limit', () => {
  // annual 140000 - 50000 = 90000 -> tax 0
  assert.equal(calcTDS({ annualTaxable: 140000, tdsYtd: 0, monthsRemaining: 12 }, rule()).employee, 0);
  // income exactly at the limit (150000 - 50000 = 100000): tax 10000, rebate 5000 -> 5000, +4% cess = 5200, over 12 months = 433
  const r = calcTDS({ annualTaxable: 150000, tdsYtd: 0, monthsRemaining: 12 }, rule({ slabs: [{ from: 0, to: null, rate: 10 }] }));
  assert.equal(r.employee, 433);
  // just above the limit the rebate no longer applies: (100001 x 10%) x 1.04 / 12
  assert.equal(calcTDS({ annualTaxable: 150001, tdsYtd: 0, monthsRemaining: 12 }, rule({ slabs: [{ from: 0, to: null, rate: 10 }] })).employee, Math.round((10000.1 * 1.04) / 12));
});

test('monthsLeftInFy counts inclusively to the end of the financial year', () => {
  assert.equal(monthsLeftInFy(4, 4), 12);
  assert.equal(monthsLeftInFy(6, 4), 10);
  assert.equal(monthsLeftInFy(3, 4), 1);
  assert.equal(monthsLeftInFy(1, 4), 3);
});

const emp = (o: Partial<EmployeeInput> = {}): EmployeeInput => ({
  employeeId: 'e1', code: 'E1', name: 'T', year: 2025, month: 6, daysInMonth: 30,
  monthlyLines: [{ code: 'BASIC', name: 'Basic', type: 'EARNING', amount: 40000, method: 'FIXED', flags: { pf: false, esi: false, pt: false, bonus: false, gratuity: false, taxable: true, prorateByAttendance: true } },
    { code: 'REIMB', name: 'Reimbursement', type: 'EARNING', amount: 5000, method: 'FIXED', flags: { pf: false, esi: false, pt: false, bonus: false, gratuity: false, taxable: false, prorateByAttendance: true } }],
  attendance: { paidDays: 30, salaryDivisor: 30, lopDays: 0, otHours: 0 }, adjustments: [], loans: [], state: null,
  applicable: { pf: false, esi: false, pt: false, lwf: false }, tdsEnabled: true, tds: { ytdTaxable: 80000, ytdTds: 0, monthsRemaining: 10 }, ...o,
});

test('engine: TDS uses taxable earnings only and projects the year (YTD + this month x months left)', () => {
  const r = calculateEmployeePayroll(emp(), { rounding: 'NEAREST_RUPEE', rules: [rule()], asOf: '2025-06-30' });
  // taxable this month 40000 (reimbursement excluded); projection 80000 + 40000 x 10 = 480000
  const expected = calcTDS({ annualTaxable: 480000, tdsYtd: 0, monthsRemaining: 10 }, rule()).employee;
  assert.equal(r.taxable, 40000);
  assert.equal(r.deductions.find((d) => d.code === 'TDS')!.amount, expected);
  assert.ok(expected > 0);
});

test('engine: TDS enabled without a rule warns instead of guessing', () => {
  const r = calculateEmployeePayroll(emp(), { rounding: 'NEAREST_RUPEE', rules: [], asOf: '2025-06-30' });
  assert.ok(r.warnings.some((w) => w.startsWith('TDS: enabled but no rule')));
  assert.equal(r.deductions.find((d) => d.code === 'TDS'), undefined);
});

test('a consultant-owned rule overrides the platform rule; another tenant is unaffected', () => {
  const platform = rule({ id: 'plat', module: 'PF' });
  const own = rule({ id: 'mine', module: 'PF', own: true, effectiveFrom: '2024-04-01' });
  assert.equal(pickRule([platform, own], 'PF', null, '2025-06-30')!.id, 'mine');
  assert.equal(pickRule([platform], 'PF', null, '2025-06-30')!.id, 'plat'); // other consultants only ever load platform rules
});
