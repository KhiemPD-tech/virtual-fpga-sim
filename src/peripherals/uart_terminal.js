/**
 * Phase B (v2.5) — UART Terminal Expansion Peripheral
 * Decodes 8N1 serial frames on bound TX pin via EdgeBus and serializes typed
 * ASCII/Hex bytes onto bound RX pin at cycle-accurate timing (works with stepCycles).
 */

import { t } from '../i18n.js';
import { parseSignalSpec } from '../engine/edge_bus.js';

export const UART_TERMINAL_MANIFEST = Object.freeze({
  id: 'uart_terminal',
  nameKey: 'periph.uart.name',
  defaultName: 'UART Terminal (8N1)',
  pins: Object.freeze([
    Object.freeze({
      id: 'tx',
      labelKey: 'periph.uart.pinTx',
      defaultLabel: 'TX (RTL → Term)',
      dir: 'from_rtl',
      aliases: ['UART_TX', 'uart_tx', 'TX', 'tx', 'GPIO[0]', 'JA[0]', 'LEDG[0]'],
    }),
    Object.freeze({
      id: 'rx',
      labelKey: 'periph.uart.pinRx',
      defaultLabel: 'RX (Term → RTL)',
      dir: 'to_rtl',
      aliases: ['UART_RX', 'uart_rx', 'RX', 'rx', 'GPIO[1]', 'JA[1]', 'SW[0]'],
    }),
  ]),
  create: (opts) => new UartTerminalPeripheral(opts),
});

function _uartDriveBit(sim, portSpec, bitVal) {
  if (!sim || !sim.ast || !portSpec) return;
  const parsed = parseSignalSpec(portSpec, 0);
  const sig = sim.ast.signals?.[parsed.signal];
  if (!sig) return;
  if (portSpec.includes('[') || sig.width > 1) {
    const cur = sim.getSignal(parsed.signal);
    const mask = 1n << BigInt(parsed.bit);
    const nextVal = bitVal ? (cur.val | mask) : (cur.val & ~mask);
    sim.setInput(parsed.signal, nextVal);
  } else {
    sim.setInput(parsed.signal, bitVal ? 1n : 0n);
  }
}

export class UartTerminalPeripheral {
  constructor(options = {}) {
    this.id = UART_TERMINAL_MANIFEST.id;
    this.cyclesPerBit = Number(options.cyclesPerBit || 16);
    this.bindings = { tx: '', rx: '', ...(options.bindings || {}) };
    this.ctx = null;

    this._rxBytes = [];
    this._txBitQueue = [];
    this._txHoldCounter = 0;
    this._currentTxBit = 1;

    this._sampler = null;
    this._unsubClk = null;
    this._showHex = false;
    this._dirtyLog = false;

    this._el = null;
    this._logEl = null;
    this._inputEl = null;
    this._divSelect = null;
    this._hexBtn = null;
    this._statusEl = null;
  }

  attach(ctx) {
    this.detach();
    this.ctx = ctx;
    if (!ctx || !ctx.sim || !ctx.edgeBus) return;

    // Hold UART_RX idle-high (1) so RTL uart_rx never false-triggers at reset
    if (this.bindings.rx) {
      _uartDriveBit(ctx.sim, this.bindings.rx, 1);
    }

    if (this.bindings.tx) {
      this._sampler = ctx.edgeBus.createBitSampler(this.bindings.tx, {
        mode: 'uart',
        cyclesPerBit: this.cyclesPerBit,
        dataBits: 8,
        onByte: (byteVal, meta) => {
          this._rxBytes.push({ value: byteVal & 0xFF, framingError: Boolean(meta?.framingError) });
          if (this._rxBytes.length > 512) this._rxBytes.shift();
          this._dirtyLog = true;
        },
      });
    }
  }

  detach() {
    if (this._sampler) {
      this._sampler.dispose();
      this._sampler = null;
    }
    if (this._unsubClk) {
      this._unsubClk();
      this._unsubClk = null;
    }
    this._txBitQueue.length = 0;
    this._txHoldCounter = 0;
  }

  rebind(bindings) {
    this.bindings = { ...this.bindings, ...bindings };
    if (this.ctx) this.attach(this.ctx);
  }

  setCyclesPerBit(cpb) {
    const val = Math.max(1, Number(cpb) | 0);
    if (val === this.cyclesPerBit) return;
    this.cyclesPerBit = val;
    if (this._divSelect) this._divSelect.value = String(val);
    if (this.ctx) this.attach(this.ctx);
  }

  /**
   * Queue a single byte (8N1: start=0, 8 data bits LSB-first, stop=1 + 2 idle guard bits)
   * onto the bound RTL RX pin synchronized to simulation clock cycles.
   */
  sendByte(byteVal) {
    const b = Number(byteVal) & 0xFF;
    this._txBitQueue.push(0); // Start bit
    for (let i = 0; i < 8; i++) {
      this._txBitQueue.push((b >> i) & 1);
    }
    this._txBitQueue.push(1, 1, 1); // Stop bit + inter-frame idle high
    this._ensureTxClockHook();
  }

  /**
   * Queue an ASCII string for serial transmission onto the bound RX pin.
   */
  sendText(text) {
    const str = String(text || '');
    for (let i = 0; i < str.length; i++) {
      this.sendByte(str.charCodeAt(i) & 0xFF);
    }
  }

