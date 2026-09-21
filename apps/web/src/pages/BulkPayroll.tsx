import { useEffect, useRef, useState } from 'react';
import { api, type Session } from '../api';
import type { Company } from './Companies';
import { Badge, Empty, ErrorBox } from '../components/ui';

interface Item { id: string; companyId: string; company?: string; employees: number; success: number; errors: number; warnings: number; status: string; errorDetail?: string | null }
interface Job { id: string; done: boolean; items: Item[] }

const TONE: Record<string, string> = { DONE: 'Completed', FAILED: 'Action Required', RUNNING: 'In Progress', QUEUED: 'Pending' };

/** Runs payroll for several companies. Each company is processed on its own, so one failure never affects another. */
export default function BulkPayroll({ companies, session }: { companies: Company[]; session: Session }) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [job, setJob] = useState<Job | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const canRun = session.user.permissions.includes('payroll.process');

  const toggle = (id: string) => { const s = new Set(picked); s.has(id) ? s.delete(id) : s.add(id); setPicked(s); };

  const poll = (id: string) => {
    api<Job>(`/payroll/bulk/${id}`).then((j) => { setJob(j); if (!j.done) timer.current = setTimeout(() => poll(id), 2000); else setBusy(false); })
      .catch((e) => { setErr(e.message); setBusy(false); });
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  const run = async () => {
    setErr(''); setJob(null); setBusy(true);
    try {
      const r = await api<{ jobId: string }>('/payroll/bulk', { method: 'POST', body: JSON.stringify({ companyIds: [...picked], year, month }) });
      poll(r.jobId);
    } catch (x) { setErr(x instanceof Error ? x.message : 'Failed'); setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Bulk payroll</h1>
        <select className="border rounded-md px-2 py-1.5 text-sm" value={month} onChange={(e) => setMonth(+e.target.value)}>
          {Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>{new Date(2000, i, 1).toLocaleString('en', { month: 'long' })}</option>)}
        </select>
        <input className="border rounded-md px-2 py-1.5 text-sm w-24" type="number" value={year} onChange={(e) => setYear(+e.target.value)} />
      </div>
      {err && <ErrorBox text={err} />}

      <div className="bg-white border rounded-xl">
        <div className="flex items-center px-4 py-3 border-b text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" checked={picked.size === companies.length && companies.length > 0} onChange={(e) => setPicked(e.target.checked ? new Set(companies.map((c) => c.id)) : new Set())} /> Select all</label>
          <span className="ml-auto text-slate-500">{picked.size} selected</span>
        </div>
        {companies.length === 0 ? <Empty text="No companies." /> : companies.map((c) => (
          <label key={c.id} className="flex items-center gap-3 px-4 py-2 border-b text-sm cursor-pointer">
            <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} /> {c.name} <span className="text-slate-400">{c.code}</span>
          </label>
        ))}
      </div>
      {canRun && <button disabled={busy || picked.size === 0} onClick={run} className="bg-slate-900 text-white rounded-md px-5 py-2 text-sm disabled:opacity-40">{busy ? 'Running…' : 'RUN SELECTED PAYROLL'}</button>}
      <p className="text-xs text-slate-500">This calculates each company independently and leaves the run for review. Nothing is approved automatically. Companies with approved or locked payroll for the month are reported as failed and left untouched.</p>

      {job && (
        <div className="bg-white border rounded-xl overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-slate-500"><tr>{['Company', 'Employees', 'Success', 'Errors', 'Warnings', 'Status'].map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr></thead>
            <tbody>
              {job.items.map((i) => (
                <tr key={i.id} className="border-t align-top">
                  <td className="px-4 py-2">{i.company ?? i.companyId}</td><td className="px-4 py-2">{i.employees}</td><td className="px-4 py-2">{i.success}</td>
                  <td className={`px-4 py-2 ${i.errors ? 'text-red-700' : ''}`}>{i.errors}</td><td className="px-4 py-2">{i.warnings}</td>
                  <td className="px-4 py-2"><Badge value={TONE[i.status] ?? i.status} />{i.errorDetail && <div className="text-xs text-red-700 mt-1 max-w-xs">{i.errorDetail}</div>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
