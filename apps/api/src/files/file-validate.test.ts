import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { BadRequestException, PayloadTooLargeException, UnsupportedMediaTypeException } from '@nestjs/common';
import { contentDisposition, MAX_UPLOAD_BYTES, safeFileName, validateUpload } from './file-validate';

const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n');
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);
const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(20)]);

test('accepts real files of allowed types and reports the type from content rules, not the client', () => {
  assert.deepEqual(validateUpload('Licence.PDF', pdf), { ext: 'pdf', mime: 'application/pdf', inline: true, name: 'Licence.PDF', size: pdf.length });
  assert.equal(validateUpload('logo.png', png).mime, 'image/png');
  assert.equal(validateUpload('wages.xlsx', zip).inline, false);
  assert.equal(validateUpload('list.csv', Buffer.from('code,name\nE1,Asha\n')).mime, 'text/csv');
});

test('rejects disguised files: content must match the extension', () => {
  const exe = Buffer.from('MZ\x90\x00\x03\x00\x00\x00');
  assert.throws(() => validateUpload('invoice.pdf', exe), UnsupportedMediaTypeException);
  assert.throws(() => validateUpload('photo.png', pdf), UnsupportedMediaTypeException);
  assert.throws(() => validateUpload('data.csv', Buffer.from([0x4d, 0x5a, 0x00, 0x01, 0x02])), UnsupportedMediaTypeException); // binary posing as text
});

test('rejects scriptable and executable formats outright', () => {
  for (const n of ['page.html', 'image.svg', 'run.js', 'tool.exe', 'x.php', 'a.bat', 'noext', 'x.pdf.exe']) {
    assert.throws(() => validateUpload(n, Buffer.from('<script>alert(1)</script>')), UnsupportedMediaTypeException, n);
  }
});

test('rejects empty and oversized files', () => {
  assert.throws(() => validateUpload('a.pdf', Buffer.alloc(0)), BadRequestException);
  assert.throws(() => validateUpload('a.pdf', undefined), BadRequestException);
  assert.throws(() => validateUpload('a.pdf', Buffer.concat([pdf, Buffer.alloc(MAX_UPLOAD_BYTES)])), PayloadTooLargeException);
});

test('an endpoint can narrow the allowed types (logo: images only)', () => {
  assert.throws(() => validateUpload('logo.pdf', pdf, ['png', 'jpg', 'jpeg']), UnsupportedMediaTypeException);
  assert.equal(validateUpload('logo.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]), ['png', 'jpg', 'jpeg']).ext, 'jpg');
});

test('file names lose paths, control characters and leading dots', () => {
  assert.equal(safeFileName('..\\..\\windows\\evil.pdf'), 'evil.pdf');
  assert.equal(safeFileName('/etc/passwd'), 'passwd');
  assert.equal(safeFileName('a<b>:"c|d?.pdf'), 'a_b___c_d_.pdf');
  assert.equal(safeFileName('...hidden.pdf'), 'hidden.pdf');
  assert.equal(safeFileName(''), 'file');
});

test('Content-Disposition is header-safe and keeps the real name', () => {
  const h = contentDisposition('નામ "x".pdf', false);
  assert.ok(h.startsWith('attachment;'));
  assert.ok(!/[\r\n]/.test(h));
  assert.ok(h.includes("filename*=UTF-8''"));
  assert.ok(contentDisposition('a.pdf', true).startsWith('inline;'));
});