  _ensureTxClockHook() {
    if (!this.ctx || !this.ctx.sim || !this.ctx.edgeBus || !this.bindings.rx) return;
    if (this._unsubClk) return;

    // Immediately assert first queued bit (start bit 0) and hold for cyclesPerBit clocks
    this._currentTxBit = this._txBitQueue.shift();
    this._txHoldCounter = 0;
    _uartDriveBit(this.ctx.sim, this.bindings.rx, this._currentTxBit);

    const clkPort = this.ctx.sim.getClockPort();
    this._unsubClk = this.ctx.edgeBus.subscribe(
      clkPort,
      () => {
        this._txHoldCounter += 1;
        if (this._txHoldCounter < this.cyclesPerBit) return;
        this._txHoldCounter = 0;

        if (this._txBitQueue.length > 0) {
          this._currentTxBit = this._txBitQueue.shift();
          _uartDriveBit(this.ctx.sim, this.bindings.rx, this._currentTxBit);
        } else {
          this._currentTxBit = 1;
          _uartDriveBit(this.ctx.sim, this.bindings.rx, 1);
          if (this._unsubClk) {
            this._unsubClk();
            this._unsubClk = null;
          }
        }
      },
      { edge: 'negedge' }
    );
  }

  getReceivedBytes() {
    return this._rxBytes.map((e) => e.value);
  }

  getReceivedText() {
    return this._rxBytes
      .map((e) => (e.value >= 32 && e.value <= 126 ? String.fromCharCode(e.value) : (e.value === 10 ? '\n' : '.')))
      .join('');
  }

  clear() {
    this._rxBytes.length = 0;
    this._dirtyLog = true;
    this._renderLog();
  }

  mount(container) {
    if (!container || typeof document === 'undefined') return;
    this._el = container;
    container.innerHTML = '';

    const ctrlRow = document.createElement('div');
    ctrlRow.className = 'periph-ctrl-row';

    const divLabel = document.createElement('label');
    divLabel.className = 'periph-inline-label';
    const divSpan = document.createElement('span');
    divSpan.setAttribute('data-i18n', 'periph.uart.divider');
    divSpan.textContent = t('periph.uart.divider');

    const divSel = document.createElement('select');
    divSel.className = 'periph-select';
    for (const optVal of [4, 8, 16, 32]) {
      const o = document.createElement('option');
      o.value = String(optVal);
      o.textContent = `${optVal} cyc/bit`;
      if (optVal === this.cyclesPerBit) o.selected = true;
      divSel.appendChild(o);
    }
    divSel.addEventListener('change', () => this.setCyclesPerBit(Number(divSel.value)));
    divLabel.appendChild(divSpan);
    divLabel.appendChild(divSel);
    this._divSelect = divSel;

    const hexBtn = document.createElement('button');
    hexBtn.type = 'button';
    hexBtn.className = 'btn btn-xs';
    hexBtn.textContent = 'HEX';
    hexBtn.addEventListener('click', () => {
      this._showHex = !this._showHex;
      hexBtn.classList.toggle('btn-primary', this._showHex);
      this._renderLog();
    });
    this._hexBtn = hexBtn;

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'btn btn-xs';
    clearBtn.setAttribute('data-i18n', 'console.clear');
    clearBtn.textContent = t('console.clear');
    clearBtn.addEventListener('click', () => this.clear());

    ctrlRow.appendChild(divLabel);
    ctrlRow.appendChild(hexBtn);
    ctrlRow.appendChild(clearBtn);

    const logEl = document.createElement('pre');
    logEl.className = 'uart-log';
    this._logEl = logEl;

    const sendRow = document.createElement('div');
    sendRow.className = 'uart-send-row';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'periph-input';
    input.placeholder = t('periph.uart.placeholder');
    this._inputEl = input;

    const sendBtn = document.createElement('button');
    sendBtn.type = 'button';
    sendBtn.className = 'btn btn-xs btn-primary';
    sendBtn.setAttribute('data-i18n', 'periph.uart.send');
    sendBtn.textContent = t('periph.uart.send');

    const doSend = () => {
      const txt = input.value;
      if (!txt) return;
      this.sendText(txt);
      input.value = '';
    };
    sendBtn.addEventListener('click', doSend);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        doSend();
      }
    });

    sendRow.appendChild(input);
    sendRow.appendChild(sendBtn);

    const status = document.createElement('div');
    status.className = 'periph-meta-line';
    this._statusEl = status;

    container.appendChild(ctrlRow);
    container.appendChild(logEl);
    container.appendChild(sendRow);
    container.appendChild(status);

    this._renderLog();
  }

  _renderLog() {
    if (!this._logEl) return;
    if (this._rxBytes.length === 0) {
      this._logEl.textContent = t('periph.uart.empty');
    } else if (this._showHex) {
      this._logEl.textContent = this._rxBytes
        .map((e) => e.value.toString(16).toUpperCase().padStart(2, '0'))
        .join(' ');
    } else {
      this._logEl.textContent = this.getReceivedText();
    }
    this._logEl.scrollTop = this._logEl.scrollHeight;
    if (this._statusEl) {
      this._statusEl.textContent = `RX: ${this._rxBytes.length} B | TX Q: ${Math.ceil(this._txBitQueue.length / 10)} B`;
    }
  }

  onFrame() {
    if (this._dirtyLog || this._txBitQueue.length > 0) {
      this._dirtyLog = false;
      this._renderLog();
    }
  }

  updateTranslations() {
    if (this._inputEl) this._inputEl.placeholder = t('periph.uart.placeholder');
    this._renderLog();
  }

  destroy() {
    this.detach();
  }
}
