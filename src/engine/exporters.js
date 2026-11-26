/**
 * Phase C (v3.0) — Hardware Exporters & Workspace Persistence (SPEC Section 11)
 * Zero-dependency IEEE 1364 .vcd waveform generator (GTKWave compatible),
 * authentic FPGA pin constraint pack exporter (.qsf / .xdc / .ucf / .pcf),
 * .lab.json workspace serializer/validator, and file://-safe Blob helpers.
 */

import { sanitizeHdlText } from './preprocessor.js';
import { parse } from './parser.js';
import { selectTopModule } from './synthesizer.js';
import { getBoardProfile } from '../boards/registry.js';

export const WORKSPACE_SCHEMA_VERSION = 3;

// ============================================================================
// 1. IEEE 1364 .VCD Waveform Generator (GTKWave Compatible)
// ============================================================================

function _expVcdIdCode(index) {
  // Printable ASCII '!' (33) .. '~' (126) => radix-94 compact VCD identifiers
  let n = index;
  let code = '';
  do {
    code = String.fromCharCode(33 + (n % 94)) + code;
    n = Math.floor(n / 94) - 1;
  } while (n >= 0);
  return code;
}

function _expFormatVcdValue(sigVal, width) {
  const w = Math.max(1, width | 0);
  if (!sigVal) {
    return w === 1 ? 'x' : `b${'x'.repeat(w)}`;
  }
  const val = BigInt(sigVal.val ?? 0n);
  const xMask = BigInt(sigVal.xMask ?? 0n);
  const zMask = BigInt(sigVal.zMask ?? 0n);

  if (w === 1) {
    if (zMask & 1n) return 'z';
    if (xMask & 1n) return 'x';
    return (val & 1n) ? '1' : '0';
  }

  let bits = '';
  for (let i = w - 1; i >= 0; i--) {
    const bit = 1n << BigInt(i);
    if (zMask & bit) bits += 'z';
    else if (xMask & bit) bits += 'x';
    else bits += (val & bit) ? '1' : '0';
  }
  return `b${bits}`;
}

function _expEmitVcdTransition(valStr, idCode, width) {
  return width === 1 ? `${valStr}${idCode}` : `${valStr} ${idCode}`;
}

function _expNormalizeSamples(waveformBuffer) {
  if (!waveformBuffer) return { samples: [], signalDefs: [] };

  // Support WaveformViewer instance directly via getSampleCount()/getSample()
  if (typeof waveformBuffer.getSampleCount === 'function' && typeof waveformBuffer.getSample === 'function') {
    const count = waveformBuffer.getSampleCount();
    const samples = [];
    for (let i = 0; i < count; i++) {
      const s = waveformBuffer.getSample(i);
      if (s) samples.push(s);
    }
    const signalDefs = Array.isArray(waveformBuffer._signals)
      ? waveformBuffer._signals.map((s) => ({ name: s.name, width: s.width ?? 1 }))
      : [];
    return { samples, signalDefs };
  }

  if (Array.isArray(waveformBuffer)) {
    return { samples: waveformBuffer, signalDefs: [] };
  }

  if (Array.isArray(waveformBuffer.samples)) {
    return { samples: waveformBuffer.samples, signalDefs: waveformBuffer.signals || [] };
  }

  return { samples: [], signalDefs: [] };
}

/**
 * Generate a standards-compliant IEEE 1364 .vcd (Value Change Dump) string
 * from a WaveformViewer instance or array of signal snapshots.
 *
 * @param {object|Array<object>} waveformBuffer
 * @param {{ moduleName?: string, timescale?: string, stepNs?: number, date?: string, version?: string, signals?: Array<{name: string, width: number}> }} [meta={}]
 * @returns {string}
 */
