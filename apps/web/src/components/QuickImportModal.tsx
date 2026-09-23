import { useState } from 'react';
import { api } from '../api';
import { parseQuickAttendanceFile } from './parseSheet';
import { ErrorBox, Modal } from './ui';

interface QuickValidation { jobId: string; totalRows: number; validRows: number; errorRows: number; errors: { row: number; message: string }[]; preview: { employeeCode: string; paidDays: number }[] }

/** Attendance "days worked" CSV/xlsx import - shared by the Attendance and Payroll pages. */
export default function QuickImportModal({ companyId, year, month, onClose, onDone }: { companyId: string; year: number; month: number; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState<QuickValidation | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true); setErr(''); setV(null);
    try {
      const rows = await parseQuickAttendanceFile(f);
      setV(await api<QuickValidation>(`/companies/${companyId}/attendance/quick-import/validate`, { method: 'POST', body: JSON.stringify({ fileName: f.name, year, month, rows }) }));
    } catch (x) { setErr(x instanceof Error ? x.message : 'Could not read file'); }
    finally { setBusy(false); }
  };
  const confirm = async () => {
    setBusy(true); setErr('');
    try { await api(`/companies/${companyId}/attendance/quick-import/${v!.jobId}/confirm`, { method: 'POST', body: JSON.stringify({ skipInvalid: v!.errorRows > 0 }) }); onDone(); }
    catch (x) { setErr(x instanceof Error ? x.message : 'Import failed'); setBusy(false); }
  };

  return (
    <Modal title={`Quick import: days worked (${month}/${year})`} onClose={onClose}>
      <p className="text-sm text-slate-600">
        For when there is no daily register - just how many days each employee worked. Upload .xlsx or .csv with columns:{' '}
        <b>Employee Code, Days Worked</b> (optionally <b>OT Hours</b>). Weekly offs and holidays are still paid automatically;
        salary itself always comes from each employee's assigned salary, not this file. Nothing is saved until you confirm.
      </p>
      <input type="file" accept=".xlsx,.csv" onChange={(e) => pick(e.target.files?.[0])} disabled={busy} />
      {err && <ErrorBox text={err} />}
      {busy && !v && <div className="text-sm text-slate-500">Reading and validating…</div>}
      {v && (
        <div className="space-y-3">
          <div className="text-sm">{v.totalRows} rows · <span className="text-emerald-700">{v.validRows} valid</span> · <span className={v.errorRows ? 'text-red-700' : ''}>{v.errorRows} with errors</span></div>
          {v.errors.length > 0 && (
            <div className="border rounded-md max-h-48 overflow-y-auto text-xs">
              {v.errors.map((e, i) => <div key={i} className="px-3 py-1 border-b text-red-700">{e.row ? `Row ${e.row}: ` : ''}{e.message}</div>)}
            </div>
          )}
          {v.preview.length > 0 && (
            <table className="text-xs w-full border"><thead className="bg-slate-50"><tr><th className="p-1 text-left">Code</th><th className="p-1 text-left">Days worked</th></tr></thead>
              <tbody>{v.preview.map((r, i) => <tr key={i} className="border-t"><td className="p-1">{r.employeeCode}</td><td className="p-1">{r.paidDays}</td></tr>)}</tbody></table>
          )}
          <button disabled={busy || v.validRows === 0} onClick={confirm} className="bg-slate-900 text-white rounded-md px-4 py-2 text-sm disabled:opacity-40">
            {v.errorRows ? `Import ${v.validRows} valid rows only` : `Confirm import (${v.validRows} employees)`}
          </button>
        </div>
      )}
    </Modal>
  );
}
