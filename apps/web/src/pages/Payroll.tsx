import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ListChecks, Trash2, X } from 'lucide-react';
import { api, download, type Session } from '../api';
import EmployeePicker, { type EmpLite } from '../components/EmployeePicker';
import QuickImportModal from '../components/QuickImportModal';
import { Badge, Card, Empty, ErrorBox } from '../components/ui';
import { money } from './Salary';

interface Run {
  id: string; year: number; month: number; status: string; totalGross: string | null; totalDeductions: string | null; totalNet: string | null;
  issues: { employeeId: string; code: string; level: 'ERROR' | 'WARNING'; message: string }[] | null; _count?: { details: number };
}
interface Row { id: string; employeeId: string; paidDays: string; lopDays: string; otHours: string; gross: string; totalDeductions: string; net: string; hasWarnings: boolean; employee: { code: string; firstName: string; lastName?: string } }
interface Detail {
  gross: string; totalDeductions: string; net: string; paidDays: string; warnings: string[] | null; formulaVersion: string; calculatedAt: string;
  earnings: { id: string; code: string; name: string; amount: string }[]; deductions: { id: string; code: string; name: string; amount: string; employerAmount: string | null }[];
  calculation: { trace: { step: string; detail: unknown }[]; employerContribution: number };
  employee: { code: string; firstName: string; lastName?: string };
}
interface Input { id: string; kind: string; name: string; amount: string; employee: { code: string; firstName: string } }

const STEPS = ['DRAFT', 'CALCULATED', 'REVIEW', 'APPROVED', 'LOCKED'];
const inp = 'border rounded-md px-2 py-1.5 text-sm';
const num = (v: string | number | null | undefined) => money(Number(v ?? 0));

