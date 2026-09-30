// EPICS calc expressions as EDM's CALC\ PVs evaluate them: infix → postfix
// compile, and evaluation.
//
// EDM does not call EPICS base: its calcPv plugin carries its own copy of
// base's postfix.c / calcPerform.c from the 3.14 era (edm/calcPv, functions
// edm_postfix / edm_calcPerform). This is a TypeScript port of that copy:
//   Copyright (c) 2002 The University of Chicago, as Operator of Argonne
//   National Laboratory. Copyright (c) 2002 The Regents of the University of
//   California, as Operator of Los Alamos National Laboratory. EPICS BASE
//   Versions 3.13.7 and higher are distributed subject to the EPICS Open
//   License.
//
// Same element tables and priorities, stack-depth checks and arithmetic. It
// differs from today's EPICS base in ways screens depend on: variables A..L
// only (no VAL), MAX and MIN take exactly two arguments (MAX(A,B,C) does not
// compile, so such a CALC stays 0), FINITE/ISNAN are unary, % is fmod, and
// there is no >>>. Never uses eval.

type ElementType =
  | 'OPERAND'
  | 'LITERAL'
  | 'STORE'
  | 'UNARY'
  | 'BINARY'
  | 'SEPARATOR'
  | 'CLOSE_PAREN'
  | 'CONDITIONAL'
  | 'TERMINATOR';

interface Element {
  readonly name: string;
  readonly inStack: number;
  readonly inComing: number;
  readonly effect: number;
  readonly type: ElementType;
  readonly code: string;
}

const el = (
  name: string,
  inStack: number,
  inComing: number,
  effect: number,
  type: ElementType,
  code: string
): Element => ({ name, inStack, inComing, effect, type, code });

const VARS = 'ABCDEFGHIJKL';
/** Number of input variables (A..L). */
export const CALC_NARGS = VARS.length;
const STACK = 80;

const OPERANDS: Element[] = [
  el('!', 7, 8, 0, 'UNARY', 'REL_NOT'),
  el('(', 0, 8, 0, 'UNARY', 'PAREN'),
  el('-', 7, 8, 0, 'UNARY', 'UNARY_NEG'),
  ...['.', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'INF', 'NAN'].map((n) =>
    el(n, 0, 0, 1, 'LITERAL', 'DOUBLE')
  ),
  el('0X', 0, 0, 1, 'LITERAL', 'INT'),
  ...[...VARS].map((v) => el(v, 0, 0, 1, 'OPERAND', `FETCH_${v}`)),
  el('D2R', 0, 0, 1, 'OPERAND', 'CONST_D2R'),
  el('PI', 0, 0, 1, 'OPERAND', 'CONST_PI'),
  el('R2D', 0, 0, 1, 'OPERAND', 'CONST_R2D'),
  el('RNDM', 0, 0, 1, 'OPERAND', 'RANDOM'),
  ...(
    [
      ['ABS', 'ABS_VAL'],
      ['ACOS', 'ACOS'],
      ['ASIN', 'ASIN'],
      ['ATAN', 'ATAN'],
      ['CEIL', 'CEIL'],
      ['COS', 'COS'],
      ['COSH', 'COSH'],
      ['EXP', 'EXP'],
      ['FINITE', 'FINITE'],
      ['FLOOR', 'FLOOR'],
      ['ISINF', 'ISINF'],
      ['ISNAN', 'ISNAN'],
      ['LN', 'LOG_E'],
      ['LOG', 'LOG_10'],
      ['LOGE', 'LOG_E'],
      ['NINT', 'NINT'],
      ['NOT', 'BIT_NOT'],
      ['SIN', 'SIN'],
      ['SINH', 'SINH'],
      ['SQR', 'SQU_RT'],
      ['SQRT', 'SQU_RT'],
      ['TAN', 'TAN'],
      ['TANH', 'TANH'],
      ['~', 'BIT_NOT'],
    ] as const
  ).map(([n, c]) => el(n, 7, 8, 0, 'UNARY', c)),
  el('ATAN2', 7, 8, -1, 'UNARY', 'ATAN2'),
  el('MAX', 7, 8, -1, 'UNARY', 'MAX'),
  el('MIN', 7, 8, -1, 'UNARY', 'MIN'),
];

