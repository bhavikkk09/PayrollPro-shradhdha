import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, type Session } from '../api';
import { Empty, ErrorBox } from '../components/ui';

interface Rule {
  id: string; module: string; state: string | null; version: number; effectiveFrom: string; effectiveTo: string | null;
  wageCeiling: string | null; employeePercent: string | null; employerPercent: string | null; slabs: unknown; rules: unknown; notes: string | null;
  scope: 'PLATFORM' | 'OWN'; editable: boolean;
}
const MODULES = ['PF', 'ESI', 'PT', 'LWF', 'TDS', 'BONUS', 'GRATUITY', 'MINIMUM_WAGE', 'OTHER'];
const inp = 'border rounded-md px-2 py-1.5 text-sm';
const HINT: Record<string, { slabs?: string; rules?: string }> = {
  PF: { rules: '{"dueDay": 15, "capWages": true, "rounding": "NEAREST"}' },
  ESI: { rules: '{"dueDay": 15, "rounding": "UP"}' },
  PT: { slabs: '[{"from":0,"to":9999,"amount":0},{"from":10000,"to":null,"amount":200,"monthAmounts":{"2":300}}]', rules: '{"dueDay": 15}' },
  LWF: { rules: '{"employeeAmount": 6, "employerAmount": 12, "months": [6, 12], "dueDay": 15}' },
  TDS: { slabs: '[{"from":0,"to":300000,"rate":0},{"from":300000,"to":null,"rate":5}]', rules: '{"standardDeduction": 0, "cessPercent": 4, "rebate": {"incomeLimit": 0, "maxAmount": 0}, "fyStartMonth": 4, "dueDay": 7}' },
};

