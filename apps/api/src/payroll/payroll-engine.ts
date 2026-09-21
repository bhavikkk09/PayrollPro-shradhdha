// The Payroll Engine: one pure, deterministic function per employee.
// No database, no clock, no randomness. Same input always yields the same output, and every step is traced,
// so any historical payslip can be reproduced from the stored `inputs` and re-verified.
import { HourlyParams, LineFlags } from '../salary/salary-calculator';
import { calcESI, calcLWF, calcPF, calcPT, calcTDS, Module, pickRule, StatRule } from './statutory';

export const ENGINE_VERSION = '1.0.0';

export interface SalaryLineSnap {
  code: string; name: string; type: 'EARNING' | 'DEDUCTION' | 'EMPLOYER_CONTRIBUTION'; amount: number; method: string;
  flags?: LineFlags; hourly?: HourlyParams;
}
export interface AttendanceIn { paidDays: number; salaryDivisor: number; lopDays: number; otHours: number; presentDays?: number }
export interface Adjustment { kind: 'ARREAR' | 'BONUS' | 'INCENTIVE' | 'OTHER_EARNING' | 'OTHER_DEDUCTION'; name: string; amount: number }
export interface LoanIn { loanId: string; type: 'LOAN' | 'ADVANCE'; emi: number; balance: number }

export interface EmployeeInput {
  employeeId: string; code: string; name: string;
  year: number; month: number;
  daysInMonth: number;
  monthlyLines: SalaryLineSnap[];
  attendance: AttendanceIn | null; // null only when the company has attendance disabled
  adjustments: Adjustment[];
  loans: LoanIn[];
  state: string | null; // for state-specific rules (PT, LWF, ...)
  applicable: { pf: boolean; esi: boolean; pt: boolean; lwf: boolean };
  tdsEnabled: boolean;
  /** Year-to-date figures for TDS projection (prior approved months of the same financial year). */
  tds?: { ytdTaxable: number; ytdTds: number; monthsRemaining: number };
}
export interface EngineConfig {
  rounding: 'NEAREST_RUPEE' | 'NONE';
  rules: StatRule[]; // all candidate rules; the engine picks by date/state
  asOf: string; // YYYY-MM-DD, the payroll period end
}

