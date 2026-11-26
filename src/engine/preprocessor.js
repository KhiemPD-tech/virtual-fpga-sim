/**
 * Phase D (v3.1) — Lightweight Verilog / SystemVerilog Preprocessor & Multi-File Source Map
 * Zero-dependency workspace preprocessor supporting:
 * - Graceful skipping of `timescale, `default_nettype, `celldefine, `endcelldefine
 * - Single-line `define NAME VALUE macros, `undef, and `ifdef/`ifndef/`else/`endif guards
 * - Multi-file `include "file.vh" resolution across loaded workspace tabs
 * - 1-based line sourceMap (mergedLine -> { fileName, originalLine })
 * - Upload validation & BOM/CRLF sanitization
 */

export const MAX_HDL_FILE_BYTES = 512 * 1024; // 512 KB per uploaded file
export const SUPPORTED_HDL_EXTENSIONS = Object.freeze(['.v', '.sv', '.vh', '.svh']);
export const UNSUPPORTED_VHDL_EXTENSIONS = Object.freeze(['.vhd', '.vhdl']);

const _PP_SKIP_DIRECTIVES = new Set([
  'timescale',
  'default_nettype',
  'celldefine',
  'endcelldefine',
  'resetall',
]);

const _PP_HEADER_EXTENSIONS = new Set(['.vh', '.svh']);

function _ppGetExtension(fileName) {
  const clean = String(fileName || '').trim().toLowerCase();
  const dot = clean.lastIndexOf('.');
  return dot >= 0 ? clean.slice(dot) : '';
}

function _ppBaseName(filePath) {
  const parts = String(filePath || '').trim().split(/[\\/]/);
  return parts[parts.length - 1] || '';
}

/**
 * Strip UTF-8 BOM (\uFEFF) and normalize CRLF / CR line endings to LF (\n).
 * @param {string} raw
 * @returns {string}
 */
export function sanitizeHdlText(raw) {
  let text = String(raw ?? '');
  if (text.charCodeAt(0) === 0xFEFF) {
    text = text.slice(1);
  }
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Validate an uploaded HDL file (extension, VHDL rejection, size <= 512 KB, binary null-byte check)
 * and sanitize BOM + CRLF line endings.
 *
 * @param {string} fileName
 * @param {string|Uint8Array|ArrayBuffer} rawContent
 * @returns {{ ok: true, name: string, content: string } | { ok: false, code: string, params: object, message: string }}
 */
export function validateUploadedHdlFile(fileName, rawContent) {
  const name = _ppBaseName(fileName) || 'untitled.sv';
  const ext = _ppGetExtension(name);

  if (UNSUPPORTED_VHDL_EXTENSIONS.includes(ext)) {
    return {
      ok: false,
      code: 'UPLOAD_VHDL_UNSUPPORTED',
      params: { file: name },
      message: `Skipped '${name}': VHDL (.vhd/.vhdl) is not supported. Please upload Verilog/SystemVerilog (.v, .sv, .vh, .svh).`,
    };
  }

  if (!SUPPORTED_HDL_EXTENSIONS.includes(ext)) {
    return {
      ok: false,
      code: 'UPLOAD_UNSUPPORTED_EXT',
      params: { file: name, ext: ext || '(none)' },
      message: `Skipped '${name}': unsupported extension '${ext || '(none)'}'. Supported: .v, .sv, .vh, .svh.`,
    };
  }

  let byteLen = 0;
  let hasNullByte = false;
  let text = '';

  if (rawContent instanceof ArrayBuffer || ArrayBuffer.isView(rawContent)) {
    const bytes = rawContent instanceof ArrayBuffer
      ? new Uint8Array(rawContent)
      : new Uint8Array(rawContent.buffer, rawContent.byteOffset, rawContent.byteLength);
    byteLen = bytes.byteLength;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0) {
        hasNullByte = true;
        break;
      }
    }
    if (!hasNullByte && byteLen <= MAX_HDL_FILE_BYTES) {
      text = typeof TextDecoder !== 'undefined'
        ? new TextDecoder('utf-8').decode(bytes)
        : String.fromCharCode(...bytes);
    }
  } else {
    text = String(rawContent ?? '');
    byteLen = typeof TextEncoder !== 'undefined'
      ? new TextEncoder().encode(text).length
      : text.length;
    hasNullByte = text.indexOf('\0') !== -1;
  }

  if (byteLen > MAX_HDL_FILE_BYTES) {
    return {
      ok: false,
      code: 'UPLOAD_FILE_TOO_LARGE',
      params: { file: name, sizeKb: (byteLen / 1024).toFixed(1), maxKb: 512 },
      message: `Rejected '${name}': file exceeds 512 KB limit (${(byteLen / 1024).toFixed(1)} KB).`,
    };
  }

  if (hasNullByte) {
    return {
      ok: false,
      code: 'UPLOAD_BINARY_REJECTED',
      params: { file: name },
      message: `Rejected '${name}': binary content detected (null bytes).`,
    };
  }

  return {
    ok: true,
    name,
    content: sanitizeHdlText(text),
  };
}

