// Gratuity estimate. Nothing legal is hard-coded: days per year, divisor, minimum service, rounding and cap all
// come from a GRATUITY compliance rule (rule.rules). Death/disability exceptions are not modelled.
export interface GratuityRule {
  daysPerYear: number; // e.g. days of wages per completed year
  monthlyDivisor: number; // days a month's wage is divided by
  minYears?: number; // eligibility threshold
  roundUpAfterMonths?: number; // remaining months above this count as one more year
  maxAmount?: number;
}

const day = (s: string) => new Date(`${s}T00:00:00Z`);

/** Completed years and leftover months between two dates (YYYY-MM-DD). */
export function serviceOf(doj: string, asOf: string) {
  const a = day(doj), b = day(asOf);
  let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() < a.getUTCDate()) months -= 1;
  months = Math.max(0, months);
  return { years: Math.floor(months / 12), months: months % 12 };
}

export function gratuityFor(doj: string, asOf: string, lastMonthlyWage: number, rule: GratuityRule) {
  const s = serviceOf(doj, asOf);
  const counted = s.years + (rule.roundUpAfterMonths != null && s.months > rule.roundUpAfterMonths ? 1 : 0);
  const eligible = s.years >= (rule.minYears ?? 0);
  let amount = eligible ? (lastMonthlyWage * rule.daysPerYear * counted) / rule.monthlyDivisor : 0;
  if (rule.maxAmount != null) amount = Math.min(amount, rule.maxAmount);
  return { serviceYears: s.years, serviceMonths: s.months, countedYears: counted, eligible, amount: Math.round(amount) };
}
