import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { evalFormula, FormulaError, parse } from './formula';
import { calculateSalary, CalcItem } from './salary-calculator';

const item = (o: Partial<CalcItem> & Pick<CalcItem, 'code' | 'sequence'>): CalcItem => ({
  name: o.code, type: 'EARNING', calcMethod: 'FIXED', ...o,
});

test('formula: precedence, unary minus, functions', () => {
  assert.equal(evalFormula('2 + 3 * 4', {}), 14);
  assert.equal(evalFormula('-(2 + 3) * 2', {}), -10);
  assert.equal(evalFormula('MIN(BASIC * 0.12, 1800)', { BASIC: 20000 }), 1800);
  assert.equal(evalFormula('round(10.6) + floor(1.9) + ceil(1.1)', {}), 14);
});

test('formula: rejects code injection, unknown names and bad syntax', () => {
  assert.throws(() => parse('process.exit(1)'), FormulaError);
  assert.throws(() => evalFormula('constructor', {}), FormulaError);
  assert.throws(() => parse('1 +'), FormulaError);
  assert.throws(() => parse('FOO(1)'), FormulaError);
  assert.throws(() => evalFormula('1 / 0', {}), FormulaError);
  assert.throws(() => evalFormula('X + 1', {}), FormulaError);
  assert.throws(() => parse('('.repeat(60) + '1' + ')'.repeat(60)), FormulaError);
});

test('structure: Basic 40% of gross, HRA 50% of basic, Special = remainder', () => {
  const r = calculateSalary(30000, [
    item({ code: 'BASIC', sequence: 1, calcMethod: 'PERCENTAGE', percentage: 40 }),
    item({ code: 'HRA', sequence: 2, calcMethod: 'PERCENTAGE', percentage: 50, percentOf: 'BASIC' }),
    item({ code: 'SPECIAL', sequence: 3, calcMethod: 'FORMULA', formula: 'GROSS - BASIC - HRA' }),
  ]);
  assert.deepEqual(r.lines.map((l) => l.amount), [12000, 6000, 12000]);
  assert.equal(r.gross, 30000);
  assert.ok(r.grossMatchesTarget);
});

test('deductions reduce net; fixed and overrides work', () => {
  const r = calculateSalary(20000, [
    item({ code: 'BASIC', sequence: 1, fixedAmount: 10000 }),
    item({ code: 'DA', sequence: 2, fixedAmount: 10000 }),
    item({ code: 'ADV', sequence: 3, type: 'DEDUCTION', fixedAmount: 500 }),
  ], { BASIC: 12000 });
  assert.equal(r.gross, 22000);
  assert.equal(r.deductions, 500);
  assert.equal(r.net, 21500);
  assert.ok(!r.grossMatchesTarget);
  assert.ok(r.warnings.some((w) => w.includes('differs')));
});

test('is deterministic and rounds each line to 2 decimals', () => {
  const items = [item({ code: 'BASIC', sequence: 1, calcMethod: 'PERCENTAGE', percentage: 33.333 })];
  const a = calculateSalary(10000, items);
  const b = calculateSalary(10000, items);
  assert.deepEqual(a, b);
  assert.equal(a.lines[0].amount, 3333.3);
});

test('a formula cannot use a component that comes later', () => {
  assert.throws(() => calculateSalary(1000, [
    item({ code: 'A', sequence: 1, calcMethod: 'FORMULA', formula: 'B * 2' }),
    item({ code: 'B', sequence: 2, fixedAmount: 10 }),
  ]), FormulaError);
});
