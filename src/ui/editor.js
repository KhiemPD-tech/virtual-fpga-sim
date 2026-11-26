/**
 * Phase 3 / v3.1 — Multi-File Tabbed Syntax-Highlighted HDL Code Editor
 * Features tabbed .v/.sv/.vh/.svh workspace, double-click rename, safe close,
 * +New File, #3B9ED8 dashed Drag & Drop overlay, per-file error gutter highlights,
 * and single-pass HTML-escaped syntax highlighting (strictly zero purple/violet).
 */

import { t } from '../i18n.js';

const _ED_CONTROL_KEYWORDS = new Set([
  'module', 'endmodule',
  'assign', 'always', 'always_ff', 'always_comb', 'initial',
  'posedge', 'negedge', 'or',
  'begin', 'end',
  'if', 'else',
  'case', 'default', 'endcase',
  'for',
]);

const _ED_TYPE_KEYWORDS = new Set([
  'input', 'output', 'inout',
  'wire', 'reg', 'logic', 'integer', 'int',
  'parameter', 'localparam',
]);

const _ED_IO_PORTS = new Set([
  'CLOCK_50', 'CLK', 'clk',
  'SW', 'sw', 'KEY', 'BTN', 'btnC', 'btnU', 'btnD', 'btnL', 'btnR',
  'LEDR', 'LEDG', 'LED', 'led', 'GPIO', 'JA', 'JB',
  'HEX0', 'HEX1', 'HEX2', 'HEX3', 'HEX4', 'HEX5', 'HEX6', 'HEX7', 'an', 'seg', 'dp',
  'UART_TX', 'UART_RX', 'PWM', 'BUZZ', 'ADC_DATA',
]);

const _ED_MULTI_OPS = [
  '===', '!==', '<=', '>=', '==', '!=', '<<', '>>', '&&', '||',
];

const _ED_SINGLE_OPS = new Set([
  '~', '&', '|', '^', '!', '+', '-', '*', '/', '%', '<', '>', '=', '?', ':',
]);

function _edEscapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Single-pass syntax highlighter (strictly zero purple/violet).
 * Escapes every slice BEFORE wrapping in <span> so operators like <=, >= never corrupt HTML.
 * @param {string} code
 * @returns {string}
 */
export function highlightHdlToHtml(code = '') {
  const src = String(code);
  const len = src.length;
  let i = 0;
  let out = '';

  while (i < len) {
    const ch = src[i];

    // Single-line comment // ...
    if (ch === '/' && src[i + 1] === '/') {
      const start = i;
      i += 2;
      while (i < len && src[i] !== '\n') i++;
      out += `<span class="tok-cmt">${_edEscapeHtml(src.slice(start, i))}</span>`;
      continue;
    }

    // Multi-line comment /* ... */
    if (ch === '/' && src[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < len && !(src[i] === '*' && src[i + 1] === '/')) i++;
      if (i < len) i += 2;
      out += `<span class="tok-cmt">${_edEscapeHtml(src.slice(start, i))}</span>`;
      continue;
    }

    // Preprocessor directive / macro token: `timescale, `define, `include, `MACRO
    if (ch === '`' && /[a-zA-Z_]/.test(src[i + 1] || '')) {
      const start = i;
      i++;
      while (i < len && /[a-zA-Z0-9_]/.test(src[i])) i++;
      out += `<span class="tok-op">${_edEscapeHtml(src.slice(start, i))}</span>`;
      continue;
    }

    // String literal "..."
    if (ch === '"') {
      const start = i;
      i++;
      while (i < len && src[i] !== '"' && src[i] !== '\n') {
        if (src[i] === '\\' && i + 1 < len) i += 2;
        else i++;
      }
      if (i < len && src[i] === '"') i++;
      out += `<span class="tok-num">${_edEscapeHtml(src.slice(start, i))}</span>`;
      continue;
    }

    // Sized / unsized Verilog numeric literals
    if (/[0-9]/.test(ch) || (ch === "'" && /[sSbBhHdDoO01xXzZ]/.test(src[i + 1] || ''))) {
      const start = i;
      if (ch !== "'") {
        while (i < len && /[0-9_]/.test(src[i])) i++;
      }
      if (src[i] === "'") {
        i++;
        if (i < len && /[sS]/.test(src[i])) i++;
        if (i < len && /[bBhHdDoO]/.test(src[i])) {
          i++;
          while (i < len && /[0-9a-fA-FxXzZ_?]/.test(src[i])) i++;
        } else if (i < len && /[01xXzZ]/.test(src[i])) {
          i++;
        }
      }
      out += `<span class="tok-num">${_edEscapeHtml(src.slice(start, i))}</span>`;
      continue;
    }

    // Identifiers, keywords, types, FPGA I/O names
    if (/[a-zA-Z_$]/.test(ch)) {
      const start = i;
      while (i < len && /[a-zA-Z0-9_$]/.test(src[i])) i++;
      const word = src.slice(start, i);
      const safeWord = _edEscapeHtml(word);
      if (_ED_CONTROL_KEYWORDS.has(word)) {
        out += `<span class="tok-kw">${safeWord}</span>`;
      } else if (_ED_TYPE_KEYWORDS.has(word)) {
        out += `<span class="tok-type">${safeWord}</span>`;
      } else if (_ED_IO_PORTS.has(word)) {
        out += `<span class="tok-io">${safeWord}</span>`;
      } else {
        out += safeWord;
      }
      continue;
    }

    // Multi-char operators
    let multi = null;
    for (const op of _ED_MULTI_OPS) {
      if (src.startsWith(op, i)) {
        multi = op;
        break;
      }
    }
    if (multi) {
      out += `<span class="tok-op">${_edEscapeHtml(multi)}</span>`;
      i += multi.length;
      continue;
    }

    // Single-char operators
    if (_ED_SINGLE_OPS.has(ch)) {
      out += `<span class="tok-op">${_edEscapeHtml(ch)}</span>`;
      i++;
      continue;
    }

    out += _edEscapeHtml(ch);
    i++;
  }

  if (src.endsWith('\n')) {
    out += ' ';
  }
  return out;
}

