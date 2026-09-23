import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import { api, type Session } from '../api';
import { Badge, Empty, ErrorBox } from '../components/ui';

export interface Component {
  id: string; code: string; name: string; type: string; calcMethod: string; percentage?: string | number | null;
  percentOf?: string | null; fixedAmount?: string | number | null; formula?: string | null; effectiveFrom: string; active: boolean;
  prorateByAttendance: boolean;
}
interface StructureRow { id: string; name: string; active: boolean; _count: { items: number; employeeSalaries: number } }
interface StructureFull { id: string; name: string; items: { componentId: string; sequence: number; component: Component }[] }
export interface CalcResult {
  lines: { code: string; name: string; type: string; amount: number }[];
  gross: number; deductions: number; net: number; warnings: string[]; grossMatchesTarget: boolean;
}

export const money = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const FLAGS: [string, string][] = [['taxable', 'Taxable'], ['pfApplicable', 'PF'], ['esiApplicable', 'ESI'], ['ptApplicable', 'PT'], ['bonusApplicable', 'Bonus'], ['gratuityApplicable', 'Gratuity']];
const PRORATE_FLAG: [string, string] = ['prorateByAttendance', 'Prorate by attendance'];

export default function Salary({ companyId, session }: { companyId: string; session: Session }) {
  const [tab, setTab] = useState<'components' | 'structures'>('components');
  const canManage = session.user.permissions.includes('salary.manage');
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Salary</h1>
      <div className="flex gap-2">
        {(['components', 'structures'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`px-3 py-1 rounded-md text-sm capitalize ${tab === t ? 'bg-slate-900 text-white' : 'border bg-white'}`}>{t}</button>
        ))}
      </div>
      {tab === 'components' ? <Components companyId={companyId} canManage={canManage} /> : <Structures companyId={companyId} canManage={canManage} />}
    </div>
  );
}

