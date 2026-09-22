import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { BadRequestException, NotFoundException, PayloadTooLargeException, UnsupportedMediaTypeException } from '@nestjs/common';
import { AuthUser } from '../common/auth.types';
import { DocumentsService } from './documents.service';
import { FileStorage } from './storage';

const pdf = Buffer.from('%PDF-1.7\n...');

// ── in-memory storage ──
class MemStorage extends FileStorage {
  files = new Map<string, Buffer>();
  puts: string[] = [];
  async put(key: string, data: Buffer) { this.puts.push(key); this.files.set(key, data); }
  async get(key: string) { return this.files.get(key) ?? null; }
  async delete(key: string) { this.files.delete(key); }
}

// ── in-memory prisma ──
const employees: Record<string, { id: string; companyId: string; deletedAt: null }> = {
  E1: { id: 'E1', companyId: 'A', deletedAt: null },
};
const tasks: Record<string, { id: string; companyId: string }> = { T1: { id: 'T1', companyId: 'A' } };
const companies: Record<string, { id: string; logoUrl: string | null }> = { A: { id: 'A', logoUrl: null }, B: { id: 'B', logoUrl: null } };

function table() {
  const rows: any[] = [];
  let seq = 0;
  return {
    rows,
    count: async ({ where }: any) => rows.filter((r) => matches(r, where)).length,
    findMany: async ({ where }: any) => rows.filter((r) => matches(r, where)),
    findFirst: async ({ where }: any) => rows.find((r) => matches(r, where)) ?? null,
    create: async ({ data }: any) => { const r = { id: 'doc' + seq++, createdAt: new Date(), ...data }; rows.push(r); return r; },
    update: async ({ where, data }: any) => { const r = rows.find((x) => x.id === where.id); if (!r) throw new Error('not found'); Object.assign(r, data); return r; },
    delete: async ({ where }: any) => { const i = rows.findIndex((x) => x.id === where.id); rows.splice(i, 1); },
    aggregate: async ({ where }: any) => ({ _sum: { sizeBytes: rows.filter((r) => matches(r, where)).reduce((s, r) => s + r.sizeBytes, 0) } }),
  };
}
function matches(row: any, where: any): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => {
    if (k === 'task') return matches(tasks[row.taskId], v as any);
    if (v && typeof v === 'object' && 'contains' in (v as any)) return String(row[k] ?? '').toLowerCase().includes(String((v as any).contains).toLowerCase());
    if (v && typeof v === 'object' && ('not' in (v as any) || 'lte' in (v as any))) {
      if ((v as any).not === null && row[k] == null) return false;
      if ((v as any).lte !== undefined && row[k] > (v as any).lte) return false;
      return true;
    }
    return row[k] === v;
  });
}

const docTable = table(), empDocTable = table(), taskDocTable = table();
const audits: any[] = [];
const storage = new MemStorage();
const prisma: any = {
  employee: { findFirst: async ({ where }: any) => (employees[where.id]?.companyId === where.companyId ? employees[where.id] : null) },
  complianceTask: { findFirst: async ({ where }: any) => (tasks[where.id]?.companyId === where.companyId ? tasks[where.id] : null) },
  document: docTable, employeeDocument: empDocTable, complianceDocument: taskDocTable,
  company: {
    // A fresh object each read, like real Prisma: a later update() must never retroactively change a value already handed out.
    findUniqueOrThrow: async ({ where }: any) => { const c = companies[where.id]; if (!c) throw new Error('missing'); return { ...c }; },
    update: async ({ where, data }: any) => Object.assign(companies[where.id], data),
  },
};
const svc = new DocumentsService(prisma, storage, { log: async (e: any) => { audits.push(e); } } as any);
const u: AuthUser = { id: 'u1', type: 'CONSULTANT', consultantId: 'C', roles: [], permissions: [] };

test('upload validates the file and stores it under company/employee/task scope', async () => {
  const co = await svc.upload(u, { kind: 'company', companyId: 'A' }, { originalname: 'licence.pdf', buffer: pdf }, { category: 'PF', title: 'PF licence' });
  assert.equal(co.category, 'PF');
  assert.equal(storage.puts.length, 1);
  const emp = await svc.upload(u, { kind: 'employee', companyId: 'A', employeeId: 'E1' }, { originalname: 'id.pdf', buffer: pdf }, { category: 'ID_PROOF' });
  assert.equal(emp.category, 'ID_PROOF');
  const t = await svc.upload(u, { kind: 'task', companyId: 'A', taskId: 'T1' }, { originalname: 'challan.pdf', buffer: pdf }, {});
  assert.equal(t.category, 'COMPLIANCE');
});

test('rejects disguised or scriptable uploads before ever touching storage', async () => {
  const before = storage.puts.length;
  await assert.rejects(svc.upload(u, { kind: 'company', companyId: 'A' }, { originalname: 'x.pdf', buffer: Buffer.from('not a pdf') }, {}), UnsupportedMediaTypeException);
  await assert.rejects(svc.upload(u, { kind: 'company', companyId: 'A' }, { originalname: 'x.html', buffer: Buffer.from('<script>') }, {}), UnsupportedMediaTypeException);
  assert.equal(storage.puts.length, before);
});

