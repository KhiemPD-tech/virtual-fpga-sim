/**
 * Phase B (v2.5) — Generalized Data-Driven Inline SVG Virtual FPGA Board
 * Renders any registered board profile (Altera DE2, Digilent Basys 3, HDLab Edu)
 * strictly using inline SVG + Dark Navy / PCB Green / Electric Cyan palette.
 */

import {
  DEFAULT_BOARD_ID,
  getBoardProfile,
} from '../boards/registry.js';

const _BRD_SVG_NS = 'http://www.w3.org/2000/svg';

// Retained for v1 API compatibility (DE2 defaults)
export const BOARD_IO_SPEC = Object.freeze({
  SW_WIDTH: 18,
  KEY_WIDTH: 4,
  LEDR_WIDTH: 18,
  LEDG_WIDTH: 9,
  HEX_COUNT: 8,
  HEX_WIDTH: 7,
});

// 7 distinct chamfered SVG polygon segments (bit [0]=a .. bit [6]=g) inside a 48x74 cell
const _BRD_SEG_POLYGONS = [
  { bit: 0, points: '10,8 13,5 35,5 38,8 35,11 13,11' },
  { bit: 1, points: '39,9 42,12 42,33 39,36 36,33 36,12' },
  { bit: 2, points: '39,38 42,41 42,62 39,65 36,62 36,41' },
  { bit: 3, points: '10,66 13,63 35,63 38,66 35,69 13,69' },
  { bit: 4, points: '9,38 12,41 12,62 9,65 6,62 6,41' },
  { bit: 5, points: '9,9 12,12 12,33 9,36 6,33 6,12' },
  { bit: 6, points: '10,37 13,34 35,34 38,37 35,40 13,40' },
];

const _BRD_BOUNCE_OFFSETS_MS = [0, 6, 13, 19, 26];

const _BRD_LED_PALETTE = {
  red:   { onFill: 'url(#fpga-led-red-on)',   onStroke: '#FCA5A5', glow: 'url(#fpga-glow-red)',   offFill: '#381316', offStroke: '#7F1D1D' },
  green: { onFill: 'url(#fpga-led-green-on)', onStroke: '#86EFAC', glow: 'url(#fpga-glow-green)', offFill: '#0F2D1D', offStroke: '#14532D' },
  cyan:  { onFill: 'url(#fpga-led-clk-on)',   onStroke: '#7DD3FC', glow: 'url(#fpga-glow-cyan)',  offFill: '#0E2438', offStroke: '#1E3A5F' },
};

function _brdSvg(tag, attrs = {}, text = null) {
  const node = document.createElementNS(_BRD_SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    node.setAttribute(k, String(v));
  }
  if (text !== null) node.textContent = text;
  return node;
}

function _brdNormalizeLogic(input, width, defaultVal = 0n) {
  if (input === undefined || input === null) {
    return { val: defaultVal, xMask: 0n, zMask: 0n, width };
  }
  if (typeof input === 'object' && 'val' in input) {
    return {
      val: BigInt(input.val ?? 0n),
      xMask: BigInt(input.xMask ?? 0n),
      zMask: BigInt(input.zMask ?? 0n),
      width: input.width ?? width,
    };
  }
  return { val: BigInt(input), xMask: 0n, zMask: 0n, width };
}

export class FpgaBoard {
  /**
   * @param {HTMLElement|null} container
   * @param {{ boardId?: string, onInputChange?: (name: string, value: bigint) => void, simulateBounce?: boolean }} [options={}]
   */
  constructor(container, options = {}) {
    this.container = container;
    this.onInputChange = typeof options.onInputChange === 'function' ? options.onInputChange : null;
    this.simulateBounce = Boolean(options.simulateBounce);
    this.profile = getBoardProfile(options.boardId || DEFAULT_BOARD_ID);

    this.swState = 0n;
    this.keyState = 0xFn;
    this.namedBtnState = {};

    this._btnPhysicallyDown = new Map();
    this._bounceTimers = new Map();
    this._muxDigits = [];

    this._hexSegs = [];
    this._hexDps = [];
    this._ledBankEls = new Map();
    this._swEls = [];
    this._btnEls = new Map();
    this._headerPinEls = new Map();
    this._clkLedEl = null;

    this._boundKeyDown = this._handleKeyDown.bind(this);
    this._boundWindowBlur = this._releaseAllButtons.bind(this);
    this._listenersAttached = false;

    this._initInputDefaults();
    if (this.container && typeof document !== 'undefined') {
      this.mount();
    }
  }

  _initInputDefaults() {
    this._clearAllBounceTimers();
    this._btnPhysicallyDown.clear();
    this.swState = 0n;
    this.namedBtnState = {};

    const btns = this.profile.io.buttons;
    if (btns && btns.mode === 'vector') {
      const mask = (1n << BigInt(btns.width)) - 1n;
      this.keyState = btns.activeLow ? mask : 0n;
    } else if (btns && btns.mode === 'named') {
      this.keyState = 0n;
      const idleBit = btns.activeLow ? 1n : 0n;
      for (const item of btns.items) {
        this.namedBtnState[item.port] = idleBit;
      }
    }

    const segSpec = this.profile.io.sevenSeg;
    this._muxDigits = [];
    if (segSpec && segSpec.mode === 'multiplexed') {
      for (let i = 0; i < segSpec.count; i++) {
        this._muxDigits.push({ val: 0x7Fn, xMask: 0n, zMask: 0n, dp: 1, ttl: 0 });
      }
    }
  }

