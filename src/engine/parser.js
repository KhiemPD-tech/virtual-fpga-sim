/**
 * Phase 2 / v2.0 — Recursive-Descent Verilog / SystemVerilog Parser & Elaborator
 * Supports multi-module compilation units, module instantiation with #(parameter)
 * overrides, 2D unpacked memory arrays, static bounded `for` loop unrolling,
 * and recursive hierarchical flattening while preserving 100% v1 compatibility.
 */

import {
  TokenType,
  PRIMITIVE_GATE_KEYWORDS,
  HdlError,
  tokenize,
} from './lexer.js';

export const MAX_FOR_UNROLL = 4096;
export const MAX_HIERARCHY_DEPTH = 32;

/**
 * Parse a Verilog / SystemVerilog numeric literal into a 4-state BigInt descriptor.
 * Supports unsized decimals, sized 'b/'h/'d/'o with underscores, X/Z digits,
 * and IEEE 1364 MSB X/Z left-extension.
 *
 * @param {string} raw
 * @param {number} [line=1]
 * @returns {{ width: number, val: bigint, xMask: bigint, zMask: bigint, sized: boolean, raw: string }}
 */
export function parseVerilogLiteral(raw, line = 1) {
  const clean = String(raw).replace(/_/g, '');
  const tickIdx = clean.indexOf("'");

  if (tickIdx === -1) {
    if (!/^[0-9]+$/.test(clean)) {
      throw new HdlError({
        code: 'INVALID_LITERAL',
        severity: 'error',
        line,
        message: `Invalid decimal literal '${raw}' at line ${line}`,
        params: { literal: raw, line },
      });
    }
    const val = BigInt(clean);
    const mask32 = (1n << 32n) - 1n;
    return {
      width: 32,
      val: val & mask32,
      xMask: 0n,
      zMask: 0n,
      sized: false,
      raw,
    };
  }

  const sizePart = clean.slice(0, tickIdx);
  const sized = sizePart.length > 0;
  const width = sized ? parseInt(sizePart, 10) : 32;
  if (sized && (!Number.isInteger(width) || width <= 0)) {
    throw new HdlError({
      code: 'INVALID_LITERAL',
      severity: 'error',
      line,
      message: `Invalid bit width in literal '${raw}' at line ${line}`,
      params: { literal: raw, line },
    });
  }

  let rest = clean.slice(tickIdx + 1).toLowerCase();
  const mask = (1n << BigInt(width)) - 1n;

  // Unbased unsized SV literal: '0, '1, 'x, 'z
  if (!sized && rest.length === 1 && /[01xz]/.test(rest)) {
    if (rest === '0') return { width: 1, val: 0n, xMask: 0n, zMask: 0n, sized: false, raw, fillBit: '0' };
    if (rest === '1') return { width: 1, val: 1n, xMask: 0n, zMask: 0n, sized: false, raw, fillBit: '1' };
    if (rest === 'x') return { width: 1, val: 0n, xMask: 1n, zMask: 0n, sized: false, raw, fillBit: 'x' };
    return { width: 1, val: 0n, xMask: 0n, zMask: 1n, sized: false, raw, fillBit: 'z' };
  }

  if (rest.startsWith('s')) {
    rest = rest.slice(1);
  }

  const base = rest[0];
  const digits = rest.slice(1);
  if (!digits) {
    throw new HdlError({
      code: 'INVALID_LITERAL',
      severity: 'error',
      line,
      message: `Missing digits in literal '${raw}' at line ${line}`,
      params: { literal: raw, line },
    });
  }

  let val = 0n;
  let xMask = 0n;
  let zMask = 0n;

  if (base === 'd') {
    if (digits === 'x') {
      return { width, val: 0n, xMask: mask, zMask: 0n, sized, raw };
    }
    if (digits === 'z' || digits === '?') {
      return { width, val: 0n, xMask: 0n, zMask: mask, sized, raw };
    }
    if (!/^[0-9]+$/.test(digits)) {
      throw new HdlError({
        code: 'INVALID_LITERAL',
        severity: 'error',
        line,
        message: `Invalid decimal digits in literal '${raw}' at line ${line}`,
        params: { literal: raw, line },
      });
    }
    val = BigInt(digits) & mask;
    return { width, val, xMask: 0n, zMask: 0n, sized, raw };
  }

  const bitsPerDigit = base === 'b' ? 1 : base === 'o' ? 3 : base === 'h' ? 4 : 0;
  if (bitsPerDigit === 0) {
    throw new HdlError({
      code: 'INVALID_LITERAL',
      severity: 'error',
      line,
      message: `Unsupported radix '${base}' in literal '${raw}' at line ${line}`,
      params: { literal: raw, base, line },
    });
  }

  const digitMask = (1n << BigInt(bitsPerDigit)) - 1n;
  const shiftStep = BigInt(bitsPerDigit);
  const validDigitRe = base === 'b' ? /^[01]$/ : base === 'o' ? /^[0-7]$/ : /^[0-9a-f]$/;

  for (let idx = 0; idx < digits.length; idx++) {
    const d = digits[idx];
    val <<= shiftStep;
    xMask <<= shiftStep;
    zMask <<= shiftStep;

    if (d === 'x') {
      xMask |= digitMask;
    } else if (d === 'z' || d === '?') {
      zMask |= digitMask;
    } else if (validDigitRe.test(d)) {
      const radix = base === 'b' ? 2 : base === 'o' ? 8 : 16;
      val |= BigInt(parseInt(d, radix));
    } else {
      throw new HdlError({
        code: 'INVALID_LITERAL',
        severity: 'error',
        line,
        message: `Invalid digit '${d}' in base-'${base}' literal '${raw}' at line ${line}`,
        params: { literal: raw, digit: d, base, line },
      });
    }
  }

  // IEEE 1364 MSB X/Z left-extension when specified digits are narrower than width
  const specifiedBits = digits.length * bitsPerDigit;
  if (specifiedBits < width) {
    const msbChar = digits[0];
    const upperMask = mask ^ ((1n << BigInt(specifiedBits)) - 1n);
    if (msbChar === 'x') {
      xMask |= upperMask;
    } else if (msbChar === 'z' || msbChar === '?') {
      zMask |= upperMask;
    }
  }

  zMask &= mask;
  xMask = (xMask & mask) & ~zMask;
  val = (val & mask) & ~xMask & ~zMask;

  return { width, val, xMask, zMask, sized, raw };
}

/**
 * Evaluate a constant integer expression AST against parameter/loop-variable bindings.
 * Supports arithmetic, bitwise, shift, relational, logical, ternary, and `$clog2()`.
 *
 * @param {object|null} node
 * @param {Record<string, { val: bigint|number }|number|bigint>} [params={}]
 * @returns {number}
 */
export function evalConstExprAst(node, params = {}) {
  if (!node) return 0;
  switch (node.kind) {
    case 'Number':
      return Number(node.val);
    case 'Ident': {
      if (node.name in params) {
        const entry = params[node.name];
        if (typeof entry === 'number') return entry;
        if (typeof entry === 'bigint') return Number(entry);
        if (entry && typeof entry === 'object' && 'val' in entry) return Number(entry.val);
      }
      return 0;
    }
    case 'SysFunc': {
      if (node.name === '$clog2' && node.args && node.args.length >= 1) {
        const v = evalConstExprAst(node.args[0], params);
        if (v <= 1) return 1;
        return Math.ceil(Math.log2(v));
      }
      return 0;
    }
    case 'Unary': {
      const v = evalConstExprAst(node.operand, params);
      if (node.op === '-') return -v;
      if (node.op === '+') return v;
      if (node.op === '~') return ~v;
      if (node.op === '!') return v === 0 ? 1 : 0;
      return v;
    }
    case 'Ternary': {
      const c = evalConstExprAst(node.cond, params);
      return c !== 0
        ? evalConstExprAst(node.thenExpr, params)
        : evalConstExprAst(node.elseExpr, params);
    }
    case 'Binary': {
      const l = evalConstExprAst(node.left, params);
      const r = evalConstExprAst(node.right, params);
      switch (node.op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/': return r !== 0 ? Math.trunc(l / r) : 0;
        case '%': return r !== 0 ? l % r : 0;
        case '<<':
        case '<<<': return l << r;
        case '>>': return l >>> r;
        case '>>>': return l >> r;
        case '&': return l & r;
        case '|': return l | r;
        case '^': return l ^ r;
        case '~^':
        case '^~': return ~(l ^ r);
        case '&&': return (l !== 0 && r !== 0) ? 1 : 0;
        case '||': return (l !== 0 || r !== 0) ? 1 : 0;
        case '==':
        case '===': return l === r ? 1 : 0;
        case '!=':
        case '!==': return l !== r ? 1 : 0;
        case '<': return l < r ? 1 : 0;
        case '<=': return l <= r ? 1 : 0;
        case '>': return l > r ? 1 : 0;
        case '>=': return l >= r ? 1 : 0;
        default: return 0;
      }
    }
    default:
      return 0;
  }
}

function _parResolveDims(range, params) {
  if (!range) return { msb: 0, lsb: 0, width: 1, hasExplicitRange: false };
  const msb = evalConstExprAst(range.msb, params);
  const lsb = evalConstExprAst(range.lsb, params);
  return {
    msb,
    lsb,
    width: Math.abs(msb - lsb) + 1,
    hasExplicitRange: true,
  };
}

function _parResolveUnpackedDims(addrRange, params) {
  if (!addrRange) {
    return { addrMsb: 0, addrLsb: 0, addrMin: 0, addrMax: 0, depth: 1 };
  }
  if (addrRange.isSizeOnly) {
    const size = Math.max(1, evalConstExprAst(addrRange.sizeExpr, params));
    return {
      addrMsb: 0,
      addrLsb: size - 1,
      addrMin: 0,
      addrMax: size - 1,
      depth: size,
    };
  }
  const addrMsb = evalConstExprAst(addrRange.msb, params);
  const addrLsb = evalConstExprAst(addrRange.lsb, params);
  const addrMin = Math.min(addrMsb, addrLsb);
  const addrMax = Math.max(addrMsb, addrLsb);
  return {
    addrMsb,
    addrLsb,
    addrMin,
    addrMax,
    depth: addrMax - addrMin + 1,
  };
}

function _parEvalParamValue(expr, params, explicitRange) {
  if (expr && expr.kind === 'Number') {
    const dims = explicitRange ? _parResolveDims(explicitRange, params) : null;
    const width = dims ? dims.width : expr.width;
    const mask = (1n << BigInt(width)) - 1n;
    return {
      width,
      val: expr.val & mask,
      xMask: expr.xMask & mask,
      zMask: expr.zMask & mask,
      sized: Boolean(dims || expr.sized),
    };
  }
  const numVal = BigInt(evalConstExprAst(expr, params));
  const dims = explicitRange ? _parResolveDims(explicitRange, params) : null;
  const width = dims ? dims.width : 32;
  const mask = (1n << BigInt(width)) - 1n;
  return {
    width,
    val: numVal & mask,
    xMask: 0n,
    zMask: 0n,
    sized: Boolean(dims),
  };
}

/**
 * Parse a Verilog / SystemVerilog compilation unit (one or more modules).
 * Automatically detects the top-level module (last uninstantiated root module,
 * or explicit `options.topModule` override).
 *
 * @param {string} [source='']
 * @param {{ topModule?: string }} [options={}]
 * @returns {{ topModule: object, modules: Record<string, object>, moduleList: object[] }}
 */