export function exportVCD(waveformBuffer, meta = {}) {
  const { samples, signalDefs } = _expNormalizeSamples(waveformBuffer);
  const topModule = String(meta.moduleName || 'top').replace(/[^a-zA-Z0-9_]/g, '_') || 'top';
  const timescale = meta.timescale || '1ns';
  const stepNs = Math.max(1, Number(meta.stepNs ?? 10) | 0);
  const dateStr = meta.date || new Date().toISOString();
  const versionStr = meta.version || 'Virtual FPGA Simulator v3.0';

  // Build ordered signal catalog from metadata + observed samples
  const sigMap = new Map();
  for (const def of (meta.signals || signalDefs)) {
    if (def && def.name && !sigMap.has(def.name)) {
      sigMap.set(def.name, { name: def.name, width: Math.max(1, def.width || 1) });
    }
  }
  for (const sample of samples) {
    if (!sample || !sample.signals) continue;
    for (const [name, val] of Object.entries(sample.signals)) {
      if (!sigMap.has(name)) {
        sigMap.set(name, { name, width: Math.max(1, val?.width || 1) });
      }
    }
  }

  // Assign compact VCD ID codes & build hierarchical scope tree
  const entries = [];
  const rootScope = { name: topModule, vars: [], children: new Map() };
  let idIdx = 0;

  for (const sig of sigMap.values()) {
    const idCode = _expVcdIdCode(idIdx++);
    const parts = sig.name.split('.');
    const localName = parts[parts.length - 1];
    let scopeNode = rootScope;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      if (!scopeNode.children.has(seg)) {
        scopeNode.children.set(seg, { name: seg, vars: [], children: new Map() });
      }
      scopeNode = scopeNode.children.get(seg);
    }
    const entry = { fullName: sig.name, localName, width: sig.width, idCode };
    scopeNode.vars.push(entry);
    entries.push(entry);
  }

  const lines = [
    '$date',
    `  ${dateStr}`,
    '$end',
    '$version',
    `  ${versionStr}`,
    '$end',
    '$timescale',
    `  ${timescale}`,
    '$end',
  ];

  const emitScope = (node) => {
    lines.push(`$scope module ${node.name} $end`);
    for (const v of node.vars) {
      const ref = v.width > 1 ? `${v.localName} [${v.width - 1}:0]` : v.localName;
      lines.push(`$var wire ${v.width} ${v.idCode} ${ref} $end`);
    }
    for (const child of node.children.values()) {
      emitScope(child);
    }
    lines.push('$upscope $end');
  };

  emitScope(rootScope);
  lines.push('$enddefinitions $end');

  if (samples.length === 0) {
    lines.push('#0');
    lines.push('$dumpvars');
    for (const e of entries) {
      lines.push(_expEmitVcdTransition(_expFormatVcdValue(null, e.width), e.idCode, e.width));
    }
    lines.push('$end');
    return `${lines.join('\n')}\n`;
  }

  // Emit #0 initial $dumpvars & strictly monotonic delta-encoded timestamps
  const prevEncoded = new Map();
  let lastTs = 0;

  for (let sIdx = 0; sIdx < samples.length; sIdx++) {
    const sample = samples[sIdx];
    const sigs = sample.signals || {};

    if (sIdx === 0) {
      const firstTs = typeof sample.timestamp === 'number'
        ? sample.timestamp
        : (typeof sample.time === 'number' ? sample.time : 0);
      lastTs = firstTs >= 0 ? Math.floor(firstTs) : 0;
      lines.push(`#${lastTs}`);
      lines.push('$dumpvars');
      for (const e of entries) {
        const valStr = _expFormatVcdValue(sigs[e.fullName], e.width);
        prevEncoded.set(e.fullName, valStr);
        lines.push(_expEmitVcdTransition(valStr, e.idCode, e.width));
      }
      lines.push('$end');
      continue;
    }

    const explicitTs = typeof sample.timestamp === 'number'
      ? sample.timestamp
      : (typeof sample.time === 'number' ? sample.time : null);
    const rawTs = explicitTs !== null
      ? Math.floor(explicitTs)
      : lastTs + stepNs;
    const ts = rawTs > lastTs ? rawTs : lastTs + stepNs;

    const deltas = [];
    for (const e of entries) {
      const valStr = _expFormatVcdValue(sigs[e.fullName], e.width);
      if (prevEncoded.get(e.fullName) !== valStr) {
        prevEncoded.set(e.fullName, valStr);
        deltas.push(_expEmitVcdTransition(valStr, e.idCode, e.width));
      }
    }

    if (deltas.length > 0) {
      lastTs = ts;
      lines.push(`#${ts}`);
      for (const d of deltas) lines.push(d);
    }
  }

  return `${lines.join('\n')}\n`;
}

