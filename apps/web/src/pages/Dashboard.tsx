import { useEffect, useState } from 'react';
import { api } from '../api';
import { Badge, Card, Empty, ErrorBox } from '../components/ui';

interface Summary {
  period: { year: number; month: number };
  totals: { companies: number; activeCompanies: number; employees: number; payrollCompleted: number; payrollPending: number; attendancePending: number };
  compliancePending: Record<string, number>;
  upcomingDue: { id: string; company: string; name: string; module: string; dueDate: string; status: string }[];
  recentPayroll: { id: string; company: string; year: number; month: number; status: string }[];
  recentActivity: { id: string; action: string; module: string; at: string }[];
  companies: { id: string; name: string; employees: number; attendance: string; payroll: string; status: string }[];
}

export default function Dashboard({ companyId }: { companyId: string }) {
  const [d, setD] = useState<Summary | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    setD(null); setErr('');
    api<Summary>('/dashboard/summary').then(setD).catch((e) => setErr(e.message));
  }, []);

  if (err) return <ErrorBox text={err} />;
  if (!d) return <div className="text-sm text-slate-500">Loading dashboard…</div>;

  const rows = companyId === 'ALL' ? d.companies : d.companies.filter((c) => c.id === companyId);
  const t = d.totals;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Dashboard <span className="text-sm font-normal text-slate-500">· {String(d.period.month).padStart(2, '0')}/{d.period.year}</span></h1>

      <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
        <Card title="Total companies" value={t.companies} />
        <Card title="Active companies" value={t.activeCompanies} />
        <Card title="Total employees" value={t.employees} />
        <Card title="Payroll completed" value={t.payrollCompleted} />
        <Card title="Payroll pending" value={t.payrollPending} />
        <Card title="Attendance pending" value={t.attendancePending} />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {Object.entries(d.compliancePending).map(([k, v]) => <Card key={k} title={`${k} pending`} value={v} />)}
      </div>

      <section className="bg-white border rounded-xl">
        <h2 className="px-4 py-3 font-medium border-b">Company status</h2>
        {rows.length === 0 ? <Empty text="No companies yet." /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-slate-500"><tr>
                {['Company', 'Employees', 'Attendance', 'Payroll', 'Status'].map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}
              </tr></thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className="border-t">
                    <td className="px-4 py-2">{c.name}</td>
                    <td className="px-4 py-2">{c.employees}</td>
                    <td className="px-4 py-2"><Badge value={c.attendance} /></td>
                    <td className="px-4 py-2"><Badge value={c.payroll} /></td>
                    <td className="px-4 py-2"><Badge value={c.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="grid md:grid-cols-3 gap-4">
        <List title="Upcoming compliance due" empty="Nothing due soon.">
          {d.upcomingDue.map((x) => (
            <li key={x.id} className="flex justify-between gap-2"><span>{x.company} · {x.name}</span><span className="text-slate-500">{x.dueDate.slice(0, 10)}</span></li>
          ))}
        </List>
        <List title="Recently processed payroll" empty="No processed payroll yet.">
          {d.recentPayroll.map((x) => (
            <li key={x.id} className="flex justify-between gap-2"><span>{x.company} · {x.month}/{x.year}</span><Badge value={x.status} /></li>
          ))}
        </List>
        <List title="Recent activity" empty="No activity yet.">
          {d.recentActivity.map((x) => (
            <li key={x.id} className="flex justify-between gap-2"><span>{x.action.replaceAll('_', ' ').toLowerCase()}</span><span className="text-slate-500">{new Date(x.at).toLocaleString()}</span></li>
          ))}
        </List>
      </div>
    </div>
  );
}

function List({ title, empty, children }: { title: string; empty: string; children: React.ReactNode[] }) {
  return (
    <section className="bg-white border rounded-xl">
      <h2 className="px-4 py-3 font-medium border-b">{title}</h2>
      {children.length === 0 ? <Empty text={empty} /> : <ul className="p-4 space-y-2 text-sm">{children}</ul>}
    </section>
  );
}