export default function ComplianceRules({ session }: { session: Session }) {
  const [rows, setRows] = useState<Rule[]>([]);
  const [module, setModule] = useState('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const canConfig = session.user.permissions.includes('compliance.config');

  const load = useCallback(() => {
    api<Rule[]>(`/compliance/rules${module ? `?module=${module}` : ''}`).then(setRows).catch((e) => setErr(e.message));
  }, [module]);
  useEffect(load, [load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Compliance rules</h1>
        <select className={inp} value={module} onChange={(e) => setModule(e.target.value)}>
          <option value="">All modules</option>{MODULES.map((m) => <option key={m}>{m}</option>)}
        </select>
      </div>
      <p className="text-sm text-slate-600">Every statutory rate, ceiling, slab and due day lives here as a dated version. To change a rule, add a new version with its effective date; the old version stays for past payrolls. Platform rows are defaults; add your own version to override them for your companies.</p>
      {err && <ErrorBox text={err} />}{msg && <div className="text-sm text-emerald-700">{msg}</div>}

      {canConfig && <NewVersion defaultModule={module} onDone={(m) => { setMsg(m); setErr(''); load(); }} onError={setErr} />}
      <Preview />

      <div className="bg-white border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-slate-500"><tr>{['Module', 'State', 'Ver', 'From', 'To', 'Ceiling', 'Emp %', 'Empr %', 'Scope'].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t align-top" title={r.notes ?? ''}>
                <td className="px-3 py-2 font-medium">{r.module}</td><td className="px-3 py-2">{r.state ?? 'All (central)'}</td><td className="px-3 py-2">v{r.version}</td>
                <td className="px-3 py-2">{r.effectiveFrom.slice(0, 10)}</td><td className="px-3 py-2">{r.effectiveTo ? r.effectiveTo.slice(0, 10) : <span className="text-emerald-700">current</span>}</td>
                <td className="px-3 py-2">{r.wageCeiling ?? '—'}</td><td className="px-3 py-2">{r.employeePercent ?? '—'}</td><td className="px-3 py-2">{r.employerPercent ?? '—'}</td>
                <td className="px-3 py-2 text-xs">{r.scope === 'OWN' ? 'Your override' : 'Platform default'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <Empty text="No rules configured." />}
      </div>
    </div>
  );
}

function NewVersion({ defaultModule, onDone, onError }: { defaultModule: string; onDone: (m: string) => void; onError: (m: string) => void }) {
  const [f, setF] = useState({ module: defaultModule || 'PF', state: '', effectiveFrom: '', wageCeiling: '', employeePercent: '', employerPercent: '', slabs: '', rules: '', notes: '' });
  useEffect(() => { if (defaultModule) setF((x) => ({ ...x, module: defaultModule })); }, [defaultModule]);
  const hint = HINT[f.module] ?? {};
  const set = (k: string, v: string) => setF({ ...f, [k]: v });

  const submit = async (e: FormEvent) => {
    e.preventDefault(); onError('');
    let slabs: unknown, rules: unknown;
    try { slabs = f.slabs.trim() ? JSON.parse(f.slabs) : undefined; } catch { return onError('Slabs is not valid JSON'); }
    try { rules = f.rules.trim() ? JSON.parse(f.rules) : undefined; } catch { return onError('Rules is not valid JSON'); }
    const num = (v: string) => (v.trim() === '' ? undefined : Number(v));
    try {
      const r = await api<{ version: number }>('/compliance/rules', { method: 'POST', body: JSON.stringify({
        module: f.module, state: f.state || undefined, effectiveFrom: f.effectiveFrom, wageCeiling: num(f.wageCeiling), employeePercent: num(f.employeePercent),
        employerPercent: num(f.employerPercent), slabs, rules, notes: f.notes || undefined,
      }) });
      onDone(`${f.module} version ${r.version} saved. The previous version now ends the day before ${f.effectiveFrom}.`);
    } catch (x) { onError(x instanceof Error ? x.message : 'Failed'); }
  };

  return (
    <form onSubmit={submit} className="bg-white border rounded-xl p-4 space-y-3">
      <h2 className="font-medium text-sm">Add a new version</h2>
      <div className="flex flex-wrap gap-3 items-end">
        <select className={inp} value={f.module} onChange={(e) => set('module', e.target.value)}>{MODULES.map((m) => <option key={m}>{m}</option>)}</select>
        <input className={`${inp} w-40`} placeholder="State (blank = all)" value={f.state} onChange={(e) => set('state', e.target.value)} />
        <label className="text-xs text-slate-600">Effective from<input className={`${inp} block mt-1`} type="date" required value={f.effectiveFrom} onChange={(e) => set('effectiveFrom', e.target.value)} /></label>
        <input className={`${inp} w-32`} type="number" step="any" placeholder="Wage ceiling" value={f.wageCeiling} onChange={(e) => set('wageCeiling', e.target.value)} />
        <input className={`${inp} w-28`} type="number" step="any" placeholder="Employee %" value={f.employeePercent} onChange={(e) => set('employeePercent', e.target.value)} />
        <input className={`${inp} w-28`} type="number" step="any" placeholder="Employer %" value={f.employerPercent} onChange={(e) => set('employerPercent', e.target.value)} />
      </div>
      <div className="grid md:grid-cols-2 gap-3">
        <label className="text-xs text-slate-600">Slabs (JSON, for PT and TDS)
          <textarea className={`${inp} block w-full mt-1 font-mono text-xs h-24`} placeholder={hint.slabs} value={f.slabs} onChange={(e) => set('slabs', e.target.value)} /></label>
        <label className="text-xs text-slate-600">Rules (JSON: due day, months, rounding, fixed amounts…)
          <textarea className={`${inp} block w-full mt-1 font-mono text-xs h-24`} placeholder={hint.rules} value={f.rules} onChange={(e) => set('rules', e.target.value)} /></label>
      </div>
      <div className="flex gap-3 items-center">
        <input className={`${inp} flex-1`} placeholder="Notes / legal reference (e.g. notification number)" value={f.notes} onChange={(e) => set('notes', e.target.value)} />
        <button className="bg-slate-900 text-white rounded-md px-4 py-1.5 text-sm">Save version</button>
      </div>
      <p className="text-xs text-slate-500">Examples in the boxes show the format only. Enter the values from the current notification.</p>
    </form>
  );
}

function Preview() {
  const [f, setF] = useState({ module: 'PF', state: '', asOf: new Date().toISOString().slice(0, 10), wage: '', month: String(new Date().getMonth() + 1) });
  const [out, setOut] = useState<string>('');
  const run = async (e: FormEvent) => {
    e.preventDefault(); setOut('');
    try {
      const r = await api<{ found: boolean; message?: string; version?: number; covered?: boolean; employee?: number; employer?: number; note?: string }>('/compliance/calc-preview', {
        method: 'POST', body: JSON.stringify({ module: f.module, state: f.state || undefined, asOf: f.asOf, wage: Number(f.wage), month: Number(f.month) }),
      });
      setOut(!r.found ? r.message! : r.covered === false ? `Rule v${r.version}: not covered at this wage` : `Rule v${r.version}: employee ${r.employee}, employer ${r.employer}${r.note ? ` (${r.note})` : ''}`);
    } catch (x) { setOut(x instanceof Error ? x.message : 'Failed'); }
  };
  return (
    <form onSubmit={run} className="bg-white border rounded-xl p-4 flex flex-wrap gap-3 items-end">
      <h2 className="font-medium text-sm w-full">Try a rule (no payroll is touched)</h2>
      <select className={inp} value={f.module} onChange={(e) => setF({ ...f, module: e.target.value })}>{['PF', 'ESI', 'PT', 'LWF', 'TDS'].map((m) => <option key={m}>{m}</option>)}</select>
      <input className={`${inp} w-36`} placeholder="State" value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })} />
      <input className={inp} type="date" value={f.asOf} onChange={(e) => setF({ ...f, asOf: e.target.value })} />
      <input className={`${inp} w-32`} type="number" required placeholder="Monthly wage" value={f.wage} onChange={(e) => setF({ ...f, wage: e.target.value })} />
      <input className={`${inp} w-20`} type="number" min={1} max={12} title="Month" value={f.month} onChange={(e) => setF({ ...f, month: e.target.value })} />
      <button className="border rounded-md px-4 py-1.5 text-sm">Calculate</button>
      {out && <span className="text-sm text-slate-700">{out}</span>}
    </form>
  );
}