export default function Payroll({ companyId, session }: { companyId: string; session: Session }) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [run, setRun] = useState<Run | null | undefined>(undefined);
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<'register' | 'issues' | 'inputs'>('register');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [drawer, setDrawer] = useState<string | null>(null);
  const [quickImport, setQuickImport] = useState(false);
  const can = (p: string) => session.user.permissions.includes(p);
  const pageSize = 50;

  const loadRun = useCallback(async () => {
    setErr('');
    try {
      const list = await api<{ id: string; year: number; month: number }[]>(`/companies/${companyId}/payroll/runs?year=${year}`);
      const hit = list.find((r) => r.month === month);
      setRun(hit ? await api<Run>(`/companies/${companyId}/payroll/runs/${hit.id}`) : null);
    } catch (x) { setErr(x instanceof Error ? x.message : 'Failed'); }
  }, [companyId, year, month]);
  useEffect(() => { setRun(undefined); loadRun(); }, [loadRun]);

  const loadRows = useCallback(() => {
    if (!run || !run._count?.details) return setRows([]);
    api<{ items: Row[]; total: number }>(`/companies/${companyId}/payroll/runs/${run.id}/details?page=${page}&pageSize=${pageSize}${search ? `&search=${encodeURIComponent(search)}` : ''}`)
      .then((r) => { setRows(r.items); setTotal(r.total); }).catch((e) => setErr(e.message));
  }, [companyId, run, page, search]);
  useEffect(() => { const t = setTimeout(loadRows, 200); return () => clearTimeout(t); }, [loadRows]);

  const act = async (path: string, body?: object, method = 'POST') => {
    setBusy(true); setErr('');
    try { await api(`/companies/${companyId}/payroll/${path}`, { method, body: body ? JSON.stringify(body) : undefined }); await loadRun(); }
    catch (x) { setErr(x instanceof Error ? x.message : 'Failed'); }
    finally { setBusy(false); }
  };
  const dl = async (path: string) => { setBusy(true); setErr(''); try { await download(path); } catch (x) { setErr(x instanceof Error ? x.message : 'Download failed'); } finally { setBusy(false); } };
  const create = () => act('runs', { year, month });
  const approve = async () => {
    setBusy(true); setErr('');
    try { await api(`/companies/${companyId}/payroll/runs/${run!.id}/approve`, { method: 'POST', body: JSON.stringify({}) }); await loadRun(); }
    catch (x) {
      const msg = x instanceof Error ? x.message : 'Failed';
      if (msg.includes('skipped') && confirm(`${msg}\n\nApprove anyway, excluding those employees?`)) {
        try { await api(`/companies/${companyId}/payroll/runs/${run!.id}/approve`, { method: 'POST', body: JSON.stringify({ acknowledgeSkipped: true }) }); await loadRun(); }
        catch (y) { setErr(y instanceof Error ? y.message : 'Failed'); }
      } else setErr(msg);
    } finally { setBusy(false); }
  };
  const unlock = () => {
    const reason = prompt('Reason for unlocking (min 10 characters). This is recorded in the audit log:');
    if (reason) act(`runs/${run!.id}/unlock`, { reason });
  };

  const st = run?.status;
  const errs = run?.issues?.filter((i) => i.level === 'ERROR') ?? [];
  const warns = run?.issues?.filter((i) => i.level === 'WARNING') ?? [];
  const btn = 'rounded-md px-4 py-1.5 text-sm disabled:opacity-40';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Payroll</h1>
        <select className={inp} value={month} onChange={(e) => { setPage(1); setMonth(+e.target.value); }}>
          {Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>{new Date(2000, i, 1).toLocaleString('en', { month: 'long' })}</option>)}
        </select>
        <input className={`${inp} w-24`} type="number" value={year} onChange={(e) => { setPage(1); setYear(+e.target.value); }} />
      </div>
      {err && <ErrorBox text={err} />}

      {run === undefined && !err && <div className="text-sm text-slate-500">Loading…</div>}
      {run === null && (
        <div className="bg-white border rounded-xl p-6 space-y-3">
          <p className="text-sm text-slate-600">No payroll run for this month yet. Before starting, make sure attendance is finalized and salary is assigned.</p>
          <div className="flex flex-wrap gap-2">
            {can('payroll.process') && <button disabled={busy} onClick={create} className={`${btn} bg-slate-900 text-white`}>Create payroll run</button>}
            {can('attendance.manage') && (
              <button disabled={busy} onClick={() => setQuickImport(true)} className={`${btn} flex items-center gap-1 border bg-white`} title="Just have total days worked per employee, not a daily register? Use this instead.">
                <ListChecks size={14} /> Quick import (days worked)
              </button>
            )}
          </div>
        </div>
      )}

      {run && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <ol className="flex gap-1 text-xs">
              {STEPS.map((s) => <li key={s} className={`px-2 py-1 rounded ${s === st ? 'bg-slate-900 text-white' : STEPS.indexOf(s) < STEPS.indexOf(st ?? '') ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-500'}`}>{s}</li>)}
            </ol>
            <div className="ml-auto flex flex-wrap gap-2">
              {can('reports.export') && (run._count?.details ?? 0) > 0 && <button disabled={busy} onClick={() => dl(`/companies/${companyId}/payslips/${run.id}`)} className={`${btn} border bg-white`}>Payslips (PDF)</button>}
              {can('attendance.manage') && st === 'DRAFT' && (
                <button disabled={busy} onClick={() => setQuickImport(true)} className={`${btn} flex items-center gap-1 border bg-white`} title="Just have total days worked per employee, not a daily register? Use this instead.">
                  <ListChecks size={14} /> Quick import (days worked)
                </button>
              )}
              {can('payroll.process') && (st === 'DRAFT' || st === 'CALCULATED' || st === 'REVIEW') && <button disabled={busy} onClick={() => act(`runs/${run.id}/process`)} className={`${btn} ${st === 'DRAFT' ? 'bg-slate-900 text-white' : 'border bg-white'}`}>{st === 'DRAFT' ? 'Calculate payroll' : 'Recalculate'}</button>}
              {can('payroll.process') && st === 'CALCULATED' && <button disabled={busy} onClick={() => act(`runs/${run.id}/review`)} className={`${btn} bg-slate-900 text-white`}>Send to review</button>}
              {can('payroll.process') && st === 'REVIEW' && <button disabled={busy} onClick={() => act(`runs/${run.id}/back-to-calculated`)} className={`${btn} border bg-white`}>Back to calculated</button>}
              {can('payroll.approve') && st === 'REVIEW' && <button disabled={busy} onClick={approve} className={`${btn} bg-emerald-700 text-white`}>Approve</button>}
              {can('payroll.approve') && st === 'APPROVED' && <button disabled={busy} onClick={() => confirm('Reopen for review? Loan recoveries will be reversed.') && act(`runs/${run.id}/unapprove`)} className={`${btn} border bg-white`}>Reopen review</button>}
              {can('payroll.lock') && st === 'APPROVED' && <button disabled={busy} onClick={() => act(`runs/${run.id}/lock`)} className={`${btn} bg-slate-900 text-white`}>Lock payroll</button>}
              {can('payroll.unlock') && st === 'LOCKED' && <button disabled={busy} onClick={unlock} className={`${btn} border border-red-300 text-red-700 bg-white`}>Unlock…</button>}
              {can('payroll.process') && st === 'DRAFT' && <button disabled={busy} onClick={() => confirm('Delete this draft run?') && act(`runs/${run.id}`, undefined, 'DELETE')} aria-label="Delete run" className="text-slate-400 hover:text-red-600"><Trash2 size={16} /></button>}
            </div>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
            <Card title="Calculated" value={run._count?.details ?? 0} />
            <Card title="Gross" value={num(run.totalGross)} />
            <Card title="Deductions" value={num(run.totalDeductions)} />
            <Card title="Net pay" value={num(run.totalNet)} />
            <Card title="Errors" value={<span className={errs.length ? 'text-red-700' : ''}>{errs.length}</span>} hint="employees skipped" />
            <Card title="Warnings" value={warns.length} />
          </div>

          <div className="flex gap-2">
            {([['register', 'Payroll register'], ['issues', `Issues (${errs.length + warns.length})`], ['inputs', 'Arrears / bonus / other']] as const).map(([k, l]) => (
              <button key={k} onClick={() => setTab(k)} className={`px-3 py-1 rounded-md text-sm ${tab === k ? 'bg-slate-900 text-white' : 'border bg-white'}`}>{l}</button>
            ))}
          </div>

          {tab === 'register' && (
            <div className="space-y-2">
              <input className={`${inp} w-64`} placeholder="Search employee" value={search} onChange={(e) => { setPage(1); setSearch(e.target.value); }} />
              <div className="bg-white border rounded-xl overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-slate-500"><tr>{['Code', 'Name', 'Paid days', 'LOP', 'OT', 'Gross', 'Deductions', 'Net'].map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id} onClick={() => setDrawer(r.employeeId)} className="border-t hover:bg-slate-50 cursor-pointer">
                        <td className="px-4 py-2">{r.employee.code}</td>
                        <td className="px-4 py-2">{r.employee.firstName} {r.employee.lastName ?? ''} {r.hasWarnings && <span title="Has warnings" className="text-amber-600">●</span>}</td>
                        <td className="px-4 py-2">{Number(r.paidDays)}</td><td className="px-4 py-2">{Number(r.lopDays)}</td><td className="px-4 py-2">{Number(r.otHours)}</td>
                        <td className="px-4 py-2">{num(r.gross)}</td><td className="px-4 py-2">{num(r.totalDeductions)}</td><td className="px-4 py-2 font-medium">{num(r.net)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {rows.length === 0 && <Empty text={st === 'DRAFT' ? 'Not calculated yet. Click "Calculate payroll".' : 'No results.'} />}
              </div>
              <div className="flex items-center justify-between text-sm text-slate-600">
                <span>{total} employees</span>
                <div className="flex gap-2">
                  <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="border rounded px-3 py-1 disabled:opacity-40">Prev</button>
                  <button disabled={page * pageSize >= total} onClick={() => setPage(page + 1)} className="border rounded px-3 py-1 disabled:opacity-40">Next</button>
                </div>
              </div>
            </div>
          )}

          {tab === 'issues' && (
            <div className="bg-white border rounded-xl">
              {[...errs, ...warns].length === 0 ? <Empty text="No issues." /> : [...errs, ...warns].map((i, k) => (
                <div key={k} className="px-4 py-2 border-b text-sm flex gap-3">
                  <span className={`text-xs rounded px-1.5 py-0.5 h-fit ${i.level === 'ERROR' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'}`}>{i.level}</span>
                  <span className="text-slate-500 w-16 shrink-0">{i.code}</span><span>{i.message}</span>
                </div>
              ))}
            </div>
          )}

          {tab === 'inputs' && <Inputs companyId={companyId} year={year} month={month} canEdit={can('payroll.process') && (st === 'DRAFT' || st === 'CALCULATED' || st === 'REVIEW')} onChanged={loadRun} />}
        </>
      )}

      {run && drawer && <DetailDrawer companyId={companyId} runId={run.id} employeeId={drawer} canPdf={can('reports.export')} onClose={() => setDrawer(null)} />}
      {quickImport && <QuickImportModal companyId={companyId} year={year} month={month} onClose={() => setQuickImport(false)} onDone={() => { setQuickImport(false); loadRun(); }} />}
    </div>
  );
}

