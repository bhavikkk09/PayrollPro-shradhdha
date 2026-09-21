import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

// AES-256-GCM for sensitive identifiers (bank account, PAN, Aadhaar reference).
// Stored as v1:<iv>:<tag>:<ciphertext> (base64url). Key: ENCRYPTION_KEY = 32 bytes, hex or base64.
function key(): Buffer {
  const raw = process.env.ENCRYPTION_KEY ?? '';
  const k = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (k.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes (64 hex chars or base64)');
  return k;
}

export function encrypt(plain: string | null | undefined): string | null {
  if (plain == null || plain === '') return null;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':');
}

export function decrypt(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const [v, iv, tag, ct] = stored.split(':');
  if (v !== 'v1') throw new Error('Unsupported ciphertext version');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

/** Show only the last 4 characters: XXXXXX1234 */
export function mask(plain: string | null | undefined): string | null {
  if (!plain) return null;
  return plain.length <= 4 ? '****' : '*'.repeat(plain.length - 4) + plain.slice(-4);
}
