import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Plus, X } from 'lucide-react';
import { api, type Session } from '../api';
import { Badge, Empty, ErrorBox } from '../components/ui';

export interface Company {
  id: string; code: string; name: string; city?: string | null; state?: string | null; status: string;
  legalName?: string | null; gstin?: string | null; pan?: string | null; email?: string | null; phone?: string | null;
  settings?: Settings | null; _count?: { employees: number };
}
type Settings = Record<string, boolean | string | number | null>;

const FLAGS: [string, string][] = [
  ['attendanceEnabled', 'Attendance'], ['shiftEnabled', 'Shift management (optional)'], ['overtimeEnabled', 'Overtime'],
  ['lateCalcEnabled', 'Late calculation'], ['lopEnabled', 'LOP'], ['leaveEnabled', 'Leave management'],
  ['pfEnabled', 'PF'], ['esiEnabled', 'ESI'], ['ptEnabled', 'Professional Tax'], ['lwfEnabled', 'LWF'],
  ['tdsEnabled', 'TDS'], ['bonusEnabled', 'Bonus'], ['gratuityEnabled', 'Gratuity'], ['minimumWageEnabled', 'Minimum wages'],
];

export default function Companies({ session }: { session: Session }) {
  const [items, setItems] = useState<Company[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [drawer, setDrawer] = useState<{ mode: 'new' } | { mode: 'edit'; id: string } | null>(null);
  const can = (p: string) => session.user.permissions.includes(p);
  const pageSize = 20;

  const load = useCallback(() => {
    setLoading(true); setErr('');
    api<{ items: Company[]; total: number }>(`/companies?page=${page}&pageSize=${pageSize}${search ? `&search=${encodeURIComponent(search)}` : ''}`)
      .then((r) => { setItems(r.items); setTotal(r.total); })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, [page, search]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Companies</h1>
        <input className="border rounded-md px-3 py-1.5 text-sm ml-auto w-full sm:w-64" placeholder="Search name or code" value={search} onChange={(e) => { setPage(1); setSearch(e.target.value); }} />
        {can('company.create') && (
          <button onClick={() => setDrawer({ mode: 'new' })} className="flex items-center gap-1 bg-slate-900 text-white rounded-md px-3 py-1.5 text-sm"><Plus size={16} /> New company</button>
        )}
      </div>

      {err && <ErrorBox text={err} />}
      <div className="bg-white border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-slate-500"><tr>
            {['Code', 'Company', 'City', 'Employees', 'Status'].map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}
          </tr></thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.id} className="border-t hover:bg-slate-50 cursor-pointer" onClick={() => setDrawer({ mode: 'edit', id: c.id })}>
                <td className="px-4 py-2">{c.code}</td><td className="px-4 py-2">{c.name}</td>
                <td className="px-4 py-2">{c.city ?? '—'}</td><td className="px-4 py-2">{c._count?.employees ?? 0}</td>
                <td className="px-4 py-2"><Badge value={c.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading && <Empty text="Loading…" />}
        {!loading && items.length === 0 && !err && <Empty text="No companies found." />}
      </div>

      <div className="flex items-center justify-between text-sm text-slate-600">
        <span>{total} companies</span>
        <div className="flex gap-2">
          <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="border rounded px-3 py-1 disabled:opacity-40">Prev</button>
          <button disabled={page * pageSize >= total} onClick={() => setPage(page + 1)} className="border rounded px-3 py-1 disabled:opacity-40">Next</button>
        </div>
      </div>

      {drawer && <CompanyDrawer target={drawer} canEdit={can('company.edit')} canSettings={can('settings.manage')} onClose={() => setDrawer(null)} onSaved={() => { setDrawer(null); load(); }} />}
    </div>
  );
}

const TEXT: [string, string][] = [
  ['code', 'Company code'], ['name', 'Company name'], ['legalName', 'Legal name'], ['tradeName', 'Trade name'],
  ['city', 'City'], ['state', 'State'], ['pincode', 'Pincode'], ['address', 'Address'],
  ['contactPerson', 'Contact person'], ['email', 'Email'], ['phone', 'Phone'],
  ['gstin', 'GSTIN'], ['pan', 'PAN'], ['tan', 'TAN'],
];

function CompanyDrawer({ target, canEdit, canSettings, onClose, onSaved }: {
  target: { mode: 'new' } | { mode: 'edit'; id: string }; canEdit: boolean; canSettings: boolean; onClose: () => void; onSaved: () => void;
}) {
  const isNew = target.mode === 'new';
  const [tab, setTab] = useState<'basic' | 'settings'>('basic');
  const [form, setForm] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState<Settings>({ shiftEnabled: false });
  const [brand, setBrand] = useState({ primaryColor: '#1e293b', footerText: '', title: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (target.mode !== 'edit') return;
    api<Company>(`/companies/${target.id}`).then((c) => {
      const f: Record<string, string> = {};
      TEXT.forEach(([k]) => { f[k] = String((c as unknown as Record<string, unknown>)[k] ?? ''); });
      setForm(f); setSettings(c.settings ?? {});
      const b = (c.settings as { branding?: Partial<typeof brand> } | null | undefined)?.branding;
      if (b) setBrand({ primaryColor: b.primaryColor ?? '#1e293b', footerText: b.footerText ?? '', title: b.title ?? '' });
    }).catch((e) => setErr(e.message));
  }, [target]);

  const save = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const clean = Object.fromEntries(Object.entries(form).filter(([, v]) => v.trim() !== ''));
      if (target.mode === 'new') {
        await api('/companies', { method: 'POST', body: JSON.stringify(clean) });
      } else {
        delete clean.code; // code is immutable
        if (canEdit) await api(`/companies/${target.id}`, { method: 'PATCH', body: JSON.stringify(clean) });
        if (canSettings) {
          const body: Record<string, unknown> = Object.fromEntries(FLAGS.map(([k]) => [k, !!settings[k]]));
          body.branding = { primaryColor: brand.primaryColor, footerText: brand.footerText, title: brand.title };
          await api(`/companies/${target.id}/settings`, { method: 'PATCH', body: JSON.stringify(body) });
        }
      }
      onSaved();
    } catch (x) { setErr(x instanceof Error ? x.message : 'Save failed'); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-black/30" onClick={onClose}>
      <form onSubmit={save} onClick={(e) => e.stopPropagation()} className="w-full max-w-lg bg-white h-full overflow-y-auto p-5 space-y-4">
        <div className="flex items-center">
          <h2 className="font-semibold">{isNew ? 'New company' : 'Company master'}</h2>
          <button type="button" onClick={onClose} className="ml-auto" aria-label="Close"><X size={18} /></button>
        </div>
        {!isNew && (
          <div className="flex gap-2 text-sm">
            {(['basic', 'settings'] as const).map((t) => (
              <button type="button" key={t} onClick={() => setTab(t)} className={`px-3 py-1 rounded-md ${tab === t ? 'bg-slate-900 text-white' : 'border'}`}>{t === 'basic' ? 'Basic & statutory' : 'Settings'}</button>
            ))}
          </div>
        )}
        {err && <ErrorBox text={err} />}

        {(isNew || tab === 'basic') && (
          <div className="grid sm:grid-cols-2 gap-3">
            {TEXT.map(([k, label]) => (
              <label key={k} className={`text-xs text-slate-600 ${k === 'address' ? 'sm:col-span-2' : ''}`}>
                {label}
                <input
                  className="mt-1 w-full border rounded-md px-2 py-1.5 text-sm text-slate-900 disabled:bg-slate-50"
                  value={form[k] ?? ''} disabled={(!isNew && !canEdit) || (!isNew && k === 'code')}
                  required={k === 'code' || k === 'name'}
                  onChange={(e) => setForm({ ...form, [k]: ['gstin', 'pan', 'tan'].includes(k) ? e.target.value.toUpperCase() : e.target.value })}
                />
              </label>
            ))}
          </div>
        )}

        {!isNew && tab === 'settings' && (
          <div className="grid sm:grid-cols-2 gap-2 text-sm">
            {FLAGS.map(([k, label]) => (
              <label key={k} className="flex items-center gap-2">
                <input type="checkbox" disabled={!canSettings} checked={!!settings[k]} onChange={(e) => setSettings({ ...settings, [k]: e.target.checked })} />
                {label}
              </label>
            ))}
          </div>
        )}
        {!isNew && tab === 'settings' && (
          <div className="space-y-2 border-t pt-3">
            <h3 className="text-sm font-medium">Payslip branding</h3>
            <div className="flex flex-wrap gap-3 items-end text-xs text-slate-600">
              <label>Colour<input type="color" className="block mt-1 h-8 w-14" disabled={!canSettings} value={brand.primaryColor} onChange={(e) => setBrand({ ...brand, primaryColor: e.target.value })} /></label>
              <label>Title<input className="block mt-1 border rounded-md px-2 py-1.5 text-sm text-slate-900 w-40" placeholder="PAYSLIP" disabled={!canSettings} value={brand.title} onChange={(e) => setBrand({ ...brand, title: e.target.value })} /></label>
              <label className="flex-1 min-w-48">Footer note<input className="block mt-1 w-full border rounded-md px-2 py-1.5 text-sm text-slate-900" disabled={!canSettings} value={brand.footerText} onChange={(e) => setBrand({ ...brand, footerText: e.target.value })} /></label>
            </div>
          </div>
        )}

        {(isNew || canEdit || canSettings) && (
          <button disabled={busy} className="bg-slate-900 text-white rounded-md px-4 py-2 text-sm disabled:opacity-60">{busy ? 'Saving…' : 'Save'}</button>
        )}
      </form>
    </div>
  );
}
