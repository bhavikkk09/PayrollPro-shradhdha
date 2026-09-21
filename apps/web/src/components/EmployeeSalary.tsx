import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { Breakup, money, type CalcResult } from '../pages/Salary';
import { ErrorBox } from './ui';

interface SalaryRow {
  id: string; grossMonthly: string | number; effectiveFrom: string; effectiveTo: string | null; reason: string | null;
  structure?: { name: string } | null; components: CalcResult;
}

export default function EmployeeSalary({ companyId, employeeId, canManage }: { companyId: string; employeeId: string; canManage: boolean }) {
  const [rows, setRows] = useState<SalaryRow[]>([]);
  const [structures, setStructures] = useState<{ id: string; name: string; active: boolean }[]>([]);
  const [form, setForm] = useState({ structureId: '', grossMonthly: '', effectiveFrom: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<SalaryRow[]>(`/companies/${companyId}/employees/${employeeId}/salary`).then(setRows).catch((e) => setErr(e.message));
  }, [companyId, employeeId]);
  useEffect(() => {
    load();
    if (canManage) api<typeof structures>(`/companies/${companyId}/salary-structures`).then((r) => setStructures(r.filter((s) => s.active))).catch(() => undefined);
  }, [load, canManage, companyId]);

  const assign = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      await api(`/companies/${companyId}/employees/${employeeId}/salary`, {
        method: 'POST', body: JSON.stringify({ structureId: form.structureId, grossMonthly: Number(form.grossMonthly), effectiveFrom: form.effectiveFrom }),
      });
      setForm({ structureId: '', grossMonthly: '', effectiveFrom: '' }); load();
    } catch (x) { setErr(x instanceof Error ? x.message : 'Failed'); }
    finally { setBusy(false); }
  };

  const current = rows.find((r) => !r.effectiveTo);
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-medium">Salary</h3>
      {err && <ErrorBox text={err} />}
      {current ? (
        <div>
          <div className="text-xs text-slate-500 mb-1">Current · {current.structure?.name} · from {current.effectiveFrom.slice(0, 10)}</div>
          <Breakup r={current.components} />
        </div>
      ) : <div className="text-sm text-slate-500">No salary assigned yet.</div>}

      {canManage && (
        <div className="flex flex-wrap gap-2 items-end">
          <label className="text-xs text-slate-600">Structure
            <select className="mt-1 block border rounded-md px-2 py-1.5 text-sm w-44" value={form.structureId} onChange={(e) => setForm({ ...form, structureId: e.target.value })}>
              <option value="">—</option>{structures.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select></label>
          <label className="text-xs text-slate-600">Monthly gross
            <input className="mt-1 block border rounded-md px-2 py-1.5 text-sm w-32" type="number" value={form.grossMonthly} onChange={(e) => setForm({ ...form, grossMonthly: e.target.value })} /></label>
          <label className="text-xs text-slate-600">Effective from
            <input className="mt-1 block border rounded-md px-2 py-1.5 text-sm" type="date" value={form.effectiveFrom} onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })} /></label>
          <button type="button" disabled={busy || !form.structureId || !form.grossMonthly || !form.effectiveFrom} onClick={assign as never} className="bg-slate-900 text-white rounded-md px-3 py-1.5 text-sm disabled:opacity-50">
            {current ? 'Revise salary' : 'Assign salary'}
          </button>
        </div>
      )}

      {rows.length > 1 && (
        <div>
          <div className="text-xs text-slate-500 mb-1">History</div>
          {rows.map((r) => (
            <div key={r.id} className="flex justify-between text-sm py-1 border-b">
              <span>{r.effectiveFrom.slice(0, 10)} → {r.effectiveTo ? r.effectiveTo.slice(0, 10) : 'present'} <span className="text-xs text-slate-400">{r.reason}</span></span>
              <span>{money(Number(r.grossMonthly))}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
