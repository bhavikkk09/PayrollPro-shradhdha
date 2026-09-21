import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, type Session } from '../api';
import EmployeePicker, { type EmpLite } from '../components/EmployeePicker';
import { Badge, Empty, ErrorBox } from '../components/ui';

interface LType { id: string; code: string; name: string; paid: boolean; encashable: boolean }
interface Req { id: string; fromDate: string; toDate: string; days: string; status: string; reason?: string; employee: { code: string; firstName: string; lastName?: string }; leaveType: { code: string } }
interface Bal { leaveTypeId: string; code: string; name: string; balance: number; encashable: boolean }

type Tab = 'requests' | 'balances' | 'setup';
const inp = 'border rounded-md px-2 py-1.5 text-sm';
const today = () => new Date().toISOString().slice(0, 10);

export default function Leave({ companyId, session }: { companyId: string; session: Session }) {
  const [tab, setTab] = useState<Tab>('requests');
  const can = (p: string) => session.user.permissions.includes(p);
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Leave</h1>
      <div className="flex gap-2">
        {(['requests', 'balances', 'setup'] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`px-3 py-1 rounded-md text-sm capitalize ${tab === t ? 'bg-slate-900 text-white' : 'border bg-white'}`}>{t}</button>
        ))}
      </div>
      {tab === 'requests' && <Requests companyId={companyId} canManage={can('leave.manage')} canApprove={can('leave.approve')} />}
      {tab === 'balances' && <Balances companyId={companyId} canManage={can('leave.manage')} />}
      {tab === 'setup' && <Setup companyId={companyId} canManage={can('leave.manage')} />}
    </div>
  );
}

function useTypes(companyId: string) {
  const [types, setTypes] = useState<LType[]>([]);
  const reload = useCallback(() => { api<LType[]>(`/companies/${companyId}/leave/types`).then(setTypes).catch(() => setTypes([])); }, [companyId]);
  useEffect(reload, [reload]);
  return { types, reload };
}

