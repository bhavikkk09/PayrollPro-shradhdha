import { randomBytes } from 'crypto';

/** Returns a list of problems; empty means the password is acceptable. */
export function passwordProblems(password: string, email = ''): string[] {
  const p: string[] = [];
  if (password.length < 10) p.push('Use at least 10 characters');
  if (password.length > 128) p.push('Use at most 128 characters');
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) p.push('Include at least one letter and one number');
  const local = email.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && password.toLowerCase().includes(local)) p.push('Do not include your email name');
  if (/^(.)\1+$/.test(password) || /^(password|12345678|qwerty)/i.test(password)) p.push('That password is too easy to guess');
  return p;
}

/** A readable one-time password for admin-issued accounts (always passes passwordProblems). */
export function generateTempPassword(): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const pick = (set: string, n: number) => Array.from(randomBytes(n), (b) => set[b % set.length]).join('');
  return `${pick(letters, 4)}-${pick(digits, 3)}-${pick(letters, 4)}-${pick(digits, 3)}`;
}
