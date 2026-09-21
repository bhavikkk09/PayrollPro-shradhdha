import { useState, type FormEvent } from 'react';
import { login, type Session } from '../api';

export default function Login({ onDone }: { onDone: (s: Session) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try { onDone(await login(email, password)); }
    catch (x) { setErr(x instanceof Error ? x.message : 'Login failed'); }
    finally { setBusy(false); }
  };

  return (
    <div className="min-h-screen grid place-items-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm bg-white border rounded-xl p-6 shadow-sm space-y-4">
        <div>
          <h1 className="text-xl font-semibold">LabourConsultPro</h1>
          <p className="text-sm text-slate-500">Sign in to your consultant account</p>
        </div>
        {err && <div role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">{err}</div>}
        <input className="w-full border rounded-md px-3 py-2 text-sm" type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        <input className="w-full border rounded-md px-3 py-2 text-sm" type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <button disabled={busy} className="w-full bg-slate-900 text-white rounded-md py-2 text-sm disabled:opacity-60">{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}
