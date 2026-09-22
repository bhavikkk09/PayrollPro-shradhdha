import { useCallback, useEffect, useMemo, useState } from 'react';
import { ListChecks, Upload } from 'lucide-react';
import { api, type Session } from '../api';
import { parseAttendanceFile, parseQuickAttendanceFile } from '../components/parseSheet';
import { Empty, ErrorBox } from '../components/ui';

type Status = 'PRESENT' | 'ABSENT' | 'PAID_LEAVE' | 'UNPAID_LEAVE' | 'WEEKLY_OFF' | 'HOLIDAY' | 'HALF_DAY' | 'LOP';
interface Summary { present: number; absent: number; paidLeave: number; unpaidLeave: number; lopDays: number; otHours: number; paidDays: number; unmarked: number }
interface Row { id: string; code: string; name: string; doj: string; dol: string | null; days: Record<string, { status: Status; otHours: number }>; summary: Summary }
interface Grid { total: number; finalized: boolean; holidays: string[]; weeklyOff: string[]; otEnabled: boolean; items: Row[] }

const SHORT: Record<Status, string> = { PRESENT: 'P', ABSENT: 'A', PAID_LEAVE: 'PL', UNPAID_LEAVE: 'UL', WEEKLY_OFF: 'WO', HOLIDAY: 'H', HALF_DAY: 'HD', LOP: 'LOP' };
const TONE: Record<Status, string> = {
  PRESENT: 'bg-emerald-100 text-emerald-800', ABSENT: 'bg-red-100 text-red-800', PAID_LEAVE: 'bg-sky-100 text-sky-800', UNPAID_LEAVE: 'bg-orange-100 text-orange-800',
  WEEKLY_OFF: 'bg-slate-100 text-slate-500', HOLIDAY: 'bg-violet-100 text-violet-700', HALF_DAY: 'bg-amber-100 text-amber-800', LOP: 'bg-rose-100 text-rose-800',
};
const CYCLE: Status[] = ['PRESENT', 'ABSENT', 'PAID_LEAVE', 'UNPAID_LEAVE', 'HALF_DAY', 'LOP'];
const DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const key = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

