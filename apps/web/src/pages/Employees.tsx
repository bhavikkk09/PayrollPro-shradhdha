import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Eye, Plus, X } from 'lucide-react';
import { api, type Session } from '../api';
import { Badge, Empty, ErrorBox } from '../components/ui';
import EmployeeSalary from '../components/EmployeeSalary';
import DocumentsPanel from '../components/DocumentsPanel';

interface Emp {
  id: string; code: string; firstName: string; middleName?: string | null; lastName?: string | null; status: string;
  department?: { name: string } | null; designation?: { name: string } | null; branch?: { name: string } | null;
  [k: string]: unknown;
}
interface Master { id: string; name: string }
type Form = Record<string, string | boolean>;

const SECTIONS: { title: string; fields: [string, string, string?][] }[] = [
  { title: 'Personal', fields: [
    ['code', 'Employee code'], ['firstName', 'First name'], ['middleName', 'Middle name'], ['lastName', 'Last name'],
    ['gender', 'Gender', 'select:MALE,FEMALE,OTHER'], ['dob', 'Date of birth', 'date'],
    ['maritalStatus', 'Marital status', 'select:SINGLE,MARRIED,DIVORCED,WIDOWED'],
    ['mobile', 'Mobile'], ['email', 'Email'], ['city', 'City'], ['state', 'State'], ['pincode', 'Pincode'], ['address', 'Address'],
  ] },
  { title: 'Employment', fields: [
    ['doj', 'Date of joining', 'date'], ['status', 'Status', 'select:ACTIVE,INACTIVE,LEFT,SUSPENDED'],
    ['branchId', 'Branch', 'master:branches'], ['departmentId', 'Department', 'master:departments'],
    ['designationId', 'Designation', 'master:designations'], ['locationId', 'Location', 'master:locations'],
    ['employmentType', 'Employment type'], ['category', 'Category'], ['grade', 'Grade'], ['costCenter', 'Cost center'],
    ['dol', 'Date of leaving', 'date'], ['reasonForLeaving', 'Reason for leaving'],
  ] },
  { title: 'Bank', fields: [['bankName', 'Bank name'], ['bankAccount', 'Account number'], ['ifsc', 'IFSC'], ['bankBranch', 'Bank branch']] },
  { title: 'Statutory', fields: [['uan', 'UAN'], ['pfNumber', 'PF number'], ['esiNumber', 'ESI number'], ['pan', 'PAN'], ['aadhaarRef', 'Aadhaar reference (last 4)']] },
];
const FLAGS: [string, string][] = [['pfApplicable', 'PF'], ['esiApplicable', 'ESI'], ['ptApplicable', 'PT'], ['lwfApplicable', 'LWF']];
const DATES = new Set(['dob', 'doj', 'dol']);