  getBoardProfile() {
    return this.profile;
  }

  /**
   * Switch active board profile dynamically and re-render the SVG board.
   * @param {string|object} boardOrId
   */
  setBoard(boardOrId) {
    this.profile = typeof boardOrId === 'string' ? getBoardProfile(boardOrId) : (boardOrId || getBoardProfile());
    this._initInputDefaults();
    if (this.container && typeof document !== 'undefined') {
      this.mount();
    }
  }

  mount() {
    if (!this.container || typeof document === 'undefined') return;
    const p = this.profile;
    const vb = p.viewBox;

    this._hexSegs = [];
    this._hexDps = [];
    this._ledBankEls.clear();
    this._swEls = [];
    this._btnEls.clear();
    this._headerPinEls.clear();
    this._clkLedEl = null;

    const svg = _brdSvg('svg', {
      viewBox: `0 0 ${vb.width} ${vb.height}`,
      class: 'board-svg',
      role: 'img',
      'aria-label': `Virtual ${p.defaultName} FPGA Board`,
    });

    this._buildDefs(svg, p);
    this._buildPcbBase(svg, p);
    this._buildSevenSegBank(svg, p);
    this._buildHeaders(svg, p);
    this._buildFpgaChip(svg, p);
    this._buildClockLed(svg, p);
    this._buildLedBanks(svg, p);
    this._buildSwitches(svg, p);
    this._buildButtons(svg, p);

    this.container.innerHTML = '';
    this.container.appendChild(svg);

    this._refreshAllSwitches();
    this._refreshAllButtons();
    this.updateOutputs({});

    if (!this._listenersAttached && typeof window !== 'undefined') {
      window.addEventListener('keydown', this._boundKeyDown);
      window.addEventListener('blur', this._boundWindowBlur);
      this._listenersAttached = true;
    }
  }

  destroy() {
    this._clearAllBounceTimers();
    if (this._listenersAttached && typeof window !== 'undefined') {
      window.removeEventListener('keydown', this._boundKeyDown);
      window.removeEventListener('blur', this._boundWindowBlur);
      this._listenersAttached = false;
    }
  }

  _buildDefs(svg, p) {
    const defs = _brdSvg('defs');

    const pcbGrad = _brdSvg('linearGradient', { id: 'fpga-pcb-grad', x1: '0%', y1: '0%', x2: '100%', y2: '100%' });
    pcbGrad.appendChild(_brdSvg('stop', { offset: '0%', 'stop-color': p.pcb.base }));
    pcbGrad.appendChild(_brdSvg('stop', { offset: '100%', 'stop-color': p.pcb.dark }));
    defs.appendChild(pcbGrad);

    const tracePat = _brdSvg('pattern', { id: 'fpga-copper-grid', width: 28, height: 28, patternUnits: 'userSpaceOnUse' });
    tracePat.appendChild(_brdSvg('path', {
      d: 'M0 14 H10 L14 10 V0 M14 28 V18 L18 14 H28',
      fill: 'none', stroke: p.pcb.trace, 'stroke-width': 1, opacity: 0.42,
    }));
    defs.appendChild(tracePat);

    const addRadial = (id, c0, c1, c2) => {
      const g = _brdSvg('radialGradient', { id, cx: '38%', cy: '35%', r: '65%' });
      g.appendChild(_brdSvg('stop', { offset: '0%', 'stop-color': c0 }));
      g.appendChild(_brdSvg('stop', { offset: '45%', 'stop-color': c1 }));
      g.appendChild(_brdSvg('stop', { offset: '100%', 'stop-color': c2 }));
      defs.appendChild(g);
    };
    addRadial('fpga-led-red-on', '#FECACA', '#EF4444', '#B91C1C');
    addRadial('fpga-led-green-on', '#DCFCE7', '#22C55E', '#15803D');
    addRadial('fpga-led-clk-on', '#E0F2FE', '#3B9ED8', '#0060A2');

    const addGlow = (id, stdDev) => {
      const f = _brdSvg('filter', { id, x: '-60%', y: '-60%', width: '220%', height: '220%' });
      f.appendChild(_brdSvg('feGaussianBlur', { stdDeviation: stdDev, result: 'blur' }));
      const merge = _brdSvg('feMerge');
      merge.appendChild(_brdSvg('feMergeNode', { in: 'blur' }));
      merge.appendChild(_brdSvg('feMergeNode', { in: 'SourceGraphic' }));
      f.appendChild(merge);
      defs.appendChild(f);
    };
    addGlow('fpga-glow-red', 2.6);
    addGlow('fpga-glow-green', 2.4);
    addGlow('fpga-glow-cyan', 2.8);

    svg.appendChild(defs);
  }

