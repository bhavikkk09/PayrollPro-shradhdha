import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Copy, Plus } from 'lucide-react';
import { api, type Session } from '../api';
import { Badge, Empty, ErrorBox } from '../components/ui';
import type { Company } from './Companies';

interface UserRow { id: string; name: string; email: string; type: 'CONSULTANT' | 'CLIENT'; active: boolean; mustChangePassword: boolean; lastLoginAt: string | null; roles: string[]; companies: { id: string; name: string; code: string }[] }
type Roles = { CONSULTANT: string[]; CLIENT: string[] };

const LABEL: Record<string, string> = {
  CONSULTANT_ADMIN: 'Firm admin', CONSULTANT_STAFF: 'Firm staff', PAYROLL_OPERATOR: 'Payroll operator', COMPLIANCE_OPERATOR: 'Compliance operator',
  READ_ONLY: 'Read only', CLIENT_ADMIN: 'Client admin', CLIENT_HR: 'Client HR / user',
};
const inp = 'border rounded-md px-2 py-1.5 text-sm';

export default function Users({ companies, session }: { companies: Company[]; session: Session }) {
  const [rows, setRows] = useState<UserRow[]>([]);
  const [roles, setRoles] = useState<Roles>({ CONSULTANT: [], CLIENT: [] });
  const [search, setSearch] = useState('');
  const [err, setErr] = useState('');
  const [modal, setModal] = useState<{ mode: 'new' } | { mode: 'edit'; user: UserRow } | null>(null);
  const [secret, setSecret] = useState<{ email: string; password: string } | null>(null);

  const load = useCallback(() => {
    api<{ items: UserRow[] }>(`/users?pageSize=100${search ? `&search=${encodeURIComponent(search)}` : ''}`).then((r) => setRows(r.items)).catch((e) => setErr(e.message));
  }, [search]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);
  useEffect(() => { api<Roles>('/users/roles').then(setRoles).catch(() => undefined); }, []);

  const reset = async (u: UserRow) => {
    if (!confirm(`Issue a new temporary password for ${u.name}? Their current password stops working and they are signed out.`)) return;
    try { const r = await api<{ temporaryPassword: string }>(`/users/${u.id}/reset-password`, { method: 'POST' }); setSecret({ email: u.email, password: r.temporaryPassword }); load(); }
    catch (x) { setErr(x instanceof Error ? x.message : 'Failed'); }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Users</h1>
        <input className={`${inp} ml-auto w-full sm:w-64`} placeholder="Search name or email" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button onClick={() => setModal({ mode: 'new' })} className="flex items-center gap-1 bg-slate-900 text-white rounded-md px-3 py-1.5 text-sm"><Plus size={16} /> Add user</button>
      </div>
      <p className="text-sm text-slate-600">Add your own staff, or invite client users so they can see only their company. Role and company changes apply within a few minutes, and the person is signed out.</p>
      {err && <ErrorBox text={err} />}

      <div className="bg-white border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-slate-500"><tr>{['Name', 'Email', 'Role', 'Companies', 'Status', 'Last sign-in', ''].map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id} className="border-t align-top">
                <td className="px-4 py-2">{u.name}{u.id === session.user.id && <span className="text-xs text-slate-400"> (you)</span>}</td>
                <td className="px-4 py-2">{u.email}</td>
                <td className="px-4 py-2"><div>{LABEL[u.roles[0]] ?? u.roles[0]}</div><div className="text-xs text-slate-400">{u.type === 'CLIENT' ? 'Client portal' : 'Firm'}</div></td>
                <td className="px-4 py-2 text-xs text-slate-600 max-w-xs">{u.roles[0] === 'CONSULTANT_ADMIN' ? 'All companies' : u.companies.map((c) => c.name).join(', ') || '—'}</td>
                <td className="px-4 py-2"><Badge value={u.active ? 'ACTIVE' : 'INACTIVE'} />{u.mustChangePassword && <div className="text-xs text-amber-700 mt-1">temp password</div>}</td>
                <td className="px-4 py-2 text-xs text-slate-500">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'never'}</td>
                <td className="px-4 py-2 text-right whitespace-nowrap space-x-3">
                  <button className="text-slate-700" onClick={() => setModal({ mode: 'edit', user: u })}>Edit</button>
                  {u.id !== session.user.id && <button className="text-slate-700" onClick={() => reset(u)}>Reset password</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <Empty text="No users yet." />}
      </div>

      {modal && <UserModal modal={modal} roles={roles} companies={companies} self={modal.mode === 'edit' && modal.user.id === session.user.id} onClose={() => setModal(null)}
        onSaved={(pw) => { setModal(null); if (pw) setSecret(pw); load(); }} />}
      {secret && <Secret s={secret} onClose={() => setSecret(null)} />}
    </div>
  );
}

function Secret({ s, onClose }: { s: { email: string; password: string }; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="fixed inset-0 z-40 bg-black/30 grid place-items-center p-4">
      <div className="bg-white rounded-xl p-5 w-full max-w-md space-y-3">
        <h2 className="font-semibold">Temporary password</h2>
        <p className="text-sm text-slate-600">Give this to <b>{s.email}</b> through a safe channel. It is shown only once, and they must replace it at first sign-in.</p>
        <div className="flex items-center gap-2 bg-slate-50 border rounded-md px-3 py-2">
          <code className="flex-1 text-base tracking-wide">{s.password}</code>
          <button onClick={() => navigator.clipboard.writeText(s.password).then(() => setCopied(true))} className="flex items-center gap-1 text-sm text-slate-700"><Copy size={14} /> {copied ? 'Copied' : 'Copy'}</button>
        </div>
        <button onClick={onClose} className="bg-slate-900 text-white rounded-md px-4 py-1.5 text-sm">Done</button>
      </div>
    </div>
  );
}

