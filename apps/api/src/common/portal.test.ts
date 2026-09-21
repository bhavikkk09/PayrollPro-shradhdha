import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AuthUser } from './auth.types';
import { clientDetail, clientRow, clientRun } from './client-view';
import { AllowPasswordChange, InternalOnly, RequirePermissions } from './decorators';
import { JwtAuthGuard, PermissionsGuard } from './guards';
import { generateTempPassword, passwordProblems } from './password';

// Decorated dummy routes, so the real Reflector reads real metadata.
class Routes {
  @InternalOnly() @RequirePermissions('compliance.view') rules() {}
  @RequirePermissions('reports.view') reports() {}
  @AllowPasswordChange() change() {}
  open() {}
}
const routes = new Routes();
const reflector = new Reflector();
const ctx = (handler: () => void, user?: AuthUser, headers: Record<string, string> = {}) => ({
  getHandler: () => handler, getClass: () => Routes, switchToHttp: () => ({ getRequest: () => ({ user, headers }) }),
}) as any;
const user = (o: Partial<AuthUser>): AuthUser => ({ id: 'u', type: 'CONSULTANT', consultantId: 'C1', roles: [], permissions: [], ...o });

test('internal-only routes refuse client users even when they hold the permission', () => {
  const g = new PermissionsGuard(reflector);
  const client = user({ type: 'CLIENT', consultantId: null, permissions: ['compliance.view', 'reports.view'] });
  assert.throws(() => g.canActivate(ctx(routes.rules, client)), ForbiddenException);
  assert.equal(g.canActivate(ctx(routes.reports, client)), true); // a normal portal route still works
  assert.equal(g.canActivate(ctx(routes.rules, user({ permissions: ['compliance.view'] }))), true); // firm staff unaffected
});

test('permission guard still enforces required permissions', () => {
  const g = new PermissionsGuard(reflector);
  assert.throws(() => g.canActivate(ctx(routes.reports, user({ permissions: [] }))), ForbiddenException);
});

test('a user on a temporary password can only reach the change-password route', () => {
  const jwt = new JwtService({ secret: 'x'.repeat(32) });
  const token = jwt.sign({ sub: 'u', type: 'CLIENT', cid: null, roles: ['CLIENT_ADMIN'], perms: ['reports.view'], mcp: true });
  const g = new JwtAuthGuard(jwt, reflector);
  const h = { authorization: `Bearer ${token}` };
  assert.throws(() => g.canActivate(ctx(routes.reports, undefined, h)), (e: any) => e instanceof ForbiddenException && (e.getResponse() as any).code === 'PASSWORD_CHANGE_REQUIRED');
  assert.equal(g.canActivate(ctx(routes.change, undefined, h)), true);
  const normal = jwt.sign({ sub: 'u', type: 'CLIENT', cid: null, roles: [], perms: [], mcp: false });
  assert.equal(g.canActivate(ctx(routes.reports, undefined, { authorization: `Bearer ${normal}` })), true);
});

test('missing or forged tokens are rejected', () => {
  const g = new JwtAuthGuard(new JwtService({ secret: 'x'.repeat(32) }), reflector);
  assert.throws(() => g.canActivate(ctx(routes.reports, undefined, {})), UnauthorizedException);
  const forged = new JwtService({ secret: 'y'.repeat(32) }).sign({ sub: 'u', type: 'SUPER_ADMIN', roles: ['SUPER_ADMIN'], perms: ['users.manage'] });
  assert.throws(() => g.canActivate(ctx(routes.reports, undefined, { authorization: `Bearer ${forged}` })), UnauthorizedException);
});

test('password rules', () => {
  assert.ok(passwordProblems('short1').length > 0);
  assert.ok(passwordProblems('onlyletterslong').some((p) => p.includes('letter and one number')));
  assert.ok(passwordProblems('asha.patel2025x', 'asha.patel@firm.in').some((p) => p.includes('email')));
  assert.ok(passwordProblems('password12345').length > 0);
  assert.deepEqual(passwordProblems('Tr1cky-Horse-42', 'x@y.in'), []);
});

test('generated temporary passwords always satisfy the rules and are random', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 50; i++) { const p = generateTempPassword(); assert.deepEqual(passwordProblems(p), [], p); seen.add(p); }
  assert.equal(seen.size, 50);
});

test('client view strips how the firm runs payroll, and leaves firm users untouched', () => {
  const run = { id: 'r', status: 'APPROVED', totalNet: 1, rulesSnapshot: { rules: [1] }, engineVersion: '1', createdBy: 'a', approvedBy: 'b', lockedBy: 'c', issues: [{ level: 'ERROR', message: 'x' }, { level: 'WARNING', message: 'PF: no rule configured' }] };
  const c = clientRun(user({ type: 'CLIENT' }), run);
  assert.ok(!('rulesSnapshot' in c) && !('engineVersion' in c) && !('approvedBy' in c));
  assert.deepEqual((c as any).issues.map((i: any) => i.level), ['ERROR']);
  assert.equal((c as any).totalNet, 1);
  assert.equal(clientRun(user({}), run), run);

  const d = { net: 5, inputs: { rules: 1 }, calculation: { trace: [] }, warnings: ['w'], formulaVersion: '1', hasWarnings: true, earnings: [] };
  const cd: any = clientDetail(user({ type: 'CLIENT' }), d);
  assert.deepEqual(Object.keys(cd).sort(), ['earnings', 'net']);
  assert.equal(clientDetail(user({}), d), d);
  assert.equal(clientRow(user({ type: 'CLIENT' }), { hasWarnings: true }).hasWarnings, false);
});