export class HdlEditor {
  /**
   * @param {HTMLElement|null} container
   * @param {object|string} [optionsOrCode={}]
   */
  constructor(container, optionsOrCode = {}) {
    const opts = typeof optionsOrCode === 'string'
      ? { initialCode: optionsOrCode }
      : (optionsOrCode || {});

    this.container = container;
    this.onChange = typeof opts.onChange === 'function' ? opts.onChange : null;
    this.onCursorChange = typeof opts.onCursorChange === 'function' ? opts.onCursorChange : null;
    this.onFilesDrop = typeof opts.onFilesDrop === 'function' ? opts.onFilesDrop : null;
    this.onActiveFileChange = typeof opts.onActiveFileChange === 'function' ? opts.onActiveFileChange : null;

    if (Array.isArray(opts.initialFiles) && opts.initialFiles.length > 0) {
      this.files = opts.initialFiles.map((f) => ({ name: String(f.name), content: String(f.content ?? '') }));
      this.activeFileName = opts.activeFile || this.files[0].name;
    } else {
      const defName = opts.initialFilename || 'main.sv';
      this.files = [{ name: defName, content: String(opts.initialCode ?? '') }];
      this.activeFileName = defName;
    }
    this.code = this._getActiveRecord().content;

    this.errorsByFile = new Map();
    this.errorMap = new Map();
    this._dragDepth = 0;

    this.workspaceEl = null;
    this.tabbarEl = null;
    this.dropOverlayEl = null;
    this.dropTextEl = null;
    this.rootEl = null;
    this.gutterEl = null;
    this.lineBgEl = null;
    this.preEl = null;
    this.codeEl = null;
    this.textareaEl = null;

    if (this.container && typeof document !== 'undefined') {
      this.mount();
    }
  }

  _getActiveRecord() {
    let rec = this.files.find((f) => f.name === this.activeFileName);
    if (!rec) {
      rec = this.files[0];
      if (!rec) {
        rec = { name: 'main.sv', content: '' };
        this.files.push(rec);
      }
      this.activeFileName = rec.name;
    }
    return rec;
  }

  _syncActiveBuffer() {
    const rec = this._getActiveRecord();
    if (this.textareaEl) {
      rec.content = this.textareaEl.value;
      this.code = rec.content;
    } else {
      rec.content = this.code;
    }
  }

