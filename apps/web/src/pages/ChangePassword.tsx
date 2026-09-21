import { useState, type FormEvent } from 'react';
import { changePassword, type Session } from '../api';
import { ErrorBox } from '../components/ui';

/** Used both as a forced screen (temporary password) and as a voluntary dialog. */
export default function ChangePassword({ forced, onDone, onCancel, onSignOut }: { forced: boolean; onDone: (s: Session) => void; onCancel?: () => void; onSignOut?: () => void }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    if (next !== again) return setErr('The new passwords do not match');
    setBusy(true);
    try { onDone(await changePassword(cur, next)); }
    catch (x) { setErr(x instanceof Error ? x.message : 'Could not change password'); }
    finally { setBusy(false); }
  };

  const box = (
    <form onSubmit={submit} className="w-full max-w-sm bg-white border rounded-xl p-6 shadow-sm space-y-3" onClick={(e) => e.stopPropagation()}>
      <div>
        <h1 className="text-lg font-semibold">{forced ? 'Choose a new password' : 'Change password'}</h1>
        {forced && <p className="text-sm text-slate-500">You signed in with a temporary password. Set your own to continue.</p>}
      </div>
      {err && <ErrorBox text={err} />}
      <input className="w-full border rounded-md px-3 py-2 text-sm" type="password" placeholder={forced ? 'Temporary password' : 'Current password'} autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required autoFocus />
      <input className="w-full border rounded-md px-3 py-2 text-sm" type="password" placeholder="New password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
      <input className="w-full border rounded-md px-3 py-2 text-sm" type="password" placeholder="Repeat new password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} required />
      <p className="text-xs text-slate-500">At least 10 characters, with a letter and a number.</p>
      <div className="flex gap-2">
        <button disabled={busy} className="bg-slate-900 text-white rounded-md px-4 py-2 text-sm disabled:opacity-60">{busy ? 'Saving…' : 'Save password'}</button>
        {forced ? <button type="button" onClick={onSignOut} className="text-sm text-slate-600 px-2">Sign out</button> : <button type="button" onClick={onCancel} className="text-sm text-slate-600 px-2">Cancel</button>}
      </div>
    </form>
  );
  return forced
    ? <div className="min-h-screen grid place-items-center px-4">{box}</div>
    : <div className="fixed inset-0 z-40 bg-black/30 grid place-items-center px-4" onClick={onCancel}>{box}</div>;
}
