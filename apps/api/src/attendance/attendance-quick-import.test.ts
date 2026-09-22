import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildQuickEntries, QuickEmployeeRef } from './attendance-quick-import';
import { summarizeMonth, SummaryInput, workingDatesBetween } from './attendance-summary';

// June 2025: 30 days, Sundays are 1, 8, 15, 22, 29 (weekly off) -> 25 working days.
const workingDates = workingDatesBetween('2025-06-01', '2025-06-30', ['SUN'], new Set());
const emp = (id: string): [string, QuickEmployeeRef] => [id, { id, workingDates }];

function paidDaysFor(entries: { employeeId: string; date: string; status: any; otHours: number }[], employeeId: string, o: Partial<SummaryInput> = {}) {
  const records = new Map(entries.filter((e) => e.employeeId === employeeId).map((e) => [e.date, { status: e.status, otHours: e.otHours }]));
  return summarizeMonth({ year: 2025, month: 6, records, weeklyOff: ['SUN'], holidays: new Set(), doj: null, dol: null, calcMethod: 'CALENDAR_DAYS', lopEnabled: true, otEnabled: true, ...o }).paidDays;
}

test('a whole number of days worked reproduces exactly that many paid days, for every calc method', () => {
  const employees = new Map([emp('E1')]);
  const { valid, errors } = buildQuickEntries([{ employeeCode: 'E1', paidDays: 20 }], employees, true);
  assert.equal(errors.length, 0);
  assert.equal(paidDaysFor(valid, 'E1', { calcMethod: 'WORKING_DAYS' }), 20);
  // Calendar-based methods additionally pay the weekly offs on top, same as manual day-by-day entry would.
  assert.equal(paidDaysFor(valid, 'E1', { calcMethod: 'CALENDAR_DAYS' }), 25); // 20 present + 5 Sundays
  assert.equal(paidDaysFor(valid, 'E1', { calcMethod: 'FIXED_30' }), 25);
});

test('a half day worked is split into whole PRESENT days plus one HALF_DAY', () => {
  const employees = new Map([emp('E1')]);
  const { valid, errors } = buildQuickEntries([{ employeeCode: 'E1', paidDays: 20.5 }], employees, true);
  assert.equal(errors.length, 0);
  assert.equal(valid.filter((e) => e.status === 'PRESENT').length, 20);
  assert.equal(valid.filter((e) => e.status === 'HALF_DAY').length, 1);
  assert.equal(paidDaysFor(valid, 'E1', { calcMethod: 'WORKING_DAYS' }), 20.5);
});

test('zero days worked marks every working day absent (full LOP), and full attendance marks none', () => {
  const employees = new Map([emp('E1'), emp('E2')]);
  const { valid } = buildQuickEntries([{ employeeCode: 'E1', paidDays: 0 }, { employeeCode: 'E2', paidDays: 25 }], employees, true);
  assert.equal(valid.filter((e) => e.employeeId === 'E1' && e.status === 'ABSENT').length, 25);
  assert.equal(valid.filter((e) => e.employeeId === 'E2' && e.status === 'PRESENT').length, 25);
  assert.equal(paidDaysFor(valid, 'E1', { calcMethod: 'WORKING_DAYS' }), 0);
  assert.equal(paidDaysFor(valid, 'E2', { calcMethod: 'WORKING_DAYS' }), 25);
});

test('rejects an unknown employee code, a fractional step other than .5, and days worked beyond available working days', () => {
  const employees = new Map([emp('E1')]);
  const { errors: e1 } = buildQuickEntries([{ employeeCode: 'GHOST', paidDays: 10 }], employees, true);
  assert.match(e1[0].message, /not found/);
  const { errors: e2 } = buildQuickEntries([{ employeeCode: 'E1', paidDays: 10.3 }], employees, true);
  assert.match(e2[0].message, /half-day steps/);
  const { errors: e3 } = buildQuickEntries([{ employeeCode: 'E1', paidDays: 26 }], employees, true);
  assert.match(e3[0].message, /exceeds/);
});

test('OT hours need at least one day worked, and land on the first working day otherwise', () => {
  const employees = new Map([emp('E1')]);
  const { errors } = buildQuickEntries([{ employeeCode: 'E1', paidDays: 0, otHours: 4 }], employees, true);
  assert.match(errors[0].message, /OT hours/);
  const { valid } = buildQuickEntries([{ employeeCode: 'E1', paidDays: 5, otHours: 4 }], employees, true);
  assert.equal(valid.find((e) => e.otHours > 0)?.date, workingDates[0]);
});

test('OT hours are rejected outright when the company has not enabled overtime', () => {
  const employees = new Map([emp('E1')]);
  const { errors, valid } = buildQuickEntries([{ employeeCode: 'E1', paidDays: 5, otHours: 4 }], employees, false);
  assert.match(errors[0].message, /Overtime is not enabled/);
  assert.equal(valid.length, 0);
});

test('duplicate employee codes in the same file are rejected', () => {
  const employees = new Map([emp('E1')]);
  const { valid, errors } = buildQuickEntries([{ employeeCode: 'E1', paidDays: 10 }, { employeeCode: 'E1', paidDays: 12 }], employees, true);
  assert.equal(valid.filter((e) => e.employeeId === 'E1').length, 25); // only the first row's entries
  assert.match(errors[0].message, /Duplicate/);
});
