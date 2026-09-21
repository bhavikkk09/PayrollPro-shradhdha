import { useEffect, useState, type ReactNode } from 'react';
import { Building2, LayoutDashboard, LogOut, Users, Network, Coins, CalendarCheck, CalendarOff, Clock, Wallet, Layers, Scale, ShieldCheck, FileText, Menu, KeyRound, UserCog } from 'lucide-react';
import { api, getSession, setSession, type Session } from './api';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Portal from './pages/Portal';
import ChangePassword from './pages/ChangePassword';
import UsersPage from './pages/Users';
import Employees from './pages/Employees';
import Reports from './pages/Reports';
import Compliance from './pages/Compliance';
import ComplianceRules from './pages/ComplianceRules';
import Payroll from './pages/Payroll';
import BulkPayroll from './pages/BulkPayroll';
import Attendance from './pages/Attendance';
import Leave from './pages/Leave';
import Shifts from './pages/Shifts';
import Salary from './pages/Salary';
import Organisation from './pages/Organisation';
import Companies, { type Company } from './pages/Companies';

type Page = 'dashboard' | 'companies' | 'employees' | 'organisation' | 'salary' | 'attendance' | 'leave' | 'shifts' | 'payroll' | 'bulk' | 'compliance' | 'rules' | 'reports' | 'users';

// `internal` items exist only for the consultant firm; `perm` hides items the user could not use anyway.
const NAV: { key: Page; label: string; icon: typeof Users; perm?: string; internal?: boolean }[] = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { key: 'companies', label: 'Companies', icon: Building2, perm: 'company.view', internal: true },
  { key: 'organisation', label: 'Organisation', icon: Network, perm: 'company.view' },
  { key: 'employees', label: 'Employees', icon: Users, perm: 'employee.view' },
  { key: 'salary', label: 'Salary', icon: Coins, perm: 'salary.view' },
  { key: 'attendance', label: 'Attendance', icon: CalendarCheck, perm: 'attendance.view' },
  { key: 'leave', label: 'Leave', icon: CalendarOff, perm: 'leave.view' },
  { key: 'shifts', label: 'Shifts', icon: Clock, perm: 'attendance.view', internal: true },
  { key: 'payroll', label: 'Payroll', icon: Wallet, perm: 'payroll.view' },
  { key: 'bulk', label: 'Bulk payroll', icon: Layers, perm: 'payroll.process', internal: true },
  { key: 'compliance', label: 'Compliance', icon: ShieldCheck, perm: 'compliance.view' },
  { key: 'rules', label: 'Compliance rules', icon: Scale, perm: 'compliance.view', internal: true },
  { key: 'reports', label: 'Reports', icon: FileText, perm: 'reports.view' },
  { key: 'users', label: 'Users', icon: UserCog, perm: 'users.manage', internal: true },
];

