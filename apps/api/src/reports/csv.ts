import { Cell, ReportResult } from './types';

/**
 * Text cells that start with = + - @ (or a control character) are executed as formulas by spreadsheet apps.
 * Prefixing an apostrophe neutralises that (CSV/formula injection). Real numbers are never touched.
 */
export function safeCell(v: Cell): string {
  if (v == null) return '';
  if (typeof v === 'number') return String(v);
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

const q = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function toCsv(r: ReportResult): string {
  const lines: string[] = [];
  lines.push(q(r.title), q(`${r.company.name} - ${r.subtitle}`));
  if (r.provisional) lines.push(q('PROVISIONAL: payroll not yet approved'));
  lines.push(r.columns.map((c) => q(c.label)).join(','));
  for (const row of r.rows) lines.push(r.columns.map((c) => q(safeCell(row[c.key] ?? null))).join(','));
  if (r.totals) lines.push(r.columns.map((c) => q(safeCell(r.totals![c.key] ?? null))).join(','));
  // BOM so Excel opens UTF-8 (names in Indian languages) correctly.
  return '﻿' + lines.join('\r\n') + '\r\n';
}
