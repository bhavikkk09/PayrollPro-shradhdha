// Every report is reduced to the same shape, so CSV, Excel, PDF, JSON and print all render from one source.
export type ColType = 'text' | 'money' | 'number' | 'date';

export interface Col {
  key: string;
  label: string;
  type?: ColType;
  align?: 'left' | 'right' | 'center';
  total?: boolean; // sum this column in the totals row
}
export type Cell = string | number | null;
export type Row = Record<string, Cell>;

export interface ReportResult {
  kind: string;
  title: string;
  subtitle: string; // period / scope line
  company: { name: string; address?: string };
  columns: Col[];
  rows: Row[];
  totals?: Row;
  notes: string[];
  provisional: boolean; // built from a payroll that is not approved yet
}

export interface ReportContext {
  company: { name: string; address?: string };
  subtitle: string;
  provisional: boolean;
}

export const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Builds a ReportResult and computes the totals row from columns flagged `total`. */
export function makeReport(kind: string, title: string, ctx: ReportContext, columns: Col[], rows: Row[], notes: string[] = []): ReportResult {
  const totalCols = columns.filter((c) => c.total);
  let totals: Row | undefined;
  if (totalCols.length) {
    totals = { [columns[0].key]: 'Total' };
    for (const c of totalCols) totals[c.key] = r2(rows.reduce((s, r) => s + (typeof r[c.key] === 'number' ? (r[c.key] as number) : 0), 0));
  }
  return { kind, title, subtitle: ctx.subtitle, company: ctx.company, columns, rows, totals, notes, provisional: ctx.provisional };
}
