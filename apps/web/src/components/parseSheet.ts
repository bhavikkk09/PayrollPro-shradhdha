import { readSheet } from 'read-excel-file/browser';

export interface ImportRow { employeeCode: string; date: string; status: string; otHours: string }

const HEAD: Record<string, keyof ImportRow> = {
  'employee code': 'employeeCode', 'emp code': 'employeeCode', code: 'employeeCode', employeecode: 'employeeCode',
  date: 'date', status: 'status', 'attendance status': 'status', 'ot hours': 'otHours', ot: 'otHours', othours: 'otHours',
};

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const cell = (v: unknown) => (v instanceof Date ? iso(v) : v == null ? '' : String(v).trim());

function csv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

/** Reads .xlsx or .csv into rows keyed by the expected columns. Header names are matched loosely. */
export async function parseAttendanceFile(file: File): Promise<ImportRow[]> {
  const raw: unknown[][] = /\.xlsx$/i.test(file.name) ? ((await readSheet(file)) as unknown[][]) : csv(await file.text());
  if (raw.length < 2) throw new Error('The file has no data rows');
  const cols = raw[0].map((h) => HEAD[String(h ?? '').trim().toLowerCase()]);
  for (const need of ['employeeCode', 'date', 'status'] as const) {
    if (!cols.includes(need)) throw new Error('Header row must contain: Employee Code, Date, Attendance Status (and optionally OT Hours)');
  }
  return raw.slice(1).filter((r) => r.some((c) => cell(c) !== '')).map((r) => {
    const o: ImportRow = { employeeCode: '', date: '', status: '', otHours: '' };
    cols.forEach((k, i) => { if (k) o[k] = cell(r[i]); });
    return o;
  });
}
