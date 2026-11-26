/**
 * Phase B (v2.5) — Expansion Peripheral Dock UI Controller
 * Manages plugin peripheral cards with +Add Peripheral menu, dynamic port binding
 * dropdowns, preset auto-attach, and 60 FPS frame updates.
 */

import { t } from '../i18n.js';
import {
  PERIPHERAL_MANIFESTS,
  getPeripheralManifest,
  listBindablePortOptions,
  autoBindPeripheralPins,
} from '../peripherals/registry.js';

export class PeripheralDock {
  /**
   * @param {HTMLElement|null} container
   * @param {{ onCountChange?: (count: number) => void }} [options={}]
   */
  constructor(container, options = {}) {
    this.container = container;
    this.onCountChange = typeof options.onCountChange === 'function' ? options.onCountChange : null;

    this._ctx = null;
    this._cards = [];
    this._nextId = 1;

    this._addSelect = null;
    this._cardsGrid = null;
    this._emptyEl = null;

    if (this.container && typeof document !== 'undefined') {
      this._mountShell();
    }
  }

  _mountShell() {
    this.container.innerHTML = '';

    const shell = document.createElement('div');
    shell.className = 'pdock-shell';

    const bar = document.createElement('div');
    bar.className = 'pdock-toolbar';

    const addSelect = document.createElement('select');
    addSelect.className = 'periph-select pdock-add-select';
    addSelect.setAttribute('aria-label', 'Select expansion peripheral');
    this._addSelect = addSelect;
    this._populateAddSelect();

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn btn-xs btn-primary';
    addBtn.setAttribute('data-i18n', 'periph.dock.add');
    addBtn.textContent = t('periph.dock.add');
    addBtn.addEventListener('click', () => {
      if (addSelect.value) {
        this.addPeripheral(addSelect.value);
      }
    });

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'btn btn-xs';
    clearBtn.setAttribute('data-i18n', 'periph.dock.clearAll');
    clearBtn.textContent = t('periph.dock.clearAll');
    clearBtn.addEventListener('click', () => this.clear());

    bar.appendChild(addSelect);
    bar.appendChild(addBtn);
    bar.appendChild(clearBtn);

    const grid = document.createElement('div');
    grid.className = 'pdock-grid';
    this._cardsGrid = grid;

    const empty = document.createElement('div');
    empty.className = 'drc-empty pdock-empty';
    empty.setAttribute('data-i18n', 'periph.dock.empty');
    empty.textContent = t('periph.dock.empty');
    this._emptyEl = empty;
    grid.appendChild(empty);

    shell.appendChild(bar);
    shell.appendChild(grid);
    this.container.appendChild(shell);
  }