  _buildPcbBase(svg, p) {
    const { width, height } = p.viewBox;
    svg.appendChild(_brdSvg('rect', {
      x: 6, y: 6, width: width - 12, height: height - 12, rx: 14,
      fill: 'url(#fpga-pcb-grad)', stroke: p.pcb.trace, 'stroke-width': 2.5,
    }));
    svg.appendChild(_brdSvg('rect', {
      x: 10, y: 10, width: width - 20, height: height - 20, rx: 11,
      fill: 'url(#fpga-copper-grid)',
    }));
    svg.appendChild(_brdSvg('rect', {
      x: 14, y: 14, width: width - 28, height: height - 28, rx: 8,
      fill: 'none', stroke: p.pcb.silk, 'stroke-width': 0.8, opacity: 0.25,
    }));

    // Corner mounting holes
    for (const [cx, cy] of [[24, 24], [width - 24, 24], [24, height - 24], [width - 24, height - 24]]) {
      svg.appendChild(_brdSvg('circle', { cx, cy, r: 7, fill: '#D97706', stroke: '#FBBF24', 'stroke-width': 1 }));
      svg.appendChild(_brdSvg('circle', { cx, cy, r: 4, fill: '#0D111D' }));
    }

    // Silkscreen board header title at bottom-right/top-right
    svg.appendChild(_brdSvg('text', {
      x: width - 38, y: height - 20, 'text-anchor': 'end',
      fill: p.pcb.silk, 'font-family': 'monospace', 'font-size': 10, 'font-weight': 'bold', opacity: 0.82,
    }, `${p.silkscreenTitle}  |  ${p.silkscreenSub}`));
  }

  _buildFpgaChip(svg, p) {
    const { chipX: x, chipY: y, chipW: w, chipH: h, chipLabel, chipSub } = p.pcb;
    const g = _brdSvg('g');

    // Gull-wing QFP pins on all 4 sides
    const pinCount = 10;
    for (let i = 0; i < pinCount; i++) {
      const px = x + 10 + (i * (w - 20)) / (pinCount - 1);
      g.appendChild(_brdSvg('rect', { x: px - 2, y: y - 7, width: 4, height: 7, fill: '#94A3B8' }));
      g.appendChild(_brdSvg('rect', { x: px - 2, y: y + h, width: 4, height: 7, fill: '#94A3B8' }));
      const py = y + 10 + (i * (h - 20)) / (pinCount - 1);
      g.appendChild(_brdSvg('rect', { x: x - 7, y: py - 2, width: 7, height: 4, fill: '#94A3B8' }));
      g.appendChild(_brdSvg('rect', { x: x + w, y: py - 2, width: 7, height: 4, fill: '#94A3B8' }));
    }

    g.appendChild(_brdSvg('rect', {
      x, y, width: w, height: h, rx: 5,
      fill: '#0F172A', stroke: '#334155', 'stroke-width': 2,
    }));
    g.appendChild(_brdSvg('rect', {
      x: x + 6, y: y + 6, width: w - 12, height: h - 12, rx: 3,
      fill: '#131A2B', stroke: '#1E2D45', 'stroke-width': 1,
    }));
    g.appendChild(_brdSvg('circle', { cx: x + 14, cy: y + 14, r: 2.6, fill: '#64748B' }));
    g.appendChild(_brdSvg('text', {
      x: x + w / 2, y: y + h / 2 - 4, 'text-anchor': 'middle',
      fill: '#E2E8F0', 'font-family': 'monospace', 'font-size': 11.5, 'font-weight': 'bold',
    }, chipLabel));
    g.appendChild(_brdSvg('text', {
      x: x + w / 2, y: y + h / 2 + 12, 'text-anchor': 'middle',
      fill: '#3B9ED8', 'font-family': 'monospace', 'font-size': 8.5,
    }, chipSub));
    svg.appendChild(g);
  }

  _buildClockLed(svg, p) {
    const cx = p.pcb.clkX;
    const cy = p.pcb.clkY;
    svg.appendChild(_brdSvg('rect', {
      x: cx - 34, y: cy - 36, width: 68, height: 78, rx: 7,
      fill: '#0D111D', stroke: '#1E2D45', 'stroke-width': 1.5,
    }));
    svg.appendChild(_brdSvg('text', {
      x: cx, y: cy - 20, 'text-anchor': 'middle',
      fill: p.pcb.silk, 'font-family': 'monospace', 'font-size': 9.5, 'font-weight': 'bold',
    }, p.clock.port));
    const led = _brdSvg('circle', {
      cx, cy: cy + 2, r: 10, fill: '#0E2438', stroke: '#3B9ED8', 'stroke-width': 1.5,
    });
    svg.appendChild(led);
    svg.appendChild(_brdSvg('text', {
      x: cx, y: cy + 28, 'text-anchor': 'middle',
      fill: '#94A3B8', 'font-family': 'monospace', 'font-size': 8.5,
    }, p.clock.freqLabel));
    this._clkLedEl = led;
  }