function Requests({ companyId, canManage, canApprove }: { companyId: string; canManage: boolean; canApprove: boolean }) {
  const { types } = useTypes(companyId);
  const [items, setItems] = useState<Req[]>([]);
  const [status, setStatus] = useState('PENDING');
  const [err, setErr] = useState('');
  const [emp, setEmp] = useState<EmpLite | null>(null);
  const [f, setF] = useState({ leaveTypeId: '', fromDate: '', toDate: '', reason: '' });

  const load = useCallback(() => {
    api<{ items: Req[] }>(`/companies/${companyId}/leave/requests?pageSize=50${status ? `&status=${status}` : ''}`).then((r) => setItems(r.items)).catch((e) => setErr(e.message));
  }, [companyId, status]);
  useEffect(load, [load]);

  const act = async (id: string, what: 'approve' | 'reject' | 'cancel') => {
    setErr('');
    try { await api(`/companies/${companyId}/leave/requests/${id}/${what}`, { method: 'POST' }); load(); }
    catch (x) { setErr(x instanceof Error ? x.message : 'Failed'); }
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    if (!emp) return setErr('Choose an employee');
    try {
      await api(`/companies/${companyId}/leave/requests`, { method: 'POST', body: JSON.stringify({ employeeId: emp.id, ...f, reason: f.reason || undefined }) });
      setF({ leaveTypeId: '', fromDate: '', toDate: '', reason: '' }); load();
    } catch (x) { setErr(x instanceof Error ? x.message : 'Failed'); }
  };

  return (
    <div className="space-y-4">
      {err && <ErrorBox text={err} />}
      {canManage && (
        <form onSubmit={submit} className="bg-white border rounded-xl p-4 flex flex-wrap gap-3 items-end">
          <EmployeePicker companyId={companyId} value={emp} onChange={setEmp} />
          <select className={inp} required value={f.leaveTypeId} onChange={(e) => setF({ ...f, leaveTypeId: e.target.value })}>
            <option value="">Leave type</option>{types.map((t) => <option key={t.id} value={t.id}>{t.code} · {t.name}</option>)}
          </select>
          <input className={inp} type="date" required value={f.fromDate} onChange={(e) => setF({ ...f, fromDate: e.target.value })} />
          <input className={inp} type="date" required value={f.toDate} onChange={(e) => setF({ ...f, toDate: e.target.value })} />
          <input className={`${inp} w-48`} placeholder="Reason (optional)" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
          <button className="bg-slate-900 text-white rounded-md px-4 py-1.5 text-sm">Request</button>
        </form>
      )}
      <select className={inp} value={status} onChange={(e) => setStatus(e.target.value)}>
        <option value="">All</option>{['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'].map((s) => <option key={s}>{s}</option>)}
      </select>
      <div className="bg-white border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-slate-500"><tr>{['Employee', 'Type', 'From', 'To', 'Days', 'Status', ''].map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr></thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="px-4 py-2">{r.employee.code} · {r.employee.firstName} {r.employee.lastName ?? ''}</td>
                <td className="px-4 py-2">{r.leaveType.code}</td><td className="px-4 py-2">{r.fromDate.slice(0, 10)}</td><td className="px-4 py-2">{r.toDate.slice(0, 10)}</td>
                <td className="px-4 py-2">{Number(r.days)}</td><td className="px-4 py-2"><Badge value={r.status} /></td>
                <td className="px-4 py-2 text-right space-x-2 whitespace-nowrap">
                  {canApprove && r.status === 'PENDING' && <><button onClick={() => act(r.id, 'approve')} className="text-emerald-700">Approve</button><button onClick={() => act(r.id, 'reject')} className="text-red-700">Reject</button></>}
                  {canManage && (r.status === 'PENDING' || r.status === 'APPROVED') && <button onClick={() => act(r.id, 'cancel')} className="text-slate-500">Cancel</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {items.length === 0 && <Empty text="No leave requests." />}
      </div>
    </div>
  );
}

function Balances({ companyId, canManage }: { companyId: string; canManage: boolean }) {
  const { types } = useTypes(companyId);
  const [emp, setEmp] = useState<EmpLite | null>(null);
  const [year, setYear] = useState(new Date().getFullYear());
  const [rows, setRows] = useState<Bal[]>([]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [f, setF] = useState({ kind: 'opening', leaveTypeId: '', days: '', note: '' });

  const load = useCallback(() => {
    if (!emp) return setRows([]);
    api<Bal[]>(`/companies/${companyId}/leave/balances?employeeId=${emp.id}&year=${year}`).then(setRows).catch((e) => setErr(e.message));
  }, [companyId, emp, year]);
  useEffect(load, [load]);

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(''); setMsg('');
    if (!emp) return setErr('Choose an employee');
    const days = Number(f.days);
    const date = year === new Date().getFullYear() ? today() : `${year}-12-31`;
    try {
      if (f.kind === 'opening') await api(`/companies/${companyId}/leave/opening`, { method: 'POST', body: JSON.stringify({ employeeId: emp.id, leaveTypeId: f.leaveTypeId, year, days }) });
      else if (f.kind === 'adjust') await api(`/companies/${companyId}/leave/adjust`, { method: 'POST', body: JSON.stringify({ employeeId: emp.id, leaveTypeId: f.leaveTypeId, date, days, note: f.note }) });
      else await api(`/companies/${companyId}/leave/encash`, { method: 'POST', body: JSON.stringify({ employeeId: emp.id, leaveTypeId: f.leaveTypeId, date, days, note: f.note || undefined }) });
      setMsg('Saved'); setF({ ...f, days: '', note: '' }); load();
    } catch (x) { setErr(x instanceof Error ? x.message : 'Failed'); }
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-3 items-center">
        <EmployeePicker companyId={companyId} value={emp} onChange={setEmp} />
        <input className={`${inp} w-24`} type="number" value={year} onChange={(e) => setYear(+e.target.value)} />
      </div>
      {err && <ErrorBox text={err} />}{msg && <div className="text-sm text-emerald-700">{msg}</div>}
      <div className="bg-white border rounded-xl">
        {!emp ? <Empty text="Choose an employee to see balances." /> : rows.map((b) => (
          <div key={b.leaveTypeId} className="flex justify-between px-4 py-2 border-b text-sm"><span>{b.code} · {b.name}</span><span className="font-medium">{b.balance}</span></div>
        ))}
      </div>
      {canManage && emp && (
        <form onSubmit={submit} className="bg-white border rounded-xl p-4 flex flex-wrap gap-3 items-end">
          <select className={inp} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            <option value="opening">Opening balance</option><option value="adjust">Adjustment (+/-)</option><option value="encash">Encashment</option>
          </select>
          <select className={inp} required value={f.leaveTypeId} onChange={(e) => setF({ ...f, leaveTypeId: e.target.value })}>
            <option value="">Leave type</option>{types.filter((t) => f.kind !== 'encash' || t.encashable).map((t) => <option key={t.id} value={t.id}>{t.code}</option>)}
          </select>
          <input className={`${inp} w-24`} type="number" step="0.5" required placeholder="Days" value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} />
          {f.kind !== 'opening' && <input className={`${inp} w-56`} required={f.kind === 'adjust'} placeholder="Note" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />}
          <button className="bg-slate-900 text-white rounded-md px-4 py-1.5 text-sm">Apply</button>
        </form>
      )}
    </div>
  );
}

function Setup({ companyId, canManage }: { companyId: string; canManage: boolean }) {
  const { types, reload } = useTypes(companyId);
  const [f, setF] = useState({ code: '', name: '', paid: true, encashable: false });
  const [p, setP] = useState({ leaveTypeId: '', annualQuota: '', maxAccumulation: '' });
  const [acc, setAcc] = useState({ year: new Date().getFullYear(), month: new Date().getMonth() + 1 });
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  const wrap = async (fn: () => Promise<unknown>, ok: string) => {
    setErr(''); setMsg('');
    try { await fn(); setMsg(ok); reload(); } catch (x) { setErr(x instanceof Error ? x.message : 'Failed'); }
  };

  return (
    <div className="space-y-4">
      {err && <ErrorBox text={err} />}{msg && <div className="text-sm text-emerald-700">{msg}</div>}
      <div className="bg-white border rounded-xl p-4 space-y-2">
        <h2 className="font-medium text-sm">Leave types</h2>
        {types.map((t) => <div key={t.id} className="text-sm">{t.code} · {t.name} <span className="text-slate-400">{t.paid ? 'paid' : 'unpaid'}{t.encashable ? ', encashable' : ''}</span></div>)}
        {canManage && (
          <form className="flex flex-wrap gap-3 items-end pt-2" onSubmit={(e) => { e.preventDefault(); wrap(() => api(`/companies/${companyId}/leave/types`, { method: 'POST', body: JSON.stringify(f) }).then(() => setF({ code: '', name: '', paid: true, encashable: false })), 'Leave type added'); }}>
            <input className={`${inp} w-24`} required placeholder="Code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} />
            <input className={inp} required placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            <label className="text-sm flex gap-1"><input type="checkbox" checked={f.paid} onChange={(e) => setF({ ...f, paid: e.target.checked })} /> Paid</label>
            <label className="text-sm flex gap-1"><input type="checkbox" checked={f.encashable} onChange={(e) => setF({ ...f, encashable: e.target.checked })} /> Encashable</label>
            <button className="bg-slate-900 text-white rounded-md px-4 py-1.5 text-sm">Add</button>
          </form>
        )}
      </div>
      {canManage && (
        <>
          <form className="bg-white border rounded-xl p-4 flex flex-wrap gap-3 items-end" onSubmit={(e) => { e.preventDefault(); wrap(() => api(`/companies/${companyId}/leave/policies`, { method: 'PUT', body: JSON.stringify({ leaveTypeId: p.leaveTypeId, name: 'Policy', annualQuota: Number(p.annualQuota), ...(p.maxAccumulation ? { maxAccumulation: Number(p.maxAccumulation) } : {}) }) }), 'Policy saved'); }}>
            <h2 className="font-medium text-sm w-full">Policy (accrues annual quota ÷ 12 each month)</h2>
            <select className={inp} required value={p.leaveTypeId} onChange={(e) => setP({ ...p, leaveTypeId: e.target.value })}><option value="">Leave type</option>{types.map((t) => <option key={t.id} value={t.id}>{t.code}</option>)}</select>
            <input className={`${inp} w-32`} type="number" step="0.5" required placeholder="Annual quota" value={p.annualQuota} onChange={(e) => setP({ ...p, annualQuota: e.target.value })} />
            <input className={`${inp} w-36`} type="number" step="0.5" placeholder="Max accumulation" value={p.maxAccumulation} onChange={(e) => setP({ ...p, maxAccumulation: e.target.value })} />
            <button className="bg-slate-900 text-white rounded-md px-4 py-1.5 text-sm">Save policy</button>
          </form>
          <form className="bg-white border rounded-xl p-4 flex flex-wrap gap-3 items-end" onSubmit={(e) => { e.preventDefault(); wrap(async () => { const r = await api<{ credited: number }>(`/companies/${companyId}/leave/accrue`, { method: 'POST', body: JSON.stringify(acc) }); setMsg(`Accrual done: ${r.credited} credits (safe to re-run)`); }, ''); }}>
            <h2 className="font-medium text-sm w-full">Run monthly accrual</h2>
            <input className={`${inp} w-24`} type="number" value={acc.year} onChange={(e) => setAcc({ ...acc, year: +e.target.value })} />
            <input className={`${inp} w-20`} type="number" min={1} max={12} value={acc.month} onChange={(e) => setAcc({ ...acc, month: +e.target.value })} />
            <button className="border rounded-md px-4 py-1.5 text-sm">Run accrual</button>
          </form>
        </>
      )}
    </div>
  );
}