// ============================================================================
// 2. Real FPGA Pin Constraint Exporter (.qsf / .xdc / .ucf / .pcf)
// ============================================================================

function _expResolvePinEntry(board, portName) {
  const pinMap = board.pinMap || {};
  if (portName in pinMap) {
    return { pinSpec: pinMap[portName], isClock: board.clock.aliases.includes(portName) };
  }

  // Match aliases from board clock, switches, buttons, LEDs, 7-seg, and headers
  if (board.clock.aliases.includes(portName) && board.clock.port in pinMap) {
    return { pinSpec: pinMap[board.clock.port], isClock: true };
  }

  const io = board.io;
  if (io.switches && io.switches.aliases.includes(portName) && io.switches.port in pinMap) {
    return { pinSpec: pinMap[io.switches.port], isClock: false };
  }
  if (io.buttons?.mode === 'vector' && io.buttons.aliases.includes(portName) && io.buttons.port in pinMap) {
    return { pinSpec: pinMap[io.buttons.port], isClock: false };
  }
  for (const bank of io.ledBanks || []) {
    if (bank.aliases.includes(portName) && bank.port in pinMap) {
      return { pinSpec: pinMap[bank.port], isClock: false };
    }
  }
  if (io.sevenSeg?.mode === 'multiplexed') {
    if (io.sevenSeg.anodeAliases.includes(portName) && io.sevenSeg.anodePort in pinMap) {
      return { pinSpec: pinMap[io.sevenSeg.anodePort], isClock: false };
    }
    if (io.sevenSeg.segAliases.includes(portName) && io.sevenSeg.segPort in pinMap) {
      return { pinSpec: pinMap[io.sevenSeg.segPort], isClock: false };
    }
    if (io.sevenSeg.dpAliases?.includes(portName) && io.sevenSeg.dpPort in pinMap) {
      return { pinSpec: pinMap[io.sevenSeg.dpPort], isClock: false };
    }
  }
  for (const hdr of io.headers || []) {
    if (hdr.aliases?.includes(portName) && hdr.port && hdr.port in pinMap) {
      return { pinSpec: pinMap[hdr.port], isClock: false };
    }
  }

  return null;
}

/**
 * Generate a synthesis-ready hardware constraint file (.qsf for DE2, .xdc for Basys 3,
 * .ucf for HDLab, or optional .pcf override) containing ONLY ports declared in `ast`.
 *
 * @param {string|object} boardOrId
 * @param {object|string} astOrSource
 * @param {{ format?: 'qsf'|'xdc'|'ucf'|'pcf' }} [options={}]
 */
