/**
 * Phase A (v2.0) — Protocol Edge Bus (SPEC Section 9.5)
 * Zero-overhead cycle-stamped edge & pulse tracker for high-throughput simulation.
 * Provides reusable peripheral helpers for PWM/Servo duty-cycle estimation,
 * Piezo Buzzer frequency measurement, and UART/SPI bit sampling.
 */

export const EDGE_BUS_DEFAULT_CAPACITY = 4096;

/**
 * Parse a signal specifier such as `'pwm_out'`, `'LEDR[0]'`, or `'u_tx.tx'`
 * into `{ signal, bit, key }`.
 *
 * @param {string} spec
 * @param {number} [defaultBit=0]
 */
export function parseSignalSpec(spec, defaultBit = 0) {
  const raw = String(spec || '').trim();
  const match = /^(.+)\[(\d+)\]$/.exec(raw);
  if (match) {
    const signal = match[1].trim();
    const bit = parseInt(match[2], 10);
    return { signal, bit, key: `${signal}[${bit}]` };
  }
  const bit = Math.max(0, defaultBit | 0);
  return { signal: raw, bit, key: `${raw}[${bit}]` };
}

function _ebReadBit(sigId, bitShift, sigVal, sigX, sigZ) {
  if (sigId < 0 || sigId >= sigVal.length) return null;
  const x = (sigX[sigId] >> bitShift) & 1n;
  const z = (sigZ[sigId] >> bitShift) & 1n;
  if (x !== 0n || z !== 0n) return null;
  return Number((sigVal[sigId] >> bitShift) & 1n);
}

export class EdgeBus {
  /**
   * @param {{ maxBatchEvents?: number }} [options={}]
   */
  constructor(options = {}) {
    this._maxBatchEvents = options.maxBatchEvents ?? EDGE_BUS_DEFAULT_CAPACITY;
    this._channelsByKey = new Map();
    this._watchersBySigId = [];
    this._nameToId = new Map();
    this._sigMeta = [];
    this._activeWatcherCount = 0;

    // Scheduled cycle-based samplers (e.g., async UART bit sampling)
    this._scheduledSamplers = new Set();
    this._activeScheduledCount = 0;

    // Batch event buffer (used by Simulator.stepCycles)
    this._capturingBatch = false;
    this._batchEvents = [];
    this._lastTick = 0;
  }

  /**
   * Fast O(1) check used inside Simulator inner tick loop.
   */
  hasWatchers() {
    return this._activeWatcherCount > 0;
  }

  /**
   * Fast O(1) check for scheduled tick samplers (UART async receivers).
   */
  hasScheduledSamplers() {
    return this._activeScheduledCount > 0;
  }

  /**
   * Bind integer signal IDs from the Simulator's Flat Signal Table.
   * Safe to call before or after subscriptions are registered.
   *
   * @param {Map<string, number>} nameToId
   * @param {Array<{ width: number, baseLsb?: number, lsb?: number, msb?: number }>} sigMeta
   */
  bindSignalMap(nameToId, sigMeta) {
    this._nameToId = nameToId || new Map();
    this._sigMeta = sigMeta || [];
    this._rebuildIdIndex();
  }

  _rebuildIdIndex() {
    const count = this._sigMeta.length;
    this._watchersBySigId = new Array(count).fill(null);

    for (const ch of this._channelsByKey.values()) {
      const sigId = this._nameToId.has(ch.signal) ? this._nameToId.get(ch.signal) : -1;
      ch.sigId = sigId;
      if (sigId >= 0) {
        const meta = this._sigMeta[sigId];
        const baseLsb = meta?.baseLsb ?? (meta ? Math.min(meta.msb ?? 0, meta.lsb ?? 0) : 0);
        const offset = Math.max(0, ch.bit - baseLsb);
        ch.bitShift = BigInt(offset);
        if (this._watchersBySigId[sigId] === null) {
          this._watchersBySigId[sigId] = [ch];
        } else {
          this._watchersBySigId[sigId].push(ch);
        }
      } else {
        ch.bitShift = BigInt(Math.max(0, ch.bit));
      }
    }

    for (const sampler of this._scheduledSamplers) {
      sampler._rebind(this._nameToId, this._sigMeta);
    }
  }

