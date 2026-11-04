// Minimal evaluator for the Formula Engine expression subset (sandboxed Python
// expressions) so formulas whose inputs are all CLIENT-side (loc:// locals)
// can evaluate without a server round-trip. Mirrors what compileRule emits:
// nested conditionals (`a if c else b`), and/or/not, comparisons, arithmetic,
// `{token}` placeholders, literals, and a small math-function namespace.
//
// This is NOT a general Python evaluator — anything outside the subset
// throws PyExprError and the caller downgrades to a warning (same contract
// as Formula Engine-side validation failures).

export class PyExprError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PyExprError';
  }
}

export type PyValue = number | string | boolean | null;

type TokenType = 'num' | 'str' | 'name' | 'binding' | 'op';

interface Token {
  type: TokenType;
  text: string;
}

const OPS = [
  '**',
  '==',
  '!=',
  '<=',
  '>=',
  '//',
  '(',
  ')',
  ',',
  '+',
  '-',
  '*',
  '/',
  '%',
  '<',
  '>',
] as const;

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (c === '{') {
      const end = source.indexOf('}', i);
      if (end === -1) throw new PyExprError('unterminated {token}');
      tokens.push({ type: 'binding', text: source.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let text = '';
      while (j < source.length && source[j] !== c) {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1]!;
          text += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc;
          j += 2;
        } else {
          text += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new PyExprError('unterminated string');
      tokens.push({ type: 'str', text });
      i = j + 1;
      continue;
    }
    if (/[0-9.]/.test(c) && /[0-9]/.test(source.slice(i).replace('.', '')[0] ?? '')) {
      const m = /^\d*\.?\d+(e[+-]?\d+)?/i.exec(source.slice(i));
      if (m) {
        tokens.push({ type: 'num', text: m[0] });
        i += m[0].length;
        continue;
      }
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(source.slice(i))!;
      tokens.push({ type: 'name', text: m[0] });
      i += m[0].length;
      continue;
    }
    const op = OPS.find((candidate) => source.startsWith(candidate, i));
    if (op) {
      tokens.push({ type: 'op', text: op });
      i += op.length;
      continue;
    }
    throw new PyExprError(`unexpected character '${c}'`);
  }
  return tokens;
}

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  max: (...a) => Math.max(...a),
  min: (...a) => Math.min(...a),
  abs: (a) => Math.abs(a!),
  sqrt: (a) => Math.sqrt(a!),
  floor: (a) => Math.floor(a!),
  ceil: (a) => Math.ceil(a!),
  round: (a) => Math.round(a!),
  exp: (a) => Math.exp(a!),
  log: (a) => Math.log(a!),
  log10: (a) => Math.log10(a!),
  pow: (a, b) => Math.pow(a!, b!),
  sin: (a) => Math.sin(a!),
  cos: (a) => Math.cos(a!),
  tan: (a) => Math.tan(a!),
  asin: (a) => Math.asin(a!),
  acos: (a) => Math.acos(a!),
  atan: (a) => Math.atan(a!),
  atan2: (a, b) => Math.atan2(a!, b!),
} as Record<string, (...args: number[]) => number>;

function truthy(value: PyValue): boolean {
  if (value === null || value === false) return false;
  if (value === 0 || value === '') return false;
  return true;
}