function Inputs({ companyId, year, month, canEdit, onChanged }: { companyId: string; year: number; month: number; canEdit: boolean; onChanged: () => void }) {
  const [items, setItems] = useState<Input[]>([]);
  const [emp, setEmp] = useState<EmpLite | null>(null);
  const [f, setF] = useState({ kind: 'BONUS', name: '', amount: '' });
  const [err, setErr] = useState('');

  const load = useCallback(() => { api<Input[]>(`/companies/${companyId}/payroll/inputs?year=${year}&month=${month}`).then(setItems).catch((e) => setErr(e.message)); }, [companyId, year, month]);
  useEffect(load, [load]);
  const done = () => { load(); onChanged(); };

  const add = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    if (!emp) return setErr('Choose an employee');
    try { await api(`/companies/${companyId}/payroll/inputs`, { method: 'POST', body: JSON.stringify({ employeeId: emp.id, year, month, kind: f.kind, name: f.name, amount: Number(f.amount) }) }); setF({ ...f, name: '', amount: '' }); done(); }
    catch (x) { setErr(x instanceof Error ? x.message : 'Failed'); }
  };
  const del = async (id: string) => { try { await api(`/companies/${companyId}/payroll/inputs/${id}`, { method: 'DELETE' }); done(); } catch (x) { setErr(x instanceof Error ? x.message : 'Failed'); } };

  return (
    <div className="space-y-3">
      {err && <ErrorBox text={err} />}
      {canEdit && (
        <form onSubmit={add} className="bg-white border rounded-xl p-4 flex flex-wrap gap-3 items-end">
          <EmployeePicker companyId={companyId} value={emp} onChange={setEmp} />
          <select className={inp} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            <option value="ARREAR">Arrear</option><option value="BONUS">Bonus</option><option value="INCENTIVE">Incentive</option>
            <option value="OTHER_EARNING">Other earning</option><option value="OTHER_DEDUCTION">Other deduction</option>
          </select>
          <input className={`${inp} w-48`} required placeholder="Description" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <input className={`${inp} w-32`} type="number" step="0.01" required placeholder="Amount" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
          <button className="bg-slate-900 text-white rounded-md px-4 py-1.5 text-sm">Add</button>
          <p className="w-full text-xs text-slate-500">Changing inputs after calculation sends the run back to DRAFT so it must be recalculated.</p>
        </form>
      )}
      <div className="bg-white border rounded-xl">
        {items.length === 0 ? <Empty text="No one-time inputs for this month." /> : items.map((i) => (
          <div key={i.id} className="flex items-center px-4 py-2 border-b text-sm gap-3">
            <span className="w-16 text-slate-500">{i.employee.code}</span><span className="w-32">{i.kind.replace('_', ' ').toLowerCase()}</span><span className="flex-1">{i.name}</span>
            <span className={i.kind === 'OTHER_DEDUCTION' ? 'text-red-700' : ''}>{num(i.amount)}</span>
            {canEdit && <button onClick={() => del(i.id)} aria-label="Delete" className="text-slate-400 hover:text-red-600"><Trash2 size={14} /></button>}
          </div>
        ))}
      </div>
    </div>
  );
}

