import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Trash2 } from 'lucide-react';
import { api, type Session } from '../api';
import EmployeePicker, { type EmpLite } from '../components/EmployeePicker';
import { Empty, ErrorBox } from '../components/ui';

interface Shift { id: string; code: string; name: string; type: string; startTime: string; endTime: string; graceMinutes: number; breakMinutes: number; _count: { assignments: number } }
const inp = 'border rounded-md px-2 py-1.5 text-sm';

/** Only reachable when the company has Shift Management enabled. Assigning shifts is optional per employee. */
export default function Shifts({ companyId, session }: { companyId: string; session: Session }) {
  const [rows, setRows] = useState<Shift[]>([]);
  const [err, setErr] = useState('');
  const [f, setF] = useState({ code: '', name: '', type: 'GENERAL', startTime: '09:00', endTime: '18:00', graceMinutes: '0', breakMinutes: '60' });
  const [emp, setEmp] = useState<EmpLite | null>(null);
  const [a, setA] = useState({ shiftId: '', fromDate: '' });
  const canManage = session.user.permissions.includes('attendance.manage');

  const load = useCallback(() => { api<Shift[]>(`/companies/${companyId}/shifts`).then(setRows).catch((e) => setErr(e.message)); }, [companyId]);
  useEffect(load, [load]);

  const wrap = async (fn: () => Promise<unknown>) => { setErr(''); try { await fn(); load(); } catch (x) { setErr(x instanceof Error ? x.message : 'Failed'); } };
  const add = (e: FormEvent) => { e.preventDefault(); wrap(() => api(`/companies/${companyId}/shifts`, { method: 'POST', body: JSON.stringify({ ...f, graceMinutes: +f.graceMinutes, breakMinutes: +f.breakMinutes }) })); };

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Shifts</h1>
      {err && <ErrorBox text={err} />}
      {canManage && (
        <form onSubmit={add} className="bg-white border rounded-xl p-4 flex flex-wrap gap-3 items-end">
          <input className={`${inp} w-24`} required placeholder="Code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} />
          <input className={inp} required placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <select className={inp} value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{['GENERAL', 'MORNING', 'NIGHT', 'ROTATIONAL'].map((t) => <option key={t}>{t}</option>)}</select>
          <input className={inp} type="time" value={f.startTime} onChange={(e) => setF({ ...f, startTime: e.target.value })} />
          <input className={inp} type="time" value={f.endTime} onChange={(e) => setF({ ...f, endTime: e.target.value })} />
          <input className={`${inp} w-24`} type="number" title="Grace minutes" placeholder="Grace" value={f.graceMinutes} onChange={(e) => setF({ ...f, graceMinutes: e.target.value })} />
          <input className={`${inp} w-24`} type="number" title="Break minutes" placeholder="Break" value={f.breakMinutes} onChange={(e) => setF({ ...f, breakMinutes: e.target.value })} />
          <button className="bg-slate-900 text-white rounded-md px-4 py-1.5 text-sm">Add shift</button>
        </form>
      )}
      <div className="bg-white border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-slate-500"><tr>{['Code', 'Name', 'Type', 'Timing', 'Grace / Break', 'Assigned', ''].map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id} className="border-t">
                <td className="px-4 py-2">{s.code}</td><td className="px-4 py-2">{s.name}</td><td className="px-4 py-2">{s.type}</td>
                <td className="px-4 py-2">{s.startTime} – {s.endTime}</td><td className="px-4 py-2">{s.graceMinutes}m / {s.breakMinutes}m</td><td className="px-4 py-2">{s._count.assignments}</td>
                <td className="px-4 py-2 text-right">{canManage && <button aria-label="Delete" className="text-slate-400 hover:text-red-600" onClick={() => confirm('Delete shift?') && wrap(() => api(`/companies/${companyId}/shifts/${s.id}`, { method: 'DELETE' }))}><Trash2 size={16} /></button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <Empty text="No shifts yet." />}
      </div>
      {canManage && rows.length > 0 && (
        <form className="bg-white border rounded-xl p-4 flex flex-wrap gap-3 items-end" onSubmit={(e) => { e.preventDefault(); if (!emp) return setErr('Choose an employee'); wrap(() => api(`/companies/${companyId}/shifts/assign`, { method: 'POST', body: JSON.stringify({ employeeId: emp.id, ...a }) })); }}>
          <h2 className="font-medium text-sm w-full">Assign shift (optional, per employee)</h2>
          <EmployeePicker companyId={companyId} value={emp} onChange={setEmp} />
          <select className={inp} required value={a.shiftId} onChange={(e) => setA({ ...a, shiftId: e.target.value })}><option value="">Shift</option>{rows.map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}</select>
          <input className={inp} type="date" required value={a.fromDate} onChange={(e) => setA({ ...a, fromDate: e.target.value })} />
          <button className="border rounded-md px-4 py-1.5 text-sm">Assign</button>
        </form>
      )}
    </div>
  );
}
