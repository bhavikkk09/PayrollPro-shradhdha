import { Status } from './attendance-summary';

export interface QuickRawRow { employeeCode?: unknown; paidDays?: unknown; otHours?: unknown }
export interface QuickEmployeeRef { id: string; workingDates: string[] } // this employee's working days in the month, within their employment window
export interface QuickEntry { employeeId: string; date: string; status: Status; otHours: number }
export interface RowError { row: number; message: string }

/**
 * Turns "employee worked N days this month" into concrete daily marks, so it can flow through
 * the same write()/finalize()/payroll pipeline as the day-by-day grid: the first N working days
 * become PRESENT (the last one HALF_DAY if N ends in .5), the rest become ABSENT. Weekly offs and
 * holidays are never written here - the summariser already pays them automatically, for every
 * calc method, so the result is exactly "N days worked" regardless of company's calc method.
 */
export function buildQuickEntries(rows: QuickRawRow[], employees: Map<string, QuickEmployeeRef>, otEnabled: boolean) {
  const valid: QuickEntry[] = [];
  const errors: RowError[] = [];
  const seen = new Set<string>();

  rows.forEach((r, idx) => {
    const row = idx + 2; // header is row 1
    const fail = (message: string) => errors.push({ row, message });
    const code = String(r.employeeCode ?? '').trim();
    if (!code) return fail('Employee code is missing');
    const emp = employees.get(code.toUpperCase());
    if (!emp) return fail(`Employee "${code}" not found in this company, or not employed this month`);
    if (seen.has(emp.id)) return fail(`Duplicate entry for ${code}`);

    const raw = String(r.paidDays ?? '').trim();
    if (raw === '') return fail('Days worked is missing');
    const paidDays = Number(raw);
    if (!Number.isFinite(paidDays) || paidDays < 0) return fail(`Days worked "${raw}" must be 0 or more`);
    if (Math.round(paidDays * 2) !== paidDays * 2) return fail(`Days worked "${raw}" must be in half-day steps (e.g. 21 or 21.5)`);
    if (paidDays > emp.workingDates.length) return fail(`Days worked (${paidDays}) exceeds this employee's ${emp.workingDates.length} working day(s) this month`);

    let ot = 0;
    const rawOt = String(r.otHours ?? '').trim();
    if (rawOt !== '') {
      ot = Number(rawOt);
      if (!Number.isFinite(ot) || ot < 0) return fail(`OT hours "${rawOt}" must be 0 or more`);
      if (ot > 0 && !otEnabled) return fail('Overtime is not enabled for this company');
    }
    const whole = Math.floor(paidDays);
    const half = paidDays - whole === 0.5;
    if (ot > 0 && whole === 0 && !half) return fail('OT hours need at least one day worked');
    seen.add(emp.id);

    emp.workingDates.forEach((d, i) => {
      const status: Status = i < whole ? 'PRESENT' : half && i === whole ? 'HALF_DAY' : 'ABSENT';
      valid.push({ employeeId: emp.id, date: d, status, otHours: i === 0 ? ot : 0 });
    });
  });
  return { valid, errors };
}
