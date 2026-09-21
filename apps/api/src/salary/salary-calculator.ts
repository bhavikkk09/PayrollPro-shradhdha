import { evalFormula, FormulaError } from './formula';

export interface CalcItem {
  code: string;
  name: string;
  type: 'EARNING' | 'DEDUCTION' | 'EMPLOYER_CONTRIBUTION';
  calcMethod: 'FIXED' | 'PERCENTAGE' | 'FORMULA' | 'HOURLY';
  percentage?: number | null;
  percentOf?: string | null; // component code or GROSS (default GROSS)
  fixedAmount?: number | null;
  formula?: string | null;
  sequence: number;
  flags?: LineFlags; // statutory applicability, copied from the component
}

export interface LineFlags { pf: boolean; esi: boolean; pt: boolean; bonus: boolean; gratuity: boolean; taxable: boolean }
/** HOURLY components (overtime): amount = otHours x (base / divisor / hoursPerDay) x multiplier, computed at payroll time. */
export interface HourlyParams { percentOf: string; multiplier: number; hoursPerDay: number }

export interface CalcLine { code: string; name: string; type: CalcItem['type']; amount: number; method: string; flags?: LineFlags; hourly?: HourlyParams }
export interface CalcResult {
  lines: CalcLine[];
  gross: number; // sum of EARNING lines
  deductions: number; // sum of DEDUCTION lines
  net: number;
  targetGross: number;
  grossMatchesTarget: boolean;
  warnings: string[];
}

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Pure and deterministic: same inputs always give the same output.
 * Items run in `sequence` order; a formula may only use GROSS and components with a lower sequence.
 * `overrides` (code -> amount) replace a component's amount and feed later formulas.
 * Every line is rounded to 2 decimals as it is computed, so stored parts add up to the stored total.
 */
export function calculateSalary(targetGross: number, items: CalcItem[], overrides: Record<string, number> = {}): CalcResult {
  if (!(targetGross >= 0) || !Number.isFinite(targetGross)) throw new FormulaError('Gross must be a non-negative number');
  const vars: Record<string, number> = { GROSS: targetGross };
  const lines: CalcLine[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const it of [...items].sort((a, b) => a.sequence - b.sequence)) {
    if (seen.has(it.code)) throw new FormulaError(`Component ${it.code} appears twice`);
    seen.add(it.code);
    let amount: number;
    if (Object.hasOwn(overrides, it.code)) {
      amount = overrides[it.code];
    } else if (it.calcMethod === 'FIXED') {
      amount = it.fixedAmount ?? 0;
      if (it.fixedAmount == null) warnings.push(`${it.code} has no fixed amount; treated as 0`);
    } else if (it.calcMethod === 'PERCENTAGE') {
      if (it.percentage == null) throw new FormulaError(`${it.code}: percentage is required`);
      const base = (it.percentOf ?? 'GROSS').toUpperCase();
      if (!Object.hasOwn(vars, base)) throw new FormulaError(`${it.code}: base "${base}" is not available (must be GROSS or an earlier component)`);
      amount = (vars[base] * it.percentage) / 100;
    } else if (it.calcMethod === 'FORMULA') {
      if (!it.formula) throw new FormulaError(`${it.code}: formula is required`);
      try { amount = evalFormula(it.formula, vars); } catch (e) {
        throw new FormulaError(`${it.code}: ${e instanceof Error ? e.message : 'invalid formula'}`);
      }
    } else {
      amount = 0; // HOURLY (e.g. overtime) is computed by the payroll engine from attendance
      warnings.push(`${it.code} is hourly and is calculated at payroll time`);
    }
    amount = round2(amount);
    if (!Number.isFinite(amount)) throw new FormulaError(`${it.code}: result is not a number`);
    if (amount < 0) warnings.push(`${it.code} is negative (${amount})`);
    vars[it.code] = amount;
    lines.push({
      code: it.code, name: it.name, type: it.type, amount, method: it.calcMethod, flags: it.flags,
      ...(it.calcMethod === 'HOURLY' ? { hourly: { percentOf: (it.percentOf ?? 'GROSS').toUpperCase(), multiplier: it.percentage ?? 1, hoursPerDay: it.fixedAmount ?? 8 } } : {}),
    });
  }

  const gross = round2(lines.filter((l) => l.type === 'EARNING').reduce((s, l) => s + l.amount, 0));
  const deductions = round2(lines.filter((l) => l.type === 'DEDUCTION').reduce((s, l) => s + l.amount, 0));
  const grossMatchesTarget = Math.abs(gross - targetGross) < 0.005;
  if (!grossMatchesTarget) warnings.push(`Earnings total ${gross} differs from target gross ${targetGross}`);
  return { lines, gross, deductions, net: round2(gross - deductions), targetGross, grossMatchesTarget, warnings };
}
