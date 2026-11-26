/**
 * Phase 4 — HiDPI HTML5 Canvas Logic Analyzer & 1,000-Sample Ring Buffer
 * Supports 1-bit square waves, multi-bit transition hexagons (HEX/DEC/BIN),
 * 4-state X red diagonal hatching, Z orange center lines, Signal Selector sidebar,
 * mouse-wheel anchored zoom, click-drag pan, Auto-Follow, and vertical hover cursor.
 * Strictly zero purple/violet tones.
 */

import { t } from '../i18n.js';
import { logic4ToString } from '../engine/simulator.js';

export const RING_BUFFER_CAPACITY = 1000;

const _WV_RULER_H = 22;
const _WV_ROW_H = 28;
const _WV_LABEL_W = 104;
const _WV_MIN_PX = 4;
const _WV_MAX_PX = 120;

const _WV_COLORS = Object.freeze({
  bg: '#080C16',
  rulerBg: '#0E1525',
  labelBg: '#0C1220',
  grid: '#18243B',
  rowBorder: '#152036',
  text: '#E2E8F0',
  textMuted: '#94A3B8',
  clk: '#FBBF24',      // Amber/Gold for Clock
  port: '#3B9ED8',     // Electric Cyan for I/O ports
  internal: '#2DD4BF', // Teal/Emerald for internal nets
  portFill: 'rgba(59, 158, 216, 0.14)',
  internalFill: 'rgba(45, 212, 191, 0.12)',
  xStroke: '#EF4444',
  xBg: 'rgba(239, 68, 68, 0.18)',
  zStroke: '#F59E0B',
  cursor: '#7DD3FC',
  cursorBand: 'rgba(59, 158, 216, 0.12)',
});

function _wvMask(width) {
  const w = Math.max(1, width | 0);
  return (1n << BigInt(w)) - 1n;
}

function _wvFormatValue(sigVal, radix) {
  if (!sigVal) return 'X';
  if (sigVal.width === 1) {
    if (sigVal.xMask !== 0n) return 'X';
    if (sigVal.zMask !== 0n) return 'Z';
    return sigVal.val === 1n ? '1' : '0';
  }
  const raw = logic4ToString(sigVal, radix);
  if (radix === 'hex') return `0x${raw}`;
  if (radix === 'bin') return raw;
  return raw;
}

function _wvSampleEq(a, b) {
  if (!a || !b) return false;
  return a.val === b.val && a.xMask === b.xMask && a.zMask === b.zMask && a.width === b.width;
}

export class WaveformViewer {
  /**
   * @param {HTMLElement|null} container
   * @param {number} [capacity=RING_BUFFER_CAPACITY]
   */
  constructor(container, capacity = RING_BUFFER_CAPACITY) {
    this.container = container;
    this.capacity = Math.max(RING_BUFFER_CAPACITY, capacity | 0);

    // Fixed-capacity circular ring buffer
    this._buffer = new Array(this.capacity);
    this._head = 0;
    this._count = 0;
    this._totalPushed = 0;

    // Signal metadata & visibility
    this._signals = []; // [{ name, width, dir, isClock, visible }]
    this._signalMap = new Map();

    // View & interaction state
    this.radix = 'hex';
    this.timeMode = false;
    this.pxPerSample = 26;
    this.viewStart = 0;
    this.autoFollow = true;
    this.hoverIndex = -1;

    this._dragging = false;
    this._dragStartX = 0;
    this._dragStartView = 0;

    // DOM / Canvas handles
    this._shellEl = null;
    this._sidebarListEl = null;
    this._sidebarValueEls = new Map();
    this._canvasWrapEl = null;
    this._canvas = null;
    this._ctx = null;
    this._hatchPattern = null;
    this._statusEl = null;
    this._followCheckEl = null;
    this._radixBtns = [];
    this._resizeObserver = null;
    this._resizeRaf = null;

    if (this.container && typeof document !== 'undefined') {
      this.mount();
    }
  }

  mount() {
    if (!this.container || typeof document === 'undefined') return;

    this.container.innerHTML = '';

    const shell = document.createElement('div');
    shell.className = 'wave-shell';

    // Top controls bar
    const toolbar = document.createElement('div');
    toolbar.className = 'wave-toolbar';

    // Radix group
    const radixGroup = document.createElement('div');
    radixGroup.className = 'wave-ctrl-group';
    const radixLabel = document.createElement('span');
    radixLabel.className = 'wave-ctrl-label';
    radixLabel.setAttribute('data-i18n', 'wave.radix');
    radixLabel.textContent = t('wave.radix');
    radixGroup.appendChild(radixLabel);

    const radixSeg = document.createElement('div');
    radixSeg.className = 'wave-seg-group';
    this._radixBtns = [];
    for (const r of ['hex', 'dec', 'bin']) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `wave-btn${this.radix === r ? ' is-active' : ''}`;
      btn.dataset.radix = r;
      btn.textContent = r.toUpperCase();
      btn.addEventListener('click', () => this.setRadix(r));
      radixSeg.appendChild(btn);
      this._radixBtns.push(btn);
    }
    radixGroup.appendChild(radixSeg);
    toolbar.appendChild(radixGroup);

