// Pure report builders: prepared data in, ReportResult out. No database, no clock.
import { gratuityFor, GratuityRule } from './gratuity';
import { Col, makeReport, ReportContext, ReportResult, Row, r2 } from './types';

export interface PayEmp {
  code: string; name: string; department: string; designation: string;
  uan: string; pfNumber: string; esiNumber: string; bankName: string; bankAccount: string; ifsc: string;
  paidDays: number; lopDays: number; otHours: number; gross: number; totalDeductions: number; net: number;
  earnings: { code: string; name: string; amount: number; source?: string }[];
  deductions: { code: string; name: string; amount: number; employer: number | null }[];
  trace: { step: string; detail: any }[];
}

const text = (key: string, label: string): Col => ({ key, label, type: 'text' });
const money = (key: string, label: string, total = true): Col => ({ key, label, type: 'money', align: 'right', total });
const num = (key: string, label: string, total = true): Col => ({ key, label, type: 'number', align: 'right', total });

/** Distinct codes in first-seen order, so every employee's lines land in a stable column. */
function codes(emps: PayEmp[], side: 'earnings' | 'deductions') {
  const seen = new Map<string, string>();
  for (const e of emps) for (const l of e[side]) if (!seen.has(l.code)) seen.set(l.code, l.name);
  return [...seen].map(([code, name]) => ({ code, name }));
}
const amt = (e: PayEmp, side: 'earnings' | 'deductions', code: string) => e[side].filter((l) => l.code === code).reduce((s, l) => s + l.amount, 0);
const stat = (e: PayEmp, code: string) => {
  const d = e.deductions.find((x) => x.code === code);
  const wage = e.trace.find((t) => t.step === code.toLowerCase())?.detail?.wage;
  return d ? { employee: d.amount, employer: d.employer ?? 0, wage: typeof wage === 'number' ? wage : 0 } : null;
};
const base = (e: PayEmp): Row => ({ code: e.code, name: e.name });

export function payrollRegister(ctx: ReportContext, emps: PayEmp[]): ReportResult {
  return makeReport('payroll-register', 'Payroll Register', ctx,
    [text('code', 'Code'), text('name', 'Name'), text('department', 'Department'), num('paidDays', 'Paid days'), num('lopDays', 'LOP'), num('otHours', 'OT hrs'),
      money('gross', 'Gross'), money('deductions', 'Deductions'), money('net', 'Net pay')],
    emps.map((e) => ({ ...base(e), department: e.department, paidDays: e.paidDays, lopDays: e.lopDays, otHours: e.otHours, gross: e.gross, deductions: e.totalDeductions, net: e.net })));
}

function salaryLike(kind: string, title: string, ctx: ReportContext, emps: PayEmp[], extra: { signature: boolean }): ReportResult {
  const ec = codes(emps, 'earnings'), dc = codes(emps, 'deductions');
  const cols: Col[] = [text('code', 'Code'), text('name', 'Name'), ...(extra.signature ? [text('designation', 'Designation')] : []), num('paidDays', 'Days'),
    ...ec.map((c) => money(`e_${c.code}`, c.name)), money('gross', 'Gross'),
    ...dc.map((c) => money(`d_${c.code}`, c.name)), money('totalDeductions', 'Total ded.'), money('net', 'Net pay'),
    ...(extra.signature ? [text('signature', 'Signature')] : [])];
  const rows = emps.map((e) => {
    const r: Row = { ...base(e), designation: e.designation, paidDays: e.paidDays, gross: e.gross, totalDeductions: e.totalDeductions, net: e.net, signature: '' };
    for (const c of ec) r[`e_${c.code}`] = amt(e, 'earnings', c.code);
    for (const c of dc) r[`d_${c.code}`] = amt(e, 'deductions', c.code);
    return r;
  });
  return makeReport(kind, title, ctx, cols, rows);
}
export const salaryRegister = (ctx: ReportContext, emps: PayEmp[]) => salaryLike('salary-register', 'Salary Register', ctx, emps, { signature: false });
export const wageRegister = (ctx: ReportContext, emps: PayEmp[]) => salaryLike('wage-register', 'Wage Register', ctx, emps, { signature: true });

export function deductionRegister(ctx: ReportContext, emps: PayEmp[]): ReportResult {
  const dc = codes(emps, 'deductions');
  return makeReport('deduction-register', 'Deduction Register', ctx,
    [text('code', 'Code'), text('name', 'Name'), ...dc.map((c) => money(`d_${c.code}`, c.name)), money('total', 'Total')],
    emps.filter((e) => e.deductions.length).map((e) => {
      const r: Row = { ...base(e), total: e.totalDeductions };
      for (const c of dc) r[`d_${c.code}`] = amt(e, 'deductions', c.code);
      return r;
    }));
}