export default function Attendance({ companyId, session }: { companyId: string; session: Session }) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [grid, setGrid] = useState<Grid | null>(null);
  const [pending, setPending] = useState<Record<string, { employeeId: string; date: string; status: Status; otHours?: number }>>({});
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [modal, setModal] = useState<'import' | 'quickImport' | 'finalize' | null>(null);
  const canManage = session.user.permissions.includes('attendance.manage');
  const firm = session.user.type !== 'CLIENT'; // finalizing and reopening a month is the consultant's job
  const n = new Date(year, month, 0).getDate();
  const pageSize = 25;

  const load = useCallback(() => {
    setErr('');
    api<Grid>(`/companies/${companyId}/attendance?year=${year}&month=${month}&page=${page}&pageSize=${pageSize}${search ? `&search=${encodeURIComponent(search)}` : ''}`)
      .then((g) => { setGrid(g); setPending({}); }).catch((e) => setErr(e.message));
  }, [companyId, year, month, page, search]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  const off = useMemo(() => new Set(grid?.weeklyOff ?? []), [grid]);
  const hol = useMemo(() => new Set(grid?.holidays ?? []), [grid]);
  const auto = (d: string): Status | null => (off.has(DOW[new Date(`${d}T00:00:00Z`).getUTCDay()]) ? 'WEEKLY_OFF' : hol.has(d) ? 'HOLIDAY' : null);
  const inWindow = (r: Row, d: string) => d >= r.doj && (!r.dol || d <= r.dol);
  const current = (r: Row, d: string): Status | null => pending[`${r.id}|${d}`]?.status ?? r.days[d]?.status ?? auto(d);

  const click = (r: Row, d: string) => {
    if (!canManage || grid?.finalized || !inWindow(r, d)) return;
    const cur = current(r, d);
    const next = cur && CYCLE.includes(cur) ? CYCLE[(CYCLE.indexOf(cur) + 1) % CYCLE.length] : 'PRESENT';
    setPending({ ...pending, [`${r.id}|${d}`]: { employeeId: r.id, date: d, status: next } });
  };
  const markPresent = () => {
    if (!grid) return;
    const p = { ...pending };
    for (const r of grid.items) for (let d = 1; d <= n; d++) {
      const k = key(year, month, d);
      if (inWindow(r, k) && !current(r, k)) p[`${r.id}|${k}`] = { employeeId: r.id, date: k, status: 'PRESENT' };
    }
    setPending(p);
  };
  const save = async () => {
    setErr(''); setMsg('');
    try {
      const r = await api<{ saved: number }>(`/companies/${companyId}/attendance`, { method: 'PUT', body: JSON.stringify({ entries: Object.values(pending) }) });
      setMsg(`${r.saved} entries saved`); load();
    } catch (x) { setErr(x instanceof Error ? x.message : 'Save failed'); }
  };
  const reopen = async () => {
    if (!confirm('Reopen this month for editing?')) return;
    try { await api(`/companies/${companyId}/attendance/reopen`, { method: 'POST', body: JSON.stringify({ year, month }) }); load(); }
    catch (x) { setErr(x instanceof Error ? x.message : 'Failed'); }
  };
  const nPending = Object.keys(pending).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Attendance</h1>
        <select className="border rounded-md px-2 py-1.5 text-sm" value={month} onChange={(e) => { setPage(1); setMonth(+e.target.value); }}>
          {Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>{new Date(2000, i, 1).toLocaleString('en', { month: 'long' })}</option>)}
        </select>
        <input className="border rounded-md px-2 py-1.5 text-sm w-24" type="number" value={year} onChange={(e) => { setPage(1); setYear(+e.target.value); }} />
        <input className="border rounded-md px-3 py-1.5 text-sm w-48" placeholder="Search employee" value={search} onChange={(e) => { setPage(1); setSearch(e.target.value); }} />
        {grid?.finalized && <span className="text-xs bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-full px-2 py-0.5">Finalized</span>}
        <div className="ml-auto flex flex-wrap gap-2">
          {canManage && !grid?.finalized && <>
            <button onClick={markPresent} className="border rounded-md px-3 py-1.5 text-sm bg-white">Mark unmarked as present</button>
            <button onClick={() => setModal('import')} className="flex items-center gap-1 border rounded-md px-3 py-1.5 text-sm bg-white"><Upload size={14} /> Import</button>
            <button onClick={() => setModal('quickImport')} className="flex items-center gap-1 border rounded-md px-3 py-1.5 text-sm bg-white" title="Just have total days worked per employee, not a daily register? Use this instead."><ListChecks size={14} /> Quick import (days worked)</button>
            {firm && <button onClick={() => setModal('finalize')} className="border rounded-md px-3 py-1.5 text-sm bg-white">Finalize month</button>}
            <button disabled={!nPending} onClick={save} className="bg-slate-900 text-white rounded-md px-4 py-1.5 text-sm disabled:opacity-40">Save{nPending ? ` (${nPending})` : ''}</button>
          </>}
          {canManage && firm && grid?.finalized && <button onClick={reopen} className="border rounded-md px-3 py-1.5 text-sm bg-white">Reopen month</button>}
        </div>
      </div>
      {err && <ErrorBox text={err} />}
      {msg && <div className="text-sm text-emerald-700">{msg}</div>}

      <div className="bg-white border rounded-xl overflow-x-auto">
        <table className="text-xs">
          <thead className="text-slate-500"><tr>
            <th className="sticky left-0 bg-white px-3 py-2 text-left min-w-40">Employee</th>
            {Array.from({ length: n }, (_, i) => <th key={i} className="px-0.5 py-2 w-7 font-medium">{i + 1}</th>)}
            {['P', 'A', 'Leave', 'LOP', 'OT', 'Paid'].map((h) => <th key={h} className="px-2 py-2 font-medium">{h}</th>)}
          </tr></thead>
          <tbody>
            {grid?.items.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="sticky left-0 bg-white px-3 py-1.5 whitespace-nowrap"><span className="text-slate-400">{r.code}</span> {r.name}</td>
                {Array.from({ length: n }, (_, i) => {
                  const d = key(year, month, i + 1);
                  const st = inWindow(r, d) ? current(r, d) : null;
                  const dirty = !!pending[`${r.id}|${d}`];
                  return (
                    <td key={i} className="p-0.5">
                      <button
                        type="button" onClick={() => click(r, d)} disabled={!inWindow(r, d)} title={st ?? 'Not marked'}
                        className={`w-6 h-6 rounded text-[10px] ${st ? TONE[st] : inWindow(r, d) ? 'border border-dashed border-slate-300' : 'bg-slate-50'} ${dirty ? 'ring-2 ring-slate-900' : ''}`}
                      >{st ? SHORT[st] : ''}</button>
                    </td>
                  );
                })}
                <td className="px-2">{r.summary.present}</td><td className="px-2">{r.summary.absent}</td>
                <td className="px-2">{r.summary.paidLeave + r.summary.unpaidLeave}</td><td className="px-2">{r.summary.lopDays}</td>
                <td className="px-2">{r.summary.otHours}</td><td className="px-2 font-medium">{r.summary.paidDays}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!grid && !err && <Empty text="Loading…" />}
        {grid && grid.items.length === 0 && <Empty text="No employees for this month." />}
      </div>
      <div className="text-xs text-slate-500">Click a day to cycle P → A → PL → UL → HD → LOP. Weekly offs and holidays fill automatically. Totals refresh after saving.</div>

      {grid && (
        <div className="flex items-center justify-between text-sm text-slate-600">
          <span>{grid.total} employees</span>
          <div className="flex gap-2">
            <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="border rounded px-3 py-1 disabled:opacity-40">Prev</button>
            <button disabled={page * pageSize >= grid.total} onClick={() => setPage(page + 1)} className="border rounded px-3 py-1 disabled:opacity-40">Next</button>
          </div>
        </div>
      )}

      {modal === 'import' && <ImportModal companyId={companyId} onClose={() => setModal(null)} onDone={() => { setModal(null); load(); }} />}
      {modal === 'quickImport' && <QuickImportModal companyId={companyId} year={year} month={month} onClose={() => setModal(null)} onDone={() => { setModal(null); load(); }} />}
      {modal === 'finalize' && <FinalizeModal companyId={companyId} year={year} month={month} onClose={() => setModal(null)} onDone={() => { setModal(null); load(); }} />}
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-30 bg-black/30 grid place-items-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex"><h2 className="font-semibold">{title}</h2><button onClick={onClose} className="ml-auto text-slate-500">Close</button></div>
        {children}
      </div>
    </div>
  );
}