  _buildSevenSegBank(svg, p) {
    const spec = p.io.sevenSeg;
    if (!spec) return;
    const g = _brdSvg('g');

    g.appendChild(_brdSvg('text', {
      x: spec.x, y: spec.y - 6, fill: p.pcb.silk,
      'font-family': 'monospace', 'font-size': 9.5, 'font-weight': 'bold',
    }, spec.silkLabel || '7-SEGMENT'));

    for (let visualPos = 0; visualPos < spec.count; visualPos++) {
      // Display MSB digit on the left (HEX7..HEX0 or AN3..AN0)
      const digitIdx = spec.count - 1 - visualPos;
      const gapOffset = spec.groupSize && visualPos >= spec.groupSize ? (spec.groupGap || 0) : 0;
      const dx = spec.x + visualPos * spec.spacing + gapOffset;
      const dy = spec.y + 2;

      const cell = _brdSvg('g', { transform: `translate(${dx}, ${dy})` });
      cell.appendChild(_brdSvg('rect', {
        x: 0, y: 0, width: 50, height: 76, rx: 5,
        fill: '#0A0F1A', stroke: '#1E2D45', 'stroke-width': 1.5,
      }));

      const segPolys = [];
      for (const seg of _BRD_SEG_POLYGONS) {
        const poly = _brdSvg('polygon', {
          points: seg.points, fill: '#1D2636', stroke: '#0D111D', 'stroke-width': 0.5,
        });
        cell.appendChild(poly);
        segPolys[seg.bit] = poly;
      }

      if (spec.mode === 'multiplexed') {
        const dpEl = _brdSvg('circle', { cx: 45, cy: 67, r: 2.3, fill: '#1D2636' });
        cell.appendChild(dpEl);
        this._hexDps[digitIdx] = dpEl;
      }

      const labelText = spec.mode === 'multiplexed' ? `AN${digitIdx}` : `${spec.portPrefix}${digitIdx}`;
      cell.appendChild(_brdSvg('text', {
        x: 25, y: 90, 'text-anchor': 'middle',
        fill: p.pcb.silk, 'font-family': 'monospace', 'font-size': 9.5, 'font-weight': 'bold',
      }, labelText));

      g.appendChild(cell);
      this._hexSegs[digitIdx] = segPolys;
    }

    svg.appendChild(g);
  }

  _buildHeaders(svg, p) {
    for (const hdr of p.io.headers || []) {
      const cols = hdr.cols || hdr.width;
      const rows = Math.ceil(hdr.width / cols);
      const pinPitch = hdr.namedPins ? 64 : 20;
      const boxW = cols * pinPitch + 14;
      const boxH = rows * 22 + 24;

      const g = _brdSvg('g');
      g.appendChild(_brdSvg('text', {
        x: hdr.x, y: hdr.y - 5, fill: p.pcb.silk,
        'font-family': 'monospace', 'font-size': 9, 'font-weight': 'bold',
      }, hdr.silkLabel || hdr.name));
      g.appendChild(_brdSvg('rect', {
        x: hdr.x, y: hdr.y, width: boxW, height: boxH, rx: 5,
        fill: '#0A0F1A', stroke: '#2A3F61', 'stroke-width': 1.2,
      }));

      for (let i = 0; i < hdr.width; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const px = hdr.x + 7 + col * pinPitch + pinPitch / 2;
        const py = hdr.y + 15 + row * 22;

        g.appendChild(_brdSvg('rect', {
          x: px - 5, y: py - 5, width: 10, height: 10, rx: 2,
          fill: '#131A2B', stroke: '#D97706', 'stroke-width': 1,
        }));
        const dot = _brdSvg('circle', { cx: px, cy: py, r: 2.6, fill: '#334155' });
        g.appendChild(dot);

        const pinLabel = hdr.namedPins ? hdr.namedPins[i] : String(i);
        g.appendChild(_brdSvg('text', {
          x: px, y: py + 14, 'text-anchor': 'middle',
          fill: '#94A3B8', 'font-family': 'monospace', 'font-size': hdr.namedPins ? 7.5 : 6.8,
        }, pinLabel));

        const key = hdr.namedPins ? hdr.namedPins[i] : `${hdr.port}[${i}]`;
        this._headerPinEls.set(key, { dot, hdr, bit: i, namedPin: hdr.namedPins ? hdr.namedPins[i] : null });
      }
      svg.appendChild(g);
    }
  }

  _buildLedBanks(svg, p) {
    for (const bank of p.io.ledBanks || []) {
      const pal = _BRD_LED_PALETTE[bank.color] || _BRD_LED_PALETTE.red;
      const g = _brdSvg('g');
      const bankW = bank.width * bank.spacing + 6;

      g.appendChild(_brdSvg('text', {
        x: bank.x, y: bank.y - 10, fill: p.pcb.silk,
        'font-family': 'monospace', 'font-size': 9.5, 'font-weight': 'bold',
      }, bank.silkLabel || `${bank.port}[${bank.width - 1}:0]`));
      g.appendChild(_brdSvg('rect', {
        x: bank.x - 4, y: bank.y - 4, width: bankW, height: 42, rx: 6,
        fill: '#0B101C', stroke: '#1E2D45', 'stroke-width': 1.2,
      }));

      const els = [];
      for (let visualIdx = 0; visualIdx < bank.width; visualIdx++) {
        // MSB on left, LSB on right (hardware board convention)
        const bit = bank.width - 1 - visualIdx;
        const cx = bank.x + visualIdx * bank.spacing + bank.spacing / 2;
        const cy = bank.y + 11;

        const circle = _brdSvg('circle', {
          cx, cy, r: bank.spacing >= 34 ? 7.5 : 6.5,
          fill: pal.offFill, stroke: pal.offStroke, 'stroke-width': 1.2,
        });
        const title = _brdSvg('title', {}, `${bank.port}[${bit}] = 0`);
        circle.appendChild(title);
        g.appendChild(circle);

        g.appendChild(_brdSvg('text', {
          x: cx, y: cy + 20, 'text-anchor': 'middle',
          fill: '#94A3B8', 'font-family': 'monospace', 'font-size': 7.8,
        }, `${bank.labelPrefix}${bit}`));

        els[bit] = { circle, title, pal };
      }

      this._ledBankEls.set(bank.id, { bank, els });
      svg.appendChild(g);
    }
  }