  _populateAddSelect() {
    if (!this._addSelect) return;
    const prev = this._addSelect.value;
    this._addSelect.innerHTML = '';
    for (const m of PERIPHERAL_MANIFESTS) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = t(m.nameKey);
      if (m.id === prev) opt.selected = true;
      this._addSelect.appendChild(opt);
    }
  }

  _notifyCount() {
    if (this._emptyEl) {
      this._emptyEl.classList.toggle('hidden', this._cards.length > 0);
    }
    if (this.onCountChange) {
      this.onCountChange(this._cards.length);
    }
  }

  /**
   * Update active simulation/AST context and re-attach all mounted peripherals.
   */
  syncContext(ctx) {
    this._ctx = ctx;
    for (const card of this._cards) {
      const updated = autoBindPeripheralPins(card.manifest, ctx?.sim?.ast, card.instance.bindings);
      card.instance.bindings = updated;
      this._refreshCardBindingsUi(card);
      card.instance.attach(ctx);
    }
  }

  /**
   * Add a peripheral plugin card by manifest ID.
   */
  addPeripheral(manifestId, options = {}) {
    const manifest = getPeripheralManifest(manifestId);
    if (!manifest) return null;

    const ast = this._ctx?.sim?.ast || null;
    const bindings = autoBindPeripheralPins(manifest, ast, options.bindings || {});
    const instance = manifest.create({ ...(options.config || {}), bindings });
    const instanceId = `periph-${this._nextId++}`;

    const card = {
      instanceId,
      manifest,
      instance,
      el: null,
      titleEl: null,
      pinSelects: new Map(),
    };

    if (this._cardsGrid && typeof document !== 'undefined') {
      this._renderCardElement(card);
    }

    this._cards.push(card);
    if (this._ctx) {
      instance.attach(this._ctx);
    }
    this._notifyCount();
    return instance;
  }

  _renderCardElement(card) {
    const el = document.createElement('div');
    el.className = 'periph-card';

    const hdr = document.createElement('div');
    hdr.className = 'periph-card-header';

    const title = document.createElement('span');
    title.className = 'periph-card-title';
    title.textContent = t(card.manifest.nameKey);
    card.titleEl = title;

    const rmBtn = document.createElement('button');
    rmBtn.type = 'button';
    rmBtn.className = 'btn btn-xs periph-rm-btn';
    rmBtn.textContent = '×';
    rmBtn.title = t('periph.dock.remove');
    rmBtn.addEventListener('click', () => this.removePeripheral(card.instanceId));

    hdr.appendChild(title);
    hdr.appendChild(rmBtn);
    el.appendChild(hdr);

    // Per-card dynamic Port Binding dropdowns
    if (card.manifest.pins.length > 0) {
      const bindBar = document.createElement('div');
      bindBar.className = 'periph-bind-bar';

      for (const pin of card.manifest.pins) {
        const lbl = document.createElement('label');
        lbl.className = 'periph-pin-field';

        const pinSpan = document.createElement('span');
        pinSpan.className = 'periph-pin-lbl';
        pinSpan.setAttribute('data-i18n', pin.labelKey);
        pinSpan.textContent = t(pin.labelKey);

        const sel = document.createElement('select');
        sel.className = 'periph-select';
        sel.addEventListener('change', () => {
          card.instance.rebind({ [pin.id]: sel.value });
        });

        card.pinSelects.set(pin.id, { pin, sel });
        lbl.appendChild(pinSpan);
        lbl.appendChild(sel);
        bindBar.appendChild(lbl);
      }

      el.appendChild(bindBar);
      this._refreshCardBindingsUi(card);
    }

    const body = document.createElement('div');
    body.className = 'periph-card-body';
    card.instance.mount(body);
    el.appendChild(body);

    card.el = el;
    this._cardsGrid.appendChild(el);
  }

  _refreshCardBindingsUi(card) {
    const ast = this._ctx?.sim?.ast || null;
    for (const { pin, sel } of card.pinSelects.values()) {
      const opts = listBindablePortOptions(ast, pin.dir);
      const current = card.instance.bindings[pin.id] || '';
      sel.innerHTML = '';

      const emptyOpt = document.createElement('option');
      emptyOpt.value = '';
      emptyOpt.textContent = t('periph.dock.unbound');
      sel.appendChild(emptyOpt);

      if (current && !opts.includes(current)) {
        opts.unshift(current);
      }

      for (const spec of opts) {
        const o = document.createElement('option');
        o.value = spec;
        o.textContent = spec;
        if (spec === current) o.selected = true;
        sel.appendChild(o);
      }
      sel.value = current;
    }
  }

  removePeripheral(instanceId) {
    const idx = this._cards.findIndex((c) => c.instanceId === instanceId);
    if (idx === -1) return;
    const [card] = this._cards.splice(idx, 1);
    card.instance.destroy();
    if (card.el && card.el.parentNode) {
      card.el.parentNode.removeChild(card.el);
    }
    this._notifyCount();
  }

  clear() {
    while (this._cards.length > 0) {
      const card = this._cards.pop();
      card.instance.destroy();
      if (card.el && card.el.parentNode) {
        card.el.parentNode.removeChild(card.el);
      }
    }
    this._notifyCount();
  }

  /**
   * Replace mounted peripherals with a preset's recommended peripheral list.
   * @param {Array<{ id: string, bindings?: object, config?: object }>} [specs=[]]
   */
  applyPresetPeripherals(specs = []) {
    this.clear();
    for (const spec of specs) {
      this.addPeripheral(spec.id, spec);
    }
  }

  getInstances() {
    return this._cards.map((c) => c.instance);
  }

  serializeState() {
    const activePeripherals = [];
    const pinBindings = {};

    this._cards.forEach((card, idx) => {
      const inst = card.instance;
      const config = {};
      if (typeof inst.cyclesPerBit === 'number') config.cyclesPerBit = inst.cyclesPerBit;
      if (typeof inst.bits === 'number') config.bits = inst.bits;
      if (typeof inst.mode === 'string') config.mode = inst.mode;
      if (typeof inst.value === 'number') config.initialValue = inst.value;
      if (typeof inst.selectedMem === 'string' && inst.selectedMem) config.memoryName = inst.selectedMem;
      if (typeof inst.sampleHex === 'string') config.sampleHex = inst._hexInput?.value || inst.sampleHex;

      const bindings = inst.bindings ? { ...inst.bindings } : {};
      activePeripherals.push({ id: card.manifest.id, config, bindings });
      if (Object.keys(bindings).length > 0) {
        pinBindings[`${card.manifest.id}#${idx}`] = bindings;
      }
    });

    return { activePeripherals, pinBindings };
  }

  onFrame() {
    for (let i = 0; i < this._cards.length; i++) {
      this._cards[i].instance.onFrame();
    }
  }

  updateTranslations() {
    this._populateAddSelect();
    for (const card of this._cards) {
      if (card.titleEl) card.titleEl.textContent = t(card.manifest.nameKey);
      this._refreshCardBindingsUi(card);
      card.instance.updateTranslations();
    }
  }
}