export function exportConstraints(boardOrId, astOrSource, options = {}) {
  const board = typeof boardOrId === 'string' ? getBoardProfile(boardOrId) : (boardOrId || getBoardProfile());
  const ast = typeof astOrSource === 'string'
    ? (selectTopModule(astOrSource, 'board') || parse(astOrSource))
    : astOrSource;
  if (!ast || !Array.isArray(ast.ports)) {
    throw new Error('exportConstraints requires a valid compiled Module AST with ports');
  }

  const format = options.format || board.device.constraintFormat || 'qsf';
  const modName = ast.name || 'top';
  const lines = [];
  const unboundPorts = [];
  let mappedPinCount = 0;

  if (format === 'qsf') {
    lines.push(`# ============================================================`);
    lines.push(`# Intel Quartus II Pin Constraints (.qsf)`);
    lines.push(`# Board: ${board.defaultName} | Device: ${board.device.part}`);
    lines.push(`# Top-Level Entity: ${modName}`);
    lines.push(`# ============================================================`);
    lines.push(`set_global_assignment -name FAMILY "Cyclone II"`);
    lines.push(`set_global_assignment -name DEVICE ${board.device.part}`);
    lines.push(`set_global_assignment -name TOP_LEVEL_ENTITY ${modName}`);
    lines.push('');

    for (const port of ast.ports) {
      const resolved = _expResolvePinEntry(board, port.name);
      if (!resolved) {
        unboundPorts.push(port.name);
        lines.push(`# Unbound port: ${port.name} (${port.dir}, ${port.width}b)`);
        continue;
      }

      if (port.width <= 1 || !Array.isArray(resolved.pinSpec)) {
        const pin = Array.isArray(resolved.pinSpec) ? resolved.pinSpec[0] : resolved.pinSpec;
        lines.push(`set_location_assignment ${pin} -to ${port.name}`);
        mappedPinCount++;
      } else {
        const lsb = Math.min(port.msb ?? 0, port.lsb ?? 0);
        const count = Math.min(port.width, resolved.pinSpec.length - lsb);
        for (let i = 0; i < count; i++) {
          lines.push(`set_location_assignment ${resolved.pinSpec[lsb + i]} -to ${port.name}[${lsb + i}]`);
          mappedPinCount++;
        }
      }
    }
  } else if (format === 'xdc') {
    const clkPeriodNs = board.clock.freqHz ? (1e9 / board.clock.freqHz).toFixed(2) : '10.00';
    const halfPeriodNs = (Number(clkPeriodNs) / 2).toFixed(2);

    lines.push(`## ============================================================`);
    lines.push(`## AMD/Xilinx Vivado Constraints (.xdc)`);
    lines.push(`## Board: ${board.defaultName} | Device: ${board.device.part}`);
    lines.push(`## Top-Level Module: ${modName}`);
    lines.push(`## ============================================================`);
    lines.push('');

    for (const port of ast.ports) {
      const resolved = _expResolvePinEntry(board, port.name);
      if (!resolved) {
        unboundPorts.push(port.name);
        lines.push(`## Unbound port: ${port.name} (${port.dir}, ${port.width}b)`);
        continue;
      }

      if (port.width <= 1 || !Array.isArray(resolved.pinSpec)) {
        const pin = Array.isArray(resolved.pinSpec) ? resolved.pinSpec[0] : resolved.pinSpec;
        lines.push(`set_property PACKAGE_PIN ${pin} [get_ports {${port.name}}]`);
        lines.push(`set_property IOSTANDARD LVCMOS33 [get_ports {${port.name}}]`);
        if (resolved.isClock) {
          lines.push(`create_clock -add -name sys_clk_pin -period ${clkPeriodNs} -waveform {0 ${halfPeriodNs}} [get_ports {${port.name}}]`);
        }
        mappedPinCount++;
      } else {
        const lsb = Math.min(port.msb ?? 0, port.lsb ?? 0);
        const count = Math.min(port.width, resolved.pinSpec.length);
        for (let i = 0; i < count; i++) {
          const ref = `${port.name}[${lsb + i}]`;
          lines.push(`set_property PACKAGE_PIN ${resolved.pinSpec[i]} [get_ports {${ref}}]`);
          lines.push(`set_property IOSTANDARD LVCMOS33 [get_ports {${ref}}]`);
          mappedPinCount++;
        }
      }
    }
  } else if (format === 'ucf') {
    const clkPeriodNs = board.clock.freqHz ? (1e9 / board.clock.freqHz).toFixed(1) : '20.0';

    lines.push(`# ============================================================`);
    lines.push(`# Xilinx ISE User Constraints File (.ucf)`);
    lines.push(`# Board: ${board.defaultName} | Device: ${board.device.part}`);
    lines.push(`# Top-Level Module: ${modName}`);
    lines.push(`# ============================================================`);
    lines.push('');

    for (const port of ast.ports) {
      const resolved = _expResolvePinEntry(board, port.name);
      if (!resolved) {
        unboundPorts.push(port.name);
        lines.push(`# Unbound port: ${port.name} (${port.dir}, ${port.width}b)`);
        continue;
      }

      if (port.width <= 1 || !Array.isArray(resolved.pinSpec)) {
        const pin = Array.isArray(resolved.pinSpec) ? resolved.pinSpec[0] : resolved.pinSpec;
        lines.push(`NET "${port.name}" LOC = "${pin}" | IOSTANDARD = LVCMOS33;`);
        if (resolved.isClock) {
          lines.push(`NET "${port.name}" TNM_NET = "${port.name}";`);
          lines.push(`TIMESPEC TS_${port.name} = PERIOD "${port.name}" ${clkPeriodNs} ns HIGH 50%;`);
        }
        mappedPinCount++;
      } else {
        const lsb = Math.min(port.msb ?? 0, port.lsb ?? 0);
        const count = Math.min(port.width, resolved.pinSpec.length);
        for (let i = 0; i < count; i++) {
          lines.push(`NET "${port.name}<${lsb + i}>" LOC = "${resolved.pinSpec[i]}" | IOSTANDARD = LVCMOS33;`);
          mappedPinCount++;
        }
      }
    }
  } else {
    // Open-source iCE40 / nextpnr Physical Constraints File (.pcf)
    lines.push(`# Physical Constraints File (.pcf) — ${board.defaultName}`);
    lines.push(`# Top-Level Module: ${modName}`);
    lines.push('');

    for (const port of ast.ports) {
      const resolved = _expResolvePinEntry(board, port.name);
      if (!resolved) {
        unboundPorts.push(port.name);
        lines.push(`# Unbound port: ${port.name} (${port.dir}, ${port.width}b)`);
        continue;
      }
      if (port.width <= 1 || !Array.isArray(resolved.pinSpec)) {
        const pin = Array.isArray(resolved.pinSpec) ? resolved.pinSpec[0] : resolved.pinSpec;
        lines.push(`set_io ${port.name} ${pin}`);
        mappedPinCount++;
      } else {
        const lsb = Math.min(port.msb ?? 0, port.lsb ?? 0);
        const count = Math.min(port.width, resolved.pinSpec.length);
        for (let i = 0; i < count; i++) {
          lines.push(`set_io ${port.name}[${lsb + i}] ${resolved.pinSpec[i]}`);
          mappedPinCount++;
        }
      }
    }
  }

  return {
    format,
    extension: `.${format}`,
    filename: `${modName}.${format}`,
    boardId: board.id,
    deviceName: board.device.name,
    mappedPinCount,
    unboundPorts,
    content: `${lines.join('\n')}\n`,
  };
}