function _ppStripInlineComment(text) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      out += ch;
      if (ch === '\\' && i + 1 < text.length) {
        out += text[++i];
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      break;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) break;
      i = end + 1;
      out += ' ';
      continue;
    }
    out += ch;
  }
  return out.trim();
}

function _ppHasModuleDecl(sanitizedCode) {
  const noBlock = sanitizedCode.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const noLine = noBlock.replace(/\/\/[^\n]*/g, '');
  return /\bmodule\s+[a-zA-Z_$]/.test(noLine);
}

function _ppExpandMacrosOnLine(line, defines, state) {
  const len = line.length;
  let out = '';
  let i = 0;
  let inStr = false;

  while (i < len) {
    const ch = line[i];

    if (state.inBlockComment) {
      if (ch === '*' && line[i + 1] === '/') {
        out += '*/';
        i += 2;
        state.inBlockComment = false;
      } else {
        out += ch;
        i++;
      }
      continue;
    }

    if (inStr) {
      out += ch;
      if (ch === '\\' && i + 1 < len) {
        out += line[++i];
      } else if (ch === '"') {
        inStr = false;
      }
      i++;
      continue;
    }

    if (ch === '/' && line[i + 1] === '/') {
      out += line.slice(i);
      break;
    }

    if (ch === '/' && line[i + 1] === '*') {
      out += '/*';
      i += 2;
      state.inBlockComment = true;
      continue;
    }

    if (ch === '"') {
      inStr = true;
      out += ch;
      i++;
      continue;
    }

    if (ch === '`') {
      const m = /^`([a-zA-Z_][a-zA-Z0-9_]*)/.exec(line.slice(i));
      if (m && defines.has(m[1])) {
        let expanded = defines.get(m[1]);
        // Allow nested macro-in-macro expansion up to 8 passes
        for (let pass = 0; pass < 8 && expanded.includes('`'); pass++) {
          let changed = false;
          expanded = expanded.replace(/`([a-zA-Z_][a-zA-Z0-9_]*)/g, (full, name) => {
            if (defines.has(name)) {
              changed = true;
              return defines.get(name);
            }
            return full;
          });
          if (!changed) break;
        }
        out += expanded;
        i += m[0].length;
        continue;
      }
    }

    out += ch;
    i++;
  }

  return out;
}

/**
 * Preprocess an array of workspace HDL files `[{ name, content }]` (or a single string)
 * into merged Verilog/SV code + a 1-based line `sourceMap` + structured warnings/infos.
 *
 * @param {Array<{ name: string, content: string }>|string} filesInput
 * @param {{ defaultFile?: string }} [options={}]
 * @returns {{
 *   mergedCode: string,
 *   sourceMap: Array<{ fileName: string, originalLine: number }>,
 *   warnings: object[],
 *   infos: object[],
 *   defines: Record<string, string>,
 *   includedFiles: string[]
 * }}
 */
export function preprocessWorkspace(filesInput, options = {}) {
  const rawList = typeof filesInput === 'string'
    ? [{ name: options.defaultFile || 'main.sv', content: filesInput }]
    : (Array.isArray(filesInput) ? filesInput : []);

  const files = rawList.map((f, idx) => ({
    name: String(f?.name || `file_${idx + 1}.sv`),
    content: sanitizeHdlText(f?.content ?? ''),
  }));

  // Build flexible lookup table for `include resolution (exact, basename, case-insensitive)
  const fileLookup = new Map();
  for (const f of files) {
    fileLookup.set(f.name, f);
    fileLookup.set(f.name.toLowerCase(), f);
    const base = _ppBaseName(f.name);
    if (!fileLookup.has(base)) fileLookup.set(base, f);
    if (!fileLookup.has(base.toLowerCase())) fileLookup.set(base.toLowerCase(), f);
  }

  const mergedLines = [];
  const sourceMap = [];
  const warnings = [];
  const infos = [];
  const defines = new Map();
  const includedSet = new Set();

  const emitLine = (text, fileName, originalLine) => {
    mergedLines.push(text);
    sourceMap.push({ fileName, originalLine });
  };

  const processFile = (fileObj, includeStack) => {
    const lines = fileObj.content.split('\n');
    const commentState = { inBlockComment: false };
    const condStack = [];
    const isActive = () => condStack.every((frame) => frame.branchActive);

    for (let idx = 0; idx < lines.length; idx++) {
      const origLine = idx + 1;
      const rawLine = lines[idx];

      // Inside a multi-line /* ... */ comment: never interpret directives
      if (commentState.inBlockComment) {
        const processed = _ppExpandMacrosOnLine(rawLine, defines, commentState);
        emitLine(isActive() ? processed : '', fileObj.name, origLine);
        continue;
      }

      // Check leading preprocessor directive: `keyword ...
      const dirMatch = /^\s*`([a-zA-Z_][a-zA-Z0-9_]*)(.*)$/.exec(rawLine);
      if (dirMatch) {
        const kw = dirMatch[1];
        const rest = dirMatch[2] || '';

        // Conditional compilation directives
        if (kw === 'ifdef' || kw === 'ifndef') {
          const macroName = _ppStripInlineComment(rest).split(/\s+/)[0] || '';
          const parentActive = isActive();
          const cond = kw === 'ifdef' ? defines.has(macroName) : !defines.has(macroName);
          condStack.push({ parentActive, taken: cond, branchActive: parentActive && cond });
          emitLine('', fileObj.name, origLine);
          continue;
        }
        if (kw === 'else') {
          if (condStack.length > 0) {
            const top = condStack[condStack.length - 1];
            top.branchActive = top.parentActive && !top.taken;
            top.taken = true;
          }
          emitLine('', fileObj.name, origLine);
          continue;
        }
        if (kw === 'endif') {
          if (condStack.length > 0) condStack.pop();
          emitLine('', fileObj.name, origLine);
          continue;
        }

        if (!isActive()) {
          emitLine('', fileObj.name, origLine);
          continue;
        }

        // Gracefully skipped directives (`timescale, `default_nettype, `celldefine, `endcelldefine)
        if (_PP_SKIP_DIRECTIVES.has(kw)) {
          infos.push({
            code: 'PREPROC_DIRECTIVE_SKIPPED',
            severity: 'info',
            file: fileObj.name,
            line: origLine,
            signal: null,
            message: `Skipped directive \`${kw} (${fileObj.name}:${origLine}).`,
            params: { directive: `\`${kw}`, file: fileObj.name, line: origLine },
          });
          emitLine('', fileObj.name, origLine);
          continue;
        }

        // Single-line `define NAME [VALUE]
        if (kw === 'define') {
          const cleanRest = _ppStripInlineComment(rest);
          const defMatch = /^([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+([\s\S]*))?$/.exec(cleanRest);
          if (defMatch) {
            defines.set(defMatch[1], (defMatch[2] ?? '').trim());
          }
          emitLine('', fileObj.name, origLine);
          continue;
        }

        if (kw === 'undef') {
          const name = _ppStripInlineComment(rest).split(/\s+/)[0] || '';
          if (name) defines.delete(name);
          emitLine('', fileObj.name, origLine);
          continue;
        }

        // `include "filename.vh"
        if (kw === 'include') {
          const incMatch = /["<]([^">]+)[">]/.exec(rest);
          const incName = incMatch ? incMatch[1].trim() : '';
          const target =
            fileLookup.get(incName) ||
            fileLookup.get(incName.toLowerCase()) ||
            fileLookup.get(_ppBaseName(incName)) ||
            fileLookup.get(_ppBaseName(incName).toLowerCase()) ||
            null;

          if (!target) {
            warnings.push({
              code: 'PREPROC_MISSING_INCLUDE',
              severity: 'warning',
              file: fileObj.name,
              line: origLine,
              signal: null,
              message: `Included file '${incName || '?'}' not found in workspace tabs (${fileObj.name}:${origLine}). Please upload '${incName || '?'}'.`,
              params: { includeFile: incName || '?', file: fileObj.name, line: origLine },
            });
            emitLine('', fileObj.name, origLine);
          } else if (includeStack.has(target.name)) {
            warnings.push({
              code: 'PREPROC_CIRCULAR_INCLUDE',
              severity: 'warning',
              file: fileObj.name,
              line: origLine,
              signal: null,
              message: `Circular \`include '${target.name}' ignored at ${fileObj.name}:${origLine}.`,
              params: { includeFile: target.name, file: fileObj.name, line: origLine },
            });
            emitLine('', fileObj.name, origLine);
          } else {
            includedSet.add(target.name);
            const nextStack = new Set(includeStack);
            nextStack.add(target.name);
            processFile(target, nextStack);
          }
          continue;
        }

        // If NOT a defined macro invocation, skip unrecognized directive gracefully with warning
        if (!defines.has(kw)) {
          warnings.push({
            code: 'PREPROC_UNKNOWN_DIRECTIVE',
            severity: 'warning',
            file: fileObj.name,
            line: origLine,
            signal: null,
            message: `Skipped unsupported preprocessor directive \`${kw} (${fileObj.name}:${origLine}).`,
            params: { directive: `\`${kw}`, file: fileObj.name, line: origLine },
          });
          emitLine('', fileObj.name, origLine);
          continue;
        }
      }

      if (!isActive()) {
        emitLine('', fileObj.name, origLine);
        continue;
      }

      const expanded = _ppExpandMacrosOnLine(rawLine, defines, commentState);
      emitLine(expanded, fileObj.name, origLine);
    }
  };

  // Identify pure header tabs (.vh / .svh without module definitions)
  const isPureHeader = (f) => _PP_HEADER_EXTENSIONS.has(_ppGetExtension(f.name)) && !_ppHasModuleDecl(f.content);
  const compilationFiles = files.filter((f) => !isPureHeader(f));
  const filesToCompile = compilationFiles.length > 0 ? compilationFiles : files;

  for (const f of filesToCompile) {
    processFile(f, new Set([f.name]));
  }

  return {
    mergedCode: mergedLines.join('\n'),
    sourceMap,
    warnings,
    infos,
    defines: Object.fromEntries(defines.entries()),
    includedFiles: [...includedSet],
  };
}

