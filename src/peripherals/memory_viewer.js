/**
 * Phase B (v2.5) — Live 2D Unpacked Memory / SRAM Viewer & Hex Loader
 * Inspects unpacked arrays (reg/logic [W-1:0] mem [0:D-1]), highlights live writes,
 * and loads Verilog $readmemh / Intel HEX text via simulator.loadMemoryHex().
 */

import { t } from '../i18n.js';
import { logic4ToString } from '../engine/simulator.js';

export const MEMORY_VIEWER_MANIFEST = Object.freeze({
  id: 'memory_viewer',
  nameKey: 'periph.mem.name',
  defaultName: 'Memory / SRAM Viewer',
  pins: Object.freeze([]),
  create: (opts) => new MemoryViewerPeripheral(opts),
});

export class MemoryViewerPeripheral {
  constructor(options = {}) {
    this.id = MEMORY_VIEWER_MANIFEST.id;
    this.bindings = {};
    this.ctx = null;
    this.selectedMem = options.memoryName || '';
    this.sampleHex = options.sampleHex || '@00\n48 44 4C 20 46 50 47 41\n01 23 45 67 89 AB CD EF';

    this._prevWords = new Map();
    this._writtenAddrs = new Set();

    this._memSelect = null;
    this._tableWrap = null;
    this._hexInput = null;
    this._statusEl = null;
  }

  attach(ctx) {
    this.ctx = ctx;
    this._prevWords.clear();
    this._writtenAddrs.clear();
    this._refreshMemoryList();
    this._renderGrid(false);
  }

  detach() {}
  rebind() {}

  _refreshMemoryList() {
    const mems = this.ctx?.sim ? this.ctx.sim.listMemories() : [];
    if (!mems.some((m) => m.name === this.selectedMem)) {
      const match = this.selectedMem
        ? mems.find((m) => m.name.endsWith(`.${this.selectedMem}`) || this.selectedMem.endsWith(`.${m.name}`))
        : null;
      this.selectedMem = match ? match.name : (mems.length > 0 ? mems[0].name : '');
    }
    if (this._memSelect) {
      this._memSelect.innerHTML = '';
      if (mems.length === 0) {
        const o = document.createElement('option');
        o.value = '';
        o.textContent = t('periph.mem.none');
        this._memSelect.appendChild(o);
      } else {
        for (const m of mems) {
          const o = document.createElement('option');
          o.value = m.name;
          o.textContent = `${m.name} [${m.depth}×${m.width}b]`;
          if (m.name === this.selectedMem) o.selected = true;
          this._memSelect.appendChild(o);
        }
      }
    }
  }

  loadHex(hexText) {
    if (!this.ctx?.sim || !this.selectedMem) return null;
    const res = this.ctx.sim.loadMemoryHex(this.selectedMem, hexText);
    this._renderGrid(true);
    if (typeof this.ctx.onExternalInput === 'function') {
      this.ctx.onExternalInput();
    }
    if (this._statusEl) {
      this._statusEl.textContent = t('periph.mem.loaded', { count: res.loadedWords, name: this.selectedMem });
    }
    return res;
  }

  mount(container) {
    if (!container || typeof document === 'undefined') return;
    container.innerHTML = '';

    const ctrlRow = document.createElement('div');
    ctrlRow.className = 'periph-ctrl-row';

    const memSel = document.createElement('select');
    memSel.className = 'periph-select';
    memSel.addEventListener('change', () => {
      this.selectedMem = memSel.value;
      this._prevWords.clear();
      this._writtenAddrs.clear();
      this._renderGrid(false);
    });
    this._memSelect = memSel;

    const status = document.createElement('span');
    status.className = 'periph-meta-line';
    this._statusEl = status;

    ctrlRow.appendChild(memSel);
    ctrlRow.appendChild(status);

    const tableWrap = document.createElement('div');
    tableWrap.className = 'mem-grid-wrap';
    this._tableWrap = tableWrap;

    const loaderRow = document.createElement('div');
    loaderRow.className = 'mem-loader-row';

    const ta = document.createElement('textarea');
    ta.className = 'mem-hex-input';
    ta.rows = 2;
    ta.value = this.sampleHex;
    ta.placeholder = '@00 AA 55 FF';
    this._hexInput = ta;

    const loadBtn = document.createElement('button');
    loadBtn.type = 'button';
    loadBtn.className = 'btn btn-xs btn-primary';
    loadBtn.setAttribute('data-i18n', 'periph.mem.loadHex');
    loadBtn.textContent = t('periph.mem.loadHex');
    loadBtn.addEventListener('click', () => this.loadHex(ta.value));

    loaderRow.appendChild(ta);
    loaderRow.appendChild(loadBtn);

    container.appendChild(ctrlRow);
    container.appendChild(tableWrap);
    container.appendChild(loaderRow);

    this._refreshMemoryList();
    this._renderGrid(false);
  }

  _renderGrid(detectWrites) {
    if (!this._tableWrap) return;
    const snap = this.ctx?.sim && this.selectedMem ? this.ctx.sim.getMemory(this.selectedMem) : null;
    if (!snap) {
      this._tableWrap.innerHTML = `<div class="drc-empty">${t('periph.mem.none')}</div>`;
      return;
    }

    const maxCells = Math.min(snap.depth, 64);
    const cols = 4;
    let html = '<table class="mem-table"><thead><tr><th>Addr</th>';
    for (let c = 0; c < cols; c++) html += `<th>+${c.toString(16).toUpperCase()}</th>`;
    html += '</tr></thead><tbody>';

    for (let base = 0; base < maxCells; base += cols) {
      const baseAddr = snap.addrMin + base;
      html += `<tr><td class="mem-addr">0x${baseAddr.toString(16).toUpperCase().padStart(2, '0')}</td>`;
      for (let c = 0; c < cols; c++) {
        const idx = base + c;
        if (idx >= maxCells) {
          html += '<td></td>';
          continue;
        }
        const w = snap.words[idx];
        const hexStr = logic4ToString(w, 'hex');
        const sigKey = `${w.val}:${w.xMask}:${w.zMask}`;
        const prev = this._prevWords.get(w.addr);
        if (detectWrites && prev !== undefined && prev !== sigKey) {
          this._writtenAddrs.add(w.addr);
        }
        this._prevWords.set(w.addr, sigKey);

        const isUnknown = (w.xMask | w.zMask) !== 0n;
        const cls = this._writtenAddrs.has(w.addr)
          ? 'mem-cell mem-written'
          : isUnknown
            ? 'mem-cell mem-x'
            : 'mem-cell';
        html += `<td class="${cls}">${hexStr}</td>`;
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    this._tableWrap.innerHTML = html;
  }

  onFrame() {
    this._renderGrid(true);
  }

  updateTranslations() {
    this._refreshMemoryList();
    this._renderGrid(false);
  }

  destroy() {}
}
