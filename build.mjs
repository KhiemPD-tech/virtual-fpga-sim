import fs from 'node:fs';
import path from 'node:path';

const ROOT_DIR = import.meta.dirname;
const SRC_DIR = path.join(ROOT_DIR, 'src');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const OUT_FILE = path.join(DIST_DIR, 'virtual-fpga.html');

export const MAX_BUNDLE_SIZE_BYTES = 500 * 1024; // 500 KB hard constraint (SPEC Section 11.2)

/**
 * Declarative topological bundle order for single-file IIFE bundling.
 * Required entries must exist; optional file/directory entries are automatically
 * bundled in deterministic order as v2.0 / v2.5 / v3.0 modules are added.
 */
export const BUNDLE_ORDER = [
  { path: 'src/i18n.js', required: true },
  { path: 'src/boards/de2.js', required: true },
  { path: 'src/boards/basys3.js', required: true },
  { path: 'src/boards/hdlab.js', required: true },
  { path: 'src/boards/registry.js', required: true },
  { path: 'src/engine/preprocessor.js', required: true },
  { path: 'src/engine/lexer.js', required: true },
  { path: 'src/engine/parser.js', required: true },
  { path: 'src/engine/edge_bus.js', required: true },
  { path: 'src/engine/simulator.js', required: true },
  { path: 'src/engine/testbench.js', required: true },
  { path: 'src/engine/synthesizer.js', required: true },
  { path: 'src/engine/exporters.js', required: true },
  { path: 'src/peripherals/uart_terminal.js', required: true },
  { path: 'src/peripherals/pwm_servo.js', required: true },
  { path: 'src/peripherals/buzzer_audio.js', required: true },
  { path: 'src/peripherals/adc_sensor.js', required: true },
  { path: 'src/peripherals/memory_viewer.js', required: true },
  { path: 'src/peripherals/registry.js', required: true },
  { path: 'src/presets.js', required: true },
  { path: 'src/ui/editor.js', required: true },
  { path: 'src/ui/board.js', required: true },
  { path: 'src/ui/waveform.js', required: true },
  { path: 'src/ui/peripheral_dock.js', required: true },
  { path: 'src/main.js', required: true },
];

/**
 * Resolve declarative BUNDLE_ORDER entries (files & optional directories) into
 * an ordered list of POSIX-normalized relative file paths.
 *
 * @param {Array<string|{path?: string, dir?: string, required?: boolean, optional?: boolean, orderFirst?: string[], orderLast?: string[]}>} [order=BUNDLE_ORDER]
 * @param {string} [rootDir=ROOT_DIR]
 * @returns {string[]}
 */
export function resolveBundleFiles(order = BUNDLE_ORDER, rootDir = ROOT_DIR) {
  const resolved = [];
  const seen = new Set();

  const pushUnique = (relPath) => {
    const norm = relPath.replace(/\\/g, '/');
    if (!seen.has(norm)) {
      seen.add(norm);
      resolved.push(norm);
    }
  };

  for (const rawEntry of order) {
    const entry = typeof rawEntry === 'string' ? { path: rawEntry, required: true } : rawEntry;
    const isOptional = Boolean(entry.optional && !entry.required);

    if (entry.path) {
      const absPath = path.join(rootDir, entry.path);
      if (fs.existsSync(absPath)) {
        pushUnique(entry.path);
      } else if (!isOptional) {
        throw new Error(`Missing required bundle module: ${entry.path}`);
      }
      continue;
    }

    if (entry.dir) {
      const absDir = path.join(rootDir, entry.dir);
      if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
        if (!isOptional) {
          throw new Error(`Missing required bundle directory: ${entry.dir}`);
        }
        continue;
      }

      const jsFiles = fs
        .readdirSync(absDir, { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.endsWith('.js'))
        .map((d) => d.name);

      const firstList = entry.orderFirst || [];
      const lastList = entry.orderLast || [];
      const firstSet = new Set(firstList);
      const lastSet = new Set(lastList);

      const orderedNames = [
        ...firstList.filter((name) => jsFiles.includes(name)),
        ...jsFiles
          .filter((name) => !firstSet.has(name) && !lastSet.has(name))
          .sort((a, b) => a.localeCompare(b, 'en')),
        ...lastList.filter((name) => jsFiles.includes(name) && !firstSet.has(name)),
      ];

      const normDir = entry.dir.replace(/\\/g, '/').replace(/\/+$/, '');
      for (const fileName of orderedNames) {
        pushUnique(`${normDir}/${fileName}`);
      }
    }
  }

  return resolved;
}

/**
 * Backward-compatible v1 export containing the currently resolved module list.
 */
export const MODULE_ORDER = resolveBundleFiles(BUNDLE_ORDER);

// ============================================================================
// ES Module Syntax Stripping (for single-file file:// IIFE)
// ============================================================================

function isIdentChar(ch) {
  return ch !== undefined && /[a-zA-Z0-9_$]/.test(ch);
}

function skipWhitespaceAndComments(code, idx) {
  const len = code.length;
  let i = idx;
  while (i < len) {
    if (/\s/.test(code[i])) {
      i++;
    } else if (code[i] === '/' && code[i + 1] === '/') {
      i += 2;
      while (i < len && code[i] !== '\n') i++;
    } else if (code[i] === '/' && code[i + 1] === '*') {
      i += 2;
      while (i < len && !(code[i] === '*' && code[i + 1] === '/')) i++;
      i += 2;
    } else {
      break;
    }
  }
  return i;
}

function skipStringLiteral(code, idx) {
  const quote = code[idx];
  const len = code.length;
  let i = idx + 1;
  while (i < len) {
    if (code[i] === '\\') {
      i += 2;
    } else if (code[i] === quote) {
      return i + 1;
    } else {
      i++;
    }
  }
  return len;
}

function skipRegexLiteral(code, idx) {
  const len = code.length;
  let i = idx + 1; // after opening /
  let inClass = false;
  while (i < len) {
    const c = code[i];
    if (c === '\\') {
      i += 2;
    } else if (c === '[') {
      inClass = true;
      i++;
    } else if (c === ']') {
      inClass = false;
      i++;
    } else if (c === '/' && !inClass) {
      i++;
      while (i < len && /[a-z]/i.test(code[i])) i++;
      return i;
    } else if (c === '\n') {
      // Unterminated regex fallback (not actually a regex)
      return idx + 1;
    } else {
      i++;
    }
  }
  return len;
}

const _REGEX_PRECEDING_KEYWORDS = new Set([
  'return',
  'case',
  'throw',
  'else',
  'do',
  'in',
  'instanceof',
  'of',
  'typeof',
  'void',
  'delete',
  'new',
  'yield',
  'await',
  'export',
  'default',
]);

const _CTRL_PAREN_KEYWORDS = new Set(['if', 'while', 'for', 'with']);

function canRegexFollowChar(ch) {
  return (
    ch === '' ||
    ch === '(' ||
    ch === '[' ||
    ch === '{' ||
    ch === ',' ||
    ch === ';' ||
    ch === ':' ||
    ch === '=' ||
    ch === '?' ||
    ch === '!' ||
    ch === '&' ||
    ch === '|' ||
    ch === '^' ||
    ch === '~' ||
    ch === '+' ||
    ch === '-' ||
    ch === '*' ||
    ch === '/' ||
    ch === '%' ||
    ch === '<' ||
    ch === '>'
  );
}