// ============================================================================
// 3. Workspace Persistence (.lab.json)
// ============================================================================

/**
 * Serialize current Virtual FPGA Simulator workspace into a versioned `.lab.json` string.
 * @param {object} state
 * @returns {string}
 */
export function serializeWorkspace(state = {}) {
  const activePeripherals = Array.isArray(state.activePeripherals)
    ? state.activePeripherals.map((p) => ({
      id: String(p.id || ''),
      config: p.config && typeof p.config === 'object' ? { ...p.config } : {},
      bindings: p.bindings && typeof p.bindings === 'object' ? { ...p.bindings } : {},
    }))
    : [];

  const pinBindings = state.pinBindings && typeof state.pinBindings === 'object'
    ? { ...state.pinBindings }
    : {};

  // Mirror peripheral bindings into top-level pinBindings map if not already supplied
  activePeripherals.forEach((p, idx) => {
    const key = `${p.id}#${idx}`;
    if (!(key in pinBindings) && Object.keys(p.bindings).length > 0) {
      pinBindings[key] = { ...p.bindings };
    }
  });

  // v3.1 Multi-file workspace array (with full backward-compatible hdlCode mirror)
  let files;
  if (Array.isArray(state.files) && state.files.length > 0) {
    files = state.files.map((f, idx) => ({
      name: String(f?.name || `file_${idx + 1}.sv`),
      content: sanitizeHdlText(f?.content ?? ''),
    }));
  } else {
    const fallbackName = state.filename ? String(state.filename) : 'main.sv';
    files = [{ name: fallbackName, content: sanitizeHdlText(state.hdlCode ?? '') }];
  }

  const activeFile = state.activeFile && files.some((f) => f.name === state.activeFile)
    ? String(state.activeFile)
    : files[0].name;
  const activeRecord = files.find((f) => f.name === activeFile) || files[0];

  const payload = {
    version: WORKSPACE_SCHEMA_VERSION,
    app: 'virtual-fpga-sim',
    savedAt: state.savedAt || new Date().toISOString(),
    boardId: String(state.boardId || 'de2'),
    simMode: state.simMode === 'testbench' ? 'testbench' : 'board',
    clockMode: String(state.clockMode ?? '5'),
    files,
    activeFile,
    hdlCode: activeRecord.content,
    filename: state.filename ? String(state.filename) : activeFile,
    presetId: state.presetId ? String(state.presetId) : null,
    activePeripherals,
    pinBindings,
    memoryHex: state.memoryHex && typeof state.memoryHex === 'object' ? { ...state.memoryHex } : {},
    language: state.language === 'en' ? 'en' : 'vi',
  };

  return `${JSON.stringify(payload, null, 2)}\n`;
}

