import PDFDocument from 'pdfkit';
import { Cell, Col, ReportResult } from './types';

/** The built-in PDF fonts cover Latin-1 only: map the rupee sign and replace anything else with "?". */
export const latin = (s: string) => s.replace(/₹/g, 'Rs.').replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
export const inr = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmt = (v: Cell, c: Col) => (v == null || v === '' ? '' : typeof v === 'number' ? (c.type === 'money' ? inr(v) : String(v)) : latin(v));

export function collect(doc: PDFKit.PDFDocument): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

/** Adds "Page x of y" to every buffered page. */
export function pageNumbers(doc: PDFKit.PDFDocument, label = '') {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const m = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // writing in the margin must not trigger a new page
    doc.font('Helvetica').fontSize(7).fillColor('#64748b')
      .text(`${label}Page ${i + 1} of ${range.count}`, 0, doc.page.height - 22, { width: doc.page.width, align: 'center', lineBreak: false });
    doc.page.margins.bottom = m;
  }
}

export async function toPdf(r: ReportResult): Promise<Buffer> {
  const wide = r.columns.length > 7;
  const doc = new PDFDocument({ size: 'A4', layout: wide ? 'landscape' : 'portrait', margin: 28, bufferPages: true, info: { Title: r.title, Author: 'LabourConsultPro' } });
  const done = collect(doc);
  const left = doc.page.margins.left;
  const W = doc.page.width - left - doc.page.margins.right;
  const size = r.columns.length > 20 ? 5.5 : r.columns.length > 12 ? 6.5 : 8;

  // Column widths come from the real rendered text width (bold for header and totals), then scaled to the page.
  const measure = (text: string, bold: boolean) => doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).widthOfString(text);
  const natural = r.columns.map((c) => {
    let w = measure(latin(c.label), true) * (c.label.includes(' ') ? 0.6 : 1); // long headers may wrap onto two lines
    for (const row of r.rows.slice(0, 400)) w = Math.max(w, measure(fmt(row[c.key] ?? null, c), false));
    if (r.totals) w = Math.max(w, measure(fmt(r.totals[c.key] ?? null, c), true));
    return w + 8;
  });
  const total = natural.reduce((x, y) => x + y, 0);
  const widths = natural.map((w) => (w / total) * W); // scales up to fill the page, or down to fit it

  const heading = () => {
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#0f172a').text(latin(r.company.name), left, 28);
    doc.font('Helvetica-Bold').fontSize(10).text(latin(r.title));
    doc.font('Helvetica').fontSize(8).fillColor('#475569').text(latin(r.subtitle));
    if (r.provisional) doc.font('Helvetica-Bold').fillColor('#b91c1c').text('PROVISIONAL: payroll not yet approved');
    doc.moveDown(0.5);
  };
  const header = () => {
    doc.font('Helvetica-Bold').fontSize(size);
    const h = Math.max(...r.columns.map((c, i) => doc.heightOfString(latin(c.label), { width: widths[i] - 4 }))) + 6;
    const y = doc.y;
    doc.rect(left, y, W, h).fill('#1e293b');
    let x = left;
    r.columns.forEach((c, i) => { doc.fillColor('#ffffff').text(latin(c.label), x + 2, y + 3, { width: widths[i] - 4, align: c.align ?? 'left' }); x += widths[i]; });
    doc.y = y + h; doc.fillColor('#0f172a');
  };
  const bottom = () => doc.page.height - doc.page.margins.bottom - 14;
  const rowH = size + 5;
  const drawRow = (row: Record<string, Cell>, bold: boolean, shade: boolean) => {
    if (doc.y + rowH > bottom()) { doc.addPage(); header(); }
    const y = doc.y;
    if (shade) doc.rect(left, y, W, rowH).fill('#f1f5f9');
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor('#0f172a');
    let x = left;
    r.columns.forEach((c, i) => { doc.text(fmt(row[c.key] ?? null, c), x + 2, y + 2.5, { width: widths[i] - 4, align: c.align ?? 'left', lineBreak: false, ellipsis: true }); x += widths[i]; });
    if (bold) doc.moveTo(left, y).lineTo(left + W, y).lineWidth(0.6).stroke('#0f172a');
    doc.y = y + rowH;
  };

  heading(); header();
  r.rows.forEach((row, i) => drawRow(row, false, i % 2 === 1));
  if (r.totals) drawRow(r.totals, true, false);
  for (const n of r.notes) { if (doc.y + 14 > bottom()) doc.addPage(); doc.moveDown(0.4).font('Helvetica-Oblique').fontSize(7).fillColor('#64748b').text(latin(n), left, doc.y, { width: W }); }

  pageNumbers(doc, `${latin(r.company.name)} - `);
  doc.end();
  return done;
}
