// Validation for compliance rule versions. Returns human-readable errors; an empty list means valid.
// It checks shape and sanity only. The legal correctness of the numbers is the compliance administrator's job.

export const MODULES = ['PF', 'ESI', 'PT', 'LWF', 'TDS', 'BONUS', 'GRATUITY', 'MINIMUM_WAGE', 'OTHER'] as const;

export interface RuleBody {
  module: string;
  state?: string | null;
  effectiveFrom: string;
  wageCeiling?: number | null;
  threshold?: number | null;
  employeePercent?: number | null;
  employerPercent?: number | null;
  slabs?: unknown;
  rules?: Record<string, any> | null;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const pct = (v: unknown) => v == null || (isNum(v) && v >= 0 && v <= 100);

/** Bands must start at >= 0, be ordered, not overlap, and only the last band may be open-ended. */
function checkBands(slabs: unknown, valueKey: 'amount' | 'rate', errors: string[]) {
  if (!Array.isArray(slabs) || slabs.length === 0) { errors.push('At least one slab is required'); return; }
  let prevTo: number | null = -1;
  slabs.forEach((s: any, i: number) => {
    const at = `Slab ${i + 1}`;
    if (!s || !isNum(s.from) || s.from < 0) return void errors.push(`${at}: "from" must be a number >= 0`);
    if (s.to != null && (!isNum(s.to) || s.to < s.from)) return void errors.push(`${at}: "to" must be empty or >= from`);
    if (!isNum(s[valueKey]) || s[valueKey] < 0 || (valueKey === 'rate' && s[valueKey] > 100)) errors.push(`${at}: "${valueKey}" must be a valid number`);
    if (prevTo === null) errors.push(`${at}: only the last slab may be open-ended`);
    else if (i > 0 && s.from < prevTo) errors.push(`${at}: overlaps the previous slab`);
    if (s.monthAmounts) for (const [m, v] of Object.entries(s.monthAmounts)) if (!/^(1[0-2]|[1-9])$/.test(m) || !isNum(v) || (v as number) < 0) errors.push(`${at}: invalid monthAmounts entry ${m}`);
    prevTo = s.to == null ? null : s.to;
  });
}

export function validateRule(d: RuleBody): string[] {
  const e: string[] = [];
  if (!(MODULES as readonly string[]).includes(d.module)) e.push('Unknown module');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.effectiveFrom ?? '') || Number.isNaN(Date.parse(d.effectiveFrom))) e.push('Effective from must be a valid date (YYYY-MM-DD)');
  for (const k of ['wageCeiling', 'threshold'] as const) if (d[k] != null && (!isNum(d[k]) || (d[k] as number) < 0)) e.push(`${k} must be a number >= 0`);
  if (!pct(d.employeePercent) || !pct(d.employerPercent)) e.push('Percentages must be between 0 and 100');
  const r = d.rules ?? {};
  if (r.dueDay != null && !(Number.isInteger(r.dueDay) && r.dueDay >= 1 && r.dueDay <= 31)) e.push('rules.dueDay must be 1-31');
  if (r.dueMonthOffset != null && !(Number.isInteger(r.dueMonthOffset) && r.dueMonthOffset >= 0 && r.dueMonthOffset <= 3)) e.push('rules.dueMonthOffset must be 0-3');
  if (r.months != null && !(Array.isArray(r.months) && r.months.every((m: unknown) => Number.isInteger(m) && (m as number) >= 1 && (m as number) <= 12))) e.push('rules.months must be a list of months 1-12');
  if (r.rounding != null && !['UP', 'DOWN', 'NEAREST'].includes(r.rounding)) e.push('rules.rounding must be UP, DOWN or NEAREST');

  switch (d.module) {
    case 'PF':
      if (d.employeePercent == null || d.employerPercent == null) e.push('PF needs employee and employer percent');
      break;
    case 'ESI':
      if (d.employeePercent == null || d.employerPercent == null) e.push('ESI needs employee and employer percent');
      if (d.wageCeiling == null) e.push('ESI needs a wage ceiling (coverage limit)');
      break;
    case 'PT': checkBands(d.slabs, 'amount', e); break;
    case 'LWF':
      if (!isNum(r.employeeAmount) || r.employeeAmount < 0 || !isNum(r.employerAmount) || r.employerAmount < 0) e.push('LWF needs rules.employeeAmount and rules.employerAmount');
      break;
    case 'TDS':
      checkBands(d.slabs, 'rate', e);
      if (r.standardDeduction != null && (!isNum(r.standardDeduction) || r.standardDeduction < 0)) e.push('rules.standardDeduction must be >= 0');
      if (r.cessPercent != null && !pct(r.cessPercent)) e.push('rules.cessPercent must be 0-100');
      if (r.rebate != null && (!isNum(r.rebate.incomeLimit) || !isNum(r.rebate.maxAmount))) e.push('rules.rebate needs incomeLimit and maxAmount');
      if (r.fyStartMonth != null && !(Number.isInteger(r.fyStartMonth) && r.fyStartMonth >= 1 && r.fyStartMonth <= 12)) e.push('rules.fyStartMonth must be 1-12');
      break;
  }
  return e;
}