    // Zoom group
    const zoomGroup = document.createElement('div');
    zoomGroup.className = 'wave-ctrl-group';

    const btnOut = document.createElement('button');
    btnOut.type = 'button';
    btnOut.className = 'wave-btn';
    btnOut.textContent = '−';
    btnOut.setAttribute('data-i18n-title', 'wave.zoomOut');
    btnOut.title = t('wave.zoomOut');
    btnOut.addEventListener('click', () => this.zoomBy(1 / 1.35));

    const btnIn = document.createElement('button');
    btnIn.type = 'button';
    btnIn.className = 'wave-btn';
    btnIn.textContent = '+';
    btnIn.setAttribute('data-i18n-title', 'wave.zoomIn');
    btnIn.title = t('wave.zoomIn');
    btnIn.addEventListener('click', () => this.zoomBy(1.35));

    const btnFit = document.createElement('button');
    btnFit.type = 'button';
    btnFit.className = 'wave-btn';
    btnFit.setAttribute('data-i18n', 'wave.fit');
    btnFit.setAttribute('data-i18n-title', 'wave.fitTitle');
    btnFit.textContent = t('wave.fit');
    btnFit.title = t('wave.fitTitle');
    btnFit.addEventListener('click', () => this.zoomFit());

    zoomGroup.appendChild(btnOut);
    zoomGroup.appendChild(btnIn);
    zoomGroup.appendChild(btnFit);
    toolbar.appendChild(zoomGroup);

    // Auto-Follow toggle
    const followWrap = document.createElement('label');
    followWrap.className = 'wave-follow-toggle';
    followWrap.setAttribute('data-i18n-title', 'wave.autoFollowTitle');
    followWrap.title = t('wave.autoFollowTitle');
    const followInput = document.createElement('input');
    followInput.type = 'checkbox';
    followInput.checked = this.autoFollow;
    followInput.addEventListener('change', () => {
      this.setAutoFollow(followInput.checked);
    });
    const followSpan = document.createElement('span');
    followSpan.setAttribute('data-i18n', 'wave.autoFollow');
    followSpan.textContent = t('wave.autoFollow');
    followWrap.appendChild(followInput);
    followWrap.appendChild(followSpan);
    toolbar.appendChild(followWrap);
    this._followCheckEl = followInput;

    // Clear button
    const btnClear = document.createElement('button');
    btnClear.type = 'button';
    btnClear.className = 'wave-btn';
    btnClear.setAttribute('data-i18n', 'wave.clear');
    btnClear.setAttribute('data-i18n-title', 'wave.clearTitle');
    btnClear.textContent = t('wave.clear');
    btnClear.title = t('wave.clearTitle');
    btnClear.addEventListener('click', () => this.clear());
    toolbar.appendChild(btnClear);

    // Export .VCD button (Phase C)
    const btnExportVcd = document.createElement('button');
    btnExportVcd.id = 'btn-export-vcd';
    btnExportVcd.type = 'button';
    btnExportVcd.className = 'wave-btn wave-btn-accent';
    btnExportVcd.setAttribute('data-i18n', 'wave.exportVcd');
    btnExportVcd.setAttribute('data-i18n-title', 'wave.exportVcdTitle');
    btnExportVcd.textContent = t('wave.exportVcd');
    btnExportVcd.title = t('wave.exportVcdTitle');
    btnExportVcd.addEventListener('click', () => {
      if (typeof this._onExportVcd === 'function') {
        this._onExportVcd(this);
      }
    });
    toolbar.appendChild(btnExportVcd);

    // Right status / cursor readout
    const statusEl = document.createElement('span');
    statusEl.className = 'wave-status';
    toolbar.appendChild(statusEl);
    this._statusEl = statusEl;

    // Main split: Signal Selector Sidebar + HiDPI Canvas viewport
    const main = document.createElement('div');
    main.className = 'wave-main';

    const sidebar = document.createElement('aside');
    sidebar.className = 'wave-sidebar';
    const sideHeader = document.createElement('div');
    sideHeader.className = 'wave-sidebar-header';
    sideHeader.setAttribute('data-i18n', 'wave.signals');
    sideHeader.textContent = t('wave.signals');
    sidebar.appendChild(sideHeader);

    const sideList = document.createElement('div');
    sideList.className = 'wave-signal-list';
    sidebar.appendChild(sideList);
    this._sidebarListEl = sideList;