const OPERATORS: Element[] = [
  el('!=', 3, 3, -1, 'BINARY', 'NOT_EQ'),
  el('#', 3, 3, -1, 'BINARY', 'NOT_EQ'),
  el('%', 5, 5, -1, 'BINARY', 'MODULO'),
  el('&', 2, 2, -1, 'BINARY', 'BIT_AND'),
  el('&&', 2, 2, -1, 'BINARY', 'REL_AND'),
  el(')', 0, 0, 0, 'CLOSE_PAREN', 'NONE'),
  el('*', 5, 5, -1, 'BINARY', 'MULT'),
  el('**', 6, 6, -1, 'BINARY', 'POWER'),
  el('+', 4, 4, -1, 'BINARY', 'ADD'),
  el(',', 0, 0, 0, 'SEPARATOR', 'NONE'),
  el('-', 4, 4, -1, 'BINARY', 'SUB'),
  el('/', 5, 5, -1, 'BINARY', 'DIV'),
  el(':', 0, 0, -1, 'CONDITIONAL', 'COND_ELSE'),
  el(':=', 0, 0, -1, 'STORE', 'STORE'),
  el(';', 0, 0, 0, 'TERMINATOR', 'NONE'),
  el('<', 3, 3, -1, 'BINARY', 'LESS_THAN'),
  el('<<', 2, 2, -1, 'BINARY', 'LEFT_SHIFT_ARITH'),
  el('<=', 3, 3, -1, 'BINARY', 'LESS_OR_EQ'),
  el('=', 3, 3, -1, 'BINARY', 'EQUAL'),
  el('==', 3, 3, -1, 'BINARY', 'EQUAL'),
  el('>', 3, 3, -1, 'BINARY', 'GR_THAN'),
  el('>=', 3, 3, -1, 'BINARY', 'GR_OR_EQ'),
  el('>>', 2, 2, -1, 'BINARY', 'RIGHT_SHIFT_ARITH'),
  el('?', 0, 0, -1, 'CONDITIONAL', 'COND_IF'),
  el('AND', 2, 2, -1, 'BINARY', 'BIT_AND'),
  el('OR', 1, 1, -1, 'BINARY', 'BIT_OR'),
  el('XOR', 1, 1, -1, 'BINARY', 'BIT_EXCL_OR'),
  el('^', 6, 6, -1, 'BINARY', 'POWER'),
  el('|', 1, 1, -1, 'BINARY', 'BIT_OR'),
  el('||', 1, 1, -1, 'BINARY', 'REL_OR'),
];

// EPICS searches its sorted tables backwards so the longest name wins.
const byLength = (a: Element, b: Element) => b.name.length - a.name.length;
const OPERANDS_SORTED = [...OPERANDS].sort(byLength);
const OPERATORS_SORTED = [...OPERATORS].sort(byLength);

/** One postfix instruction; `n` is a literal's value. */
export interface CalcOp {
  readonly code: string;
  readonly n?: number;
}

export type CalcProgram = readonly CalcOp[];

export class CalcError extends Error {}

