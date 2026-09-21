import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { summarizeMonth, SummaryInput, Status, workingDatesBetween } from './attendance-summary';
import { parseDate, validateAttendanceRows } from './attendance-import';

// June 2025: 30 days, Sundays are 1, 8, 15, 22, 29 (weekly off).
const base = (o: Partial<SummaryInput> = {}): SummaryInput => ({
  year: 2025, month: 6, records: new Map(), weeklyOff: ['SUN'], holidays: new Set(), doj: null, dol: null,
  calcMethod: 'CALENDAR_DAYS', lopEnabled: true, otEnabled: true, ...o,
});
const rec = (pairs: [string, Status, number?][]) => new Map(pairs.map(([d, s, ot]) => [d, { status: s, otHours: ot ?? 0 }]));

test('weekly offs auto-fill; unmarked working days are reported, not guessed', () => {
  const s = summarizeMonth(base());
  assert.equal(s.weeklyOffs, 5);
  assert.equal(s.workingDays, 25);
  assert.equal(s.unmarked, 25);
  assert.equal(s.unmarkedDates[0], '2025-06-02');
});

test('unmarkedAs=PRESENT resolves everything; full month paid 30 days', () => {
  const s = summarizeMonth(base({ unmarkedAs: 'PRESENT' }));
  assert.equal(s.unmarked, 0);
  assert.equal(s.present, 25);
  assert.equal(s.lopDays, 0);
  assert.equal(s.paidDays, 30);
});

test('absent, unpaid leave, LOP and half day produce LOP days', () => {
  const s = summarizeMonth(base({
    unmarkedAs: 'PRESENT',
    records: rec([['2025-06-02', 'ABSENT'], ['2025-06-03', 'UNPAID_LEAVE'], ['2025-06-04', 'LOP'], ['2025-06-05', 'HALF_DAY'], ['2025-06-06', 'PAID_LEAVE']]),
  }));
  assert.equal(s.lopDays, 3.5); // 1 + 1 + 1 + 0.5
  assert.equal(s.paidLeave, 1);
  assert.equal(s.paidDays, 26.5);
});

test('LOP disabled means no deduction days', () => {
  const s = summarizeMonth(base({ lopEnabled: false, unmarkedAs: 'PRESENT', records: rec([['2025-06-02', 'ABSENT']]) }));
  assert.equal(s.lopDays, 0);
  assert.equal(s.paidDays, 30);
});

test('mid-month joiner is paid only from the joining date', () => {
  const s = summarizeMonth(base({ doj: '2025-06-16', unmarkedAs: 'PRESENT' }));
  assert.equal(s.employedDays, 15);
  assert.equal(s.paidDays, 15);
});

test('leaver: days after leaving are excluded', () => {
  const s = summarizeMonth(base({ dol: '2025-06-10', unmarkedAs: 'PRESENT' }));
  assert.equal(s.employedDays, 10);
});

test('FIXED_30 and WORKING_DAYS methods', () => {
  const recs = rec([['2025-06-02', 'ABSENT']]);
  const f = summarizeMonth(base({ calcMethod: 'FIXED_30', unmarkedAs: 'PRESENT', records: recs }));
  assert.equal(f.salaryDivisor, 30);
  assert.equal(f.paidDays, 29);
  const w = summarizeMonth(base({ calcMethod: 'WORKING_DAYS', unmarkedAs: 'PRESENT', records: recs }));
  assert.equal(w.salaryDivisor, 25);
  assert.equal(w.paidDays, 24);
});

test('holidays are auto-filled and OT only counts when enabled', () => {
  const holidays = new Set(['2025-06-10']);
  const s = summarizeMonth(base({ holidays, unmarkedAs: 'PRESENT', records: rec([['2025-06-02', 'PRESENT', 2], ['2025-06-03', 'PRESENT', 1.5]]) }));
  assert.equal(s.holidays, 1);
  assert.equal(s.otHours, 3.5);
  assert.equal(summarizeMonth(base({ otEnabled: false, records: rec([['2025-06-02', 'PRESENT', 2]]) })).otHours, 0);
});

test('workingDatesBetween skips weekly offs and holidays', () => {
  assert.deepEqual(workingDatesBetween('2025-06-06', '2025-06-10', ['SUN'], new Set(['2025-06-09'])), ['2025-06-06', '2025-06-07', '2025-06-10']); // Sat is a working day, Sun off, Mon holiday
});

test('date parsing accepts common formats and rejects impossible dates', () => {
  assert.equal(parseDate('2025-06-05'), '2025-06-05');
  assert.equal(parseDate('05/06/2025'), '2025-06-05');
  assert.equal(parseDate('31-02-2025'), null);
  assert.equal(parseDate('nonsense'), null);
});

test('import validation: aliases, unknown employee, bad status, OT rules, duplicates, employment window', () => {
  const emps = new Map([['E1', { id: 'id1', doj: '2025-06-05', dol: null }]]);
  const { valid, errors } = validateAttendanceRows([
    { employeeCode: 'e1', date: '2025-06-10', status: 'p', otHours: '2' },
    { employeeCode: 'E1', date: '2025-06-10', status: 'P' },
    { employeeCode: 'E9', date: '2025-06-10', status: 'P' },
    { employeeCode: 'E1', date: '2025-06-11', status: 'Sick' },
    { employeeCode: 'E1', date: '2025-06-01', status: 'P' },
    { employeeCode: 'E1', date: '2025-06-12', status: 'P', otHours: '30' },
    { employeeCode: 'E1', date: '2025-06-13', status: 'HD' },
  ], emps, true);
  assert.equal(valid.length, 2);
  assert.equal(valid[0].status, 'PRESENT');
  assert.equal(valid[1].status, 'HALF_DAY');
  assert.equal(errors.length, 5);
  assert.ok(errors[0].message.includes('Duplicate'));
  const noOt = validateAttendanceRows([{ employeeCode: 'E1', date: '2025-06-10', status: 'P', otHours: 1 }], emps, false);
  assert.equal(noOt.errors.length, 1);
});
