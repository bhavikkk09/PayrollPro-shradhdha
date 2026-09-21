import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Trash2 } from 'lucide-react';
import { api, type Session } from '../api';
import { Badge, Empty, ErrorBox } from '../components/ui';
import { money } from './Salary';

interface Task { id: string; companyId: string; module: string; name: string; dueDate: string; status: string; assignedTo: string | null; assignedName: string | null; completedAt: string | null; challanRef: string | null; company: { name: string; code: string } }
interface Reg { id: string; module: string; number: string; state: string | null }
interface Summary { runStatus: string | null; final?: boolean; modules: { module: string; employees: number; employee: number; employer: number; total: number }[] }

const MODULES = ['PF', 'ESI', 'PT', 'LWF', 'TDS', 'BONUS', 'GRATUITY', 'MINIMUM_WAGE', 'OTHER'];
const inp = 'border rounded-md px-2 py-1.5 text-sm';
type Tab = 'calendar' | 'summary' | 'registrations';

/** Works across all companies (central calendar) or for the selected company. */
export default function Compliance({ companyId, session }: { companyId: string; session: Session }) {
  const [tab, setTab] = useState<Tab>('calendar');
  const single = companyId !== 'ALL';
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Compliance</h1>
      <div className="flex gap-2">
        {(['calendar', ...(single ? ['summary', 'registrations'] : [])] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`px-3 py-1 rounded-md text-sm capitalize ${tab === t ? 'bg-slate-900 text-white' : 'border bg-white'}`}>{t}</button>
        ))}
      </div>
      {tab === 'calendar' && <Calendar companyId={companyId} session={session} />}
      {tab === 'summary' && single && <SummaryTab companyId={companyId} />}
      {tab === 'registrations' && single && <Registrations companyId={companyId} canManage={session.user.permissions.includes('compliance.manage')} />}
    </div>
  );
}