interface Validation { jobId: string; totalRows: number; validRows: number; errorRows: number; errors: { row: number; message: string }[]; preview: { employeeCode: string; date: string; status: string; otHours: number }[] }

function ImportModal({ companyId, onClose, onDone }: { companyId: string; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState<Validation | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true); setErr(''); setV(null);
    try {
      const rows = await parseAttendanceFile(f);
      setV(await api<Validation>(`/companies/${companyId}/attendance/import/validate`, { method: 'POST', body: JSON.stringify({ fileName: f.name, rows }) }));
    } catch (x) { setErr(x instanceof Error ? x.message : 'Could not read file'); }
    finally { setBusy(false); }
  };
  const confirm = async () => {
    setBusy(true); setErr('');
    try { await api(`/companies/${companyId}/attendance/import/${v!.jobId}/confirm`, { method: 'POST', body: JSON.stringify({ skipInvalid: v!.errorRows > 0 }) }); onDone(); }
    catch (x) { setErr(x instanceof Error ? x.message : 'Import failed'); setBusy(false); }
  };

  return (
    <Modal title="Import attendance" onClose={onClose}>
      <p className="text-sm text-slate-600">Upload .xlsx or .csv with columns: <b>Employee Code, Date, Attendance Status, OT Hours</b>. Status: P, A, PL, UL, WO, H, HD, LOP. Nothing is saved until you confirm.</p>
      <input type="file" accept=".xlsx,.csv" onChange={(e) => pick(e.target.files?.[0])} disabled={busy} />
      {err && <ErrorBox text={err} />}
      {busy && !v && <div className="text-sm text-slate-500">Reading and validating…</div>}
      {v && (
        <div className="space-y-3">
          <div className="text-sm">{v.totalRows} rows · <span className="text-emerald-700">{v.validRows} valid</span> · <span className={v.errorRows ? 'text-red-700' : ''}>{v.errorRows} with errors</span></div>
          {v.errors.length > 0 && (
            <div className="border rounded-md max-h-48 overflow-y-auto text-xs">
              {v.errors.map((e, i) => <div key={i} className="px-3 py-1 border-b text-red-700">{e.row ? `Row ${e.row}: ` : ''}{e.message}</div>)}
            </div>
          )}
          {v.preview.length > 0 && (
            <table className="text-xs w-full border"><thead className="bg-slate-50"><tr><th className="p-1 text-left">Code</th><th className="p-1 text-left">Date</th><th className="p-1 text-left">Status</th><th className="p-1 text-left">OT</th></tr></thead>
              <tbody>{v.preview.map((r, i) => <tr key={i} className="border-t"><td className="p-1">{r.employeeCode}</td><td className="p-1">{r.date}</td><td className="p-1">{r.status}</td><td className="p-1">{r.otHours}</td></tr>)}</tbody></table>
          )}
          <button disabled={busy || v.validRows === 0} onClick={confirm} className="bg-slate-900 text-white rounded-md px-4 py-2 text-sm disabled:opacity-40">
            {v.errorRows ? `Import ${v.validRows} valid rows only` : `Confirm import (${v.validRows} rows)`}
          </button>
        </div>
      )}
    </Modal>
  );
}