    const canvasWrap = document.createElement('div');
    canvasWrap.className = 'wave-canvas-wrap';
    const canvas = document.createElement('canvas');
    canvas.className = 'wave-canvas';
    canvasWrap.appendChild(canvas);

    main.appendChild(sidebar);
    main.appendChild(canvasWrap);

    shell.appendChild(toolbar);
    shell.appendChild(main);
    this.container.appendChild(shell);

    this._shellEl = shell;
    this._canvasWrapEl = canvasWrap;
    this._canvas = canvas;
    this._ctx = canvas.getContext('2d');
    this._hatchPattern = this._createRedHatchPattern(this._ctx);

    this._bindCanvasEvents();
    this._observeResize();
    this._renderSidebar();
    this.render();
  }

  _createRedHatchPattern(ctx) {
    if (!ctx || typeof document === 'undefined') return null;
    const tile = document.createElement('canvas');
    tile.width = 8;
    tile.height = 8;
    const tctx = tile.getContext('2d');
    if (!tctx) return null;
    tctx.fillStyle = _WV_COLORS.xBg;
    tctx.fillRect(0, 0, 8, 8);
    tctx.strokeStyle = 'rgba(239, 68, 68, 0.65)';
    tctx.lineWidth = 1.2;
    tctx.beginPath();
    tctx.moveTo(-2, 8);
    tctx.lineTo(8, -2);
    tctx.moveTo(0, 10);
    tctx.lineTo(10, 0);
    tctx.stroke();
    return ctx.createPattern(tile, 'repeat');
  }

  _observeResize() {
    if (!this._canvasWrapEl) return;
    const scheduleResizeRender = () => {
      if (this._resizeRaf !== null) return;
      if (typeof requestAnimationFrame === 'function') {
        this._resizeRaf = requestAnimationFrame(() => {
          this._resizeRaf = null;
          this.render();
        });
      } else {
        this.render();
      }
    };

    if (typeof ResizeObserver !== 'undefined') {
      if (this._resizeObserver) this._resizeObserver.disconnect();
      this._resizeObserver = new ResizeObserver(scheduleResizeRender);
      this._resizeObserver.observe(this._canvasWrapEl);
    } else if (typeof window !== 'undefined') {
      window.addEventListener('resize', scheduleResizeRender);
    }
  }

  _bindCanvasEvents() {
    if (!this._canvas) return;

    // Mouse wheel anchored horizontal zoom (Shift+Wheel scrolls vertically)
    this._canvas.addEventListener('wheel', (e) => {
      if (e.shiftKey) return;
      e.preventDefault();
      const rect = this._canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
      this.zoomBy(factor, mouseX);
    }, { passive: false });

    // Click-drag horizontal pan
    this._canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this._dragging = true;
      this._dragStartX = e.clientX;
      this._dragStartView = this.viewStart;
      this._canvas.classList.add('is-dragging');
      try {
        this._canvas.setPointerCapture(e.pointerId);
      } catch {
        // Ignore on synthetic events
      }
    });

    this._canvas.addEventListener('pointermove', (e) => {
      const rect = this._canvas.getBoundingClientRect();
      const localX = e.clientX - rect.left;

      if (this._dragging) {
        const dx = e.clientX - this._dragStartX;
        const deltaSamples = -dx / this.pxPerSample;
        const maxStart = this._getMaxViewStart();
        const nextStart = Math.max(0, Math.min(maxStart, this._dragStartView + deltaSamples));
        if (nextStart < maxStart - 0.25 && this.autoFollow) {
          this.setAutoFollow(false);
        }
        this.viewStart = nextStart;
      }

      if (localX >= _WV_LABEL_W && this._count > 0) {
        const sampleIdx = Math.floor(this.viewStart + (localX - _WV_LABEL_W) / this.pxPerSample);
        this.hoverIndex = sampleIdx >= 0 && sampleIdx < this._count ? sampleIdx : -1;
      } else {
        this.hoverIndex = -1;
      }

      this._updateSidebarValues();
      this._updateStatusText();
      this.render();
    });

    const endDrag = () => {
      if (!this._dragging) return;
      this._dragging = false;
      this._canvas.classList.remove('is-dragging');
    };
    this._canvas.addEventListener('pointerup', endDrag);
    this._canvas.addEventListener('pointercancel', endDrag);

    this._canvas.addEventListener('pointerleave', () => {
      endDrag();
      if (this.hoverIndex !== -1) {
        this.hoverIndex = -1;
        this._updateSidebarValues();
        this._updateStatusText();
        this.render();
      }
    });
  }

  // ==========================================================================
  // Ring Buffer API
  // ==========================================================================

  /**
   * Push a simulator snapshot into the circular ring buffer.
   * @param {object} snapshot - { cycle, phase?, signals: { [name]: { val, xMask, zMask, width } } }
   */
  pushSample(snapshot) {
    if (!snapshot || !snapshot.signals) return;

    const clonedSignals = {};
    for (const [name, s] of Object.entries(snapshot.signals)) {
      clonedSignals[name] = {
        width: s.width ?? 1,
        val: BigInt(s.val ?? 0n),
        xMask: BigInt(s.xMask ?? 0n),
        zMask: BigInt(s.zMask ?? 0n),
      };
      if (!this._signalMap.has(name)) {
        const meta = {
          name,
          width: clonedSignals[name].width,
          dir: 'internal',
          isClock: name === 'CLOCK_50' || name === 'CLK' || name === 'clk',
          visible: true,
        };
        this._signals.push(meta);
        this._signalMap.set(name, meta);
      }
    }

    const ts = typeof snapshot.time === 'number'
      ? snapshot.time
      : (typeof snapshot.timestamp === 'number' ? snapshot.timestamp : null);
    const entry = {
      index: this._totalPushed,
      cycle: snapshot.cycle ?? 0,
      time: ts,
      timestamp: ts,
      phase: snapshot.phase ?? 'comb',
      signals: clonedSignals,
    };

    if (this._count < this.capacity) {
      const slot = (this._head + this._count) % this.capacity;
      this._buffer[slot] = entry;
      this._count += 1;
    } else {
      this._buffer[this._head] = entry;
      this._head = (this._head + 1) % this.capacity;
      if (!this.autoFollow && this.viewStart > 0) {
        this.viewStart = Math.max(0, this.viewStart - 1);
      }
    }

    this._totalPushed += 1;

    if (this.autoFollow) {
      this.viewStart = this._getMaxViewStart();
    }
  }

  /**
   * Backward-compatible alias for pushSample().
   */
  record(snapshot) {
    this.pushSample(snapshot);
  }

  /**
   * Retrieve the chronological `index`-th sample (0 = oldest in buffer, count-1 = newest).
   * @param {number} index
   */
  getSample(index) {
    if (index < 0 || index >= this._count) return null;
    return this._buffer[(this._head + index) % this.capacity] ?? null;
  }

  getSampleCount() {
    return this._count;
  }

  clear() {
    this._buffer.fill(undefined);
    this._head = 0;
    this._count = 0;
    this._totalPushed = 0;
    this.viewStart = 0;
    this.hoverIndex = -1;
    this._updateSidebarValues();
    this._updateStatusText();
    this.render();
  }

  /**
   * Configure displayed signals from parsed AST metadata.
   * Preserves existing visibility checkboxes for matching signal names.
   * @param {Array<{ name: string, width: number, dir: string, isClock?: boolean }>} signalList
   */
  setSignals(signalList = []) {
    const prevVisibility = new Map();
    for (const s of this._signals) {
      prevVisibility.set(s.name, s.visible);
    }

    this._signals = signalList.map((s) => ({
      name: s.name,
      width: s.width ?? 1,
      dir: s.dir || 'internal',
      isClock: Boolean(s.isClock || s.name === 'CLOCK_50' || s.name === 'CLK' || s.name === 'clk'),
      visible: prevVisibility.has(s.name)
        ? prevVisibility.get(s.name)
        : (s.visible !== undefined ? Boolean(s.visible) : true),
    }));

    this._signalMap.clear();
    for (const s of this._signals) {
      this._signalMap.set(s.name, s);
    }

    this._renderSidebar();
    this.render();
  }

  setRadix(radix) {
    if (radix !== 'hex' && radix !== 'dec' && radix !== 'bin') return;
    this.radix = radix;
    for (const btn of this._radixBtns) {
      btn.classList.toggle('is-active', btn.dataset.radix === radix);
    }
    this._updateSidebarValues();
    this.render();
  }

  setAutoFollow(enabled) {
    this.autoFollow = Boolean(enabled);
    if (this._followCheckEl) {
      this._followCheckEl.checked = this.autoFollow;
    }
    if (this.autoFollow) {
      this.viewStart = this._getMaxViewStart();
      this.render();
    }
  }

  zoomBy(factor, anchorX = null) {
    const traceW = this._getTraceWidth();
    const oldPx = this.pxPerSample;
    const newPx = Math.max(_WV_MIN_PX, Math.min(_WV_MAX_PX, oldPx * factor));
    if (newPx === oldPx) return;

    const anchorPx = anchorX !== null
      ? Math.max(0, anchorX - _WV_LABEL_W)
      : traceW * 0.5;
    const anchorSample = this.viewStart + anchorPx / oldPx;

    this.pxPerSample = newPx;
    if (this.autoFollow) {
      this.viewStart = this._getMaxViewStart();
    } else {
      const maxStart = this._getMaxViewStart();
      this.viewStart = Math.max(0, Math.min(maxStart, anchorSample - anchorPx / newPx));
    }
    this.render();
  }

  zoomFit() {
    const traceW = this._getTraceWidth();
    if (this._count <= 1 || traceW <= 20) {
      this.pxPerSample = 26;
      this.viewStart = 0;
    } else {
      this.pxPerSample = Math.max(_WV_MIN_PX, Math.min(_WV_MAX_PX, (traceW - 12) / this._count));
      this.viewStart = 0;
    }
    this.render();
  }

  setTimeMode(enabled) {
    this.timeMode = Boolean(enabled);
    this._updateStatusText();
    this.render();
  }

  /**
   * Load a full discrete-event testbench trace (`[{ time, signals }, ...]`) in ns time mode.
   */
  loadTrace(trace = [], signalList = null) {
    const neededCap = Math.min(4096, Math.max(RING_BUFFER_CAPACITY, trace.length));
    if (neededCap !== this.capacity) {
      this.capacity = neededCap;
      this._buffer = new Array(this.capacity);
    }
    this._buffer.fill(undefined);
    this._head = 0;
    this._count = 0;
    this._totalPushed = 0;
    this.hoverIndex = -1;
    this.timeMode = true;

    if (Array.isArray(signalList)) {
      this.setSignals(signalList);
    }
    const prevAuto = this.autoFollow;
    this.autoFollow = false;
    for (let i = 0; i < trace.length; i++) {
      this.pushSample(trace[i]);
    }
    this.autoFollow = prevAuto;
    this._renderSidebar();
    this.zoomFit();
  }

  setExportVcdHandler(handler) {
    this._onExportVcd = typeof handler === 'function' ? handler : null;
  }

  updateTranslations() {
    this._updateStatusText();
    this.render();
  }

  // ==========================================================================
  // Sidebar Rendering & Helpers
  // ==========================================================================

  _getTraceWidth() {
    const wrapW = this._canvasWrapEl ? this._canvasWrapEl.clientWidth : 520;
    return Math.max(80, wrapW - _WV_LABEL_W);
  }

  _getMaxViewStart() {
    const visibleSamples = this._getTraceWidth() / this.pxPerSample;
    return Math.max(0, this._count - visibleSamples + 1);
  }

  _signalColor(sig) {
    if (sig.isClock) return _WV_COLORS.clk;
    if (sig.dir === 'input' || sig.dir === 'output' || sig.dir === 'inout') return _WV_COLORS.port;
    return _WV_COLORS.internal;
  }

  _renderSidebar() {
    if (!this._sidebarListEl) return;
    this._sidebarListEl.innerHTML = '';
    this._sidebarValueEls.clear();

    for (const sig of this._signals) {
      const row = document.createElement('label');
      row.className = 'wave-sig-row';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = sig.visible;
      cb.addEventListener('change', () => {
        sig.visible = cb.checked;
        this.render();
      });

      const dot = document.createElement('span');
      dot.className = 'wave-sig-dot';
      dot.style.backgroundColor = this._signalColor(sig);

      const nameEl = document.createElement('span');
      nameEl.className = 'wave-sig-name';
      nameEl.textContent = sig.width > 1 ? `${sig.name}[${sig.width - 1}:0]` : sig.name;
      nameEl.title = nameEl.textContent;

      const valEl = document.createElement('span');
      valEl.className = 'wave-sig-val';
      valEl.textContent = '-';

      row.appendChild(cb);
      row.appendChild(dot);
      row.appendChild(nameEl);
      row.appendChild(valEl);
      this._sidebarListEl.appendChild(row);
      this._sidebarValueEls.set(sig.name, valEl);
    }

    this._updateSidebarValues();
  }

  _updateSidebarValues() {
    if (!this._sidebarValueEls.size) return;
    const idx = this.hoverIndex >= 0 ? this.hoverIndex : (this._count - 1);
    const sample = idx >= 0 ? this.getSample(idx) : null;

    for (const sig of this._signals) {
      const el = this._sidebarValueEls.get(sig.name);
      if (!el) continue;
      if (!sample || !sample.signals[sig.name]) {
        el.textContent = '-';
        el.className = 'wave-sig-val';
        continue;
      }
      const sv = sample.signals[sig.name];
      const formatted = _wvFormatValue(sv, this.radix);
      el.textContent = formatted;
      el.title = formatted;
      if (sv.xMask !== 0n) {
        el.className = 'wave-sig-val val-x';
      } else if (sv.zMask !== 0n) {
        el.className = 'wave-sig-val val-z';
      } else {
        el.className = 'wave-sig-val';
      }
    }
  }

  _updateStatusText() {
    if (!this._statusEl) return;
    if (this.hoverIndex >= 0) {
      const s = this.getSample(this.hoverIndex);
      if (s) {
        this._statusEl.textContent = (this.timeMode && typeof s.time === 'number')
          ? t('wave.cursorTimeInfo', { time: s.time, sample: s.index })
          : t('wave.cursorInfo', { sample: s.index, cycle: s.cycle });
        return;
      }
    }
    if (this.timeMode && this._count > 0) {
      const last = this.getSample(this._count - 1);
      if (last && typeof last.time === 'number') {
        this._statusEl.textContent = t('wave.timeSpanInfo', {
          endTime: last.time,
          count: this._count,
        });
        return;
      }
    }
    this._statusEl.textContent = t('wave.samplesInfo', {
      count: this._count,
      cap: this.capacity,
    });
  }

  // ==========================================================================
  // HiDPI Canvas Drawing
  // ==========================================================================

  render() {
    if (!this._canvas || !this._ctx || !this._canvasWrapEl) return;

    this._updateSidebarValues();
    this._updateStatusText();

    const visibleSignals = this._signals.filter((s) => s.visible);
    const wrapW = Math.max(240, this._canvasWrapEl.clientWidth);
    const wrapH = Math.max(120, this._canvasWrapEl.clientHeight);
    const neededH = Math.max(wrapH, _WV_RULER_H + visibleSignals.length * _WV_ROW_H + 6);

    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) ? window.devicePixelRatio : 1;
    const pixelW = Math.round(wrapW * dpr);
    const pixelH = Math.round(neededH * dpr);

    if (this._canvas.width !== pixelW || this._canvas.height !== pixelH) {
      this._canvas.width = pixelW;
      this._canvas.height = pixelH;
      this._canvas.style.width = `${wrapW}px`;
      this._canvas.style.height = `${neededH}px`;
    }

    const ctx = this._ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Clear full background
    ctx.fillStyle = _WV_COLORS.bg;
    ctx.fillRect(0, 0, wrapW, neededH);

    // Empty state
    if (this._count === 0) {
      this._drawRuler(ctx, wrapW);
      ctx.fillStyle = _WV_COLORS.textMuted;
      ctx.font = '12px Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(t('wave.empty'), wrapW / 2, wrapH / 2 + 6);
      return;
    }

    if (this.autoFollow) {
      this.viewStart = this._getMaxViewStart();
    }

    const traceW = Math.max(1, wrapW - _WV_LABEL_W);
    const firstVis = Math.max(0, Math.floor(this.viewStart) - 1);
    const lastVis = Math.min(this._count - 1, Math.ceil(this.viewStart + traceW / this.pxPerSample) + 1);

    // Draw vertical grid lines
    const minTickPx = 44;
    const stepSamples = Math.max(1, Math.ceil(minTickPx / this.pxPerSample));
    const firstTick = Math.floor(firstVis / stepSamples) * stepSamples;

    ctx.strokeStyle = _WV_COLORS.grid;
    ctx.lineWidth = 1;
    for (let sIdx = firstTick; sIdx <= lastVis + 1; sIdx += stepSamples) {
      const x = _WV_LABEL_W + (sIdx - this.viewStart) * this.pxPerSample;
      if (x < _WV_LABEL_W || x > wrapW) continue;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, _WV_RULER_H);
      ctx.lineTo(Math.round(x) + 0.5, neededH);
      ctx.stroke();
    }

    // Hover sample highlight band
    if (this.hoverIndex >= 0 && this.hoverIndex < this._count) {
      const hx = _WV_LABEL_W + (this.hoverIndex - this.viewStart) * this.pxPerSample;
      if (hx + this.pxPerSample >= _WV_LABEL_W && hx <= wrapW) {
        ctx.fillStyle = _WV_COLORS.cursorBand;
        ctx.fillRect(Math.max(_WV_LABEL_W, hx), _WV_RULER_H, this.pxPerSample, neededH - _WV_RULER_H);
      }
    }

    // Draw each visible signal trace (clipped to trace area)
    ctx.save();
    ctx.beginPath();
    ctx.rect(_WV_LABEL_W, _WV_RULER_H, traceW, neededH - _WV_RULER_H);
    ctx.clip();

    visibleSignals.forEach((sig, rowIdx) => {
      const yTop = _WV_RULER_H + rowIdx * _WV_ROW_H;
      // Row separator
      ctx.strokeStyle = _WV_COLORS.rowBorder;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(_WV_LABEL_W, yTop + _WV_ROW_H - 0.5);
      ctx.lineTo(wrapW, yTop + _WV_ROW_H - 0.5);
      ctx.stroke();

      if (sig.width === 1) {
        this._drawSingleBitTrace(ctx, sig, yTop, firstVis, lastVis);
      } else {
        this._drawBusTrace(ctx, sig, yTop, firstVis, lastVis);
      }
    });
    ctx.restore();

    // Left sticky trace-name gutter on canvas
    ctx.fillStyle = _WV_COLORS.labelBg;
    ctx.fillRect(0, _WV_RULER_H, _WV_LABEL_W, neededH - _WV_RULER_H);
    ctx.strokeStyle = '#1E2D45';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(_WV_LABEL_W - 0.5, 0);
    ctx.lineTo(_WV_LABEL_W - 0.5, neededH);
    ctx.stroke();

    ctx.font = '11px Consolas, monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    visibleSignals.forEach((sig, rowIdx) => {
      const yTop = _WV_RULER_H + rowIdx * _WV_ROW_H;
      const yMid = yTop + _WV_ROW_H / 2;

      ctx.strokeStyle = _WV_COLORS.rowBorder;
      ctx.beginPath();
      ctx.moveTo(0, yTop + _WV_ROW_H - 0.5);
      ctx.lineTo(_WV_LABEL_W, yTop + _WV_ROW_H - 0.5);
      ctx.stroke();

      ctx.fillStyle = this._signalColor(sig);
      const label = sig.width > 1 ? `${sig.name}[${sig.width - 1}:0]` : sig.name;
      const clippedLabel = label.length > 13 ? `${label.slice(0, 12)}…` : label;
      ctx.fillText(clippedLabel, 8, yMid);
    });

    // Top time/cycle ruler
    this._drawRuler(ctx, wrapW, firstTick, lastVis, stepSamples);

    // Interactive vertical hairline cursor
    if (this.hoverIndex >= 0 && this.hoverIndex < this._count) {
      const sample = this.getSample(this.hoverIndex);
      const cx = _WV_LABEL_W + (this.hoverIndex - this.viewStart + 0.5) * this.pxPerSample;
      if (cx >= _WV_LABEL_W && cx <= wrapW) {
        ctx.save();
        ctx.strokeStyle = _WV_COLORS.cursor;
        ctx.lineWidth = 1.2;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(Math.round(cx) + 0.5, _WV_RULER_H);
        ctx.lineTo(Math.round(cx) + 0.5, neededH);
        ctx.stroke();
        ctx.setLineDash([]);

        // Ruler cursor pill showing exact time (ns) or cycle & sample
        if (sample) {
          const pillText = (this.timeMode && typeof sample.time === 'number')
            ? `${sample.time}ns (#${sample.index})`
            : `C${sample.cycle} (#${sample.index})`;
          ctx.font = 'bold 10px Consolas, monospace';
          const tw = ctx.measureText(pillText).width + 10;
          const px = Math.max(_WV_LABEL_W + 2, Math.min(wrapW - tw - 2, cx - tw / 2));
          ctx.fillStyle = '#0D111D';
          ctx.strokeStyle = _WV_COLORS.cursor;
          ctx.lineWidth = 1;
          ctx.fillRect(px, 3, tw, _WV_RULER_H - 6);
          ctx.strokeRect(px + 0.5, 3.5, tw - 1, _WV_RULER_H - 7);
          ctx.fillStyle = _WV_COLORS.cursor;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(pillText, px + tw / 2, _WV_RULER_H / 2);
        }
        ctx.restore();
      }
    }
  }

  _drawRuler(ctx, width, firstTick = 0, lastVis = -1, stepSamples = 1) {
    ctx.fillStyle = _WV_COLORS.rulerBg;
    ctx.fillRect(0, 0, width, _WV_RULER_H);
    ctx.strokeStyle = '#1E2D45';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, _WV_RULER_H - 0.5);
    ctx.lineTo(width, _WV_RULER_H - 0.5);
    ctx.stroke();

    ctx.fillStyle = _WV_COLORS.textMuted;
    ctx.font = '10px Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('SIGNAL', 8, _WV_RULER_H / 2);

    for (let sIdx = firstTick; sIdx <= lastVis; sIdx += stepSamples) {
      const sample = this.getSample(sIdx);
      if (!sample) continue;
      const x = _WV_LABEL_W + (sIdx - this.viewStart) * this.pxPerSample;
      if (x < _WV_LABEL_W - 2 || x > width - 16) continue;
      ctx.strokeStyle = '#2A3F61';
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, _WV_RULER_H - 5);
      ctx.lineTo(Math.round(x) + 0.5, _WV_RULER_H);
      ctx.stroke();
      ctx.fillStyle = _WV_COLORS.textMuted;
      const tickLabel = (this.timeMode && typeof sample.time === 'number')
        ? `${sample.time}ns`
        : `C${sample.cycle}`;
      ctx.fillText(tickLabel, x + 3, _WV_RULER_H / 2);
    }
  }

  _drawSingleBitTrace(ctx, sig, yTop, firstVis, lastVis) {
    const yHi = yTop + 6;
    const yLo = yTop + _WV_ROW_H - 6;
    const yMid = (yHi + yLo) / 2;
    const color = this._signalColor(sig);

    let prevKnownY = null;

    for (let i = firstVis; i <= lastVis; i++) {
      const sample = this.getSample(i);
      if (!sample) continue;
      const sv = sample.signals[sig.name];
      if (!sv) continue;

      const x0 = _WV_LABEL_W + (i - this.viewStart) * this.pxPerSample;
      const x1 = x0 + this.pxPerSample;

      if (sv.xMask !== 0n) {
        // 4-state X: red diagonal hatching block
        ctx.fillStyle = this._hatchPattern || _WV_COLORS.xBg;
        ctx.fillRect(x0, yHi, this.pxPerSample, yLo - yHi);
        ctx.strokeStyle = _WV_COLORS.xStroke;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x0, yHi);
        ctx.lineTo(x1, yHi);
        ctx.moveTo(x0, yLo);
        ctx.lineTo(x1, yLo);
        ctx.stroke();
        prevKnownY = null;
      } else if (sv.zMask !== 0n) {
        // 4-state Z: orange center line
        ctx.strokeStyle = _WV_COLORS.zStroke;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(x0, yMid);
        ctx.lineTo(x1, yMid);
        ctx.stroke();
        prevKnownY = null;
      } else {
        const y = (sv.val & 1n) === 1n ? yHi : yLo;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        if (prevKnownY !== null && prevKnownY !== y) {
          ctx.moveTo(x0, prevKnownY);
          ctx.lineTo(x0, y);
        } else {
          ctx.moveTo(x0, y);
        }
        ctx.lineTo(x1, y);
        ctx.stroke();
        prevKnownY = y;
      }
    }
  }

  _drawBusTrace(ctx, sig, yTop, firstVis, lastVis) {
    const yHi = yTop + 5;
    const yLo = yTop + _WV_ROW_H - 5;
    const yMid = (yHi + yLo) / 2;
    const strokeColor = this._signalColor(sig);
    const fillColor = (sig.dir === 'input' || sig.dir === 'output' || sig.dir === 'inout')
      ? _WV_COLORS.portFill
      : _WV_COLORS.internalFill;

    // Group consecutive equal samples into contiguous stable bus runs
    let runStart = firstVis;
    while (runStart <= lastVis) {
      const startSample = this.getSample(runStart);
      const startVal = startSample?.signals[sig.name];
      if (!startVal) {
        runStart++;
        continue;
      }

      let runEnd = runStart + 1;
      while (runEnd <= lastVis) {
        const nextVal = this.getSample(runEnd)?.signals[sig.name];
        if (!nextVal || !_wvSampleEq(startVal, nextVal)) break;
        runEnd++;
      }

      const x0 = _WV_LABEL_W + (runStart - this.viewStart) * this.pxPerSample;
      const x1 = _WV_LABEL_W + (runEnd - this.viewStart) * this.pxPerSample;
      const runPx = x1 - x0;

      const fullMask = _wvMask(startVal.width);
      const hasX = startVal.xMask !== 0n;
      const isAllZ = !hasX && startVal.zMask === fullMask;

      if (isAllZ) {
        ctx.strokeStyle = _WV_COLORS.zStroke;
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(x0, yMid);
        ctx.lineTo(x1, yMid);
        ctx.stroke();
      } else {
        const ch = Math.min(4.5, runPx * 0.25);
        ctx.beginPath();
        ctx.moveTo(x0, yMid);
        ctx.lineTo(x0 + ch, yHi);
        ctx.lineTo(x1 - ch, yHi);
        ctx.lineTo(x1, yMid);
        ctx.lineTo(x1 - ch, yLo);
        ctx.lineTo(x0 + ch, yLo);
        ctx.closePath();

        ctx.fillStyle = hasX ? (this._hatchPattern || _WV_COLORS.xBg) : fillColor;
        ctx.fill();
        ctx.strokeStyle = hasX ? _WV_COLORS.xStroke : strokeColor;
        ctx.lineWidth = 1.3;
        ctx.stroke();

        // Draw formatted bus value inside hexagon if enough room
        if (runPx >= 22) {
          const text = _wvFormatValue(startVal, this.radix);
          ctx.font = '10.5px Consolas, monospace';
          ctx.fillStyle = hasX ? '#FCA5A5' : _WV_COLORS.text;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';

          const availW = runPx - ch * 2 - 6;
          let drawText = text;
          if (ctx.measureText(drawText).width > availW) {
            while (drawText.length > 1 && ctx.measureText(`${drawText}…`).width > availW) {
              drawText = drawText.slice(0, -1);
            }
            drawText = drawText.length > 0 ? `${drawText}…` : '';
          }
          if (drawText) {
            ctx.fillText(drawText, (x0 + x1) / 2, yMid + 0.5);
          }
        }
      }

      runStart = runEnd;
    }
  }
}