test('an employee document cannot be attached to another company\'s employee, or a foreign employee id', async () => {
  await assert.rejects(svc.upload(u, { kind: 'employee', companyId: 'B', employeeId: 'E1' }, { originalname: 'id.pdf', buffer: pdf }, {}), NotFoundException);
});

test('an invalid category is rejected', async () => {
  await assert.rejects(svc.upload(u, { kind: 'company', companyId: 'A' }, { originalname: 'x.pdf', buffer: pdf }, { category: 'NOT_A_CATEGORY' }), BadRequestException);
});

test('storage quota is enforced per company, based on real stored sizes', async () => {
  const big = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(1024)]);
  process.env.MAX_COMPANY_STORAGE_MB = '0.001'; // ~1KB, already exceeded by earlier uploads in this suite
  try {
    await assert.rejects(svc.upload(u, { kind: 'company', companyId: 'A' }, { originalname: 'big.pdf', buffer: big }, {}), PayloadTooLargeException);
  } finally {
    delete process.env.MAX_COMPANY_STORAGE_MB; // always restore, even if the assertion itself fails
  }
});

test('if saving the database record fails, the uploaded blob is removed (no orphan file)', async () => {
  const before = storage.files.size;
  const originalCreate = docTable.create;
  docTable.create = async () => { throw new Error('db exploded'); };
  await assert.rejects(svc.upload(u, { kind: 'company', companyId: 'A' }, { originalname: 'x.pdf', buffer: pdf }, {}));
  assert.equal(storage.files.size, before); // put then rolled back
  docTable.create = originalCreate;
});

test('read returns the stored bytes, and employee document reads are audited', async () => {
  const list = await svc.list({ kind: 'employee', companyId: 'A', employeeId: 'E1' }, { page: 1, pageSize: 10 });
  const id = list.items[0].id;
  audits.length = 0;
  const r = await svc.read(u, { kind: 'employee', companyId: 'A', employeeId: 'E1' }, id);
  assert.equal(r.data.subarray(0, 4).toString(), '%PDF');
  assert.ok(audits.some((a) => a.action === 'EMPLOYEE_DOCUMENT_DOWNLOADED'));
});

test('documents of one company cannot be read, edited or deleted through another company\'s scope', async () => {
  const list = await svc.list({ kind: 'company', companyId: 'A' }, { page: 1, pageSize: 10 });
  const id = list.items[0].id;
  await assert.rejects(svc.read(u, { kind: 'company', companyId: 'B' }, id), NotFoundException);
  await assert.rejects(svc.update(u, { kind: 'company', companyId: 'B' }, id, { title: 'x' }), NotFoundException);
  await assert.rejects(svc.remove(u, { kind: 'company', companyId: 'B' }, id), NotFoundException);
});

test('deleting a document removes both the database row and the stored file', async () => {
  const list = await svc.list({ kind: 'company', companyId: 'A' }, { page: 1, pageSize: 50 });
  const doc = list.items.find((d: { category: string }) => d.category === 'PF')!;
  const key = docTable.rows.find((r) => r.id === doc.id).fileKey;
  assert.ok(storage.files.has(key));
  await svc.remove(u, { kind: 'company', companyId: 'A' }, doc.id);
  assert.ok(!storage.files.has(key));
  await assert.rejects(svc.read(u, { kind: 'company', companyId: 'A' }, doc.id), NotFoundException);
});

test('task documents cannot be edited (only uploaded or deleted)', async () => {
  const list = await svc.list({ kind: 'task', companyId: 'A', taskId: 'T1' }, { page: 1, pageSize: 10 });
  await assert.rejects(svc.update(u, { kind: 'task', companyId: 'A', taskId: 'T1' }, list.items[0].id, { title: 'x' }), BadRequestException);
});

test('company logo: only images accepted, size capped, old blob replaced and removed', async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);
  await assert.rejects(svc.setLogo(u, 'A', { originalname: 'x.pdf', buffer: pdf }), UnsupportedMediaTypeException);
  await svc.setLogo(u, 'A', { originalname: 'logo.png', buffer: png });
  const key1 = companies.A.logoUrl!.slice(5);
  assert.ok(storage.files.has(key1));
  await svc.setLogo(u, 'A', { originalname: 'logo2.png', buffer: png });
  assert.ok(!storage.files.has(key1)); // old logo cleaned up
  const got = await svc.getLogo('A');
  assert.equal(got!.mime, 'image/png');
  await svc.removeLogo(u, 'A');
  assert.equal(companies.A.logoUrl, null);
  assert.equal(await svc.getLogo('A'), null);
});

test('logo over the size cap is rejected', async () => {
  const bigPng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(600 * 1024)]);
  await assert.rejects(svc.setLogo(u, 'A', { originalname: 'big.png', buffer: bigPng }), PayloadTooLargeException);
});