/**
 * Parse and validate a `.lab.json` workspace payload (v1, v2, and v3 multi-file).
 * Throws a clear Error on corrupt JSON, invalid schema, or missing HDL source.
 *
 * @param {string|object} jsonInput
 * @returns {object}
 */
export function deserializeWorkspace(jsonInput) {
  let raw;
  if (typeof jsonInput === 'string') {
    try {
      raw = JSON.parse(jsonInput);
    } catch (err) {
      throw new Error(`Corrupt .lab.json file: invalid JSON (${err.message})`);
    }
  } else if (jsonInput && typeof jsonInput === 'object') {
    raw = jsonInput;
  } else {
    throw new Error('Invalid .lab.json workspace: expected a JSON string or object');
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid .lab.json workspace: root value must be a JSON object');
  }

  const version = Number(raw.version ?? raw.schemaVersion);
  if (!Number.isInteger(version) || version < 1 || version > WORKSPACE_SCHEMA_VERSION) {
    throw new Error(`Unsupported .lab.json workspace version: '${raw.version ?? raw.schemaVersion}'`);
  }

  let files = null;
  let activeFile = null;
  let hdlCode = null;
  let filename = typeof raw.filename === 'string' ? raw.filename : null;

  if (Array.isArray(raw.files) && raw.files.length > 0) {
    files = [];
    for (let i = 0; i < raw.files.length; i++) {
      const entry = raw.files[i];
      if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string' || typeof entry.content !== 'string') {
        throw new Error(`Invalid .lab.json workspace: malformed files[${i}] entry (expected { name, content })`);
      }
      files.push({
        name: entry.name.trim() || `file_${i + 1}.sv`,
        content: sanitizeHdlText(entry.content),
      });
    }
    activeFile = typeof raw.activeFile === 'string' && files.some((f) => f.name === raw.activeFile)
      ? raw.activeFile
      : files[0].name;
    const activeRec = files.find((f) => f.name === activeFile) || files[0];
    hdlCode = activeRec.content;
    if (!filename) filename = activeFile;
  } else {
    const rawHdl = typeof raw.hdlCode === 'string'
      ? raw.hdlCode
      : (typeof raw.hdlSource === 'string' ? raw.hdlSource : null);
    if (rawHdl === null) {
      throw new Error('Invalid .lab.json workspace: missing string field "hdlCode"');
    }
    hdlCode = sanitizeHdlText(rawHdl);
    activeFile = typeof raw.activeFile === 'string' && raw.activeFile.trim()
      ? raw.activeFile.trim()
      : (filename && filename.trim() ? filename.trim() : 'main.sv');
    files = [{ name: activeFile, content: hdlCode }];
  }

  const boardId = typeof raw.boardId === 'string' && raw.boardId.trim()
    ? raw.boardId.trim()
    : 'de2';

  const clockMode = raw.clockMode !== undefined && raw.clockMode !== null
    ? String(raw.clockMode)
    : '5';

  const activePeripherals = Array.isArray(raw.activePeripherals)
    ? raw.activePeripherals
      .filter((p) => p && typeof p === 'object' && typeof p.id === 'string' && p.id.trim().length > 0)
      .map((p) => ({
        id: p.id.trim(),
        config: p.config && typeof p.config === 'object' ? { ...p.config } : {},
        bindings: p.bindings && typeof p.bindings === 'object' ? { ...p.bindings } : {},
      }))
    : [];

  const pinBindings = raw.pinBindings && typeof raw.pinBindings === 'object' && !Array.isArray(raw.pinBindings)
    ? { ...raw.pinBindings }
    : {};

  const memoryHex = raw.memoryHex && typeof raw.memoryHex === 'object' && !Array.isArray(raw.memoryHex)
    ? { ...raw.memoryHex }
    : {};

  return {
    version,
    boardId,
    simMode: raw.simMode === 'testbench' ? 'testbench' : 'board',
    clockMode,
    files,
    activeFile,
    hdlCode,
    filename,
    presetId: typeof raw.presetId === 'string' ? raw.presetId : null,
    activePeripherals,
    pinBindings,
    memoryHex,
    language: raw.language === 'en' ? 'en' : 'vi',
  };
}