function Components({ companyId, canManage }: { companyId: string; canManage: boolean }) {
  const [rows, setRows] = useState<Component[]>([]);
  const [form, setForm] = useState<Record<string, string | boolean>>({ type: 'EARNING', calcMethod: 'FIXED', taxable: true, prorateByAttendance: true });
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    api<Component[]>(`/companies/${companyId}/salary-components`).then(setRows).catch((e) => setErr(e.message)).finally(() => setLoading(false));
  }, [companyId]);
  useEffect(load, [load]);

  const set = (k: string, v: string | boolean) => setForm({ ...form, [k]: v });
  const add = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    try {
      const b: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(form)) {
        if (typeof v === 'boolean') b[k] = v;
        else if (v.trim() !== '') b[k] = ['percentage', 'fixedAmount'].includes(k) ? Number(v) : v;
      }
      await api(`/companies/${companyId}/salary-components`, { method: 'POST', body: JSON.stringify(b) });
      setForm({ type: 'EARNING', calcMethod: 'FIXED', taxable: true, prorateByAttendance: true }); load();
    } catch (x) { setErr(x instanceof Error ? x.message : 'Failed'); }
  };
  const del = async (id: string) => {
    if (!confirm('Delete this component?')) return;
    setErr('');
    try { await api(`/companies/${companyId}/salary-components/${id}`, { method: 'DELETE' }); load(); }
    catch (x) { setErr(x instanceof Error ? x.message : 'Failed'); }
  };
  const toggle = async (c: Component) => {
    try { await api(`/companies/${companyId}/salary-components/${c.id}`, { method: 'PATCH', body: JSON.stringify({ active: !c.active }) }); load(); }
    catch (x) { setErr(x instanceof Error ? x.message : 'Failed'); }
  };

  const inp = 'mt-1 block border rounded-md px-2 py-1.5 text-sm text-slate-900 w-36';
  const m = String(form.calcMethod);
  return (
    <div className="space-y-4">
      {err && <ErrorBox text={err} />}
      {canManage && (
        <form onSubmit={add} className="bg-white border rounded-xl p-4 space-y-3">
          <div className="flex flex-wrap gap-3 items-end">
            <label className="text-xs text-slate-600">Code<input className={inp} required placeholder="BASIC" value={String(form.code ?? '')} onChange={(e) => set('code', e.target.value.toUpperCase())} /></label>
            <label className="text-xs text-slate-600">Name<input className={inp} required value={String(form.name ?? '')} onChange={(e) => set('name', e.target.value)} /></label>
            <label className="text-xs text-slate-600">Type<select className={inp} value={String(form.type)} onChange={(e) => set('type', e.target.value)}>
              <option value="EARNING">Earning</option><option value="DEDUCTION">Deduction</option><option value="EMPLOYER_CONTRIBUTION">Employer contribution</option></select></label>
            <label className="text-xs text-slate-600">Calculation<select className={inp} value={m} onChange={(e) => set('calcMethod', e.target.value)}>
              {['FIXED', 'PERCENTAGE', 'FORMULA', 'HOURLY'].map((x) => <option key={x}>{x}</option>)}</select></label>
            {m === 'PERCENTAGE' && <>
              <label className="text-xs text-slate-600">Percentage %<input className={inp} type="number" step="0.01" required value={String(form.percentage ?? '')} onChange={(e) => set('percentage', e.target.value)} /></label>
              <label className="text-xs text-slate-600">Of (code / GROSS)<input className={inp} placeholder="GROSS" value={String(form.percentOf ?? '')} onChange={(e) => set('percentOf', e.target.value.toUpperCase())} /></label>
            </>}
            {m === 'FIXED' && <label className="text-xs text-slate-600">Fixed amount<input className={inp} type="number" step="0.01" value={String(form.fixedAmount ?? '')} onChange={(e) => set('fixedAmount', e.target.value)} /></label>}
            {m === 'FORMULA' && <label className="text-xs text-slate-600">Formula<input className={`${inp} w-64`} required placeholder="GROSS - BASIC - HRA" value={String(form.formula ?? '')} onChange={(e) => set('formula', e.target.value)} /></label>}
            <label className="text-xs text-slate-600">Effective from<input className={inp} type="date" required value={String(form.effectiveFrom ?? '')} onChange={(e) => set('effectiveFrom', e.target.value)} /></label>
          </div>
          <div className="flex flex-wrap gap-4 text-sm items-center">
            {FLAGS.map(([k, l]) => <label key={k} className="flex items-center gap-1"><input type="checkbox" checked={!!form[k]} onChange={(e) => set(k, e.target.checked)} /> {l}</label>)}
            <label className="flex items-center gap-1 border-l pl-4" title="Unchecked: this component always pays its full amount, regardless of days worked/LOP">
              <input type="checkbox" checked={!!form[PRORATE_FLAG[0]]} onChange={(e) => set(PRORATE_FLAG[0], e.target.checked)} /> {PRORATE_FLAG[1]}
            </label>
            <button className="ml-auto bg-slate-900 text-white rounded-md px-4 py-1.5 text-sm">Add component</button>
          </div>
        </form>
      )}
      <div className="bg-white border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-slate-500"><tr>{['Code', 'Name', 'Type', 'Calculation', 'From', 'Status', ''].map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className="border-t">
                <td className="px-4 py-2 font-mono">{c.code}</td><td className="px-4 py-2">{c.name}</td>
                <td className="px-4 py-2">{c.type.replace('_', ' ').toLowerCase()}</td>
                <td className="px-4 py-2 text-slate-600">{describe(c)}{!c.prorateByAttendance && c.type === 'EARNING' && <span className="ml-2 text-xs bg-amber-50 text-amber-700 border border-amber-200 rounded-full px-2 py-0.5">always full</span>}</td>
                <td className="px-4 py-2">{c.effectiveFrom.slice(0, 10)}</td>
                <td className="px-4 py-2"><button disabled={!canManage} onClick={() => toggle(c)}><Badge value={c.active ? 'ACTIVE' : 'INACTIVE'} /></button></td>
                <td className="px-4 py-2 text-right">{canManage && <button onClick={() => del(c.id)} aria-label="Delete" className="text-slate-400 hover:text-red-600"><Trash2 size={16} /></button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading && <Empty text="Loading…" />}
        {!loading && rows.length === 0 && <Empty text="No salary components yet." />}
      </div>
    </div>
  );
}