function UserModal({ modal, roles, companies, self, onClose, onSaved }: {
  modal: { mode: 'new' } | { mode: 'edit'; user: UserRow }; roles: Roles; companies: Company[]; self: boolean; onClose: () => void; onSaved: (pw?: { email: string; password: string }) => void;
}) {
  const edit = modal.mode === 'edit' ? modal.user : null;
  const [f, setF] = useState({
    name: edit?.name ?? '', email: edit?.email ?? '', type: (edit?.type ?? 'CLIENT') as 'CONSULTANT' | 'CLIENT',
    roleKey: edit?.roles[0] ?? 'CLIENT_ADMIN', active: edit?.active ?? true, password: '',
  });
  const [ids, setIds] = useState<Set<string>>(new Set(edit?.companies.map((c) => c.id) ?? []));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const typeOptions = roles[f.type];
  const isAdminRole = f.type === 'CONSULTANT' && f.roleKey === 'CONSULTANT_ADMIN';

  const setType = (type: 'CONSULTANT' | 'CLIENT') => setF({ ...f, type, roleKey: roles[type][0] ?? f.roleKey });
  const toggle = (id: string) => { const s = new Set(ids); s.has(id) ? s.delete(id) : s.add(id); setIds(s); };

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      if (!edit) {
        const r = await api<{ temporaryPassword?: string }>('/users', { method: 'POST', body: JSON.stringify({
          name: f.name, email: f.email, type: f.type, roleKey: f.roleKey, companyIds: isAdminRole ? [] : [...ids], ...(f.password ? { password: f.password } : {}),
        }) });
        onSaved(r.temporaryPassword ? { email: f.email, password: r.temporaryPassword } : undefined);
      } else {
        await api(`/users/${edit.id}`, { method: 'PATCH', body: JSON.stringify({
          name: f.name, ...(self ? {} : { active: f.active, roleKey: f.roleKey }), companyIds: isAdminRole ? undefined : [...ids],
        }) });
        onSaved();
      }
    } catch (x) { setErr(x instanceof Error ? x.message : 'Failed'); setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-30 bg-black/30 grid place-items-center p-4" onClick={onClose}>
      <form onSubmit={submit} onClick={(e) => e.stopPropagation()} className="bg-white rounded-xl w-full max-w-lg max-h-[92vh] overflow-y-auto p-5 space-y-3">
        <h2 className="font-semibold">{edit ? 'Edit user' : 'Add user'}</h2>
        {err && <ErrorBox text={err} />}
        <div className="grid sm:grid-cols-2 gap-3">
          <label className="text-xs text-slate-600">Name<input className={`${inp} block mt-1 w-full`} required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label className="text-xs text-slate-600">Email<input className={`${inp} block mt-1 w-full`} type="email" required disabled={!!edit} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
          {!edit && (
            <label className="text-xs text-slate-600">Who is this?
              <select className={`${inp} block mt-1 w-full`} value={f.type} onChange={(e) => setType(e.target.value as 'CONSULTANT' | 'CLIENT')}>
                <option value="CLIENT">Client company user (portal)</option><option value="CONSULTANT">My firm's staff</option>
              </select></label>
          )}
          <label className="text-xs text-slate-600">Role
            <select className={`${inp} block mt-1 w-full`} disabled={self} value={f.roleKey} onChange={(e) => setF({ ...f, roleKey: e.target.value })}>
              {typeOptions.map((r) => <option key={r} value={r}>{LABEL[r] ?? r}</option>)}
            </select></label>
        </div>
        {!isAdminRole && (
          <div>
            <div className="text-xs text-slate-600 mb-1">Can access these companies</div>
            <div className="border rounded-md max-h-44 overflow-y-auto">
              {companies.map((c) => (
                <label key={c.id} className="flex items-center gap-2 px-3 py-1.5 text-sm border-b last:border-0"><input type="checkbox" checked={ids.has(c.id)} onChange={() => toggle(c.id)} /> {c.name}</label>
              ))}
              {companies.length === 0 && <div className="px-3 py-2 text-sm text-slate-500">No companies.</div>}
            </div>
          </div>
        )}
        {isAdminRole && <p className="text-xs text-slate-500">Firm admins can access every company of your firm.</p>}
        {edit && !self && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active (untick to block sign-in)</label>}
        {!edit && (
          <label className="text-xs text-slate-600">Password (optional)
            <input className={`${inp} block mt-1 w-full`} type="text" placeholder="Leave blank to generate a temporary one" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
          </label>
        )}
        <div className="flex gap-2">
          <button disabled={busy} className="bg-slate-900 text-white rounded-md px-4 py-1.5 text-sm disabled:opacity-60">{busy ? 'Saving…' : edit ? 'Save' : 'Create user'}</button>
          <button type="button" onClick={onClose} className="text-sm text-slate-600 px-2">Cancel</button>
        </div>
      </form>
    </div>
  );
}