export function pfReport(ctx: ReportContext, emps: PayEmp[]): ReportResult {
  const rows = emps.flatMap((e) => { const s = stat(e, 'PF'); return s ? [{ ...base(e), uan: e.uan, pfNumber: e.pfNumber, wage: s.wage, employee: s.employee, employer: s.employer, total: s.employee + s.employer }] : []; });
  const missing = emps.filter((e) => stat(e, 'PF') && !e.uan).length;
  return makeReport('pf-report', 'Provident Fund Report', ctx,
    [text('code', 'Code'), text('name', 'Name'), text('uan', 'UAN'), text('pfNumber', 'PF no.'), money('wage', 'PF wages'), money('employee', 'Employee share'), money('employer', 'Employer share'), money('total', 'Total')],
    rows, missing ? [`${missing} employee(s) have no UAN recorded.`] : []);
}

export function esiReport(ctx: ReportContext, emps: PayEmp[]): ReportResult {
  const rows = emps.flatMap((e) => { const s = stat(e, 'ESI'); return s ? [{ ...base(e), esiNumber: e.esiNumber, wage: s.wage, employee: s.employee, employer: s.employer, total: s.employee + s.employer }] : []; });
  const missing = emps.filter((e) => stat(e, 'ESI') && !e.esiNumber).length;
  return makeReport('esi-report', 'ESI Report', ctx,
    [text('code', 'Code'), text('name', 'Name'), text('esiNumber', 'ESI no.'), money('wage', 'ESI wages'), money('employee', 'Employee share'), money('employer', 'Employer share'), money('total', 'Total')],
    rows, missing ? [`${missing} employee(s) have no ESI number recorded.`] : []);
}

export function ptReport(ctx: ReportContext, emps: PayEmp[]): ReportResult {
  const rows = emps.flatMap((e) => { const s = stat(e, 'PT'); return s ? [{ ...base(e), wage: s.wage, pt: s.employee }] : []; });
  return makeReport('pt-report', 'Professional Tax Report', ctx, [text('code', 'Code'), text('name', 'Name'), money('wage', 'PT wages'), money('pt', 'PT deducted')], rows);
}

export function lwfReport(ctx: ReportContext, emps: PayEmp[]): ReportResult {
  const rows = emps.flatMap((e) => { const s = stat(e, 'LWF'); return s ? [{ ...base(e), employee: s.employee, employer: s.employer, total: s.employee + s.employer }] : []; });
  return makeReport('lwf-report', 'Labour Welfare Fund Report', ctx, [text('code', 'Code'), text('name', 'Name'), money('employee', 'Employee share'), money('employer', 'Employer share'), money('total', 'Total')], rows);
}

export function otRegister(ctx: ReportContext, emps: PayEmp[]): ReportResult {
  const rows = emps.filter((e) => e.otHours > 0).map((e) => ({ ...base(e), otHours: e.otHours, amount: e.earnings.filter((l) => l.source === 'OVERTIME').reduce((s, l) => s + l.amount, 0) }));
  return makeReport('ot-register', 'Overtime Register', ctx, [text('code', 'Code'), text('name', 'Name'), num('otHours', 'OT hours'), money('amount', 'OT amount')], rows);
}

export function bankStatement(ctx: ReportContext, emps: PayEmp[]): ReportResult {
  const payable = emps.filter((e) => e.net > 0);
  const noBank = payable.filter((e) => !e.bankAccount || !e.ifsc).length;
  return makeReport('bank-statement', 'Bank Salary Statement', ctx,
    [text('code', 'Code'), text('name', 'Name'), text('bankName', 'Bank'), text('account', 'Account no.'), text('ifsc', 'IFSC'), money('net', 'Net pay')],
    payable.map((e) => ({ ...base(e), bankName: e.bankName, account: e.bankAccount, ifsc: e.ifsc, net: e.net })),
    noBank ? [`${noBank} employee(s) have missing bank details and cannot be paid by transfer.`] : []);
}

// ───────── Attendance, leave, ledger, bonus, gratuity ─────────
export interface AttRow { code: string; name: string; present: number; absent: number; paidLeave: number; unpaidLeave: number; weeklyOffs: number; holidays: number; lopDays: number; otHours: number; paidDays: number; days: Record<string, string> }

