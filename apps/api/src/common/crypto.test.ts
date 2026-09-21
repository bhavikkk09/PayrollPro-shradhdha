import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { encrypt, decrypt, mask } from './crypto';

// key is read lazily, so setting it after import is fine
process.env.ENCRYPTION_KEY = 'a'.repeat(64);

test('encrypt/decrypt round trip, random IV, no plaintext in output', () => {
  const a = encrypt('ABCDE1234F')!;
  const b = encrypt('ABCDE1234F')!;
  assert.notEqual(a, b);
  assert.ok(!a.includes('ABCDE'));
  assert.equal(decrypt(a), 'ABCDE1234F');
});

test('tampered ciphertext is rejected', () => {
  const parts = encrypt('secret')!.split(':');
  parts[3] = Buffer.from('tampered').toString('base64url');
  assert.throws(() => decrypt(parts.join(':')));
});

test('null/empty handled and mask keeps last 4', () => {
  assert.equal(encrypt(''), null);
  assert.equal(decrypt(null), null);
  assert.equal(mask('123456789012'), '********9012');
  assert.equal(mask('12'), '****');
});
