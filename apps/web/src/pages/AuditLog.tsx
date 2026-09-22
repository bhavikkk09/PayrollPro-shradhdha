import { Fragment, useCallback, useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { api, download } from '../api';
import type { Company } from './Companies';
import { Empty, ErrorBox } from '../components/ui';

interface Entry { id: string; createdAt: string; user: string | null; company: string | null; module: string; action: string; recordId: string | null; ip: string | null; oldValue: unknown; newValue: unknown }
const inp = 'border rounded-md px-2 py-1.5 text-sm';
const label = (a: string) => a.replaceAll('_', ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());

/** Firm-internal, read-only. There is no edit or delete for any entry — the log is append-only end to end. */
export default function AuditLog({ companies }: { companies: Company[] }) {
  const [items, setItems] = useState<Entry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [modules, setModules] = useState<string[]>([]);
  const [f, setF] = useState({ companyId: '', module: '', action: '', from: '', to: '' });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const pageSize = 50;

  const load = useCallback(() => {
    setLoading(true); setErr('');
    const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    for (const [k, v] of Object.entries(f)) if (v) qs.set(k, v);
    api<{ items: Entry[]; total: number }>(`/audit?${qs}`).then((r) => { setItems(r.items); setTotal(r.total); }).catch((e) => setErr(e.message)).finally(() => setLoading(false));
  }, [page, f]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);
  useEffect(() => { api<string[]>('/audit/modules').then(setModules).catch(() => undefined); }, []);

  const exportCsv = async () => {
    const qs = new URLSearchParams({ format: 'csv' });
    for (const [k, v] of Object.entries(f)) if (v) qs.set(k, v);
    try { await download(`/audit?${qs}`); } catch (x) { setErr(x instanceof Error ? x.message : 'Export failed'); }
  };

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Audit log</h1>
      <p className="text-sm text-slate-600">Every sensitive action, in the order it happened. Entries cannot be edited or removed.</p>
      <div className="bg-white border rounded-xl p-3 flex flex-wrap gap-2 items-end">
        <select className={inp} value={f.companyId} onChange={(e) => { setPage(1); setF({ ...f, companyId: e.target.value }); }}>
          <option value="">All companies</option>{companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select className={inp} value={f.module} onChange={(e) => { setPage(1); setF({ ...f, module: e.target.value }); }}>
          <option value="">All modules</option>{modules.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <input className={`${inp} w-40`} placeholder="Action contains…" value={f.action} onChange={(e) => { setPage(1); setF({ ...f, action: e.target.value }); }} />
        <label className="text-xs text-slate-600">From<input className={`${inp} block mt-1`} type="date" value={f.from} onChange={(e) => { setPage(1); setF({ ...f, from: e.target.value }); }} /></label>
        <label className="text-xs text-slate-600">To<input className={`${inp} block mt-1`} type="date" value={f.to} onChange={(e) => { setPage(1); setF({ ...f, to: e.target.value }); }} /></label>
        <button onClick={exportCsv} className="ml-auto flex items-center gap-1 border rounded-md px-3 py-1.5 text-sm bg-white"><Download size={14} /> Export CSV</button>
      </div>
      {err && <ErrorBox text={err} />}

      <div className="bg-white border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-slate-500"><tr>{['Time', 'User', 'Company', 'Module', 'Action', 'IP', ''].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
          <tbody>
            {items.map((e) => (
              <Fragment key={e.id}>
                <tr className="border-t hover:bg-slate-50 cursor-pointer" onClick={() => setExpanded(expanded === e.id ? null : e.id)}>
                  <td className="px-3 py-2 text-xs text-slate-500 whitespace-nowrap">{new Date(e.createdAt).toLocaleString()}</td>
                  <td className="px-3 py-2 text-xs">{e.user ?? '—'}</td>
                  <td className="px-3 py-2 text-xs">{e.company ?? '—'}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{e.module}</td>
                  <td className="px-3 py-2">{label(e.action)}</td>
                  <td className="px-3 py-2 text-xs text-slate-400">{e.ip ?? '—'}</td>
                  <td className="px-3 py-2 text-xs text-slate-400">{(e.oldValue || e.newValue) ? (expanded === e.id ? 'Hide' : 'Details') : ''}</td>
                </tr>
                {expanded === e.id && !!(e.oldValue || e.newValue) && (
                  <tr className="border-t bg-slate-50">
                    <td colSpan={7} className="px-3 py-3">
                      <div className="grid sm:grid-cols-2 gap-3 text-xs">
                        {e.oldValue != null && <div><div className="text-slate-500 mb-1">Before</div><pre className="bg-white border rounded p-2 overflow-x-auto">{JSON.stringify(e.oldValue, null, 2)}</pre></div>}
                        {e.newValue != null && <div><div className="text-slate-500 mb-1">After</div><pre className="bg-white border rounded p-2 overflow-x-auto">{JSON.stringify(e.newValue, null, 2)}</pre></div>}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
        {loading && <Empty text="Loading…" />}
        {!loading && items.length === 0 && <Empty text="No matching entries." />}
      </div>

      <div className="flex items-center justify-between text-sm text-slate-600">
        <span>{total} entries</span>
        <div className="flex gap-2">
          <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="border rounded px-3 py-1 disabled:opacity-40">Prev</button>
          <button disabled={page * pageSize >= total} onClick={() => setPage(page + 1)} className="border rounded px-3 py-1 disabled:opacity-40">Next</button>
        </div>
      </div>
    </div>
  );
}
