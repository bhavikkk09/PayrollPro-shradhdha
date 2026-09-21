import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Trash2 } from 'lucide-react';
import { api, type Session } from '../api';
import { Empty, ErrorBox } from '../components/ui';

type Kind = 'branches' | 'departments' | 'designations' | 'locations';
interface Row { id: string; code?: string; name: string; city?: string | null; state?: string | null; establishmentCode?: string | null }

const TABS: { kind: Kind; label: string; hasCode: boolean }[] = [
  { kind: 'branches', label: 'Branches', hasCode: true },
  { kind: 'departments', label: 'Departments', hasCode: true },
  { kind: 'designations', label: 'Designations', hasCode: false },
  { kind: 'locations', label: 'Locations', hasCode: false },
];

export default function Organisation({ companyId, session }: { companyId: string; session: Session }) {
  const [kind, setKind] = useState<Kind>('branches');
  const [rows, setRows] = useState<Row[]>([]);
  const [form, setForm] = useState<Record<string, string>>({});
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const tab = TABS.find((t) => t.kind === kind)!;
  const canManage = session.user.permissions.includes('branch.manage');

  const load = useCallback(() => {
    setLoading(true); setErr('');
    api<Row[]>(`/companies/${companyId}/${kind}`).then(setRows).catch((e) => setErr(e.message)).finally(() => setLoading(false));
  }, [companyId, kind]);
  useEffect(() => { setForm({}); load(); }, [load]);

  const add = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    try {
      const body = Object.fromEntries(Object.entries(form).filter(([, v]) => v.trim() !== ''));
      await api(`/companies/${companyId}/${kind}`, { method: 'POST', body: JSON.stringify(body) });
      setForm({}); load();
    } catch (x) { setErr(x instanceof Error ? x.message : 'Failed'); }
  };
  const del = async (id: string) => {
    if (!confirm('Delete this item?')) return;
    setErr('');
    try { await api(`/companies/${companyId}/${kind}/${id}`, { method: 'DELETE' }); load(); }
    catch (x) { setErr(x instanceof Error ? x.message : 'Failed'); }
  };

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Organisation</h1>
      <div className="flex gap-2 flex-wrap">
        {TABS.map((t) => (
          <button key={t.kind} onClick={() => setKind(t.kind)} className={`px-3 py-1 rounded-md text-sm ${kind === t.kind ? 'bg-slate-900 text-white' : 'border bg-white'}`}>{t.label}</button>
        ))}
      </div>
      {err && <ErrorBox text={err} />}

      {canManage && (
        <form onSubmit={add} className="bg-white border rounded-xl p-4 flex flex-wrap gap-3 items-end">
          {tab.hasCode && <Field label="Code" value={form.code} onChange={(v) => setForm({ ...form, code: v })} required />}
          <Field label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} required />
          {kind === 'branches' && <>
            <Field label="City" value={form.city} onChange={(v) => setForm({ ...form, city: v })} />
            <Field label="State" value={form.state} onChange={(v) => setForm({ ...form, state: v })} />
            <Field label="Establishment code" value={form.establishmentCode} onChange={(v) => setForm({ ...form, establishmentCode: v })} />
          </>}
          <button className="bg-slate-900 text-white rounded-md px-4 py-1.5 text-sm">Add</button>
        </form>
      )}

      <div className="bg-white border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-slate-500"><tr>
            {tab.hasCode && <th className="px-4 py-2 font-medium">Code</th>}
            <th className="px-4 py-2 font-medium">Name</th>
            {kind === 'branches' && <th className="px-4 py-2 font-medium">City</th>}
            <th className="px-4 py-2" />
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t">
                {tab.hasCode && <td className="px-4 py-2">{r.code}</td>}
                <td className="px-4 py-2">{r.name}</td>
                {kind === 'branches' && <td className="px-4 py-2">{r.city ?? '—'}</td>}
                <td className="px-4 py-2 text-right">{canManage && <button onClick={() => del(r.id)} aria-label="Delete" className="text-slate-400 hover:text-red-600"><Trash2 size={16} /></button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading && <Empty text="Loading…" />}
        {!loading && rows.length === 0 && <Empty text={`No ${tab.label.toLowerCase()} yet.`} />}
      </div>
    </div>
  );
}

function Field({ label, value, onChange, required }: { label: string; value?: string; onChange: (v: string) => void; required?: boolean }) {
  return (
    <label className="text-xs text-slate-600">
      {label}
      <input className="mt-1 block border rounded-md px-2 py-1.5 text-sm text-slate-900 w-40" value={value ?? ''} required={required} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}
