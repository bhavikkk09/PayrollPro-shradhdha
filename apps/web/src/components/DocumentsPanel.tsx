import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Eye, Trash2, Upload } from 'lucide-react';
import { api, download, previewFile, uploadFile } from '../api';
import { Empty, ErrorBox } from './ui';

export interface Doc { id: string; title: string; category: string; fileName: string; mimeType: string; sizeBytes: number; expiryDate: string | null; reminderDaysBefore: number | null; createdAt: string }

const COMPANY_CATEGORIES: [string, string][] = [
  ['REGISTRATION_CERTIFICATE', 'Registration certificate'], ['PF', 'PF'], ['ESI', 'ESI'], ['LABOUR_LICENSE', 'Labour licence'],
  ['EMPLOYEE', 'Employee'], ['PAYROLL', 'Payroll'], ['COMPLIANCE', 'Compliance'], ['OTHER', 'Other'],
];
const EMPLOYEE_CATEGORIES: [string, string][] = [
  ['ID_PROOF', 'ID proof'], ['ADDRESS_PROOF', 'Address proof'], ['EDUCATION', 'Education'], ['APPOINTMENT_LETTER', 'Appointment letter'],
  ['BANK', 'Bank'], ['MEDICAL', 'Medical'], ['OTHER', 'Other'],
];
const CAT_LABEL = Object.fromEntries([...COMPANY_CATEGORIES, ...EMPLOYEE_CATEGORIES]);
const PREVIEWABLE = ['application/pdf', 'image/png', 'image/jpeg'];
const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

const today = () => new Date().toISOString().slice(0, 10);
const expiryTone = (d: string | null) => {
  if (!d) return '';
  const days = Math.ceil((Date.parse(d) - Date.parse(today())) / 86_400_000);
  return days < 0 ? 'text-red-700' : days <= 30 ? 'text-amber-700' : 'text-slate-500';
};