function DetailDrawer({ companyId, runId, employeeId, canPdf, onClose }: { companyId: string; runId: string; employeeId: string; canPdf: boolean; onClose: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api<Detail>(`/companies/${companyId}/payroll/runs/${runId}/details/${employeeId}`).then(setD).catch((e) => setErr(e.message)); }, [companyId, runId, employeeId]);

  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-black/30" onClick={onClose}>
      <div className="w-full max-w-xl bg-white h-full overflow-y-auto p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center"><h2 className="font-semibold">{d ? `${d.employee.code} · ${d.employee.firstName} ${d.employee.lastName ?? ''}` : 'Payslip breakup'}</h2><button onClick={onClose} className="ml-auto" aria-label="Close"><X size={18} /></button></div>
        {err && <ErrorBox text={err} />}
        {d && (
          <>
            <div className="border rounded-lg text-sm">
              <div className="px-3 py-1.5 bg-slate-50 font-medium">Earnings</div>
              {d.earnings.map((e) => <div key={e.id} className="flex justify-between px-3 py-1.5 border-b"><span>{e.name}</span><span>{num(e.amount)}</span></div>)}
              <div className="flex justify-between px-3 py-1.5 font-medium border-b"><span>Gross</span><span>{num(d.gross)}</span></div>
              <div className="px-3 py-1.5 bg-slate-50 font-medium">Deductions</div>
              {d.deductions.map((e) => <div key={e.id} className="flex justify-between px-3 py-1.5 border-b"><span>{e.name}{e.employerAmount != null && <span className="text-xs text-slate-400"> · employer {num(e.employerAmount)}</span>}</span><span>{num(e.amount)}</span></div>)}
              <div className="flex justify-between px-3 py-1.5 font-medium border-b"><span>Total deductions</span><span>{num(d.totalDeductions)}</span></div>
              <div className="flex justify-between px-3 py-2 font-semibold bg-slate-50"><span>Net pay</span><span>{num(d.net)}</span></div>
            </div>
            {canPdf && <button onClick={() => download(`/companies/${companyId}/payslips/${runId}?employeeId=${employeeId}`).catch((x) => setErr(x.message))} className="border rounded-md px-3 py-1.5 text-sm">Download payslip (PDF)</button>}
            {d.warnings?.length ? <div className="text-xs bg-amber-50 text-amber-800 rounded p-3 space-y-1">{d.warnings.map((w) => <div key={w}>{w}</div>)}</div> : null}
            <details className="text-xs">
              <summary className="cursor-pointer text-slate-600">Calculation trace · engine v{d.formulaVersion}</summary>
              <pre className="mt-2 bg-slate-50 rounded p-3 overflow-x-auto">{JSON.stringify(d.calculation.trace, null, 2)}</pre>
            </details>
          </>
        )}
      </div>
    </div>
  );
}
