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
  rules: Record<string, any> | null; // e.g. {rounding:'UP', capWages:true, months:[6,12], employeeAmount, employerAmount}
}

export interface StatResult { employee: number; employer: number; wage: number; ruleId: string; ruleVersion: number; note?: string }

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

/** Rule in force on `onDate` for a module: state-specific beats central; then latest effectiveFrom, then highest version. */
export function pickRule(rules: StatRule[], module: Module, state: string | null, onDate: string): StatRule | null {
  const live = rules.filter((r) => r.module === module && r.effectiveFrom <= onDate && (!r.effectiveTo || r.effectiveTo >= onDate));
  const order = (a: StatRule, b: StatRule) => (a.effectiveFrom === b.effectiveFrom ? b.version - a.version : a.effectiveFrom < b.effectiveFrom ? 1 : -1);
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
