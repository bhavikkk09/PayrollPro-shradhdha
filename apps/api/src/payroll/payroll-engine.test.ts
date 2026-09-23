import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { calculateEmployeePayroll, EmployeeInput, EngineConfig, SalaryLineSnap } from './payroll-engine';
import { pickRule, StatRule } from './statutory';

// Fixture rules use TEST values only; the engine reads whatever the rule row says.
const rule = (o: Partial<StatRule> & Pick<StatRule, 'id' | 'module'>): StatRule => ({
  state: null, version: 1, effectiveFrom: '2024-04-01', effectiveTo: null, wageCeiling: null, threshold: null,
  employeePercent: null, employerPercent: null, slabs: null, rules: null, ...o,
});
const PF = rule({ id: 'pf1', module: 'PF', wageCeiling: 15000, employeePercent: 12, employerPercent: 12 });
const ESI = rule({ id: 'esi1', module: 'ESI', wageCeiling: 21000, employeePercent: 0.75, employerPercent: 3.25 });
const PT = rule({ id: 'pt1', module: 'PT', state: 'Gujarat', slabs: [{ from: 0, to: 9999, amount: 0 }, { from: 10000, to: null, amount: 200, monthAmounts: { '2': 300 } }] });
const LWF = rule({ id: 'lwf1', module: 'LWF', rules: { employeeAmount: 6, employerAmount: 12, months: [6, 12] } });
const cfg = (rules: StatRule[] = [PF, ESI, PT, LWF]): EngineConfig => ({ rounding: 'NEAREST_RUPEE', rules, asOf: '2025-06-30' });

const F = (pf: boolean, esi: boolean, pt: boolean, prorateByAttendance = true) => ({ pf, esi, pt, bonus: false, gratuity: false, taxable: true, prorateByAttendance });
const line = (code: string, amount: number, flags = F(false, true, true), extra: Partial<SalaryLineSnap> = {}): SalaryLineSnap =>
  ({ code, name: code, type: 'EARNING', amount, method: 'FIXED', flags, ...extra });
const std = (): SalaryLineSnap[] => [line('BASIC', 12000, F(true, true, true)), line('HRA', 6000), line('SPECIAL', 12000)];

const emp = (o: Partial<EmployeeInput> = {}): EmployeeInput => ({
  employeeId: 'e1', code: 'E1', name: 'Test', year: 2025, month: 6, daysInMonth: 30, monthlyLines: std(),
  attendance: { paidDays: 30, salaryDivisor: 30, lopDays: 0, otHours: 0 }, adjustments: [], loans: [], state: 'Gujarat',
  applicable: { pf: true, esi: true, pt: true, lwf: false }, tdsEnabled: false, ...o,
});
const ded = (r: ReturnType<typeof calculateEmployeePayroll>, code: string) => r.deductions.find((d) => d.code === code);

test('full month: gross, PF on flagged wages, ESI not covered above ceiling, PT slab', () => {
  const r = calculateEmployeePayroll(emp(), cfg());
  assert.equal(r.gross, 30000);
  assert.equal(ded(r, 'PF')!.amount, 1440);
  assert.equal(ded(r, 'PF')!.employer, 1440);
  assert.equal(ded(r, 'ESI'), undefined);
  assert.equal(ded(r, 'PT')!.amount, 200);
  assert.equal(r.net, 30000 - 1440 - 200);
  assert.equal(r.employerContribution, 1440);
});

test('LOP prorates earnings by paid days / divisor', () => {
  const r = calculateEmployeePayroll(emp({ attendance: { paidDays: 27, salaryDivisor: 30, lopDays: 3, otHours: 0 } }), cfg());
  assert.equal(r.earnings.find((e) => e.code === 'BASIC')!.amount, 10800);
  assert.equal(r.gross, 27000);
  assert.equal(r.ratio, 0.9);
});

test('prorateByAttendance=false pays a component in full regardless of LOP', () => {
  const lines = [line('BASIC', 12000, F(true, true, true)), line('FIXED_ALLOW', 3000, F(false, false, false, false))];
  const r = calculateEmployeePayroll(emp({ monthlyLines: lines, attendance: { paidDays: 15, salaryDivisor: 30, lopDays: 15, otHours: 0 } }), cfg());
  assert.equal(r.earnings.find((e) => e.code === 'BASIC')!.amount, 6000); // prorated: 12000 x 0.5
  assert.equal(r.earnings.find((e) => e.code === 'FIXED_ALLOW')!.amount, 3000); // not prorated: full amount
  assert.equal(r.gross, 9000);
});

test('a salary snapshot from before this flag existed still prorates (backward compatible default)', () => {
  const oldSnapshotLine: SalaryLineSnap = { code: 'BASIC', name: 'Basic', type: 'EARNING', amount: 12000, method: 'FIXED', flags: { pf: true, esi: true, pt: true, bonus: false, gratuity: false, taxable: true } as any };
  const r = calculateEmployeePayroll(emp({ monthlyLines: [oldSnapshotLine], attendance: { paidDays: 15, salaryDivisor: 30, lopDays: 15, otHours: 0 } }), cfg());
  assert.equal(r.earnings.find((e) => e.code === 'BASIC')!.amount, 6000);
});

