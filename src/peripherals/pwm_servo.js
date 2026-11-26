/**
 * Phase B (v2.5) — PWM Duty-Cycle Meter & Inline SVG Rotary Servo (0°–180°)
 * Measures real-time pulse width, period, and duty cycle via EdgeBus.
 */

import { t } from '../i18n.js';

const _PWM_SVG_NS = 'http://www.w3.org/2000/svg';

export const PWM_SERVO_MANIFEST = Object.freeze({
  id: 'pwm_servo',
  nameKey: 'periph.pwm.name',
  defaultName: 'PWM Meter & Servo',
  pins: Object.freeze([
    Object.freeze({
      id: 'pwm',
      labelKey: 'periph.pwm.pinPwm',
      defaultLabel: 'PWM In',
      dir: 'from_rtl',
      aliases: ['PWM', 'pwm', 'pwm_out', 'PWM_OUT', 'SERVO', 'LEDR[0]', 'LEDG[0]', 'GPIO[2]'],
    }),
  ]),
  create: (opts) => new PwmServoPeripheral(opts),
});

function _pwmSvg(tag, attrs = {}, text = null) {
  const el = document.createElementNS(_PWM_SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (text !== null) el.textContent = text;
  return el;
}

export class PwmServoPeripheral {
  constructor(options = {}) {
    this.id = PWM_SERVO_MANIFEST.id;
    this.bindings = { pwm: '', ...(options.bindings || {}) };
    this.ctx = null;
    this._monitor = null;

    this._barFill = null;
    this._armEl = null;
    this._dutyText = null;
    this._angleText = null;
    this._pulseText = null;
  }

  attach(ctx) {
    this.detach();
    this.ctx = ctx;
    if (!ctx || !ctx.edgeBus || !this.bindings.pwm) return;
    this._monitor = ctx.edgeBus.createPwmMonitor(this.bindings.pwm);
  }

  detach() {
    if (this._monitor) {
      this._monitor.dispose();
      this._monitor = null;
    }
  }

  rebind(bindings) {
    this.bindings = { ...this.bindings, ...bindings };
    if (this.ctx) this.attach(this.ctx);
  }

  getMetrics() {
    if (!this._monitor) {
      return { valid: false, dutyCycle: 0, dutyPct: 0, highCycles: 0, periodCycles: 0, frequencyHz: 0, angleDeg: 0 };
    }
    const clkHz = this.ctx?.getClockFreqHz ? this.ctx.getClockFreqHz() : null;
    const m = this._monitor.getMetrics(clkHz);
    const duty = Math.max(0, Math.min(1, m?.dutyCycle || 0));
    return { ...m, dutyCycle: duty, dutyPct: duty * 100, angleDeg: duty * 180 };
  }

  mount(container) {
    if (!container || typeof document === 'undefined') return;
    container.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.className = 'pwm-wrap';

    // Inline SVG rotary servo motor (0° to 180°)
    const svg = _pwmSvg('svg', { viewBox: '0 0 156 96', class: 'pwm-servo-svg' });
    svg.appendChild(_pwmSvg('rect', {
      x: 22, y: 54, width: 112, height: 34, rx: 6,
      fill: '#0D111D', stroke: '#2A3F61', 'stroke-width': 1.5,
    }));
    svg.appendChild(_pwmSvg('rect', {
      x: 10, y: 66, width: 12, height: 10, rx: 2, fill: '#1E2D45',
    }));
    svg.appendChild(_pwmSvg('rect', {
      x: 134, y: 66, width: 12, height: 10, rx: 2, fill: '#1E2D45',
    }));
    // Calibrated 180-degree dial arc
    svg.appendChild(_pwmSvg('path', {
      d: 'M 32 62 A 46 46 0 0 1 124 62',
      fill: 'none', stroke: '#1E2D45', 'stroke-width': 4, 'stroke-linecap': 'round',
    }));
    svg.appendChild(_pwmSvg('text', { x: 20, y: 56, fill: '#94A3B8', 'font-family': 'monospace', 'font-size': 8 }, '0°'));
    svg.appendChild(_pwmSvg('text', { x: 78, y: 12, 'text-anchor': 'middle', fill: '#94A3B8', 'font-family': 'monospace', 'font-size': 8 }, '90°'));
    svg.appendChild(_pwmSvg('text', { x: 126, y: 56, fill: '#94A3B8', 'font-family': 'monospace', 'font-size': 8 }, '180°'));

    // Rotating servo horn group centered at (78, 62)
    const arm = _pwmSvg('g', { transform: 'rotate(-90 78 62)' });
    arm.appendChild(_pwmSvg('path', {
      d: 'M 73 62 L 75 22 Q 78 18 81 22 L 83 62 Z',
      fill: '#3B9ED8', stroke: '#7DD3FC', 'stroke-width': 1.2,
    }));
    arm.appendChild(_pwmSvg('circle', { cx: 78, cy: 26, r: 2.2, fill: '#0D111D' }));
    arm.appendChild(_pwmSvg('circle', { cx: 78, cy: 62, r: 9, fill: '#0060A2', stroke: '#5AB8EC', 'stroke-width': 1.5 }));
    arm.appendChild(_pwmSvg('circle', { cx: 78, cy: 62, r: 3.2, fill: '#E2E8F0' }));
    svg.appendChild(arm);
    this._armEl = arm;

    const statsCol = document.createElement('div');
    statsCol.className = 'pwm-stats';

    const dutyRow = document.createElement('div');
    dutyRow.className = 'pwm-stat-row';
    const dutyLbl = document.createElement('span');
    dutyLbl.setAttribute('data-i18n', 'periph.pwm.duty');
    dutyLbl.textContent = t('periph.pwm.duty');
    const dutyVal = document.createElement('strong');
    dutyVal.className = 'meta-mono';
    dutyVal.textContent = '0.0%';
    dutyRow.appendChild(dutyLbl);
    dutyRow.appendChild(dutyVal);
    this._dutyText = dutyVal;

    const track = document.createElement('div');
    track.className = 'util-track';
    const fill = document.createElement('div');
    fill.className = 'util-fill';
    fill.style.width = '0%';
    track.appendChild(fill);
    this._barFill = fill;

    const angleRow = document.createElement('div');
    angleRow.className = 'pwm-stat-row';
    const angleLbl = document.createElement('span');
    angleLbl.setAttribute('data-i18n', 'periph.pwm.angle');
    angleLbl.textContent = t('periph.pwm.angle');
    const angleVal = document.createElement('strong');
    angleVal.className = 'meta-mono';
    angleVal.textContent = '0°';
    angleRow.appendChild(angleLbl);
    angleRow.appendChild(angleVal);
    this._angleText = angleVal;

    const pulseLine = document.createElement('div');
    pulseLine.className = 'periph-meta-line';
    pulseLine.textContent = 'High: 0 / Period: 0 cyc';
    this._pulseText = pulseLine;

    statsCol.appendChild(dutyRow);
    statsCol.appendChild(track);
    statsCol.appendChild(angleRow);
    statsCol.appendChild(pulseLine);

    wrap.appendChild(svg);
    wrap.appendChild(statsCol);
    container.appendChild(wrap);
  }

  onFrame() {
    const m = this.getMetrics();
    const pct = Math.max(0, Math.min(100, m.dutyPct));
    const angleDeg = m.angleDeg;
    const svgRot = -90 + angleDeg;

    if (this._barFill) this._barFill.style.width = `${pct.toFixed(1)}%`;
    if (this._armEl) this._armEl.setAttribute('transform', `rotate(${svgRot.toFixed(1)} 78 62)`);
    if (this._dutyText) this._dutyText.textContent = `${pct.toFixed(1)}%`;
    if (this._angleText) this._angleText.textContent = `${Math.round(angleDeg)}°`;
    if (this._pulseText) {
      const freqStr = m.frequencyHz > 0 ? ` | ${m.frequencyHz.toFixed(1)} Hz` : '';
      this._pulseText.textContent = `High: ${m.highCycles} / Per: ${m.periodCycles} cyc${freqStr}`;
    }
  }

  updateTranslations() {}

  destroy() {
    this.detach();
  }
}