function canRegexFollowState(lastNonWsChar, lastWord) {
  if (lastWord && _REGEX_PRECEDING_KEYWORDS.has(lastWord)) return true;
  return canRegexFollowChar(lastNonWsChar);
}

function skipTemplateLiteral(code, idx) {
  const len = code.length;
  let i = idx + 1; // after opening backtick
  while (i < len) {
    if (code[i] === '\\') {
      i += 2;
    } else if (code[i] === '`') {
      return i + 1;
    } else if (code[i] === '$' && code[i + 1] === '{') {
      i += 2;
      let exprDepth = 1;
      let exprLastChar = '{';
      let exprLastWord = '';
      while (i < len && exprDepth > 0) {
        const c = code[i];
        if (c === '/' && code[i + 1] === '/') {
          i += 2;
          while (i < len && code[i] !== '\n') i++;
        } else if (c === '/' && code[i + 1] === '*') {
          i += 2;
          while (i < len && !(code[i] === '*' && code[i + 1] === '/')) i++;
          i = Math.min(len, i + 2);
        } else if (
          c === '/' &&
          code[i + 1] !== '/' &&
          code[i + 1] !== '*' &&
          canRegexFollowState(exprLastChar, exprLastWord)
        ) {
          i = skipRegexLiteral(code, i);
          exprLastChar = '/';
          exprLastWord = '';
        } else if (c === "'" || c === '"') {
          i = skipStringLiteral(code, i);
          exprLastChar = c;
          exprLastWord = '';
        } else if (c === '`') {
          i = skipTemplateLiteral(code, i);
          exprLastChar = '`';
          exprLastWord = '';
        } else if (/[a-zA-Z_$]/.test(c)) {
          const wStart = i;
          while (i < len && isIdentChar(code[i])) i++;
          exprLastWord = code.slice(wStart, i);
          exprLastChar = code[i - 1];
        } else if (c === '{') {
          exprDepth++;
          exprLastChar = '{';
          exprLastWord = '';
          i++;
        } else if (c === '}') {
          exprDepth--;
          exprLastChar = '}';
          exprLastWord = '';
          i++;
        } else {
          if (!/\s/.test(c)) {
            exprLastChar = c;
            exprLastWord = '';
          }
          i++;
        }
      }
    } else {
      i++;
    }
  }
  return len;
}

function consumeTrailingStatementEnd(code, idx) {
  const len = code.length;
  let i = idx;
  while (i < len && (code[i] === ' ' || code[i] === '\t')) i++;
  if (code[i] === ';') {
    i++;
    while (i < len && (code[i] === ' ' || code[i] === '\t')) i++;
  }
  if (code[i] === '\r' && code[i + 1] === '\n') {
    i += 2;
  } else if (code[i] === '\n') {
    i++;
  }
  return i;
}

function matchKeywordAt(code, idx, keyword) {
  if (!code.startsWith(keyword, idx)) return false;
  if (isIdentChar(code[idx - 1])) return false;
  if (isIdentChar(code[idx + keyword.length])) return false;
  return true;
}

function consumeFromSpecifier(code, idx) {
  const len = code.length;
  let i = idx;
  while (i < len) {
    i = skipWhitespaceAndComments(code, i);
    if (matchKeywordAt(code, i, 'from')) {
      i = skipWhitespaceAndComments(code, i + 4);
      if (code[i] === "'" || code[i] === '"') {
        i = skipStringLiteral(code, i);
        return consumeTrailingStatementEnd(code, i);
      }
    }
    if (code[i] === "'" || code[i] === '"') {
      i = skipStringLiteral(code, i);
    } else if (code[i] === ';') {
      return consumeTrailingStatementEnd(code, i);
    } else {
      i++;
    }
  }
  return len;
}

/**
 * Safely strip top-level ES module `import` and `export` syntax without
 * corrupting strings, template literals, or comments.
 * @param {string} code
 * @returns {string}
 */
export function stripModuleSyntax(code) {
  const len = code.length;
  let out = '';
  let i = 0;
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let lastNonWsChar = '';
  let lastWord = '';

  while (i < len) {
    const ch = code[i];

    // Single-line comment
    if (ch === '/' && code[i + 1] === '/') {
      const start = i;
      i += 2;
      while (i < len && code[i] !== '\n') i++;
      out += code.slice(start, i);
      continue;
    }

    // Multi-line comment
    if (ch === '/' && code[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < len && !(code[i] === '*' && code[i + 1] === '/')) i++;
      i = Math.min(len, i + 2);
      out += code.slice(start, i);
      continue;
    }

    // Regex literal
    if (ch === '/' && code[i + 1] !== '/' && code[i + 1] !== '*' && canRegexFollowState(lastNonWsChar, lastWord)) {
      const end = skipRegexLiteral(code, i);
      out += code.slice(i, end);
      lastNonWsChar = '/';
      lastWord = '';
      i = end;
      continue;
    }

    // String literals
    if (ch === "'" || ch === '"') {
      const end = skipStringLiteral(code, i);
      out += code.slice(i, end);
      lastNonWsChar = ch;
      lastWord = '';
      i = end;
      continue;
    }

    // Template literals (preserving nested ${...} expressions)
    if (ch === '`') {
      const end = skipTemplateLiteral(code, i);
      out += code.slice(i, end);
      lastNonWsChar = '`';
      lastWord = '';
      i = end;
      continue;
    }

    // Top-level ES module statements
    const atTopLevel = braceDepth === 0 && parenDepth === 0 && bracketDepth === 0;
    const canStartModuleStmt = atTopLevel && lastNonWsChar !== '.';

    if (canStartModuleStmt && matchKeywordAt(code, i, 'import')) {
      const afterKw = skipWhitespaceAndComments(code, i + 6);
      // Preserve dynamic import(...) and import.meta
      if (code[afterKw] !== '(' && code[afterKw] !== '.') {
        if (code[afterKw] === "'" || code[afterKw] === '"') {
          // Side-effect import: import './foo.js';
          const afterStr = skipStringLiteral(code, afterKw);
          i = consumeTrailingStatementEnd(code, afterStr);
        } else {
          // Standard single-line or multi-line import ... from '...';
          i = consumeFromSpecifier(code, afterKw);
        }
        lastNonWsChar = ';';
        lastWord = '';
        continue;
      }
    }

    if (canStartModuleStmt && matchKeywordAt(code, i, 'export')) {
      const afterKw = skipWhitespaceAndComments(code, i + 6);

      // Standalone export { ... }; or export { ... } from '...';
      if (code[afterKw] === '{') {
        let j = afterKw + 1;
        let depth = 1;
        while (j < len && depth > 0) {
          j = skipWhitespaceAndComments(code, j);
          if (code[j] === "'" || code[j] === '"') {
            j = skipStringLiteral(code, j);
          } else if (code[j] === '{') {
            depth++;
            j++;
          } else if (code[j] === '}') {
            depth--;
            j++;
          } else {
            j++;
          }
        }
        const afterBrace = skipWhitespaceAndComments(code, j);
        if (matchKeywordAt(code, afterBrace, 'from')) {
          i = consumeFromSpecifier(code, afterBrace);
        } else {
          i = consumeTrailingStatementEnd(code, afterBrace);
        }
        lastNonWsChar = ';';
        lastWord = '';
        continue;
      }

      // Re-export: export * from '...'; or export * as ns from '...';
      if (code[afterKw] === '*') {
        i = consumeFromSpecifier(code, afterKw + 1);
        lastNonWsChar = ';';
        lastWord = '';
        continue;
      }

      // export default <decl/expr>
      if (matchKeywordAt(code, afterKw, 'default')) {
        i = skipWhitespaceAndComments(code, afterKw + 7);
        lastNonWsChar = '=';
        lastWord = '';
        continue;
      }

      // export const / let / var / function / async function / class
      if (
        matchKeywordAt(code, afterKw, 'const') ||
        matchKeywordAt(code, afterKw, 'let') ||
        matchKeywordAt(code, afterKw, 'var') ||
        matchKeywordAt(code, afterKw, 'function') ||
        matchKeywordAt(code, afterKw, 'async') ||
        matchKeywordAt(code, afterKw, 'class')
      ) {
        i = afterKw;
        lastWord = '';
        continue;
      }
    }

    // Identifiers / keywords (track lastWord for accurate regex-vs-division detection)
    if (/[a-zA-Z_$]/.test(ch)) {
      const wStart = i;
      while (i < len && isIdentChar(code[i])) i++;
      const word = code.slice(wStart, i);
      out += word;
      lastWord = lastNonWsChar === '.' ? '' : word;
      lastNonWsChar = word[word.length - 1];
      continue;
    }

    // Track nesting depth
    if (ch === '{') braceDepth++;
    else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1);
    else if (ch === '(') parenDepth++;
    else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
    else if (ch === '[') bracketDepth++;
    else if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1);

    if (!/\s/.test(ch)) {
      lastNonWsChar = ch;
      lastWord = '';
    }

    out += ch;
    i++;
  }

  return out;
}