function Calendar({ companyId, session }: { companyId: string; session: Session }) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [status, setStatus] = useState('');
  const [items, setItems] = useState<Task[]>([]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [assign, setAssign] = useState<{ task: string; users: { id: string; name: string }[] } | null>(null);
  const can = session.user.permissions.includes('compliance.manage');

  const load = useCallback(() => {
    const qs = new URLSearchParams({ year: String(year), month: String(month), pageSize: '100' });
    if (companyId !== 'ALL') qs.set('companyId', companyId);
    if (status) qs.set('status', status);
    api<{ items: Task[] }>(`/compliance/calendar?${qs}`).then((r) => setItems(r.items)).catch((e) => setErr(e.message));
  }, [companyId, year, month, status]);
  useEffect(load, [load]);

  const wrap = async (fn: () => Promise<unknown>, ok?: string) => {
    setErr(''); setMsg('');
    try { await fn(); if (ok) setMsg(ok); load(); } catch (x) { setErr(x instanceof Error ? x.message : 'Failed'); }
  };
  const complete = (t: Task) => {
    const ref = prompt(`Challan / acknowledgement number for ${t.name} (optional):`, '');
    if (ref !== null) wrap(() => api(`/compliance/tasks/${t.id}/complete`, { method: 'POST', body: JSON.stringify({ challanRef: ref || undefined }) }));
  };
  const openAssign = async (t: Task) => {
    try { setAssign({ task: t.id, users: await api(`/compliance/tasks/${t.id}/assignees`) }); } catch (x) { setErr(x instanceof Error ? x.message : 'Failed'); }
  };
  const generate = () => wrap(async () => {
    const r = await api<{ created: string[]; skipped: { module: string; reason: string }[] }>(`/companies/${companyId}/compliance/tasks/generate`, { method: 'POST', body: JSON.stringify({ year, month }) });
    setMsg(`Created: ${r.created.join(', ') || 'none'}. ${r.skipped.filter((s) => s.reason !== 'Already generated').map((s) => `${s.module}: ${s.reason}`).join(' · ')}`);
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs text-slate-500">Due in</span>
        <select className={inp} value={month} onChange={(e) => setMonth(+e.target.value)}>
          {Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>{new Date(2000, i, 1).toLocaleString('en', { month: 'long' })}</option>)}
        </select>
        <input className={`${inp} w-24`} type="number" value={year} onChange={(e) => setYear(+e.target.value)} />
        <select className={inp} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All status</option>{['UPCOMING', 'DUE_SOON', 'PENDING', 'COMPLETED', 'OVERDUE'].map((s) => <option key={s}>{s}</option>)}
        </select>
        {can && companyId !== 'ALL' && <button onClick={generate} className="ml-auto border rounded-md px-3 py-1.5 text-sm bg-white">Generate tasks for the previous month</button>}
      </div>
      {err && <ErrorBox text={err} />}{msg && <div className="text-sm text-slate-700">{msg}</div>}

      <div className="bg-white border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-slate-500"><tr>{['Compliance', 'Company', 'Due date', 'Status', 'Assigned', 'Completed', ''].map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr></thead>
          <tbody>
            {items.map((t) => (
              <tr key={t.id} className="border-t">
                <td className="px-4 py-2">{t.name}</td><td className="px-4 py-2">{t.company.name}</td><td className="px-4 py-2">{t.dueDate.slice(0, 10)}</td>
                <td className="px-4 py-2"><Badge value={t.status} /></td>
                <td className="px-4 py-2">{t.assignedName ?? '—'}</td>
                <td className="px-4 py-2 text-xs">{t.completedAt ? `${t.completedAt.slice(0, 10)}${t.challanRef ? ` · ${t.challanRef}` : ''}` : '—'}</td>
                <td className="px-4 py-2 text-right whitespace-nowrap space-x-2">
                  {can && t.status !== 'COMPLETED' && <><button className="text-slate-600" onClick={() => openAssign(t)}>Assign</button><button className="text-emerald-700" onClick={() => complete(t)}>Complete</button></>}
                  {can && t.status === 'COMPLETED' && <button className="text-slate-500" onClick={() => wrap(() => api(`/compliance/tasks/${t.id}/reopen`, { method: 'POST' }))}>Reopen</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {items.length === 0 && <Empty text="Nothing due in this period." />}
      </div>

      {assign && (
        <div className="fixed inset-0 z-30 bg-black/30 grid place-items-center p-4" onClick={() => setAssign(null)}>
          <div className="bg-white rounded-xl p-5 w-full max-w-sm space-y-2" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-semibold">Assign to</h2>
            <button className="block w-full text-left px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-50" onClick={() => wrap(() => api(`/compliance/tasks/${assign.task}/assign`, { method: 'POST', body: JSON.stringify({}) })).then(() => setAssign(null))}>Unassigned</button>
            {assign.users.map((u) => <button key={u.id} className="block w-full text-left px-3 py-1.5 text-sm hover:bg-slate-50" onClick={() => wrap(() => api(`/compliance/tasks/${assign.task}/assign`, { method: 'POST', body: JSON.stringify({ userId: u.id }) })).then(() => setAssign(null))}>{u.name}</button>)}
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryTab({ companyId }: { companyId: string }) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [s, setS] = useState<Summary | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api<Summary>(`/companies/${companyId}/compliance/summary?year=${year}&month=${month}`).then(setS).catch((e) => setErr(e.message)); }, [companyId, year, month]);

  return (
    <div className="space-y-3">
      <div className="flex gap-3 items-center">
        <select className={inp} value={month} onChange={(e) => setMonth(+e.target.value)}>{Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>{new Date(2000, i, 1).toLocaleString('en', { month: 'long' })}</option>)}</select>
        <input className={`${inp} w-24`} type="number" value={year} onChange={(e) => setYear(+e.target.value)} />
        {s?.runStatus && <Badge value={s.runStatus === 'APPROVED' || s.runStatus === 'LOCKED' ? 'Completed' : 'In Progress'} />}
      </div>
      {err && <ErrorBox text={err} />}
      {s && !s.final && s.runStatus && <div className="text-xs bg-amber-50 text-amber-800 rounded p-2">Payroll for this month is {s.runStatus}; figures are provisional until it is approved.</div>}
      <div className="bg-white border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-slate-500"><tr>{['Module', 'Employees', 'Employee share', 'Employer share', 'Total to pay'].map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr></thead>
          <tbody>{s?.modules.map((m) => <tr key={m.module} className="border-t"><td className="px-4 py-2 font-medium">{m.module}</td><td className="px-4 py-2">{m.employees}</td><td className="px-4 py-2">{money(m.employee)}</td><td className="px-4 py-2">{money(m.employer)}</td><td className="px-4 py-2 font-medium">{money(m.total)}</td></tr>)}</tbody>
        </table>
        {s && s.modules.length === 0 && <Empty text={s.runStatus ? 'No statutory deductions in this payroll.' : 'No payroll run for this month.'} />}
      </div>
    </div>
  );
}

function Registrations({ companyId, canManage }: { companyId: string; canManage: boolean }) {
  const [rows, setRows] = useState<Reg[]>([]);
  const [f, setF] = useState({ module: 'PF', number: '', state: '' });
  const [err, setErr] = useState('');
  const load = useCallback(() => { api<Reg[]>(`/companies/${companyId}/compliance/registrations`).then(setRows).catch((e) => setErr(e.message)); }, [companyId]);
  useEffect(load, [load]);

  const add = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    try { await api(`/companies/${companyId}/compliance/registrations`, { method: 'PUT', body: JSON.stringify({ module: f.module, number: f.number, state: f.state || undefined }) }); setF({ ...f, number: '' }); load(); }
    catch (x) { setErr(x instanceof Error ? x.message : 'Failed'); }
  };
  const del = async (id: string) => { try { await api(`/companies/${companyId}/compliance/registrations/${id}`, { method: 'DELETE' }); load(); } catch (x) { setErr(x instanceof Error ? x.message : 'Failed'); } };

  return (
    <div className="space-y-3">
      {err && <ErrorBox text={err} />}
      {canManage && (
        <form onSubmit={add} className="bg-white border rounded-xl p-4 flex flex-wrap gap-3 items-end">
          <select className={inp} value={f.module} onChange={(e) => setF({ ...f, module: e.target.value })}>{MODULES.map((m) => <option key={m}>{m}</option>)}</select>
          <input className={`${inp} w-56`} required placeholder="Registration number" value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} />
          <input className={`${inp} w-40`} placeholder="State" value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })} />
          <button className="bg-slate-900 text-white rounded-md px-4 py-1.5 text-sm">Add</button>
        </form>
      )}
      <div className="bg-white border rounded-xl">
        {rows.length === 0 ? <Empty text="No registrations recorded." /> : rows.map((r) => (
          <div key={r.id} className="flex items-center px-4 py-2 border-b text-sm gap-4">
            <span className="w-24 font-medium">{r.module}</span><span className="flex-1">{r.number}</span><span className="text-slate-500">{r.state ?? ''}</span>
            {canManage && <button aria-label="Delete" onClick={() => del(r.id)} className="text-slate-400 hover:text-red-600"><Trash2 size={14} /></button>}
          </div>
        ))}
      </div>
    </div>
  );
}
