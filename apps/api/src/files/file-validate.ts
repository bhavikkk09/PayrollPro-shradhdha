import { BadRequestException, PayloadTooLargeException, UnsupportedMediaTypeException } from '@nestjs/common';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

interface Kind { mime: string; inline: boolean; check: (b: Buffer) => boolean }
const starts = (b: Buffer, sig: number[]) => sig.every((v, i) => b[i] === v);
const text = (b: Buffer) => { for (const c of b.subarray(0, 4096)) if (c === 0 || (c < 9) || (c > 13 && c < 32 && c !== 27)) return false; return true; };

/**
 * Allowlist by extension. The content must really look like that type (magic bytes), so an executable renamed to .pdf
 * is refused. Scriptable formats (html, svg, js) are simply not allowed. Only pdf and images may be shown inline.
 */
const KINDS: Record<string, Kind> = {
  pdf: { mime: 'application/pdf', inline: true, check: (b) => starts(b, [0x25, 0x50, 0x44, 0x46, 0x2d]) },
  png: { mime: 'image/png', inline: true, check: (b) => starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  jpg: { mime: 'image/jpeg', inline: true, check: (b) => starts(b, [0xff, 0xd8, 0xff]) },
  jpeg: { mime: 'image/jpeg', inline: true, check: (b) => starts(b, [0xff, 0xd8, 0xff]) },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', inline: false, check: (b) => starts(b, [0x50, 0x4b, 0x03, 0x04]) },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', inline: false, check: (b) => starts(b, [0x50, 0x4b, 0x03, 0x04]) },
  xls: { mime: 'application/vnd.ms-excel', inline: false, check: (b) => starts(b, [0xd0, 0xcf, 0x11, 0xe0]) },
  doc: { mime: 'application/msword', inline: false, check: (b) => starts(b, [0xd0, 0xcf, 0x11, 0xe0]) },
  csv: { mime: 'text/csv', inline: false, check: text },
  txt: { mime: 'text/plain', inline: false, check: text },
};

export const IMAGE_EXT = ['png', 'jpg', 'jpeg'];

export function safeFileName(original: string): string {
  const base = (original ?? '').split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  if (!clean || clean.length > 150) return (clean || 'file').slice(-150);
  return clean;
}

export interface Checked { ext: string; mime: string; inline: boolean; name: string; size: number }

export function validateUpload(originalName: string, data: Buffer | undefined, allowedExt?: string[]): Checked {
  if (!data || data.length === 0) throw new BadRequestException('No file received, or the file is empty');
  if (data.length > MAX_UPLOAD_BYTES) throw new PayloadTooLargeException(`File is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
  const name = safeFileName(originalName);
  const ext = (name.includes('.') ? name.split('.').pop()! : '').toLowerCase();
  const kind = KINDS[ext];
  if (!kind || (allowedExt && !allowedExt.includes(ext))) {
    throw new UnsupportedMediaTypeException(`This file type is not allowed. Allowed: ${(allowedExt ?? Object.keys(KINDS)).join(', ')}`);
  }
  if (!kind.check(data)) throw new UnsupportedMediaTypeException('The file content does not match its type');
  return { ext, mime: kind.mime, inline: kind.inline, name, size: data.length };
}

/** Content-Disposition with an ASCII fallback and the real (UTF-8) name for modern browsers. */
export function contentDisposition(name: string, inline: boolean): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