// ============================================================================
// Automated Build Assertions (Size, Palette, Leftover import/export & Syntax)
// ============================================================================

const FORBIDDEN_COLOR_NAME_RE =
  /\b(purple|violet|rebeccapurple|blueviolet|darkviolet|mediumpurple|indigo|magenta|fuchsia|orchid|mediumorchid|darkorchid|darkmagenta|mediumvioletred|palevioletred|plum|lavender|thistle)\b/gi;

function blankPreservingNewlines(segment) {
  return segment.replace(/[^\n]/g, ' ');
}

function stripCssComments(css) {
  const len = css.length;
  let out = '';
  let i = 0;
  while (i < len) {
    const ch = css[i];
    if (ch === "'" || ch === '"') {
      const end = skipStringLiteral(css, i);
      out += css.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '/' && css[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < len && !(css[i] === '*' && css[i + 1] === '/')) i++;
      i = Math.min(len, i + 2);
      out += blankPreservingNewlines(css.slice(start, i));
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function stripHtmlComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, (m) => blankPreservingNewlines(m));
}

function stripJsComments(code) {
  const len = code.length;
  let out = '';
  let i = 0;
  let lastNonWsChar = '';
  let lastWord = '';
  while (i < len) {
    const ch = code[i];
    if (ch === '/' && code[i + 1] === '/') {
      const start = i;
      i += 2;
      while (i < len && code[i] !== '\n') i++;
      out += blankPreservingNewlines(code.slice(start, i));
      continue;
    }
    if (ch === '/' && code[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < len && !(code[i] === '*' && code[i + 1] === '/')) i++;
      i = Math.min(len, i + 2);
      out += blankPreservingNewlines(code.slice(start, i));
      continue;
    }
    if (ch === '/' && code[i + 1] !== '/' && code[i + 1] !== '*' && canRegexFollowState(lastNonWsChar, lastWord)) {
      const end = skipRegexLiteral(code, i);
      out += code.slice(i, end);
      lastNonWsChar = '/';
      lastWord = '';
      i = end;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = skipStringLiteral(code, i);
      out += code.slice(i, end);
      lastNonWsChar = ch;
      lastWord = '';
      i = end;
      continue;
    }
    if (ch === '`') {
      const end = skipTemplateLiteral(code, i);
      out += code.slice(i, end);
      lastNonWsChar = '`';
      lastWord = '';
      i = end;
      continue;
    }
    if (/[a-zA-Z_$]/.test(ch)) {
      const wStart = i;
      while (i < len && isIdentChar(code[i])) i++;
      const word = code.slice(wStart, i);
      out += word;
      lastWord = lastNonWsChar === '.' ? '' : word;
      lastNonWsChar = word[word.length - 1];
      continue;
    }
    if (!/\s/.test(ch)) {
      lastNonWsChar = ch;
      lastWord = '';
    }
    out += ch;
    i++;
  }
  return out;
}

function rgbToHsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  const l = (max + min) / 2;

  let h = 0;
  let s = 0;
  if (delta !== 0) {
    s = delta / (1 - Math.abs(2 * l - 1));
    if (max === rn) h = ((gn - bn) / delta) % 6;
    else if (max === gn) h = (bn - rn) / delta + 2;
    else h = (rn - gn) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }

  return { h, s: s * 100, l: l * 100 };
}

function isForbiddenPurpleVioletHsl(h, s, l) {
  const hue = ((h % 360) + 360) % 360;
  return hue >= 250 && hue <= 320 && s >= 15 && l >= 5 && l <= 97;
}