// C strtod: hex, decimal with optional exponent, INF, NAN.
const LITERAL = /^(?:0x[0-9a-f]+|(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?|inf(?:inity)?|nan)/i;

/** postfix(): compile an infix expression. Throws CalcError on a bad expression. */
export function compileCalc(expr: string): CalcProgram {
  if (!expr) throw new CalcError('Null argument');
  const out: CalcOp[] = [];
  const stack: { e: Element; code: string; effect: number }[] = [];
  let src = expr;
  let operandNeeded = true;
  let depth = 0;
  let condCount = 0;

  const emit = (top: { e: Element; code: string; effect: number }) => {
    out.push({ code: top.code });
    depth += top.effect;
  };
  const popWhile = (test: (t: { e: Element }) => boolean) => {
    while (stack.length && test(stack[stack.length - 1])) emit(stack.pop()!);
  };

  for (;;) {
    src = src.replace(/^\s+/, '');
    if (!src) break;
    const upper = src.toUpperCase();
    const table = operandNeeded ? OPERANDS_SORTED : OPERATORS_SORTED;
    const e = table.find((t) => upper.startsWith(t.name));
    if (!e) break;
    const at = src; // literals are re-read from their first character
    src = src.slice(e.name.length);

    switch (e.type) {
      case 'OPERAND':
        out.push({ code: e.code });
        depth += e.effect;
        operandNeeded = false;
        break;
      case 'LITERAL': {
        depth += e.effect;
        if (e.code === 'DOUBLE') {
          const m = LITERAL.exec(at);
          if (!m) throw new CalcError('Bad numeric literal');
          const t = m[0].toLowerCase();
          const v = t.startsWith('inf')
            ? Infinity
            : t === 'nan'
              ? NaN
              : t.startsWith('0x')
                ? parseInt(t, 16)
                : Number(m[0]);
          out.push({ code: 'LITERAL', n: v });
          src = at.slice(m[0].length);
        } else {
          const m = /^0x[0-9a-f]+/i.exec(at);
          if (!m) throw new CalcError('Bad numeric literal');
          out.push({ code: 'LITERAL', n: parseInt(m[0], 16) | 0 });
          src = at.slice(m[0].length);
        }
        operandNeeded = false;
        break;
      }
      case 'STORE': {
        const prev = out[out.length - 1];
        if (!prev || stack.length || !/^FETCH_[A-L]$/.test(prev.code)) {
          throw new CalcError('Bad assignment target');
        }
        out.pop();
        stack.push({ e, code: `STORE_${prev.code.slice(6)}`, effect: e.effect });
        depth -= 1;
        operandNeeded = true;
        break;
      }
      case 'UNARY':
        popWhile((t) => t.e.inStack >= e.inComing);
        stack.push({ e, code: e.code, effect: e.effect });
        break;
      case 'BINARY':
        popWhile((t) => t.e.inStack >= e.inComing);
        stack.push({ e, code: e.code, effect: e.effect });
        operandNeeded = true;
        break;
      case 'SEPARATOR':
        if (!stack.length) throw new CalcError('Comma without enclosing parentheses');
        while (stack[stack.length - 1].e.name !== '(') {
          if (stack.length <= 1) throw new CalcError('Comma without enclosing parentheses');
          emit(stack.pop()!);
        }
        operandNeeded = true;
        break;
      case 'CLOSE_PAREN': {
        if (!stack.length) throw new CalcError('Close parenthesis found without open');
        while (stack[stack.length - 1].e.name !== '(') {
          if (stack.length <= 1) throw new CalcError('Close parenthesis found without open');
          emit(stack.pop()!);
        }
        stack.pop(); // the (
        break;
      }
      case 'CONDITIONAL':
        popWhile((t) => t.e.inStack > e.inComing);
        out.push({ code: e.code });
        depth += e.effect;
        if (e.name === ':') {
          if (--condCount < 0) throw new CalcError('Unbalanced conditional ?: operators');
          stack.push({ e, code: 'COND_END', effect: 0 });
        } else {
          condCount++;
        }
        operandNeeded = true;
        break;
      case 'TERMINATOR':
        while (stack.length) {
          if (stack[stack.length - 1].e.name === '(') throw new CalcError('Parenthesis still open');
          emit(stack.pop()!);
        }
        if (condCount !== 0) throw new CalcError('Unbalanced conditional ?: operators');
        if (depth > 1) throw new CalcError('Too many results returned');
        operandNeeded = true;
        break;
    }
    if (depth < 0) throw new CalcError('Not enough operands provided');
    if (depth >= STACK) throw new CalcError('Runtime stack overflow');
  }

  if (src) throw new CalcError('Syntax error, unknown element');
  while (stack.length) {
    if (stack[stack.length - 1].e.name === '(') throw new CalcError('Parenthesis still open');
    emit(stack.pop()!);
  }
  if (condCount !== 0) throw new CalcError('Unbalanced conditional ?: operators');
  if (operandNeeded || depth !== 1) throw new CalcError('Incomplete expression');
  return out.filter((o) => o.code !== 'PAREN');
}

/** C (int) cast of a double (out-of-range values are undefined in C; wrap here). */
const d2i = (x: number) => (Number.isFinite(x) ? Math.trunc(x) | 0 : 0);

/** cond_search(): index after the matching COND_ELSE / COND_END, or -1. */
function condSearch(prog: CalcProgram, from: number, match: string): number {
  let count = 1;
  for (let i = from; i < prog.length; i++) {
    const code = prog[i].code;
    if (code === match && --count === 0) return i + 1;
    if (code === 'COND_IF') count++;
  }
  return -1;
}

/**
 * calcPerform(): evaluate a compiled expression. `args` holds A..L (it is
 * written by `:=` stores). Returns null when the program is malformed at run
 * time (EPICS returns -1).
 */
export function performCalc(prog: CalcProgram, args: number[]): number | null {
  const st: number[] = [];
  let pc = 0;
  while (pc < prog.length) {
    const { code, n } = prog[pc++];
    if (code.startsWith('FETCH_')) {
      st.push(args[VARS.indexOf(code[6])] ?? 0);
      continue;
    }
    if (code.startsWith('STORE_')) {
      args[VARS.indexOf(code[6])] = st.pop() ?? 0;
      continue;
    }
    const top = () => st[st.length - 1];
    const bin = (f: (a: number, b: number) => number) => {
      const b = st.pop()!;
      st[st.length - 1] = f(top(), b);
    };
    const un = (f: (a: number) => number) => {
      st[st.length - 1] = f(top());
    };
    switch (code) {
      case 'LITERAL':
        st.push(n ?? 0);
        break;
      case 'CONST_PI':
        st.push(Math.PI);
        break;
      case 'CONST_D2R':
        st.push(Math.PI / 180);
        break;
      case 'CONST_R2D':
        st.push(180 / Math.PI);
        break;
      case 'RANDOM':
        st.push(Math.random());
        break;
      case 'UNARY_NEG':
        un((a) => -a);
        break;
      case 'ADD':
        bin((a, b) => a + b);
        break;
      case 'SUB':
        bin((a, b) => a - b);
        break;
      case 'MULT':
        bin((a, b) => a * b);
        break;
      case 'DIV':
        bin((a, b) => a / b);
        break;
      case 'MODULO':
        bin((a, b) => a % b); // fmod
        break;
      case 'POWER':
        bin((a, b) => Math.pow(a, b));
        break;
      case 'ABS_VAL':
        un(Math.abs);
        break;
      case 'EXP':
        un(Math.exp);
        break;
      case 'LOG_10':
        un(Math.log10);
        break;
      case 'LOG_E':
        un(Math.log);
        break;
      case 'MAX':
        bin((a, b) => (a < b || Number.isNaN(b) ? b : a));
        break;
      case 'MIN':
        bin((a, b) => (a > b || Number.isNaN(b) ? b : a));
        break;
      case 'SQU_RT':
        un(Math.sqrt);
        break;
      case 'ACOS':
        un(Math.acos);
        break;
      case 'ASIN':
        un(Math.asin);
        break;
      case 'ATAN':
        un(Math.atan);
        break;
      case 'ATAN2':
        // EPICS: ATAN2(a, b) = atan2(b, a)
        bin((a, b) => Math.atan2(b, a));
        break;
      case 'COS':
        un(Math.cos);
        break;
      case 'SIN':
        un(Math.sin);
        break;
      case 'TAN':
        un(Math.tan);
        break;
      case 'COSH':
        un(Math.cosh);
        break;
      case 'SINH':
        un(Math.sinh);
        break;
      case 'TANH':
        un(Math.tanh);
        break;
      case 'CEIL':
        un(Math.ceil);
        break;
      case 'FLOOR':
        un(Math.floor);
        break;
      case 'FINITE':
        un((v) => (Number.isFinite(v) ? 1 : 0));
        break;
      case 'ISNAN':
        un((v) => (Number.isNaN(v) ? 1 : 0));
        break;
      case 'ISINF':
        un((a) => (Math.abs(a) === Infinity ? 1 : 0));
        break;
      case 'NINT':
        un((a) => Math.trunc(a >= 0 ? a + 0.5 : a - 0.5));
        break;
      case 'REL_OR':
        bin((a, b) => (a || b ? 1 : 0));
        break;
      case 'REL_AND':
        bin((a, b) => (a && b ? 1 : 0));
        break;
      case 'REL_NOT':
        un((a) => (a ? 0 : 1));
        break;
      case 'BIT_OR':
        bin((a, b) => d2i(a) | d2i(b));
        break;
      case 'BIT_AND':
        bin((a, b) => d2i(a) & d2i(b));
        break;
      case 'BIT_EXCL_OR':
        bin((a, b) => d2i(a) ^ d2i(b));
        break;
      case 'BIT_NOT':
        un((a) => ~d2i(a));
        break;
      case 'RIGHT_SHIFT_ARITH':
        bin((a, b) => d2i(a) >> d2i(b));
        break;
      case 'LEFT_SHIFT_ARITH':
        bin((a, b) => d2i(a) << d2i(b));
        break;
      case 'NOT_EQ':
        bin((a, b) => (a !== b ? 1 : 0));
        break;
      case 'LESS_THAN':
        bin((a, b) => (a < b ? 1 : 0));
        break;
      case 'LESS_OR_EQ':
        bin((a, b) => (a <= b ? 1 : 0));
        break;
      case 'EQUAL':
        bin((a, b) => (a === b ? 1 : 0));
        break;
      case 'GR_OR_EQ':
        bin((a, b) => (a >= b ? 1 : 0));
        break;
      case 'GR_THAN':
        bin((a, b) => (a > b ? 1 : 0));
        break;
      case 'COND_IF':
        if (st.pop() === 0) {
          pc = condSearch(prog, pc, 'COND_ELSE');
          if (pc < 0) return null;
        }
        break;
      case 'COND_ELSE':
        pc = condSearch(prog, pc, 'COND_END');
        if (pc < 0) return null;
        break;
      case 'COND_END':
        break;
      default:
        return null;
    }
  }
  return st.length === 1 ? st[0] : null;
}