// ============================================================================
// 4. Client-Side file://-Safe Download & File Import Helpers
// ============================================================================

/**
 * Trigger a client-side file download via Blob + ObjectURL (100% file:// safe).
 * Returns `{ filename, byteLength, downloaded }` cleanly in both browser and Node.js.
 *
 * @param {string} filename
 * @param {string} content
 * @param {string} [mimeType='text/plain;charset=utf-8']
 */
export function downloadTextFile(filename, content, mimeType = 'text/plain;charset=utf-8') {
  const text = String(content ?? '');
  const byteLength = typeof TextEncoder !== 'undefined'
    ? new TextEncoder().encode(text).length
    : text.length;

  if (typeof document === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') {
    return { filename, byteLength, downloaded: false };
  }

  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => {
    try { URL.revokeObjectURL(url); } catch { /* ignore */ }
  }, 1500);

  return { filename, byteLength, downloaded: true };
}

/**
 * Read UTF-8 text from an `<input type="file">` File object (100% file:// safe).
 * @param {File} file
 * @returns {Promise<string>}
 */
export function readTextFileFromInput(file) {
  if (!file) return Promise.reject(new Error('No file selected'));
  if (typeof file.text === 'function') {
    return file.text();
  }
  return new Promise((resolve, reject) => {
    if (typeof FileReader === 'undefined') {
      reject(new Error('FileReader API unavailable'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

/**
 * Read raw bytes from a File object (100% file:// safe) for binary/size validation.
 * @param {File} file
 * @returns {Promise<ArrayBuffer>}
 */
export function readBinaryFileFromInput(file) {
  if (!file) return Promise.reject(new Error('No file selected'));
  if (typeof file.arrayBuffer === 'function') {
    return file.arrayBuffer();
  }
  return new Promise((resolve, reject) => {
    if (typeof FileReader === 'undefined') {
      reject(new Error('FileReader API unavailable'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader.readAsArrayBuffer(file);
  });
}
