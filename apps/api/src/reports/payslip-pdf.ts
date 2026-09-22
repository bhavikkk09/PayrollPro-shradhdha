import PDFDocument from 'pdfkit';
import { collect, inr, latin, pageNumbers } from './pdf';
import { amountInWords } from './words';

export interface Branding { primaryColor?: string; footerText?: string; title?: string }

export interface PayslipData {
  company: { name: string; address: string };
  period: string; // e.g. "June 2025"
  draft: boolean;
  employee: { code: string; name: string; department: string; designation: string; doj: string; bank: string; uan: string; pfNumber: string; esiNumber: string };
  attendance: { workingDays: number; paidDays: number; lopDays: number; otHours: number };
  earnings: { name: string; amount: number }[];
  deductions: { name: string; amount: number }[];
  gross: number; totalDeductions: number; net: number;
  logo?: Buffer; // PNG or JPEG
}

const HEX = /^#[0-9a-fA-F]{6}$/;

function slip(doc: PDFKit.PDFDocument, p: PayslipData, b: Branding) {
  const m = doc.page.margins.left, W = doc.page.width - m * 2;
  const color = b.primaryColor && HEX.test(b.primaryColor) ? b.primaryColor : '#1e293b';

  // header band
  doc.rect(0, 0, doc.page.width, 78).fill(color);
  if (p.logo) {
    try { doc.roundedRect(m + W - 100, 12, 100, 54, 4).fill('#ffffff'); doc.image(p.logo, m + W - 96, 16, { fit: [92, 46], align: 'center', valign: 'center' }); }
    catch { /* a corrupt logo must not break the payslip */ }
  }
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(16).text(latin(p.company.name), m, 20, { width: p.logo ? W - 110 : W });
  doc.font('Helvetica').fontSize(8.5).text(latin(p.company.address || ''), m, 44, { width: W });
  doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(12).text(`${latin(b.title || 'PAYSLIP')} - ${latin(p.period)}`, m, 92);

  // employee block
  const info: [string, string][] = [
    ['Employee code', p.employee.code], ['Name', p.employee.name], ['Department', p.employee.department], ['Designation', p.employee.designation],
    ['Date of joining', p.employee.doj], ['Bank', p.employee.bank], ['UAN', p.employee.uan], ['PF number', p.employee.pfNumber], ['ESI number', p.employee.esiNumber],
  ];
  let y = 116;
  const colW = W / 2;
  info.forEach(([k, v], i) => {
    const x = m + (i % 2) * colW, yy = y + Math.floor(i / 2) * 15;
    doc.font('Helvetica').fontSize(8).fillColor('#64748b').text(k, x, yy, { width: 80 });
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#0f172a').text(latin(v || '-'), x + 82, yy, { width: colW - 90, lineBreak: false, ellipsis: true });
  });
  y += Math.ceil(info.length / 2) * 15 + 8;

  // attendance strip
  doc.rect(m, y, W, 26).fill('#f1f5f9');
  const att: [string, number][] = [['Working days', p.attendance.workingDays], ['Paid days', p.attendance.paidDays], ['LOP days', p.attendance.lopDays], ['OT hours', p.attendance.otHours]];
  att.forEach(([k, v], i) => {
    const x = m + i * (W / 4);
    doc.font('Helvetica').fontSize(7.5).fillColor('#64748b').text(k, x + 8, y + 4, { width: W / 4 - 10 });
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#0f172a').text(String(v), x + 8, y + 13, { width: W / 4 - 10 });
  });
  y += 38;

  // earnings | deductions
  const half = (W - 12) / 2, xr = m + half + 12;
  const head = (x: number, t: string) => { doc.rect(x, y, half, 18).fill(color); doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9).text(t, x + 6, y + 5); doc.text('Amount', x + 6, y + 5, { width: half - 12, align: 'right' }); };
  head(m, 'Earnings'); head(xr, 'Deductions');
  const rows = Math.max(p.earnings.length, p.deductions.length, 1);
  const line = (x: number, i: number, item?: { name: string; amount: number }) => {
    const yy = y + 22 + i * 16;
    if (i % 2 === 1) doc.rect(x, yy - 2, half, 16).fill('#f8fafc');
    if (!item) return;
    doc.fillColor('#0f172a').font('Helvetica').fontSize(8.5).text(latin(item.name), x + 6, yy + 1, { width: half - 90, lineBreak: false, ellipsis: true });
    doc.text(inr(item.amount), x + 6, yy + 1, { width: half - 12, align: 'right' });
  };
  for (let i = 0; i < rows; i++) { line(m, i, p.earnings[i]); line(xr, i, p.deductions[i]); }
  y += 26 + rows * 16;
  const total = (x: number, label: string, v: number) => {
    doc.moveTo(x, y).lineTo(x + half, y).lineWidth(0.7).stroke('#0f172a');
    doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(9).text(label, x + 6, y + 5); doc.text(inr(v), x + 6, y + 5, { width: half - 12, align: 'right' });
  };
  total(m, 'Gross earnings', p.gross); total(xr, 'Total deductions', p.totalDeductions);
  y += 30;

  // net pay
  doc.rect(m, y, W, 34).fill(color);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11).text('NET PAY', m + 10, y + 11);
  doc.fontSize(15).text(`Rs. ${inr(p.net)}`, m + 10, y + 9, { width: W - 20, align: 'right' });
  y += 44;
  doc.fillColor('#334155').font('Helvetica-Oblique').fontSize(8.5).text(latin(amountInWords(p.net)), m, y, { width: W });

  // footer
  const fy = doc.page.height - 70;
  if (b.footerText) doc.fillColor('#475569').font('Helvetica').fontSize(8).text(latin(b.footerText), m, fy, { width: W, align: 'center' });
  doc.fillColor('#94a3b8').fontSize(7.5).text('This is a computer generated payslip and does not require a signature.', m, fy + 22, { width: W, align: 'center' });

  if (p.draft) {
    doc.save().rotate(-35, { origin: [doc.page.width / 2, doc.page.height / 2] }).fillColor('#dc2626').fillOpacity(0.12).font('Helvetica-Bold').fontSize(70)
      .text('DRAFT', 0, doc.page.height / 2 - 40, { width: doc.page.width, align: 'center', lineBreak: false }).restore();
    doc.fillOpacity(1);
  }
}

/** One payslip per page. Draft payslips carry a DRAFT watermark. */
export async function payslipsPdf(list: PayslipData[], branding: Branding = {}): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 36, bufferPages: true, info: { Title: 'Payslips', Author: 'LabourConsultPro' } });
  const done = collect(doc);
  list.forEach((p, i) => { if (i > 0) doc.addPage(); slip(doc, p, branding); });
  if (list.length > 1) pageNumbers(doc);
  doc.end();
  return done;
}