  mount() {
    if (!this.container || typeof document === 'undefined') return;

    this.workspaceEl = document.createElement('div');
    this.workspaceEl.className = 'hdl-workspace';

    // Compact Multi-File Tab Bar
    this.tabbarEl = document.createElement('div');
    this.tabbarEl.className = 'hdl-tabbar';
    this.tabbarEl.setAttribute('role', 'tablist');

    this.rootEl = document.createElement('div');
    this.rootEl.className = 'hdl-editor';

    this.gutterEl = document.createElement('div');
    this.gutterEl.className = 'hdl-gutter';
    this.gutterEl.setAttribute('aria-hidden', 'true');

    const stage = document.createElement('div');
    stage.className = 'hdl-code-stage';

    this.lineBgEl = document.createElement('div');
    this.lineBgEl.className = 'hdl-line-highlights';
    this.lineBgEl.setAttribute('aria-hidden', 'true');

    this.preEl = document.createElement('pre');
    this.preEl.className = 'hdl-highlight';
    this.preEl.setAttribute('aria-hidden', 'true');
    this.codeEl = document.createElement('code');
    this.preEl.appendChild(this.codeEl);

    this.textareaEl = document.createElement('textarea');
    this.textareaEl.className = 'hdl-textarea';
    this.textareaEl.setAttribute('spellcheck', 'false');
    this.textareaEl.setAttribute('autocomplete', 'off');
    this.textareaEl.setAttribute('autocorrect', 'off');
    this.textareaEl.setAttribute('autocapitalize', 'off');
    this.textareaEl.setAttribute('aria-label', 'Verilog HDL Editor');
    this.textareaEl.value = this.code;

    stage.appendChild(this.lineBgEl);
    stage.appendChild(this.preEl);
    stage.appendChild(this.textareaEl);

    this.rootEl.appendChild(this.gutterEl);
    this.rootEl.appendChild(stage);

    // Drag & Drop Overlay (#3B9ED8 dashed border, zero purple)
    this.dropOverlayEl = document.createElement('div');
    this.dropOverlayEl.className = 'hdl-drop-overlay hidden';
    const dropBox = document.createElement('div');
    dropBox.className = 'hdl-drop-box';
    this.dropTextEl = document.createElement('span');
    this.dropTextEl.setAttribute('data-i18n', 'editor.dropHint');
    this.dropTextEl.textContent = t('editor.dropHint');
    dropBox.appendChild(this.dropTextEl);
    this.dropOverlayEl.appendChild(dropBox);

    this.workspaceEl.appendChild(this.tabbarEl);
    this.workspaceEl.appendChild(this.rootEl);
    this.workspaceEl.appendChild(this.dropOverlayEl);

    this.container.innerHTML = '';
    this.container.appendChild(this.workspaceEl);

    this._bindEvents();
    this._bindDropEvents();
    this._renderTabs();
    this._renderAll();
  }

