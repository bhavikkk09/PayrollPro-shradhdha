// Pure month summariser: no DB, no clock. Dates are 'YYYY-MM-DD' strings (UTC calendar days).

export type Status = 'PRESENT' | 'ABSENT' | 'PAID_LEAVE' | 'UNPAID_LEAVE' | 'WEEKLY_OFF' | 'HOLIDAY' | 'HALF_DAY' | 'LOP';
export const STATUSES: Status[] = ['PRESENT', 'ABSENT', 'PAID_LEAVE', 'UNPAID_LEAVE', 'WEEKLY_OFF', 'HOLIDAY', 'HALF_DAY', 'LOP'];

export type CalcMethod = 'CALENDAR_DAYS' | 'FIXED_30' | 'WORKING_DAYS';
const DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

export interface SummaryInput {
  year: number;
  month: number; // 1-12
  records: Map<string, { status: Status; otHours: number }>;
  weeklyOff: string[]; // e.g. ['SUN']
  holidays: Set<string>;
  doj: string | null; // employment window; days outside it are not counted
  dol: string | null;
  calcMethod: CalcMethod;
  lopEnabled: boolean;
  otEnabled: boolean;
  unmarkedAs?: Status; // how to treat days with no record (working days only)
}

export interface MonthSummary {
  daysInMonth: number;
  employedDays: number;
  workingDays: number; // employed days that are neither weekly off nor holiday
  present: number;
  absent: number;
  paidLeave: number;
  unpaidLeave: number;
  weeklyOffs: number;
  holidays: number;
  lopDays: number;
  otHours: number;
  unmarked: number;
  unmarkedDates: string[];
  salaryDivisor: number; // days the monthly salary is divided by
  paidDays: number;
}

export const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const dateKey = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
export const weekday = (key: string) => DOW[new Date(`${key}T00:00:00Z`).getUTCDay()];
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * LOP rule: when LOP is enabled, lopDays = absent + unpaid leave + days marked LOP + 0.5 per half day.
 * When LOP is disabled no deduction days are produced (everyone is paid in full).
 * paidDays: CALENDAR_DAYS -> employed days - LOP; FIXED_30 -> 30 (or employed days if fewer) - LOP;
 * WORKING_DAYS -> employed working days - LOP. Weekly offs and holidays are paid in the first two.
 */
export function summarizeMonth(i: SummaryInput): MonthSummary {
  const n = daysInMonth(i.year, i.month);
  const s: MonthSummary = {
    daysInMonth: n, employedDays: 0, workingDays: 0, present: 0, absent: 0, paidLeave: 0, unpaidLeave: 0,
    weeklyOffs: 0, holidays: 0, lopDays: 0, otHours: 0, unmarked: 0, unmarkedDates: [], salaryDivisor: 0, paidDays: 0,
  };
  let lopMarked = 0;
  let monthWorking = 0;

  for (let d = 1; d <= n; d++) {
    const key = dateKey(i.year, i.month, d);
    const isWo = i.weeklyOff.includes(weekday(key));
    const isHol = i.holidays.has(key);
    if (!isWo && !isHol) monthWorking++;
    if ((i.doj && key < i.doj) || (i.dol && key > i.dol)) continue; // not employed that day
    s.employedDays++;

    const rec = i.records.get(key);
    let st: Status | null = rec?.status ?? null;
    if (!st) st = isWo ? 'WEEKLY_OFF' : isHol ? 'HOLIDAY' : i.unmarkedAs ?? null;
    if (!isWo && !isHol) s.workingDays++;
    if (!st) { s.unmarked++; s.unmarkedDates.push(key); continue; }
    if (rec && i.otEnabled) s.otHours += rec.otHours;

    switch (st) {
      case 'PRESENT': s.present += 1; break;
      case 'HALF_DAY': s.present += 0.5; s.absent += 0.5; break;
      case 'ABSENT': s.absent += 1; break;
      case 'PAID_LEAVE': s.paidLeave += 1; break;
      case 'UNPAID_LEAVE': s.unpaidLeave += 1; break;
      case 'LOP': lopMarked += 1; break;
      case 'WEEKLY_OFF': s.weeklyOffs += 1; break;
      case 'HOLIDAY': s.holidays += 1; break;
    }
  }

  s.lopDays = i.lopEnabled ? r2(s.absent + s.unpaidLeave + lopMarked) : 0;

  let base: number;
  if (i.calcMethod === 'FIXED_30') { s.salaryDivisor = 30; base = s.employedDays === n ? 30 : Math.min(30, s.employedDays); }
  else if (i.calcMethod === 'WORKING_DAYS') { s.salaryDivisor = monthWorking; base = s.workingDays; }
  else { s.salaryDivisor = n; base = s.employedDays; }
  s.paidDays = Math.max(0, r2(base - s.lopDays));
  s.otHours = r2(s.otHours);
  s.present = r2(s.present); s.absent = r2(s.absent);
  return s;
}

/** Working days (excluding weekly off and holidays) between two dates inclusive. Used for leave requests. */
export function workingDatesBetween(from: string, to: string, weeklyOff: string[], holidays: Set<string>): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    const key = new Date(t).toISOString().slice(0, 10);
    if (!weeklyOff.includes(weekday(key)) && !holidays.has(key)) out.push(key);
  }
  return out;
}