  /**
   * Reset measured edge timestamps and pulse accumulators while keeping active subscriptions.
   */
  resetState() {
    this._lastTick = 0;
    this._batchEvents = [];
    for (const ch of this._channelsByKey.values()) {
      ch.lastLevel = null;
      ch.lastEdgeTick = null;
      ch.lastSampleTick = 0;
      ch.lastHighTicks = 0;
      ch.lastLowTicks = 0;
      ch.highCycles = 0;
      ch.lowCycles = 0;
      ch.periodCycles = 0;
      ch.dutyCycle = 0;
      ch.totalHighTicks = 0;
      ch.totalTrackedTicks = 0;
      ch.edgeCount = 0;
      ch.risingCount = 0;
      ch.fallingCount = 0;
    }
    for (const sampler of this._scheduledSamplers) {
      sampler.reset();
    }
  }

  /**
   * Seed initial post-reset levels at tick 0 so the first real transition measures cleanly
   * without emitting a spurious power-on edge.
   */
  seedInitialLevels(sigVal, sigX, sigZ, tick = 0) {
    this._lastTick = tick;
    if (this._activeWatcherCount === 0) return;
    for (const ch of this._channelsByKey.values()) {
      if (ch.sigId >= 0) {
        ch.lastLevel = _ebReadBit(ch.sigId, ch.bitShift, sigVal, sigX, sigZ);
        ch.lastSampleTick = tick;
      }
    }
  }

  beginBatch() {
    this._capturingBatch = true;
    this._batchEvents = [];
  }

  endBatch() {
    this._capturingBatch = false;
    const drained = this._batchEvents;
    this._batchEvents = [];
    return drained;
  }

  _getOrCreateChannel(signalSpec, bitOpt) {
    const parsed = parseSignalSpec(signalSpec, bitOpt ?? 0);
    let ch = this._channelsByKey.get(parsed.key);
    if (!ch) {
      const sigId = this._nameToId.has(parsed.signal) ? this._nameToId.get(parsed.signal) : -1;
      const meta = sigId >= 0 ? this._sigMeta[sigId] : null;
      const baseLsb = meta?.baseLsb ?? (meta ? Math.min(meta.msb ?? 0, meta.lsb ?? 0) : 0);
      const offset = Math.max(0, parsed.bit - baseLsb);

      ch = {
        key: parsed.key,
        signal: parsed.signal,
        bit: parsed.bit,
        sigId,
        bitShift: BigInt(offset),
        lastLevel: null,
        lastEdgeTick: null,
        lastSampleTick: this._lastTick,
        lastHighTicks: 0,
        lastLowTicks: 0,
        highCycles: 0,
        lowCycles: 0,
        periodCycles: 0,
        dutyCycle: 0,
        totalHighTicks: 0,
        totalTrackedTicks: 0,
        edgeCount: 0,
        risingCount: 0,
        fallingCount: 0,
        listeners: new Set(),
        refCount: 0,
      };
      this._channelsByKey.set(parsed.key, ch);
      this._activeWatcherCount = this._channelsByKey.size;

      if (sigId >= 0) {
        if (this._watchersBySigId[sigId] === null) {
          this._watchersBySigId[sigId] = [ch];
        } else if (this._watchersBySigId[sigId]) {
          this._watchersBySigId[sigId].push(ch);
        }
      }
    }
    return ch;
  }