export function attendanceRegister(ctx: ReportContext, rows: AttRow[]): ReportResult {
  return makeReport('attendance-register', 'Attendance Register', ctx,
    [text('code', 'Code'), text('name', 'Name'), num('present', 'Present'), num('absent', 'Absent'), num('paidLeave', 'Paid leave'), num('unpaidLeave', 'Unpaid leave'),
      num('weeklyOffs', 'Week offs'), num('holidays', 'Holidays'), num('lopDays', 'LOP'), num('otHours', 'OT hrs'), num('paidDays', 'Paid days')],
    rows.map((r) => ({ code: r.code, name: r.name, present: r.present, absent: r.absent, paidLeave: r.paidLeave, unpaidLeave: r.unpaidLeave, weeklyOffs: r.weeklyOffs, holidays: r.holidays, lopDays: r.lopDays, otHours: r.otHours, paidDays: r.paidDays })));
}

export function musterRoll(ctx: ReportContext, rows: AttRow[], daysInMonth: number): ReportResult {
  const dayCols: Col[] = Array.from({ length: daysInMonth }, (_, i) => ({ key: `d${i + 1}`, label: String(i + 1), type: 'text' as const, align: 'center' as const }));
  return makeReport('muster-roll', 'Muster Roll', ctx, [text('code', 'Code'), text('name', 'Name'), ...dayCols, num('present', 'Present', false)],
    rows.map((r) => {
      const o: Row = { code: r.code, name: r.name, present: r.present };
      for (let d = 1; d <= daysInMonth; d++) o[`d${d}`] = r.days[String(d)] ?? '';
      return o;
    }),
    ['P present, A absent, PL paid leave, UL unpaid leave, HD half day, WO weekly off, H holiday. Blank means not marked.']);
}

export function leaveRegister(ctx: ReportContext, types: { id: string; code: string; name: string }[], rows: { code: string; name: string; balances: Record<string, number> }[]): ReportResult {
  return makeReport('leave-register', 'Leave Register', ctx,
    [text('code', 'Code'), text('name', 'Name'), ...types.map((t) => num(`t_${t.id}`, `${t.code} balance`, false))],
    rows.map((r) => { const o: Row = { code: r.code, name: r.name }; for (const t of types) o[`t_${t.id}`] = r.balances[t.id] ?? 0; return o; }));
}

export function employeeLedger(ctx: ReportContext, months: { label: string; paidDays: number; gross: number; deductions: number; net: number; status: string }[]): ReportResult {
  return makeReport('employee-ledger', 'Employee Ledger', ctx,
    [text('month', 'Month'), num('paidDays', 'Paid days'), money('gross', 'Gross'), money('deductions', 'Deductions'), money('net', 'Net pay'), text('status', 'Payroll status')],
    months.map((m) => ({ month: m.label, paidDays: m.paidDays, gross: m.gross, deductions: m.deductions, net: m.net, status: m.status })));
}

export function bonusReport(ctx: ReportContext, rows: { code: string; name: string; wages: number; paid: number }[]): ReportResult {
  return makeReport('bonus-report', 'Bonus Report', ctx,
    [text('code', 'Code'), text('name', 'Name'), money('wages', 'Bonus-applicable wages'), money('paid', 'Bonus paid')], rows,
    ['Shows bonus-applicable wages and bonus already paid through payroll. Statutory bonus is not calculated automatically.']);
}

export function gratuityReport(ctx: ReportContext, rows: { code: string; name: string; doj: string; wage: number }[], asOf: string, rule: GratuityRule | null): ReportResult {
  const cols: Col[] = [text('code', 'Code'), text('name', 'Name'), { key: 'doj', label: 'Date of joining', type: 'date' }, text('service', 'Service'), money('wage', 'Last monthly wage', false),
    ...(rule ? [text('eligible', 'Eligible'), money('amount', 'Gratuity (est.)')] : [])];
  const out = rows.map((r) => {
    const base: Row = { code: r.code, name: r.name, doj: r.doj, wage: r.wage };
    const g = gratuityFor(r.doj, asOf, r.wage, rule ?? { daysPerYear: 0, monthlyDivisor: 1 });
    base.service = `${g.serviceYears}y ${g.serviceMonths}m`;
    if (rule) { base.eligible = g.eligible ? 'Yes' : 'No'; base.amount = g.amount; }
    return base;
  });
  return makeReport('gratuity-report', 'Gratuity Report', ctx, cols, out,
    rule ? ['Estimate from the GRATUITY rule in force. Exceptions such as death or disability are not modelled.'] : ['No GRATUITY rule is configured, so amounts are not calculated. Add one under Compliance rules.']);
}

export { r2 };