function asNumber(value: PyValue, context: string): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  throw new PyExprError(`${context} needs a number, got ${JSON.stringify(value)}`);
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  private readonly bindings: ReadonlyMap<string, PyValue>;

  constructor(tokens: Token[], bindings: ReadonlyMap<string, PyValue>) {
    this.tokens = tokens;
    this.bindings = bindings;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private takeOp(text: string): boolean {
    const t = this.peek();
    if (t && t.type === 'op' && t.text === text) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private takeName(text: string): boolean {
    const t = this.peek();
    if (t && t.type === 'name' && t.text === text) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parse(): PyValue {
    const value = this.conditional();
    if (this.pos !== this.tokens.length) {
      throw new PyExprError(`trailing input at token ${this.pos}`);
    }
    return value;
  }

  // conditional := or ('if' or 'else' conditional)?
  private conditional(): PyValue {
    const value = this.or();
    if (this.takeName('if')) {
      const cond = this.or();
      if (!this.takeName('else')) throw new PyExprError("conditional missing 'else'");
      const alt = this.conditional();
      return truthy(cond) ? value : alt;
    }
    return value;
  }

  private or(): PyValue {
    let value = this.and();
    while (this.takeName('or')) {
      const rhs = this.and();
      value = truthy(value) ? value : rhs;
    }
    return value;
  }

  private and(): PyValue {
    let value = this.not();
    while (this.takeName('and')) {
      const rhs = this.not();
      value = truthy(value) ? rhs : value;
    }
    return value;
  }

  private not(): PyValue {
    if (this.takeName('not')) return !truthy(this.not());
    return this.comparison();
  }

  private comparison(): PyValue {
    const lhs = this.arith();
    const t = this.peek();
    if (t && t.type === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(t.text)) {
      this.pos += 1;
      const rhs = this.arith();
      switch (t.text) {
        case '==':
          return lhs === rhs;
        case '!=':
          return lhs !== rhs;
        case '<':
          return asNumber(lhs, '<') < asNumber(rhs, '<');
        case '<=':
          return asNumber(lhs, '<=') <= asNumber(rhs, '<=');
        case '>':
          return asNumber(lhs, '>') > asNumber(rhs, '>');
        case '>=':
          return asNumber(lhs, '>=') >= asNumber(rhs, '>=');
      }
    }
    return lhs;
  }

  private arith(): PyValue {
    let value = this.term();
    for (;;) {
      if (this.takeOp('+')) {
        const rhs = this.term();
        if (typeof value === 'string' && typeof rhs === 'string') {
          value = value + rhs;
        } else {
          value = asNumber(value, '+') + asNumber(rhs, '+');
        }
      } else if (this.takeOp('-')) {
        value = asNumber(value, '-') - asNumber(this.term(), '-');
      } else {
        return value;
      }
    }
  }

  private term(): PyValue {
    let value = this.factor();
    for (;;) {
      if (this.takeOp('*')) value = asNumber(value, '*') * asNumber(this.factor(), '*');
      else if (this.takeOp('/')) value = asNumber(value, '/') / asNumber(this.factor(), '/');
      else if (this.takeOp('//'))
        value = Math.floor(asNumber(value, '//') / asNumber(this.factor(), '//'));
      else if (this.takeOp('%')) value = asNumber(value, '%') % asNumber(this.factor(), '%');
      else return value;
    }
  }

  private factor(): PyValue {
    if (this.takeOp('+')) return asNumber(this.factor(), 'unary +');
    if (this.takeOp('-')) return -asNumber(this.factor(), 'unary -');
    return this.power();
  }

  private power(): PyValue {
    const base = this.atom();
    if (this.takeOp('**')) {
      return Math.pow(asNumber(base, '**'), asNumber(this.factor(), '**'));
    }
    return base;
  }

  private atom(): PyValue {
    const t = this.peek();
    if (!t) throw new PyExprError('unexpected end of expression');
    if (t.type === 'num') {
      this.pos += 1;
      return Number(t.text);
    }
    if (t.type === 'str') {
      this.pos += 1;
      return t.text;
    }
    if (t.type === 'binding') {
      this.pos += 1;
      if (!this.bindings.has(t.text)) throw new PyExprError(`unbound token {${t.text}}`);
      return this.bindings.get(t.text)!;
    }
    if (t.type === 'op' && t.text === '(') {
      this.pos += 1;
      const value = this.conditional();
      if (!this.takeOp(')')) throw new PyExprError("missing ')'");
      return value;
    }
    if (t.type === 'name') {
      this.pos += 1;
      if (t.text === 'True') return true;
      if (t.text === 'False') return false;
      if (t.text === 'None') return null;
      const fn = FUNCTIONS[t.text];
      if (fn && this.takeOp('(')) {
        const args: number[] = [];
        if (!this.takeOp(')')) {
          for (;;) {
            args.push(asNumber(this.conditional(), `${t.text}()`));
            if (this.takeOp(',')) continue;
            if (this.takeOp(')')) break;
            throw new PyExprError(`bad argument list for ${t.text}()`);
          }
        }
        return fn(...args);
      }
      throw new PyExprError(`unknown name '${t.text}'`);
    }
    throw new PyExprError(`unexpected token '${t.text}'`);
  }
}

/** Evaluate a Formula Engine wire expression against `{token}` binding values. */
export function evaluatePyExpr(
  expression: string,
  bindings: ReadonlyMap<string, PyValue>
): PyValue {
  return new Parser(tokenize(expression), bindings).parse();
}
