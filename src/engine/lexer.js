/**
 * Phase 2 — Verilog / SystemVerilog Lexer & Structured Diagnostics
 * Zero-dependency tokenizer with exact line/column tracking and i18n-ready errors.
 */

export const TokenType = Object.freeze({
  KEYWORD: 'KEYWORD',
  IDENT: 'IDENT',
  NUMBER: 'NUMBER',
  STRING: 'STRING',
  OPERATOR: 'OPERATOR',
  PUNCT: 'PUNCT',
  EOF: 'EOF',
});

export const PRIMITIVE_GATE_KEYWORDS = new Set([
  'and', 'or', 'not', 'nand', 'nor', 'xor', 'xnor', 'buf',
]);

export const VERILOG_KEYWORDS = new Set([
  'module', 'endmodule',
  'input', 'output', 'inout',
  'wire', 'reg', 'logic',
  'integer', 'int', 'genvar', 'signed',
  'parameter', 'localparam',
  'assign', 'always', 'always_ff', 'always_comb', 'initial',
  'posedge', 'negedge', 'or',
  'begin', 'end',
  'if', 'else',
  'case', 'casex', 'casez', 'default', 'endcase',
  'for', 'repeat',
  'function', 'endfunction', 'automatic', 'return',
  'generate', 'endgenerate',
  'and', 'not', 'nand', 'nor', 'xor', 'xnor', 'buf',
]);

/**
 * Create a standardized i18n-ready diagnostic object.
 * @param {object} opts
 * @param {string} opts.code
 * @param {'error'|'warning'|'info'} [opts.severity='error']
 * @param {number|null} [opts.line=null]
 * @param {string|null} [opts.signal=null]
 * @param {string} opts.message
 * @param {object} [opts.params={}]
 */
export function createDiagnostic({
  code,
  severity = 'error',
  line = null,
  file = null,
  signal = null,
  message = '',
  params = {},
}) {
  const diag = { code, severity, line, signal, message, params };
  if (file !== null && file !== undefined) diag.file = file;
  return diag;
}

/**
 * Structured HDL Error carrying i18n-ready diagnostic metadata.
 */
export class HdlError extends Error {
  constructor({
    code,
    severity = 'error',
    line = null,
    col = null,
    signal = null,
    message = '',
    params = {},
  }) {
    super(message);
    this.name = 'HdlError';
    this.code = code;
    this.severity = severity;
    this.line = line;
    this.col = col;
    this.signal = signal;
    this.params = params;
  }

  toDiagnostic() {
    return createDiagnostic({
      code: this.code,
      severity: this.severity,
      line: this.line,
      signal: this.signal,
      message: this.message,
      params: this.params,
    });
  }
}

const _LEX_MULTI_OPS = [
  '===', '!==', '<<<', '>>>', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||',
  '~&', '~|', '~^', '^~',
];

const _LEX_SINGLE_OPS = new Set([
  '~', '&', '|', '^', '!', '+', '-', '*', '/', '%', '<', '>', '=', '?', ':',
]);

const _LEX_PUNCT = new Set([
  '(', ')', '[', ']', '{', '}', ',', ';', '@', '#', '.',
]);

/**
 * Tokenize Verilog / SystemVerilog source text.
 * @param {string} source
 * @returns {Array<{ type: string, value: string, line: number, col: number }>}
 */
