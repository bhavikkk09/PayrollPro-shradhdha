// Safe arithmetic expression engine for salary formulas. No eval / Function.
// Grammar: expr = term (('+'|'-') term)* ; term = unary (('*'|'/') unary)* ;
// unary = '-' unary | primary ; primary = NUMBER | IDENT | IDENT '(' args ')' | '(' expr ')'
// Identifiers are component codes (e.g. BASIC) or GROSS. Functions: MIN, MAX, ROUND, FLOOR, CEIL.

export type Node =
  | { t: 'num'; v: number }
  | { t: 'id'; name: string }
  | { t: 'neg'; x: Node }
  | { t: 'bin'; op: '+' | '-' | '*' | '/'; l: Node; r: Node }
  | { t: 'fn'; name: string; args: Node[] };

export class FormulaError extends Error {}

const MAX_LEN = 500;
const FUNCS: Record<string, { min: number; max: number; run: (a: number[]) => number }> = {
  MIN: { min: 1, max: 10, run: (a) => Math.min(...a) },
  MAX: { min: 1, max: 10, run: (a) => Math.max(...a) },
  ROUND: { min: 1, max: 1, run: (a) => Math.round(a[0]) },
  FLOOR: { min: 1, max: 1, run: (a) => Math.floor(a[0]) },
  CEIL: { min: 1, max: 1, run: (a) => Math.ceil(a[0]) },
};

export function parse(src: string): Node {
  if (src.length > MAX_LEN) throw new FormulaError('Formula too long');
  const s = src;
  let i = 0;
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const peek = () => { ws(); return s[i]; };

  function expr(depth: number): Node {
    if (depth > 30) throw new FormulaError('Formula too deeply nested');
    let l = term(depth);
    for (;;) {
      const c = peek();
      if (c === '+' || c === '-') { i++; l = { t: 'bin', op: c, l, r: term(depth) }; } else return l;
    }
  }
  function term(depth: number): Node {
    let l = unary(depth);
    for (;;) {
      const c = peek();
      if (c === '*' || c === '/') { i++; l = { t: 'bin', op: c, l, r: unary(depth) }; } else return l;
    }
  }
  function unary(depth: number): Node {
    if (peek() === '-') { i++; return { t: 'neg', x: unary(depth) }; }
    return primary(depth);
  }
  function primary(depth: number): Node {
    const c = peek();
    if (c === undefined) throw new FormulaError('Unexpected end of formula');
    if (c === '(') {
      i++;
      const e = expr(depth + 1);
      if (peek() !== ')') throw new FormulaError('Missing )');
      i++;
      return e;
    }
    const num = /^\d+(\.\d+)?/.exec(s.slice(i));
    if (num) { i += num[0].length; return { t: 'num', v: Number(num[0]) }; }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
    if (id) {
      i += id[0].length;
      const name = id[0].toUpperCase();
      if (peek() === '(') {
        i++;
        const args: Node[] = [];
        if (peek() !== ')') {
          for (;;) {
            args.push(expr(depth + 1));
            if (peek() === ',') { i++; continue; }
            break;
          }
        }
        if (peek() !== ')') throw new FormulaError('Missing ) in function call');
        i++;
        const f = FUNCS[name];
        if (!f) throw new FormulaError(`Unknown function ${name}`);
        if (args.length < f.min || args.length > f.max) throw new FormulaError(`${name} takes ${f.min === f.max ? f.min : `${f.min}-${f.max}`} argument(s)`);
        return { t: 'fn', name, args };
      }
      return { t: 'id', name };
    }
    throw new FormulaError(`Unexpected "${c}"`);
  }

  const ast = expr(0);
  if (peek() !== undefined) throw new FormulaError(`Unexpected "${s[i]}"`);
  return ast;
}

export function identifiers(n: Node, out = new Set<string>()): Set<string> {
  if (n.t === 'id') out.add(n.name);
  else if (n.t === 'neg') identifiers(n.x, out);
  else if (n.t === 'bin') { identifiers(n.l, out); identifiers(n.r, out); }
  else if (n.t === 'fn') n.args.forEach((a) => identifiers(a, out));
  return out;
}

export function evaluate(n: Node, vars: Record<string, number>): number {
  switch (n.t) {
    case 'num': return n.v;
    case 'id':
      if (!Object.hasOwn(vars, n.name)) throw new FormulaError(`Unknown or not-yet-calculated component "${n.name}"`);
      return vars[n.name];
    case 'neg': return -evaluate(n.x, vars);
    case 'bin': {
      const a = evaluate(n.l, vars);
      const b = evaluate(n.r, vars);
      if (n.op === '+') return a + b;
      if (n.op === '-') return a - b;
      if (n.op === '*') return a * b;
      if (b === 0) throw new FormulaError('Division by zero');
      return a / b;
    }
    case 'fn': return FUNCS[n.name].run(n.args.map((a) => evaluate(a, vars)));
  }
}

export const evalFormula = (src: string, vars: Record<string, number>) => evaluate(parse(src), vars);
