// Rule-driven statutory calculators. No legal value is hard-coded here: every rate, ceiling, slab,
// month list and rounding choice comes from a versioned ComplianceRule row.

export type Module = 'PF' | 'ESI' | 'PT' | 'LWF' | 'TDS' | 'BONUS' | 'GRATUITY' | 'MINIMUM_WAGE' | 'OTHER';

export interface StatRule {
  id: string;
  module: Module;
  state: string | null; // null = central
  version: number;
  effectiveFrom: string; // YYYY-MM-DD
  effectiveTo: string | null;
  wageCeiling: number | null;
  threshold: number | null;
  employeePercent: number | null;
  employerPercent: number | null;
  slabs: unknown; // PT: [{from, to|null, amount, monthAmounts?: {"2": 300}}]
  own?: boolean; // true when the rule belongs to the company's consultant (beats a platform default)
  rules: Record<string, any> | null; // e.g. {rounding:'UP', capWages:true, months:[6,12], employeeAmount, employerAmount}
}

export interface StatResult { employee: number; employer: number; wage: number; ruleId: string; ruleVersion: number; note?: string }

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

/** Rule in force on `onDate`: state-specific beats central; consultant-owned beats platform; then latest effectiveFrom, then highest version. */
export function pickRule(rules: StatRule[], module: Module, state: string | null, onDate: string): StatRule | null {
  const live = rules.filter((r) => r.module === module && r.effectiveFrom <= onDate && (!r.effectiveTo || r.effectiveTo >= onDate));
  const order = (a: StatRule, b: StatRule) =>
    Number(!!b.own) - Number(!!a.own) || (a.effectiveFrom === b.effectiveFrom ? b.version - a.version : a.effectiveFrom < b.effectiveFrom ? 1 : -1);
  const exact = live.filter((r) => r.state && norm(r.state) === norm(state)).sort(order);
  if (exact.length) return exact[0];
  return live.filter((r) => !r.state).sort(order)[0] ?? null;
}

export function roundBy(amount: number, mode: string | undefined): number {
  if (mode === 'UP') return Math.ceil(amount - 1e-9);
  if (mode === 'DOWN') return Math.floor(amount + 1e-9);
  return Math.round(amount + Number.EPSILON);
}

/** Provident fund: percent of PF wages, optionally capped at the wage ceiling. */
export function calcPF(wage: number, rule: StatRule): StatResult {
  const cap = rule.rules?.capWages !== false && rule.wageCeiling != null ? rule.wageCeiling : Infinity;
  const base = Math.min(wage, cap);
  const mode = rule.rules?.rounding;
  return {
    employee: roundBy((base * (rule.employeePercent ?? 0)) / 100, mode),
    employer: roundBy((base * (rule.employerPercent ?? 0)) / 100, mode),
    wage: base, ruleId: rule.id, ruleVersion: rule.version,
  };
}

/** ESI: applies only while wages are within the ceiling; contribution is on the full wage. */
export function calcESI(wage: number, rule: StatRule): StatResult | null {
  if (rule.wageCeiling != null && wage > rule.wageCeiling) return null; // not covered
  const mode = rule.rules?.rounding ?? 'UP';
  return {
    employee: roundBy((wage * (rule.employeePercent ?? 0)) / 100, mode),
    employer: roundBy((wage * (rule.employerPercent ?? 0)) / 100, mode),
    wage, ruleId: rule.id, ruleVersion: rule.version,
  };
}

interface Slab { from: number; to: number | null; amount: number; monthAmounts?: Record<string, number> }

/** Professional tax: employee-only, from wage slabs. A slab may override the amount for specific months. */
export function calcPT(wage: number, month: number, rule: StatRule): StatResult {
  const slabs = (Array.isArray(rule.slabs) ? rule.slabs : []) as Slab[];
  const hit = slabs.find((s) => wage >= s.from && (s.to == null || wage <= s.to));
  const amount = hit ? hit.monthAmounts?.[String(month)] ?? hit.amount : 0;
  return { employee: amount, employer: 0, wage, ruleId: rule.id, ruleVersion: rule.version, note: hit ? undefined : 'No PT slab matched' };
}

/** Labour welfare fund: fixed contributions in the months listed by the rule (e.g. half-yearly). */
export function calcLWF(month: number, rule: StatRule): StatResult {
  const months: number[] | undefined = rule.rules?.months;
  const due = !months || months.includes(month);
  return {
    employee: due ? Number(rule.rules?.employeeAmount ?? 0) : 0,
    employer: due ? Number(rule.rules?.employerAmount ?? 0) : 0,
    wage: 0, ruleId: rule.id, ruleVersion: rule.version,
  };
}

interface TaxSlab { from: number; to: number | null; rate: number }

/** Annual tax from progressive slabs (rate is a percentage of the part of income inside each band). */
export function slabTax(income: number, slabs: TaxSlab[]): number {
  let tax = 0;
  for (const b of slabs) {
    const top = b.to == null ? Infinity : b.to;
    const part = Math.max(0, Math.min(income, top) - b.from);
    tax += (part * b.rate) / 100;
  }
  return tax;
}

export interface TdsInput { annualTaxable: number; tdsYtd: number; monthsRemaining: number }

/**
 * Simplified monthly TDS: project the year, apply slabs (rule.slabs = [{from,to,rate}]), standard deduction,
 * rebate {incomeLimit,maxAmount} and cess from the rule, then spread the tax not yet deducted over the
 * remaining months. No investment declarations or HRA exemption are modelled.
 */
export function calcTDS(i: TdsInput, rule: StatRule): StatResult {
  const r = rule.rules ?? {};
  const slabs = (Array.isArray(rule.slabs) ? rule.slabs : []) as TaxSlab[];
  const income = Math.max(0, i.annualTaxable - Number(r.standardDeduction ?? 0));
  let tax = slabTax(income, slabs);
  if (r.rebate && income <= Number(r.rebate.incomeLimit)) tax = Math.max(0, tax - Number(r.rebate.maxAmount));
  tax += (tax * Number(r.cessPercent ?? 0)) / 100;
  const remaining = Math.max(0, tax - i.tdsYtd);
  const monthly = roundBy(remaining / Math.max(1, i.monthsRemaining), r.rounding);
  return { employee: monthly, employer: 0, wage: income, ruleId: rule.id, ruleVersion: rule.version, note: undefined };
}
