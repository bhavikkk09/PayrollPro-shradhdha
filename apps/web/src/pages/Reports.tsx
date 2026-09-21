import { useEffect, useMemo, useState } from 'react';
import { Download, Printer } from 'lucide-react';
import { api, download, type Session } from '../api';
import EmployeePicker, { type EmpLite } from '../components/EmployeePicker';
import { Empty, ErrorBox } from '../components/ui';
import { money } from './Salary';

interface Cat { kind: string; name: string; group: string; needs: 'month' | 'year' | 'fy' | 'employee' }
interface Col { key: string; label: string; type?: string; align?: string }
interface Report { title: string; subtitle: string; company: { name: string; address?: string }; columns: Col[]; rows: Record<string, string | number | null>[]; totals?: Record<string, string | number | null>; notes: string[]; provisional: boolean }

const inp = 'border rounded-md px-2 py-1.5 text-sm';
const fmt = (v: string | number | null | undefined, c: Col) => (v == null || v === '' ? '' : typeof v === 'number' ? (c.type === 'money' ? money(v) : String(v)) : v);

export default function Reports({ companyId, session }: { companyId: string; session: Session }) {
  const now = new Date();
  const [cat, setCat] = useState<Cat[]>([]);
  const [kind, setKind] = useState('payroll-register');
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [emp, setEmp] = useState<EmpLite | null>(null);
  const [rep, setRep] = useState<Report | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const canExport = session.user.permissions.includes('reports.export');
  const current = cat.find((c) => c.kind === kind);

  useEffect(() => { api<Cat[]>(`/companies/${companyId}/reports`).then(setCat).catch((e) => setErr(e.message)); }, [companyId]);
  useEffect(() => { setRep(null); setErr(''); }, [kind, year, month, emp]);

  const groups = useMemo(() => [...new Set(cat.map((c) => c.group))], [cat]);
  const qs = (format: string) => {
    const p = new URLSearchParams({ year: String(year), month: String(month), format });
    if (current?.needs === 'employee' && emp) p.set('employeeId', emp.id);
    return `/companies/${companyId}/reports/${kind}?${p}`;
  };
  const run = async (fn: () => Promise<void>) => { setBusy(true); setErr(''); try { await fn(); } catch (x) { setErr(x instanceof Error ? x.message : 'Failed'); } finally { setBusy(false); } };
  const view = () => run(async () => setRep(await api<Report>(qs('json'))));
  const file = (f: 'csv' | 'xlsx' | 'pdf') => run(() => download(qs(f)));

  const needsMonth = current?.needs === 'month';
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold print:hidden">Reports</h1>
      <div className="bg-white border rounded-xl p-4 flex flex-wrap gap-3 items-end print:hidden">
        <label className="text-xs text-slate-600">Report
          <select className={`${inp} block mt-1 w-60`} value={kind} onChange={(e) => setKind(e.target.value)}>
            {groups.map((g) => <optgroup key={g} label={g}>{cat.filter((c) => c.group === g).map((c) => <option key={c.kind} value={c.kind}>{c.name}</option>)}</optgroup>)}
          </select></label>
        {needsMonth && (
          <label className="text-xs text-slate-600">Month
            <select className={`${inp} block mt-1`} value={month} onChange={(e) => setMonth(+e.target.value)}>
              {Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>{new Date(2000, i, 1).toLocaleString('en', { month: 'long' })}</option>)}
            </select></label>
        )}
        <label className="text-xs text-slate-600">{current?.needs === 'fy' || current?.needs === 'employee' ? 'Financial year starting' : 'Year'}
          <input className={`${inp} block mt-1 w-24`} type="number" value={year} onChange={(e) => setYear(+e.target.value)} /></label>
        {current?.needs === 'employee' && <div className="text-xs text-slate-600">Employee<EmployeePicker companyId={companyId} value={emp} onChange={setEmp} /></div>}
        <button disabled={busy || (current?.needs === 'employee' && !emp)} onClick={view} className="bg-slate-900 text-white rounded-md px-4 py-1.5 text-sm disabled:opacity-40">{busy ? 'Working…' : 'View'}</button>
        {canExport && (
          <div className="flex gap-2 ml-auto">
            {(['csv', 'xlsx', 'pdf'] as const).map((f) => (
              <button key={f} disabled={busy || (current?.needs === 'employee' && !emp)} onClick={() => file(f)} className="flex items-center gap-1 border rounded-md px-3 py-1.5 text-sm bg-white disabled:opacity-40 uppercase"><Download size={14} /> {f}</button>
            ))}
            <button disabled={!rep} onClick={() => window.print()} className="flex items-center gap-1 border rounded-md px-3 py-1.5 text-sm bg-white disabled:opacity-40"><Printer size={14} /> Print</button>
          </div>
        )}
      </div>
      {err && <ErrorBox text={err} />}

      {!rep && !err && <div className="bg-white border rounded-xl print:hidden"><Empty text="Choose a report and click View." /></div>}
      {rep && (
        <div className="bg-white border rounded-xl print:border-0">
          <div className="px-4 py-3 border-b">
            <div className="font-semibold">{rep.company.name}</div>
            <div className="text-sm">{rep.title} <span className="text-slate-500">· {rep.subtitle}</span></div>
            {rep.provisional && <div className="text-xs font-semibold text-red-700 mt-1">PROVISIONAL: payroll not yet approved</div>}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm print:text-[9px]">
              <thead className="text-left text-slate-500"><tr>{rep.columns.map((c) => <th key={c.key} className={`px-3 py-2 font-medium whitespace-nowrap ${c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : ''}`}>{c.label}</th>)}</tr></thead>
              <tbody>
                {rep.rows.map((r, i) => <tr key={i} className="border-t">{rep.columns.map((c) => <td key={c.key} className={`px-3 py-1.5 whitespace-nowrap ${c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : ''}`}>{fmt(r[c.key], c)}</td>)}</tr>)}
                {rep.totals && <tr className="border-t-2 font-semibold">{rep.columns.map((c) => <td key={c.key} className={`px-3 py-2 whitespace-nowrap ${c.align === 'right' ? 'text-right' : ''}`}>{fmt(rep.totals![c.key], c)}</td>)}</tr>}
              </tbody>
            </table>
            {rep.rows.length === 0 && <Empty text="No data for this selection." />}
          </div>
          {rep.notes.length > 0 && <div className="px-4 py-3 text-xs text-slate-500 space-y-1 border-t">{rep.notes.map((n) => <div key={n}>{n}</div>)}</div>}
        </div>
      )}
    </div>
  );
}