export default function Employees({ companyId, session }: { companyId: string; session: Session }) {
  const [items, setItems] = useState<Emp[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [drawer, setDrawer] = useState<'new' | string | null>(null);
  const can = (p: string) => session.user.permissions.includes(p);
  const pageSize = 25;

  const load = useCallback(() => {
    setLoading(true); setErr('');
    const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (search) qs.set('search', search);
    if (status) qs.set('status', status);
    api<{ items: Emp[]; total: number }>(`/companies/${companyId}/employees?${qs}`)
      .then((r) => { setItems(r.items); setTotal(r.total); })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, [companyId, page, search, status]);
  useEffect(() => { setPage(1); }, [companyId]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Employees</h1>
        <input className="border rounded-md px-3 py-1.5 text-sm ml-auto w-full sm:w-64" placeholder="Search code, name, UAN, mobile" value={search} onChange={(e) => { setPage(1); setSearch(e.target.value); }} />
        <select className="border rounded-md px-2 py-1.5 text-sm" value={status} onChange={(e) => { setPage(1); setStatus(e.target.value); }}>
          <option value="">All status</option>
          {['ACTIVE', 'INACTIVE', 'LEFT', 'SUSPENDED'].map((s) => <option key={s}>{s}</option>)}
        </select>
        {can('employee.create') && <button onClick={() => setDrawer('new')} className="flex items-center gap-1 bg-slate-900 text-white rounded-md px-3 py-1.5 text-sm"><Plus size={16} /> Add employee</button>}
      </div>
      {err && <ErrorBox text={err} />}

      <div className="bg-white border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-slate-500"><tr>
            {['Code', 'Name', 'Department', 'Designation', 'Branch', 'Status'].map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}
          </tr></thead>
          <tbody>
            {items.map((e) => (
              <tr key={e.id} onClick={() => setDrawer(e.id)} className="border-t hover:bg-slate-50 cursor-pointer">
                <td className="px-4 py-2">{e.code}</td>
                <td className="px-4 py-2">{[e.firstName, e.middleName, e.lastName].filter(Boolean).join(' ')}</td>
                <td className="px-4 py-2">{e.department?.name ?? '—'}</td>
                <td className="px-4 py-2">{e.designation?.name ?? '—'}</td>
                <td className="px-4 py-2">{e.branch?.name ?? '—'}</td>
                <td className="px-4 py-2"><Badge value={e.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading && <Empty text="Loading…" />}
        {!loading && items.length === 0 && !err && <Empty text="No employees found." />}
      </div>

      <div className="flex items-center justify-between text-sm text-slate-600">
        <span>{total} employees</span>
        <div className="flex gap-2">
          <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="border rounded px-3 py-1 disabled:opacity-40">Prev</button>
          <button disabled={page * pageSize >= total} onClick={() => setPage(page + 1)} className="border rounded px-3 py-1 disabled:opacity-40">Next</button>
        </div>
      </div>

      {drawer && <EmployeeDrawer companyId={companyId} id={drawer === 'new' ? null : drawer} can={can} onClose={() => setDrawer(null)} onSaved={() => { setDrawer(null); load(); }} />}
    </div>
  );
}

function EmployeeDrawer({ companyId, id, can, onClose, onSaved }: {
  companyId: string; id: string | null; can: (p: string) => boolean; onClose: () => void; onSaved: () => void;
}) {
  const [form, setForm] = useState<Form>({ ptApplicable: true, pfApplicable: true, esiApplicable: true, lwfApplicable: false, status: 'ACTIVE' });
  const [masters, setMasters] = useState<Record<string, Master[]>>({});
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const readOnly = id ? !can('employee.edit') : false;

  const loadEmployee = useCallback((reveal: boolean) => {
    if (!id) return;
    api<Record<string, unknown>>(`/companies/${companyId}/employees/${id}${reveal ? '?reveal=true' : ''}`).then((e) => {
      const f: Form = {};
      for (const s of SECTIONS) for (const [k] of s.fields) {
        const v = e[k];
        f[k] = v == null ? '' : DATES.has(k) ? String(v).slice(0, 10) : String(v);
      }
      for (const [k] of FLAGS) f[k] = !!e[k];
      setForm(f); setRevealed(reveal);
    }).catch((x) => setErr(x.message));
  }, [companyId, id]);

  useEffect(() => {
    loadEmployee(false);
    for (const k of ['branches', 'departments', 'designations', 'locations']) {
      api<Master[]>(`/companies/${companyId}/${k}`).then((r) => setMasters((m) => ({ ...m, [k]: r }))).catch(() => undefined);
    }
  }, [companyId, loadEmployee]);

  const save = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const body: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(form)) {
        if (typeof v === 'boolean') { body[k] = v; continue; }
        // masked values (****1234) are display-only: never send them back
        if (v.trim() === '' || (!revealed && /^\*+/.test(v))) continue;
        body[k] = v;
      }
      if (id) delete body.code; // keep code immutable once created
      await api(`/companies/${companyId}/employees${id ? `/${id}` : ''}`, { method: id ? 'PATCH' : 'POST', body: JSON.stringify(body) });
      onSaved();
    } catch (x) { setErr(x instanceof Error ? x.message : 'Save failed'); }
    finally { setBusy(false); }
  };

  const input = (k: string, label: string, type?: string) => {
    const base = 'mt-1 w-full border rounded-md px-2 py-1.5 text-sm text-slate-900 disabled:bg-slate-50';
    const required = ['code', 'firstName', 'doj'].includes(k);
    const val = String(form[k] ?? '');
    const set = (v: string) => setForm({ ...form, [k]: k === 'pan' || k === 'ifsc' ? v.toUpperCase() : v });
    return (
      <label key={k} className={`text-xs text-slate-600 ${k === 'address' ? 'sm:col-span-2' : ''}`}>
        {label}{required && ' *'}
        {type?.startsWith('select:') ? (
          <select className={base} disabled={readOnly} value={val} onChange={(e) => set(e.target.value)}>
            <option value="">—</option>
            {type.slice(7).split(',').map((o) => <option key={o}>{o}</option>)}
          </select>
        ) : type?.startsWith('master:') ? (
          <select className={base} disabled={readOnly} value={val} onChange={(e) => set(e.target.value)}>
            <option value="">—</option>
            {(masters[type.slice(7)] ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        ) : (
          <input className={base} type={type === 'date' ? 'date' : 'text'} value={val} required={required} disabled={readOnly || (!!id && k === 'code')} onChange={(e) => set(e.target.value)} />
        )}
      </label>
    );
  };

  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-black/30" onClick={onClose}>
      <form onSubmit={save} onClick={(e) => e.stopPropagation()} className="w-full max-w-2xl bg-white h-full overflow-y-auto p-5 space-y-5">
        <div className="flex items-center gap-3">
          <h2 className="font-semibold">{id ? 'Employee' : 'New employee'}</h2>
          {id && can('employee.sensitive') && !revealed && (
            <button type="button" onClick={() => loadEmployee(true)} className="flex items-center gap-1 text-xs border rounded px-2 py-1"><Eye size={14} /> Reveal bank/PAN/Aadhaar</button>
          )}
          <button type="button" onClick={onClose} className="ml-auto" aria-label="Close"><X size={18} /></button>
        </div>
        {err && <ErrorBox text={err} />}
        {SECTIONS.map((s) => (
          <section key={s.title}>
            <h3 className="text-sm font-medium mb-2">{s.title}</h3>
            <div className="grid sm:grid-cols-2 gap-3">{s.fields.map(([k, l, t]) => input(k, l, t))}</div>
            {s.title === 'Statutory' && (
              <div className="flex gap-4 mt-3 text-sm">
                {FLAGS.map(([k, l]) => (
                  <label key={k} className="flex items-center gap-1">
                    <input type="checkbox" disabled={readOnly} checked={!!form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.checked })} /> {l}
                  </label>
                ))}
              </div>
            )}
          </section>
        ))}
        {id && can('salary.view') && <EmployeeSalary companyId={companyId} employeeId={id} canManage={can('salary.manage')} />}
        {id && can('documents.view') && (
          <section className="space-y-2">
            <h3 className="text-sm font-medium">Documents</h3>
            <DocumentsPanel basePath={`/companies/${companyId}/employees/${id}/documents`} kind="employee" canManage={can('documents.manage')} />
          </section>
        )}
        {!readOnly && <button disabled={busy} className="bg-slate-900 text-white rounded-md px-4 py-2 text-sm disabled:opacity-60">{busy ? 'Saving…' : 'Save'}</button>}
      </form>
    </div>
  );
}