  _buildSwitches(svg, p) {
    const sw = p.io.switches;
    if (!sw) return;
    const g = _brdSvg('g');

    g.appendChild(_brdSvg('text', {
      x: sw.x, y: sw.y - 10, fill: p.pcb.silk,
      'font-family': 'monospace', 'font-size': 9.5, 'font-weight': 'bold',
    }, sw.silkLabel || `${sw.port}[${sw.width - 1}:0]`));

    for (let visualIdx = 0; visualIdx < sw.width; visualIdx++) {
      const bit = sw.width - 1 - visualIdx;
      const cx = sw.x + visualIdx * sw.spacing + sw.spacing / 2;
      const y = sw.y;

      const sg = _brdSvg('g', {
        class: 'board-sw-group',
        role: 'switch',
        tabindex: 0,
        'aria-checked': 'false',
        'aria-label': `${sw.labelPrefix}${bit}`,
      });
      sg.appendChild(_brdSvg('title', {}, `${sw.labelPrefix}[${bit}]`));
      sg.appendChild(_brdSvg('rect', {
        x: cx - 11, y, width: 22, height: 54, rx: 4,
        fill: '#0A0F1A', stroke: '#2A3F61', 'stroke-width': 1.3,
      }));
      const indicator = _brdSvg('rect', {
        x: cx - 6, y: y + 5, width: 12, height: 4, rx: 1.5, fill: '#1E2D45',
      });
      sg.appendChild(indicator);

      const knob = _brdSvg('rect', {
        class: 'board-sw-knob',
        x: cx - 8, y: y + 32, width: 16, height: 17, rx: 3,
        fill: '#64748B', stroke: '#94A3B8', 'stroke-width': 1.1,
      });
      sg.appendChild(knob);

      const stateText = _brdSvg('text', {
        x: cx, y: y + 67, 'text-anchor': 'middle',
        fill: '#94A3B8', 'font-family': 'monospace', 'font-size': 8.5, 'font-weight': 'bold',
      }, '0');
      sg.appendChild(stateText);

      sg.appendChild(_brdSvg('text', {
        x: cx, y: y + 79, 'text-anchor': 'middle',
        fill: p.pcb.silk, 'font-family': 'monospace', 'font-size': 8,
      }, `${sw.labelPrefix}${bit}`));

      sg.addEventListener('click', () => this.toggleSwitch(bit));
      sg.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          this.toggleSwitch(bit);
        }
      });

      g.appendChild(sg);
      this._swEls[bit] = { group: sg, knob, indicator, stateText };
    }

    svg.appendChild(g);
  }

  _buildButtons(svg, p) {
    const btns = p.io.buttons;
    if (!btns) return;

    const addButtonWidget = (keyId, cx, cy, label, r = 19) => {
      const g = _brdSvg('g', {
        class: 'board-key-group',
        role: 'button',
        tabindex: 0,
        'aria-pressed': 'false',
        'aria-label': label,
      });
      g.appendChild(_brdSvg('title', {}, `${label} (${btns.activeLow ? 'Active-Low' : 'Active-High'})`));
      g.appendChild(_brdSvg('rect', {
        x: cx - r - 4, y: cy - r - 4, width: (r + 4) * 2, height: (r + 4) * 2, rx: 7,
        fill: '#0A0F1A', stroke: '#2A3F61', 'stroke-width': 1.4,
      }));
      const cap = _brdSvg('circle', {
        class: 'board-key-cap',
        cx, cy, r, fill: '#0060A2', stroke: '#3B9ED8', 'stroke-width': 1.8,
      });
      g.appendChild(cap);

      const valText = _brdSvg('text', {
        x: cx, y: cy + 4, 'text-anchor': 'middle',
        fill: '#E2E8F0', 'font-family': 'monospace', 'font-size': 11, 'font-weight': 'bold',
        'pointer-events': 'none',
      }, btns.activeLow ? '1' : '0');
      g.appendChild(valText);

      g.appendChild(_brdSvg('text', {
        x: cx, y: cy + r + 15, 'text-anchor': 'middle',
        fill: p.pcb.silk, 'font-family': 'monospace', 'font-size': 8.5, 'font-weight': 'bold',
      }, label));

      g.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        try {
          if (typeof g.setPointerCapture === 'function') g.setPointerCapture(e.pointerId);
        } catch {
          // Ignore synthetic pointer capture error
        }
        this._pressButton(keyId);
      });
      const rel = () => this._releaseButton(keyId);
      g.addEventListener('pointerup', rel);
      g.addEventListener('pointerleave', rel);
      g.addEventListener('pointercancel', rel);
      g.addEventListener('lostpointercapture', rel);
      g.addEventListener('keydown', (e) => {
        if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
          e.preventDefault();
          this._pressButton(keyId);
        }
      });
      g.addEventListener('keyup', (e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          this._releaseButton(keyId);
        }
      });

      svg.appendChild(g);
      this._btnEls.set(keyId, { group: g, cap, valText });
    };

    if (btns.mode === 'vector') {
      svg.appendChild(_brdSvg('text', {
        x: btns.x - 16, y: btns.y - 36, fill: p.pcb.silk,
        'font-family': 'monospace', 'font-size': 9.5, 'font-weight': 'bold',
      }, btns.silkLabel || `${btns.port}[${btns.width - 1}:0]`));

      for (let visualIdx = 0; visualIdx < btns.width; visualIdx++) {
        // MSB button on left, LSB (KEY0 / BTN0) on right
        const bit = btns.width - 1 - visualIdx;
        const cx = btns.x + visualIdx * btns.spacing;
        addButtonWidget(bit, cx, btns.y, btns.labels[bit] || `${btns.port}${bit}`, 19);
      }
    } else if (btns.mode === 'named') {
      svg.appendChild(_brdSvg('text', {
        x: btns.cx, y: btns.cy - 84, 'text-anchor': 'middle', fill: p.pcb.silk,
        'font-family': 'monospace', 'font-size': 9.5, 'font-weight': 'bold',
      }, btns.silkLabel || 'PUSH BUTTONS'));

      for (const item of btns.items) {
        addButtonWidget(item.port, btns.cx + item.dx, btns.cy + item.dy, item.label, 16);
      }
    }
  }

  _handleKeyDown(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key < '0' || e.key > '9') return;
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    if (active) {
      const tag = active.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' || active.isContentEditable) return;
    }
    const bitIdx = Number(e.key);
    const swWidth = this.profile.io.switches?.width ?? 0;
    if (bitIdx >= 0 && bitIdx < swWidth) {
      e.preventDefault();
      this.toggleSwitch(bitIdx);
    }
  }

  toggleSwitch(bitIndex) {
    const sw = this.profile.io.switches;
    if (!sw || bitIndex < 0 || bitIndex >= sw.width) return;
    this.swState ^= (1n << BigInt(bitIndex));
    this._updateSwitchVisual(bitIndex);
    if (this.onInputChange) {
      this.onInputChange(sw.port, this.swState);
    }
  }

  _updateSwitchVisual(i) {
    const sw = this._swEls[i];
    if (!sw) return;
    const isOn = ((this.swState >> BigInt(i)) & 1n) === 1n;
    sw.group.setAttribute('aria-checked', isOn ? 'true' : 'false');
    sw.knob.style.transform = isOn ? 'translateY(-22px)' : 'translateY(0px)';
    sw.knob.setAttribute('fill', isOn ? '#3B9ED8' : '#64748B');
    sw.knob.setAttribute('stroke', isOn ? '#7DD3FC' : '#94A3B8');
    sw.indicator.setAttribute('fill', isOn ? '#22C55E' : '#1E2D45');
    sw.stateText.textContent = isOn ? '1' : '0';
    sw.stateText.setAttribute('fill', isOn ? '#3B9ED8' : '#94A3B8');
  }

  _refreshAllSwitches() {
    const swWidth = this.profile.io.switches?.width ?? 0;
    for (let i = 0; i < swWidth; i++) this._updateSwitchVisual(i);
  }

  _clearBounceTimers(keyId) {
    const timers = this._bounceTimers.get(keyId);
    if (!timers) return;
    for (const id of timers) clearTimeout(id);
    timers.length = 0;
  }

  _clearAllBounceTimers() {
    for (const timers of this._bounceTimers.values()) {
      for (const id of timers) clearTimeout(id);
    }
    this._bounceTimers.clear();
  }

  _applyButtonBit(keyId, bitVal) {
    const btns = this.profile.io.buttons;
    if (!btns) return;

    if (btns.mode === 'vector') {
      const mask = 1n << BigInt(keyId);
      if (bitVal === 1n) this.keyState |= mask;
      else this.keyState &= ~mask;
      this._updateButtonVisual(keyId);
      if (this.onInputChange) this.onInputChange(btns.port, this.keyState);
    } else if (btns.mode === 'named') {
      this.namedBtnState[keyId] = bitVal;
      this._updateButtonVisual(keyId);
      if (this.onInputChange) this.onInputChange(keyId, bitVal);
    }
  }

  _triggerButtonTransition(keyId, targetBit) {
    this._clearBounceTimers(keyId);
    if (!this.simulateBounce) {
      this._applyButtonBit(keyId, targetBit);
      return;
    }

    const oppositeBit = targetBit ^ 1n;
    const list = [];
    this._bounceTimers.set(keyId, list);
    _BRD_BOUNCE_OFFSETS_MS.forEach((delayMs, stepIdx) => {
      const bitAtStep = (stepIdx % 2 === 0 || stepIdx === _BRD_BOUNCE_OFFSETS_MS.length - 1)
        ? targetBit
        : oppositeBit;
      if (delayMs === 0) {
        this._applyButtonBit(keyId, bitAtStep);
      } else {
        list.push(setTimeout(() => this._applyButtonBit(keyId, bitAtStep), delayMs));
      }
    });
  }

  _pressButton(keyId) {
    if (this._btnPhysicallyDown.get(keyId)) return;
    this._btnPhysicallyDown.set(keyId, true);
    const targetBit = this.profile.io.buttons?.activeLow ? 0n : 1n;
    this._triggerButtonTransition(keyId, targetBit);
  }

  _releaseButton(keyId) {
    if (!this._btnPhysicallyDown.get(keyId)) return;
    this._btnPhysicallyDown.set(keyId, false);
    const targetBit = this.profile.io.buttons?.activeLow ? 1n : 0n;
    this._triggerButtonTransition(keyId, targetBit);
  }

  _releaseAllButtons() {
    for (const [keyId, isDown] of this._btnPhysicallyDown.entries()) {
      if (isDown) this._releaseButton(keyId);
    }
  }

  _updateButtonVisual(keyId) {
    const el = this._btnEls.get(keyId);
    const btns = this.profile.io.buttons;
    if (!el || !btns) return;

    const rawBit = btns.mode === 'vector'
      ? ((this.keyState >> BigInt(keyId)) & 1n)
      : (this.namedBtnState[keyId] ?? (btns.activeLow ? 1n : 0n));
    const isPressed = btns.activeLow ? rawBit === 0n : rawBit === 1n;

    el.group.setAttribute('aria-pressed', isPressed ? 'true' : 'false');
    el.cap.setAttribute('fill', isPressed ? '#3B9ED8' : '#0060A2');
    el.cap.setAttribute('stroke', isPressed ? '#BAE6FD' : '#3B9ED8');
    el.cap.style.transform = isPressed ? 'scale(0.92)' : 'scale(1)';
    el.cap.style.transformOrigin = `${el.cap.getAttribute('cx')}px ${el.cap.getAttribute('cy')}px`;
    el.valText.textContent = rawBit === 1n ? '1' : '0';
  }

  _refreshAllButtons() {
    for (const keyId of this._btnEls.keys()) {
      this._updateButtonVisual(keyId);
    }
  }

  setBounceEnabled(enabled) {
    this.simulateBounce = Boolean(enabled);
  }

  /**
   * Return current input states keyed by board port names (plus SW/KEY aliases).
   */
  getInputs() {
    const out = {};
    const sw = this.profile.io.switches;
    if (sw) {
      out[sw.port] = this.swState;
      for (const alias of sw.aliases) out[alias] = this.swState;
    }
    const btns = this.profile.io.buttons;
    if (btns && btns.mode === 'vector') {
      out[btns.port] = this.keyState;
      for (const alias of btns.aliases) out[alias] = this.keyState;
    } else if (btns && btns.mode === 'named') {
      for (const item of btns.items) {
        out[item.port] = this.namedBtnState[item.port] ?? 0n;
      }
    }
    return out;
  }

  resetInputs() {
    this._initInputDefaults();
    this._refreshAllSwitches();
    this._refreshAllButtons();
    if (this.onInputChange) {
      const sw = this.profile.io.switches;
      if (sw) this.onInputChange(sw.port, this.swState);
      const btns = this.profile.io.buttons;
      if (btns && btns.mode === 'vector') {
        this.onInputChange(btns.port, this.keyState);
      } else if (btns && btns.mode === 'named') {
        for (const item of btns.items) {
          this.onInputChange(item.port, this.namedBtnState[item.port]);
        }
      }
    }
  }

  /**
   * Latch an active multiplexed 7-segment anode/cathode sample for persistence-of-vision display.
   */
  recordMuxSample(anInput, segInput, dpInput = 1n) {
    const spec = this.profile.io.sevenSeg;
    if (!spec || spec.mode !== 'multiplexed') return;
    const an = _brdNormalizeLogic(anInput, spec.count, (1n << BigInt(spec.count)) - 1n);
    const seg = _brdNormalizeLogic(segInput, 7, 0x7Fn);
    const dp = _brdNormalizeLogic(dpInput, 1, 1n);
    const decay = spec.povDecayFrames || 12;

    for (let d = 0; d < spec.count; d++) {
      const shift = BigInt(d);
      const anUnknown = (((an.xMask | an.zMask) >> shift) & 1n) === 1n;
      const anActive = !anUnknown && (spec.activeLow ? ((an.val >> shift) & 1n) === 0n : ((an.val >> shift) & 1n) === 1n);
      if (anActive) {
        this._muxDigits[d] = {
          val: seg.val,
          xMask: seg.xMask,
          zMask: seg.zMask,
          dp: Number(dp.val & 1n),
          ttl: decay,
        };
      }
    }
  }

  _paintSevenSegDigit(digitIdx, logicVal, activeLow, dpOff = true) {
    const segs = this._hexSegs[digitIdx];
    if (!segs) return;
    for (let b = 0; b < 7; b++) {
      const poly = segs[b];
      if (!poly) continue;
      const shift = BigInt(b);
      const isUnknown = (((logicVal.xMask | logicVal.zMask) >> shift) & 1n) === 1n;
      const bit = (logicVal.val >> shift) & 1n;
      const isLit = activeLow ? bit === 0n : bit === 1n;

      if (isUnknown) {
        poly.setAttribute('fill', '#D97706');
        poly.removeAttribute('filter');
        poly.classList.add('seg-unknown');
      } else if (isLit) {
        poly.setAttribute('fill', '#FF3B30');
        poly.setAttribute('filter', 'url(#fpga-glow-red)');
        poly.classList.remove('seg-unknown');
      } else {
        poly.setAttribute('fill', '#1D2636');
        poly.removeAttribute('filter');
        poly.classList.remove('seg-unknown');
      }
    }
    const dpEl = this._hexDps[digitIdx];
    if (dpEl) {
      dpEl.setAttribute('fill', dpOff ? '#1D2636' : '#FF3B30');
    }
  }

  /**
   * Update all LEDs, 7-segment displays (independent or multiplexed POV), CLK LED,
   * and expansion header indicator pins from simulator outputs.
   */
  updateOutputs(outputs = {}) {
    const io = this.profile.io;

    // 1. LED banks
    for (const { bank, els } of this._ledBankEls.values()) {
      let rawVal;
      for (const alias of bank.aliases) {
        if (alias in outputs) {
          rawVal = outputs[alias];
          break;
        }
      }
      if (rawVal === undefined) continue;
      const vec = _brdNormalizeLogic(rawVal, bank.width, 0n);

      for (let i = 0; i < bank.width; i++) {
        const entry = els[i];
        if (!entry) continue;
        const shift = BigInt(i);
        const isUnknown = (((vec.xMask | vec.zMask) >> shift) & 1n) === 1n;
        const isOn = ((vec.val >> shift) & 1n) === 1n;

        if (isUnknown) {
          entry.circle.setAttribute('fill', '#B45309');
          entry.circle.setAttribute('stroke', '#FBBF24');
          entry.circle.removeAttribute('filter');
          entry.circle.classList.add('led-unknown');
          entry.title.textContent = `${bank.port}[${i}] = X`;
        } else if (isOn) {
          entry.circle.setAttribute('fill', entry.pal.onFill);
          entry.circle.setAttribute('stroke', entry.pal.onStroke);
          entry.circle.setAttribute('filter', entry.pal.glow);
          entry.circle.classList.remove('led-unknown');
          entry.title.textContent = `${bank.port}[${i}] = 1`;
        } else {
          entry.circle.setAttribute('fill', entry.pal.offFill);
          entry.circle.setAttribute('stroke', entry.pal.offStroke);
          entry.circle.removeAttribute('filter');
          entry.circle.classList.remove('led-unknown');
          entry.title.textContent = `${bank.port}[${i}] = 0`;
        }
      }
    }

    // 2. 7-Segment displays
    const segSpec = io.sevenSeg;
    if (segSpec && segSpec.mode === 'independent') {
      const offVal = segSpec.activeLow ? 0x7Fn : 0n;
      for (let h = 0; h < segSpec.count; h++) {
        const key = `${segSpec.portPrefix}${h}`;
        if (!(key in outputs)) continue;
        const hexVal = _brdNormalizeLogic(outputs[key], 7, offVal);
        this._paintSevenSegDigit(h, hexVal, segSpec.activeLow, true);
      }
    } else if (segSpec && segSpec.mode === 'multiplexed') {
      let anRaw;
      let segRaw;
      let dpRaw = 1n;
      for (const a of segSpec.anodeAliases) { if (a in outputs) { anRaw = outputs[a]; break; } }
      for (const s of segSpec.segAliases) { if (s in outputs) { segRaw = outputs[s]; break; } }
      for (const d of (segSpec.dpAliases || [])) { if (d in outputs) { dpRaw = outputs[d]; break; } }

      if (anRaw !== undefined && segRaw !== undefined) {
        this.recordMuxSample(anRaw, segRaw, dpRaw);
      }
      for (let d = 0; d < segSpec.count; d++) {
        const slot = this._muxDigits[d];
        if (slot && slot.ttl > 0) {
          this._paintSevenSegDigit(d, slot, segSpec.activeLow, slot.dp !== 0);
          slot.ttl -= 1;
        } else {
          this._paintSevenSegDigit(d, { val: 0x7Fn, xMask: 0n, zMask: 0n, width: 7 }, segSpec.activeLow, true);
        }
      }
    }

    // 3. Header pin activity dots
    for (const entry of this._headerPinEls.values()) {
      if (entry.namedPin && entry.namedPin in outputs) {
        const v = _brdNormalizeLogic(outputs[entry.namedPin], 1, 0n);
        const hi = (v.val !== 0n) && (v.xMask | v.zMask) === 0n;
        entry.dot.setAttribute('fill', hi ? '#3B9ED8' : '#334155');
      } else if (entry.hdr.aliases) {
        let raw;
        for (const a of entry.hdr.aliases) { if (a in outputs) { raw = outputs[a]; break; } }
        if (raw !== undefined) {
          const v = _brdNormalizeLogic(raw, entry.hdr.width, 0n);
          const bitHi = ((v.val >> BigInt(entry.bit)) & 1n) === 1n && (((v.xMask | v.zMask) >> BigInt(entry.bit)) & 1n) === 0n;
          entry.dot.setAttribute('fill', bitHi ? '#22C55E' : '#334155');
        }
      }
    }

    // 4. Clock LED
    if ('clk' in outputs && this._clkLedEl) {
      const clk = _brdNormalizeLogic(outputs.clk, 1, 0n);
      const isHi = (clk.val & 1n) === 1n && (clk.xMask | clk.zMask) === 0n;
      if (isHi) {
        this._clkLedEl.setAttribute('fill', 'url(#fpga-led-clk-on)');
        this._clkLedEl.setAttribute('filter', 'url(#fpga-glow-cyan)');
      } else {
        this._clkLedEl.setAttribute('fill', '#0E2438');
        this._clkLedEl.removeAttribute('filter');
      }
    }
  }
}