/** Reused for company documents, employee documents and compliance-task attachments (basePath differs only in prefix). */
export default function DocumentsPanel({ basePath, kind, canManage, showExpiry = true }: { basePath: string; kind: 'company' | 'employee' | 'task'; canManage: boolean; showExpiry?: boolean }) {
  const [items, setItems] = useState<Doc[]>([]);
  const [total, setTotal] = useState(0);
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState({ category: kind === 'employee' ? 'OTHER' : 'OTHER', title: '', expiryDate: '', reminderDaysBefore: '30' });
  const categories = kind === 'employee' ? EMPLOYEE_CATEGORIES : COMPANY_CATEGORIES;

  const load = useCallback(() => {
    const qs = new URLSearchParams({ page: '1', pageSize: '100' });
    if (category) qs.set('category', category);
    if (search) qs.set('search', search);
    api<{ items: Doc[]; total: number }>(`${basePath}?${qs}`).then((r) => { setItems(r.items); setTotal(r.total); }).catch((e) => setErr(e.message));
  }, [basePath, category, search]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true); setErr('');
    try {
      await uploadFile(basePath, file, kind === 'task' ? {} : { category: form.category, title: form.title || undefined, expiryDate: form.expiryDate || undefined, reminderDaysBefore: form.expiryDate ? form.reminderDaysBefore : undefined });
      setForm({ ...form, title: '', expiryDate: '' });
      load();
    } catch (x) { setErr(x instanceof Error ? x.message : 'Upload failed'); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  };
  const view = (d: Doc) => previewFile(`${basePath}/${d.id}/file`).catch((x) => setErr(x instanceof Error ? x.message : 'Failed'));
  const dl = (d: Doc) => download(`${basePath}/${d.id}/file`).catch((x) => setErr(x instanceof Error ? x.message : 'Failed'));
  const del = async (d: Doc) => {
    if (!confirm(`Delete "${d.title}"?`)) return;
    setErr('');
    try { await api(`${basePath}/${d.id}`, { method: 'DELETE' }); load(); }
    catch (x) { setErr(x instanceof Error ? x.message : 'Failed'); }
  };

  return (
    <div className="space-y-3">
      {err && <ErrorBox text={err} />}
      <div className="flex flex-wrap items-center gap-2">
        {kind !== 'task' && (
          <>
            <select className="border rounded-md px-2 py-1.5 text-sm" value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">All categories</option>{categories.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <input className="border rounded-md px-2 py-1.5 text-sm w-48" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
          </>
        )}
      </div>

      {canManage && (
        <div className="bg-white border rounded-xl p-3 flex flex-wrap gap-2 items-end">
          {kind !== 'task' && (
            <>
              <label className="text-xs text-slate-600">Category
                <select className="block mt-1 border rounded-md px-2 py-1.5 text-sm" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                  {categories.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select></label>
              {kind === 'company' && <label className="text-xs text-slate-600">Title<input className="block mt-1 border rounded-md px-2 py-1.5 text-sm w-40" placeholder="(defaults to file name)" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>}
              <label className="text-xs text-slate-600">Expiry date (optional)<input className="block mt-1 border rounded-md px-2 py-1.5 text-sm" type="date" value={form.expiryDate} onChange={(e) => setForm({ ...form, expiryDate: e.target.value })} /></label>
              {form.expiryDate && kind === 'company' && <label className="text-xs text-slate-600">Remind (days before)<input className="block mt-1 border rounded-md px-2 py-1.5 text-sm w-24" type="number" min={0} value={form.reminderDaysBefore} onChange={(e) => setForm({ ...form, reminderDaysBefore: e.target.value })} /></label>}
            </>
          )}
          <label className="flex items-center gap-1 bg-slate-900 text-white rounded-md px-3 py-1.5 text-sm cursor-pointer">
            <Upload size={14} /> {busy ? 'Uploading…' : 'Upload file'}
            <input ref={fileRef} type="file" className="hidden" disabled={busy} accept=".pdf,.png,.jpg,.jpeg,.xlsx,.docx,.xls,.doc,.csv,.txt" onChange={(e) => pick(e.target.files?.[0])} />
          </label>
          <span className="text-xs text-slate-400">PDF, images, Office files, CSV/TXT — up to 10 MB.</span>
        </div>
      )}

      <div className="bg-white border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-slate-500"><tr>
            {kind !== 'task' && <th className="px-3 py-2 font-medium">Category</th>}
            <th className="px-3 py-2 font-medium">{kind === 'company' ? 'Title' : 'File'}</th>
            <th className="px-3 py-2 font-medium">Size</th>
            {showExpiry && kind !== 'task' && <th className="px-3 py-2 font-medium">Expiry</th>}
            <th className="px-3 py-2 font-medium">Uploaded</th>
            <th className="px-3 py-2" />
          </tr></thead>
          <tbody>
            {items.map((d) => (
              <tr key={d.id} className="border-t">
                {kind !== 'task' && <td className="px-3 py-2 text-xs text-slate-500">{CAT_LABEL[d.category] ?? d.category}</td>}
                <td className="px-3 py-2">{kind === 'company' ? d.title : d.fileName}{kind === 'company' && <div className="text-xs text-slate-400">{d.fileName}</div>}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{fmtSize(d.sizeBytes)}</td>
                {showExpiry && kind !== 'task' && <td className={`px-3 py-2 text-xs ${expiryTone(d.expiryDate)}`}>{d.expiryDate ?? '—'}</td>}
                <td className="px-3 py-2 text-xs text-slate-500">{d.createdAt.slice(0, 10)}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap space-x-2">
                  {PREVIEWABLE.includes(d.mimeType) && <button onClick={() => view(d)} aria-label="Preview" className="text-slate-500 hover:text-slate-800"><Eye size={16} /></button>}
                  <button onClick={() => dl(d)} aria-label="Download" className="text-slate-500 hover:text-slate-800"><Download size={16} /></button>
                  {canManage && <button onClick={() => del(d)} aria-label="Delete" className="text-slate-400 hover:text-red-600"><Trash2 size={16} /></button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {items.length === 0 && <Empty text="No documents uploaded yet." />}
      </div>
      {total > items.length && <div className="text-xs text-slate-500">Showing {items.length} of {total}.</div>}
    </div>
  );
}