const describe = (c: Component) =>
  c.calcMethod === 'PERCENTAGE' ? `${Number(c.percentage)}% of ${c.percentOf ?? 'GROSS'}`
    : c.calcMethod === 'FIXED' ? (c.fixedAmount != null ? `Fixed ${money(Number(c.fixedAmount))}` : 'Fixed (per employee)')
      : c.calcMethod === 'FORMULA' ? c.formula ?? '' : 'Hourly';

function Structures({ companyId, canManage }: { companyId: string; canManage: boolean }) {
  const [list, setList] = useState<StructureRow[]>([]);
  const [comps, setComps] = useState<Component[]>([]);
  const [editing, setEditing] = useState<{ id: string | null; name: string; ids: string[] } | null>(null);
  const [gross, setGross] = useState('30000');
  const [preview, setPreview] = useState<CalcResult | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    api<StructureRow[]>(`/companies/${companyId}/salary-structures`).then(setList).catch((e) => setErr(e.message));
    api<Component[]>(`/companies/${companyId}/salary-components`).then((r) => setComps(r.filter((c) => c.active))).catch(() => undefined);
  }, [companyId]);
  useEffect(load, [load]);

  const open = async (id: string | null) => {
    setErr(''); setPreview(null);
    if (!id) return setEditing({ id: null, name: '', ids: [] });
    try {
      const s = await api<StructureFull>(`/companies/${companyId}/salary-structures/${id}`);
      setEditing({ id, name: s.name, ids: s.items.map((i) => i.componentId) });
    } catch (x) { setErr(x instanceof Error ? x.message : 'Failed'); }
  };

  const body = () => ({ name: editing!.name, items: editing!.ids.map((componentId, i) => ({ componentId, sequence: i + 1 })) });
  const save = async () => {
    setErr('');
    try {
      const path = `/companies/${companyId}/salary-structures${editing!.id ? `/${editing!.id}` : ''}`;
      const s = await api<StructureFull>(path, { method: editing!.id ? 'PATCH' : 'POST', body: JSON.stringify(body()) });
      setEditing({ ...editing!, id: s.id }); load();
    } catch (x) { setErr(x instanceof Error ? x.message : 'Failed'); }
  };
  const runPreview = async () => {
    if (!editing?.id) return setErr('Save the structure first to preview it');
    setErr('');
    try { setPreview(await api<CalcResult>(`/companies/${companyId}/salary-structures/${editing.id}/preview`, { method: 'POST', body: JSON.stringify({ gross: Number(gross) }) })); }
    catch (x) { setErr(x instanceof Error ? x.message : 'Failed'); }
  };
  const del = async (id: string) => {
    if (!confirm('Delete this structure?')) return;
    try { await api(`/companies/${companyId}/salary-structures/${id}`, { method: 'DELETE' }); if (editing?.id === id) setEditing(null); load(); }
    catch (x) { setErr(x instanceof Error ? x.message : 'Failed'); }
  };
  const move = (i: number, d: number) => {
    const ids = [...editing!.ids]; const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]]; setEditing({ ...editing!, ids });
  };

  const byId = new Map(comps.map((c) => [c.id, c]));
  return (
    <div className="grid lg:grid-cols-3 gap-4">
      <div className="bg-white border rounded-xl">
        <div className="flex items-center px-4 py-3 border-b"><h2 className="font-medium">Structures</h2>
          {canManage && <button onClick={() => open(null)} className="ml-auto text-sm border rounded px-2 py-1">New</button>}</div>
        {list.length === 0 ? <Empty text="No structures yet." /> : list.map((s) => (
          <div key={s.id} className="flex items-center px-4 py-2 border-b text-sm">
            <button onClick={() => open(s.id)} className="text-left flex-1"><div>{s.name}</div><div className="text-xs text-slate-500">{s._count.items} components · {s._count.employeeSalaries} assigned</div></button>
            {canManage && <button onClick={() => del(s.id)} aria-label="Delete" className="text-slate-400 hover:text-red-600"><Trash2 size={16} /></button>}
          </div>
        ))}
      </div>

      <div className="lg:col-span-2 space-y-3">
        {err && <ErrorBox text={err} />}
        {!editing ? <div className="bg-white border rounded-xl"><Empty text="Select a structure or create a new one." /></div> : (
          <div className="bg-white border rounded-xl p-4 space-y-4">
            <input className="border rounded-md px-3 py-1.5 text-sm w-full sm:w-72" placeholder="Structure name" value={editing.name} disabled={!canManage} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            <div>
              <div className="text-xs text-slate-500 mb-1">Calculation order (a formula can only use components above it)</div>
              {editing.ids.map((id, i) => (
                <div key={id} className="flex items-center gap-2 py-1 text-sm border-b">
                  <span className="w-6 text-slate-400">{i + 1}</span>
                  <span className="font-mono w-24">{byId.get(id)?.code}</span>
                  <span className="flex-1 text-slate-600">{byId.get(id) ? describe(byId.get(id)!) : ''}</span>
                  {canManage && <>
                    <button onClick={() => move(i, -1)} aria-label="Up"><ArrowUp size={14} /></button>
                    <button onClick={() => move(i, 1)} aria-label="Down"><ArrowDown size={14} /></button>
                    <button onClick={() => setEditing({ ...editing, ids: editing.ids.filter((x) => x !== id) })} aria-label="Remove" className="text-slate-400 hover:text-red-600"><Trash2 size={14} /></button>
                  </>}
                </div>
              ))}
              {canManage && (
                <select className="border rounded-md px-2 py-1.5 text-sm mt-2" value="" onChange={(e) => e.target.value && setEditing({ ...editing, ids: [...editing.ids, e.target.value] })}>
                  <option value="">+ Add component…</option>
                  {comps.filter((c) => !editing.ids.includes(c.id)).map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
                </select>
              )}
            </div>
            <div className="flex flex-wrap gap-2 items-center">
              {canManage && <button onClick={save} className="bg-slate-900 text-white rounded-md px-4 py-1.5 text-sm">Save structure</button>}
              <input className="border rounded-md px-2 py-1.5 text-sm w-32" type="number" value={gross} onChange={(e) => setGross(e.target.value)} aria-label="Sample gross" />
              <button onClick={runPreview} className="border rounded-md px-3 py-1.5 text-sm">Preview with gross</button>
            </div>
            {preview && <Breakup r={preview} />}
          </div>
        )}
      </div>
    </div>
  );
}

export function Breakup({ r }: { r: CalcResult }) {
  return (
    <div className="border rounded-lg text-sm">
      {r.lines.map((l) => (
        <div key={l.code} className="flex justify-between px-3 py-1.5 border-b">
          <span>{l.name} <span className="text-xs text-slate-400">{l.type === 'DEDUCTION' ? 'deduction' : ''}</span></span>
          <span className={l.type === 'DEDUCTION' ? 'text-red-700' : ''}>{money(l.amount)}</span>
        </div>
      ))}
      <div className="flex justify-between px-3 py-1.5 font-medium"><span>Gross</span><span>{money(r.gross)}</span></div>
      <div className="flex justify-between px-3 py-1.5"><span>Deductions</span><span>{money(r.deductions)}</span></div>
      <div className="flex justify-between px-3 py-1.5 font-semibold bg-slate-50"><span>Net</span><span>{money(r.net)}</span></div>
      {r.warnings.map((w) => <div key={w} className="px-3 py-1.5 text-xs text-amber-700 bg-amber-50">{w}</div>)}
    </div>
  );
}