export function parseProgram(source = '', options = {}) {
  const tokens = tokenize(source);
  let pos = 0;
  let currentModAst = null;

  const peek = (offset = 0) => tokens[Math.min(pos + offset, tokens.length - 1)];
  const next = () => tokens[pos++];

  const check = (type, value) => {
    const tok = peek();
    if (type && tok.type !== type) return false;
    if (value !== undefined && tok.value !== value) return false;
    return true;
  };

  const match = (type, value) => (check(type, value) ? next() : null);

  const syntaxErr = (code, tok, message, params = {}) => new HdlError({
    code,
    severity: 'error',
    line: tok?.line ?? 1,
    col: tok?.col ?? 1,
    signal: null,
    message,
    params: { ...params, line: tok?.line ?? 1, col: tok?.col ?? 1 },
  });

  const expect = (type, value, code = 'SYNTAX_ERROR', msg = null) => {
    const tok = peek();
    if (!check(type, value)) {
      const expected = value !== undefined ? `'${value}'` : type;
      const got = tok.type === TokenType.EOF ? 'end of file' : `'${tok.value}'`;
      throw syntaxErr(
        code,
        tok,
        msg || `Expected ${expected} at line ${tok.line}, got ${got}`,
        { expected: value ?? type, got: tok.value || 'EOF' }
      );
    }
    return next();
  };

  function parseRange() {
    if (!match(TokenType.PUNCT, '[')) return null;
    const msb = parseExpr();
    expect(TokenType.OPERATOR, ':', 'EXPECTED_COLON');
    const lsb = parseExpr();
    expect(TokenType.PUNCT, ']', 'EXPECTED_RBRACKET');
    return { msb, lsb };
  }

  function parseUnpackedRange() {
    if (!match(TokenType.PUNCT, '[')) return null;
    const first = parseExpr();
    if (match(TokenType.OPERATOR, ':')) {
      const second = parseExpr();
      expect(TokenType.PUNCT, ']', 'EXPECTED_RBRACKET');
      return { msb: first, lsb: second, isSizeOnly: false };
    }
    expect(TokenType.PUNCT, ']', 'EXPECTED_RBRACKET');
    return { sizeExpr: first, isSizeOnly: true };
  }

  function isDirectionKw() {
    return (
      check(TokenType.KEYWORD, 'input') ||
      check(TokenType.KEYWORD, 'output') ||
      check(TokenType.KEYWORD, 'inout')
    );
  }

  function isStorageKw() {
    return (
      check(TokenType.KEYWORD, 'wire') ||
      check(TokenType.KEYWORD, 'reg') ||
      check(TokenType.KEYWORD, 'logic') ||
      check(TokenType.KEYWORD, 'integer') ||
      check(TokenType.KEYWORD, 'int')
    );
  }

  function isPrimitiveGateKw() {
    return check(TokenType.KEYWORD) && PRIMITIVE_GATE_KEYWORDS.has(peek().value);
  }

  function looksLikeInstantiation() {
    if (!check(TokenType.IDENT)) return false;
    const t1 = peek(1);
    if (t1.type === TokenType.PUNCT && t1.value === '#') return true;
    const t2 = peek(2);
    if (t1.type === TokenType.IDENT && t2.type === TokenType.PUNCT && t2.value === '(') {
      return true;
    }
    return false;
  }

  function parseGateInstantiation(targetList) {
    const gateTok = next();
    const gateType = gateTok.value;

    // Optional gate propagation delay: e.g. `and #5 u1(y, a, b);` or `and #(5) (y, a, b);`
    if (match(TokenType.PUNCT, '#')) {
      if (match(TokenType.PUNCT, '(')) {
        while (!check(TokenType.PUNCT, ')') && !check(TokenType.EOF)) {
          parseExpr();
          if (!match(TokenType.PUNCT, ',')) break;
        }
        expect(TokenType.PUNCT, ')', 'EXPECTED_RPAREN');
      } else {
        parsePrimary();
      }
    }

    while (!check(TokenType.EOF)) {
      let instanceName = null;
      if (check(TokenType.IDENT)) {
        instanceName = next().value;
      }
      expect(TokenType.PUNCT, '(', 'EXPECTED_LPAREN', `Expected '(' in '${gateType}' primitive gate`);

      const args = [];
      if (!check(TokenType.PUNCT, ')')) {
        args.push(parseExpr());
        while (match(TokenType.PUNCT, ',')) {
          args.push(parseExpr());
        }
      }
      expect(TokenType.PUNCT, ')', 'EXPECTED_RPAREN');

      if (args.length < 2) {
        throw syntaxErr(
          'INVALID_GATE_PORTS',
          gateTok,
          `Primitive gate '${gateType}' requires at least 2 terminals (output, input...) at line ${gateTok.line}`,
          { gate: gateType, argCount: args.length }
        );
      }

      if (gateType === 'not' || gateType === 'buf') {
        // IEEE 1364: not/buf have 1+ outputs followed by 1 input: not [u1] (out1, [out2...,] in);
        const inp = args[args.length - 1];
        const outputs = args.slice(0, -1);
        for (let oi = 0; oi < outputs.length; oi++) {
          const outExpr = outputs[oi];
          if (!_parIsValidLValueKind(outExpr)) {
            throw syntaxErr(
              'INVALID_GATE_OUTPUT',
              gateTok,
              `Output terminal of '${gateType}' gate must be a writable net/bit-select at line ${gateTok.line}`,
              { gate: gateType }
            );
          }
          targetList.push({
            kind: 'Gate',
            gateType,
            instanceName: instanceName
              ? (outputs.length > 1 ? `${instanceName}_${oi}` : instanceName)
              : null,
            target: outExpr,
            inputs: [inp],
            line: gateTok.line,
          });
        }
      } else {
        // IEEE 1364: and/or/nand/nor/xor/xnor have 1 output followed by 1+ inputs
        const outExpr = args[0];
        if (!_parIsValidLValueKind(outExpr)) {
          throw syntaxErr(
            'INVALID_GATE_OUTPUT',
            gateTok,
            `Output terminal of '${gateType}' gate must be a writable net/bit-select at line ${gateTok.line}`,
            { gate: gateType }
          );
        }
        targetList.push({
          kind: 'Gate',
          gateType,
          instanceName,
          target: outExpr,
          inputs: args.slice(1),
          line: gateTok.line,
        });
      }

      if (!match(TokenType.PUNCT, ',')) break;
    }

    expect(TokenType.PUNCT, ';', 'EXPECTED_SEMICOLON');
  }

  function parseInstantiation(targetList) {
    const modNameTok = expect(TokenType.IDENT, undefined, 'EXPECTED_MODULE_NAME');
    const paramOverrides = [];

    // Optional #( ... ) parameter override list (named .P(expr) or positional expr)
    if (match(TokenType.PUNCT, '#')) {
      expect(TokenType.PUNCT, '(', 'EXPECTED_LPAREN');
      while (!check(TokenType.PUNCT, ')') && !check(TokenType.EOF)) {
        if (match(TokenType.PUNCT, '.')) {
          const pNameTok = expect(TokenType.IDENT, undefined, 'EXPECTED_IDENT', 'Expected parameter name');
          expect(TokenType.PUNCT, '(', 'EXPECTED_LPAREN');
          const pExpr = parseExpr();
          expect(TokenType.PUNCT, ')', 'EXPECTED_RPAREN');
          paramOverrides.push({ name: pNameTok.value, expr: pExpr, line: pNameTok.line });
        } else {
          const exprTok = peek();
          const pExpr = parseExpr();
          paramOverrides.push({ name: null, expr: pExpr, line: exprTok.line });
        }
        if (!match(TokenType.PUNCT, ',')) break;
      }
      expect(TokenType.PUNCT, ')', 'EXPECTED_RPAREN');
    }

    // One or more comma-separated instances sharing the same module & parameters
    while (!check(TokenType.EOF)) {
      const instNameTok = expect(TokenType.IDENT, undefined, 'EXPECTED_INSTANCE_NAME', 'Expected instance identifier');
      expect(TokenType.PUNCT, '(', 'EXPECTED_LPAREN');

      const portConnections = [];
      if (!check(TokenType.PUNCT, ')')) {
        while (!check(TokenType.PUNCT, ')') && !check(TokenType.EOF)) {
          if (match(TokenType.PUNCT, '.')) {
            const portTok = expect(TokenType.IDENT, undefined, 'EXPECTED_PORT_NAME', 'Expected port identifier');
            expect(TokenType.PUNCT, '(', 'EXPECTED_LPAREN');
            let connExpr = null;
            if (!check(TokenType.PUNCT, ')')) {
              connExpr = parseExpr();
            }
            expect(TokenType.PUNCT, ')', 'EXPECTED_RPAREN');
            portConnections.push({
              portName: portTok.value,
              expr: connExpr,
              line: portTok.line,
            });
          } else {
            const exprTok = peek();
            const connExpr = parseExpr();
            portConnections.push({
              portName: null,
              expr: connExpr,
              line: exprTok.line,
            });
          }
          if (!match(TokenType.PUNCT, ',')) break;
        }
      }
      expect(TokenType.PUNCT, ')', 'EXPECTED_RPAREN');

      targetList.push({
        kind: 'Instance',
        moduleName: modNameTok.value,
        instanceName: instNameTok.value,
        paramOverrides: paramOverrides.map((p) => ({ ...p })),
        portConnections,
        line: modNameTok.line,
      });

      if (!match(TokenType.PUNCT, ',')) break;
    }

    expect(TokenType.PUNCT, ';', 'EXPECTED_SEMICOLON');
  }

  function parseFunctionDef(ast) {
    const fnTok = expect(TokenType.KEYWORD, 'function', 'EXPECTED_FUNCTION');
    match(TokenType.KEYWORD, 'automatic');

    let retStorage = null;
    if (isStorageKw()) {
      retStorage = next().value;
    }
    match(TokenType.KEYWORD, 'signed');
    const retRange = parseRange();
    const isIntRet = retStorage === 'integer' || retStorage === 'int';
    const retDims = retRange
      ? _parResolveDims(retRange, ast.params)
      : isIntRet
        ? { msb: 31, lsb: 0, width: 32 }
        : { msb: 0, lsb: 0, width: 1 };

    const nameTok = expect(TokenType.IDENT, undefined, 'EXPECTED_IDENT', 'Expected function identifier');
    const args = [];
    const locals = [];
    const localParams = [];

    // Optional ANSI argument list: function [W-1:0] fname (input [W-1:0] a, input b);
    if (match(TokenType.PUNCT, '(')) {
      if (!check(TokenType.PUNCT, ')')) {
        let curRange = null;
        let curIsInt = false;
        while (!check(TokenType.PUNCT, ')') && !check(TokenType.EOF)) {
          if (isDirectionKw()) {
            next();
            curRange = null;
            curIsInt = false;
          }
          if (isStorageKw()) {
            const st = next().value;
            curIsInt = st === 'integer' || st === 'int';
          }
          match(TokenType.KEYWORD, 'signed');
          if (check(TokenType.PUNCT, '[')) {
            curRange = parseRange();
          }
          const argTok = expect(TokenType.IDENT, undefined, 'EXPECTED_IDENT', 'Expected function argument identifier');
          const dims = curRange
            ? _parResolveDims(curRange, ast.params)
            : curIsInt
              ? { msb: 31, lsb: 0, width: 32 }
              : { msb: 0, lsb: 0, width: 1 };
          args.push({
            name: argTok.value,
            rangeExpr: curRange,
            msb: dims.msb,
            lsb: dims.lsb,
            width: dims.width,
            line: argTok.line,
          });
          if (!match(TokenType.PUNCT, ',')) break;
        }
      }
      expect(TokenType.PUNCT, ')', 'EXPECTED_RPAREN');
    }
    expect(TokenType.PUNCT, ';', 'EXPECTED_SEMICOLON');

    // Classic Verilog-1995 function item declarations (input, reg/logic/integer, localparam)
    while (!check(TokenType.KEYWORD, 'endfunction') && !check(TokenType.EOF)) {
      if (check(TokenType.KEYWORD, 'parameter') || check(TokenType.KEYWORD, 'localparam')) {
        const pKind = next().value;
        if (check(TokenType.KEYWORD, 'logic') || check(TokenType.KEYWORD, 'integer') || check(TokenType.KEYWORD, 'int')) {
          next();
        }
        const pRange = parseRange();
        while (!check(TokenType.PUNCT, ';') && !check(TokenType.EOF)) {
          const pTok = expect(TokenType.IDENT, undefined, 'EXPECTED_IDENT');
          expect(TokenType.OPERATOR, '=', 'EXPECTED_ASSIGN');
          const pExpr = parseExpr();
          localParams.push({ name: pTok.value, kind: pKind, rangeExpr: pRange, expr: pExpr, line: pTok.line });
          if (!match(TokenType.PUNCT, ',')) break;
        }
        expect(TokenType.PUNCT, ';', 'EXPECTED_SEMICOLON');
      } else if (isDirectionKw()) {
        next(); // input
        let st = null;
        if (isStorageKw()) st = next().value;
        match(TokenType.KEYWORD, 'signed');
        const range = parseRange();
        const isInt = st === 'integer' || st === 'int';
        const dims = range
          ? _parResolveDims(range, ast.params)
          : isInt
            ? { msb: 31, lsb: 0, width: 32 }
            : { msb: 0, lsb: 0, width: 1 };
        while (!check(TokenType.PUNCT, ';') && !check(TokenType.EOF)) {
          const argTok = expect(TokenType.IDENT, undefined, 'EXPECTED_IDENT', 'Expected function argument identifier');
          args.push({
            name: argTok.value,
            rangeExpr: range,
            msb: dims.msb,
            lsb: dims.lsb,
            width: dims.width,
            line: argTok.line,
          });
          if (!match(TokenType.PUNCT, ',')) break;
        }
        expect(TokenType.PUNCT, ';', 'EXPECTED_SEMICOLON');
      } else if (isStorageKw()) {
        const st = next().value;
        match(TokenType.KEYWORD, 'signed');
        const range = parseRange();
        const isInt = st === 'integer' || st === 'int';
        const dims = range
          ? _parResolveDims(range, ast.params)
          : isInt
            ? { msb: 31, lsb: 0, width: 32 }
            : { msb: 0, lsb: 0, width: 1 };
        while (!check(TokenType.PUNCT, ';') && !check(TokenType.EOF)) {
          const locTok = expect(TokenType.IDENT, undefined, 'EXPECTED_IDENT', 'Expected local variable identifier');
          locals.push({
            name: locTok.value,
            rangeExpr: range,
            msb: dims.msb,
            lsb: dims.lsb,
            width: dims.width,
            isInteger: isInt,
            line: locTok.line,
          });
          if (!match(TokenType.PUNCT, ',')) break;
        }
        expect(TokenType.PUNCT, ';', 'EXPECTED_SEMICOLON');
      } else {
        break;
      }
    }

    const bodyStmts = [];
    while (!check(TokenType.KEYWORD, 'endfunction') && !check(TokenType.EOF)) {
      bodyStmts.push(parseStatement());
    }
    expect(TokenType.KEYWORD, 'endfunction', 'EXPECTED_ENDFUNCTION', "Expected 'endfunction'");

    const body = bodyStmts.length === 1
      ? bodyStmts[0]
      : { kind: 'Block', statements: bodyStmts, line: fnTok.line };

    ast.functions[nameTok.value] = {
      kind: 'FunctionDef',
      name: nameTok.value,
      returnRangeExpr: retRange,
      returnMsb: retDims.msb,
      returnLsb: retDims.lsb,
      returnWidth: retDims.width,
      args,
      locals,
      localParams,
      body,
      line: fnTok.line,
    };
  }

  function parseForHeader() {
    expect(TokenType.PUNCT, '(', 'EXPECTED_LPAREN');
    let isInlineInt = false;
    if (
      check(TokenType.KEYWORD, 'genvar') ||
      check(TokenType.KEYWORD, 'int') ||
      check(TokenType.KEYWORD, 'integer')
    ) {
      const declKw = next().value;
      isInlineInt = declKw === 'int' || declKw === 'integer';
    }
    const loopVarTok = expect(TokenType.IDENT, undefined, 'EXPECTED_IDENT', 'Expected loop variable identifier');
    expect(TokenType.OPERATOR, '=', 'EXPECTED_ASSIGN');
    const initExpr = parseExpr();
    expect(TokenType.PUNCT, ';', 'EXPECTED_SEMICOLON');
    const condExpr = parseExpr();
    expect(TokenType.PUNCT, ';', 'EXPECTED_SEMICOLON');

    const stepVarTok = expect(TokenType.IDENT, undefined, 'EXPECTED_IDENT', 'Expected loop step variable');
    let stepExpr;
    if (match(TokenType.OPERATOR, '=')) {
      stepExpr = parseExpr();
    } else if (check(TokenType.OPERATOR, '+') && peek(1).type === TokenType.OPERATOR && peek(1).value === '+') {
      next();
      next();
      stepExpr = {
        kind: 'Binary',
        op: '+',
        left: { kind: 'Ident', name: stepVarTok.value, line: stepVarTok.line },
        right: { kind: 'Number', width: 32, val: 1n, xMask: 0n, zMask: 0n, sized: false, raw: '1', line: stepVarTok.line },
        line: stepVarTok.line,
      };
    } else if (check(TokenType.OPERATOR, '-') && peek(1).type === TokenType.OPERATOR && peek(1).value === '-') {
      next();
      next();
      stepExpr = {
        kind: 'Binary',
        op: '-',
        left: { kind: 'Ident', name: stepVarTok.value, line: stepVarTok.line },
        right: { kind: 'Number', width: 32, val: 1n, xMask: 0n, zMask: 0n, sized: false, raw: '1', line: stepVarTok.line },
        line: stepVarTok.line,
      };
    } else {
      const bad = peek();
      throw syntaxErr(
        'EXPECTED_ASSIGN_OP',
        bad,
        `Expected '=', '++', or '--' in for-loop step at line ${bad.line}`,
        { got: bad.value }
      );
    }
    expect(TokenType.PUNCT, ')', 'EXPECTED_RPAREN');
    return { loopVar: loopVarTok.value, isInlineInt, initExpr, condExpr, stepExpr };
  }

  function parseGenerateBody(ast) {
    let blockName = null;
    const items = [];
    if (match(TokenType.KEYWORD, 'begin')) {
      if (match(TokenType.OPERATOR, ':')) {
        blockName = expect(TokenType.IDENT, undefined, 'EXPECTED_IDENT', 'Expected generate block label').value;
      }
      while (!check(TokenType.KEYWORD, 'end') && !check(TokenType.EOF)) {
        parseGenerateItem(items, ast);
      }
      expect(TokenType.KEYWORD, 'end', 'EXPECTED_END', "Expected 'end' in generate block");
    } else {
      parseGenerateItem(items, ast);
    }
    return { blockName, items };
  }

  function parseGenerateItem(targetList, ast) {
    const tok = peek();

    if (match(TokenType.KEYWORD, 'for')) {
      const hdr = parseForHeader();
      const body = parseGenerateBody(ast);
      targetList.push({
        kind: 'GenerateFor',
        ...hdr,
        blockName: body.blockName,
        items: body.items,
        line: tok.line,
      });
      return;
    }

    if (match(TokenType.KEYWORD, 'if')) {
      expect(TokenType.PUNCT, '(', 'EXPECTED_LPAREN');
      const condExpr = parseExpr();
      expect(TokenType.PUNCT, ')', 'EXPECTED_RPAREN');
      const thenBlock = parseGenerateBody(ast);
      let elseBlock = null;
      if (match(TokenType.KEYWORD, 'else')) {
        elseBlock = parseGenerateBody(ast);
      }
      targetList.push({
        kind: 'GenerateIf',
        condExpr,
        thenBlock,
        elseBlock,
        line: tok.line,
      });
      return;
    }

    if (check(TokenType.KEYWORD, 'parameter') || check(TokenType.KEYWORD, 'localparam')) {
      const paramKind = next().value;
      if (check(TokenType.KEYWORD, 'logic') || check(TokenType.KEYWORD, 'integer') || check(TokenType.KEYWORD, 'int')) {
        next();
      }
      const rangeExpr = parseRange();
      const defs = [];
      while (!check(TokenType.PUNCT, ';') && !check(TokenType.EOF)) {
        const pTok = expect(TokenType.IDENT, undefined, 'EXPECTED_IDENT');
        expect(TokenType.OPERATOR, '=', 'EXPECTED_ASSIGN');
        const expr = parseExpr();
        defs.push({ name: pTok.value, expr, line: pTok.line });
        if (!match(TokenType.PUNCT, ',')) break;
      }
      expect(TokenType.PUNCT, ';', 'EXPECTED_SEMICOLON');
      targetList.push({ kind: 'GenParam', paramKind, rangeExpr, defs, line: tok.line });
      return;
    }

    if (isStorageKw()) {
      const storage = next().value;
      match(TokenType.KEYWORD, 'signed');
      const rangeExpr = parseRange();
      const isInteger = storage === 'integer' || storage === 'int';
      const declItems = [];
      while (!check(TokenType.PUNCT, ';') && !check(TokenType.EOF)) {
        const sigTok = expect(TokenType.IDENT, undefined, 'EXPECTED_IDENT', 'Expected signal identifier');
        if (check(TokenType.PUNCT, '[')) {
          const addrRange = parseUnpackedRange();
          declItems.push({ name: sigTok.value, isMemory: true, addrRange, initExpr: null, line: sigTok.line });
        } else {
          let initExpr = null;
          if (match(TokenType.OPERATOR, '=')) {
            initExpr = parseExpr();
          }
          declItems.push({ name: sigTok.value, isMemory: false, addrRange: null, initExpr, line: sigTok.line });
        }
        if (!match(TokenType.PUNCT, ',')) break;
      }
      expect(TokenType.PUNCT, ';', 'EXPECTED_SEMICOLON');
      targetList.push({ kind: 'GenDecl', storage, rangeExpr, isInteger, items: declItems, line: tok.line });
      return;
    }

    if (check(TokenType.KEYWORD, 'assign')) {
      const assignTok = next();
      const target = parseLValue();
      expect(TokenType.OPERATOR, '=', 'EXPECTED_ASSIGN');
      const expr = parseExpr();
      expect(TokenType.PUNCT, ';', 'EXPECTED_SEMICOLON');
      targetList.push({ kind: 'Assign', target, expr, line: assignTok.line });
      return;
    }

    if (
      check(TokenType.KEYWORD, 'always') ||
      check(TokenType.KEYWORD, 'always_ff') ||
      check(TokenType.KEYWORD, 'always_comb')
    ) {
      targetList.push(parseAlways());
      return;
    }

    if (check(TokenType.KEYWORD, 'initial')) {
      const initTok = next();
      const body = parseStatement();
      targetList.push({ kind: 'Initial', body, line: initTok.line });
      return;
    }

    if (isPrimitiveGateKw()) {
      parseGateInstantiation(targetList);
      return;
    }

    if (looksLikeInstantiation()) {
      parseInstantiation(targetList);
      return;
    }

    if (match(TokenType.PUNCT, ';')) {
      return;
    }

    throw syntaxErr(
      'UNEXPECTED_TOKEN',
      tok,
      `Unexpected token '${tok.value}' inside generate block at line ${tok.line}`,
      { token: tok.value }
    );
  }

  function parseModule() {
    const modTok = expect(TokenType.KEYWORD, 'module', 'EXPECTED_MODULE');
    const nameTok = expect(TokenType.IDENT, undefined, 'EXPECTED_MODULE_NAME', 'Expected module identifier');

    const ast = {
      kind: 'Module',
      name: nameTok.value,
      line: modTok.line,
      ports: [],
      signals: {},
      memories: {},
      params: {},
      paramDefs: [],
      assigns: [],
      gates: [],
      functions: {},
      genvars: [],
      generateBlocks: [],
      alwaysBlocks: [],
      initialBlocks: [],
      instances: [],
    };
    currentModAst = ast;

    const portByName = new Map();

    // Optional #(parameter ...) header
    if (match(TokenType.PUNCT, '#')) {
      expect(TokenType.PUNCT, '(', 'EXPECTED_LPAREN');
      let curParamKind = 'parameter';
      let curParamRange = null;
      while (!check(TokenType.PUNCT, ')') && !check(TokenType.EOF)) {
        if (check(TokenType.KEYWORD, 'parameter') || check(TokenType.KEYWORD, 'localparam')) {
          curParamKind = next().value;
          curParamRange = null;
        }
        if (
          check(TokenType.KEYWORD, 'logic') ||
          check(TokenType.KEYWORD, 'integer') ||
          check(TokenType.KEYWORD, 'int')
        ) {
          next();
        }
        if (check(TokenType.PUNCT, '[')) {
          curParamRange = parseRange();
        }
        const pTok = expect(TokenType.IDENT, undefined, 'EXPECTED_IDENT');
        expect(TokenType.OPERATOR, '=', 'EXPECTED_ASSIGN');
        const pExpr = parseExpr();
        ast.params[pTok.value] = _parEvalParamValue(pExpr, ast.params, curParamRange);
        ast.paramDefs.push({
          name: pTok.value,
          kind: curParamKind,
          rangeExpr: curParamRange,
          expr: pExpr,
          line: pTok.line,
        });
        if (!match(TokenType.PUNCT, ',')) break;
      }
      expect(TokenType.PUNCT, ')', 'EXPECTED_RPAREN');
    }

    // Optional port list (...) — supports both ANSI and classic Verilog-1995 styles
    if (match(TokenType.PUNCT, '(')) {
      if (!check(TokenType.PUNCT, ')')) {
        const isAnsi = isDirectionKw();

        if (isAnsi) {
          let curDir = 'input';
          let curStorage = 'wire';
          let curRange = null;

          while (!check(TokenType.PUNCT, ')') && !check(TokenType.EOF)) {
            if (isDirectionKw()) {
              curDir = next().value;
              curStorage = 'wire';
              curRange = null;
            }
            if (isStorageKw()) {
              curStorage = next().value;
            }
            match(TokenType.KEYWORD, 'signed');
            if (check(TokenType.PUNCT, '[')) {
              curRange = parseRange();
            }

            const sigTok = expect(TokenType.IDENT, undefined, 'EXPECTED_PORT_NAME', 'Expected port identifier');
            const dims = _parResolveDims(curRange, ast.params);
            const sigInfo = {
              name: sigTok.value,
              dir: curDir,
              storage: curStorage,
              msb: dims.msb,
              lsb: dims.lsb,
              width: dims.width,
              rangeExpr: curRange,
              line: sigTok.line,
            };
            ast.ports.push(sigInfo);
            ast.signals[sigInfo.name] = sigInfo;
            portByName.set(sigInfo.name, sigInfo);

            if (!match(TokenType.PUNCT, ',')) break;
          }
        } else {
          // Classic non-ANSI port list: module top(a, b, y);
          while (!check(TokenType.PUNCT, ')') && !check(TokenType.EOF)) {
            const sigTok = expect(TokenType.IDENT, undefined, 'EXPECTED_PORT_NAME', 'Expected port identifier');
            const sigInfo = {
              name: sigTok.value,
              dir: null,
              storage: 'wire',
              msb: 0,
              lsb: 0,
              width: 1,
              rangeExpr: null,
              line: sigTok.line,
            };
            ast.ports.push(sigInfo);
            ast.signals[sigInfo.name] = sigInfo;
            portByName.set(sigInfo.name, sigInfo);

            if (!match(TokenType.PUNCT, ',')) break;
          }
        }
      }
      expect(TokenType.PUNCT, ')', 'EXPECTED_RPAREN');
    }

    expect(TokenType.PUNCT, ';', 'EXPECTED_SEMICOLON');

    // Module body items
    while (!check(TokenType.KEYWORD, 'endmodule') && !check(TokenType.EOF)) {
      if (check(TokenType.KEYWORD, 'parameter') || check(TokenType.KEYWORD, 'localparam')) {
        const pKind = next().value;
        if (
          check(TokenType.KEYWORD, 'logic') ||
          check(TokenType.KEYWORD, 'integer') ||
          check(TokenType.KEYWORD, 'int')
        ) {
          next();
        }
        const pRange = parseRange();
        while (!check(TokenType.PUNCT, ';') && !check(TokenType.EOF)) {
          const pTok = expect(TokenType.IDENT, undefined, 'EXPECTED_IDENT');
          expect(TokenType.OPERATOR, '=', 'EXPECTED_ASSIGN');
          const pExpr = parseExpr();
          ast.params[pTok.value] = _parEvalParamValue(pExpr, ast.params, pRange);
          ast.paramDefs.push({
            name: pTok.value,
            kind: pKind,
            rangeExpr: pRange,
            expr: pExpr,
            line: pTok.line,
          });
          if (!match(TokenType.PUNCT, ',')) break;
        }
        expect(TokenType.PUNCT, ';', 'EXPECTED_SEMICOLON');
      } else if (check(TokenType.KEYWORD, 'genvar')) {
        next();
        while (!check(TokenType.PUNCT, ';') && !check(TokenType.EOF)) {
          const gvTok = expect(TokenType.IDENT, undefined, 'EXPECTED_IDENT', 'Expected genvar identifier');
          ast.genvars.push(gvTok.value);
          if (!match(TokenType.PUNCT, ',')) break;
        }
        expect(TokenType.PUNCT, ';', 'EXPECTED_SEMICOLON');
      } else if (check(TokenType.KEYWORD, 'generate')) {
        next();
        while (!check(TokenType.KEYWORD, 'endgenerate') && !check(TokenType.EOF)) {
          parseGenerateItem(ast.generateBlocks, ast);
        }
        expect(TokenType.KEYWORD, 'endgenerate', 'EXPECTED_ENDGENERATE', "Expected 'endgenerate'");
      } else if (check(TokenType.KEYWORD, 'for')) {
        // Direct SystemVerilog generate-for inside module body (without generate/endgenerate wrapper)
        parseGenerateItem(ast.generateBlocks, ast);
      } else if (check(TokenType.KEYWORD, 'function')) {
        parseFunctionDef(ast);
      } else if (isDirectionKw() || isStorageKw()) {
        parseDeclaration(ast, portByName);
      } else if (check(TokenType.KEYWORD, 'assign')) {
        const assignTok = next();
        const target = parseLValue();
        expect(TokenType.OPERATOR, '=', 'EXPECTED_ASSIGN');
        const expr = parseExpr();
        expect(TokenType.PUNCT, ';', 'EXPECTED_SEMICOLON');
        ast.assigns.push({
          kind: 'Assign',
          target,
          expr,
          line: assignTok.line,
        });
      } else if (
        check(TokenType.KEYWORD, 'always') ||
        check(TokenType.KEYWORD, 'always_ff') ||
        check(TokenType.KEYWORD, 'always_comb')
      ) {
        ast.alwaysBlocks.push(parseAlways());
      } else if (check(TokenType.KEYWORD, 'initial')) {
        const initTok = next();
        const body = parseStatement();
        ast.initialBlocks.push({
          kind: 'Initial',
          body,
          line: initTok.line,
        });
      } else if (isPrimitiveGateKw()) {
        parseGateInstantiation(ast.gates);
      } else if (looksLikeInstantiation()) {
        parseInstantiation(ast.instances);
      } else {
        const tok = peek();
        throw syntaxErr(
          'UNEXPECTED_TOKEN',
          tok,
          `Unexpected token '${tok.value}' in module body at line ${tok.line}`,
          { token: tok.value }
        );
      }
    }

    expect(TokenType.KEYWORD, 'endmodule', 'EXPECTED_ENDMODULE', "Expected 'endmodule'");
    return ast;
  }

  function parseDeclaration(ast, portByName) {
    let dir = null;
    let storage = null;

    if (isDirectionKw()) {
      dir = next().value;
    }
    if (isStorageKw()) {
      storage = next().value;
    }
    match(TokenType.KEYWORD, 'signed');

    const isIntDecl = storage === 'integer' || storage === 'int';
    const range = parseRange();
    const dims = range
      ? _parResolveDims(range, ast.params)
      : isIntDecl
        ? { msb: 31, lsb: 0, width: 32, hasExplicitRange: false }
        : { msb: 0, lsb: 0, width: 1, hasExplicitRange: false };

    while (!check(TokenType.PUNCT, ';') && !check(TokenType.EOF)) {
      const sigTok = expect(TokenType.IDENT, undefined, 'EXPECTED_IDENT', 'Expected signal identifier');
      const sigName = sigTok.value;

      // Unpacked 2D memory array declaration: reg [7:0] mem [0:255]; or logic [15:0] rom [64];
      if (check(TokenType.PUNCT, '[')) {
        const addrRange = parseUnpackedRange();
        const addrDims = _parResolveUnpackedDims(addrRange, ast.params);
        ast.memories[sigName] = {
          name: sigName,
          storage: storage || 'reg',
          msb: dims.msb,
          lsb: dims.lsb,
          width: dims.width,
          rangeExpr: range,
          addrMsb: addrDims.addrMsb,
          addrLsb: addrDims.addrLsb,
          addrMin: addrDims.addrMin,
          addrMax: addrDims.addrMax,
          depth: addrDims.depth,
          addrRangeExpr: addrRange,
          line: sigTok.line,
        };
      } else {
        const existing = ast.signals[sigName];
        if (existing) {
          if (dir) existing.dir = dir;
          if (storage) existing.storage = isIntDecl ? 'reg' : storage;
          if (dims.hasExplicitRange) {
            existing.msb = dims.msb;
            existing.lsb = dims.lsb;
            existing.width = dims.width;
            existing.rangeExpr = range;
          }
          // Keep port entry synchronized
          const portEntry = portByName.get(sigName);
          if (portEntry && portEntry !== existing) {
            Object.assign(portEntry, existing);
          }
        } else {
          ast.signals[sigName] = {
            name: sigName,
            dir: dir || 'internal',
            storage: isIntDecl ? 'reg' : (storage || 'wire'),
            msb: dims.msb,
            lsb: dims.lsb,
            width: dims.width,
            rangeExpr: range,
            isInteger: isIntDecl,
            line: sigTok.line,
          };
        }

        // Inline wire continuous assignment (`wire w = expr;`) vs reg/integer init (`reg clk = 0;`)
        if (match(TokenType.OPERATOR, '=')) {
          const expr = parseExpr();
          if (storage === 'reg' || isIntDecl) {
            ast.initialBlocks.push({
              kind: 'Initial',
              body: {
                kind: 'ProcAssign',
                target: { kind: 'Ident', name: sigName, line: sigTok.line },
                op: '=',
                expr,
                line: sigTok.line,
              },
              line: sigTok.line,
            });
          } else {
            ast.assigns.push({
              kind: 'Assign',
              target: { kind: 'Ident', name: sigName, line: sigTok.line },
              expr,
              line: sigTok.line,
            });
          }
        }
      }

      if (!match(TokenType.PUNCT, ',')) break;
    }

    expect(TokenType.PUNCT, ';', 'EXPECTED_SEMICOLON');
  }

  function parseSensitivitySpec() {
    const sensitivity = [];
    let isStar = false;
    let hasEdge = false;

    if (match(TokenType.OPERATOR, '*')) {
      isStar = true;
      return { sensitivity, isStar, hasEdge };
    }

    expect(TokenType.PUNCT, '(', 'EXPECTED_LPAREN');
    if (match(TokenType.OPERATOR, '*')) {
      isStar = true;
    } else {
      while (!check(TokenType.PUNCT, ')') && !check(TokenType.EOF)) {
        let edge = null;
        if (check(TokenType.KEYWORD, 'posedge') || check(TokenType.KEYWORD, 'negedge')) {
          edge = next().value;
          hasEdge = true;
        }
        const sigTok = expect(TokenType.IDENT, undefined, 'EXPECTED_SENSITIVITY_SIGNAL', 'Expected signal in sensitivity list');
        let sigName = sigTok.value;
        while (check(TokenType.PUNCT, '.') && peek(1).type === TokenType.IDENT) {
          next();
          sigName += `.${next().value}`;
        }
        let index = null;
        if (match(TokenType.PUNCT, '[')) {
          index = parseExpr();
          expect(TokenType.PUNCT, ']', 'EXPECTED_RBRACKET');
        }
        sensitivity.push({
          edge,
          signal: sigName,
          index,
          line: sigTok.line,
        });
        if (!match(TokenType.KEYWORD, 'or') && !match(TokenType.PUNCT, ',')) {
          break;
        }
      }
    }
    expect(TokenType.PUNCT, ')', 'EXPECTED_RPAREN');
    return { sensitivity, isStar, hasEdge };
  }

  function stmtHasTimingControl(stmt) {
    if (!stmt) return false;
    if (stmt.kind === 'Delay' || stmt.kind === 'EventCtrl') return true;
    if (stmt.kind === 'Block') return stmt.statements.some(stmtHasTimingControl);
    if (stmt.kind === 'If') return stmtHasTimingControl(stmt.thenBranch) || stmtHasTimingControl(stmt.elseBranch);
    if (stmt.kind === 'For' || stmt.kind === 'RepeatStmt') return stmtHasTimingControl(stmt.body);
    if (stmt.kind === 'Case') {
      return stmt.items.some((it) => stmtHasTimingControl(it.stmt)) || stmtHasTimingControl(stmt.defaultBranch);
    }
    return false;
  }

  function parseAlways() {
    const kwTok = next();
    const keyword = kwTok.value;
    let mode = keyword === 'always_ff' ? 'seq' : 'comb';
    let sensitivity = [];
    let hasAt = false;

    if (match(TokenType.PUNCT, '@')) {
      hasAt = true;
      const spec = parseSensitivitySpec();
      sensitivity = spec.sensitivity;
      if (spec.isStar) {
        mode = 'comb';
      } else if (spec.hasEdge) {
        mode = 'seq';
      }
    }

    const body = parseStatement();
    if (!hasAt && keyword === 'always' && stmtHasTimingControl(body)) {
      mode = 'tb';
    }
    return {
      kind: 'Always',
      keyword,
      mode,
      sensitivity,
      body,
      line: kwTok.line,
    };
  }

  function parseStatement() {
    const tok = peek();

    if (match(TokenType.KEYWORD, 'begin')) {
      // Optional named block `begin : block_name`
      if (match(TokenType.OPERATOR, ':')) {
        expect(TokenType.IDENT, undefined, 'EXPECTED_IDENT');
      }
      const statements = [];
      while (!check(TokenType.KEYWORD, 'end') && !check(TokenType.EOF)) {
        // Optional block-local `integer i;` declaration inside begin..end
        if (check(TokenType.KEYWORD, 'integer') || check(TokenType.KEYWORD, 'int')) {
          next();
          while (!check(TokenType.PUNCT, ';') && !check(TokenType.EOF)) {
            const vTok = expect(TokenType.IDENT, undefined, 'EXPECTED_IDENT');
            if (currentModAst && !currentModAst.signals[vTok.value]) {
              currentModAst.signals[vTok.value] = {
                name: vTok.value,
                dir: 'internal',
                storage: 'reg',
                msb: 31,
                lsb: 0,
                width: 32,
                rangeExpr: null,
                isInteger: true,
                line: vTok.line,
              };
            }
            if (match(TokenType.OPERATOR, '=')) {
              const initExpr = parseExpr();
              statements.push({
                kind: 'ProcAssign',
                target: { kind: 'Ident', name: vTok.value, line: vTok.line },
                op: '=',
                expr: initExpr,
                line: vTok.line,
              });
            }
            if (!match(TokenType.PUNCT, ',')) break;
          }
          expect(TokenType.PUNCT, ';', 'EXPECTED_SEMICOLON');
          continue;
        }
        statements.push(parseStatement());
      }
      expect(TokenType.KEYWORD, 'end', 'EXPECTED_END', "Expected 'end'");
      return { kind: 'Block', statements, line: tok.line };
    }

    // Timing delay control: `#10;` or `#5 clk = ~clk;` or `#(PERIOD/2) clk = ~clk;`
    if (match(TokenType.PUNCT, '#')) {
      let delayExpr;
      if (match(TokenType.PUNCT, '(')) {
        delayExpr = parseExpr();
        expect(TokenType.PUNCT, ')', 'EXPECTED_RPAREN');
      } else {
        delayExpr = parsePrimary();
      }
      if (match(TokenType.PUNCT, ';')) {
        return { kind: 'Delay', delay: delayExpr, stmt: null, line: tok.line };
      }
      const stmt = parseStatement();
      return { kind: 'Delay', delay: delayExpr, stmt, line: tok.line };
    }

    // Procedural event control: `@(posedge clk);` or `@(negedge rst_n) stmt`
    if (match(TokenType.PUNCT, '@')) {
      const spec = parseSensitivitySpec();
      if (match(TokenType.PUNCT, ';')) {
        return { kind: 'EventCtrl', sensitivity: spec.sensitivity, stmt: null, line: tok.line };
      }
      const stmt = parseStatement();
      return { kind: 'EventCtrl', sensitivity: spec.sensitivity, stmt, line: tok.line };
    }

    // `repeat (N) stmt`
    if (match(TokenType.KEYWORD, 'repeat')) {
      expect(TokenType.PUNCT, '(', 'EXPECTED_LPAREN');
      const count = parseExpr();
      expect(TokenType.PUNCT, ')', 'EXPECTED_RPAREN');
      const body = parseStatement();
      return { kind: 'RepeatStmt', count, body, line: tok.line };
    }

    // SystemVerilog `return [expr];` (inside functions)
    if (match(TokenType.KEYWORD, 'return')) {
      let expr = null;
      if (!check(TokenType.PUNCT, ';')) {
        expr = parseExpr();
      }
      expect(TokenType.PUNCT, ';', 'EXPECTED_SEMICOLON');
      return { kind: 'Return', expr, line: tok.line };
    }

    if (match(TokenType.KEYWORD, 'if')) {
      expect(TokenType.PUNCT, '(', 'EXPECTED_LPAREN');
      const cond = parseExpr();
      expect(TokenType.PUNCT, ')', 'EXPECTED_RPAREN');
      const thenBranch = parseStatement();
      let elseBranch = null;
      if (match(TokenType.KEYWORD, 'else')) {
        elseBranch = parseStatement();
      }
      return { kind: 'If', cond, thenBranch, elseBranch, line: tok.line };
    }

    if (
      check(TokenType.KEYWORD, 'case') ||
      check(TokenType.KEYWORD, 'casex') ||
      check(TokenType.KEYWORD, 'casez')
    ) {
      const caseKind = next().value;
      expect(TokenType.PUNCT, '(', 'EXPECTED_LPAREN');
      const expr = parseExpr();
      expect(TokenType.PUNCT, ')', 'EXPECTED_RPAREN');
      const items = [];
      let defaultBranch = null;

      while (!check(TokenType.KEYWORD, 'endcase') && !check(TokenType.EOF)) {
        if (match(TokenType.KEYWORD, 'default')) {
          match(TokenType.OPERATOR, ':');
          defaultBranch = parseStatement();
        } else {
          const itemLine = peek().line;
          const patterns = [parseExpr()];
          while (match(TokenType.PUNCT, ',')) {
            patterns.push(parseExpr());
          }
          expect(TokenType.OPERATOR, ':', 'EXPECTED_COLON', "Expected ':' in case item");
          const stmt = parseStatement();
          items.push({ patterns, stmt, line: itemLine });
        }
      }
      expect(TokenType.KEYWORD, 'endcase', 'EXPECTED_ENDCASE', "Expected 'endcase'");
      return { kind: 'Case', caseKind, expr, items, defaultBranch, line: tok.line };
    }

    // Static bounded `for` loop: for ([int|integer] i = 0; i < N; i = i + 1 | i++ | i--) stmt
    if (match(TokenType.KEYWORD, 'for')) {
      const hdr = parseForHeader();
      if (hdr.isInlineInt && currentModAst && !currentModAst.signals[hdr.loopVar]) {
        currentModAst.signals[hdr.loopVar] = {
          name: hdr.loopVar,
          dir: 'internal',
          storage: 'reg',
          msb: 31,
          lsb: 0,
          width: 32,
          rangeExpr: null,
          isInteger: true,
          line: tok.line,
        };
      }
      const body = parseStatement();
      return { kind: 'For', ...hdr, body, line: tok.line };
    }

    // System task call statement (e.g., $readmemh("rom.hex", mem); $display(...); $finish; $stop;)
    if (check(TokenType.IDENT) && peek().value.startsWith('$') && (peek(1).value === '(' || peek(1).value === ';')) {
      const sysTok = next();
      const args = [];
      if (match(TokenType.PUNCT, '(')) {
        if (!check(TokenType.PUNCT, ')')) {
          args.push(parseExpr());
          while (match(TokenType.PUNCT, ',')) {
            args.push(parseExpr());
          }
        }
        expect(TokenType.PUNCT, ')', 'EXPECTED_RPAREN');
      }
      expect(TokenType.PUNCT, ';', 'EXPECTED_SEMICOLON');
      return { kind: 'SystemCall', name: sysTok.value, args, line: sysTok.line };
    }

    if (match(TokenType.PUNCT, ';')) {
      return { kind: 'Noop', line: tok.line };
    }

    // Statement-level procedural assignment: target = expr; OR target <= expr;
    // Disambiguated from relational '<=' which only appears inside parseExpr().
    const target = parseLValue();
    const opTok = peek();
    if (!check(TokenType.OPERATOR, '=') && !check(TokenType.OPERATOR, '<=')) {
      throw syntaxErr(
        'EXPECTED_ASSIGN_OP',
        opTok,
        `Expected '=' or '<=' in procedural assignment at line ${opTok.line}, got '${opTok.value}'`,
        { got: opTok.value }
      );
    }
    const op = next().value;
    const expr = parseExpr();
    expect(TokenType.PUNCT, ';', 'EXPECTED_SEMICOLON');

    return {
      kind: 'ProcAssign',
      target,
      op,
      expr,
      line: tok.line,
    };
  }

  function parseLValue() {
    const startTok = peek();

    if (match(TokenType.PUNCT, '{')) {
      const parts = [parseLValue()];
      while (match(TokenType.PUNCT, ',')) {
        parts.push(parseLValue());
      }
      expect(TokenType.PUNCT, '}', 'EXPECTED_RBRACE');
      return { kind: 'Concat', parts, line: startTok.line };
    }

    const nameTok = expect(TokenType.IDENT, undefined, 'EXPECTED_LVALUE', 'Expected target signal identifier');
    let fullName = nameTok.value;
    while (check(TokenType.PUNCT, '.') && peek(1).type === TokenType.IDENT) {
      next();
      fullName += `.${next().value}`;
    }
    if (match(TokenType.PUNCT, '[')) {
      const first = parseExpr();
      if (match(TokenType.OPERATOR, ':')) {
        const lsb = parseExpr();
        expect(TokenType.PUNCT, ']', 'EXPECTED_RBRACKET');
        return { kind: 'PartSelect', name: fullName, msb: first, lsb, line: nameTok.line };
      }
      expect(TokenType.PUNCT, ']', 'EXPECTED_RBRACKET');

      // Optional second index for 2D memory word bit/part select: mem[addr][bit] or mem[addr][hi:lo]
      if (match(TokenType.PUNCT, '[')) {
        const second = parseExpr();
        if (match(TokenType.OPERATOR, ':')) {
          const lsb = parseExpr();
          expect(TokenType.PUNCT, ']', 'EXPECTED_RBRACKET');
          return {
            kind: 'MemPartSelect',
            name: fullName,
            addr: first,
            msb: second,
            lsb,
            line: nameTok.line,
          };
        }
        expect(TokenType.PUNCT, ']', 'EXPECTED_RBRACKET');
        return {
          kind: 'MemBitSelect',
          name: fullName,
          addr: first,
          index: second,
          line: nameTok.line,
        };
      }

      return { kind: 'BitSelect', name: fullName, index: first, line: nameTok.line };
    }

    return { kind: 'Ident', name: fullName, line: nameTok.line };
  }

  // --- Expression Grammar (Standard Verilog Precedence) ---

  function parseExpr() {
    return parseTernary();
  }

  function parseTernary() {
    const cond = parseLogicalOr();
    if (match(TokenType.OPERATOR, '?')) {
      const thenExpr = parseExpr();
      expect(TokenType.OPERATOR, ':', 'EXPECTED_COLON', "Expected ':' in ternary expression");
      const elseExpr = parseTernary();
      return { kind: 'Ternary', cond, thenExpr, elseExpr, line: cond.line };
    }
    return cond;
  }

  function parseLogicalOr() {
    let left = parseLogicalAnd();
    while (match(TokenType.OPERATOR, '||')) {
      left = { kind: 'Binary', op: '||', left, right: parseLogicalAnd(), line: left.line };
    }
    return left;
  }

  function parseLogicalAnd() {
    let left = parseBitwiseOr();
    while (match(TokenType.OPERATOR, '&&')) {
      left = { kind: 'Binary', op: '&&', left, right: parseBitwiseOr(), line: left.line };
    }
    return left;
  }

  function parseBitwiseOr() {
    let left = parseBitwiseXor();
    while (match(TokenType.OPERATOR, '|')) {
      left = { kind: 'Binary', op: '|', left, right: parseBitwiseXor(), line: left.line };
    }
    return left;
  }

  function parseBitwiseXor() {
    let left = parseBitwiseAnd();
    while (
      check(TokenType.OPERATOR, '^') ||
      check(TokenType.OPERATOR, '~^') ||
      check(TokenType.OPERATOR, '^~')
    ) {
      const op = next().value;
      left = { kind: 'Binary', op, left, right: parseBitwiseAnd(), line: left.line };
    }
    return left;
  }

  function parseBitwiseAnd() {
    let left = parseEquality();
    while (match(TokenType.OPERATOR, '&')) {
      left = { kind: 'Binary', op: '&', left, right: parseEquality(), line: left.line };
    }
    return left;
  }

  function parseEquality() {
    let left = parseRelational();
    while (
      check(TokenType.OPERATOR, '==') ||
      check(TokenType.OPERATOR, '!=') ||
      check(TokenType.OPERATOR, '===') ||
      check(TokenType.OPERATOR, '!==')
    ) {
      const op = next().value;
      left = { kind: 'Binary', op, left, right: parseRelational(), line: left.line };
    }
    return left;
  }

  function parseRelational() {
    let left = parseShift();
    while (
      check(TokenType.OPERATOR, '<') ||
      check(TokenType.OPERATOR, '<=') ||
      check(TokenType.OPERATOR, '>') ||
      check(TokenType.OPERATOR, '>=')
    ) {
      const op = next().value;
      left = { kind: 'Binary', op, left, right: parseShift(), line: left.line };
    }
    return left;
  }

  function parseShift() {
    let left = parseAdditive();
    while (
      check(TokenType.OPERATOR, '<<') ||
      check(TokenType.OPERATOR, '>>') ||
      check(TokenType.OPERATOR, '<<<') ||
      check(TokenType.OPERATOR, '>>>')
    ) {
      const op = next().value;
      left = { kind: 'Binary', op, left, right: parseAdditive(), line: left.line };
    }
    return left;
  }

  function parseAdditive() {
    let left = parseMultiplicative();
    while (check(TokenType.OPERATOR, '+') || check(TokenType.OPERATOR, '-')) {
      const op = next().value;
      left = { kind: 'Binary', op, left, right: parseMultiplicative(), line: left.line };
    }
    return left;
  }

  function parseMultiplicative() {
    let left = parseUnary();
    while (
      check(TokenType.OPERATOR, '*') ||
      check(TokenType.OPERATOR, '/') ||
      check(TokenType.OPERATOR, '%')
    ) {
      const op = next().value;
      left = { kind: 'Binary', op, left, right: parseUnary(), line: left.line };
    }
    return left;
  }

  function parseUnary() {
    const tok = peek();
    if (
      check(TokenType.OPERATOR, '~') ||
      check(TokenType.OPERATOR, '!') ||
      check(TokenType.OPERATOR, '+') ||
      check(TokenType.OPERATOR, '-') ||
      check(TokenType.OPERATOR, '&') ||
      check(TokenType.OPERATOR, '|') ||
      check(TokenType.OPERATOR, '^') ||
      check(TokenType.OPERATOR, '~&') ||
      check(TokenType.OPERATOR, '~|') ||
      check(TokenType.OPERATOR, '~^') ||
      check(TokenType.OPERATOR, '^~')
    ) {
      const op = next().value;
      return { kind: 'Unary', op, operand: parseUnary(), line: tok.line };
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const tok = peek();

    if (check(TokenType.NUMBER)) {
      const numTok = next();
      const lit = parseVerilogLiteral(numTok.value, numTok.line);
      return { kind: 'Number', ...lit, line: numTok.line };
    }

    if (check(TokenType.STRING)) {
      const strTok = next();
      return { kind: 'String', value: strTok.value, line: strTok.line };
    }

    if (match(TokenType.PUNCT, '(')) {
      const expr = parseExpr();
      expect(TokenType.PUNCT, ')', 'EXPECTED_RPAREN');
      return expr;
    }

    if (match(TokenType.PUNCT, '{')) {
      const first = parseExpr();
      // Replication operator: {count{a, b}}
      if (match(TokenType.PUNCT, '{')) {
        const innerParts = [parseExpr()];
        while (match(TokenType.PUNCT, ',')) {
          innerParts.push(parseExpr());
        }
        expect(TokenType.PUNCT, '}', 'EXPECTED_RBRACE');
        expect(TokenType.PUNCT, '}', 'EXPECTED_RBRACE');
        return {
          kind: 'Repeat',
          count: first,
          expr: innerParts.length === 1 ? innerParts[0] : { kind: 'Concat', parts: innerParts, line: tok.line },
          line: tok.line,
        };
      }

      const parts = [first];
      while (match(TokenType.PUNCT, ',')) {
        parts.push(parseExpr());
      }
      expect(TokenType.PUNCT, '}', 'EXPECTED_RBRACE');
      return { kind: 'Concat', parts, line: tok.line };
    }

    if (check(TokenType.IDENT)) {
      const nameTok = next();
      // System function expression: e.g. $clog2(DEPTH) or bare $time
      if (nameTok.value.startsWith('$')) {
        const args = [];
        if (match(TokenType.PUNCT, '(')) {
          if (!check(TokenType.PUNCT, ')')) {
            args.push(parseExpr());
            while (match(TokenType.PUNCT, ',')) {
              args.push(parseExpr());
            }
          }
          expect(TokenType.PUNCT, ')', 'EXPECTED_RPAREN');
        }
        return { kind: 'SysFunc', name: nameTok.value, args, line: nameTok.line };
      }

      // User-defined combinational function call: fname(arg1, arg2, ...)
      if (match(TokenType.PUNCT, '(')) {
        const args = [];
        if (!check(TokenType.PUNCT, ')')) {
          args.push(parseExpr());
          while (match(TokenType.PUNCT, ',')) {
            args.push(parseExpr());
          }
        }
        expect(TokenType.PUNCT, ')', 'EXPECTED_RPAREN');
        return { kind: 'FuncCall', name: nameTok.value, args, line: nameTok.line };
      }

      // Optional hierarchical dotted reference: e.g. dut.count or u_rf.regs[i]
      let fullName = nameTok.value;
      while (check(TokenType.PUNCT, '.') && peek(1).type === TokenType.IDENT) {
        next();
        fullName += `.${next().value}`;
      }

      if (match(TokenType.PUNCT, '[')) {
        const idx = parseExpr();
        if (match(TokenType.OPERATOR, ':')) {
          const lsb = parseExpr();
          expect(TokenType.PUNCT, ']', 'EXPECTED_RBRACKET');
          return { kind: 'PartSelect', name: fullName, msb: idx, lsb, line: nameTok.line };
        }
        expect(TokenType.PUNCT, ']', 'EXPECTED_RBRACKET');

        // Optional second index for 2D memory word bit/part select: mem[addr][bit] or mem[addr][hi:lo]
        if (match(TokenType.PUNCT, '[')) {
          const second = parseExpr();
          if (match(TokenType.OPERATOR, ':')) {
            const lsb = parseExpr();
            expect(TokenType.PUNCT, ']', 'EXPECTED_RBRACKET');
            return {
              kind: 'MemPartSelect',
              name: fullName,
              addr: idx,
              msb: second,
              lsb,
              line: nameTok.line,
            };
          }
          expect(TokenType.PUNCT, ']', 'EXPECTED_RBRACKET');
          return {
            kind: 'MemBitSelect',
            name: fullName,
            addr: idx,
            index: second,
            line: nameTok.line,
          };
        }

        return { kind: 'BitSelect', name: fullName, index: idx, line: nameTok.line };
      }
      return { kind: 'Ident', name: fullName, line: nameTok.line };
    }

    throw syntaxErr(
      'UNEXPECTED_TOKEN',
      tok,
      `Unexpected token '${tok.value || 'EOF'}' in expression at line ${tok.line}`,
      { token: tok.value || 'EOF' }
    );
  }

  // Parse all modules in the compilation unit
  const moduleList = [];
  const modules = {};

  if (!check(TokenType.KEYWORD, 'module')) {
    parseModule(); // Throws standard EXPECTED_MODULE HdlError
  }

  while (check(TokenType.KEYWORD, 'module')) {
    const mod = parseModule();
    if (modules[mod.name]) {
      throw new HdlError({
        code: 'DUPLICATE_MODULE',
        severity: 'error',
        line: mod.line,
        message: `Duplicate module definition '${mod.name}' at line ${mod.line}`,
        params: { module: mod.name, line: mod.line },
      });
    }
    modules[mod.name] = mod;
    moduleList.push(mod);
  }

  if (!check(TokenType.EOF)) {
    const extra = peek();
    throw syntaxErr(
      'UNEXPECTED_TOKEN',
      extra,
      `Unexpected token '${extra.value}' after endmodule at line ${extra.line}`,
      { token: extra.value }
    );
  }

  // Select top-level module: explicit override -> last uninstantiated root -> last module
  let topModule = null;
  if (options && options.topModule) {
    topModule = modules[options.topModule] || null;
    if (!topModule) {
      throw new HdlError({
        code: 'UNKNOWN_MODULE',
        severity: 'error',
        line: 1,
        message: `Requested top-level module '${options.topModule}' was not found`,
        params: { module: options.topModule },
      });
    }
  } else if (moduleList.length === 1) {
    topModule = moduleList[0];
  } else {
    const instantiatedNames = new Set();
    for (const mod of moduleList) {
      for (const inst of mod.instances) {
        instantiatedNames.add(inst.moduleName);
      }
    }
    const roots = moduleList.filter((m) => !instantiatedNames.has(m.name));
    topModule = roots.length > 0 ? roots[roots.length - 1] : moduleList[moduleList.length - 1];
  }

  // Attach compilation unit registry onto topModule for seamless v1/v2 interoperability
  topModule.modules = modules;
  topModule.moduleOrder = moduleList.map((m) => m.name);

  return { topModule, modules, moduleList };
}

/**
 * Parse Verilog / SystemVerilog source text and return the top-level Module AST
 * (with `.modules` registry attached when multiple modules are defined).
 *
 * @param {string} [source='']
 * @param {{ topModule?: string }} [options={}]
 * @returns {object}
 */
export function parse(source = '', options = {}) {
  return parseProgram(source, options).topModule;
}

// ============================================================================
// Hierarchical Elaboration, Parameter Propagation & Static For-Loop Unrolling
// ============================================================================

function _parMakeConstNumberNode(val, width = 32, sized = false, line = 1) {
  const mask = (1n << BigInt(Math.max(1, width))) - 1n;
  const bigVal = typeof val === 'bigint' ? val : BigInt(Math.trunc(val));
  return {
    kind: 'Number',
    width: Math.max(1, width),
    val: bigVal & mask,
    xMask: 0n,
    zMask: 0n,
    sized,
    raw: String(bigVal),
    line,
  };
}

function _parIsValidLValueKind(node) {
  if (!node) return false;
  switch (node.kind) {
    case 'Ident':
    case 'BitSelect':
    case 'PartSelect':
    case 'MemSelect':
    case 'MemBitSelect':
    case 'MemPartSelect':
      return true;
    case 'Concat':
      return node.parts.every(_parIsValidLValueKind);
    default:
      return false;
  }
}

/**
 * Elaborate a parsed Module AST (or Verilog/SV source string) into a flat,
 * parameter-resolved, loop-unrolled design with hierarchical attribution.
 *
 * @param {string|object} astOrSource
 * @param {{ topModule?: string }} [options={}]
 * @returns {object}
 */
export function elaborate(astOrSource, options = {}) {
  if (astOrSource && typeof astOrSource === 'object' && astOrSource.isElaborated) {
    return astOrSource;
  }

  const rootAst = typeof astOrSource === 'string'
    ? parse(astOrSource, options)
    : astOrSource;

  if (!rootAst || rootAst.kind !== 'Module') {
    throw new HdlError({
      code: 'INVALID_AST',
      severity: 'error',
      line: 1,
      message: 'Expected a parsed Module AST for elaboration',
    });
  }

  const moduleMap = rootAst.modules || { [rootAst.name]: rootAst };

  const out = {
    kind: 'Module',
    isElaborated: true,
    name: rootAst.name,
    line: rootAst.line,
    ports: [],
    signals: {},
    memories: {},
    params: {},
    assigns: [],
    gates: [],
    functions: {},
    alwaysBlocks: [],
    initialBlocks: [],
    instances: rootAst.instances ? [...rootAst.instances] : [],
    modules: moduleMap,
    hierarchy: null,
  };

  function resolveModuleParams(modAst, overrideValues) {
    const resolved = {};
    const paramDefs = modAst.paramDefs || [];
    const formalParamNames = paramDefs
      .filter((d) => d.kind === 'parameter')
      .map((d) => d.name);

    const overrideByName = {};
    let posIdx = 0;
    for (const ov of overrideValues) {
      if (ov.name !== null) {
        if (paramDefs.length > 0 && !formalParamNames.includes(ov.name)) {
          throw new HdlError({
            code: 'UNKNOWN_PARAM',
            severity: 'error',
            line: ov.line ?? modAst.line,
            message: `Unknown parameter '${ov.name}' on module '${modAst.name}' at line ${ov.line ?? modAst.line}`,
            params: { param: ov.name, module: modAst.name, line: ov.line ?? modAst.line },
          });
        }
        overrideByName[ov.name] = ov.value;
      } else if (posIdx < formalParamNames.length) {
        overrideByName[formalParamNames[posIdx]] = ov.value;
        posIdx++;
      } else {
        throw new HdlError({
          code: 'PARAM_COUNT_MISMATCH',
          severity: 'error',
          line: ov.line ?? modAst.line,
          message: `Too many positional parameter overrides for module '${modAst.name}' at line ${ov.line ?? modAst.line}`,
          params: { module: modAst.name, line: ov.line ?? modAst.line },
        });
      }
    }

    if (paramDefs.length > 0) {
      for (const def of paramDefs) {
        if (def.kind === 'parameter' && def.name in overrideByName) {
          const ovVal = overrideByName[def.name];
          const dims = def.rangeExpr ? _parResolveDims(def.rangeExpr, resolved) : null;
          const width = dims ? dims.width : ovVal.width;
          const mask = (1n << BigInt(width)) - 1n;
          resolved[def.name] = {
            width,
            val: ovVal.val & mask,
            xMask: ovVal.xMask & mask,
            zMask: ovVal.zMask & mask,
            sized: Boolean(dims || ovVal.sized),
          };
        } else {
          resolved[def.name] = _parEvalParamValue(def.expr, resolved, def.rangeExpr);
        }
      }
    } else if (modAst.params) {
      // Fallback for manually constructed synthetic ASTs without paramDefs
      for (const [k, v] of Object.entries(modAst.params)) {
        resolved[k] = k in overrideByName ? { ...overrideByName[k] } : { ...v };
      }
    }

    return resolved;
  }

  function elaborateInstance(modAst, prefix, overrideValues, callStack, depth) {
    if (callStack.has(modAst.name)) {
      const chain = [...callStack, modAst.name].join(' -> ');
      throw new HdlError({
        code: 'RECURSIVE_INSTANTIATION',
        severity: 'error',
        line: modAst.line,
        message: `Recursive module instantiation detected: ${chain}`,
        params: { module: modAst.name, chain },
      });
    }
    if (depth > MAX_HIERARCHY_DEPTH) {
      throw new HdlError({
        code: 'HIERARCHY_DEPTH_EXCEEDED',
        severity: 'error',
        line: modAst.line,
        message: `Module instantiation depth exceeded limit (${MAX_HIERARCHY_DEPTH}) at '${modAst.name}'`,
        params: { module: modAst.name, maxDepth: MAX_HIERARCHY_DEPTH },
      });
    }

    const nextStack = new Set(callStack);
    nextStack.add(modAst.name);

    const isTop = prefix === '';
    const qName = (localName) => (isTop ? localName : `${prefix}.${localName}`);
    const resolvedParams = resolveModuleParams(modAst, overrideValues);

    if (isTop) {
      out.params = { ...resolvedParams };
    }

    const localMemories = { ...(modAst.memories || {}) };
    const localFunctions = modAst.functions || {};
    const hierNode = {
      moduleName: modAst.name,
      instancePath: isTop ? modAst.name : prefix,
      instanceName: isTop ? modAst.name : prefix.split('.').pop(),
      prefix,
      params: { ...resolvedParams },
      signals: {},
      memories: {},
      assigns: [],
      gates: [],
      functions: {},
      alwaysBlocks: [],
      children: [],
    };

    // 1. Resolve & register ports and signals
    const portNames = new Set((modAst.ports || []).map((p) => p.name));
    const resolvedPortList = [];

    for (const sig of Object.values(modAst.signals || {})) {
      const dims = sig.rangeExpr
        ? _parResolveDims(sig.rangeExpr, resolvedParams)
        : { msb: sig.msb, lsb: sig.lsb, width: sig.width };
      const fullName = qName(sig.name);
      const flatSig = {
        name: fullName,
        localName: sig.name,
        instancePath: prefix,
        dir: isTop ? sig.dir : 'internal',
        portDir: portNames.has(sig.name) ? sig.dir : null,
        storage: sig.storage,
        msb: dims.msb,
        lsb: dims.lsb,
        width: dims.width,
        isInteger: Boolean(sig.isInteger),
        line: sig.line,
      };
      out.signals[fullName] = flatSig;
      hierNode.signals[fullName] = flatSig;
    }

    for (const p of modAst.ports || []) {
      const fullSig = out.signals[qName(p.name)];
      if (fullSig) {
        resolvedPortList.push({
          ...fullSig,
          name: isTop ? p.name : fullSig.name,
          localName: p.name,
          dir: p.dir,
        });
      }
    }
    if (isTop) {
      out.ports = resolvedPortList;
    }

    // 2. Resolve & register unpacked 2D memories
    for (const mem of Object.values(localMemories)) {
      const wordDims = mem.rangeExpr
        ? _parResolveDims(mem.rangeExpr, resolvedParams)
        : { msb: mem.msb, lsb: mem.lsb, width: mem.width };
      const addrDims = mem.addrRangeExpr
        ? _parResolveUnpackedDims(mem.addrRangeExpr, resolvedParams)
        : {
          addrMsb: mem.addrMsb,
          addrLsb: mem.addrLsb,
          addrMin: mem.addrMin,
          addrMax: mem.addrMax,
          depth: mem.depth,
        };
      const fullName = qName(mem.name);
      const flatMem = {
        name: fullName,
        localName: mem.name,
        instancePath: prefix,
        storage: mem.storage,
        msb: wordDims.msb,
        lsb: wordDims.lsb,
        width: wordDims.width,
        addrMsb: addrDims.addrMsb,
        addrLsb: addrDims.addrLsb,
        addrMin: addrDims.addrMin,
        addrMax: addrDims.addrMax,
        depth: addrDims.depth,
        line: mem.line,
      };
      out.memories[fullName] = flatMem;
      hierNode.memories[fullName] = flatMem;
    }

    // Helper: rewrite expressions & statements into flat namespace, substituting params & loop vars
    function resolveSignalRef(rawName, localScope, genRenames) {
      if (localScope && localScope.has(rawName)) return rawName;
      if (genRenames && rawName in genRenames) return genRenames[rawName];
      return qName(rawName);
    }

    function isKnownConstExpr(node) {
      if (!node) return false;
      if (node.kind === 'Number') return node.xMask === 0n && node.zMask === 0n;
      if (node.kind === 'Unary') return isKnownConstExpr(node.operand);
      if (node.kind === 'Binary') return isKnownConstExpr(node.left) && isKnownConstExpr(node.right);
      if (node.kind === 'Ternary') {
        return isKnownConstExpr(node.cond) && isKnownConstExpr(node.thenExpr) && isKnownConstExpr(node.elseExpr);
      }
      return false;
    }

    function rewriteExpr(node, loopScope, localScope = null, genRenames = null, extraParams = null) {
      if (!node) return null;
      const paramEnv = extraParams ? { ...resolvedParams, ...extraParams } : resolvedParams;
      switch (node.kind) {
        case 'Number':
        case 'String':
          return { ...node };

        case 'SysFunc': {
          if (node.name === '$clog2') {
            const val = evalConstExprAst(node, { ...paramEnv, ...loopScope });
            return _parMakeConstNumberNode(val, 32, false, node.line);
          }
          return {
            kind: 'SysFunc',
            name: node.name,
            args: (node.args || []).map((a) => rewriteExpr(a, loopScope, localScope, genRenames, extraParams)),
            line: node.line,
          };
        }

        case 'FuncCall': {
          const fnFullName = node.name in localFunctions ? qName(node.name) : node.name;
          return {
            kind: 'FuncCall',
            name: fnFullName,
            localName: node.name,
            args: (node.args || []).map((a) => rewriteExpr(a, loopScope, localScope, genRenames, extraParams)),
            line: node.line,
          };
        }

        case 'Ident': {
          if (node.name in loopScope) {
            return _parMakeConstNumberNode(loopScope[node.name], 32, false, node.line);
          }
          if (localScope && localScope.has(node.name)) {
            return { kind: 'Ident', name: node.name, isLocal: true, line: node.line };
          }
          if (node.name in paramEnv) {
            const p = paramEnv[node.name];
            return {
              kind: 'Number',
              width: p.width,
              val: p.val,
              xMask: p.xMask,
              zMask: p.zMask,
              sized: Boolean(p.sized),
              raw: String(p.val),
              line: node.line,
            };
          }
          return { kind: 'Ident', name: resolveSignalRef(node.name, localScope, genRenames), line: node.line };
        }

        case 'BitSelect': {
          const idx = rewriteExpr(node.index, loopScope, localScope, genRenames, extraParams);
          if (node.name in loopScope && isKnownConstExpr(idx)) {
            const bitPos = evalConstExprAst(idx, {});
            const bitVal = (BigInt(loopScope[node.name]) >> BigInt(Math.max(0, bitPos))) & 1n;
            return _parMakeConstNumberNode(bitVal, 1, true, node.line);
          }
          if (localScope && localScope.has(node.name)) {
            return { kind: 'BitSelect', name: node.name, isLocal: true, index: idx, line: node.line };
          }
          const resolvedName = resolveSignalRef(node.name, localScope, genRenames);
          if (node.name in localMemories || resolvedName in out.memories) {
            return { kind: 'MemSelect', name: resolvedName, addr: idx, line: node.line };
          }
          return { kind: 'BitSelect', name: resolvedName, index: idx, line: node.line };
        }

        case 'PartSelect': {
          const msb = rewriteExpr(node.msb, loopScope, localScope, genRenames, extraParams);
          const lsb = rewriteExpr(node.lsb, loopScope, localScope, genRenames, extraParams);
          if (node.name in loopScope && isKnownConstExpr(msb) && isKnownConstExpr(lsb)) {
            const m = evalConstExprAst(msb, {});
            const l = evalConstExprAst(lsb, {});
            const lo = Math.min(m, l);
            const w = Math.abs(m - l) + 1;
            const mask = (1n << BigInt(w)) - 1n;
            const sliceVal = (BigInt(loopScope[node.name]) >> BigInt(Math.max(0, lo))) & mask;
            return _parMakeConstNumberNode(sliceVal, w, true, node.line);
          }
          return {
            kind: 'PartSelect',
            name: resolveSignalRef(node.name, localScope, genRenames),
            isLocal: Boolean(localScope && localScope.has(node.name)),
            msb,
            lsb,
            line: node.line,
          };
        }

        case 'MemSelect':
          return {
            kind: 'MemSelect',
            name: resolveSignalRef(node.name, localScope, genRenames),
            addr: rewriteExpr(node.addr, loopScope, localScope, genRenames, extraParams),
            line: node.line,
          };

        case 'MemBitSelect':
          return {
            kind: 'MemBitSelect',
            name: resolveSignalRef(node.name, localScope, genRenames),
            addr: rewriteExpr(node.addr, loopScope, localScope, genRenames, extraParams),
            index: rewriteExpr(node.index, loopScope, localScope, genRenames, extraParams),
            line: node.line,
          };

        case 'MemPartSelect':
          return {
            kind: 'MemPartSelect',
            name: resolveSignalRef(node.name, localScope, genRenames),
            addr: rewriteExpr(node.addr, loopScope, localScope, genRenames, extraParams),
            msb: rewriteExpr(node.msb, loopScope, localScope, genRenames, extraParams),
            lsb: rewriteExpr(node.lsb, loopScope, localScope, genRenames, extraParams),
            line: node.line,
          };

        case 'Concat':
          return {
            kind: 'Concat',
            parts: node.parts.map((p) => rewriteExpr(p, loopScope, localScope, genRenames, extraParams)),
            line: node.line,
          };

        case 'Repeat':
          return {
            kind: 'Repeat',
            count: rewriteExpr(node.count, loopScope, localScope, genRenames, extraParams),
            expr: rewriteExpr(node.expr, loopScope, localScope, genRenames, extraParams),
            line: node.line,
          };

        case 'Unary':
          return {
            kind: 'Unary',
            op: node.op,
            operand: rewriteExpr(node.operand, loopScope, localScope, genRenames, extraParams),
            line: node.line,
          };

        case 'Binary':
          return {
            kind: 'Binary',
            op: node.op,
            left: rewriteExpr(node.left, loopScope, localScope, genRenames, extraParams),
            right: rewriteExpr(node.right, loopScope, localScope, genRenames, extraParams),
            line: node.line,
          };

        case 'Ternary':
          return {
            kind: 'Ternary',
            cond: rewriteExpr(node.cond, loopScope, localScope, genRenames, extraParams),
            thenExpr: rewriteExpr(node.thenExpr, loopScope, localScope, genRenames, extraParams),
            elseExpr: rewriteExpr(node.elseExpr, loopScope, localScope, genRenames, extraParams),
            line: node.line,
          };

        default:
          return { ...node };
      }
    }

    function rewriteSensitivityList(sensList, loopScope, genRenames, extraParams) {
      return (sensList || []).map((s) => {
        let idxNode = s.index ? rewriteExpr(s.index, loopScope, null, genRenames, extraParams) : null;
        if (idxNode && idxNode.kind !== 'Number' && isKnownConstExpr(idxNode)) {
          idxNode = _parMakeConstNumberNode(evalConstExprAst(idxNode, {}), 32, false, idxNode.line);
        }
        return {
          edge: s.edge,
          signal: resolveSignalRef(s.signal, null, genRenames),
          index: idxNode,
          line: s.line,
        };
      });
    }

    function rewriteStmt(stmt, loopScope, localScope = null, genRenames = null, extraParams = null, keepRuntimeFor = false) {
      if (!stmt || stmt.kind === 'Noop') return { kind: 'Noop', line: stmt?.line ?? 1 };
      const paramEnv = extraParams ? { ...resolvedParams, ...extraParams } : resolvedParams;

      switch (stmt.kind) {
        case 'Block':
          return {
            kind: 'Block',
            statements: stmt.statements.map((s) => rewriteStmt(s, loopScope, localScope, genRenames, extraParams, keepRuntimeFor)),
            line: stmt.line,
          };

        case 'ProcAssign':
          return {
            kind: 'ProcAssign',
            target: rewriteExpr(stmt.target, loopScope, localScope, genRenames, extraParams),
            op: stmt.op,
            expr: rewriteExpr(stmt.expr, loopScope, localScope, genRenames, extraParams),
            line: stmt.line,
          };

        case 'If':
          return {
            kind: 'If',
            cond: rewriteExpr(stmt.cond, loopScope, localScope, genRenames, extraParams),
            thenBranch: rewriteStmt(stmt.thenBranch, loopScope, localScope, genRenames, extraParams, keepRuntimeFor),
            elseBranch: stmt.elseBranch
              ? rewriteStmt(stmt.elseBranch, loopScope, localScope, genRenames, extraParams, keepRuntimeFor)
              : null,
            line: stmt.line,
          };

        case 'Case':
          return {
            kind: 'Case',
            caseKind: stmt.caseKind || 'case',
            expr: rewriteExpr(stmt.expr, loopScope, localScope, genRenames, extraParams),
            items: stmt.items.map((it) => ({
              patterns: it.patterns.map((p) => rewriteExpr(p, loopScope, localScope, genRenames, extraParams)),
              stmt: rewriteStmt(it.stmt, loopScope, localScope, genRenames, extraParams, keepRuntimeFor),
              line: it.line,
            })),
            defaultBranch: stmt.defaultBranch
              ? rewriteStmt(stmt.defaultBranch, loopScope, localScope, genRenames, extraParams, keepRuntimeFor)
              : null,
            line: stmt.line,
          };

        case 'For': {
          if (keepRuntimeFor) {
            return {
              kind: 'For',
              loopVar: resolveSignalRef(stmt.loopVar, localScope, genRenames),
              initExpr: rewriteExpr(stmt.initExpr, loopScope, localScope, genRenames, extraParams),
              condExpr: rewriteExpr(stmt.condExpr, loopScope, localScope, genRenames, extraParams),
              stepExpr: rewriteExpr(stmt.stepExpr, loopScope, localScope, genRenames, extraParams),
              body: rewriteStmt(stmt.body, loopScope, localScope, genRenames, extraParams, true),
              line: stmt.line,
            };
          }
          const constEnv = { ...paramEnv, ...loopScope };
          let curVal = evalConstExprAst(stmt.initExpr, constEnv);
          const unrolled = [];
          let iters = 0;

          while (true) {
            const iterEnv = { ...constEnv, [stmt.loopVar]: curVal };
            const condRes = evalConstExprAst(stmt.condExpr, iterEnv);
            if (condRes === 0) break;

            iters++;
            if (iters > MAX_FOR_UNROLL) {
              throw new HdlError({
                code: 'FOR_LOOP_LIMIT',
                severity: 'error',
                line: stmt.line,
                message: `Static for-loop exceeded maximum unroll limit (${MAX_FOR_UNROLL}) at line ${stmt.line}`,
                params: { maxIterations: MAX_FOR_UNROLL, line: stmt.line },
              });
            }

            const nextLoopScope = { ...loopScope, [stmt.loopVar]: curVal };
            unrolled.push(rewriteStmt(stmt.body, nextLoopScope, localScope, genRenames, extraParams, false));
            curVal = evalConstExprAst(stmt.stepExpr, iterEnv);
          }

          return { kind: 'Block', statements: unrolled, line: stmt.line };
        }

        case 'RepeatStmt':
          return {
            kind: 'RepeatStmt',
            count: rewriteExpr(stmt.count, loopScope, localScope, genRenames, extraParams),
            body: rewriteStmt(stmt.body, loopScope, localScope, genRenames, extraParams, keepRuntimeFor),
            line: stmt.line,
          };

        case 'Delay':
          return {
            kind: 'Delay',
            delay: rewriteExpr(stmt.delay, loopScope, localScope, genRenames, extraParams),
            stmt: stmt.stmt ? rewriteStmt(stmt.stmt, loopScope, localScope, genRenames, extraParams, keepRuntimeFor) : null,
            line: stmt.line,
          };

        case 'EventCtrl':
          return {
            kind: 'EventCtrl',
            sensitivity: rewriteSensitivityList(stmt.sensitivity, loopScope, genRenames, extraParams),
            stmt: stmt.stmt ? rewriteStmt(stmt.stmt, loopScope, localScope, genRenames, extraParams, keepRuntimeFor) : null,
            line: stmt.line,
          };

        case 'Return':
          return {
            kind: 'Return',
            expr: stmt.expr ? rewriteExpr(stmt.expr, loopScope, localScope, genRenames, extraParams) : null,
            line: stmt.line,
          };

        case 'SystemCall':
          return {
            kind: 'SystemCall',
            name: stmt.name,
            args: stmt.args.map((a) => rewriteExpr(a, loopScope, localScope, genRenames, extraParams)),
            line: stmt.line,
          };

        default:
          return { ...stmt };
      }
    }

    // 2b. Elaborate combinational function definitions (resolving parameter-dependent widths)
    for (const fnDef of Object.values(localFunctions)) {
      const fnParams = { ...resolvedParams };
      for (const lp of fnDef.localParams || []) {
        fnParams[lp.name] = _parEvalParamValue(lp.expr, fnParams, lp.rangeExpr);
      }
      const retDims = fnDef.returnRangeExpr
        ? _parResolveDims(fnDef.returnRangeExpr, fnParams)
        : { msb: fnDef.returnMsb, lsb: fnDef.returnLsb, width: fnDef.returnWidth };

      const localScope = new Set([fnDef.name]);
      const resolvedArgs = (fnDef.args || []).map((a) => {
        localScope.add(a.name);
        const dims = a.rangeExpr
          ? _parResolveDims(a.rangeExpr, fnParams)
          : { msb: a.msb, lsb: a.lsb, width: a.width };
        return { name: a.name, msb: dims.msb, lsb: dims.lsb, width: dims.width, line: a.line };
      });
      const resolvedLocals = (fnDef.locals || []).map((loc) => {
        localScope.add(loc.name);
        const dims = loc.rangeExpr
          ? _parResolveDims(loc.rangeExpr, fnParams)
          : { msb: loc.msb, lsb: loc.lsb, width: loc.width };
        return {
          name: loc.name,
          msb: dims.msb,
          lsb: dims.lsb,
          width: dims.width,
          isInteger: Boolean(loc.isInteger),
          line: loc.line,
        };
      });

      const fullFnName = qName(fnDef.name);
      const flatFn = {
        kind: 'FunctionDef',
        name: fullFnName,
        localName: fnDef.name,
        instancePath: prefix,
        returnMsb: retDims.msb,
        returnLsb: retDims.lsb,
        returnWidth: retDims.width,
        args: resolvedArgs,
        locals: resolvedLocals,
        body: rewriteStmt(fnDef.body, {}, localScope, null, fnParams),
        line: fnDef.line,
      };
      out.functions[fullFnName] = flatFn;
      hierNode.functions[fullFnName] = flatFn;
    }

    // Shared helpers for elaborating primitive gates & child module instances (direct & generate-for)
    let autoGateCounter = 0;
    const seenInstNames = new Set();

    function elaborateGate(gate, loopScope, genPrefix, genRenames, extraParams) {
      const localGateName = gate.instanceName || `${gate.gateType}_${autoGateCounter++}`;
      const relName = genPrefix ? `${genPrefix}.${localGateName}` : localGateName;
      const fullInstPath = isTop ? relName : `${prefix}.${relName}`;
      const flatGate = {
        kind: 'Gate',
        gateType: gate.gateType,
        instanceName: relName,
        instancePath: fullInstPath,
        parentPath: prefix,
        target: rewriteExpr(gate.target, loopScope, null, genRenames, extraParams),
        inputs: gate.inputs.map((inp) => rewriteExpr(inp, loopScope, null, genRenames, extraParams)),
        line: gate.line,
      };
      out.gates.push(flatGate);
      hierNode.gates.push(flatGate);
    }

    function elaborateChildInstance(inst, loopScope, genPrefix, genRenames, extraParams) {
      const relInstName = genPrefix ? `${genPrefix}.${inst.instanceName}` : inst.instanceName;
      if (seenInstNames.has(relInstName)) {
        throw new HdlError({
          code: 'DUPLICATE_INSTANCE',
          severity: 'error',
          line: inst.line,
          message: `Duplicate instance name '${relInstName}' in module '${modAst.name}' at line ${inst.line}`,
          params: { instance: relInstName, module: modAst.name, line: inst.line },
        });
      }
      seenInstNames.add(relInstName);

      const childMod = moduleMap[inst.moduleName];
      if (!childMod) {
        throw new HdlError({
          code: 'UNKNOWN_MODULE',
          severity: 'error',
          line: inst.line,
          message: `Undefined module '${inst.moduleName}' instantiated as '${relInstName}' at line ${inst.line}`,
          params: { module: inst.moduleName, instance: relInstName, line: inst.line },
        });
      }

      // Evaluate parameter override expressions in PARENT parameter + generate loop scope
      const paramScope = { ...resolvedParams, ...(extraParams || {}), ...loopScope };
      const evaledOverrides = (inst.paramOverrides || []).map((ov) => ({
        name: ov.name,
        value: _parEvalParamValue(ov.expr, paramScope, null),
        line: ov.line,
      }));

      const childPrefix = isTop ? relInstName : `${prefix}.${relInstName}`;
      const { hierNode: childHier, ports: childPorts } = elaborateInstance(
        childMod,
        childPrefix,
        evaledOverrides,
        nextStack,
        depth + 1
      );
      childHier.instanceName = relInstName;
      hierNode.children.push(childHier);

      // Map port connections (named or positional) to structural wiring assigns
      const childPortByLocalName = new Map(childPorts.map((p) => [p.localName, p]));
      const conns = inst.portConnections || [];
      let posPortIdx = 0;

      for (const conn of conns) {
        let formalPort = null;
        if (conn.portName !== null) {
          formalPort = childPortByLocalName.get(conn.portName) || null;
          if (!formalPort) {
            throw new HdlError({
              code: 'UNKNOWN_PORT',
              severity: 'error',
              line: conn.line,
              message: `Unknown port '.${conn.portName}' on module '${childMod.name}' at line ${conn.line}`,
              params: { port: conn.portName, module: childMod.name, line: conn.line },
            });
          }
        } else {
          if (posPortIdx >= childPorts.length) {
            throw new HdlError({
              code: 'PORT_COUNT_MISMATCH',
              severity: 'error',
              line: conn.line,
              message: `Too many positional port connections for instance '${relInstName}' (${childMod.name}) at line ${conn.line}`,
              params: { instance: relInstName, module: childMod.name, line: conn.line },
            });
          }
          formalPort = childPorts[posPortIdx++];
        }

        if (!conn.expr) continue; // Explicitly unconnected port: .port()

        const parentExpr = rewriteExpr(conn.expr, loopScope, null, genRenames, extraParams);
        const childIdent = { kind: 'Ident', name: formalPort.name, line: conn.line };

        if (formalPort.dir === 'input') {
          const wireAssign = {
            kind: 'Assign',
            target: childIdent,
            expr: parentExpr,
            line: conn.line,
            instancePath: prefix,
            isPortWiring: true,
            portWireDir: 'input',
          };
          out.assigns.push(wireAssign);
          hierNode.assigns.push(wireAssign);
        } else if (formalPort.dir === 'output') {
          if (!_parIsValidLValueKind(parentExpr)) {
            throw new HdlError({
              code: 'INVALID_PORT_TARGET',
              severity: 'error',
              line: conn.line,
              message: `Output port '.${formalPort.localName}' of '${relInstName}' must connect to a writable net/slice at line ${conn.line}`,
              params: { port: formalPort.localName, instance: relInstName, line: conn.line },
            });
          }
          const wireAssign = {
            kind: 'Assign',
            target: parentExpr,
            expr: childIdent,
            line: conn.line,
            instancePath: prefix,
            isPortWiring: true,
            portWireDir: 'output',
          };
          out.assigns.push(wireAssign);
          hierNode.assigns.push(wireAssign);
        } else {
          const wireAssign = {
            kind: 'Assign',
            target: childIdent,
            expr: parentExpr,
            line: conn.line,
            instancePath: prefix,
            isPortWiring: true,
            portWireDir: 'inout',
          };
          out.assigns.push(wireAssign);
          hierNode.assigns.push(wireAssign);
        }
      }
    }

    let autoGenBlockCounter = 0;

    function elaborateGenerateItems(items, loopScope, genPrefix, genRenames, extraParams) {
      const localRenames = { ...(genRenames || {}) };
      const localExtraParams = { ...(extraParams || {}) };

      for (const item of items || []) {
        switch (item.kind) {
          case 'GenerateFor': {
            const constEnv = { ...resolvedParams, ...localExtraParams, ...loopScope };
            let curVal = evalConstExprAst(item.initExpr, constEnv);
            const blkBase = item.blockName || `genblk${autoGenBlockCounter++}`;
            let iters = 0;

            while (true) {
              const iterEnv = { ...constEnv, [item.loopVar]: curVal };
              const condRes = evalConstExprAst(item.condExpr, iterEnv);
              if (condRes === 0) break;

              iters++;
              if (iters > MAX_FOR_UNROLL) {
                throw new HdlError({
                  code: 'FOR_LOOP_LIMIT',
                  severity: 'error',
                  line: item.line,
                  message: `Static generate for-loop exceeded maximum unroll limit (${MAX_FOR_UNROLL}) at line ${item.line}`,
                  params: { maxIterations: MAX_FOR_UNROLL, line: item.line },
                });
              }

              const iterPrefix = genPrefix ? `${genPrefix}.${blkBase}[${curVal}]` : `${blkBase}[${curVal}]`;
              const nextLoopScope = { ...loopScope, [item.loopVar]: curVal };
              elaborateGenerateItems(item.items, nextLoopScope, iterPrefix, localRenames, localExtraParams);
              curVal = evalConstExprAst(item.stepExpr, iterEnv);
            }
            break;
          }

          case 'GenerateIf': {
            const constEnv = { ...resolvedParams, ...localExtraParams, ...loopScope };
            const condRes = evalConstExprAst(item.condExpr, constEnv);
            const chosen = condRes !== 0 ? item.thenBlock : item.elseBlock;
            if (chosen) {
              const nextPrefix = chosen.blockName
                ? (genPrefix ? `${genPrefix}.${chosen.blockName}` : chosen.blockName)
                : genPrefix;
              elaborateGenerateItems(chosen.items, loopScope, nextPrefix, localRenames, localExtraParams);
            }
            break;
          }

          case 'GenParam': {
            const constEnv = { ...resolvedParams, ...localExtraParams, ...loopScope };
            for (const def of item.defs || []) {
              localExtraParams[def.name] = _parEvalParamValue(def.expr, constEnv, item.rangeExpr);
            }
            break;
          }

          case 'GenDecl': {
            const constEnv = { ...resolvedParams, ...localExtraParams, ...loopScope };
            const dims = item.rangeExpr
              ? _parResolveDims(item.rangeExpr, constEnv)
              : item.isInteger
                ? { msb: 31, lsb: 0, width: 32 }
                : { msb: 0, lsb: 0, width: 1 };
            for (const d of item.items || []) {
              const relName = genPrefix ? `${genPrefix}.${d.name}` : d.name;
              const fullName = qName(relName);
              localRenames[d.name] = fullName;
              if (d.isMemory) {
                const addrDims = _parResolveUnpackedDims(d.addrRange, constEnv);
                const flatMem = {
                  name: fullName,
                  localName: d.name,
                  instancePath: prefix,
                  storage: item.storage || 'reg',
                  msb: dims.msb,
                  lsb: dims.lsb,
                  width: dims.width,
                  addrMsb: addrDims.addrMsb,
                  addrLsb: addrDims.addrLsb,
                  addrMin: addrDims.addrMin,
                  addrMax: addrDims.addrMax,
                  depth: addrDims.depth,
                  line: d.line,
                };
                out.memories[fullName] = flatMem;
                hierNode.memories[fullName] = flatMem;
              } else {
                const flatSig = {
                  name: fullName,
                  localName: d.name,
                  instancePath: prefix,
                  dir: 'internal',
                  portDir: null,
                  storage: item.isInteger ? 'reg' : (item.storage || 'wire'),
                  msb: dims.msb,
                  lsb: dims.lsb,
                  width: dims.width,
                  isInteger: Boolean(item.isInteger),
                  line: d.line,
                };
                out.signals[fullName] = flatSig;
                hierNode.signals[fullName] = flatSig;
                if (d.initExpr) {
                  const flatAssign = {
                    kind: 'Assign',
                    target: { kind: 'Ident', name: fullName, line: d.line },
                    expr: rewriteExpr(d.initExpr, loopScope, null, localRenames, localExtraParams),
                    line: d.line,
                    instancePath: prefix,
                    isPortWiring: false,
                  };
                  out.assigns.push(flatAssign);
                  hierNode.assigns.push(flatAssign);
                }
              }
            }
            break;
          }

          case 'Assign': {
            const flatAssign = {
              kind: 'Assign',
              target: rewriteExpr(item.target, loopScope, null, localRenames, localExtraParams),
              expr: rewriteExpr(item.expr, loopScope, null, localRenames, localExtraParams),
              line: item.line,
              instancePath: prefix,
              isPortWiring: false,
            };
            out.assigns.push(flatAssign);
            hierNode.assigns.push(flatAssign);
            break;
          }

          case 'Always': {
            const flatBlk = {
              kind: 'Always',
              keyword: item.keyword,
              mode: item.mode,
              sensitivity: rewriteSensitivityList(item.sensitivity, loopScope, localRenames, localExtraParams),
              body: rewriteStmt(item.body, loopScope, null, localRenames, localExtraParams, item.mode === 'tb'),
              line: item.line,
              instancePath: prefix,
            };
            out.alwaysBlocks.push(flatBlk);
            hierNode.alwaysBlocks.push(flatBlk);
            break;
          }

          case 'Initial': {
            out.initialBlocks.push({
              kind: 'Initial',
              body: rewriteStmt(item.body, loopScope, null, localRenames, localExtraParams, true),
              line: item.line,
              instancePath: prefix,
            });
            break;
          }

          case 'Gate':
            elaborateGate(item, loopScope, genPrefix, localRenames, localExtraParams);
            break;

          case 'Instance':
            elaborateChildInstance(item, loopScope, genPrefix, localRenames, localExtraParams);
            break;
        }
      }
    }

    // 3. Rewrite continuous assignments
    for (const assign of modAst.assigns || []) {
      const flatAssign = {
        kind: 'Assign',
        target: rewriteExpr(assign.target, {}),
        expr: rewriteExpr(assign.expr, {}),
        line: assign.line,
        instancePath: prefix,
        isPortWiring: Boolean(assign.isPortWiring),
      };
      out.assigns.push(flatAssign);
      hierNode.assigns.push(flatAssign);
    }

    // 3b. Rewrite structural primitive gates
    for (const gate of modAst.gates || []) {
      elaborateGate(gate, {}, '', null, null);
    }

    // 4. Rewrite always blocks
    for (const blk of modAst.alwaysBlocks || []) {
      const flatBlk = {
        kind: 'Always',
        keyword: blk.keyword,
        mode: blk.mode,
        sensitivity: rewriteSensitivityList(blk.sensitivity, {}, null, null),
        body: rewriteStmt(blk.body, {}, null, null, null, blk.mode === 'tb'),
        line: blk.line,
        instancePath: prefix,
      };
      out.alwaysBlocks.push(flatBlk);
      hierNode.alwaysBlocks.push(flatBlk);
    }

    // 5. Rewrite initial blocks
    for (const initBlk of modAst.initialBlocks || []) {
      out.initialBlocks.push({
        kind: 'Initial',
        body: rewriteStmt(initBlk.body, {}, null, null, null, true),
        line: initBlk.line,
        instancePath: prefix,
      });
    }

    // 6. Recursively elaborate child instances & generate blocks
    for (const inst of modAst.instances || []) {
      elaborateChildInstance(inst, {}, '', null, null);
    }

    if (modAst.generateBlocks && modAst.generateBlocks.length > 0) {
      elaborateGenerateItems(modAst.generateBlocks, {}, '', null, null);
    }

    return { hierNode, ports: resolvedPortList };
  }

  const { hierNode } = elaborateInstance(rootAst, '', [], new Set(), 0);
  out.hierarchy = hierNode;
  return out;
}
