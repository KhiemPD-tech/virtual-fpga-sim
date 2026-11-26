/**
 * Phase B (v2.5) — Virtual ADC / Ambient Sensor Slider Peripheral
 * Simulates an 8-bit (0–255) or 10-bit (0–1023) Light/Temperature ADC driving
 * a bound RTL input port with an inline SVG analog dial gauge.
 */

import { t } from '../i18n.js';
import { parseSignalSpec } from '../engine/edge_bus.js';

const _ADC_SVG_NS = 'http://www.w3.org/2000/svg';

export const ADC_SENSOR_MANIFEST = Object.freeze({
  id: 'adc_sensor',
  nameKey: 'periph.adc.name',
  defaultName: 'Virtual ADC / Sensor',
  pins: Object.freeze([
    Object.freeze({
      id: 'out',
      labelKey: 'periph.adc.pinOut',
      defaultLabel: 'ADC Bus',
      dir: 'to_rtl',
      aliases: ['ADC_DATA', 'adc_data', 'ADC_IN', 'adc_in', 'SENSOR', 'SW', 'sw'],
    }),
  ]),
  create: (opts) => new AdcSensorPeripheral(opts),
});

function _adcSvg(tag, attrs = {}, text = null) {
  const el = document.createElementNS(_ADC_SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (text !== null) el.textContent = text;
  return el;
}

export class AdcSensorPeripheral {
  constructor(options = {}) {
    this.id = ADC_SENSOR_MANIFEST.id;
    this.bindings = { out: '', ...(options.bindings || {}) };
    this.bits = options.bits === 10 ? 10 : 8;
    this.mode = options.mode === 'temp' ? 'temp' : 'light';
    this.value = options.initialValue ?? 128;
    this.ctx = null;

    this._sliderEl = null;
    this._readoutEl = null;
    this._needleEl = null;
    this._arcEl = null;
    this._bitsSelect = null;
    this._modeSelect = null;
  }

  getMaxValue() {
    return (1 << this.bits) - 1;
  }

  attach(ctx) {
    this.ctx = ctx;
    // Auto-adapt bit resolution if bound to a 10-bit signal
    if (ctx?.sim?.ast && this.bindings.out) {
      const parsed = parseSignalSpec(this.bindings.out, 0);
      const sig = ctx.sim.ast.signals?.[parsed.signal];
      if (sig && sig.width === 10 && this.bits !== 10) {
        this.setBits(10);
      }
    }
    this.pushValue();
  }

  detach() {}

  rebind(bindings) {
    this.bindings = { ...this.bindings, ...bindings };
    if (this.ctx) this.attach(this.ctx);
  }

  setBits(bits) {
    this.bits = bits === 10 ? 10 : 8;
    const max = this.getMaxValue();
    this.value = Math.min(this.value, max);
    if (this._sliderEl) {
      this._sliderEl.max = String(max);
      this._sliderEl.value = String(this.value);
    }
    if (this._bitsSelect) this._bitsSelect.value = String(this.bits);
    this.pushValue();
    this._updateVisuals();
  }

  setValue(val) {
    const max = this.getMaxValue();
    this.value = Math.max(0, Math.min(max, Math.round(Number(val) || 0)));
    if (this._sliderEl) this._sliderEl.value = String(this.value);
    this.pushValue();
    this._updateVisuals();
  }

  pushValue() {
    if (!this.ctx?.sim?.ast || !this.bindings.out) return;
    const parsed = parseSignalSpec(this.bindings.out, 0);
    if (!this.ctx.sim.ast.signals?.[parsed.signal]) return;
    this.ctx.sim.setInput(parsed.signal, BigInt(this.value));
    if (typeof this.ctx.onExternalInput === 'function') {
      this.ctx.onExternalInput();
    }
  }

  mount(container) {
    if (!container || typeof document === 'undefined') return;
    container.innerHTML = '';

    const ctrlRow = document.createElement('div');
    ctrlRow.className = 'periph-ctrl-row';

    const modeSel = document.createElement('select');
    modeSel.className = 'periph-select';
    for (const [val, key] of [['light', 'periph.adc.modeLight'], ['temp', 'periph.adc.modeTemp']]) {
      const o = document.createElement('option');
      o.value = val;
      o.setAttribute('data-i18n', key);
      o.textContent = t(key);
      if (val === this.mode) o.selected = true;
      modeSel.appendChild(o);
    }
    modeSel.addEventListener('change', () => {
      this.mode = modeSel.value;
      this._updateVisuals();
    });
    this._modeSelect = modeSel;

    const bitsSel = document.createElement('select');
    bitsSel.className = 'periph-select';
    for (const b of [8, 10]) {
      const o = document.createElement('option');
      o.value = String(b);
      o.textContent = `${b}-bit (0–${(1 << b) - 1})`;
      if (b === this.bits) o.selected = true;
      bitsSel.appendChild(o);
    }
    bitsSel.addEventListener('change', () => this.setBits(Number(bitsSel.value)));
    this._bitsSelect = bitsSel;

    ctrlRow.appendChild(modeSel);
    ctrlRow.appendChild(bitsSel);

    const body = document.createElement('div');
    body.className = 'adc-wrap';

    // Inline SVG analog gauge
    const svg = _adcSvg('svg', { viewBox: '0 0 120 72', class: 'adc-gauge-svg' });
    svg.appendChild(_adcSvg('path', {
      d: 'M 16 60 A 44 44 0 0 1 104 60',
      fill: 'none', stroke: '#1E2D45', 'stroke-width': 7, 'stroke-linecap': 'round',
    }));
    const arc = _adcSvg('path', {
      d: 'M 16 60 A 44 44 0 0 1 104 60',
      fill: 'none', stroke: '#3B9ED8', 'stroke-width': 7, 'stroke-linecap': 'round',
      'stroke-dasharray': '138.2', 'stroke-dashoffset': '69.1',
    });
    svg.appendChild(arc);
    this._arcEl = arc;

    const needle = _adcSvg('line', {
      x1: 60, y1: 60, x2: 60, y2: 24,
      stroke: '#FBBF24', 'stroke-width': 2.2, 'stroke-linecap': 'round',
      transform: 'rotate(0 60 60)',
    });
    svg.appendChild(needle);
    svg.appendChild(_adcSvg('circle', { cx: 60, cy: 60, r: 4.5, fill: '#3B9ED8' }));
    this._needleEl = needle;

    const right = document.createElement('div');
    right.className = 'adc-controls';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = String(this.getMaxValue());
    slider.value = String(this.value);
    slider.className = 'periph-slider';
    slider.addEventListener('input', () => this.setValue(slider.value));
    this._sliderEl = slider;

    const readout = document.createElement('div');
    readout.className = 'meta-mono';
    this._readoutEl = readout;

    right.appendChild(slider);
    right.appendChild(readout);

    body.appendChild(svg);
    body.appendChild(right);

    container.appendChild(ctrlRow);
    container.appendChild(body);
    this._updateVisuals();
  }

  _updateVisuals() {
    const max = this.getMaxValue();
    const frac = max > 0 ? this.value / max : 0;
    const deg = -90 + frac * 180;
    if (this._needleEl) this._needleEl.setAttribute('transform', `rotate(${deg.toFixed(1)} 60 60)`);
    if (this._arcEl) this._arcEl.setAttribute('stroke-dashoffset', (138.2 * (1 - frac)).toFixed(1));
    if (this._readoutEl) {
      const hex = this.value.toString(16).toUpperCase().padStart(Math.ceil(this.bits / 4), '0');
      const phys = this.mode === 'temp'
        ? `${(-10 + frac * 95).toFixed(1)} °C`
        : `${Math.round(frac * 1000)} Lux`;
      this._readoutEl.textContent = `${this.value} (0x${hex}) | ${phys}`;
    }
  }

  onFrame() {}
  updateTranslations() {}
  destroy() {}
}