test('PF wage is capped at the rule ceiling', () => {
  const r = calculateEmployeePayroll(emp({ monthlyLines: [line('BASIC', 20000, F(true, true, true))] }), cfg());
  assert.equal(ded(r, 'PF')!.amount, 1800);
});

test('ESI applies within ceiling and rounds up per rule default', () => {
  const r = calculateEmployeePayroll(emp({ monthlyLines: [line('BASIC', 20001, F(false, true, false))] }), cfg());
  assert.equal(ded(r, 'ESI')!.amount, 151); // 150.0075 -> 151
  assert.equal(ded(r, 'ESI')!.employer, 651); // 650.0325 -> 651
});

test('overtime = otHours x (base/divisor/hoursPerDay) x multiplier', () => {
  const ot: SalaryLineSnap = { code: 'OT', name: 'Overtime', type: 'EARNING', amount: 0, method: 'HOURLY', hourly: { percentOf: 'GROSS', multiplier: 2, hoursPerDay: 8 } };
  const r = calculateEmployeePayroll(emp({ monthlyLines: [...std(), ot], attendance: { paidDays: 30, salaryDivisor: 30, lopDays: 0, otHours: 10 } }), cfg());
  assert.equal(r.earnings.find((e) => e.code === 'OT')!.amount, 2500); // 30000/30/8 = 125 x 10 x 2
  assert.equal(r.gross, 32500);
});

test('arrears/bonus add to gross; other deduction and loan reduce net; loan capped at balance', () => {
  const r = calculateEmployeePayroll(emp({
    adjustments: [{ kind: 'ARREAR', name: 'Arrear', amount: 500 }, { kind: 'BONUS', name: 'Diwali', amount: 1000 }, { kind: 'OTHER_DEDUCTION', name: 'Fine', amount: 200 }],
    loans: [{ loanId: 'L1', type: 'LOAN', emi: 1000, balance: 400 }],
  }), cfg([]));
  assert.equal(r.gross, 31500);
  assert.equal(ded(r, 'LOAN')!.amount, 400);
  assert.equal(r.totalDeductions, 600);
  assert.equal(r.net, 30900);
});

test('enabled module with no configured rule warns instead of silently using zero', () => {
  const r = calculateEmployeePayroll(emp(), cfg([]));
  assert.ok(r.warnings.some((w) => w.startsWith('PF: enabled but no rule')));
  assert.equal(ded(r, 'PF'), undefined);
});

test('PT month override and LWF only in listed months', () => {
  const feb = calculateEmployeePayroll(emp({ month: 2 }), cfg());
  assert.equal(ded(feb, 'PT')!.amount, 300);
  const jun = calculateEmployeePayroll(emp({ applicable: { pf: false, esi: false, pt: false, lwf: true } }), cfg());
  assert.equal(ded(jun, 'LWF')!.amount, 6);
  const mar = calculateEmployeePayroll(emp({ month: 3, applicable: { pf: false, esi: false, pt: false, lwf: true } }), cfg());
  assert.equal(ded(mar, 'LWF'), undefined);
});

test('module not applicable to the employee is skipped', () => {
  const r = calculateEmployeePayroll(emp({ applicable: { pf: false, esi: false, pt: false, lwf: false } }), cfg());
  assert.equal(r.deductions.length, 0);
  assert.equal(r.net, 30000);
});

test('negative net is flagged', () => {
  const r = calculateEmployeePayroll(emp({ adjustments: [{ kind: 'OTHER_DEDUCTION', name: 'Recovery', amount: 40000 }] }), cfg([]));
  assert.ok(r.net < 0);
  assert.ok(r.warnings.some((w) => w.includes('negative')));
});

test('attendance disabled pays the full month with a warning', () => {
  const r = calculateEmployeePayroll(emp({ attendance: null }), cfg([]));
  assert.equal(r.gross, 30000);
  assert.ok(r.warnings.some((w) => w.includes('Attendance is disabled')));
});

test('deterministic: identical input gives identical output including trace', () => {
  const a = calculateEmployeePayroll(emp(), cfg());
  const b = calculateEmployeePayroll(structuredClone(emp()), cfg());
  assert.deepEqual(a, b);
  assert.ok(a.trace.length >= 4);
});

test('pickRule: state beats central, latest effective and highest version win, expiry respected', () => {
  const central = rule({ id: 'c', module: 'PT', version: 1 });
  const gj = rule({ id: 'g', module: 'PT', state: 'gujarat', version: 1 });
  assert.equal(pickRule([central, gj], 'PT', 'Gujarat', '2025-06-30')!.id, 'g');
  assert.equal(pickRule([central, gj], 'PT', 'Goa', '2025-06-30')!.id, 'c');
  const v1 = rule({ id: 'v1', module: 'PF', version: 1, effectiveTo: '2025-03-31' });
  const v2 = rule({ id: 'v2', module: 'PF', version: 2, effectiveFrom: '2025-04-01' });
  assert.equal(pickRule([v1, v2], 'PF', null, '2025-03-31')!.id, 'v1');
  assert.equal(pickRule([v1, v2], 'PF', null, '2025-04-01')!.id, 'v2');
  assert.equal(pickRule([v1], 'PF', null, '2025-06-30'), null);
});
