import { useEffect, useState } from 'react';
import { api } from '../api';

export interface EmpLite { id: string; code: string; firstName: string; lastName?: string | null }
export const empName = (e: EmpLite) => `${e.code} · ${[e.firstName, e.lastName].filter(Boolean).join(' ')}`;

/** Search-as-you-type employee chooser (server-side search, never loads the whole table). */
export default function EmployeePicker({ companyId, value, onChange }: { companyId: string; value: EmpLite | null; onChange: (e: EmpLite | null) => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<EmpLite[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      api<{ items: EmpLite[] }>(`/companies/${companyId}/employees?pageSize=10${q ? `&search=${encodeURIComponent(q)}` : ''}`).then((r) => setResults(r.items)).catch(() => setResults([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q, open, companyId]);

  return (
    <div className="relative">
      <input
        className="border rounded-md px-2 py-1.5 text-sm w-64" placeholder="Search employee code or name"
        value={open ? q : value ? empName(value) : q}
        onFocus={() => { setOpen(true); setQ(''); }}
        onChange={(e) => { setQ(e.target.value); if (value) onChange(null); }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && results.length > 0 && (
        <ul className="absolute z-20 bg-white border rounded-md mt-1 w-64 max-h-56 overflow-y-auto shadow">
          {results.map((e) => (
            <li key={e.id}><button type="button" className="w-full text-left px-3 py-1.5 text-sm hover:bg-slate-50" onMouseDown={() => { onChange(e); setOpen(false); }}>{empName(e)}</button></li>
          ))}
        </ul>
      )}
    </div>
  );
}
