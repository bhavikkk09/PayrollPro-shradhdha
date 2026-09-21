import { Status, STATUSES } from './attendance-summary';

const ALIASES: Record<string, Status> = {
  P: 'PRESENT', PRESENT: 'PRESENT', A: 'ABSENT', ABSENT: 'ABSENT',
  PL: 'PAID_LEAVE', 'PAID LEAVE': 'PAID_LEAVE', PAID_LEAVE: 'PAID_LEAVE', L: 'PAID_LEAVE',
  UL: 'UNPAID_LEAVE', 'UNPAID LEAVE': 'UNPAID_LEAVE', UNPAID_LEAVE: 'UNPAID_LEAVE',
  WO: 'WEEKLY_OFF', 'WEEKLY OFF': 'WEEKLY_OFF', WEEKLY_OFF: 'WEEKLY_OFF',
  H: 'HOLIDAY', HOLIDAY: 'HOLIDAY', HD: 'HALF_DAY', 'HALF DAY': 'HALF_DAY', HALF_DAY: 'HALF_DAY', LOP: 'LOP',
};

export interface RawRow { employeeCode?: unknown; date?: unknown; status?: unknown; otHours?: unknown }
export interface EmployeeRef { id: string; doj: string; dol: string | null }
export interface ValidRow { employeeId: string; employeeCode: string; date: string; status: Status; otHours: number }
export interface RowError { row: number; message: string }

/** Accepts YYYY-MM-DD, DD/MM/YYYY and DD-MM-YYYY. Returns null if not a real calendar date. */
export function parseDate(v: unknown): string | null {
  const s = String(v ?? '').trim();
  let y: number, m: number, d: number;
  let x = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (x) { y = +x[1]; m = +x[2]; d = +x[3]; } else {
    x = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
    if (!x) return null;
    d = +x[1]; m = +x[2]; y = +x[3];
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

export function validateAttendanceRows(rows: RawRow[], employees: Map<string, EmployeeRef>, otEnabled: boolean) {
  const valid: ValidRow[] = [];
  const errors: RowError[] = [];
  const seen = new Set<string>();

  rows.forEach((r, idx) => {
    const row = idx + 2; // header is row 1
    const code = String(r.employeeCode ?? '').trim();
    const fail = (message: string) => errors.push({ row, message });
    if (!code) return fail('Employee code is missing');
    const emp = employees.get(code.toUpperCase());
    if (!emp) return fail(`Employee "${code}" not found in this company`);
    const date = parseDate(r.date);
    if (!date) return fail(`Invalid date "${String(r.date ?? '')}" (use YYYY-MM-DD or DD/MM/YYYY)`);
    const status = ALIASES[String(r.status ?? '').trim().toUpperCase()];
    if (!status) return fail(`Unknown status "${String(r.status ?? '')}". Use: ${STATUSES.join(', ')}`);
    if (date < emp.doj) return fail(`${date} is before the joining date ${emp.doj}`);
    if (emp.dol && date > emp.dol) return fail(`${date} is after the leaving date ${emp.dol}`);
    let ot = 0;
    const rawOt = String(r.otHours ?? '').trim();
    if (rawOt !== '') {
      ot = Number(rawOt);
      if (!Number.isFinite(ot) || ot < 0 || ot > 24) return fail(`OT hours "${rawOt}" must be between 0 and 24`);
      if (ot > 0 && !otEnabled) return fail('Overtime is not enabled for this company');
    }
    const dupKey = `${emp.id}|${date}`;
    if (seen.has(dupKey)) return fail(`Duplicate entry for ${code} on ${date}`);
    seen.add(dupKey);
    valid.push({ employeeId: emp.id, employeeCode: code, date, status, otHours: ot });
  });
  return { valid, errors };
}
