import ExcelJS from 'exceljs';
import { ReportResult } from './types';

/**
 * Text is always written as a string cell (never as a formula), and numbers as real numbers with a money
 * format, so figures can be summed and sorted in Excel.
 */
export async function toXlsx(r: ReportResult): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'LabourConsultPro';
  const ws = wb.addWorksheet(r.title.slice(0, 31), { views: [{ state: 'frozen', ySplit: r.provisional ? 5 : 4 }], pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });

  ws.addRow([r.company.name]).font = { bold: true, size: 13 };
  ws.addRow([r.title]).font = { bold: true, size: 11 };
  ws.addRow([r.subtitle]);
  if (r.provisional) { const p = ws.addRow(['PROVISIONAL: payroll not yet approved']); p.font = { bold: true, color: { argb: 'FFB91C1C' } }; }
  const head = ws.addRow(r.columns.map((c) => c.label));
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.alignment = { vertical: 'middle', wrapText: true };
  head.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } }; });

  const put = (row: Record<string, string | number | null>, bold = false) => {
    const x = ws.addRow(r.columns.map((c) => row[c.key] ?? null));
    r.columns.forEach((c, i) => {
      const cell = x.getCell(i + 1);
      if (typeof cell.value === 'string') cell.value = { richText: [{ text: cell.value }] }; // forces a text cell even if it looks like a formula
      if (c.type === 'money') cell.numFmt = '#,##0.00';
      if (c.align === 'right') cell.alignment = { horizontal: 'right' };
      if (c.align === 'center') cell.alignment = { horizontal: 'center' };
      if (bold) cell.font = { bold: true };
    });
    return x;
  };
  for (const row of r.rows) put(row);
  if (r.totals) { const t = put(r.totals, true); t.eachCell((c) => { c.border = { top: { style: 'thin' } }; }); }
  for (const n of r.notes) ws.addRow([n]).font = { italic: true, color: { argb: 'FF64748B' } };

  r.columns.forEach((c, i) => {
    const longest = Math.max(c.label.length, ...r.rows.slice(0, 300).map((row) => String(row[c.key] ?? '').length));
    ws.getColumn(i + 1).width = Math.min(34, Math.max(c.type === 'text' && c.align === 'center' ? 4 : 8, longest + 2));
  });
  ws.autoFilter = { from: { row: r.provisional ? 5 : 4, column: 1 }, to: { row: r.provisional ? 5 : 4, column: r.columns.length } };

  return Buffer.from(await wb.xlsx.writeBuffer());
}