export function tokenize(source = '') {
  const text = String(source);
  const tokens = [];
  const len = text.length;
  let i = 0;
  let line = 1;
  let col = 1;

  const advance = (count = 1) => {
    for (let k = 0; k < count; k++) {
      if (text[i] === '\n') {
        line++;
        col = 1;
      } else {
        col++;
      }
      i++;
    }
  };

  while (i < len) {
    const ch = text[i];

    // Whitespace
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      advance();
      continue;
    }

    // Single-line comment // ...
    if (ch === '/' && text[i + 1] === '/') {
      advance(2);
      while (i < len && text[i] !== '\n') advance();
      continue;
    }

    // Multi-line comment /* ... */
    if (ch === '/' && text[i + 1] === '*') {
      const startLine = line;
      const startCol = col;
      advance(2);
      while (i < len && !(text[i] === '*' && text[i + 1] === '/')) {
        advance();
      }
      if (i >= len) {
        throw new HdlError({
          code: 'UNTERMINATED_COMMENT',
          severity: 'error',
          line: startLine,
          col: startCol,
          message: `Unterminated block comment starting at line ${startLine}, column ${startCol}`,
          params: { line: startLine, col: startCol },
        });
      }
      advance(2);
      continue;
    }

    const startLine = line;
    const startCol = col;

    // Double-quoted string literals (e.g. $readmemh("rom.hex", mem))
    if (ch === '"') {
      advance();
      let strVal = '';
      while (i < len && text[i] !== '"' && text[i] !== '\n') {
        if (text[i] === '\\' && i + 1 < len) {
          advance();
          const esc = text[i];
          if (esc === 'n') strVal += '\n';
          else if (esc === 't') strVal += '\t';
          else strVal += esc;
          advance();
        } else {
          strVal += text[i];
          advance();
        }
      }
      if (i >= len || text[i] !== '"') {
        throw new HdlError({
          code: 'UNTERMINATED_STRING',
          severity: 'error',
          line: startLine,
          col: startCol,
          message: `Unterminated string literal at line ${startLine}, column ${startCol}`,
          params: { line: startLine, col: startCol },
        });
      }
      advance();
      tokens.push({ type: TokenType.STRING, value: strVal, line: startLine, col: startCol });
      continue;
    }

    // Sized/unsized numeric literals (10, 4'b1010, 8'b1010_0101, 8'hFF, 7'd42, 4'bx, 4'bz, '0, 'x)
    if (/[0-9]/.test(ch) || (ch === "'" && /[sSbBhHdDoO01xXzZ]/.test(text[i + 1] || ''))) {
      let raw = '';
      if (ch !== "'") {
        while (i < len && /[0-9_]/.test(text[i])) {
          raw += text[i];
          advance();
        }
      }

      if (text[i] === "'") {
        raw += "'";
        advance();

        if (i < len && (text[i] === 's' || text[i] === 'S')) {
          raw += text[i];
          advance();
        }

        if (i < len && /[bBhHdDoO]/.test(text[i])) {
          const base = text[i].toLowerCase();
          raw += text[i];
          advance();

          const digitStart = i;
          while (i < len && /[0-9a-fA-FxXzZ_?]/.test(text[i])) {
            raw += text[i];
            advance();
          }

          if (i === digitStart) {
            throw new HdlError({
              code: 'INVALID_LITERAL',
              severity: 'error',
              line: startLine,
              col: startCol,
              message: `Malformed numeric literal '${raw}' at line ${startLine}`,
              params: { literal: raw, base, line: startLine },
            });
          }
        } else if (i < len && /[01xXzZ]/.test(text[i])) {
          raw += text[i];
          advance();
        } else {
          throw new HdlError({
            code: 'INVALID_LITERAL',
            severity: 'error',
            line: startLine,
            col: startCol,
            message: `Invalid numeric literal '${raw}' at line ${startLine}`,
            params: { literal: raw, line: startLine },
          });
        }
      }

      tokens.push({ type: TokenType.NUMBER, value: raw, line: startLine, col: startCol });
      continue;
    }

    // Identifiers and keywords
    if (/[a-zA-Z_$]/.test(ch)) {
      let ident = '';
      while (i < len && /[a-zA-Z0-9_$]/.test(text[i])) {
        ident += text[i];
        advance();
      }
      const type = VERILOG_KEYWORDS.has(ident) ? TokenType.KEYWORD : TokenType.IDENT;
      tokens.push({ type, value: ident, line: startLine, col: startCol });
      continue;
    }

    // Multi-character operators
    let matchedMulti = null;
    for (const op of _LEX_MULTI_OPS) {
      if (text.startsWith(op, i)) {
        matchedMulti = op;
        break;
      }
    }
    if (matchedMulti) {
      advance(matchedMulti.length);
      tokens.push({ type: TokenType.OPERATOR, value: matchedMulti, line: startLine, col: startCol });
      continue;
    }

    // Single-character operators
    if (_LEX_SINGLE_OPS.has(ch)) {
      advance();
      tokens.push({ type: TokenType.OPERATOR, value: ch, line: startLine, col: startCol });
      continue;
    }

    // Punctuation
    if (_LEX_PUNCT.has(ch)) {
      advance();
      tokens.push({ type: TokenType.PUNCT, value: ch, line: startLine, col: startCol });
      continue;
    }

    throw new HdlError({
      code: 'UNEXPECTED_CHAR',
      severity: 'error',
      line: startLine,
      col: startCol,
      message: `Unexpected character '${ch}' at line ${startLine}, column ${startCol}`,
      params: { char: ch, line: startLine, col: startCol },
    });
  }

  tokens.push({ type: TokenType.EOF, value: '', line, col });
  return tokens;
}
