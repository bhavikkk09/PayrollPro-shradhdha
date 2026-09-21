import { AuthUser } from './auth.types';

/**
 * Client-portal users see their own company's payroll, but not how the consultant firm runs it:
 * rule snapshots, engine versions, internal warnings and the people who processed it are removed.
 */
export const isClient = (u: AuthUser) => u.type === 'CLIENT';

export function clientRun<T extends Record<string, any>>(u: AuthUser, run: T): T {
  if (!isClient(u)) return run;
  const { rulesSnapshot, engineVersion, createdBy, approvedBy, lockedBy, issues, ...rest } = run;
  const errors = Array.isArray(issues) ? issues.filter((i: any) => i?.level === 'ERROR') : issues;
  return { ...rest, issues: errors } as unknown as T;
}

export function clientDetail<T extends Record<string, any>>(u: AuthUser, d: T): T {
  if (!isClient(u)) return d;
  const { inputs, calculation, warnings, formulaVersion, hasWarnings, ...rest } = d;
  return rest as unknown as T;
}

export function clientRow<T extends Record<string, any>>(u: AuthUser, r: T): T {
  return isClient(u) ? ({ ...r, hasWarnings: false } as T) : r;
}
