const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

const below100 = (n: number) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ' ' + ONES[n % 10] : ''}`);
const below1000 = (n: number) => {
  const h = Math.floor(n / 100), r = n % 100;
  return [h ? `${ONES[h]} Hundred` : '', r ? below100(r) : ''].filter(Boolean).join(' ');
};

/** Indian numbering (crore, lakh, thousand). Example: 28560 -> "Rupees Twenty Eight Thousand Five Hundred Sixty Only". */
export function amountInWords(amount: number): string {
  const total = Math.round(Math.abs(amount) * 100);
  const rupees = Math.floor(total / 100), paise = total % 100;
  if (rupees === 0 && paise === 0) return 'Rupees Zero Only';
  const parts: string[] = [];
  let n = rupees;
  const crore = Math.floor(n / 10_000_000); n %= 10_000_000;
  const lakh = Math.floor(n / 100_000); n %= 100_000;
  const thousand = Math.floor(n / 1000); n %= 1000;
  if (crore) parts.push(`${below1000(crore)} Crore`);
  if (lakh) parts.push(`${below100(lakh)} Lakh`);
  if (thousand) parts.push(`${below100(thousand)} Thousand`);
  if (n) parts.push(below1000(n));
  const r = parts.join(' ');
  const p = paise ? `${below100(paise)} Paise` : '';
  const body = [rupees ? `Rupees ${r}` : '', p].filter(Boolean).join(' and ');
  return `${amount < 0 ? 'Minus ' : ''}${body} Only`;
}