export interface EarningLine { code: string; name: string; amount: number; monthly?: number; source: 'SALARY' | 'OVERTIME' | 'ADJUSTMENT' }
export interface DeductionLine { code: string; name: string; amount: number; employer?: number; source: 'SALARY' | 'STATUTORY' | 'LOAN' | 'ADJUSTMENT'; loanId?: string; ruleId?: string; ruleVersion?: number }
export interface PayrollOutput {
  earnings: EarningLine[]; deductions: DeductionLine[];
  gross: number; totalDeductions: number; net: number; employerContribution: number; taxable: number;
  paidDays: number; lopDays: number; otHours: number; ratio: number;
  warnings: string[]; errors: string[];
  trace: { step: string; detail: unknown }[];
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function calculateEmployeePayroll(i: EmployeeInput, cfg: EngineConfig): PayrollOutput {
  const warnings: string[] = [];
  const errors: string[] = [];
  const trace: PayrollOutput['trace'] = [];
  const money = (n: number) => (cfg.rounding === 'NEAREST_RUPEE' ? Math.round(n + Number.EPSILON) : r2(n));
  const empty = (): PayrollOutput => ({ earnings: [], deductions: [], gross: 0, totalDeductions: 0, net: 0, employerContribution: 0, taxable: 0, paidDays: 0, lopDays: 0, otHours: 0, ratio: 0, warnings, errors, trace });

  // 1. Attendance -> proration ratio
  const divisor = i.attendance?.salaryDivisor ?? i.daysInMonth;
  if (!(divisor > 0)) { errors.push('Salary divisor is zero'); return empty(); }
  const paidDays = i.attendance ? i.attendance.paidDays : i.daysInMonth;
  const lopDays = i.attendance?.lopDays ?? 0;
  const otHours = i.attendance?.otHours ?? 0;
  const ratio = Math.min(1, Math.max(0, paidDays / divisor));
  if (!i.attendance) warnings.push('Attendance is disabled: paid for the full month');
  trace.push({ step: 'attendance', detail: { paidDays, divisor, lopDays, otHours, ratio } });

  // 2. Earnings from the stored salary snapshot, prorated by paid days
  const earnings: EarningLine[] = [];
  const earnedByCode = new Map<string, number>();
  const flagsByCode = new Map<string, LineFlags | undefined>();
  let monthlyBase = 0;
  for (const l of i.monthlyLines) {
    if (l.type !== 'EARNING' || l.method === 'HOURLY') continue;
    monthlyBase += l.amount;
    const earned = money(l.amount * ratio);
    earnings.push({ code: l.code, name: l.name, amount: earned, monthly: l.amount, source: 'SALARY' });
    earnedByCode.set(l.code, earned);
    flagsByCode.set(l.code, l.flags);
    if (!l.flags) warnings.push(`${l.code}: salary snapshot has no statutory flags; treated as not applicable`);
  }
  trace.push({ step: 'earnings', detail: { monthlyBase: r2(monthlyBase), lines: earnings.map((e) => [e.code, e.amount]) } });

  // 3. Overtime (HOURLY components)
  for (const l of i.monthlyLines.filter((x) => x.type === 'EARNING' && x.method === 'HOURLY')) {
    if (!l.hourly) { warnings.push(`${l.code}: hourly parameters missing; skipped`); continue; }
    if (otHours <= 0) continue;
    const baseAmt = l.hourly.percentOf === 'GROSS' ? monthlyBase : i.monthlyLines.find((x) => x.code === l.hourly!.percentOf)?.amount;
    if (baseAmt == null) { warnings.push(`${l.code}: base ${l.hourly.percentOf} not found; skipped`); continue; }
    const rate = baseAmt / divisor / l.hourly.hoursPerDay;
    const amount = money(otHours * rate * l.hourly.multiplier);
    earnings.push({ code: l.code, name: l.name, amount, source: 'OVERTIME' });
    trace.push({ step: 'overtime', detail: { code: l.code, otHours, hourlyRate: r2(rate), multiplier: l.hourly.multiplier, amount } });
  }

  // 4. One-time earnings (arrears, bonus, incentive, other)
  for (const a of i.adjustments.filter((x) => x.kind !== 'OTHER_DEDUCTION')) {
    earnings.push({ code: a.kind, name: a.name, amount: money(a.amount), source: 'ADJUSTMENT' });
  }
  const gross = r2(earnings.reduce((s, e) => s + e.amount, 0));

  // 5. Deductions: fixed salary deductions, one-time deductions, loans/advances
  const deductions: DeductionLine[] = [];
  for (const l of i.monthlyLines.filter((x) => x.type === 'DEDUCTION')) deductions.push({ code: l.code, name: l.name, amount: money(l.amount), source: 'SALARY' });
  for (const a of i.adjustments.filter((x) => x.kind === 'OTHER_DEDUCTION')) deductions.push({ code: 'OTHER_DED', name: a.name, amount: money(a.amount), source: 'ADJUSTMENT' });
  for (const ln of i.loans) {
    const amt = Math.min(ln.emi, ln.balance);
    if (amt > 0) deductions.push({ code: ln.type === 'ADVANCE' ? 'ADVANCE' : 'LOAN', name: ln.type === 'ADVANCE' ? 'Advance recovery' : 'Loan EMI', amount: money(amt), source: 'LOAN', loanId: ln.loanId });
  }

  // 6. Statutory, from versioned rules
  const wageOf = (flag: keyof LineFlags) => r2(earnings.filter((e) => e.source === 'SALARY').reduce((s, e) => s + (flagsByCode.get(e.code)?.[flag] ? e.amount : 0), 0));
  const stat = (module: Module, want: boolean, run: (rule: StatRule) => { employee: number; employer: number; ruleId: string; ruleVersion: number; note?: string } | null, wage: number) => {
    if (!want) return;
    const rule = pickRule(cfg.rules, module, i.state, cfg.asOf);
    if (!rule) { warnings.push(`${module}: enabled but no rule is configured for ${i.state ?? 'central'} on ${cfg.asOf}`); return; }
    const r = run(rule);
    if (!r) { trace.push({ step: module.toLowerCase(), detail: { wage, covered: false, ruleId: rule.id } }); return; }
    if (r.note) warnings.push(`${module}: ${r.note}`);
    if (r.employee > 0 || r.employer > 0) deductions.push({ code: module, name: module, amount: r.employee, employer: r.employer, source: 'STATUTORY', ruleId: r.ruleId, ruleVersion: r.ruleVersion });
    trace.push({ step: module.toLowerCase(), detail: { wage, employee: r.employee, employer: r.employer, ruleId: r.ruleId, ruleVersion: r.ruleVersion } });
  };
  const pfWage = wageOf('pf'), esiWage = wageOf('esi'), ptWage = wageOf('pt');
  stat('PF', i.applicable.pf, (rule) => calcPF(pfWage, rule), pfWage);
  stat('ESI', i.applicable.esi, (rule) => calcESI(esiWage, rule), esiWage);
  stat('PT', i.applicable.pt, (rule) => calcPT(ptWage, i.month, rule), ptWage);
  stat('LWF', i.applicable.lwf, (rule) => calcLWF(i.month, rule), 0);
  // TDS: taxable earnings this month + projection of the rest of the financial year
  const taxable = r2(earnings.reduce((sum, e) => sum + (e.source === 'SALARY' ? (flagsByCode.get(e.code)?.taxable ? e.amount : 0) : e.amount), 0));
  if (i.tdsEnabled) {
    const t = i.tds ?? { ytdTaxable: 0, ytdTds: 0, monthsRemaining: 1 };
    stat('TDS', true, (rule) => calcTDS({ annualTaxable: t.ytdTaxable + taxable * t.monthsRemaining, tdsYtd: t.ytdTds, monthsRemaining: t.monthsRemaining }, rule), taxable);
  }

  // 7. Totals
  const totalDeductions = r2(deductions.reduce((s, d) => s + d.amount, 0));
  const net = money(gross - totalDeductions);
  const employerContribution = r2(deductions.reduce((s, d) => s + (d.employer ?? 0), 0));
  if (net < 0) warnings.push(`Net salary is negative (${net})`);
  trace.push({ step: 'totals', detail: { gross, totalDeductions, net, employerContribution, taxable } });

  return { earnings, deductions, gross, totalDeductions, net, employerContribution, taxable, paidDays, lopDays, otHours, ratio, warnings, errors, trace };
}