  _bindEvents() {
    if (!this.textareaEl) return;

    this.textareaEl.addEventListener('input', () => {
      this.code = this.textareaEl.value;
      this._getActiveRecord().content = this.code;
      this._renderAll();
      this._syncScroll();
      this._emitCursor();
      if (this.onChange) this.onChange(this.code, this.activeFileName);
    });

    this.textareaEl.addEventListener('scroll', () => this._syncScroll());

    this.textareaEl.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        this._handleTabKey(e.shiftKey);
      }
    });

    const emitCursor = () => this._emitCursor();
    this.textareaEl.addEventListener('keyup', emitCursor);
    this.textareaEl.addEventListener('click', emitCursor);
    this.textareaEl.addEventListener('focus', emitCursor);
  }

  _bindDropEvents() {
    if (!this.workspaceEl) return;

    const showOverlay = () => {
      if (this.dropOverlayEl) this.dropOverlayEl.classList.remove('hidden');
    };
    const hideOverlay = () => {
      this._dragDepth = 0;
      if (this.dropOverlayEl) this.dropOverlayEl.classList.add('hidden');
    };

    this.workspaceEl.addEventListener('dragenter', (e) => {
      e.preventDefault();
      this._dragDepth += 1;
      showOverlay();
    });
    this.workspaceEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      showOverlay();
    });
    this.workspaceEl.addEventListener('dragleave', (e) => {
      e.preventDefault();
      this._dragDepth = Math.max(0, this._dragDepth - 1);
      if (this._dragDepth === 0) hideOverlay();
    });
    this.workspaceEl.addEventListener('drop', (e) => {
      e.preventDefault();
      hideOverlay();
      const dropped = e.dataTransfer?.files;
      if (dropped && dropped.length > 0 && this.onFilesDrop) {
        this.onFilesDrop(dropped);
      }
    });
  }

  _renderTabs() {
    if (!this.tabbarEl || typeof document === 'undefined') return;
    this.tabbarEl.innerHTML = '';

    for (const file of this.files) {
      const isActive = file.name === this.activeFileName;
      const fileErrs = this.errorsByFile.get(file.name);
      let badgeKind = '';
      if (fileErrs && fileErrs.size > 0) {
        badgeKind = 'warning';
        for (const e of fileErrs.values()) {
          if (e.severity === 'error') {
            badgeKind = 'error';
            break;
          }
        }
      }

      const tab = document.createElement('div');
      tab.className = `hdl-tab${isActive ? ' active' : ''}`;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
      tab.dataset.filename = file.name;

      if (badgeKind) {
        const dot = document.createElement('span');
        dot.className = `hdl-tab-dot is-${badgeKind}`;
        tab.appendChild(dot);
      }

      const label = document.createElement('span');
      label.className = 'hdl-tab-label';
      label.textContent = file.name;
      label.title = t('editor.renameHint');
      label.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        this._startInlineRename(tab, label, file.name);
      });
      tab.appendChild(label);

      if (this.files.length > 1) {
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'hdl-tab-close';
        closeBtn.textContent = '×';
        closeBtn.title = t('editor.closeTab');
        closeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.closeFile(file.name);
        });
        tab.appendChild(closeBtn);
      }

      tab.addEventListener('click', () => this.switchToFile(file.name));
      this.tabbarEl.appendChild(tab);
    }

    const addBtn = document.createElement('button');
    addBtn.id = 'btn-new-file';
    addBtn.type = 'button';
    addBtn.className = 'hdl-tab-add';
    addBtn.textContent = '+';
    addBtn.title = t('editor.newFileTitle');
    addBtn.setAttribute('aria-label', t('editor.newFileTitle'));
    addBtn.addEventListener('click', () => this.addNewFile());
    this.tabbarEl.appendChild(addBtn);
  }

  _startInlineRename(tabEl, labelEl, oldName) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'hdl-tab-rename';
    input.value = oldName;
    input.size = Math.max(8, oldName.length + 2);

    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      const next = input.value.trim();
      if (commit && next && next !== oldName) {
        this.renameFile(oldName, next);
      } else {
        this._renderTabs();
      }
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));

    tabEl.replaceChild(input, labelEl);
    input.focus();
    const dot = oldName.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : oldName.length);
  }

  // ==========================================================================
  // Multi-File Workspace API
  // ==========================================================================

  getFiles() {
    this._syncActiveBuffer();
    return this.files.map((f) => ({ name: f.name, content: f.content }));
  }

  getActiveFile() {
    this._syncActiveBuffer();
    const rec = this._getActiveRecord();
    return { name: rec.name, content: rec.content };
  }

  setFiles(filesList, activeName = null) {
    const cleaned = Array.isArray(filesList) && filesList.length > 0
      ? filesList.map((f, idx) => ({
        name: String(f?.name || `file_${idx + 1}.sv`),
        content: String(f?.content ?? ''),
      }))
      : [{ name: 'main.sv', content: '' }];

    this.files = cleaned;
    this.activeFileName = activeName && cleaned.some((f) => f.name === activeName)
      ? activeName
      : cleaned[0].name;
    this.errorsByFile.clear();
    this._loadActiveIntoEditor();
  }

  upsertFile(name, content, switchTo = true) {
    this._syncActiveBuffer();
    const cleanName = String(name || 'untitled.sv').trim() || 'untitled.sv';
    const text = String(content ?? '');
    const existing = this.files.find((f) => f.name === cleanName);

    if (existing) {
      existing.content = text;
    } else {
      this.files.push({ name: cleanName, content: text });
    }

    if (switchTo || existing?.name === this.activeFileName) {
      this.activeFileName = cleanName;
      this._loadActiveIntoEditor();
    } else {
      this._renderTabs();
    }
    return cleanName;
  }

  addNewFile(preferredName = null) {
    this._syncActiveBuffer();
    let idx = this.files.length + 1;
    let candidate = preferredName || `module_${idx}.sv`;
    while (this.files.some((f) => f.name === candidate)) {
      idx += 1;
      candidate = `module_${idx}.sv`;
    }
    const baseMod = candidate.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_]/g, '_') || 'sub_mod';
    const stub = `module ${baseMod} (\n  input  logic a,\n  output logic y\n);\n  assign y = a;\nendmodule\n`;
    this.upsertFile(candidate, stub, true);
    return candidate;
  }

  switchToFile(name) {
    if (!this.files.some((f) => f.name === name)) return false;
    if (name === this.activeFileName) return true;
    this._syncActiveBuffer();
    this.activeFileName = name;
    this._loadActiveIntoEditor();
    return true;
  }

  renameFile(oldName, newName) {
    const clean = String(newName || '').trim().replace(/[\\/]/g, '_');
    if (!clean || clean === oldName) return false;
    if (this.files.some((f) => f.name === clean)) return false;

    const target = this.files.find((f) => f.name === oldName);
    if (!target) return false;
    target.name = clean;

    if (this.errorsByFile.has(oldName)) {
      this.errorsByFile.set(clean, this.errorsByFile.get(oldName));
      this.errorsByFile.delete(oldName);
    }
    if (this.activeFileName === oldName) {
      this.activeFileName = clean;
    }
    this._renderTabs();
    if (this.onActiveFileChange) this.onActiveFileChange(this.getActiveFile());
    return true;
  }

  closeFile(name) {
    if (this.files.length <= 1) return false;
    const idx = this.files.findIndex((f) => f.name === name);
    if (idx === -1) return false;

    this._syncActiveBuffer();
    this.files.splice(idx, 1);
    this.errorsByFile.delete(name);

    if (this.activeFileName === name) {
      const nextIdx = Math.min(idx, this.files.length - 1);
      this.activeFileName = this.files[nextIdx].name;
      this._loadActiveIntoEditor();
    } else {
      this._renderTabs();
    }
    return true;
  }

  _loadActiveIntoEditor() {
    const rec = this._getActiveRecord();
    this.code = rec.content;
    this.errorMap = this.errorsByFile.get(rec.name) || new Map();
    if (this.textareaEl) {
      this.textareaEl.value = this.code;
      this.textareaEl.scrollTop = 0;
      this.textareaEl.scrollLeft = 0;
    }
    this._renderTabs();
    this._renderAll();
    this._emitCursor();
    if (this.onActiveFileChange) this.onActiveFileChange({ name: rec.name, content: rec.content });
  }

  _handleTabKey(isShift) {
    const ta = this.textareaEl;
    if (!ta) return;

    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const val = ta.value;

    if (!isShift && start === end) {
      ta.value = val.slice(0, start) + '  ' + val.slice(end);
      ta.selectionStart = ta.selectionEnd = start + 2;
    } else {
      const lineStart = val.lastIndexOf('\n', start - 1) + 1;
      const lineEndIdx = val.indexOf('\n', end);
      const blockEnd = lineEndIdx === -1 ? val.length : lineEndIdx;
      const selectedBlock = val.slice(lineStart, blockEnd);
      const lines = selectedBlock.split('\n');

      let firstDelta = 0;
      let totalDelta = 0;
      const updated = lines.map((line, idx) => {
        if (!isShift) {
          if (idx === 0) firstDelta = 2;
          totalDelta += 2;
          return '  ' + line;
        }
        const matchSpaces = line.match(/^ {1,2}/);
        const removed = matchSpaces ? matchSpaces[0].length : 0;
        if (idx === 0) firstDelta = -removed;
        totalDelta -= removed;
        return line.slice(removed);
      });

      ta.value = val.slice(0, lineStart) + updated.join('\n') + val.slice(blockEnd);
      ta.selectionStart = Math.max(lineStart, start + firstDelta);
      ta.selectionEnd = Math.max(ta.selectionStart, end + totalDelta);
    }

    this.code = ta.value;
    this._getActiveRecord().content = this.code;
    this._renderAll();
    this._syncScroll();
    this._emitCursor();
    if (this.onChange) this.onChange(this.code, this.activeFileName);
  }

  _syncScroll() {
    if (!this.textareaEl || !this.preEl || !this.gutterEl || !this.lineBgEl) return;
    const top = this.textareaEl.scrollTop;
    const left = this.textareaEl.scrollLeft;
    this.preEl.scrollTop = top;
    this.preEl.scrollLeft = left;
    this.gutterEl.scrollTop = top;
    this.lineBgEl.scrollTop = top;
  }

  _emitCursor() {
    if (!this.textareaEl || !this.onCursorChange) return;
    const caret = this.textareaEl.selectionStart || 0;
    const before = this.textareaEl.value.slice(0, caret);
    const lines = before.split('\n');
    this.onCursorChange({
      line: lines.length,
      col: lines[lines.length - 1].length + 1,
    });
  }

  _renderAll() {
    if (this.codeEl) {
      this.codeEl.innerHTML = highlightHdlToHtml(this.code);
    }
    this._renderGutterAndHighlights();
  }

  _renderGutterAndHighlights() {
    if (!this.gutterEl || !this.lineBgEl) return;
    const lineCount = Math.max(1, this.code.split('\n').length);

    let gutterHtml = '';
    let bgHtml = '';

    for (let ln = 1; ln <= lineCount; ln++) {
      const entry = this.errorMap.get(ln);
      if (entry) {
        const cls = entry.severity === 'error' ? 'line-error' : 'line-warning';
        const tip = _edEscapeHtml(entry.messages.join('\n')).replace(/"/g, '&quot;');
        gutterHtml += `<div class="hdl-gutter-line ${cls}" title="${tip}">${ln}</div>`;
        bgHtml += `<div class="hdl-line-bg ${cls}"></div>`;
      } else {
        gutterHtml += `<div class="hdl-gutter-line">${ln}</div>`;
        bgHtml += `<div class="hdl-line-bg"></div>`;
      }
    }

    this.gutterEl.innerHTML = gutterHtml;
    this.lineBgEl.innerHTML = bgHtml;
    this._syncScroll();
  }

  getValue() {
    this._syncActiveBuffer();
    return this.code;
  }

  setValue(code) {
    this.code = String(code ?? '');
    this._getActiveRecord().content = this.code;
    if (this.textareaEl) {
      this.textareaEl.value = this.code;
    }
    this._renderAll();
    this._emitCursor();
  }

  /**
   * Highlight error/warning lines per file tab and update tab status badges.
   * @param {Array<{ file?: string|null, line?: number|null, severity?: string, message?: string }>} errors
   */
  setErrors(errors = []) {
    this.errorsByFile.clear();

    for (const err of errors) {
      const ln = Number(err?.line);
      if (!Number.isInteger(ln) || ln < 1) continue;
      const targetFile = err.file && this.files.some((f) => f.name === err.file)
        ? err.file
        : this.activeFileName;
      if (!this.errorsByFile.has(targetFile)) {
        this.errorsByFile.set(targetFile, new Map());
      }
      const fileMap = this.errorsByFile.get(targetFile);
      const sev = err.severity === 'warning' ? 'warning' : 'error';
      const msg = String(err.message || err.code || 'HDL diagnostic');
      const existing = fileMap.get(ln);
      if (existing) {
        if (sev === 'error') existing.severity = 'error';
        existing.messages.push(msg);
      } else {
        fileMap.set(ln, { severity: sev, messages: [msg] });
      }
    }

    this.errorMap = this.errorsByFile.get(this.activeFileName) || new Map();
    this._renderTabs();
    this._renderGutterAndHighlights();
  }

  clearErrors() {
    this.errorsByFile.clear();
    this.errorMap = new Map();
    this._renderTabs();
    this._renderGutterAndHighlights();
  }

  updateTranslations() {
    if (this.dropTextEl) this.dropTextEl.textContent = t('editor.dropHint');
    this._renderTabs();
  }

  focus() {
    if (this.textareaEl) this.textareaEl.focus();
  }

  /**
   * Switch to `fileName` (if provided) and scroll to 1-based `lineNumber`.
   * @param {number} lineNumber
   * @param {string|null} [fileName=null]
   */
  scrollToLine(lineNumber, fileName = null) {
    if (fileName && fileName !== this.activeFileName) {
      this.switchToFile(fileName);
    }
    const ln = Number(lineNumber);
    if (!this.textareaEl || !Number.isInteger(ln) || ln < 1) return;

    const lines = this.textareaEl.value.split('\n');
    const clamped = Math.min(ln, lines.length);
    let offset = 0;
    for (let i = 0; i < clamped - 1; i++) {
      offset += lines[i].length + 1;
    }

    this.textareaEl.focus();
    this.textareaEl.selectionStart = offset;
    this.textareaEl.selectionEnd = offset + lines[clamped - 1].length;

    const lineHeight = 20;
    this.textareaEl.scrollTop = Math.max(0, (clamped - 3) * lineHeight);
    this._syncScroll();
    this._emitCursor();
  }
}