export default function App() {
  const [session, setSess] = useState<Session | null>(getSession());
  const [page, setPage] = useState<Page>('dashboard');
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState<string>('ALL'); // company context for every page
  const [open, setOpen] = useState(false);
  const [shiftEnabled, setShiftEnabled] = useState(false); // shift screens exist only for companies that enabled them
  const [pwDialog, setPwDialog] = useState(false);

  const mustChange = !!session?.user.mustChangePassword;

  useEffect(() => {
    if (!session || mustChange) return;
    api<{ items: Company[] }>('/companies?pageSize=100').then((r) => setCompanies(r.items)).catch(() => setCompanies([]));
  }, [session, page, mustChange]);

  useEffect(() => {
    if (session && session.user.type === 'CLIENT' && companyId === 'ALL' && companies.length) setCompanyId(companies[0].id);
  }, [session, companies, companyId]);

  useEffect(() => {
    setShiftEnabled(false);
    if (!session || mustChange || companyId === 'ALL' || session.user.type === 'CLIENT') return;
    api<Company>(`/companies/${companyId}`).then((c) => setShiftEnabled(!!c.settings?.shiftEnabled)).catch(() => undefined);
  }, [session, companyId, page, mustChange]);

  const logout = () => { setSession(null); setSess(null); setCompanyId('ALL'); setPage('dashboard'); };
  if (!session) return <Login onDone={setSess} />;
  if (mustChange) return <ChangePassword forced onDone={setSess} onSignOut={logout} />;

  const isClient = session.user.type === 'CLIENT';
  const can = (p?: string) => !p || session.user.permissions.includes(p);
  const nav = NAV.filter((n) => (!n.internal || !isClient) && can(n.perm) && (n.key !== 'shifts' || shiftEnabled));
  const canAll = !isClient;
  const scoped = (node: ReactNode) => companyId === 'ALL'
    ? <div className="text-sm text-slate-600 bg-white border rounded-xl p-6">Select a company from the top bar to continue.</div>
    : node;
  const key = companyId;

  return (
    <div className="min-h-screen flex">
      <aside className={`print:hidden ${open ? 'block' : 'hidden'} md:block w-60 bg-slate-900 text-slate-200 shrink-0 fixed md:static inset-y-0 z-20`}>
        <div className="px-5 py-5 text-lg font-semibold text-white">LabourConsultPro</div>
        <nav className="px-2 space-y-1">
          {nav.map((n) => (
            <button
              key={n.key}
              onClick={() => { setPage(n.key); setOpen(false); }}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm text-left ${page === n.key ? 'bg-slate-700 text-white' : 'hover:bg-slate-800'}`}
            >
              <n.icon size={16} /> {n.key === 'dashboard' && isClient ? 'Home' : n.label}
            </button>
          ))}
        </nav>
      </aside>

      <div className="flex-1 min-w-0">
        <header className="print:hidden h-14 bg-white border-b flex items-center gap-3 px-4">
          <button className="md:hidden" onClick={() => setOpen(!open)} aria-label="Menu"><Menu size={20} /></button>
          {(canAll || companies.length > 1) ? (
            <>
              <label className="text-xs text-slate-500 hidden sm:block">Current company</label>
              <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className="border rounded-md px-2 py-1.5 text-sm max-w-[220px]">
                {canAll && <option value="ALL">All companies</option>}
                {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </>
          ) : <span className="text-sm text-slate-600">{companies[0]?.name}</span>}
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="hidden sm:block text-slate-600">{session.user.name}</span>
            <button onClick={() => setPwDialog(true)} className="flex items-center gap-1 text-slate-600 hover:text-slate-900" title="Change password"><KeyRound size={16} /><span className="hidden sm:inline">Password</span></button>
            <button onClick={logout} className="flex items-center gap-1 text-slate-600 hover:text-slate-900"><LogOut size={16} /> Sign out</button>
          </div>
        </header>
        <main className="p-4 md:p-6">
          {page === 'dashboard' && (isClient
            ? scoped(<Portal key={key} companyId={companyId} session={session} go={setPage} />)
            : <Dashboard companyId={companyId} />)}
          {page === 'companies' && !isClient && <Companies session={session} />}
          {page === 'rules' && !isClient && <ComplianceRules session={session} />}
          {page === 'bulk' && !isClient && <BulkPayroll companies={companies} session={session} />}
          {page === 'users' && !isClient && <UsersPage companies={companies} session={session} />}
          {page === 'compliance' && <Compliance key={key} companyId={companyId} session={session} />}
          {page === 'salary' && scoped(<Salary key={key} companyId={companyId} session={session} />)}
          {page === 'employees' && scoped(<Employees key={key} companyId={companyId} session={session} />)}
          {page === 'reports' && scoped(<Reports key={key} companyId={companyId} session={session} />)}
          {page === 'payroll' && scoped(<Payroll key={key} companyId={companyId} session={session} />)}
          {page === 'attendance' && scoped(<Attendance key={key} companyId={companyId} session={session} />)}
          {page === 'leave' && scoped(<Leave key={key} companyId={companyId} session={session} />)}
          {page === 'shifts' && !isClient && scoped(shiftEnabled ? <Shifts key={key} companyId={companyId} session={session} /> : <div className="text-sm text-slate-600">Shift management is disabled for this company.</div>)}
          {page === 'organisation' && scoped(<Organisation key={key} companyId={companyId} session={session} />)}
        </main>
      </div>
      {pwDialog && <ChangePassword forced={false} onDone={(s) => { setSess(s); setPwDialog(false); }} onCancel={() => setPwDialog(false)} />}
    </div>
  );
}
