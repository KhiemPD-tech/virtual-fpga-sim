/**
 * Phase B (v2.5) — Piezo Buzzer Peripheral (Pure Web Audio API)
 * Lazily initializes AudioContext on user click (autoplay safe) with explicit
 * Mute/Unmute toggle and inline SVG piezo soundwave animation.
 */

import { t } from '../i18n.js';

const _BUZ_SVG_NS = 'http://www.w3.org/2000/svg';

export const BUZZER_AUDIO_MANIFEST = Object.freeze({
  id: 'buzzer_audio',
  nameKey: 'periph.buzzer.name',
  defaultName: 'Piezo Buzzer (Web Audio)',
  pins: Object.freeze([
    Object.freeze({
      id: 'buzz',
      labelKey: 'periph.buzzer.pinBuzz',
      defaultLabel: 'Tone Pin',
      dir: 'from_rtl',
      aliases: ['BUZZ', 'buzz', 'BUZZER', 'buzzer', 'TONE', 'tone_out', 'LEDG[1]', 'LEDR[1]', 'GPIO[3]'],
    }),
  ]),
  create: (opts) => new BuzzerAudioPeripheral(opts),
});

function _buzSvg(tag, attrs = {}) {
  const el = document.createElementNS(_BUZ_SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

export class BuzzerAudioPeripheral {
  constructor(options = {}) {
    this.id = BUZZER_AUDIO_MANIFEST.id;
    this.bindings = { buzz: '', ...(options.bindings || {}) };
    this.ctx = null;
    this._monitor = null;

    this.muted = true; // Autoplay-safe default: user explicitly clicks Unmute
    this.volume = 0.14;
    this._audioCtx = null;
    this._osc = null;
    this._gain = null;
    this._lastEdgeCount = 0;
    this._idleFrames = 0;

    this._muteBtn = null;
    this._freqEl = null;
    this._wavesGroup = null;
    this._coreEl = null;
  }

  attach(ctx) {
    this.detach();
    this.ctx = ctx;
    this._lastEdgeCount = 0;
    this._idleFrames = 0;
    if (!ctx || !ctx.edgeBus || !this.bindings.buzz) return;
    this._monitor = ctx.edgeBus.createPwmMonitor(this.bindings.buzz);
  }

  detach() {
    if (this._monitor) {
      this._monitor.dispose();
      this._monitor = null;
    }
    this._silenceAudio();
  }

  rebind(bindings) {
    this.bindings = { ...this.bindings, ...bindings };
    if (this.ctx) this.attach(this.ctx);
  }

  _ensureAudioNodes() {
    if (this._audioCtx) {
      if (this._audioCtx.state === 'suspended' && typeof this._audioCtx.resume === 'function') {
        this._audioCtx.resume().catch(() => {});
      }
      return true;
    }
    const AudioCtxCtor =
      typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!AudioCtxCtor) return false;

    try {
      this._audioCtx = new AudioCtxCtor();
      this._osc = this._audioCtx.createOscillator();
      this._gain = this._audioCtx.createGain();
      this._osc.type = 'square';
      this._osc.frequency.value = 440;
      this._gain.gain.value = 0;
      this._osc.connect(this._gain);
      this._gain.connect(this._audioCtx.destination);
      this._osc.start();
      return true;
    } catch {
      return false;
    }
  }

  _silenceAudio() {
    if (this._gain && this._audioCtx) {
      try {
        this._gain.gain.setTargetAtTime(0, this._audioCtx.currentTime, 0.015);
      } catch {
        this._gain.gain.value = 0;
      }
    }
  }

  toggleMute() {
    this.muted = !this.muted;
    if (!this.muted) {
      this._ensureAudioNodes();
    } else {
      this._silenceAudio();
    }
    this._syncMuteButton();
  }

  _syncMuteButton() {
    if (!this._muteBtn) return;
    this._muteBtn.textContent = t(this.muted ? 'periph.buzzer.unmute' : 'periph.buzzer.mute');
    this._muteBtn.classList.toggle('btn-primary', !this.muted);
  }

  mount(container) {
    if (!container || typeof document === 'undefined') return;
    container.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.className = 'buzzer-wrap';

    // Inline SVG Piezo disc + animated soundwaves
    const svg = _buzSvg('svg', { viewBox: '0 0 110 72', class: 'buzzer-svg' });
    svg.appendChild(_buzSvg('circle', { cx: 36, cy: 36, r: 26, fill: '#0D111D', stroke: '#2A3F61', 'stroke-width': 2 }));
    svg.appendChild(_buzSvg('circle', { cx: 36, cy: 36, r: 17, fill: '#172136', stroke: '#D97706', 'stroke-width': 1.5 }));
    const core = _buzSvg('circle', { cx: 36, cy: 36, r: 7, fill: '#0E2438', stroke: '#3B9ED8', 'stroke-width': 1.4 });
    svg.appendChild(core);
    this._coreEl = core;

    const waves = _buzSvg('g', { class: 'buzzer-waves', opacity: 0.2 });
    waves.appendChild(_buzSvg('path', { d: 'M 70 24 Q 78 36 70 48', fill: 'none', stroke: '#3B9ED8', 'stroke-width': 2.2, 'stroke-linecap': 'round' }));
    waves.appendChild(_buzSvg('path', { d: 'M 80 18 Q 91 36 80 54', fill: 'none', stroke: '#5AB8EC', 'stroke-width': 2, 'stroke-linecap': 'round' }));
    waves.appendChild(_buzSvg('path', { d: 'M 90 12 Q 104 36 90 60', fill: 'none', stroke: '#22C55E', 'stroke-width': 1.8, 'stroke-linecap': 'round' }));
    svg.appendChild(waves);
    this._wavesGroup = waves;

    const info = document.createElement('div');
    info.className = 'buzzer-info';

    const muteBtn = document.createElement('button');
    muteBtn.type = 'button';
    muteBtn.className = 'btn btn-xs';
    muteBtn.addEventListener('click', () => this.toggleMute());
    this._muteBtn = muteBtn;
    this._syncMuteButton();

    const volSlider = document.createElement('input');
    volSlider.type = 'range';
    volSlider.min = '0';
    volSlider.max = '40';
    volSlider.value = String(Math.round(this.volume * 100));
    volSlider.className = 'periph-slider';
    volSlider.addEventListener('input', () => {
      this.volume = Number(volSlider.value) / 100;
    });

    const freqEl = document.createElement('div');
    freqEl.className = 'meta-mono';
    freqEl.textContent = '0 Hz (Idle)';
    this._freqEl = freqEl;

    info.appendChild(muteBtn);
    info.appendChild(volSlider);
    info.appendChild(freqEl);

    wrap.appendChild(svg);
    wrap.appendChild(info);
    container.appendChild(wrap);
  }

  onFrame() {
    const clkHz = this.ctx?.getClockFreqHz ? this.ctx.getClockFreqHz() : 1000;
    const m = this._monitor ? this._monitor.getMetrics(clkHz) : null;
    const hasNewEdges = Boolean(m && m.edgeCount > this._lastEdgeCount);
    if (m) this._lastEdgeCount = m.edgeCount;

    if (hasNewEdges) {
      this._idleFrames = 0;
    } else {
      this._idleFrames += 1;
    }

    const isToggling = Boolean(m && m.valid && m.periodCycles > 0 && this._idleFrames < 8);
    // Compute audible tone frequency (scales cleanly for low-Hz simulation clocks too)
    let rawHz = isToggling ? m.frequencyHz : 0;
    let audibleHz = rawHz;
    if (isToggling && audibleHz < 120) {
      audibleHz = Math.min(2400, Math.max(140, Math.round(4400 / Math.max(2, m.periodCycles))));
    } else if (audibleHz > 4000) {
      audibleHz = 4000;
    }

    if (this._wavesGroup) {
      this._wavesGroup.setAttribute('opacity', isToggling ? '1' : '0.18');
      this._wavesGroup.classList.toggle('is-active', isToggling);
    }
    if (this._coreEl) {
      this._coreEl.setAttribute('fill', isToggling ? '#3B9ED8' : '#0E2438');
    }
    if (this._freqEl) {
      this._freqEl.textContent = isToggling
        ? `${Math.round(audibleHz)} Hz (per=${m.periodCycles} cyc)`
        : t('periph.buzzer.idle');
    }

    if (!this.muted && isToggling && this._audioCtx && this._osc && this._gain) {
      try {
        const now = this._audioCtx.currentTime;
        this._osc.frequency.setTargetAtTime(audibleHz, now, 0.01);
        this._gain.gain.setTargetAtTime(this.volume, now, 0.015);
      } catch {
        // Ignore audio scheduling error
      }
    } else {
      this._silenceAudio();
    }
  }

  updateTranslations() {
    this._syncMuteButton();
  }

  destroy() {
    this.detach();
    if (this._audioCtx && typeof this._audioCtx.close === 'function') {
      try { this._audioCtx.close(); } catch { /* ignore */ }
    }
    this._audioCtx = null;
    this._osc = null;
    this._gain = null;
  }
}
