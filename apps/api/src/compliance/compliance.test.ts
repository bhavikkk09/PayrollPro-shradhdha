import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { computeStatus, dueDateFor } from './compliance-tasks';
import { validateRule } from './rule-validate';

const base = { effectiveFrom: '2025-04-01' };

test('due date: next month by default, clamped to month length, year rollover', () => {
  assert.equal(dueDateFor(2025, 6, 15, 1), '2025-07-15');
  assert.equal(dueDateFor(2025, 1, 31, 1), '2025-02-28');
  assert.equal(dueDateFor(2025, 12, 15, 1), '2026-01-15');
  assert.equal(dueDateFor(2025, 6, 7, 0), '2025-06-07');
});

test('status: overdue, due soon, pending, upcoming, completed', () => {
  assert.equal(computeStatus('2025-07-20', '2025-07-15', 2025, 6, false), 'OVERDUE');
  assert.equal(computeStatus('2025-07-10', '2025-07-15', 2025, 6, false), 'DUE_SOON');
  assert.equal(computeStatus('2025-07-15', '2025-07-15', 2025, 6, false), 'DUE_SOON'); // due today is not overdue
  assert.equal(computeStatus('2025-07-01', '2025-07-15', 2025, 6, false), 'PENDING'); // period over, due in 14 days
  assert.equal(computeStatus('2025-06-10', '2025-07-15', 2025, 6, false), 'UPCOMING'); // period still running
  assert.equal(computeStatus('2025-09-01', '2025-07-15', 2025, 6, true), 'COMPLETED');
});

test('PF/ESI need percentages; ESI also a ceiling', () => {
  assert.ok(validateRule({ module: 'PF', ...base }).length > 0);
  assert.deepEqual(validateRule({ module: 'PF', ...base, employeePercent: 12, employerPercent: 12 }), []);
  assert.ok(validateRule({ module: 'ESI', ...base, employeePercent: 1, employerPercent: 3 }).some((e) => e.includes('ceiling')));
  assert.ok(validateRule({ module: 'PF', ...base, employeePercent: 120, employerPercent: 1 }).some((e) => e.includes('between 0 and 100')));
});

test('PT slabs must be ordered, non-overlapping, only the last open-ended', () => {
  const ok = [{ from: 0, to: 9999, amount: 0 }, { from: 10000, to: null, amount: 200, monthAmounts: { '2': 300 } }];
  assert.deepEqual(validateRule({ module: 'PT', ...base, slabs: ok }), []);
  assert.ok(validateRule({ module: 'PT', ...base, slabs: [{ from: 0, to: 9999, amount: 0 }, { from: 9000, to: null, amount: 5 }] }).some((e) => e.includes('overlaps')));
  assert.ok(validateRule({ module: 'PT', ...base, slabs: [{ from: 0, to: null, amount: 0 }, { from: 10, to: null, amount: 5 }] }).some((e) => e.includes('open-ended')));
  assert.ok(validateRule({ module: 'PT', ...base, slabs: [] }).length > 0);
  assert.ok(validateRule({ module: 'PT', ...base, slabs: [{ from: 0, to: null, amount: 5, monthAmounts: { '13': 1 } }] }).some((e) => e.includes('monthAmounts')));
});

test('LWF and TDS specific fields', () => {
  assert.ok(validateRule({ module: 'LWF', ...base }).length > 0);
  assert.deepEqual(validateRule({ module: 'LWF', ...base, rules: { employeeAmount: 6, employerAmount: 12, months: [6, 12], dueDay: 15 } }), []);
  assert.ok(validateRule({ module: 'LWF', ...base, rules: { employeeAmount: 6, employerAmount: 12, months: [13] } }).length > 0);
  assert.deepEqual(validateRule({ module: 'TDS', ...base, slabs: [{ from: 0, to: 100, rate: 0 }, { from: 100, to: null, rate: 10 }], rules: { standardDeduction: 50, cessPercent: 4 } }), []);
  assert.ok(validateRule({ module: 'TDS', ...base, slabs: [{ from: 0, to: null, rate: 150 }] }).length > 0);
});

test('rejects bad dates, unknown modules and bad due-day settings', () => {
  assert.ok(validateRule({ module: 'PF', effectiveFrom: '01/04/2025', employeePercent: 1, employerPercent: 1 }).length > 0);
  assert.ok(validateRule({ module: 'XYZ', ...base }).some((e) => e.includes('module')));
  assert.ok(validateRule({ module: 'OTHER', ...base, rules: { dueDay: 40 } }).some((e) => e.includes('dueDay')));
});
