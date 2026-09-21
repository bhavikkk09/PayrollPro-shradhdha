import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ForbiddenException } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';

const host = (res: any) => ({ switchToHttp: () => ({ getResponse: () => res }) }) as any;
const fakeRes = (headersSent = false) => {
  const r: any = { headersSent, statusCode: 0, body: null, calls: 0 };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: unknown) => { r.calls++; r.body = b; if (r.headersSent) throw new Error('ERR_HTTP_HEADERS_SENT'); return r; };
  return r;
};

test('HTTP errors keep their status and message', () => {
  const r = fakeRes();
  new AllExceptionsFilter().catch(new ForbiddenException('nope'), host(r));
  assert.equal(r.statusCode, 403);
});

test('unexpected errors return a generic message with an error id and no stack', () => {
  const r = fakeRes();
  new AllExceptionsFilter().catch(new Error('secret db detail'), host(r));
  assert.equal(r.statusCode, 500);
  assert.ok(r.body.errorId);
  assert.ok(!JSON.stringify(r.body).includes('secret'));
});

test('an error after the response was sent must not try to reply again (that used to crash the process)', () => {
  const r = fakeRes(true);
  assert.doesNotThrow(() => new AllExceptionsFilter().catch(new Error('late'), host(r)));
  assert.equal(r.calls, 0);
});
