import { useEffect, useState } from 'react';
import { api, download, type Session } from '../api';
import { Badge, Card, Empty, ErrorBox } from '../components/ui';

interface Run { id: string; year: number; month: number; status: string; totalNet: string | null; _count: { details: number } }
interface Task { id: string; name: string; dueDate: string; status: string; completedAt: string | null }

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const FINAL = ['APPROVED', 'LOCKED'];

/** Home screen for client-portal users: what needs doing this month, in plain terms. */
export default function Portal({ companyId, session, go }: { companyId: string; session: Session; go: (p: 'attendance' | 'payroll' | 'employees' | 'reports' | 'compliance') => void }) {
  const now = new Date();
  const [name, setName] = useState('');
  const [emps, setEmps] = useState<number | null>(null);
  const [att, setAtt] = useState<{ finalized: boolean } | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [err, setErr] = useState('');
  const can = (p: string) => session.user.permissions.includes(p);
  const y = now.getFullYear(), m = now.getMonth() + 1;

  useEffect(() => {
    setErr('');
    const base = `/companies/${companyId}`;
    api<{ name: string }>(base).then((c) => setName(c.name)).catch((e) => setErr(e.message));
    if (can('employee.view')) api<{ total: number }>(`${base}/employees?pageSize=1&status=ACTIVE`).then((r) => setEmps(r.total)).catch(() => undefined);
    if (can('attendance.view')) api<{ finalized: boolean }>(`${base}/attendance?year=${y}&month=${m}&pageSize=1`).then(setAtt).catch(() => undefined);
    if (can('payroll.view')) api<Run[]>(`${base}/payroll/runs?year=${y}`).then((a) => { if (m === 1) api<Run[]>(`${base}/payroll/runs?year=${y - 1}`).then((b) => setRuns([...a, ...b])).catch(() => setRuns(a)); else setRuns(a); }).catch(() => undefined);
    if (can('compliance.view')) api<{ items: Task[] }>(`/compliance/calendar?companyId=${companyId}&pageSize=100`).then((r) => setTasks(r.items)).catch(() => undefined);
  }, [companyId]); // eslint-disable-line react-hooks/exhaustive-deps

  const sorted = [...runs].sort((a, b) => b.year * 12 + b.month - (a.year * 12 + a.month));
  const latestFinal = sorted.find((r) => FINAL.includes(r.status) && r._count.details > 0);
  const thisMonth = sorted.find((r) => r.year === y && r.month === m);
  const open = tasks.filter((t) => t.status !== 'COMPLETED');
  const overdue = open.filter((t) => t.status === 'OVERDUE').length;
  const soon = open.filter((t) => t.status === 'DUE_SOON').length;
  const payslips = (r: Run, label: string) => can('reports.export') && (
    <button className="border rounded-md px-3 py-1.5 text-sm bg-white" onClick={() => download(`/companies/${companyId}/payslips/${r.id}`).catch((e) => setErr(e.message))}>{label}</button>
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">{name || 'Your company'}</h1>
        <p className="text-sm text-slate-500">Welcome, {session.user.name}. Here is where things stand for {MONTHS[m - 1]} {y}.</p>
      </div>
      {err && <ErrorBox text={err} />}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card title="Active employees" value={emps ?? '—'} />
        <Card title="Attendance" value={att ? (att.finalized ? 'Finalized' : 'Open') : '—'} hint={att && !att.finalized ? 'Upload or mark attendance' : undefined} />
        <Card title="This month's payroll" value={thisMonth ? thisMonth.status.charAt(0) + thisMonth.status.slice(1).toLowerCase() : 'Not started'} />
        <Card title="Compliance" value={<span className={overdue ? 'text-red-700' : ''}>{overdue ? `${overdue} overdue` : soon ? `${soon} due soon` : 'On track'}</span>} />
      </div>

      <div className="flex flex-wrap gap-2">
        {can('attendance.manage') && <button onClick={() => go('attendance')} className="bg-slate-900 text-white rounded-md px-4 py-2 text-sm">Upload attendance</button>}
        {can('employee.view') && <button onClick={() => go('employees')} className="border rounded-md px-4 py-2 text-sm bg-white">View employees</button>}
        {can('payroll.view') && <button onClick={() => go('payroll')} className="border rounded-md px-4 py-2 text-sm bg-white">View payroll</button>}
        {can('reports.view') && <button onClick={() => go('reports')} className="border rounded-md px-4 py-2 text-sm bg-white">Reports</button>}
      </div>

      {can('payroll.view') && (
        <section className="bg-white border rounded-xl">
          <h2 className="px-4 py-3 font-medium border-b">Latest approved payroll</h2>
          {latestFinal ? (
            <div className="px-4 py-3 flex flex-wrap items-center gap-3 text-sm">
              <span className="font-medium">{MONTHS[latestFinal.month - 1]} {latestFinal.year}</span>
              <Badge value="Completed" />
              <span className="text-slate-500">{latestFinal._count.details} employees</span>
              <span className="ml-auto flex gap-2">{payslips(latestFinal, 'Download payslips (PDF)')}</span>
            </div>
          ) : <Empty text="No approved payroll yet." />}
        </section>
      )}

      {can('compliance.view') && (
        <section className="bg-white border rounded-xl">
          <div className="flex items-center px-4 py-3 border-b"><h2 className="font-medium">Compliance status</h2><button onClick={() => go('compliance')} className="ml-auto text-sm text-slate-600">See all</button></div>
          {tasks.length === 0 ? <Empty text="No compliance filings scheduled." /> : (
            <table className="w-full text-sm">
              <tbody>
                {[...tasks].sort((a, b) => a.dueDate.localeCompare(b.dueDate)).filter((t) => t.status !== 'COMPLETED').slice(0, 8).concat(tasks.filter((t) => t.status === 'COMPLETED').slice(-3)).map((t) => (
                  <tr key={t.id} className="border-t"><td className="px-4 py-2">{t.name}</td><td className="px-4 py-2 text-slate-500">due {t.dueDate.slice(0, 10)}</td><td className="px-4 py-2 text-right"><Badge value={t.status} /></td></tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}