function lineNumberAt(text, offset) {
  let line = 1;
  for (let i = 0; i < offset; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

function inspectHexMatch(hexDigits, rawToken, stripped, index, label, violations) {
  let c = hexDigits;
  if (c.length === 3) {
    c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
  }
  if (c.length !== 6 && c.length !== 8) return;
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  const hsl = rgbToHsl(r, g, b);
  if (isForbiddenPurpleVioletHsl(hsl.h, hsl.s, hsl.l)) {
    violations.push(
      `${label}:${lineNumberAt(stripped, index)} forbidden purple/violet hex color '${rawToken}' (hsl ${Math.round(hsl.h)}deg, ${Math.round(hsl.s)}%, ${Math.round(hsl.l)}%)`
    );
  }
}

/**
 * Assert that no forbidden purple/violet named colors or hex/rgb/hsl hues appear
 * outside comments across CSS, HTML, and bundled JS sources.
 *
 * @param {Array<{ label: string, content: string, kind: 'css'|'html'|'js' }>} sources
 */
export function assertNoForbiddenColors(sources) {
  const violations = [];

  for (const src of sources) {
    let stripped = src.content;
    if (src.kind === 'css') stripped = stripCssComments(src.content);
    else if (src.kind === 'html') stripped = stripHtmlComments(src.content);
    else if (src.kind === 'js') stripped = stripJsComments(src.content);

    // 1. Named purple/violet CSS color keywords
    FORBIDDEN_COLOR_NAME_RE.lastIndex = 0;
    let m;
    while ((m = FORBIDDEN_COLOR_NAME_RE.exec(stripped)) !== null) {
      violations.push(
        `${src.label}:${lineNumberAt(stripped, m.index)} forbidden color keyword '${m[0]}'`
      );
    }

    // 2. Hex colors (#RRGGBB, #RRGGBBAA, and #RGB)
    const hexRe =
      src.kind === 'js'
        ? /#([0-9a-fA-F]{8}|[0-9a-fA-F]{6})\b/g
        : /#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;
    while ((m = hexRe.exec(stripped)) !== null) {
      inspectHexMatch(m[1], m[0], stripped, m.index, src.label, violations);
    }

    if (src.kind === 'js') {
      // Catch standalone quoted 3-digit hex colors ('#90f') and CSS/SVG color properties in JS strings
      // without falsely flagging Verilog delays or VCD timestamps like "#808\n"
      const exactShortHexRe = /(['"`])#([0-9a-fA-F]{3})\1/g;
      while ((m = exactShortHexRe.exec(stripped)) !== null) {
        inspectHexMatch(m[2], `#${m[2]}`, stripped, m.index + 1, src.label, violations);
      }
      const attrShortHexRe = /(?:color|fill|stroke|background|border|stop-color|shadow)\s*[:=]\s*['"]?#([0-9a-fA-F]{3})\b/gi;
      while ((m = attrShortHexRe.exec(stripped)) !== null) {
        inspectHexMatch(m[1], `#${m[1]}`, stripped, m.index, src.label, violations);
      }
    }

    // 3. rgb() / rgba() colors
    const rgbRe = /\brgba?\(\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})(?:\s*[,/]\s*[\d.]+%?)?\s*\)/gi;
    while ((m = rgbRe.exec(stripped)) !== null) {
      const r = Number(m[1]);
      const g = Number(m[2]);
      const b = Number(m[3]);
      if (r <= 255 && g <= 255 && b <= 255) {
        const hsl = rgbToHsl(r, g, b);
        if (isForbiddenPurpleVioletHsl(hsl.h, hsl.s, hsl.l)) {
          violations.push(
            `${src.label}:${lineNumberAt(stripped, m.index)} forbidden purple/violet color '${m[0]}' (hsl ${Math.round(hsl.h)}deg, ${Math.round(hsl.s)}%, ${Math.round(hsl.l)}%)`
          );
        }
      }
    }

    // 4. hsl() / hsla() colors
    const hslRe =
      /\bhsla?\(\s*(-?\d+(?:\.\d+)?)(?:deg)?\s*[,\s]\s*(\d+(?:\.\d+)?)%\s*[,\s]\s*(\d+(?:\.\d+)?)%(?:\s*[,/]\s*[\d.]+%?)?\s*\)/gi;
    while ((m = hslRe.exec(stripped)) !== null) {
      const h = Number(m[1]);
      const s = Number(m[2]);
      const l = Number(m[3]);
      if (isForbiddenPurpleVioletHsl(h, s, l)) {
        violations.push(
          `${src.label}:${lineNumberAt(stripped, m.index)} forbidden purple/violet color '${m[0]}'`
        );
      }
    }
  }

  if (violations.length > 0) {
    throw new Error(
      `Forbidden color assertion failed (purple/violet palette prohibition):\n  - ${violations.join('\n  - ')}`
    );
  }
}

/**
 * Assert that stripped JS code contains zero leftover ES module `import` or `export` statements.
 * Skips comments, string literals, template literals, member properties (`.import`/`.export`),
 * object keys (`import:`/`export:`), dynamic `import(...)`, and `import.meta`.
 *
 * @param {string} code
 * @param {string} [label='bundle']
 */
export function assertNoLeftoverModuleSyntax(code, label = 'bundle') {
  const len = code.length;
  let i = 0;
  let line = 1;
  let lastNonWsChar = '';
  let lastWord = '';
  const violations = [];

  while (i < len) {
    const ch = code[i];

    if (ch === '\n') {
      line++;
      i++;
      continue;
    }

    if (ch === '/' && code[i + 1] === '/') {
      i += 2;
      while (i < len && code[i] !== '\n') i++;
      continue;
    }

    if (ch === '/' && code[i + 1] === '*') {
      i += 2;
      while (i < len && !(code[i] === '*' && code[i + 1] === '/')) {
        if (code[i] === '\n') line++;
        i++;
      }
      i = Math.min(len, i + 2);
      continue;
    }

    if (ch === '/' && code[i + 1] !== '/' && code[i + 1] !== '*' && canRegexFollowState(lastNonWsChar, lastWord)) {
      const end = skipRegexLiteral(code, i);
      lastNonWsChar = '/';
      lastWord = '';
      i = end;
      continue;
    }

    if (ch === "'" || ch === '"') {
      const end = skipStringLiteral(code, i);
      for (let k = i; k < end; k++) {
        if (code[k] === '\n') line++;
      }
      lastNonWsChar = ch;
      lastWord = '';
      i = end;
      continue;
    }

    if (ch === '`') {
      const end = skipTemplateLiteral(code, i);
      for (let k = i; k < end; k++) {
        if (code[k] === '\n') line++;
      }
      lastNonWsChar = '`';
      lastWord = '';
      i = end;
      continue;
    }

    if (/[a-zA-Z_$]/.test(ch)) {
      const wStart = i;
      while (i < len && isIdentChar(code[i])) i++;
      const word = code.slice(wStart, i);

      if (lastNonWsChar !== '.' && word === 'import') {
        const nextIdx = skipWhitespaceAndComments(code, i);
        const nextCh = code[nextIdx];
        if (nextCh !== '(' && nextCh !== '.' && nextCh !== ':') {
          violations.push(`${label}:${line} leftover ES module 'import' statement`);
        }
      } else if (lastNonWsChar !== '.' && word === 'export') {
        const nextIdx = skipWhitespaceAndComments(code, i);
        const nextCh = code[nextIdx];
        if (nextCh !== '(' && nextCh !== ':') {
          violations.push(`${label}:${line} leftover ES module 'export' statement`);
        }
      }

      lastWord = lastNonWsChar === '.' ? '' : word;
      lastNonWsChar = word[word.length - 1];
      continue;
    }

    if (!/\s/.test(ch)) {
      lastNonWsChar = ch;
      lastWord = '';
    }
    i++;
  }

  if (violations.length > 0) {
    throw new Error(
      `Leftover ES module syntax assertion failed:\n  - ${violations.join('\n  - ')}`
    );
  }
}

/**
 * Validate that the assembled IIFE parses cleanly under strict JS without executing it.
 * Catches syntax errors, stray import/export tokens, and duplicate top-level declarations.
 *
 * @param {string} iifeScript
 */
export function assertValidBundleScript(iifeScript) {
  try {
    // Parse-only check (does not execute the returned function)
    new Function(iifeScript);
  } catch (err) {
    throw new Error(`Bundled IIFE syntax assertion failed: ${err.message}`);
  }
}

/**
 * Assert that the final single-file HTML bundle contains zero external network URLs
 * (allowing only the standard W3C SVG XML namespace URI).
 *
 * @param {string} outputHtml
 */
export function assertNoExternalUrls(outputHtml) {
  const urlRe = /https?:\/\/[^\s"'`<>)]+/gi;
  const violations = [];
  let m;
  while ((m = urlRe.exec(outputHtml)) !== null) {
    const url = m[0];
    if (url === 'http://www.w3.org/2000/svg') continue;
    violations.push(url);
  }
  if (violations.length > 0) {
    throw new Error(
      `External URL assertion failed (zero-dependency constraint):\n  - ${[...new Set(violations)].join('\n  - ')}`
    );
  }
}

/**
 * Assert that the final single-file HTML bundle stays under the hard byte budget.
 *
 * @param {string} outputHtml
 * @param {number} [maxBytes=MAX_BUNDLE_SIZE_BYTES]
 */
export function assertBundleSize(outputHtml, maxBytes = MAX_BUNDLE_SIZE_BYTES) {
  const byteLen = Buffer.byteLength(outputHtml, 'utf8');
  const sizeKb = (byteLen / 1024).toFixed(2);
  const maxKb = (maxBytes / 1024).toFixed(0);
  if (byteLen > maxBytes) {
    throw new Error(
      `Bundle size assertion failed: dist/virtual-fpga.html is ${sizeKb} KB (${byteLen} bytes), exceeding the ${maxKb} KB (${maxBytes} bytes) limit.`
    );
  }
  return { byteLen, sizeKb, maxKb };
}

// ============================================================================
// Safe Zero-Dependency Tokenizer-Aware Compaction (CSS / HTML / JS)
// ============================================================================

const _JS_MULTI_OPS = [
  '>>>=',
  '===', '!==', '>>>', '<<=', '>>=', '**=', '&&=', '||=', '??=', '...',
  '=>', '<=', '>=', '==', '!=', '++', '--', '<<', '>>', '**', '&&', '||', '??', '?.',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
];

const _JS_RESTRICTED_NL_KEYWORDS = new Set(['return', 'throw', 'break', 'continue', 'yield']);

const _JS_SAFE_DROP_NL_AFTER = new Set([
  ';', '{', '(', '[', ',', ':', '?', '=>', '${',
  '=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>>=', '**=', '&&=', '||=', '??=',
  '&&', '||', '??', '===', '!==', '==', '!=', '<', '<=', '>', '>=',
  '<<', '>>', '>>>', '&', '|', '^', '*', '/', '%', '**', '+', '-', '!', '~', '...', '.', '?.',
]);

const _JS_SAFE_DROP_NL_AFTER_KW = new Set(['else', 'do', 'try', 'finally']);

const _JS_SAFE_DROP_NL_BEFORE = new Set([
  '}', ')', ']', ',', ';', ':', '?', '.', '?.',
  '&&', '||', '??', '===', '!==', '==', '!=', '<', '<=', '>', '>=',
  '<<', '>>', '>>>', '&', '|', '^', '*', '%', '**',
]);

const _JS_SAFE_AFTER_CLOSE_BRACE_KW = new Set(['else', 'catch', 'finally', 'while']);

const _JS_EXPR_BRACE_PREV_KW = new Set([
  'return', 'throw', 'yield', 'await', 'case', 'in', 'of', 'typeof', 'void', 'delete',
]);

const _JS_EXPR_BRACE_PREV_PUNCT = new Set([
  '(', '[', ',', ':', '?', '=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
  '<<=', '>>=', '>>>=', '**=', '&&=', '||=', '??=', '&&', '||', '??', '${',
  '===', '!==', '==', '!=', '<', '<=', '>', '>=', '+', '-', '*', '/', '%', '**',
  '&', '|', '^', '!', '~', '...',
]);

function _isJsWordChar(ch) {
  return ch !== undefined && /[a-zA-Z0-9_$]/.test(ch);
}

function _canRegexFollowToken(prevTok) {
  if (!prevTok) return true;
  if (prevTok.type === 'word') {
    if (prevTok.isPropName) return false;
    return _REGEX_PRECEDING_KEYWORDS.has(prevTok.value);
  }
  if (prevTok.type === 'punct') {
    if (prevTok.value === ')') return Boolean(prevTok.isCtrlParenClose);
    if (prevTok.value === ']') return false;
    if (prevTok.value === '}') return Boolean(prevTok.isBlockBraceClose);
    if (prevTok.value === '++' || prevTok.value === '--') return false;
    return true;
  }
  return false;
}

function _isJsExprBrace(prevTok) {
  if (!prevTok) return false;
  if (prevTok.type === 'word') {
    return !prevTok.isPropName && _JS_EXPR_BRACE_PREV_KW.has(prevTok.value);
  }
  if (prevTok.type === 'punct') {
    return _JS_EXPR_BRACE_PREV_PUNCT.has(prevTok.value);
  }
  return false;
}

function _needsJsSpace(prevTok, currTok) {
  const pv = prevTok.value;
  const cv = currTok.value;
  const prevLast = pv[pv.length - 1];
  const currFirst = cv[0];

  if (_isJsWordChar(prevLast) && _isJsWordChar(currFirst)) return true;
  if (prevTok.type === 'number' && !pv.includes('.') && cv === '.') return true;
  if (prevLast === '+' && currFirst === '+') return true;
  if (prevLast === '-' && currFirst === '-') return true;
  if (pv === '/' && (currFirst === '/' || currFirst === '*')) return true;
  if (pv === '<' && currFirst === '!') return true;
  return false;
}

function _chooseJsSeparator(prevTok, currTok, hadNewline) {
  if (!prevTok) return '';
  if (prevTok.value === '${') return '';

  const needsSpace = _needsJsSpace(prevTok, currTok);
  if (!hadNewline) {
    return needsSpace ? ' ' : '';
  }

  // Respect ECMAScript [no LineTerminator here] restricted productions
  if (prevTok.type === 'word' && !prevTok.isPropName && _JS_RESTRICTED_NL_KEYWORDS.has(prevTok.value)) {
    if (currTok.value === '}' || currTok.value === ';' || currTok.value === ')' || currTok.value === ',') {
      return '';
    }
    return '\n';
  }
  if (currTok.value === '++' || currTok.value === '--') {
    return '\n';
  }

  // Drop newline only where syntactically guaranteed ASI-safe
  const canDrop =
    (prevTok.type === 'punct' && _JS_SAFE_DROP_NL_AFTER.has(prevTok.value)) ||
    (prevTok.type === 'punct' && prevTok.value === ')' && prevTok.isCtrlParenClose) ||
    (prevTok.type === 'word' && !prevTok.isPropName && _JS_SAFE_DROP_NL_AFTER_KW.has(prevTok.value)) ||
    (currTok.type === 'punct' && _JS_SAFE_DROP_NL_BEFORE.has(currTok.value)) ||
    (prevTok.type === 'punct' &&
      prevTok.value === '}' &&
      currTok.type === 'word' &&
      !currTok.isPropName &&
      _JS_SAFE_AFTER_CLOSE_BRACE_KW.has(currTok.value));

  if (canDrop) {
    return needsSpace ? ' ' : '';
  }
  return '\n';
}

/**
 * Tokenizer-aware CSS compaction for single-file distribution:
 * strips comments and redundant whitespace while preserving quoted strings,
 * `url(...)` tokens, `calc(...)` spacing around `+/-`, media query keywords,
 * and descendant pseudo-selectors.
 *
 * @param {string} css
 * @returns {string}
 */
export function compactCss(css) {
  const len = css.length;
  const out = [];
  let i = 0;
  let braceDepth = 0;
  let parenDepth = 0;
  let pendingSpace = false;
  let lastChar = '';

  const emitChar = (ch) => {
    if (pendingSpace) {
      const stripBefore =
        ch === '{' ||
        ch === '}' ||
        ch === ';' ||
        ch === ',' ||
        ((ch === '>' || ch === '~') && braceDepth === 0 && parenDepth === 0);
      if (!stripBefore && out.length > 0) {
        const prev = lastChar;
        const stripAfter =
          prev === '{' ||
          prev === '}' ||
          prev === ';' ||
          prev === ',' ||
          prev === ':' ||
          prev === '(' ||
          ((prev === '>' || prev === '~') && braceDepth === 0 && parenDepth === 0);
        if (!stripAfter) {
          out.push(' ');
        }
      }
      pendingSpace = false;
    }
    if (ch === '}' && out.length > 0 && out[out.length - 1] === ';') {
      out.pop();
    }
    out.push(ch);
    lastChar = ch;
  };

  while (i < len) {
    const ch = css[i];

    // Preserved string literals
    if (ch === "'" || ch === '"') {
      const end = skipStringLiteral(css, i);
      const raw = css.slice(i, end);
      if (pendingSpace && out.length > 0 && lastChar !== ':' && lastChar !== ',' && lastChar !== '(') {
        out.push(' ');
      }
      pendingSpace = false;
      out.push(raw);
      lastChar = ch;
      i = end;
      continue;
    }

    // Block comments /* ... */
    if (ch === '/' && css[i + 1] === '*') {
      i += 2;
      while (i < len && !(css[i] === '*' && css[i + 1] === '/')) i++;
      i = Math.min(len, i + 2);
      pendingSpace = true;
      continue;
    }

    // Whitespace
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '\f') {
      pendingSpace = true;
      i++;
      continue;
    }

    // Preserve url(...) contents verbatim
    if ((ch === 'u' || ch === 'U') && /^url\(/i.test(css.slice(i, i + 4))) {
      let j = i + 4;
      while (j < len && css[j] !== ')') {
        if (css[j] === "'" || css[j] === '"') {
          j = skipStringLiteral(css, j);
        } else {
          j++;
        }
      }
      if (j < len && css[j] === ')') j++;
      if (pendingSpace && out.length > 0 && lastChar !== ':' && lastChar !== ',' && lastChar !== '(') {
        out.push(' ');
      }
      pendingSpace = false;
      out.push(css.slice(i, j));
      lastChar = ')';
      i = j;
      continue;
    }

    if (ch === '{') {
      emitChar('{');
      braceDepth++;
      i++;
      continue;
    }
    if (ch === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      emitChar('}');
      i++;
      continue;
    }
    if (ch === '(') {
      emitChar('(');
      parenDepth++;
      i++;
      continue;
    }
    if (ch === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      emitChar(')');
      i++;
      continue;
    }

    emitChar(ch);
    i++;
  }

  return out.join('').trim();
}

/**
 * Tag-aware HTML compaction for the app shell:
 * strips HTML comments (except INLINE_STYLE / INLINE_SCRIPT markers),
 * collapses multi-line tag attribute whitespace and line indentation,
 * while preserving `<pre>`, `<textarea>`, `<script>`, and `<style>` blocks verbatim.
 *
 * @param {string} html
 * @returns {string}
 */
export function compactHtml(html) {
  const len = html.length;
  const out = [];
  let i = 0;

  while (i < len) {
    // HTML comments
    if (html.startsWith('<!--', i)) {
      const endIdx = html.indexOf('-->', i + 4);
      const end = endIdx === -1 ? len : endIdx + 3;
      const rawComment = html.slice(i, end);
      if (/^<!--\s*INLINE_(?:STYLE|SCRIPT)\s*-->$/.test(rawComment)) {
        out.push(rawComment);
      }
      i = end;
      continue;
    }

    // Tags
    if (html[i] === '<') {
      const tagMatch = /^<\s*([a-zA-Z0-9-]+)/.exec(html.slice(i, i + 32));
      const tagName = tagMatch ? tagMatch[1].toLowerCase() : '';

      // Preserve raw content tags verbatim
      if (tagName === 'pre' || tagName === 'textarea' || tagName === 'script' || tagName === 'style') {
        const closeRe = new RegExp(`<\\/${tagName}\\s*>`, 'i');
        const rest = html.slice(i);
        const m = closeRe.exec(rest);
        if (m) {
          const end = i + m.index + m[0].length;
          out.push(html.slice(i, end));
          i = end;
          continue;
        }
      }

      // Scan regular tag collapsing inter-attribute whitespace while keeping quotes verbatim
      let j = i + 1;
      let tagBuf = '<';
      let inWs = false;
      while (j < len && html[j] !== '>') {
        const c = html[j];
        if (c === '"' || c === "'") {
          const qEnd = skipStringLiteral(html, j);
          if (inWs && tagBuf.length > 1) tagBuf += ' ';
          inWs = false;
          tagBuf += html.slice(j, qEnd);
          j = qEnd;
        } else if (/\s/.test(c)) {
          inWs = true;
          j++;
        } else {
          if (inWs && tagBuf.length > 1 && c !== '/') tagBuf += ' ';
          inWs = false;
          tagBuf += c;
          j++;
        }
      }
      if (j < len && html[j] === '>') {
        tagBuf += '>';
        j++;
      }
      out.push(tagBuf);
      i = j;
      continue;
    }

    // Text node between tags: strip indentation & blank lines safely
    const nextTag = html.indexOf('<', i);
    const end = nextTag === -1 ? len : nextTag;
    const text = html.slice(i, end);
    if (/^\s+$/.test(text)) {
      if (text.includes('\n')) {
        // Pure formatting whitespace between elements
        const prevChunk = out[out.length - 1] || '';
        const nextSlice = html.slice(end, end + 16);
        // Keep a single newline between adjacent inline elements (e.g. <span>...</span> <span>)
        if (/^<\/?(?:span|a|strong|em|b|i|code|button|input|label)\b/i.test(nextSlice) && /<\/(?:span|a|strong|em|b|i|code|button|label)>$/i.test(prevChunk)) {
          out.push('\n');
        }
      } else {
        out.push(' ');
      }
    } else {
      out.push(text.replace(/[ \t]*\r?\n[ \t]*/g, ' ').replace(/[ \t]{2,}/g, ' '));
    }
    i = end;
  }

  return out.join('').trim();
}

/**
 * Tokenizer-aware JS compaction for single-file distribution:
 * strips `//` and `/* ... *\/` comments, redundant blank lines, indentation,
 * and safe non-semantic whitespace OUTSIDE string literals, template literals
 * (including nested `${...}` expressions), and regex literals (including those
 * after keywords like `return /.../` or control headers `if (c) /.../`),
 * while strictly preserving ASI safety and Verilog/HTML template content verbatim.
 *
 * @param {string} code
 * @returns {string}
 */
export function compactJs(code) {
  const len = code.length;
  const out = [];
  let i = 0;
  let prevTok = null;
  let hadNewline = false;
  const parenStack = [];
  const braceStack = [];

  const emitToken = (tok) => {
    const sep = _chooseJsSeparator(prevTok, tok, hadNewline);
    if (sep) out.push(sep);
    out.push(tok.value);
    prevTok = tok;
    hadNewline = false;
  };

  const scanTemplateRaw = (startIdx) => {
    let j = startIdx;
    let chunkStart = j;
    while (j < len) {
      const c = code[j];
      if (c === '\\') {
        j = Math.min(len, j + 2);
      } else if (c === '`') {
        out.push(code.slice(chunkStart, j + 1));
        prevTok = { type: 'tpl_end', value: '`' };
        hadNewline = false;
        return j + 1;
      } else if (c === '$' && code[j + 1] === '{') {
        out.push(code.slice(chunkStart, j + 2));
        braceStack.push('tpl');
        prevTok = { type: 'punct', value: '${' };
        hadNewline = false;
        return j + 2;
      } else {
        j++;
      }
    }
    out.push(code.slice(chunkStart, len));
    prevTok = { type: 'tpl_end', value: '`' };
    hadNewline = false;
    return len;
  };

  while (i < len) {
    const ch = code[i];

    // Whitespace
    if (ch === ' ' || ch === '\t' || ch === '\v' || ch === '\f' || ch === '\r' || ch === '\n') {
      if (ch === '\n' || ch === '\r') hadNewline = true;
      i++;
      continue;
    }

    // Single-line comment // ...
    if (ch === '/' && code[i + 1] === '/') {
      i += 2;
      while (i < len && code[i] !== '\n') i++;
      continue;
    }

    // Multi-line comment /* ... */
    if (ch === '/' && code[i + 1] === '*') {
      i += 2;
      while (i < len && !(code[i] === '*' && code[i + 1] === '/')) {
        if (code[i] === '\n' || code[i] === '\r') hadNewline = true;
        i++;
      }
      i = Math.min(len, i + 2);
      continue;
    }

    // String literals
    if (ch === "'" || ch === '"') {
      const end = skipStringLiteral(code, i);
      emitToken({ type: 'string', value: code.slice(i, end) });
      i = end;
      continue;
    }

    // Template literals (static text verbatim; nested ${...} expressions tokenized)
    if (ch === '`') {
      const sep = _chooseJsSeparator(prevTok, { type: 'tpl_start', value: '`' }, hadNewline);
      if (sep) out.push(sep);
      out.push('`');
      i = scanTemplateRaw(i + 1);
      continue;
    }

    // Regex literal
    if (ch === '/' && code[i + 1] !== '/' && code[i + 1] !== '*' && _canRegexFollowToken(prevTok)) {
      const end = skipRegexLiteral(code, i);
      if (end > i + 1) {
        emitToken({ type: 'regex', value: code.slice(i, end) });
        i = end;
        continue;
      }
    }

    // Numeric literals (hex, binary, octal, decimal, float, exponent, BigInt, separators)
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(code[i + 1] || ''))) {
      const start = i;
      if (ch === '0' && (code[i + 1] === 'x' || code[i + 1] === 'X')) {
        i += 2;
        while (i < len && /[0-9a-fA-F_]/.test(code[i])) i++;
        if (code[i] === 'n') i++;
      } else if (ch === '0' && (code[i + 1] === 'b' || code[i + 1] === 'B')) {
        i += 2;
        while (i < len && /[01_]/.test(code[i])) i++;
        if (code[i] === 'n') i++;
      } else if (ch === '0' && (code[i + 1] === 'o' || code[i + 1] === 'O')) {
        i += 2;
        while (i < len && /[0-7_]/.test(code[i])) i++;
        if (code[i] === 'n') i++;
      } else {
        if (ch === '.') {
          i++;
          while (i < len && /[0-9_]/.test(code[i])) i++;
        } else {
          while (i < len && /[0-9_]/.test(code[i])) i++;
          if (code[i] === '.' && code[i + 1] !== '.') {
            i++;
            while (i < len && /[0-9_]/.test(code[i])) i++;
          }
        }
        if ((code[i] === 'e' || code[i] === 'E') && /[0-9+-]/.test(code[i + 1] || '')) {
          i++;
          if (code[i] === '+' || code[i] === '-') i++;
          while (i < len && /[0-9_]/.test(code[i])) i++;
        }
        if (code[i] === 'n') i++;
      }
      emitToken({ type: 'number', value: code.slice(start, i) });
      continue;
    }

    // Identifiers, keywords, and private fields (#ident)
    if (/[a-zA-Z_$]/.test(ch) || (ch === '#' && /[a-zA-Z_$]/.test(code[i + 1] || ''))) {
      const start = i;
      i++;
      while (i < len && isIdentChar(code[i])) i++;
      const word = code.slice(start, i);
      const isPropName = Boolean(prevTok && prevTok.type === 'punct' && (prevTok.value === '.' || prevTok.value === '?.'));
      emitToken({ type: 'word', value: word, isPropName });
      continue;
    }

    // Closing brace of a template `${...}` interpolation
    if (ch === '}' && braceStack.length > 0 && braceStack[braceStack.length - 1] === 'tpl') {
      braceStack.pop();
      out.push('}');
      i = scanTemplateRaw(i + 1);
      continue;
    }

    // Multi-character & single-character operators / punctuators
    let op = ch;
    for (let k = 0; k < _JS_MULTI_OPS.length; k++) {
      const cand = _JS_MULTI_OPS[k];
      if (code.startsWith(cand, i)) {
        op = cand;
        break;
      }
    }

    const tok = { type: 'punct', value: op };
    if (op === '(') {
      const isCtrl = Boolean(
        prevTok && prevTok.type === 'word' && !prevTok.isPropName && _CTRL_PAREN_KEYWORDS.has(prevTok.value)
      );
      parenStack.push(isCtrl);
    } else if (op === ')') {
      tok.isCtrlParenClose = parenStack.length > 0 ? parenStack.pop() : false;
    } else if (op === '{') {
      braceStack.push(_isJsExprBrace(prevTok) ? 'expr' : 'block');
    } else if (op === '}') {
      const kind = braceStack.length > 0 ? braceStack.pop() : 'block';
      tok.isBlockBraceClose = kind === 'block';
    }

    emitToken(tok);
    i += op.length;
  }

  return out.join('').trim();
}

/**
 * Safe tokenizer-aware compaction of internal single-underscore (`_foo`) symbols
 * inside the self-contained IIFE bundle. Skips `__*` names, skips any symbol
 * appearing inside string/template/regex literals, and never touches public APIs.
 */
function _compactPrivateUnderscoreSymbols(code) {
  const len = code.length;
  const parts = [];
  const literalChunks = [];
  const existingWords = new Set();
  const candCounts = new Map();
  let i = 0;
  let chunkStart = 0;
  let prevTok = null;
  const parenStack = [];
  const braceStack = [];

  const flushRaw = (endIdx) => {
    if (endIdx > chunkStart) parts.push(code.slice(chunkStart, endIdx));
  };

  const scanTpl = (startIdx) => {
    let j = startIdx;
    while (j < len) {
      const c = code[j];
      if (c === '\\') {
        j = Math.min(len, j + 2);
      } else if (c === '`') {
        literalChunks.push(code.slice(startIdx, j));
        prevTok = { type: 'tpl_end', value: '`' };
        return j + 1;
      } else if (c === '$' && code[j + 1] === '{') {
        literalChunks.push(code.slice(startIdx, j));
        braceStack.push('tpl');
        prevTok = { type: 'punct', value: '${' };
        return j + 2;
      } else {
        j++;
      }
    }
    literalChunks.push(code.slice(startIdx, len));
    return len;
  };

  while (i < len) {
    const ch = code[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = skipStringLiteral(code, i);
      literalChunks.push(code.slice(i, end));
      prevTok = { type: 'string', value: '""' };
      i = end;
      continue;
    }
    if (ch === '`') {
      i = scanTpl(i + 1);
      continue;
    }
    if (ch === '/' && code[i + 1] !== '/' && code[i + 1] !== '*' && _canRegexFollowToken(prevTok)) {
      const end = skipRegexLiteral(code, i);
      if (end > i + 1) {
        literalChunks.push(code.slice(i, end));
        prevTok = { type: 'regex', value: '//' };
        i = end;
        continue;
      }
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(code[i + 1] || ''))) {
      i++;
      while (i < len && /[0-9a-fA-FxXoObBn._]/.test(code[i])) i++;
      prevTok = { type: 'number', value: '0' };
      continue;
    }
    if (/[a-zA-Z_$]/.test(ch)) {
      const start = i;
      i++;
      while (i < len && isIdentChar(code[i])) i++;
      const word = code.slice(start, i);
      existingWords.add(word);
      const isPropName = Boolean(prevTok && prevTok.type === 'punct' && (prevTok.value === '.' || prevTok.value === '?.'));
      if (/^_[a-zA-Z0-9][a-zA-Z0-9_]{4,}$/.test(word)) {
        flushRaw(start);
        parts.push({ ident: word });
        chunkStart = i;
        candCounts.set(word, (candCounts.get(word) || 0) + 1);
      }
      prevTok = { type: 'word', value: word, isPropName };
      continue;
    }
    if (ch === '}' && braceStack.length > 0 && braceStack[braceStack.length - 1] === 'tpl') {
      braceStack.pop();
      i = scanTpl(i + 1);
      continue;
    }
    let op = ch;
    for (let k = 0; k < _JS_MULTI_OPS.length; k++) {
      if (code.startsWith(_JS_MULTI_OPS[k], i)) {
        op = _JS_MULTI_OPS[k];
        break;
      }
    }
    const tok = { type: 'punct', value: op };
    if (op === '(') {
      parenStack.push(Boolean(prevTok && prevTok.type === 'word' && !prevTok.isPropName && _CTRL_PAREN_KEYWORDS.has(prevTok.value)));
    } else if (op === ')') {
      tok.isCtrlParenClose = parenStack.length > 0 ? parenStack.pop() : false;
    } else if (op === '{') {
      braceStack.push(_isJsExprBrace(prevTok) ? 'expr' : 'block');
    } else if (op === '}') {
      tok.isBlockBraceClose = (braceStack.length > 0 ? braceStack.pop() : 'block') === 'block';
    }
    prevTok = tok;
    i += op.length;
  }
  flushRaw(len);

  const allLiterals = literalChunks.join('\n');
  const candidates = [...candCounts.entries()]
    .filter(([name, count]) => count >= 2 && !allLiterals.includes(name))
    .sort((a, b) => (b[1] * (b[0].length - 3)) - (a[1] * (a[0].length - 3)));

  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let seq = 0;
  const nextShort = () => {
    while (true) {
      let n = seq++;
      let s = '';
      do {
        s = alphabet[n % alphabet.length] + s;
        n = Math.floor(n / alphabet.length) - 1;
      } while (n >= 0);
      const cand = `_${s}`;
      if (!existingWords.has(cand)) {
        existingWords.add(cand);
        return cand;
      }
    }
  };

  const renameMap = new Map();
  for (const [name] of candidates) {
    const shortName = nextShort();
    if (shortName.length < name.length) {
      renameMap.set(name, shortName);
    }
  }

  return parts.map((p) => (typeof p === 'string' ? p : (renameMap.get(p.ident) || p.ident))).join('');
}

// ============================================================================
// Single-File HTML Builder
// ============================================================================

/**
 * Bundle all modules under `src/` into a single `file://`-safe HTML artifact.
 *
 * @param {{ minify?: boolean, writeFile?: boolean }} [options={}]
 */
export function build(options = {}) {
  const minify = options.minify !== undefined ? Boolean(options.minify) : true;
  const writeFile = options.writeFile !== undefined ? Boolean(options.writeFile) : true;

  const htmlPath = path.join(SRC_DIR, 'index.html');
  const cssPath = path.join(SRC_DIR, 'styles.css');

  const htmlTemplate = fs.readFileSync(htmlPath, 'utf8');
  const cssContent = fs.readFileSync(cssPath, 'utf8').trim();
  const resolvedFiles = resolveBundleFiles(BUNDLE_ORDER, ROOT_DIR);

  const colorAuditSources = [
    { label: 'src/index.html', content: htmlTemplate, kind: 'html' },
    { label: 'src/styles.css', content: cssContent, kind: 'css' },
  ];

  const bundledModules = resolvedFiles
    .map((relPath) => {
      const absPath = path.join(ROOT_DIR, relPath);
      const raw = fs.readFileSync(absPath, 'utf8');
      const stripped = stripModuleSyntax(raw).trim();

      assertNoLeftoverModuleSyntax(stripped, relPath);
      colorAuditSources.push({ label: relPath, content: raw, kind: 'js' });

      return minify ? compactJs(stripped) : `// === ${relPath} ===\n${stripped}`;
    })
    .join('\n');

  const rawIifeScript = minify
    ? `(()=>{'use strict';${bundledModules}})();`
    : `(() => {\n'use strict';\n${bundledModules}\n})();`;
  const iifeScript = minify ? _compactPrivateUnderscoreSymbols(rawIifeScript) : rawIifeScript;

  // Run automated assertions before writing dist/virtual-fpga.html
  assertNoLeftoverModuleSyntax(iifeScript, 'dist/virtual-fpga.html (IIFE)');
  assertValidBundleScript(iifeScript);
  assertNoForbiddenColors(colorAuditSources);

  const stylePattern = /<!--\s*INLINE_STYLE\s*-->|<link\s+rel=["']stylesheet["']\s+href=["'](?:\.\/)?styles\.css["']\s*\/?>/i;
  const scriptPattern = /<!--\s*INLINE_SCRIPT\s*-->|<script\s+type=["']module["']\s+src=["'](?:\.\/)?main\.js["']\s*><\/script>/i;

  if (!stylePattern.test(htmlTemplate)) {
    throw new Error('Could not find stylesheet link or <!-- INLINE_STYLE --> marker in src/index.html');
  }
  if (!scriptPattern.test(htmlTemplate)) {
    throw new Error('Could not find module script tag or <!-- INLINE_SCRIPT --> marker in src/index.html');
  }

  const finalHtmlShell = minify ? compactHtml(htmlTemplate) : htmlTemplate;
  const finalCss = minify ? compactCss(cssContent) : cssContent;
  const outputHtml = finalHtmlShell
    .replace(stylePattern, () => (minify ? `<style>${finalCss}</style>` : `<style>\n${finalCss}\n</style>`))
    .replace(scriptPattern, () => (minify ? `<script>${iifeScript}</script>` : `<script>\n${iifeScript}\n</script>`));

  let byteLen;
  let sizeKb;
  let maxKb;
  if (minify) {
    ({ byteLen, sizeKb, maxKb } = assertBundleSize(outputHtml, MAX_BUNDLE_SIZE_BYTES));
  } else {
    byteLen = Buffer.byteLength(outputHtml, 'utf8');
    sizeKb = (byteLen / 1024).toFixed(2);
    maxKb = (MAX_BUNDLE_SIZE_BYTES / 1024).toFixed(0);
  }
  assertNoExternalUrls(outputHtml);

  if (writeFile) {
    fs.mkdirSync(DIST_DIR, { recursive: true });
    fs.writeFileSync(OUT_FILE, outputHtml, 'utf8');
  }

  const modeLabel = minify ? 'minified' : 'unminified (--no-minify)';
  const sizeCheckLabel = minify ? 'size OK' : 'size check skipped (--no-minify)';
  console.log(
    `Bundled ${resolvedFiles.length} modules -> ${path.relative(ROOT_DIR, OUT_FILE)} (${sizeKb} KB / ${maxKb} KB, ${modeLabel}) [checks: ${sizeCheckLabel}, palette OK, zero-external-urls OK, module-syntax OK, syntax OK]`
  );

  return { outFile: OUT_FILE, byteLen, sizeKb, minify, modules: resolvedFiles };
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isCli) {
  const cliArgs = process.argv.slice(2);
  const noMinify = cliArgs.includes('--no-minify');
  build({ minify: !noMinify });
}