/**
 * Resolve a 1-based preprocessed line number back to `{ fileName, originalLine }`.
 * @param {Array<{ fileName: string, originalLine: number }>} sourceMap
 * @param {number|null|undefined} mergedLine
 */
export function resolveSourceLocation(sourceMap, mergedLine) {
  if (!Array.isArray(sourceMap) || sourceMap.length === 0) return null;
  const ln = Number(mergedLine);
  if (!Number.isInteger(ln) || ln < 1) return null;
  if (ln <= sourceMap.length) return sourceMap[ln - 1];
  return sourceMap[sourceMap.length - 1];
}

/**
 * Map a parser or synthesizer diagnostic's merged line number back to its exact workspace file & line.
 * @param {object} diag
 * @param {Array<{ fileName: string, originalLine: number }>} sourceMap
 */
export function mapDiagnosticToSource(diag, sourceMap) {
  if (!diag) return diag;
  if (diag.file) return diag; // Already mapped (e.g. preprocessor diagnostic)
  const loc = resolveSourceLocation(sourceMap, diag.line);
  if (!loc) return diag;
  return {
    ...diag,
    file: loc.fileName,
    line: loc.originalLine,
    params: {
      ...(diag.params || {}),
      file: loc.fileName,
      line: loc.originalLine,
    },
  };
}
