import { useEffect, useState } from 'react';
import { Building2, LayoutDashboard, LogOut, Users, Wallet, ShieldCheck, FileText, Menu } from 'lucide-react';
import { api, getSession, setSession, type Session } from './api';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Companies, { type Company } from './pages/Companies';

type Page = 'dashboard' | 'companies';

const NAV: { key: Page | 'soon'; label: string; icon: typeof Users; soon?: boolean }[] = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { key: 'companies', label: 'Companies', icon: Building2 },
  { key: 'soon', label: 'Employees', icon: Users, soon: true },
  { key: 'soon', label: 'Payroll', icon: Wallet, soon: true },
  { key: 'soon', label: 'Compliance', icon: ShieldCheck, soon: true },
  { key: 'soon', label: 'Reports', icon: FileText, soon: true },
];

export default function App() {
  const [session, setSess] = useState<Session | null>(getSession());
  const [page, setPage] = useState<Page>('dashboard');
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState<string>('ALL'); // company context for every page
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!session) return;
    api<{ items: Company[] }>('/companies?pageSize=100').then((r) => setCompanies(r.items)).catch(() => setCompanies([]));
  }, [session, page]);

  if (!session) return <Login onDone={setSess} />;

  const canAll = session.user.type !== 'CLIENT';
  const logout = () => { setSession(null); setSess(null); };

  return (
    <div className="min-h-screen flex">
      <aside className={`${open ? 'block' : 'hidden'} md:block w-60 bg-slate-900 text-slate-200 shrink-0 fixed md:static inset-y-0 z-20`}>
        <div className="px-5 py-5 text-lg font-semibold text-white">LabourConsultPro</div>
        <nav className="px-2 space-y-1">
          {NAV.map((n) => (
            <button
              key={n.label}
              disabled={n.soon}
              onClick={() => { if (!n.soon) { setPage(n.key as Page); setOpen(false); } }}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm text-left ${
                page === n.key ? 'bg-slate-700 text-white' : n.soon ? 'text-slate-500 cursor-not-allowed' : 'hover:bg-slate-800'
              }`}
            >
              <n.icon size={16} /> {n.label}
              {n.soon && <span className="ml-auto text-[10px] uppercase tracking-wide">soon</span>}
            </button>
          ))}
        </nav>
      </aside>

      <div className="flex-1 min-w-0">
        <header className="h-14 bg-white border-b flex items-center gap-3 px-4">
          <button className="md:hidden" onClick={() => setOpen(!open)} aria-label="Menu"><Menu size={20} /></button>
          <label className="text-xs text-slate-500 hidden sm:block">Current company</label>
          <select
            value={companyId}
            onChange={(e) => setCompanyId(e.target.value)}
            className="border rounded-md px-2 py-1.5 text-sm max-w-[220px]"
          >
            {canAll && <option value="ALL">All companies</option>}
            {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="hidden sm:block text-slate-600">{session.user.name}</span>
            <button onClick={logout} className="flex items-center gap-1 text-slate-600 hover:text-slate-900"><LogOut size={16} /> Sign out</button>
          </div>
        </header>
        <main className="p-4 md:p-6">
          {page === 'dashboard' && <Dashboard companyId={companyId} />}
          {page === 'companies' && <Companies session={session} />}
        </main>
      </div>
    </div>
  );
}