  _releaseChannel(ch) {
    ch.refCount = Math.max(0, ch.refCount - 1);
    if (ch.refCount === 0 && ch.listeners.size === 0) {
      this._channelsByKey.delete(ch.key);
      this._activeWatcherCount = this._channelsByKey.size;
      if (ch.sigId >= 0 && this._watchersBySigId[ch.sigId]) {
        const filtered = this._watchersBySigId[ch.sigId].filter((c) => c !== ch);
        this._watchersBySigId[ch.sigId] = filtered.length > 0 ? filtered : null;
      }
    }
  }

  /**
   * Subscribe to signal transitions (`posedge`, `negedge`, or `both`).
   * Returns an `unsubscribe()` function.
   *
   * @param {string} signalSpec e.g. `'pwm_out'` or `'LEDR[0]'`
   * @param {(event: object) => void} callback
   * @param {{ bit?: number, edge?: 'both'|'posedge'|'negedge' }} [options={}]
   */
  subscribe(signalSpec, callback, options = {}) {
    const ch = this._getOrCreateChannel(signalSpec, options.bit);
    const entry = {
      callback: typeof callback === 'function' ? callback : null,
      edge: options.edge || 'both',
    };
    ch.refCount += 1;
    ch.listeners.add(entry);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      ch.listeners.delete(entry);
      this._releaseChannel(ch);
    };
  }

  /**
   * Hot-path hook called by Simulator after Phase 1 + Phase 2 settle for a list of
   * changed integer signal IDs. Skips unwatched signals in O(1).
   */
  sampleChanged(changedSigIds, sigVal, sigX, sigZ, cycle, tick, phase = 'posedge') {
    this._lastTick = tick;
    if (this._activeWatcherCount === 0 || !changedSigIds || changedSigIds.length === 0) return;

    const watchersBySigId = this._watchersBySigId;
    for (let i = 0; i < changedSigIds.length; i++) {
      const sigId = changedSigIds[i];
      const channels = watchersBySigId[sigId];
      if (!channels) continue;

      for (let c = 0; c < channels.length; c++) {
        const ch = channels[c];
        const nextBit = _ebReadBit(sigId, ch.bitShift, sigVal, sigX, sigZ);
        const prevBit = ch.lastLevel;

        if (tick > ch.lastSampleTick && prevBit !== null) {
          const dt = tick - ch.lastSampleTick;
          ch.totalTrackedTicks += dt;
          if (prevBit === 1) {
            ch.totalHighTicks += dt;
          }
        }
        ch.lastSampleTick = tick;

        if (nextBit === prevBit) continue;
        ch.lastLevel = nextBit;

        // Only emit clean 0 -> 1 (posedge) or 1 -> 0 (negedge) transitions
        if (prevBit === null || nextBit === null) {
          continue;
        }

        const edge = nextBit === 1 ? 'posedge' : 'negedge';
        ch.edgeCount += 1;
        let pulseWidthCycles = null;

        if (edge === 'posedge') {
          ch.risingCount += 1;
          if (ch.lastEdgeTick !== null) {
            ch.lastLowTicks = tick - ch.lastEdgeTick;
            ch.lowCycles = ch.lastLowTicks / 2;
            pulseWidthCycles = ch.lowCycles;
          }
        } else {
          ch.fallingCount += 1;
          if (ch.lastEdgeTick !== null) {
            ch.lastHighTicks = tick - ch.lastEdgeTick;
            ch.highCycles = ch.lastHighTicks / 2;
            pulseWidthCycles = ch.highCycles;
          }
        }

        ch.lastEdgeTick = tick;

        if (ch.lastHighTicks > 0 && ch.lastLowTicks > 0) {
          const totalPeriodTicks = ch.lastHighTicks + ch.lastLowTicks;
          ch.periodCycles = totalPeriodTicks / 2;
          ch.dutyCycle = ch.lastHighTicks / totalPeriodTicks;
        }

        const event = {
          signal: ch.signal,
          bit: ch.bit,
          edge,
          prevBit,
          bitValue: nextBit,
          cycle,
          tick,
          phase,
          pulseWidthCycles,
          highCycles: ch.highCycles,
          lowCycles: ch.lowCycles,
          periodCycles: ch.periodCycles,
          dutyCycle: ch.dutyCycle,
        };

        if (this._capturingBatch && this._batchEvents.length < this._maxBatchEvents) {
          this._batchEvents.push(event);
        }

        for (const sub of ch.listeners) {
          if (sub.callback && (sub.edge === 'both' || sub.edge === edge)) {
            sub.callback(event);
          }
        }
      }
    }
  }

  /**
   * Advance scheduled cycle-based bit samplers (e.g. async UART receivers) on each tick.
   */
  advanceTick(sigVal, sigX, sigZ, cycle, tick, phase = 'posedge') {
    this._lastTick = tick;
    if (this._activeScheduledCount === 0) return;
    for (const sampler of this._scheduledSamplers) {
      sampler._onTick(sigVal, sigX, sigZ, cycle, tick, phase);
    }
  }

  /**
   * Query live channel pulse/duty-cycle statistics.
   *
   * @param {string} signalSpec
   * @param {number|null} [clockFreqHz=null]
   * @param {number} [bit=0]
   */
  getChannelStats(signalSpec, clockFreqHz = null, bit = 0) {
    const parsed = parseSignalSpec(signalSpec, bit);
    const ch = this._channelsByKey.get(parsed.key);
    if (!ch) return null;

    // Include trailing time since last sample up to current simulation tick
    let totalTrackedTicks = ch.totalTrackedTicks;
    let totalHighTicks = ch.totalHighTicks;
    if (this._lastTick > ch.lastSampleTick && ch.lastLevel !== null) {
      const dt = this._lastTick - ch.lastSampleTick;
      totalTrackedTicks += dt;
      if (ch.lastLevel === 1) totalHighTicks += dt;
    }

    const averageDutyCycle = totalTrackedTicks > 0 ? totalHighTicks / totalTrackedTicks : 0;
    const hasFullPeriod = ch.lastHighTicks > 0 && ch.lastLowTicks > 0;
    const dutyCycle = hasFullPeriod
      ? ch.dutyCycle
      : (totalTrackedTicks > 0 ? averageDutyCycle : 0);
    const periodCycles = hasFullPeriod ? ch.periodCycles : 0;
    const frequencyHz =
      clockFreqHz && periodCycles > 0 ? Number(clockFreqHz) / periodCycles : 0;

    return {
      signal: ch.signal,
      bit: ch.bit,
      valid: hasFullPeriod,
      highCycles: ch.highCycles,
      lowCycles: ch.lowCycles,
      periodCycles,
      dutyCycle,
      dutyPct: dutyCycle * 100,
      averageDutyCycle,
      frequencyHz,
      edgeCount: ch.edgeCount,
      risingCount: ch.risingCount,
      fallingCount: ch.fallingCount,
      currentLevel: ch.lastLevel,
    };
  }

  /**
   * Create a PWM / Servo / Piezo Buzzer duty-cycle & period monitor on a signal.
   *
   * @param {string} signalSpec
   * @param {{ bit?: number, onEdge?: (event: object, metrics: object) => void }} [options={}]
   */
  createPwmMonitor(signalSpec, options = {}) {
    const parsed = parseSignalSpec(signalSpec, options.bit ?? 0);
    const ch = this._getOrCreateChannel(parsed.signal, parsed.bit);

    const onEdgeCb = typeof options.onEdge === 'function' ? options.onEdge : null;
    const unsubscribe = this.subscribe(
      parsed.signal,
      (ev) => {
        if (onEdgeCb) {
          onEdgeCb(ev, this.getChannelStats(parsed.signal, null, parsed.bit));
        }
      },
      { bit: parsed.bit, edge: 'both' }
    );

    return {
      signal: parsed.signal,
      bit: parsed.bit,
      getMetrics: (clockFreqHz = null) => this.getChannelStats(parsed.signal, clockFreqHz, parsed.bit),
      reset: () => {
        ch.lastEdgeTick = null;
        ch.lastHighTicks = 0;
        ch.lastLowTicks = 0;
        ch.highCycles = 0;
        ch.lowCycles = 0;
        ch.periodCycles = 0;
        ch.dutyCycle = 0;
        ch.totalHighTicks = 0;
        ch.totalTrackedTicks = 0;
        ch.lastSampleTick = this._lastTick;
        ch.edgeCount = 0;
        ch.risingCount = 0;
        ch.fallingCount = 0;
      },
      dispose: () => unsubscribe(),
    };
  }

  /**
   * Create a UART (async start-bit + cycle divider) or SPI (clocked synchronous) bit sampler.
   *
   * @param {string} dataSignalSpec
   * @param {object} [options={}]
   * @param {'uart'|'sync'} [options.mode]
   * @param {number} [options.bit=0]
   * @param {number} [options.cyclesPerBit=16]
   * @param {number} [options.dataBits=8]
   * @param {boolean} [options.msbFirst]
   * @param {'negedge'|'posedge'} [options.startEdge='negedge']
   * @param {string} [options.clockSignal]
   * @param {'posedge'|'negedge'} [options.clockEdge='posedge']
   * @param {(bit: number|null, bitIndex: number, meta: object) => void} [options.onBit]
   * @param {(byteVal: number, meta: object) => void} [options.onByte]
   */
  createBitSampler(dataSignalSpec, options = {}) {
    const dataParsed = parseSignalSpec(dataSignalSpec, options.bit ?? 0);
    const mode = options.mode || (options.clockSignal ? 'sync' : 'uart');
    const dataBits = Math.max(1, options.dataBits ?? 8);
    const onBit = typeof options.onBit === 'function' ? options.onBit : null;
    const onByte = typeof options.onByte === 'function' ? options.onByte : null;
    const bytes = [];

    if (mode === 'sync' && options.clockSignal) {
      const clkParsed = parseSignalSpec(options.clockSignal, options.clockBit ?? 0);
      const clockEdge = options.clockEdge || 'posedge';
      const msbFirst = options.msbFirst !== undefined ? Boolean(options.msbFirst) : true;
      let shiftReg = 0;
      let bitCount = 0;
      let dataSigId = this._nameToId.has(dataParsed.signal) ? this._nameToId.get(dataParsed.signal) : -1;
      let dataShift = BigInt(dataParsed.bit);
      let latestSigRef = null;

      const samplerRecord = {
        _rebind: (nameToId, sigMeta) => {
          dataSigId = nameToId.has(dataParsed.signal) ? nameToId.get(dataParsed.signal) : -1;
          const meta = dataSigId >= 0 ? sigMeta[dataSigId] : null;
          const baseLsb = meta?.baseLsb ?? 0;
          dataShift = BigInt(Math.max(0, dataParsed.bit - baseLsb));
        },
        _onTick: (sigVal, sigX, sigZ) => {
          latestSigRef = { sigVal, sigX, sigZ };
        },
        reset: () => {
          shiftReg = 0;
          bitCount = 0;
        },
      };
      samplerRecord._rebind(this._nameToId, this._sigMeta);
      this._scheduledSamplers.add(samplerRecord);
      this._activeScheduledCount = this._scheduledSamplers.size;

      const unsubClk = this.subscribe(
        clkParsed.signal,
        (ev) => {
          if (!latestSigRef || dataSigId < 0) return;
          const bitVal = _ebReadBit(
            dataSigId,
            dataShift,
            latestSigRef.sigVal,
            latestSigRef.sigX,
            latestSigRef.sigZ
          );
          const normBit = bitVal === 1 ? 1 : 0;
          if (msbFirst) {
            shiftReg = (shiftReg << 1) | normBit;
          } else {
            shiftReg |= normBit << bitCount;
          }
          if (onBit) onBit(bitVal, bitCount, { cycle: ev.cycle, tick: ev.tick });
          bitCount += 1;
          if (bitCount === dataBits) {
            const word = shiftReg;
            bytes.push(word);
            if (onByte) onByte(word, { cycle: ev.cycle, tick: ev.tick });
            shiftReg = 0;
            bitCount = 0;
          }
        },
        { bit: clkParsed.bit, edge: clockEdge }
      );

      return {
        getBytes: () => [...bytes],
        clear: () => { bytes.length = 0; },
        reset: () => {
          bytes.length = 0;
          samplerRecord.reset();
        },
        dispose: () => {
          unsubClk();
          this._scheduledSamplers.delete(samplerRecord);
          this._activeScheduledCount = this._scheduledSamplers.size;
        },
      };
    }

    // Async UART frame sampler (8N1 default)
    const cyclesPerBit = Math.max(1, Number(options.cyclesPerBit ?? 16));
    const msbFirst = Boolean(options.msbFirst ?? false);
    const startEdge = options.startEdge || 'negedge';

    let dataSigId = -1;
    let dataShift = BigInt(dataParsed.bit);
    let inFrame = false;
    let startTick = 0;
    let nextBitIdx = 0;
    let nextSampleTick = 0;
    let shiftReg = 0;

    const samplerRecord = {
      _rebind: (nameToId, sigMeta) => {
        dataSigId = nameToId.has(dataParsed.signal) ? nameToId.get(dataParsed.signal) : -1;
        const meta = dataSigId >= 0 ? sigMeta[dataSigId] : null;
        const baseLsb = meta?.baseLsb ?? 0;
        dataShift = BigInt(Math.max(0, dataParsed.bit - baseLsb));
      },
      _onTick: (sigVal, sigX, sigZ, cycle, tick) => {
        if (!inFrame || dataSigId < 0 || tick < nextSampleTick) return;

        const bitVal = _ebReadBit(dataSigId, dataShift, sigVal, sigX, sigZ);
        if (nextBitIdx < dataBits) {
          const normBit = bitVal === 1 ? 1 : 0;
          if (msbFirst) {
            shiftReg = (shiftReg << 1) | normBit;
          } else {
            shiftReg |= normBit << nextBitIdx;
          }
          if (onBit) onBit(bitVal, nextBitIdx, { cycle, tick });
          nextBitIdx += 1;
          nextSampleTick = startTick + Math.round((1.5 + nextBitIdx) * cyclesPerBit * 2);
        } else {
          // Stop bit sampled -> frame complete
          const framingError = bitVal !== 1;
          const word = shiftReg;
          bytes.push(word);
          if (onByte) onByte(word, { cycle, tick, framingError });
          inFrame = false;
          shiftReg = 0;
          nextBitIdx = 0;
        }
      },
      reset: () => {
        inFrame = false;
        startTick = 0;
        nextBitIdx = 0;
        nextSampleTick = 0;
        shiftReg = 0;
      },
    };
    samplerRecord._rebind(this._nameToId, this._sigMeta);
    this._scheduledSamplers.add(samplerRecord);
    this._activeScheduledCount = this._scheduledSamplers.size;

    const unsubStart = this.subscribe(
      dataParsed.signal,
      (ev) => {
        if (inFrame) return;
        inFrame = true;
        startTick = ev.tick;
        nextBitIdx = 0;
        shiftReg = 0;
        nextSampleTick = startTick + Math.round(1.5 * cyclesPerBit * 2);
      },
      { bit: dataParsed.bit, edge: startEdge }
    );

    return {
      getBytes: () => [...bytes],
      clear: () => { bytes.length = 0; },
      reset: () => {
        bytes.length = 0;
        samplerRecord.reset();
      },
      dispose: () => {
        unsubStart();
        this._scheduledSamplers.delete(samplerRecord);
        this._activeScheduledCount = this._scheduledSamplers.size;
      },
    };
  }
}