interface QuickValidation { jobId: string; totalRows: number; validRows: number; errorRows: number; errors: { row: number; message: string }[]; preview: { employeeCode: string; paidDays: number }[] }

function QuickImportModal({ companyId, year, month, onClose, onDone }: { companyId: string; year: number; month: number; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState<QuickValidation | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true); setErr(''); setV(null);
    try {
      const rows = await parseQuickAttendanceFile(f);
      setV(await api<QuickValidation>(`/companies/${companyId}/attendance/quick-import/validate`, { method: 'POST', body: JSON.stringify({ fileName: f.name, year, month, rows }) }));
    } catch (x) { setErr(x instanceof Error ? x.message : 'Could not read file'); }
    finally { setBusy(false); }
  };
  const confirm = async () => {
    setBusy(true); setErr('');
    try { await api(`/companies/${companyId}/attendance/quick-import/${v!.jobId}/confirm`, { method: 'POST', body: JSON.stringify({ skipInvalid: v!.errorRows > 0 }) }); onDone(); }
    catch (x) { setErr(x instanceof Error ? x.message : 'Import failed'); setBusy(false); }
  };

  return (
    <Modal title={`Quick import: days worked (${month}/${year})`} onClose={onClose}>
      <p className="text-sm text-slate-600">
        For when there is no daily register - just how many days each employee worked. Upload .xlsx or .csv with columns:{' '}
        <b>Employee Code, Days Worked</b> (optionally <b>OT Hours</b>). Weekly offs and holidays are still paid automatically;
        salary itself always comes from each employee's assigned salary, not this file. Nothing is saved until you confirm.
      </p>
      <input type="file" accept=".xlsx,.csv" onChange={(e) => pick(e.target.files?.[0])} disabled={busy} />
      {err && <ErrorBox text={err} />}
      {busy && !v && <div className="text-sm text-slate-500">Reading and validating…</div>}
      {v && (
        <div className="space-y-3">
          <div className="text-sm">{v.totalRows} rows · <span className="text-emerald-700">{v.validRows} valid</span> · <span className={v.errorRows ? 'text-red-700' : ''}>{v.errorRows} with errors</span></div>
          {v.errors.length > 0 && (
            <div className="border rounded-md max-h-48 overflow-y-auto text-xs">
              {v.errors.map((e, i) => <div key={i} className="px-3 py-1 border-b text-red-700">{e.row ? `Row ${e.row}: ` : ''}{e.message}</div>)}
            </div>
          )}
          {v.preview.length > 0 && (
            <table className="text-xs w-full border"><thead className="bg-slate-50"><tr><th className="p-1 text-left">Code</th><th className="p-1 text-left">Days worked</th></tr></thead>
              <tbody>{v.preview.map((r, i) => <tr key={i} className="border-t"><td className="p-1">{r.employeeCode}</td><td className="p-1">{r.paidDays}</td></tr>)}</tbody></table>
          )}
          <button disabled={busy || v.validRows === 0} onClick={confirm} className="bg-slate-900 text-white rounded-md px-4 py-2 text-sm disabled:opacity-40">
            {v.errorRows ? `Import ${v.validRows} valid rows only` : `Confirm import (${v.validRows} employees)`}
          </button>
        </div>
      )}
    </Modal>
  );
}

function FinalizeModal({ companyId, year, month, onClose, onDone }: { companyId: string; year: number; month: number; onClose: () => void; onDone: () => void }) {
  const [as, setAs] = useState('');
  const [err, setErr] = useState('');
  const go = async () => {
    setErr('');
    try { await api(`/companies/${companyId}/attendance/finalize`, { method: 'POST', body: JSON.stringify({ year, month, ...(as ? { unmarkedAs: as } : {}) }) }); onDone(); }
    catch (x) { setErr(x instanceof Error ? x.message : 'Failed'); }
  };
  return (
    <Modal title={`Finalize ${month}/${year}`} onClose={onClose}>
      <p className="text-sm text-slate-600">Finalizing locks attendance for payroll. It fails if working days are unmarked, unless you choose how to treat them.</p>
      <select className="border rounded-md px-2 py-1.5 text-sm" value={as} onChange={(e) => setAs(e.target.value)}>
        <option value="">Require every day to be marked</option>
        <option value="PRESENT">Treat unmarked days as Present</option>
        <option value="ABSENT">Treat unmarked days as Absent</option>
      </select>
      {err && <ErrorBox text={err} />}
      <div><button onClick={go} className="bg-slate-900 text-white rounded-md px-4 py-2 text-sm">Finalize</button></div>
    </Modal>
  );
}
