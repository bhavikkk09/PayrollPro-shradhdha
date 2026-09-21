import type { ReactNode } from 'react';

const TONE: Record<string, string> = {
  OK: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  Completed: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  ACTIVE: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  Warning: 'bg-amber-50 text-amber-700 border-amber-200',
  'In Progress': 'bg-amber-50 text-amber-700 border-amber-200',
  DUE_SOON: 'bg-amber-50 text-amber-700 border-amber-200',
  Pending: 'bg-slate-100 text-slate-700 border-slate-200',
  INACTIVE: 'bg-slate-100 text-slate-700 border-slate-200',
  'Action Required': 'bg-red-50 text-red-700 border-red-200',
  OVERDUE: 'bg-red-50 text-red-700 border-red-200',
  SUSPENDED: 'bg-red-50 text-red-700 border-red-200',
};

export const Badge = ({ value }: { value: string }) => (
  <span className={`inline-block text-xs px-2 py-0.5 rounded-full border ${TONE[value] ?? TONE.Pending}`}>{value.replace('_', ' ')}</span>
);

export const Card = ({ title, value, hint }: { title: string; value: ReactNode; hint?: string }) => (
  <div className="bg-white border rounded-xl p-4">
    <div className="text-xs text-slate-500">{title}</div>
    <div className="text-2xl font-semibold mt-1">{value}</div>
    {hint && <div className="text-xs text-slate-400 mt-1">{hint}</div>}
  </div>
);

export const Empty = ({ text }: { text: string }) => <div className="text-sm text-slate-500 py-8 text-center">{text}</div>;
export const ErrorBox = ({ text }: { text: string }) => (
  <div role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3">{text}</div>
);
