/**
 * Phase 2 / v2.0 — 4-State (0, 1, X, Z), Two-Phase Cycle-Accurate RTL Simulator
 * Features hierarchical elaboration, integer-indexed Flat Signal Table,
 * Dirty-Fanout combinational propagation, 2D unpacked memory arrays + Hex loader,
 * Time-Sliced Batch execution (stepCycles), and Protocol Edge Bus integration.
 */

import {
  createDiagnostic,
} from './lexer.js';
import {
  elaborate,
} from './parser.js';
import {
  EdgeBus,
} from './edge_bus.js';

export const CLOCK_PORT_ALIASES = Object.freeze(['CLOCK_50', 'CLK', 'clk']);
export const MAX_COMB_ITERATIONS = 64;

const _SIM_MAX_DELTA_PASSES = 32;
const _SIM_MAX_FUNC_DEPTH = 32;
const _SIM_BUDGET_CHECK_STRIDE = 64;

// Precomputed BigInt bitmasks for widths 0..128 to avoid repeated shift allocations
const _SIM_MASK_CACHE = new Array(129);
_SIM_MASK_CACHE[0] = 1n;
for (let _w = 1; _w <= 128; _w++) {
  _SIM_MASK_CACHE[_w] = (1n << BigInt(_w)) - 1n;
}

function _simMask(width) {
  const w = width <= 1 ? 1 : (width | 0);
  if (w <= 128) return _SIM_MASK_CACHE[w];
  return (1n << BigInt(w)) - 1n;
}

function _simNowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

/**
 * Create a normalized 4-state BigInt logic vector.
 * Invariant per bit:
 *   0 => val=0, x=0, z=0
 *   1 => val=1, x=0, z=0
 *   X => val=0, x=1, z=0
 *   Z => val=0, x=0, z=1
 *
 * @param {number} [width=1]
 * @param {bigint|number} [val=0n]
 * @param {bigint|number} [xMask=0n]
 * @param {bigint|number} [zMask=0n]
 */
export function createLogic4(width = 1, val = 0n, xMask = 0n, zMask = 0n) {
  const w = Math.max(1, width | 0);
  const mask = _simMask(w);
  const z = (typeof zMask === 'bigint' ? zMask : BigInt(zMask)) & mask;
  const x = ((typeof xMask === 'bigint' ? xMask : BigInt(xMask)) & mask) & ~z;
  const v = ((typeof val === 'bigint' ? val : BigInt(val)) & mask) & ~x & ~z;
  return { width: w, val: v, xMask: x, zMask: z };
}

export function makeAllX(width = 1) {
  const w = Math.max(1, width | 0);
  return { width: w, val: 0n, xMask: _simMask(w), zMask: 0n };
}

export function makeAllZ(width = 1) {
  const w = Math.max(1, width | 0);
  return { width: w, val: 0n, xMask: 0n, zMask: _simMask(w) };
}

function _simResize(v, targetWidth) {
  const w = targetWidth <= 1 ? 1 : (targetWidth | 0);
  if (v.width === w) return v;
  const mask = _simMask(w);
  const z = v.zMask & mask;
  const x = (v.xMask & mask) & ~z;
  const val = (v.val & mask) & ~x & ~z;
  return { width: w, val, xMask: x, zMask: z };
}

function _simEquals(a, b) {
  if (!a || !b) return false;
  return a.width === b.width && a.val === b.val && a.xMask === b.xMask && a.zMask === b.zMask;
}

function _simHasUnknown(v) {
  return (v.xMask | v.zMask) !== 0n;
}

/**
 * Format a 4-state Logic4 vector to a display string ('bin' | 'hex' | 'dec').
 */
export function logic4ToString(v, radix = 'hex') {
  if (!v) return 'X';
  if (radix === 'bin') {
    let s = '';
    for (let i = v.width - 1; i >= 0; i--) {
      const bit = 1n << BigInt(i);
      if (v.zMask & bit) s += 'Z';
      else if (v.xMask & bit) s += 'X';
      else s += (v.val & bit) ? '1' : '0';
    }
    return s;
  }
  if (radix === 'dec') {
    if (v.zMask === _simMask(v.width)) return 'Z';
    if (_simHasUnknown(v)) return 'X';
    return v.val.toString(10);
  }
  // Hex radix (4 bits per nibble)
  const nibbles = Math.ceil(v.width / 4);
  let out = '';
  for (let n = nibbles - 1; n >= 0; n--) {
    const shift = BigInt(n * 4);
    const nVal = (v.val >> shift) & 0xFn;
    const nX = (v.xMask >> shift) & 0xFn;
    const nZ = (v.zMask >> shift) & 0xFn;
    if (nX !== 0n) out += 'X';
    else if (nZ !== 0n) out += 'Z';
    else out += nVal.toString(16).toUpperCase();
  }
  return out;
}

/**
 * Extract 1-bit 4-state value at zero-based offset `bitOffset` from vector `v`.
 * Out-of-range returns 1-bit X.
 */
function _simGetBit(v, bitOffset) {
  if (bitOffset < 0 || bitOffset >= v.width) {
    return makeAllX(1);
  }
  const shift = BigInt(bitOffset);
  return {
    width: 1,
    val: (v.val >> shift) & 1n,
    xMask: (v.xMask >> shift) & 1n,
    zMask: (v.zMask >> shift) & 1n,
  };
}

/**
 * Determine Verilog truthiness of a Logic4 value:
 *   1n => known non-zero (at least one known '1' bit)
 *   0n => known zero (all bits known '0')
 *   null => unknown (no known '1' bit, at least one 'X'/'Z' bit)
 */
function _simTruthiness(v) {
  const knownOnes = v.val & ~(v.xMask | v.zMask);
  if (knownOnes !== 0n) return 1n;
  if (_simHasUnknown(v)) return null;
  return 0n;
}

function _simParseHexWord(rawWord, width) {
  let clean = rawWord.trim().replace(/_/g, '');
  if (clean.startsWith('0x') || clean.startsWith('0X')) {
    clean = clean.slice(2);
  }
  const mask = _simMask(width);
  let val = 0n;
  let xMask = 0n;
  let zMask = 0n;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i].toLowerCase();
    val <<= 4n;
    xMask <<= 4n;
    zMask <<= 4n;
    if (ch === 'x') {
      xMask |= 0xFn;
    } else if (ch === 'z' || ch === '?') {
      zMask |= 0xFn;
    } else if (/^[0-9a-f]$/.test(ch)) {
      val |= BigInt(parseInt(ch, 16));
    } else {
      return null;
    }
  }

  zMask &= mask;
  xMask = (xMask & mask) & ~zMask;
  val = (val & mask) & ~xMask & ~zMask;
  return { val, xMask, zMask };
}

export class Simulator {
  /**
   * @param {object|string|null} [ast=null]
   * @param {{ edgeBus?: EdgeBus, topModule?: string }} [options={}]
   */
  constructor(ast = null, options = {}) {
    this.ast = null;
    this.cycle = 0;
    this._halfTick = 0;
    this._simTime = 0;
    this._skipInitial = Boolean(options.skipInitial);
    this._ieeeEdges = Boolean(options.ieeeEdges);
    this.halted = false;
    this.runtimeError = null;
    this.clockPort = 'CLOCK_50';

    // Flat Signal Table (integer ID 0..sigCount-1)
    this.sigCount = 0;
    this.sigNames = [];
    this.nameToId = new Map();
    this.sigMeta = [];
    this.sigVal = [];
    this.sigX = [];
    this.sigZ = [];

    // 2D Unpacked Memory Arrays
    this.memCount = 0;
    this.memNames = [];
    this.memNameToId = new Map();
    this.memList = [];

    // Compiled combinational/sequential structures, functions & dirty-fanout tables
    this._combNodes = [];
    this._seqBlocks = [];
    this._functions = {};
    this._funcReadSigs = new Map();
    this._funcReadMems = new Map();
    this._sigFanout = [];
    this._memFanout = [];
    this._portWiringFanout = [];
    this._seqTriggersBySig = [];
    this._isSeqSensitive = new Uint8Array(0);

    // Pre-allocated generation-stamped staging buffers (zero Map copies in hot loop)
    this._nbaVal = [];
    this._nbaX = [];
    this._nbaZ = [];
    this._nbaStamp = new Uint32Array(0);
    this._nbaGen = 1;
    this._nbaDirtyIds = [];

    this._blkVal = [];
    this._blkX = [];
    this._blkZ = [];
    this._blkStamp = new Uint32Array(0);
    this._blkGen = 1;
    this._blkDirtyIds = [];

    this._seqCommitVal = [];
    this._seqCommitX = [];
    this._seqCommitZ = [];
    this._seqCommitStamp = new Uint32Array(0);
    this._seqCommitGen = 1;
    this._seqCommitIds = [];

    this._workVal = [];
    this._workX = [];
    this._workZ = [];
    this._workStamp = new Uint32Array(0);
    this._workGen = 1;
    this._workDirtyIds = [];

    this._edgePrevVal = [];
    this._edgePrevX = [];
    this._edgePrevZ = [];
    this._edgePrevStamp = new Uint32Array(0);
    this._edgePrevGen = 1;

    this._combQueued = new Uint8Array(0);
    this._combSeenStamp = new Uint32Array(0);
    this._combSeenGen = 1;
    this._seqTrigStamp = new Uint32Array(0);
    this._seqTrigGen = 1;
    this._tickChangedStamp = new Uint32Array(0);
    this._tickChangedGen = 1;
    this._memNbaWrites = [];

    // Protocol Edge Bus (zero overhead when idle)
    this.edgeBus = options.edgeBus instanceof EdgeBus ? options.edgeBus : new EdgeBus();

    if (ast) {
      this.compile(ast, options);
    }
  }

  /**
   * Access the attached Protocol Edge Bus for subscribing peripheral monitors.
   */
  getEdgeBus() {
    return this.edgeBus;
  }

  /**
   * Look up the flat integer signal ID (`-1` if undeclared).
   * @param {string} name
   */
  getSignalId(name) {
    const id = this.nameToId.get(name);
    return id === undefined ? -1 : id;
  }

  /**
   * Elaborate, flatten, bind integer IDs, build dirty-fanout graphs, and initialize state.
   *
   * @param {object|string} astOrSource
   * @param {{ topModule?: string }} [options={}]
   */
  compile(astOrSource, options = {}) {
    this.ast = elaborate(astOrSource, options);
    this._buildFlatTables();
    this.clockPort = this._detectClockPort();
    this.edgeBus.bindSignalMap(this.nameToId, this.sigMeta);
    this.reset();
    return this;
  }

  _buildFlatTables() {
    this.sigNames = [];
    this.nameToId = new Map();
    this.sigMeta = [];

    for (const [name, info] of Object.entries(this.ast.signals || {})) {
      const id = this.sigNames.length;
      const width = Math.max(1, info.width || 1);
      const baseLsb = Math.min(info.msb ?? 0, info.lsb ?? 0);
      this.sigNames.push(name);
      this.nameToId.set(name, id);
      this.sigMeta.push({
        id,
        name,
        dir: info.dir || 'internal',
        portDir: info.portDir || null,
        storage: info.storage || 'wire',
        width,
        msb: info.msb ?? (width - 1),
        lsb: info.lsb ?? 0,
        baseLsb,
        mask: _simMask(width),
        isSigned: Boolean(info.isInteger || info.signed),
      });
    }

    this.sigCount = this.sigNames.length;

    // Build 2D memory table
    this.memNames = [];
    this.memNameToId = new Map();
    this.memList = [];

    for (const [name, mem] of Object.entries(this.ast.memories || {})) {
      const memId = this.memNames.length;
      const width = Math.max(1, mem.width || 1);
      const depth = Math.max(1, mem.depth || 1);
      const baseLsb = Math.min(mem.msb ?? 0, mem.lsb ?? 0);
      this.memNames.push(name);
      this.memNameToId.set(name, memId);
      this.memList.push({
        id: memId,
        name,
        localName: mem.localName || name,
        instancePath: mem.instancePath || '',
        storage: mem.storage || 'reg',
        width,
        msb: mem.msb ?? (width - 1),
        lsb: mem.lsb ?? 0,
        baseLsb,
        mask: _simMask(width),
        addrMsb: mem.addrMsb ?? 0,
        addrLsb: mem.addrLsb ?? (depth - 1),
        addrMin: mem.addrMin ?? 0,
        addrMax: mem.addrMax ?? (depth - 1),
        depth,
        val: new Array(depth).fill(0n),
        xMask: new Array(depth).fill(_simMask(width)),
        zMask: new Array(depth).fill(0n),
      });
    }
    this.memCount = this.memNames.length;

    // Ensure any undeclared identifier referenced in assigns/always gets a fallback signal slot
    const ensureSignalName = (name, defaultWidth = 1, defaultStorage = 'wire') => {
      if (!name || this.nameToId.has(name) || this.memNameToId.has(name)) return;
      if (this.ast.params && name in this.ast.params) return;
      const id = this.sigNames.length;
      const w = Math.max(1, defaultWidth);
      this.sigNames.push(name);
      this.nameToId.set(name, id);
      this.sigMeta.push({
        id,
        name,
        dir: 'internal',
        portDir: null,
        storage: defaultStorage,
        width: w,
        msb: w - 1,
        lsb: 0,
        baseLsb: 0,
        mask: _simMask(w),
        isSigned: w === 32 && defaultStorage === 'reg',
      });
      this.sigCount = this.sigNames.length;
    };

    const bindNodeIds = (node, readSigs, readMems) => {
      if (!node || typeof node !== 'object') return;
      switch (node.kind) {
        case 'Ident': {
          if (node.isLocal) {
            node._sigId = -1;
            break;
          }
          if (this.ast.params && node.name in this.ast.params) {
            node._paramVal = this.ast.params[node.name];
            node._sigId = -1;
          } else {
            ensureSignalName(node.name);
            node._sigId = this.nameToId.get(node.name) ?? -1;
            if (readSigs && node._sigId >= 0) readSigs.add(node._sigId);
          }
          break;
        }
        case 'BitSelect': {
          if (node.isLocal) {
            node._sigId = -1;
            node._memId = -1;
          } else if (this.memNameToId.has(node.name)) {
            node._memId = this.memNameToId.get(node.name);
            node._sigId = -1;
            if (readMems) readMems.add(node._memId);
          } else {
            ensureSignalName(node.name);
            node._sigId = this.nameToId.get(node.name) ?? -1;
            node._memId = -1;
            if (readSigs && node._sigId >= 0) readSigs.add(node._sigId);
          }
          bindNodeIds(node.index, readSigs, readMems);
          break;
        }
        case 'PartSelect': {
          if (node.isLocal) {
            node._sigId = -1;
          } else {
            ensureSignalName(node.name);
            node._sigId = this.nameToId.get(node.name) ?? -1;
            if (readSigs && node._sigId >= 0) readSigs.add(node._sigId);
          }
          bindNodeIds(node.msb, readSigs, readMems);
          bindNodeIds(node.lsb, readSigs, readMems);
          break;
        }
        case 'MemSelect': {
          node._memId = this.memNameToId.get(node.name) ?? -1;
          if (readMems && node._memId >= 0) readMems.add(node._memId);
          bindNodeIds(node.addr, readSigs, readMems);
          break;
        }
        case 'MemBitSelect': {
          node._memId = this.memNameToId.get(node.name) ?? -1;
          if (readMems && node._memId >= 0) readMems.add(node._memId);
          bindNodeIds(node.addr, readSigs, readMems);
          bindNodeIds(node.index, readSigs, readMems);
          break;
        }
        case 'MemPartSelect': {
          node._memId = this.memNameToId.get(node.name) ?? -1;
          if (readMems && node._memId >= 0) readMems.add(node._memId);
          bindNodeIds(node.addr, readSigs, readMems);
          bindNodeIds(node.msb, readSigs, readMems);
          bindNodeIds(node.lsb, readSigs, readMems);
          break;
        }
        case 'Concat':
          for (const p of node.parts) bindNodeIds(p, readSigs, readMems);
          break;
        case 'Repeat':
          bindNodeIds(node.count, readSigs, readMems);
          bindNodeIds(node.expr, readSigs, readMems);
          break;
        case 'Unary':
          bindNodeIds(node.operand, readSigs, readMems);
          break;
        case 'Binary':
          bindNodeIds(node.left, readSigs, readMems);
          bindNodeIds(node.right, readSigs, readMems);
          break;
        case 'Ternary':
          bindNodeIds(node.cond, readSigs, readMems);
          bindNodeIds(node.thenExpr, readSigs, readMems);
          bindNodeIds(node.elseExpr, readSigs, readMems);
          break;
        case 'FuncCall': {
          for (const arg of node.args || []) bindNodeIds(arg, readSigs, readMems);
          const fnSigs = this._funcReadSigs.get(node.name);
          if (readSigs && fnSigs) {
            for (const sid of fnSigs) readSigs.add(sid);
          }
          const fnMems = this._funcReadMems.get(node.name);
          if (readMems && fnMems) {
            for (const mid of fnMems) readMems.add(mid);
          }
          break;
        }
        case 'SysFunc':
          for (const arg of node.args || []) bindNodeIds(arg, readSigs, readMems);
          break;
      }
    };

    const bindTargetIds = (target, readSigs, readMems) => {
      if (!target) return;
      switch (target.kind) {
        case 'Ident':
          if (target.isLocal) {
            target._sigId = -1;
          } else {
            ensureSignalName(target.name);
            target._sigId = this.nameToId.get(target.name) ?? -1;
          }
          break;
        case 'BitSelect':
          if (target.isLocal) {
            target._sigId = -1;
            target._memId = -1;
          } else if (this.memNameToId.has(target.name)) {
            target._memId = this.memNameToId.get(target.name);
            target._sigId = -1;
          } else {
            ensureSignalName(target.name);
            target._sigId = this.nameToId.get(target.name) ?? -1;
            target._memId = -1;
          }
          bindNodeIds(target.index, readSigs, readMems);
          break;
        case 'PartSelect':
          if (target.isLocal) {
            target._sigId = -1;
          } else {
            ensureSignalName(target.name);
            target._sigId = this.nameToId.get(target.name) ?? -1;
          }
          bindNodeIds(target.msb, readSigs, readMems);
          bindNodeIds(target.lsb, readSigs, readMems);
          break;
        case 'MemSelect':
          target._memId = this.memNameToId.get(target.name) ?? -1;
          bindNodeIds(target.addr, readSigs, readMems);
          break;
        case 'MemBitSelect':
          target._memId = this.memNameToId.get(target.name) ?? -1;
          bindNodeIds(target.addr, readSigs, readMems);
          bindNodeIds(target.index, readSigs, readMems);
          break;
        case 'MemPartSelect':
          target._memId = this.memNameToId.get(target.name) ?? -1;
          bindNodeIds(target.addr, readSigs, readMems);
          bindNodeIds(target.msb, readSigs, readMems);
          bindNodeIds(target.lsb, readSigs, readMems);
          break;
        case 'Concat':
          for (const p of target.parts) bindTargetIds(p, readSigs, readMems);
          break;
      }
    };

    const bindStmtIds = (stmt, readSigs, readMems) => {
      if (!stmt || stmt.kind === 'Noop') return;
      switch (stmt.kind) {
        case 'Block':
          for (const s of stmt.statements) bindStmtIds(s, readSigs, readMems);
          break;
        case 'ProcAssign':
          bindTargetIds(stmt.target, readSigs, readMems);
          bindNodeIds(stmt.expr, readSigs, readMems);
          break;
        case 'If':
          bindNodeIds(stmt.cond, readSigs, readMems);
          bindStmtIds(stmt.thenBranch, readSigs, readMems);
          if (stmt.elseBranch) bindStmtIds(stmt.elseBranch, readSigs, readMems);
          break;
        case 'Case':
          bindNodeIds(stmt.expr, readSigs, readMems);
          for (const it of stmt.items) {
            for (const p of it.patterns) bindNodeIds(p, readSigs, readMems);
            bindStmtIds(it.stmt, readSigs, readMems);
          }
          if (stmt.defaultBranch) bindStmtIds(stmt.defaultBranch, readSigs, readMems);
          break;
        case 'For':
          ensureSignalName(stmt.loopVar, 32, 'reg');
          stmt._loopSigId = this.nameToId.get(stmt.loopVar) ?? -1;
          bindNodeIds(stmt.initExpr, readSigs, readMems);
          bindNodeIds(stmt.condExpr, readSigs, readMems);
          bindNodeIds(stmt.stepExpr, readSigs, readMems);
          bindStmtIds(stmt.body, readSigs, readMems);
          break;
        case 'Return':
          if (stmt.expr) bindNodeIds(stmt.expr, readSigs, readMems);
          break;
        case 'RepeatStmt':
          bindNodeIds(stmt.count, readSigs, readMems);
          bindStmtIds(stmt.body, readSigs, readMems);
          break;
        case 'Delay':
          if (stmt.delay) bindNodeIds(stmt.delay, readSigs, readMems);
          if (stmt.stmt) bindStmtIds(stmt.stmt, readSigs, readMems);
          break;
        case 'EventCtrl':
          for (const s of stmt.sensitivity || []) {
            ensureSignalName(s.signal);
            s._sigId = this.nameToId.get(s.signal) ?? -1;
            if (s.index) bindNodeIds(s.index, readSigs, readMems);
          }
          if (stmt.stmt) bindStmtIds(stmt.stmt, readSigs, readMems);
          break;
        case 'SystemCall':
          for (const a of stmt.args || []) bindNodeIds(a, readSigs, readMems);
          break;
      }
    };

    // Bind elaborated combinational function definitions first so FuncCall fanout is known
    this._functions = this.ast.functions || {};
    this._funcReadSigs = new Map();
    this._funcReadMems = new Map();
    for (const [fnName, fnDef] of Object.entries(this._functions)) {
      const fSigs = new Set();
      const fMems = new Set();
      bindStmtIds(fnDef.body, fSigs, fMems);
      this._funcReadSigs.set(fnName, fSigs);
      this._funcReadMems.set(fnName, fMems);
    }

    // Build combinational nodes & sequential blocks with bound integer IDs
    this._combNodes = [];
    this._seqBlocks = [];

    for (const assign of this.ast.assigns || []) {
      const readSigs = new Set();
      const readMems = new Set();
      bindTargetIds(assign.target, readSigs, readMems);
      bindNodeIds(assign.expr, readSigs, readMems);
      this._combNodes.push({
        id: this._combNodes.length,
        kind: 'assign',
        assign,
        isPortWiring: Boolean(assign.isPortWiring && assign.portWireDir === 'input'),
        readSigIds: [...readSigs],
        readMemIds: [...readMems],
      });
    }

    // Structural primitive gates (and, or, not, nand, nor, xor, xnor, buf)
    for (const gate of this.ast.gates || []) {
      const readSigs = new Set();
      const readMems = new Set();
      bindTargetIds(gate.target, readSigs, readMems);
      for (const inp of gate.inputs || []) {
        bindNodeIds(inp, readSigs, readMems);
      }
      this._combNodes.push({
        id: this._combNodes.length,
        kind: 'gate',
        gate,
        isPortWiring: false,
        readSigIds: [...readSigs],
        readMemIds: [...readMems],
      });
    }

    for (const blk of this.ast.alwaysBlocks || []) {
      if (blk.mode === 'tb') {
        bindStmtIds(blk.body, null, null);
        continue; // Testbench timing blocks (`always #T ...`) run in testbench.js
      }
      const readSigs = new Set();
      const readMems = new Set();
      bindStmtIds(blk.body, readSigs, readMems);

      if (blk.mode === 'comb') {
        this._combNodes.push({
          id: this._combNodes.length,
          kind: 'combAlways',
          blk,
          isPortWiring: false,
          readSigIds: [...readSigs],
          readMemIds: [...readMems],
        });
      } else {
        const compiledSens = [];
        for (const sens of blk.sensitivity || []) {
          ensureSignalName(sens.signal);
          const sigId = this.nameToId.get(sens.signal) ?? -1;
          if (sens.index) bindNodeIds(sens.index, null, null);
          let staticBitOffset = 0;
          let hasDynamicIndex = false;
          if (sens.index) {
            if (sens.index.kind === 'Number' && sens.index.xMask === 0n && sens.index.zMask === 0n) {
              const baseLsb = sigId >= 0 ? this.sigMeta[sigId].baseLsb : 0;
              staticBitOffset = Number(sens.index.val) - baseLsb;
            } else {
              hasDynamicIndex = true;
            }
          }
          compiledSens.push({
            edge: sens.edge,
            sigId,
            signal: sens.signal,
            indexExpr: sens.index,
            staticBitOffset,
            hasDynamicIndex,
          });
        }
        this._seqBlocks.push({
          id: this._seqBlocks.length,
          blk,
          sensitivity: compiledSens,
        });
      }
    }

    for (const initBlk of this.ast.initialBlocks || []) {
      bindStmtIds(initBlk.body, null, null);
    }

    // Now allocate dense arrays sized to final sigCount, memCount, combCount, seqCount
    const N = this.sigCount;
    const M = this.memCount;
    const C = this._combNodes.length;
    const S = this._seqBlocks.length;

    this.sigVal = new Array(N).fill(0n);
    this.sigX = new Array(N).fill(0n);
    this.sigZ = new Array(N).fill(0n);

    this._nbaVal = new Array(N).fill(0n);
    this._nbaX = new Array(N).fill(0n);
    this._nbaZ = new Array(N).fill(0n);
    this._nbaStamp = new Uint32Array(N);

    this._blkVal = new Array(N).fill(0n);
    this._blkX = new Array(N).fill(0n);
    this._blkZ = new Array(N).fill(0n);
    this._blkStamp = new Uint32Array(N);

    this._seqCommitVal = new Array(N).fill(0n);
    this._seqCommitX = new Array(N).fill(0n);
    this._seqCommitZ = new Array(N).fill(0n);
    this._seqCommitStamp = new Uint32Array(N);

    this._workVal = new Array(N).fill(0n);
    this._workX = new Array(N).fill(0n);
    this._workZ = new Array(N).fill(0n);
    this._workStamp = new Uint32Array(N);

    this._edgePrevVal = new Array(N).fill(0n);
    this._edgePrevX = new Array(N).fill(0n);
    this._edgePrevZ = new Array(N).fill(0n);
    this._edgePrevStamp = new Uint32Array(N);

    this._combQueued = new Uint8Array(C);
    this._combSeenStamp = new Uint32Array(N);
    this._seqTrigStamp = new Uint32Array(S);
    this._tickChangedStamp = new Uint32Array(N);

    // Precompute dirty-fanout adjacency tables
    this._sigFanout = Array.from({ length: N }, () => []);
    this._portWiringFanout = Array.from({ length: N }, () => []);
    this._memFanout = Array.from({ length: M }, () => []);

    for (let ci = 0; ci < C; ci++) {
      const node = this._combNodes[ci];
      for (const sid of node.readSigIds) {
        if (sid >= 0 && sid < N) {
          this._sigFanout[sid].push(ci);
          if (node.isPortWiring) {
            this._portWiringFanout[sid].push(ci);
          }
        }
      }
      for (const mid of node.readMemIds) {
        if (mid >= 0 && mid < M) {
          this._memFanout[mid].push(ci);
        }
      }
    }

    // Precompute sequential sensitivity trigger table by signal ID
    this._seqTriggersBySig = Array.from({ length: N }, () => []);
    this._isSeqSensitive = new Uint8Array(N);
    for (let si = 0; si < S; si++) {
      const sblk = this._seqBlocks[si];
      for (const sens of sblk.sensitivity) {
        if (sens.sigId >= 0 && sens.sigId < N) {
          this._isSeqSensitive[sens.sigId] = 1;
          this._seqTriggersBySig[sens.sigId].push({
            seqIdx: si,
            edge: sens.edge,
            staticBitOffset: sens.staticBitOffset,
            hasDynamicIndex: sens.hasDynamicIndex,
            indexExpr: sens.indexExpr,
          });
        }
      }
    }
  }

  _detectClockPort() {
    if (!this.ast) return 'CLOCK_50';
    for (const alias of CLOCK_PORT_ALIASES) {
      if (this.nameToId.has(alias)) return alias;
    }
    return 'CLOCK_50';
  }

  getClockPort() {
    return this.clockPort;
  }

  /**
   * Reset simulation state:
   * - Top-level input ports initialized to known 0 (xMask = 0n)
   * - All other signals and unpacked memories initialized to all-X
   * - Executes any `initial` blocks and settles initial Phase 2 combinational logic
   */
  reset() {
    this.cycle = 0;
    this._halfTick = 0;
    this.halted = false;
    this.runtimeError = null;

    if (!this.ast) return;

    for (let id = 0; id < this.sigCount; id++) {
      const meta = this.sigMeta[id];
      if (meta.dir === 'input') {
        this.sigVal[id] = 0n;
        this.sigX[id] = 0n;
        this.sigZ[id] = 0n;
      } else {
        this.sigVal[id] = 0n;
        this.sigX[id] = meta.mask;
        this.sigZ[id] = 0n;
      }
    }

    for (let m = 0; m < this.memCount; m++) {
      const mem = this.memList[m];
      mem.val.fill(0n);
      mem.xMask.fill(mem.mask);
      mem.zMask.fill(0n);
    }

    // Run optional initial blocks directly against main state (skipped when testbench.js drives initial)
    if (!this._skipInitial && this.ast.initialBlocks && this.ast.initialBlocks.length > 0) {
      for (const initBlk of this.ast.initialBlocks) {
        this._execInitialStmt(initBlk.body);
      }
    }

    this.evalCombinational();
    this.edgeBus.resetState();
    this.edgeBus.seedInitialLevels(this.sigVal, this.sigX, this.sigZ, 0);
  }

  _execInitialStmt(stmt) {
    if (!stmt || stmt.kind === 'Noop' || stmt.kind === 'SystemCall') return;
    const readEnv = { useOverlay: false };
    switch (stmt.kind) {
      case 'Block':
        for (const s of stmt.statements) this._execInitialStmt(s);
        break;
      case 'ProcAssign': {
        const lhsW = this._getTargetWidth(stmt.target, readEnv);
        const val = this._evalExpr(stmt.expr, readEnv, lhsW);
        this._writeTargetDirect(stmt.target, val, readEnv, null);
        break;
      }
      case 'If': {
        const cv = this._evalExpr(stmt.cond, readEnv, null);
        if (_simTruthiness(cv) === 1n) {
          this._execInitialStmt(stmt.thenBranch);
        } else if (stmt.elseBranch) {
          this._execInitialStmt(stmt.elseBranch);
        }
        break;
      }
      case 'Case': {
        const kv = this._evalExpr(stmt.expr, readEnv, null);
        let matched = false;
        for (const it of stmt.items) {
          for (const p of it.patterns) {
            const pv = this._evalExpr(p, readEnv, kv.width);
            const w = Math.max(kv.width, pv.width);
            if (_simEquals(_simResize(kv, w), _simResize(pv, w))) {
              this._execInitialStmt(it.stmt);
              matched = true;
              break;
            }
          }
          if (matched) break;
        }
        if (!matched && stmt.defaultBranch) this._execInitialStmt(stmt.defaultBranch);
        break;
      }
      case 'For': {
        const sid = stmt._loopSigId;
        if (sid === undefined || sid < 0) break;
        const meta = this.sigMeta[sid];
        const initV = _simResize(this._evalExpr(stmt.initExpr, readEnv, meta.width), meta.width);
        this.sigVal[sid] = initV.val;
        this.sigX[sid] = initV.xMask;
        this.sigZ[sid] = initV.zMask;
        let guard = 0;
        while (guard++ < 4096) {
          const condV = this._evalExpr(stmt.condExpr, readEnv, null);
          if (_simTruthiness(condV) !== 1n) break;
          this._execInitialStmt(stmt.body);
          const stepV = _simResize(this._evalExpr(stmt.stepExpr, readEnv, meta.width), meta.width);
          this.sigVal[sid] = stepV.val;
          this.sigX[sid] = stepV.xMask;
          this.sigZ[sid] = stepV.zMask;
        }
        break;
      }
      case 'RepeatStmt': {
        const cntV = this._evalExpr(stmt.count, readEnv, null);
        if (_simHasUnknown(cntV)) break;
        const n = Math.min(4096, Math.max(0, Number(cntV.val)));
        for (let r = 0; r < n; r++) this._execInitialStmt(stmt.body);
        break;
      }
    }
  }

  /**
   * Set an input (or forced signal) value, propagate input port wiring,
   * execute triggered Phase 1 sequential blocks, and settle Phase 2 combinational logic.
   *
   * @param {string} name
   * @param {number|bigint|{val: bigint, xMask?: bigint, zMask?: bigint, width?: number}} value
   */
  setInput(name, value) {
    if (!this.ast) return false;
    const sigId = this.nameToId.get(name);
    if (sigId === undefined) return false;

    const meta = this.sigMeta[sigId];
    const width = meta.width;
    const mask = meta.mask;

    let nextV;
    let nextX;
    let nextZ;
    if (value !== null && typeof value === 'object' && 'val' in value) {
      const z = (typeof value.zMask === 'bigint' ? value.zMask : BigInt(value.zMask ?? 0n)) & mask;
      const x = ((typeof value.xMask === 'bigint' ? value.xMask : BigInt(value.xMask ?? 0n)) & mask) & ~z;
      const v = ((typeof value.val === 'bigint' ? value.val : BigInt(value.val ?? 0n)) & mask) & ~x & ~z;
      nextV = v;
      nextX = x;
      nextZ = z;
    } else {
      nextV = (typeof value === 'bigint' ? value : BigInt(value)) & mask;
      nextX = 0n;
      nextZ = 0n;
    }

    const prevV = this.sigVal[sigId];
    const prevX = this.sigX[sigId];
    const prevZ = this.sigZ[sigId];

    this.sigVal[sigId] = nextV;
    this.sigX[sigId] = nextX;
    this.sigZ[sigId] = nextZ;

    if (this.halted) return false;

    const changed = nextV !== prevV || nextX !== prevX || nextZ !== prevZ;
    if (!changed) return false;

    const triggered = this._processSignalTransition(
      sigId,
      prevV,
      prevX,
      prevZ,
      this._halfTick,
      'input'
    );
    return triggered;
  }

  /**
   * Read a 4-state signal value `{ val, xMask, zMask, width }`.
   * @param {string} name
   */
  getSignal(name) {
    const sigId = this.nameToId.get(name);
    if (sigId !== undefined) {
      return {
        width: this.sigMeta[sigId].width,
        val: this.sigVal[sigId],
        xMask: this.sigX[sigId],
        zMask: this.sigZ[sigId],
      };
    }
    if (this.ast && this.ast.params && name in this.ast.params) {
      const p = this.ast.params[name];
      return createLogic4(p.width, p.val, p.xMask, p.zMask);
    }
    return makeAllX(1);
  }

  // ==========================================================================
  // Unpacked 2D Memory Array Runtime API (SPEC Section 9.2)
  // ==========================================================================

  /**
   * List all declared/elaborated 2D memory arrays with dimension & bit-count metadata.
   */
  listMemories() {
    return this.memList.map((m) => ({
      name: m.name,
      localName: m.localName,
      instancePath: m.instancePath,
      width: m.width,
      depth: m.depth,
      addrMin: m.addrMin,
      addrMax: m.addrMax,
      addrMsb: m.addrMsb,
      addrLsb: m.addrLsb,
      totalBits: m.width * m.depth,
      storage: m.storage,
    }));
  }

  /**
   * Read a single 4-state word from a 2D memory array.
   * Returns all-X if the memory or address is out of range.
   */
  getMemoryWord(name, addr) {
    const memId = this.memNameToId.get(name);
    if (memId === undefined) return makeAllX(1);
    const mem = this.memList[memId];
    const offset = Number(addr) - mem.addrMin;
    if (!Number.isInteger(offset) || offset < 0 || offset >= mem.depth) {
      return makeAllX(mem.width);
    }
    return {
      width: mem.width,
      val: mem.val[offset],
      xMask: mem.xMask[offset],
      zMask: mem.zMask[offset],
    };
  }

  /**
   * Write a single 4-state word into a 2D memory array and settle combinational readers.
   */
  setMemoryWord(name, addr, value) {
    const memId = this.memNameToId.get(name);
    if (memId === undefined) return false;
    const mem = this.memList[memId];
    const offset = Number(addr) - mem.addrMin;
    if (!Number.isInteger(offset) || offset < 0 || offset >= mem.depth) {
      return false;
    }

    const l4 =
      value !== null && typeof value === 'object' && 'val' in value
        ? createLogic4(mem.width, value.val, value.xMask ?? 0n, value.zMask ?? 0n)
        : createLogic4(mem.width, BigInt(value), 0n, 0n);

    mem.val[offset] = l4.val;
    mem.xMask[offset] = l4.xMask;
    mem.zMask[offset] = l4.zMask;

    if (!this.halted) {
      this._evalCombinationalDirty([], [memId]);
    }
    return true;
  }

  /**
   * Return an immutable snapshot of a 2D memory array (`null` if not found).
   * @param {string} name
   */
  getMemory(name) {
    const memId = this.memNameToId.get(name);
    if (memId === undefined) return null;
    const mem = this.memList[memId];
    const words = new Array(mem.depth);
    for (let i = 0; i < mem.depth; i++) {
      words[i] = {
        addr: mem.addrMin + i,
        width: mem.width,
        val: mem.val[i],
        xMask: mem.xMask[i],
        zMask: mem.zMask[i],
      };
    }
    return {
      name: mem.name,
      width: mem.width,
      depth: mem.depth,
      addrMin: mem.addrMin,
      addrMax: mem.addrMax,
      words,
      read: (addr) => {
        const off = Number(addr) - mem.addrMin;
        if (!Number.isInteger(off) || off < 0 || off >= mem.depth) return makeAllX(mem.width);
        const w = words[off];
        return { width: w.width, val: w.val, xMask: w.xMask, zMask: w.zMask };
      },
    };
  }

  /**
   * Load hex image data into a 2D memory array.
   * Supports Verilog `$readmemh` syntax (`@addr` offsets, whitespace/newline-separated
   * hex words, `_` separators, `X`/`Z` nibbles, `//` and `/* *\/` comments) as well as
   * standard Intel HEX (`:LLAAAATT...`) records.
   *
   * @param {string} name
   * @param {string} hexText
   */
  loadMemoryHex(name, hexText) {
    const memId = this.memNameToId.get(name);
    if (memId === undefined) {
      throw new Error(`Memory '${name}' does not exist in compiled design`);
    }
    const mem = this.memList[memId];
    const rawText = String(hexText || '');

    // Strip // and /* */ comments
    const cleaned = rawText
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ');

    const nonEmptyLines = cleaned
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    let loadedWords = 0;
    let firstAddr = null;
    let lastAddr = null;

    // Detect Intel HEX format
    const isIntelHex = nonEmptyLines.length > 0 && nonEmptyLines.every((l) => l.startsWith(':'));

    if (isIntelHex) {
      let upperAddr = 0;
      const bytesPerWord = Math.max(1, Math.ceil(mem.width / 8));
      for (const line of nonEmptyLines) {
        const byteCount = parseInt(line.slice(1, 3), 16);
        const addr16 = parseInt(line.slice(3, 7), 16);
        const recType = parseInt(line.slice(7, 9), 16);
        if (recType === 1) break; // EOF
        if (recType === 4 && byteCount >= 2) {
          upperAddr = parseInt(line.slice(9, 13), 16) << 16;
          continue;
        }
        if (recType !== 0) continue;

        const baseAddr = upperAddr + addr16;
        for (let b = 0; b < byteCount; b += bytesPerWord) {
          let wordVal = 0n;
          for (let k = 0; k < bytesPerWord && b + k < byteCount; k++) {
            const hexPos = 9 + (b + k) * 2;
            const byteVal = parseInt(line.slice(hexPos, hexPos + 2), 16);
            wordVal = (wordVal << 8n) | BigInt(byteVal & 0xFF);
          }
          const targetAddr = Math.floor((baseAddr + b) / bytesPerWord);
          const off = targetAddr - mem.addrMin;
          if (off >= 0 && off < mem.depth) {
            mem.val[off] = wordVal & mem.mask;
            mem.xMask[off] = 0n;
            mem.zMask[off] = 0n;
            if (firstAddr === null) firstAddr = targetAddr;
            lastAddr = targetAddr;
            loadedWords++;
          }
        }
      }
    } else {
      const tokens = cleaned.split(/[\s,]+/).filter((t) => t.length > 0);
      let cursor = mem.addrMin;

      for (const tok of tokens) {
        if (tok.startsWith('@')) {
          const parsedAddr = parseInt(tok.slice(1).replace(/_/g, ''), 16);
          if (!Number.isNaN(parsedAddr)) {
            cursor = parsedAddr;
          }
          continue;
        }

        const decoded = _simParseHexWord(tok, mem.width);
        if (!decoded) continue;

        const off = cursor - mem.addrMin;
        if (off >= 0 && off < mem.depth) {
          mem.val[off] = decoded.val;
          mem.xMask[off] = decoded.xMask;
          mem.zMask[off] = decoded.zMask;
          if (firstAddr === null) firstAddr = cursor;
          lastAddr = cursor;
          loadedWords++;
        }
        cursor++;
      }
    }

    if (loadedWords > 0 && !this.halted) {
      this._evalCombinationalDirty([], [memId]);
    }

    return {
      memory: mem.name,
      loadedWords,
      startAddr: firstAddr,
      endAddr: lastAddr,
    };
  }

  // ==========================================================================
  // Clock Stepping & Time-Sliced Batch Execution (SPEC Section 9.4)
  // ==========================================================================

  /**
   * Transition clock to a specific level (0 or 1), running Phase 1 + Phase 2.
   * @param {0|1} level
   * @param {string} [clkName]
   */
  stepEdge(level, clkName = this.clockPort) {
    if (!this.ast || this.halted) {
      return { cycle: this.cycle, halted: this.halted, error: this.runtimeError };
    }
    const targetClk = clkName || this.clockPort;
    const clkId = this.nameToId.get(targetClk);
    const tick = this.cycle * 2 + (level ? 0 : 1);
    this._halfTick = tick;

    if (clkId !== undefined) {
      this._stepEdgeFast(clkId, level ? 1n : 0n, tick, level ? 'posedge' : 'negedge');
    } else {
      this._evalCombinationalDirty([], []);
    }

    return {
      cycle: this.cycle,
      halted: this.halted,
      error: this.runtimeError ?? null,
    };
  }

  /**
   * Fast internal clock-edge path using integer `clkId` (no string lookups or result objects).
   */
  _stepEdgeFast(clkId, levelBit, tick, phase) {
    const prevV = this.sigVal[clkId];
    const prevX = this.sigX[clkId];
    const prevZ = this.sigZ[clkId];

    this.sigVal[clkId] = levelBit;
    this.sigX[clkId] = 0n;
    this.sigZ[clkId] = 0n;

    if (prevV !== levelBit || prevX !== 0n || prevZ !== 0n) {
      this._processSignalTransition(clkId, prevV, prevX, prevZ, tick, phase);
    } else if (this.edgeBus.hasScheduledSamplers()) {
      this.edgeBus.advanceTick(this.sigVal, this.sigX, this.sigZ, this.cycle, tick, phase);
    }
  }

  /**
   * Advance one full clock cycle:
   *   1. Rising edge (0 -> 1): Phase 1 sequential + Phase 2 combinational
   *   2. Falling edge (1 -> 0): Phase 1 sequential (if negedge) + Phase 2 combinational
   *
   * @param {string} [clkName]
   * @param {(phase: string, snapshot: object) => void} [onPhase]
   */
  stepClock(clkName = this.clockPort, onPhase = null) {
    if (!this.ast || this.halted) {
      return { cycle: this.cycle, halted: this.halted, error: this.runtimeError };
    }
    const targetClk = clkName || this.clockPort;
    const clkId = this.nameToId.get(targetClk);

    // Ensure starting low before rising edge
    if (clkId !== undefined && (this.sigVal[clkId] !== 0n || this.sigX[clkId] !== 0n || this.sigZ[clkId] !== 0n)) {
      this.sigVal[clkId] = 0n;
      this.sigX[clkId] = 0n;
      this.sigZ[clkId] = 0n;
    }

    // Rising edge: 0 -> 1
    this.stepEdge(1, targetClk);
    if (typeof onPhase === 'function') {
      onPhase('posedge', this.getSnapshot());
    }
    if (this.halted) {
      return { cycle: this.cycle, halted: true, error: this.runtimeError };
    }

    // Falling edge: 1 -> 0
    this.stepEdge(0, targetClk);
    if (!this.halted) {
      this.cycle += 1;
    }
    if (typeof onPhase === 'function') {
      onPhase('negedge', this.getSnapshot());
    }

    return {
      cycle: this.cycle,
      halted: this.halted,
      error: this.runtimeError,
    };
  }

  /**
   * Advance one half-cycle (toggles clock 0 -> 1 or 1 -> 0; increments cycle on falling edge).
   * @param {string} [clkName]
   */
  stepHalfClock(clkName = this.clockPort) {
    if (!this.ast || this.halted) {
      return { cycle: this.cycle, phase: 'halted', halted: this.halted, error: this.runtimeError };
    }
    const targetClk = clkName || this.clockPort;
    const clkId = this.nameToId.get(targetClk);
    const isHigh =
      clkId !== undefined &&
      this.sigVal[clkId] === 1n &&
      this.sigX[clkId] === 0n &&
      this.sigZ[clkId] === 0n;

    if (!isHigh) {
      this.stepEdge(1, targetClk);
      return { cycle: this.cycle, phase: 'posedge', halted: this.halted, error: this.runtimeError };
    }
    this.stepEdge(0, targetClk);
    if (!this.halted) {
      this.cycle += 1;
    }
    return { cycle: this.cycle, phase: 'negedge', halted: this.halted, error: this.runtimeError };
  }

  /**
   * Time-Sliced Batch Execution (SPEC Section 9.4).
   * Executes up to `count` full clock cycles within `maxBudgetMs` (default 8 ms)
   * without blocking UI frames or requiring Web Workers (`file://` safe).
   *
   * @param {number} count
   * @param {number} [maxBudgetMs=8]
   * @param {string} [clkName]
   * @returns {{ cyclesExecuted: number, hitBudget: boolean, events: object[], cycle: number, halted: boolean, error: object|null }}
   */
  stepCycles(count, maxBudgetMs = 8, clkName = this.clockPort) {
    const targetCount = Math.max(0, count | 0);
    if (!this.ast || this.halted || targetCount === 0) {
      return {
        cyclesExecuted: 0,
        hitBudget: false,
        events: [],
        cycle: this.cycle,
        halted: this.halted,
        error: this.runtimeError,
      };
    }

    const targetClk = clkName || this.clockPort;
    const clkId = this.nameToId.get(targetClk);
    const useBudget = typeof maxBudgetMs === 'number' && maxBudgetMs > 0 && Number.isFinite(maxBudgetMs);
    const startMs = useBudget ? _simNowMs() : 0;

    // Ensure starting low before batch begins
    if (clkId !== undefined && (this.sigVal[clkId] !== 0n || this.sigX[clkId] !== 0n || this.sigZ[clkId] !== 0n)) {
      this.sigVal[clkId] = 0n;
      this.sigX[clkId] = 0n;
      this.sigZ[clkId] = 0n;
    }

    const captureEvents = this.edgeBus.hasWatchers();
    if (captureEvents) {
      this.edgeBus.beginBatch();
    }

    let cyclesExecuted = 0;
    let hitBudget = false;

    for (let i = 0; i < targetCount; i++) {
      const baseTick = this.cycle * 2;
      this._halfTick = baseTick;

      if (clkId !== undefined) {
        // Rising edge (0 -> 1)
        this._stepEdgeFast(clkId, 1n, baseTick, 'posedge');
        if (this.halted) break;

        // Falling edge (1 -> 0)
        this._halfTick = baseTick + 1;
        this._stepEdgeFast(clkId, 0n, baseTick + 1, 'negedge');
        if (this.halted) break;
      }

      this.cycle += 1;
      cyclesExecuted += 1;

      if (useBudget && (cyclesExecuted & (_SIM_BUDGET_CHECK_STRIDE - 1)) === 0 && cyclesExecuted < targetCount) {
        if (_simNowMs() - startMs >= maxBudgetMs) {
          hitBudget = true;
          break;
        }
      }
    }

    const events = captureEvents ? this.edgeBus.endBatch() : [];
    return {
      cyclesExecuted,
      hitBudget,
      events,
      cycle: this.cycle,
      halted: this.halted,
      error: this.runtimeError,
    };
  }

  /**
   * Alias for stepClock() for backward compatibility.
   */
  step(clkName = this.clockPort) {
    return this.stepClock(clkName);
  }

  // ==========================================================================
  // Core Transition Engine: Port Wiring -> Phase 1 (Seq) -> Phase 2 (Dirty Comb)
  // ==========================================================================

  _processSignalTransition(rootSigId, prevV, prevX, prevZ, tick, phase) {
    const trackForEdgeBus = this.edgeBus.hasWatchers();
    let tickChangedIds = null;
    let tickGen = 0;

    if (trackForEdgeBus) {
      tickGen = ++this._tickChangedGen;
      tickChangedIds = [];
      this._tickChangedStamp[rootSigId] = tickGen;
      tickChangedIds.push(rootSigId);
    }

    // Record pre-edge state for root signal and any transitive child input port wires
    const edgeGen = ++this._edgePrevGen;
    this._edgePrevStamp[rootSigId] = edgeGen;
    this._edgePrevVal[rootSigId] = prevV;
    this._edgePrevX[rootSigId] = prevX;
    this._edgePrevZ[rootSigId] = prevZ;

    const edgeChangedIds = [rootSigId];
    const dirtySigIds = [rootSigId];
    const dirtyMemIds = [];

    // Propagate structural input port wiring (e.g. CLOCK_50 -> u0.clk, KEY[0] -> u0.rst_n)
    // BEFORE Phase 1 so parent and child flip-flops sample the exact same atomic clock/reset edge.
    const wireFanout = this._portWiringFanout[rootSigId];
    if (wireFanout && wireFanout.length > 0) {
      this._propagatePortInputWiring(
        rootSigId,
        edgeGen,
        edgeChangedIds,
        dirtySigIds,
        tickChangedIds,
        tickGen
      );
    }

    // Phase 1: Sequential blocks triggered by edgeChangedIds
    const phase1SeqSensitive = [];
    const triggered = this._evalSequentialForEdgeChanges(
      edgeChangedIds,
      edgeGen,
      dirtySigIds,
      dirtyMemIds,
      tickChangedIds,
      tickGen,
      phase1SeqSensitive
    );

    // Phase 2: Dirty-Fanout combinational propagation
    const combRes = this._evalCombinationalDirty(
      dirtySigIds,
      dirtyMemIds,
      tickChangedIds,
      tickGen
    );

    // Merge sequential-commit & combinational transitions on any seq-sensitive internal net
    const mergeSensitiveChanges = (seqList, combList) => {
      if ((!seqList || seqList.length === 0) && (!combList || combList.length === 0)) {
        return null;
      }
      const seen = new Map();
      if (seqList) {
        for (let i = 0; i < seqList.length; i++) {
          const ch = seqList[i];
          if (!seen.has(ch.id)) seen.set(ch.id, ch);
        }
      }
      if (combList) {
        for (let i = 0; i < combList.length; i++) {
          const ch = combList[i];
          if (!seen.has(ch.id)) seen.set(ch.id, ch);
        }
      }
      return seen.size > 0 ? [...seen.values()] : null;
    };

    // Follow-up delta passes if Phase 1 or Phase 2 toggled a signal used in a sequential
    // sensitivity list (e.g., async ripple counter `always @(negedge q[0])` or internal clock divider)
    let deltaPass = 0;
    let deltaSeqChanges = mergeSensitiveChanges(phase1SeqSensitive, combRes.seqSensitiveChanges);
    while (
      !this.halted &&
      deltaSeqChanges &&
      deltaSeqChanges.length > 0 &&
      deltaPass < _SIM_MAX_DELTA_PASSES
    ) {
      deltaPass++;
      const dEdgeGen = ++this._edgePrevGen;
      const dEdgeIds = [];
      const dDirtySigs = [];
      const dDirtyMems = [];

      for (let i = 0; i < deltaSeqChanges.length; i++) {
        const ch = deltaSeqChanges[i];
        this._edgePrevStamp[ch.id] = dEdgeGen;
        this._edgePrevVal[ch.id] = ch.prevV;
        this._edgePrevX[ch.id] = ch.prevX;
        this._edgePrevZ[ch.id] = ch.prevZ;
        dEdgeIds.push(ch.id);
        const wFanout = this._portWiringFanout[ch.id];
        if (wFanout && wFanout.length > 0) {
          this._propagatePortInputWiring(
            ch.id,
            dEdgeGen,
            dEdgeIds,
            dDirtySigs,
            tickChangedIds,
            tickGen
          );
        }
      }

      const dSeqSensitive = [];
      const dTrig = this._evalSequentialForEdgeChanges(
        dEdgeIds,
        dEdgeGen,
        dDirtySigs,
        dDirtyMems,
        tickChangedIds,
        tickGen,
        dSeqSensitive
      );
      if (!dTrig) break;

      const dComb = this._evalCombinationalDirty(
        dDirtySigs,
        dDirtyMems,
        tickChangedIds,
        tickGen
      );
      deltaSeqChanges = mergeSensitiveChanges(dSeqSensitive, dComb.seqSensitiveChanges);
    }

    // Notify Protocol Edge Bus (only if subscribers exist)
    if (trackForEdgeBus) {
      this.edgeBus.sampleChanged(
        tickChangedIds,
        this.sigVal,
        this.sigX,
        this.sigZ,
        this.cycle,
        tick,
        phase
      );
    }
    if (this.edgeBus.hasScheduledSamplers()) {
      this.edgeBus.advanceTick(this.sigVal, this.sigX, this.sigZ, this.cycle, tick, phase);
    }

    return triggered;
  }

  // ==========================================================================
  // Testbench Driver Hooks (Phase 2 — v4.0-B)
  // ==========================================================================

  tbEvalExpr(expr, contextWidth = null) {
    return this._evalExpr(expr, { useOverlay: false }, contextWidth);
  }

  tbGetTargetWidth(target) {
    return this._getTargetWidth(target, { useOverlay: false });
  }

  tbWriteTarget(target, rhsVal, changedMap, dirtyMemIds) {
    const readEnv = { useOverlay: false, dirtyMemIds };
    this._writeTargetDirect(target, rhsVal, readEnv, (id, pv, px, pz) => {
      if (changedMap && !changedMap.has(id)) {
        changedMap.set(id, { prevV: pv, prevX: px, prevZ: pz });
      }
    });
  }

  /**
   * Propagate a batch of testbench signal/memory writes through port input wiring,
   * Phase 1 sequential blocks, Phase 2 combinational logic, and cascaded internal edges.
   */
  tbPropagateChanges(changedMap, dirtyMemIds = []) {
    if (this.halted) return false;
    const hasSigs = changedMap && changedMap.size > 0;
    const hasMems = dirtyMemIds && dirtyMemIds.length > 0;
    if (!hasSigs && !hasMems) return false;

    const edgeGen = ++this._edgePrevGen;
    const edgeChangedIds = [];
    const dirtySigIds = [];
    const memDirty = hasMems ? [...dirtyMemIds] : [];

    if (hasSigs) {
      for (const [sigId, prev] of changedMap.entries()) {
        if (
          this.sigVal[sigId] === prev.prevV &&
          this.sigX[sigId] === prev.prevX &&
          this.sigZ[sigId] === prev.prevZ
        ) {
          continue;
        }
        this._edgePrevStamp[sigId] = edgeGen;
        this._edgePrevVal[sigId] = prev.prevV;
        this._edgePrevX[sigId] = prev.prevX;
        this._edgePrevZ[sigId] = prev.prevZ;
        edgeChangedIds.push(sigId);
        dirtySigIds.push(sigId);
      }

      const initialEdgeCount = edgeChangedIds.length;
      for (let i = 0; i < initialEdgeCount; i++) {
        const sid = edgeChangedIds[i];
        const wireFanout = this._portWiringFanout[sid];
        if (wireFanout && wireFanout.length > 0) {
          this._propagatePortInputWiring(sid, edgeGen, edgeChangedIds, dirtySigIds, null, 0);
        }
      }
    }

    const phase1SeqSensitive = [];
    const triggered = edgeChangedIds.length > 0
      ? this._evalSequentialForEdgeChanges(edgeChangedIds, edgeGen, dirtySigIds, memDirty, null, 0, phase1SeqSensitive)
      : false;

    const combRes = this._evalCombinationalDirty(dirtySigIds, memDirty, null, 0);

    const mergeSensitive = (seqList, combList) => {
      if ((!seqList || seqList.length === 0) && (!combList || combList.length === 0)) return null;
      const seen = new Map();
      if (seqList) {
        for (let i = 0; i < seqList.length; i++) {
          if (!seen.has(seqList[i].id)) seen.set(seqList[i].id, seqList[i]);
        }
      }
      if (combList) {
        for (let i = 0; i < combList.length; i++) {
          if (!seen.has(combList[i].id)) seen.set(combList[i].id, combList[i]);
        }
      }
      return seen.size > 0 ? [...seen.values()] : null;
    };

    let deltaPass = 0;
    let deltaSeqChanges = mergeSensitive(phase1SeqSensitive, combRes.seqSensitiveChanges);
    while (!this.halted && deltaSeqChanges && deltaSeqChanges.length > 0 && deltaPass < _SIM_MAX_DELTA_PASSES) {
      deltaPass++;
      const dEdgeGen = ++this._edgePrevGen;
      const dEdgeIds = [];
      const dDirtySigs = [];
      const dDirtyMems = [];

      for (let i = 0; i < deltaSeqChanges.length; i++) {
        const ch = deltaSeqChanges[i];
        this._edgePrevStamp[ch.id] = dEdgeGen;
        this._edgePrevVal[ch.id] = ch.prevV;
        this._edgePrevX[ch.id] = ch.prevX;
        this._edgePrevZ[ch.id] = ch.prevZ;
        dEdgeIds.push(ch.id);
        const wFanout = this._portWiringFanout[ch.id];
        if (wFanout && wFanout.length > 0) {
          this._propagatePortInputWiring(ch.id, dEdgeGen, dEdgeIds, dDirtySigs, null, 0);
        }
      }

      const dSeqSensitive = [];
      const dTrig = this._evalSequentialForEdgeChanges(dEdgeIds, dEdgeGen, dDirtySigs, dDirtyMems, null, 0, dSeqSensitive);
      if (!dTrig) break;
      const dComb = this._evalCombinationalDirty(dDirtySigs, dDirtyMems, null, 0);
      deltaSeqChanges = mergeSensitive(dSeqSensitive, dComb.seqSensitiveChanges);
    }

    return triggered;
  }

  _propagatePortInputWiring(rootSigId, edgeGen, edgeChangedIds, dirtySigIds, tickChangedIds, tickGen) {
    const queue = [rootSigId];
    let head = 0;
    const readEnv = { useOverlay: false };
    let guard = 0;

    while (head < queue.length && guard < MAX_COMB_ITERATIONS) {
      guard++;
      const srcId = queue[head++];
      const fanout = this._portWiringFanout[srcId];
      if (!fanout || fanout.length === 0) continue;

      for (let i = 0; i < fanout.length; i++) {
        const node = this._combNodes[fanout[i]];
        const assign = node.assign;
        const targetId = assign.target._sigId;
        if (targetId < 0) continue;

        const prevV = this.sigVal[targetId];
        const prevX = this.sigX[targetId];
        const prevZ = this.sigZ[targetId];

        const lhsW = this._getTargetWidth(assign.target, readEnv);
        const val = this._evalExpr(assign.expr, readEnv, lhsW);
        this._writeTargetDirect(assign.target, val, readEnv, null);

        if (
          this.sigVal[targetId] !== prevV ||
          this.sigX[targetId] !== prevX ||
          this.sigZ[targetId] !== prevZ
        ) {
          if (this._edgePrevStamp[targetId] !== edgeGen) {
            this._edgePrevStamp[targetId] = edgeGen;
            this._edgePrevVal[targetId] = prevV;
            this._edgePrevX[targetId] = prevX;
            this._edgePrevZ[targetId] = prevZ;
            edgeChangedIds.push(targetId);
          }
          dirtySigIds.push(targetId);
          if (tickChangedIds && this._tickChangedStamp[targetId] !== tickGen) {
            this._tickChangedStamp[targetId] = tickGen;
            tickChangedIds.push(targetId);
          }
          queue.push(targetId);
        }
      }
    }
  }

  /**
   * Phase 1 — Trigger all sequential always blocks matching any edge in `edgeChangedIds`.
   * Stages non-blocking (`<=`) writes into generation-stamped flat arrays and commits atomically.
   */
  _evalSequentialForEdgeChanges(
    edgeChangedIds,
    edgeGen,
    dirtySigIds,
    dirtyMemIds,
    tickChangedIds,
    tickGen,
    seqOutSensitive = null
  ) {
    if (edgeChangedIds.length === 0 || this._seqBlocks.length === 0) return false;

    const trigGen = ++this._seqTrigGen;
    const triggeredBlockIdxs = [];
    const readEnv = { useOverlay: false };

    for (let i = 0; i < edgeChangedIds.length; i++) {
      const sigId = edgeChangedIds[i];
      const triggers = this._seqTriggersBySig[sigId];
      if (!triggers || triggers.length === 0) continue;

      const prevV = this._edgePrevVal[sigId];
      const prevX = this._edgePrevX[sigId];
      const prevZ = this._edgePrevZ[sigId];
      const curV = this.sigVal[sigId];
      const curX = this.sigX[sigId];
      const curZ = this.sigZ[sigId];
      const meta = this.sigMeta[sigId];

      for (let t = 0; t < triggers.length; t++) {
        const trig = triggers[t];
        if (this._seqTrigStamp[trig.seqIdx] === trigGen) continue;

        let bitOffset = trig.staticBitOffset;
        if (trig.hasDynamicIndex) {
          const idxVal = this._evalExpr(trig.indexExpr, readEnv, null);
          if (_simHasUnknown(idxVal)) continue;
          bitOffset = Number(idxVal.val) - meta.baseLsb;
        }
        if (bitOffset < 0 || bitOffset >= meta.width) continue;

        const sh = BigInt(bitOffset);
        const pU = ((prevX | prevZ) >> sh) & 1n;
        const cU = ((curX | curZ) >> sh) & 1n;
        const pBit = (prevV >> sh) & 1n;
        const cBit = (curV >> sh) & 1n;

        let edgeMatched = false;
        if (this._ieeeEdges) {
          if (cU === 0n) {
            edgeMatched =
              (trig.edge === 'posedge' && cBit === 1n && (pU !== 0n || pBit === 0n)) ||
              (trig.edge === 'negedge' && cBit === 0n && (pU !== 0n || pBit === 1n));
          }
        } else if (pU === 0n && cU === 0n) {
          edgeMatched =
            (trig.edge === 'posedge' && pBit === 0n && cBit === 1n) ||
            (trig.edge === 'negedge' && pBit === 1n && cBit === 0n);
        }

        if (edgeMatched) {
          this._seqTrigStamp[trig.seqIdx] = trigGen;
          triggeredBlockIdxs.push(trig.seqIdx);
        }
      }
    }

    if (triggeredBlockIdxs.length === 0) return false;

    // Evaluate all triggered sequential blocks against pre-edge flat state
    const nbaGen = ++this._nbaGen;
    const seqCommitGen = ++this._seqCommitGen;
    this._nbaDirtyIds.length = 0;
    this._seqCommitIds.length = 0;
    this._memNbaWrites.length = 0;

    for (let i = 0; i < triggeredBlockIdxs.length; i++) {
      const sblk = this._seqBlocks[triggeredBlockIdxs[i]];
      const blkGen = ++this._blkGen;
      this._blkDirtyIds.length = 0;
      const env = {
        useOverlay: true,
        overlayStamp: this._blkStamp,
        overlayGen: blkGen,
        overlayVal: this._blkVal,
        overlayX: this._blkX,
        overlayZ: this._blkZ,
        overlayDirty: this._blkDirtyIds,
        isSeq: true,
        nbaGen,
        seqCommitGen,
        dirtyMemIds,
      };
      this._execStmt(sblk.blk.body, env);
    }

    // Commit blocking sequential assignments first, then non-blocking updates atomically
    const seqOutSeen = seqOutSensitive ? new Set() : null;

    for (let i = 0; i < this._seqCommitIds.length; i++) {
      const id = this._seqCommitIds[i];
      const nv = this._seqCommitVal[id];
      const nx = this._seqCommitX[id];
      const nz = this._seqCommitZ[id];
      const pv = this.sigVal[id];
      const px = this.sigX[id];
      const pz = this.sigZ[id];
      if (pv !== nv || px !== nx || pz !== nz) {
        if (seqOutSensitive && this._isSeqSensitive[id] === 1 && !seqOutSeen.has(id)) {
          seqOutSeen.add(id);
          seqOutSensitive.push({ id, prevV: pv, prevX: px, prevZ: pz });
        }
        this.sigVal[id] = nv;
        this.sigX[id] = nx;
        this.sigZ[id] = nz;
        dirtySigIds.push(id);
        if (tickChangedIds && this._tickChangedStamp[id] !== tickGen) {
          this._tickChangedStamp[id] = tickGen;
          tickChangedIds.push(id);
        }
      }
    }

    for (let i = 0; i < this._nbaDirtyIds.length; i++) {
      const id = this._nbaDirtyIds[i];
      const nv = this._nbaVal[id];
      const nx = this._nbaX[id];
      const nz = this._nbaZ[id];
      const pv = this.sigVal[id];
      const px = this.sigX[id];
      const pz = this.sigZ[id];
      if (pv !== nv || px !== nx || pz !== nz) {
        if (seqOutSensitive && this._isSeqSensitive[id] === 1 && !seqOutSeen.has(id)) {
          seqOutSeen.add(id);
          seqOutSensitive.push({ id, prevV: pv, prevX: px, prevZ: pz });
        }
        this.sigVal[id] = nv;
        this.sigX[id] = nx;
        this.sigZ[id] = nz;
        dirtySigIds.push(id);
        if (tickChangedIds && this._tickChangedStamp[id] !== tickGen) {
          this._tickChangedStamp[id] = tickGen;
          tickChangedIds.push(id);
        }
      }
    }

    // Commit staged 2D memory non-blocking writes atomically
    for (let i = 0; i < this._memNbaWrites.length; i++) {
      const mw = this._memNbaWrites[i];
      const mem = this.memList[mw.memId];
      if (
        mem.val[mw.offset] !== mw.val ||
        mem.xMask[mw.offset] !== mw.xMask ||
        mem.zMask[mw.offset] !== mw.zMask
      ) {
        mem.val[mw.offset] = mw.val;
        mem.xMask[mw.offset] = mw.xMask;
        mem.zMask[mw.offset] = mw.zMask;
        dirtyMemIds.push(mw.memId);
      }
    }

    return true;
  }

  /**
   * Phase 2 — Full combinational settlement (evaluates all combinational nodes on iteration 0,
   * then uses dirty-fanout propagation until fixed-point convergence or 64-iteration cap).
   */
  evalCombinational() {
    if (!this.ast || this._combNodes.length === 0) {
      return { converged: true, iterations: 0, error: null };
    }
    const allNodes = new Array(this._combNodes.length);
    for (let i = 0; i < allNodes.length; i++) allNodes[i] = i;
    return this._runCombQueue(allNodes, null, 0);
  }

  /**
   * Dirty-Fanout combinational propagation seeded only by changed signal & memory IDs.
   */
  _evalCombinationalDirty(dirtySigIds, dirtyMemIds, tickChangedIds = null, tickGen = 0) {
    const C = this._combNodes.length;
    if (C === 0 || (dirtySigIds.length === 0 && dirtyMemIds.length === 0)) {
      return { converged: true, iterations: 0, error: null, seqSensitiveChanges: null };
    }

    const queued = this._combQueued;
    const initialNodes = [];

    for (let i = 0; i < dirtySigIds.length; i++) {
      const fanout = this._sigFanout[dirtySigIds[i]];
      if (!fanout) continue;
      for (let f = 0; f < fanout.length; f++) {
        const cid = fanout[f];
        if (!queued[cid]) {
          queued[cid] = 1;
          initialNodes.push(cid);
        }
      }
    }

    for (let i = 0; i < dirtyMemIds.length; i++) {
      const fanout = this._memFanout[dirtyMemIds[i]];
      if (!fanout) continue;
      for (let f = 0; f < fanout.length; f++) {
        const cid = fanout[f];
        if (!queued[cid]) {
          queued[cid] = 1;
          initialNodes.push(cid);
        }
      }
    }

    for (let i = 0; i < initialNodes.length; i++) {
      queued[initialNodes[i]] = 0;
    }

    if (initialNodes.length === 0) {
      return { converged: true, iterations: 0, error: null, seqSensitiveChanges: null };
    }

    return this._runCombQueue(initialNodes, tickChangedIds, tickGen);
  }

  _runCombQueue(initialNodes, tickChangedIds, tickGen) {
    const queued = this._combQueued;
    const readEnv = { useOverlay: false };
    let currentNodes = initialNodes;
    let seqSensitiveChanges = null;
    const seqSensSeen = new Map();

    for (let iter = 0; iter < MAX_COMB_ITERATIONS; iter++) {
      const seenGen = ++this._combSeenGen;
      const iterChangedIds = [];

      const recordChanged = (id, prevV, prevX, prevZ) => {
        if (this._combSeenStamp[id] !== seenGen) {
          this._combSeenStamp[id] = seenGen;
          iterChangedIds.push(id);
        }
        if (tickChangedIds && this._tickChangedStamp[id] !== tickGen) {
          this._tickChangedStamp[id] = tickGen;
          tickChangedIds.push(id);
        }
        if (this._isSeqSensitive[id] === 1 && !seqSensSeen.has(id)) {
          seqSensSeen.set(id, { id, prevV, prevX, prevZ });
        }
      };

      for (let n = 0; n < currentNodes.length; n++) {
        const node = this._combNodes[currentNodes[n]];

        if (node.kind === 'assign') {
          const assign = node.assign;
          const lhsW = this._getTargetWidth(assign.target, readEnv);
          const val = this._evalExpr(assign.expr, readEnv, lhsW);
          this._writeTargetDirect(assign.target, val, readEnv, recordChanged);
        } else if (node.kind === 'gate') {
          const gate = node.gate;
          const val = this._evalGate(gate, readEnv);
          this._writeTargetDirect(gate.target, val, readEnv, recordChanged);
        } else {
          // Combinational always block using generation-stamped scratch overlay
          const workGen = ++this._workGen;
          this._workDirtyIds.length = 0;
          const env = {
            useOverlay: true,
            overlayStamp: this._workStamp,
            overlayGen: workGen,
            overlayVal: this._workVal,
            overlayX: this._workX,
            overlayZ: this._workZ,
            overlayDirty: this._workDirtyIds,
            isSeq: false,
            nbaGen: 0,
            seqCommitGen: 0,
            dirtyMemIds: null,
          };
          this._execStmt(node.blk.body, env);

          for (let d = 0; d < this._workDirtyIds.length; d++) {
            const id = this._workDirtyIds[d];
            const nv = this._workVal[id];
            const nx = this._workX[id];
            const nz = this._workZ[id];
            const pv = this.sigVal[id];
            const px = this.sigX[id];
            const pz = this.sigZ[id];
            if (pv !== nv || px !== nx || pz !== nz) {
              this.sigVal[id] = nv;
              this.sigX[id] = nx;
              this.sigZ[id] = nz;
              recordChanged(id, pv, px, pz);
            }
          }
        }
      }

      if (iterChangedIds.length === 0) {
        if (seqSensSeen.size > 0) {
          seqSensitiveChanges = [...seqSensSeen.values()];
        }
        return { converged: true, iterations: iter + 1, error: null, seqSensitiveChanges };
      }

      if (iter === MAX_COMB_ITERATIONS - 1) {
        const changedNames = iterChangedIds.map((id) => this.sigNames[id]);
        const primarySignal = changedNames[0] ?? null;
        this.halted = true;
        this.runtimeError = createDiagnostic({
          code: 'COMBINATIONAL_LOOP',
          severity: 'error',
          line: null,
          signal: primarySignal,
          message: `Combinational loop detected: failed to converge after ${MAX_COMB_ITERATIONS} iterations (oscillating: ${changedNames.join(', ')})`,
          params: {
            maxIterations: MAX_COMB_ITERATIONS,
            signals: changedNames,
          },
        });
        return {
          converged: false,
          iterations: MAX_COMB_ITERATIONS,
          error: this.runtimeError,
          seqSensitiveChanges: null,
        };
      }

      // Enqueue ONLY downstream combinational blocks reading changed signals
      const nextNodes = [];
      for (let i = 0; i < iterChangedIds.length; i++) {
        const fanout = this._sigFanout[iterChangedIds[i]];
        if (!fanout) continue;
        for (let f = 0; f < fanout.length; f++) {
          const cid = fanout[f];
          if (!queued[cid]) {
            queued[cid] = 1;
            nextNodes.push(cid);
          }
        }
      }

      for (let i = 0; i < nextNodes.length; i++) {
        queued[nextNodes[i]] = 0;
      }

      if (nextNodes.length === 0) {
        if (seqSensSeen.size > 0) {
          seqSensitiveChanges = [...seqSensSeen.values()];
        }
        return { converged: true, iterations: iter + 1, error: null, seqSensitiveChanges };
      }

      currentNodes = nextNodes;
    }

    return { converged: true, iterations: 0, error: null, seqSensitiveChanges };
  }

  /**
   * Return an immutable snapshot of cycle count, status, and all 4-state signals
   * for the Logic Analyzer and Virtual FPGA Board.
   */
  getSnapshot() {
    const signals = {};
    for (let id = 0; id < this.sigCount; id++) {
      signals[this.sigNames[id]] = {
        width: this.sigMeta[id].width,
        val: this.sigVal[id],
        xMask: this.sigX[id],
        zMask: this.sigZ[id],
      };
    }
    return {
      cycle: this.cycle,
      halted: this.halted,
      runtimeError: this.runtimeError ? { ...this.runtimeError } : null,
      signals,
    };
  }

  // ==========================================================================
  // Statement & Expression Evaluation (Integer-Indexed Flat Table)
  // ==========================================================================

  _readSig(sigId, env) {
    if (sigId < 0 || sigId >= this.sigCount) return makeAllX(1);
    const w = this.sigMeta[sigId].width;
    if (env.useOverlay && env.overlayStamp[sigId] === env.overlayGen) {
      return {
        width: w,
        val: env.overlayVal[sigId],
        xMask: env.overlayX[sigId],
        zMask: env.overlayZ[sigId],
      };
    }
    return {
      width: w,
      val: this.sigVal[sigId],
      xMask: this.sigX[sigId],
      zMask: this.sigZ[sigId],
    };
  }

  _execStmt(stmt, env) {
    if (!stmt || stmt.kind === 'Noop' || stmt.kind === 'SystemCall' || env.funcReturned) return;

    switch (stmt.kind) {
      case 'Block':
        for (let i = 0; i < stmt.statements.length; i++) {
          this._execStmt(stmt.statements[i], env);
          if (env.funcReturned) break;
        }
        break;

      case 'ProcAssign': {
        const lhsWidth = this._getTargetWidth(stmt.target, env);
        const val = this._evalExpr(stmt.expr, env, lhsWidth);
        if (stmt.op === '<=' && env.isSeq && !env.funcLocals) {
          // Sequential non-blocking: stage in NBA buffers without mutating current env
          this._writeTargetNba(stmt.target, val, env);
        } else {
          // Blocking assignment (or comb NBA / function local write)
          this._writeTargetOverlay(stmt.target, val, env);
        }
        break;
      }

      case 'Return': {
        if (env.funcLocals && env.funcReturnName) {
          const retSlot = env.funcLocals.get(env.funcReturnName);
          if (retSlot && stmt.expr) {
            const val = _simResize(this._evalExpr(stmt.expr, env, retSlot.width), retSlot.width);
            retSlot.val = val.val;
            retSlot.xMask = val.xMask;
            retSlot.zMask = val.zMask;
          }
          env.funcReturned = true;
        }
        break;
      }

      case 'If': {
        const condVal = this._evalExpr(stmt.cond, env, null);
        if (_simTruthiness(condVal) === 1n) {
          this._execStmt(stmt.thenBranch, env);
        } else if (stmt.elseBranch) {
          this._execStmt(stmt.elseBranch, env);
        }
        break;
      }

      case 'Case': {
        const keyVal = this._evalExpr(stmt.expr, env, null);
        const caseKind = stmt.caseKind || 'case';
        let matched = false;
        const items = stmt.items;

        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          for (let p = 0; p < item.patterns.length; p++) {
            const patVal = this._evalExpr(item.patterns[p], env, keyVal.width);
            const w = Math.max(keyVal.width, patVal.width);
            const a = _simResize(keyVal, w);
            const b = _simResize(patVal, w);
            let isMatch = false;
            if (caseKind === 'casez') {
              const care = ~(a.zMask | b.zMask) & _simMask(w);
              isMatch =
                ((a.val & care) === (b.val & care)) &&
                ((a.xMask & care) === (b.xMask & care));
            } else if (caseKind === 'casex') {
              const care = ~(a.xMask | a.zMask | b.xMask | b.zMask) & _simMask(w);
              isMatch = (a.val & care) === (b.val & care);
            } else {
              isMatch = _simEquals(a, b);
            }
            if (isMatch) {
              this._execStmt(item.stmt, env);
              matched = true;
              break;
            }
          }
          if (matched) break;
        }

        if (!matched && stmt.defaultBranch) {
          this._execStmt(stmt.defaultBranch, env);
        }
        break;
      }
    }
  }

  _getTargetWidth(target, env) {
    if (!target) return 1;
    switch (target.kind) {
      case 'Ident': {
        if (env && env.funcLocals && env.funcLocals.has(target.name)) {
          return env.funcLocals.get(target.name).width;
        }
        const id = target._sigId;
        return id >= 0 && id < this.sigCount ? this.sigMeta[id].width : 32;
      }
      case 'BitSelect':
        if (target._memId >= 0) return this.memList[target._memId].width;
        return 1;
      case 'MemSelect':
        return target._memId >= 0 ? this.memList[target._memId].width : 1;
      case 'MemBitSelect':
        return 1;
      case 'PartSelect':
      case 'MemPartSelect': {
        const msbV = this._evalExpr(target.msb, env, null);
        const lsbV = this._evalExpr(target.lsb, env, null);
        if (_simHasUnknown(msbV) || _simHasUnknown(lsbV)) return 1;
        return Math.abs(Number(msbV.val) - Number(lsbV.val)) + 1;
      }
      case 'Concat': {
        let total = 0;
        for (let i = 0; i < target.parts.length; i++) {
          total += this._getTargetWidth(target.parts[i], env);
        }
        return total;
      }
      default:
        return 1;
    }
  }

  /**
   * Direct write into main `sigVal/sigX/sigZ` (used by continuous `assign` and `initial`).
   */
  _writeTargetDirect(target, rhsVal, readEnv, onChanged) {
    if (!target) return;

    if (target.kind === 'Ident') {
      const id = target._sigId;
      if (id < 0 || id >= this.sigCount) return;
      const meta = this.sigMeta[id];
      const resized = _simResize(rhsVal, meta.width);
      const pv = this.sigVal[id];
      const px = this.sigX[id];
      const pz = this.sigZ[id];
      if (pv !== resized.val || px !== resized.xMask || pz !== resized.zMask) {
        this.sigVal[id] = resized.val;
        this.sigX[id] = resized.xMask;
        this.sigZ[id] = resized.zMask;
        if (onChanged) onChanged(id, pv, px, pz);
      }
      return;
    }

    if (target.kind === 'BitSelect' && target._memId < 0) {
      const id = target._sigId;
      if (id < 0 || id >= this.sigCount) return;
      const meta = this.sigMeta[id];
      const idxV = this._evalExpr(target.index, readEnv, null);
      if (_simHasUnknown(idxV)) return;

      const bitOffset = Number(idxV.val) - meta.baseLsb;
      if (bitOffset < 0 || bitOffset >= meta.width) return;

      const pv = this.sigVal[id];
      const px = this.sigX[id];
      const pz = this.sigZ[id];
      const shift = BigInt(bitOffset);
      const clearMask = ~(1n << shift);

      const nv = ((pv & clearMask) | ((rhsVal.val & 1n) << shift)) & meta.mask;
      const nx = ((px & clearMask) | ((rhsVal.xMask & 1n) << shift)) & meta.mask;
      const nz = ((pz & clearMask) | ((rhsVal.zMask & 1n) << shift)) & meta.mask;
      const cleanX = nx & ~nz;
      const cleanV = nv & ~cleanX & ~nz;

      if (pv !== cleanV || px !== cleanX || pz !== nz) {
        this.sigVal[id] = cleanV;
        this.sigX[id] = cleanX;
        this.sigZ[id] = nz;
        if (onChanged) onChanged(id, pv, px, pz);
      }
      return;
    }

    if (target.kind === 'PartSelect') {
      const id = target._sigId;
      if (id < 0 || id >= this.sigCount) return;
      const meta = this.sigMeta[id];
      const msbV = this._evalExpr(target.msb, readEnv, null);
      const lsbV = this._evalExpr(target.lsb, readEnv, null);
      if (_simHasUnknown(msbV) || _simHasUnknown(lsbV)) return;

      const hi = Math.max(Number(msbV.val), Number(lsbV.val));
      const lo = Math.min(Number(msbV.val), Number(lsbV.val));
      const sliceWidth = hi - lo + 1;
      const shiftAmt = lo - meta.baseLsb;
      if (shiftAmt < 0) return;

      const pv = this.sigVal[id];
      const px = this.sigX[id];
      const pz = this.sigZ[id];
      const shift = BigInt(shiftAmt);
      const sliceMask = _simMask(sliceWidth);
      const clearMask = ~(sliceMask << shift);
      const resized = _simResize(rhsVal, sliceWidth);

      const nz = ((pz & clearMask) | ((resized.zMask & sliceMask) << shift)) & meta.mask;
      const nx = (((px & clearMask) | ((resized.xMask & sliceMask) << shift)) & meta.mask) & ~nz;
      const nv = (((pv & clearMask) | ((resized.val & sliceMask) << shift)) & meta.mask) & ~nx & ~nz;

      if (pv !== nv || px !== nx || pz !== nz) {
        this.sigVal[id] = nv;
        this.sigX[id] = nx;
        this.sigZ[id] = nz;
        if (onChanged) onChanged(id, pv, px, pz);
      }
      return;
    }

    if (target.kind === 'MemSelect' || (target.kind === 'BitSelect' && target._memId >= 0)) {
      const memId = target._memId;
      if (memId < 0 || memId >= this.memCount) return;
      const mem = this.memList[memId];
      const addrV = this._evalExpr(target.kind === 'MemSelect' ? target.addr : target.index, readEnv, null);
      if (_simHasUnknown(addrV)) return;
      const off = Number(addrV.val) - mem.addrMin;
      if (off < 0 || off >= mem.depth) return;
      const resized = _simResize(rhsVal, mem.width);
      mem.val[off] = resized.val;
      mem.xMask[off] = resized.xMask;
      mem.zMask[off] = resized.zMask;
      if (readEnv && readEnv.dirtyMemIds) readEnv.dirtyMemIds.push(memId);
      return;
    }

    if (target.kind === 'MemBitSelect' || target.kind === 'MemPartSelect') {
      this._writeMemSubTarget(target, rhsVal, readEnv, false, readEnv ? readEnv.dirtyMemIds : null);
      return;
    }

    if (target.kind === 'Concat') {
      let bitCursor = 0n;
      for (let idx = target.parts.length - 1; idx >= 0; idx--) {
        const part = target.parts[idx];
        const partWidth = this._getTargetWidth(part, readEnv);
        const partMask = _simMask(partWidth);
        const slice = {
          width: partWidth,
          val: (rhsVal.val >> bitCursor) & partMask,
          xMask: (rhsVal.xMask >> bitCursor) & partMask,
          zMask: (rhsVal.zMask >> bitCursor) & partMask,
        };
        this._writeTargetDirect(part, slice, readEnv, onChanged);
        bitCursor += BigInt(partWidth);
      }
    }
  }

  /**
   * Write into an overlay buffer (used by blocking `=` assignments and comb `always` blocks).
   */
  _writeTargetOverlay(target, rhsVal, env) {
    if (!target) return;

    const writeSigSlot = (id, nv, nx, nz) => {
      if (env.overlayStamp[id] !== env.overlayGen) {
        env.overlayStamp[id] = env.overlayGen;
        env.overlayDirty.push(id);
      }
      env.overlayVal[id] = nv;
      env.overlayX[id] = nx;
      env.overlayZ[id] = nz;

      if (env.isSeq) {
        if (this._seqCommitStamp[id] !== env.seqCommitGen) {
          this._seqCommitStamp[id] = env.seqCommitGen;
          this._seqCommitIds.push(id);
        }
        this._seqCommitVal[id] = nv;
        this._seqCommitX[id] = nx;
        this._seqCommitZ[id] = nz;
      }
    };

    if (target.kind === 'Ident') {
      if (env.funcLocals && env.funcLocals.has(target.name)) {
        const slot = env.funcLocals.get(target.name);
        const resized = _simResize(rhsVal, slot.width);
        slot.val = resized.val;
        slot.xMask = resized.xMask;
        slot.zMask = resized.zMask;
        return;
      }
      const id = target._sigId;
      if (id < 0 || id >= this.sigCount) return;
      const resized = _simResize(rhsVal, this.sigMeta[id].width);
      writeSigSlot(id, resized.val, resized.xMask, resized.zMask);
      return;
    }

    if (target.kind === 'BitSelect' && target._memId < 0) {
      if (env.funcLocals && env.funcLocals.has(target.name)) {
        const slot = env.funcLocals.get(target.name);
        const idxV = this._evalExpr(target.index, env, null);
        if (_simHasUnknown(idxV)) return;
        const bitOffset = Number(idxV.val) - slot.baseLsb;
        if (bitOffset < 0 || bitOffset >= slot.width) return;
        const shift = BigInt(bitOffset);
        const clearMask = ~(1n << shift);
        const nz = ((slot.zMask & clearMask) | ((rhsVal.zMask & 1n) << shift)) & slot.mask;
        const nx = (((slot.xMask & clearMask) | ((rhsVal.xMask & 1n) << shift)) & slot.mask) & ~nz;
        const nv = (((slot.val & clearMask) | ((rhsVal.val & 1n) << shift)) & slot.mask) & ~nx & ~nz;
        slot.val = nv;
        slot.xMask = nx;
        slot.zMask = nz;
        return;
      }
      const id = target._sigId;
      if (id < 0 || id >= this.sigCount) return;
      const meta = this.sigMeta[id];
      const idxV = this._evalExpr(target.index, env, null);
      if (_simHasUnknown(idxV)) return;
      const bitOffset = Number(idxV.val) - meta.baseLsb;
      if (bitOffset < 0 || bitOffset >= meta.width) return;

      const cur = this._readSig(id, env);
      const shift = BigInt(bitOffset);
      const clearMask = ~(1n << shift);
      const nz = ((cur.zMask & clearMask) | ((rhsVal.zMask & 1n) << shift)) & meta.mask;
      const nx = (((cur.xMask & clearMask) | ((rhsVal.xMask & 1n) << shift)) & meta.mask) & ~nz;
      const nv = (((cur.val & clearMask) | ((rhsVal.val & 1n) << shift)) & meta.mask) & ~nx & ~nz;
      writeSigSlot(id, nv, nx, nz);
      return;
    }

    if (target.kind === 'PartSelect') {
      if (env.funcLocals && env.funcLocals.has(target.name)) {
        const slot = env.funcLocals.get(target.name);
        const msbV = this._evalExpr(target.msb, env, null);
        const lsbV = this._evalExpr(target.lsb, env, null);
        if (_simHasUnknown(msbV) || _simHasUnknown(lsbV)) return;
        const hi = Math.max(Number(msbV.val), Number(lsbV.val));
        const lo = Math.min(Number(msbV.val), Number(lsbV.val));
        const sliceWidth = hi - lo + 1;
        const shiftAmt = lo - slot.baseLsb;
        if (shiftAmt < 0) return;
        const shift = BigInt(shiftAmt);
        const sliceMask = _simMask(sliceWidth);
        const clearMask = ~(sliceMask << shift);
        const resized = _simResize(rhsVal, sliceWidth);
        const nz = ((slot.zMask & clearMask) | ((resized.zMask & sliceMask) << shift)) & slot.mask;
        const nx = (((slot.xMask & clearMask) | ((resized.xMask & sliceMask) << shift)) & slot.mask) & ~nz;
        const nv = (((slot.val & clearMask) | ((resized.val & sliceMask) << shift)) & slot.mask) & ~nx & ~nz;
        slot.val = nv;
        slot.xMask = nx;
        slot.zMask = nz;
        return;
      }
      const id = target._sigId;
      if (id < 0 || id >= this.sigCount) return;
      const meta = this.sigMeta[id];
      const msbV = this._evalExpr(target.msb, env, null);
      const lsbV = this._evalExpr(target.lsb, env, null);
      if (_simHasUnknown(msbV) || _simHasUnknown(lsbV)) return;

      const hi = Math.max(Number(msbV.val), Number(lsbV.val));
      const lo = Math.min(Number(msbV.val), Number(lsbV.val));
      const sliceWidth = hi - lo + 1;
      const shiftAmt = lo - meta.baseLsb;
      if (shiftAmt < 0) return;

      const cur = this._readSig(id, env);
      const shift = BigInt(shiftAmt);
      const sliceMask = _simMask(sliceWidth);
      const clearMask = ~(sliceMask << shift);
      const resized = _simResize(rhsVal, sliceWidth);

      const nz = ((cur.zMask & clearMask) | ((resized.zMask & sliceMask) << shift)) & meta.mask;
      const nx = (((cur.xMask & clearMask) | ((resized.xMask & sliceMask) << shift)) & meta.mask) & ~nz;
      const nv = (((cur.val & clearMask) | ((resized.val & sliceMask) << shift)) & meta.mask) & ~nx & ~nz;
      writeSigSlot(id, nv, nx, nz);
      return;
    }

    if (target.kind === 'MemSelect' || (target.kind === 'BitSelect' && target._memId >= 0)) {
      const memId = target._memId;
      if (memId < 0 || memId >= this.memCount) return;
      const mem = this.memList[memId];
      const addrV = this._evalExpr(target.kind === 'MemSelect' ? target.addr : target.index, env, null);
      if (_simHasUnknown(addrV)) return;
      const off = Number(addrV.val) - mem.addrMin;
      if (off < 0 || off >= mem.depth) return;
      const resized = _simResize(rhsVal, mem.width);
      mem.val[off] = resized.val;
      mem.xMask[off] = resized.xMask;
      mem.zMask[off] = resized.zMask;
      if (env.dirtyMemIds) env.dirtyMemIds.push(memId);
      return;
    }

    if (target.kind === 'MemBitSelect' || target.kind === 'MemPartSelect') {
      this._writeMemSubTarget(target, rhsVal, env, false, env.dirtyMemIds);
      return;
    }

    if (target.kind === 'Concat') {
      let bitCursor = 0n;
      for (let idx = target.parts.length - 1; idx >= 0; idx--) {
        const part = target.parts[idx];
        const partWidth = this._getTargetWidth(part, env);
        const partMask = _simMask(partWidth);
        const slice = {
          width: partWidth,
          val: (rhsVal.val >> bitCursor) & partMask,
          xMask: (rhsVal.xMask >> bitCursor) & partMask,
          zMask: (rhsVal.zMask >> bitCursor) & partMask,
        };
        this._writeTargetOverlay(part, slice, env);
        bitCursor += BigInt(partWidth);
      }
    }
  }

  /**
   * Stage non-blocking (`<=`) writes in Phase 1 NBA buffers without mutating current read state.
   */
  _writeTargetNba(target, rhsVal, env) {
    if (!target) return;

    const readBaseForNba = (id) => {
      if (this._nbaStamp[id] === env.nbaGen) {
        return {
          width: this.sigMeta[id].width,
          val: this._nbaVal[id],
          xMask: this._nbaX[id],
          zMask: this._nbaZ[id],
        };
      }
      return this._readSig(id, env);
    };

    const stageNbaSlot = (id, nv, nx, nz) => {
      if (this._nbaStamp[id] !== env.nbaGen) {
        this._nbaStamp[id] = env.nbaGen;
        this._nbaDirtyIds.push(id);
      }
      this._nbaVal[id] = nv;
      this._nbaX[id] = nx;
      this._nbaZ[id] = nz;
    };

    if (target.kind === 'Ident') {
      const id = target._sigId;
      if (id < 0 || id >= this.sigCount) return;
      const resized = _simResize(rhsVal, this.sigMeta[id].width);
      stageNbaSlot(id, resized.val, resized.xMask, resized.zMask);
      return;
    }

    if (target.kind === 'BitSelect' && target._memId < 0) {
      const id = target._sigId;
      if (id < 0 || id >= this.sigCount) return;
      const meta = this.sigMeta[id];
      const idxV = this._evalExpr(target.index, env, null);
      if (_simHasUnknown(idxV)) return;
      const bitOffset = Number(idxV.val) - meta.baseLsb;
      if (bitOffset < 0 || bitOffset >= meta.width) return;

      const cur = readBaseForNba(id);
      const shift = BigInt(bitOffset);
      const clearMask = ~(1n << shift);
      const nz = ((cur.zMask & clearMask) | ((rhsVal.zMask & 1n) << shift)) & meta.mask;
      const nx = (((cur.xMask & clearMask) | ((rhsVal.xMask & 1n) << shift)) & meta.mask) & ~nz;
      const nv = (((cur.val & clearMask) | ((rhsVal.val & 1n) << shift)) & meta.mask) & ~nx & ~nz;
      stageNbaSlot(id, nv, nx, nz);
      return;
    }

    if (target.kind === 'PartSelect') {
      const id = target._sigId;
      if (id < 0 || id >= this.sigCount) return;
      const meta = this.sigMeta[id];
      const msbV = this._evalExpr(target.msb, env, null);
      const lsbV = this._evalExpr(target.lsb, env, null);
      if (_simHasUnknown(msbV) || _simHasUnknown(lsbV)) return;

      const hi = Math.max(Number(msbV.val), Number(lsbV.val));
      const lo = Math.min(Number(msbV.val), Number(lsbV.val));
      const sliceWidth = hi - lo + 1;
      const shiftAmt = lo - meta.baseLsb;
      if (shiftAmt < 0) return;

      const cur = readBaseForNba(id);
      const shift = BigInt(shiftAmt);
      const sliceMask = _simMask(sliceWidth);
      const clearMask = ~(sliceMask << shift);
      const resized = _simResize(rhsVal, sliceWidth);

      const nz = ((cur.zMask & clearMask) | ((resized.zMask & sliceMask) << shift)) & meta.mask;
      const nx = (((cur.xMask & clearMask) | ((resized.xMask & sliceMask) << shift)) & meta.mask) & ~nz;
      const nv = (((cur.val & clearMask) | ((resized.val & sliceMask) << shift)) & meta.mask) & ~nx & ~nz;
      stageNbaSlot(id, nv, nx, nz);
      return;
    }

    if (target.kind === 'MemSelect' || (target.kind === 'BitSelect' && target._memId >= 0)) {
      const memId = target._memId;
      if (memId < 0 || memId >= this.memCount) return;
      const mem = this.memList[memId];
      const addrV = this._evalExpr(target.kind === 'MemSelect' ? target.addr : target.index, env, null);
      if (_simHasUnknown(addrV)) return;
      const off = Number(addrV.val) - mem.addrMin;
      if (off < 0 || off >= mem.depth) return;
      const resized = _simResize(rhsVal, mem.width);
      this._stageMemNbaWrite(memId, off, resized.val, resized.xMask, resized.zMask);
      return;
    }

    if (target.kind === 'MemBitSelect' || target.kind === 'MemPartSelect') {
      this._writeMemSubTarget(target, rhsVal, env, true, null);
      return;
    }

    if (target.kind === 'Concat') {
      let bitCursor = 0n;
      for (let idx = target.parts.length - 1; idx >= 0; idx--) {
        const part = target.parts[idx];
        const partWidth = this._getTargetWidth(part, env);
        const partMask = _simMask(partWidth);
        const slice = {
          width: partWidth,
          val: (rhsVal.val >> bitCursor) & partMask,
          xMask: (rhsVal.xMask >> bitCursor) & partMask,
          zMask: (rhsVal.zMask >> bitCursor) & partMask,
        };
        this._writeTargetNba(part, slice, env);
        bitCursor += BigInt(partWidth);
      }
    }
  }

  _stageMemNbaWrite(memId, offset, val, xMask, zMask) {
    for (let i = this._memNbaWrites.length - 1; i >= 0; i--) {
      const entry = this._memNbaWrites[i];
      if (entry.memId === memId && entry.offset === offset) {
        entry.val = val;
        entry.xMask = xMask;
        entry.zMask = zMask;
        return;
      }
    }
    this._memNbaWrites.push({ memId, offset, val, xMask, zMask });
  }

  _writeMemSubTarget(target, rhsVal, env, isNba, dirtyMemIds) {
    const memId = target._memId;
    if (memId < 0 || memId >= this.memCount) return;
    const mem = this.memList[memId];
    const addrV = this._evalExpr(target.addr, env, null);
    if (_simHasUnknown(addrV)) return;
    const off = Number(addrV.val) - mem.addrMin;
    if (off < 0 || off >= mem.depth) return;

    let curV = mem.val[off];
    let curX = mem.xMask[off];
    let curZ = mem.zMask[off];

    if (isNba) {
      for (let i = this._memNbaWrites.length - 1; i >= 0; i--) {
        const e = this._memNbaWrites[i];
        if (e.memId === memId && e.offset === off) {
          curV = e.val;
          curX = e.xMask;
          curZ = e.zMask;
          break;
        }
      }
    }

    let shiftAmt;
    let sliceWidth;
    if (target.kind === 'MemBitSelect') {
      const idxV = this._evalExpr(target.index, env, null);
      if (_simHasUnknown(idxV)) return;
      shiftAmt = Number(idxV.val) - mem.baseLsb;
      sliceWidth = 1;
      if (shiftAmt < 0 || shiftAmt >= mem.width) return;
    } else {
      const msbV = this._evalExpr(target.msb, env, null);
      const lsbV = this._evalExpr(target.lsb, env, null);
      if (_simHasUnknown(msbV) || _simHasUnknown(lsbV)) return;
      const hi = Math.max(Number(msbV.val), Number(lsbV.val));
      const lo = Math.min(Number(msbV.val), Number(lsbV.val));
      sliceWidth = hi - lo + 1;
      shiftAmt = lo - mem.baseLsb;
      if (shiftAmt < 0) return;
    }

    const shift = BigInt(shiftAmt);
    const sliceMask = _simMask(sliceWidth);
    const clearMask = ~(sliceMask << shift);
    const resized = _simResize(rhsVal, sliceWidth);

    const nz = ((curZ & clearMask) | ((resized.zMask & sliceMask) << shift)) & mem.mask;
    const nx = (((curX & clearMask) | ((resized.xMask & sliceMask) << shift)) & mem.mask) & ~nz;
    const nv = (((curV & clearMask) | ((resized.val & sliceMask) << shift)) & mem.mask) & ~nx & ~nz;

    if (isNba) {
      this._stageMemNbaWrite(memId, off, nv, nx, nz);
    } else {
      mem.val[off] = nv;
      mem.xMask[off] = nx;
      mem.zMask[off] = nz;
      if (dirtyMemIds) dirtyMemIds.push(memId);
    }
  }

  _evalExpr(node, env, contextWidth = null) {
    if (!node) return makeAllX(contextWidth || 1);

    switch (node.kind) {
      case 'Number': {
        if (node.fillBit && contextWidth) {
          const mask = _simMask(contextWidth);
          if (node.fillBit === '0') return { width: contextWidth, val: 0n, xMask: 0n, zMask: 0n };
          if (node.fillBit === '1') return { width: contextWidth, val: mask, xMask: 0n, zMask: 0n };
          if (node.fillBit === 'x') return makeAllX(contextWidth);
          return makeAllZ(contextWidth);
        }
        return { width: node.width, val: node.val, xMask: node.xMask, zMask: node.zMask };
      }

      case 'Ident': {
        if (env && env.funcLocals && env.funcLocals.has(node.name)) {
          const slot = env.funcLocals.get(node.name);
          return { width: slot.width, val: slot.val, xMask: slot.xMask, zMask: slot.zMask };
        }
        if (node._paramVal) {
          const p = node._paramVal;
          return { width: p.width, val: p.val, xMask: p.xMask, zMask: p.zMask };
        }
        return this._readSig(node._sigId, env);
      }

      case 'FuncCall':
        return this._evalFuncCall(node, env, contextWidth);

      case 'SysFunc': {
        if (node.name === '$time' || node.name === '$stime' || node.name === '$realtime') {
          return createLogic4(64, BigInt(Math.max(0, Math.trunc(this._simTime || 0))));
        }
        return makeAllX(contextWidth || 32);
      }

      case 'BitSelect': {
        if (env && env.funcLocals && env.funcLocals.has(node.name)) {
          const slot = env.funcLocals.get(node.name);
          const idxV = this._evalExpr(node.index, env, null);
          if (_simHasUnknown(idxV)) return makeAllX(1);
          return _simGetBit(slot, Number(idxV.val) - slot.baseLsb);
        }
        if (node._memId >= 0) {
          return this._readMemoryElem(node._memId, node.index, env);
        }
        const sigId = node._sigId;
        const baseLsb = sigId >= 0 ? this.sigMeta[sigId].baseLsb : 0;
        const base = this._readSig(sigId, env);
        const idxV = this._evalExpr(node.index, env, null);
        if (_simHasUnknown(idxV)) return makeAllX(1);
        return _simGetBit(base, Number(idxV.val) - baseLsb);
      }

      case 'MemSelect':
        return this._readMemoryElem(node._memId, node.addr, env);

      case 'MemBitSelect': {
        const memId = node._memId;
        if (memId < 0 || memId >= this.memCount) return makeAllX(1);
        const word = this._readMemoryElem(memId, node.addr, env);
        const idxV = this._evalExpr(node.index, env, null);
        if (_simHasUnknown(idxV)) return makeAllX(1);
        return _simGetBit(word, Number(idxV.val) - this.memList[memId].baseLsb);
      }

      case 'MemPartSelect': {
        const memId = node._memId;
        if (memId < 0 || memId >= this.memCount) return makeAllX(1);
        const word = this._readMemoryElem(memId, node.addr, env);
        const msbV = this._evalExpr(node.msb, env, null);
        const lsbV = this._evalExpr(node.lsb, env, null);
        if (_simHasUnknown(msbV) || _simHasUnknown(lsbV)) return makeAllX(1);
        const hi = Math.max(Number(msbV.val), Number(lsbV.val));
        const lo = Math.min(Number(msbV.val), Number(lsbV.val));
        const sliceWidth = hi - lo + 1;
        const shift = BigInt(Math.max(0, lo - this.memList[memId].baseLsb));
        return createLogic4(sliceWidth, word.val >> shift, word.xMask >> shift, word.zMask >> shift);
      }

      case 'PartSelect': {
        let base;
        let baseLsb;
        if (env && env.funcLocals && env.funcLocals.has(node.name)) {
          const slot = env.funcLocals.get(node.name);
          base = slot;
          baseLsb = slot.baseLsb;
        } else {
          const sigId = node._sigId;
          baseLsb = sigId >= 0 ? this.sigMeta[sigId].baseLsb : 0;
          base = this._readSig(sigId, env);
        }
        const msbV = this._evalExpr(node.msb, env, null);
        const lsbV = this._evalExpr(node.lsb, env, null);
        if (_simHasUnknown(msbV) || _simHasUnknown(lsbV)) return makeAllX(1);

        const hi = Math.max(Number(msbV.val), Number(lsbV.val));
        const lo = Math.min(Number(msbV.val), Number(lsbV.val));
        const sliceWidth = hi - lo + 1;
        const shift = BigInt(Math.max(0, lo - baseLsb));
        return createLogic4(
          sliceWidth,
          base.val >> shift,
          base.xMask >> shift,
          base.zMask >> shift
        );
      }

      case 'Concat': {
        let totalWidth = 0;
        let val = 0n;
        let xMask = 0n;
        let zMask = 0n;
        for (let i = 0; i < node.parts.length; i++) {
          const pv = this._evalExpr(node.parts[i], env, null);
          const shift = BigInt(pv.width);
          val = (val << shift) | pv.val;
          xMask = (xMask << shift) | pv.xMask;
          zMask = (zMask << shift) | pv.zMask;
          totalWidth += pv.width;
        }
        return createLogic4(Math.max(1, totalWidth), val, xMask, zMask);
      }

      case 'Repeat': {
        const cntV = this._evalExpr(node.count, env, null);
        if (_simHasUnknown(cntV)) return makeAllX(1);
        const count = Number(cntV.val);
        const inner = this._evalExpr(node.expr, env, null);
        if (count <= 0) return { width: 1, val: 0n, xMask: 0n, zMask: 0n };
        let val = 0n;
        let xMask = 0n;
        let zMask = 0n;
        const shift = BigInt(inner.width);
        for (let r = 0; r < count; r++) {
          val = (val << shift) | inner.val;
          xMask = (xMask << shift) | inner.xMask;
          zMask = (zMask << shift) | inner.zMask;
        }
        return createLogic4(inner.width * count, val, xMask, zMask);
      }

      case 'Unary':
        return this._evalUnary(node, env, contextWidth);

      case 'Binary':
        return this._evalBinary(node, env, contextWidth);

      case 'Ternary': {
        const condV = this._evalExpr(node.cond, env, null);
        const truth = _simTruthiness(condV);
        if (truth === 1n) {
          return this._evalExpr(node.thenExpr, env, contextWidth);
        }
        if (truth === 0n) {
          return this._evalExpr(node.elseExpr, env, contextWidth);
        }
        const tV = this._evalExpr(node.thenExpr, env, contextWidth);
        const eV = this._evalExpr(node.elseExpr, env, contextWidth);
        const w = Math.max(contextWidth || 0, tV.width, eV.width);
        const a = _simResize(tV, w);
        const b = _simResize(eV, w);
        const mask = _simMask(w);
        const aU = a.xMask | a.zMask;
        const bU = b.xMask | b.zMask;
        const bothKnown1 = (a.val & ~aU) & (b.val & ~bU);
        const bothKnown0 = (~a.val & ~aU & mask) & (~b.val & ~bU & mask);
        const outX = ~(bothKnown1 | bothKnown0) & mask;
        return { width: w, val: bothKnown1, xMask: outX, zMask: 0n };
      }

      default:
        return makeAllX(contextWidth || 1);
    }
  }

  _readMemoryElem(memId, addrExpr, env) {
    if (memId < 0 || memId >= this.memCount) return makeAllX(1);
    const mem = this.memList[memId];
    const addrV = this._evalExpr(addrExpr, env, null);
    if (_simHasUnknown(addrV)) return makeAllX(mem.width);
    const off = Number(addrV.val) - mem.addrMin;
    if (off < 0 || off >= mem.depth) return makeAllX(mem.width);
    return {
      width: mem.width,
      val: mem.val[off],
      xMask: mem.xMask[off],
      zMask: mem.zMask[off],
    };
  }

  /**
   * Evaluate an IEEE 1364 structural primitive gate (and, or, not, nand, nor, xor, xnor, buf)
   * with full 4-state controlling-value semantics (`0 & X == 0`, `1 | X == 1`, `Z` -> `X` on input).
   */
  _evalGate(gate, readEnv) {
    const lhsW = this._getTargetWidth(gate.target, readEnv);
    const mask = _simMask(lhsW);
    const inputs = gate.inputs || [];
    if (inputs.length === 0) return makeAllX(lhsW);

    const gType = gate.gateType;
    if (gType === 'buf' || gType === 'not') {
      const v = _simResize(this._evalExpr(inputs[0], readEnv, lhsW), lhsW);
      const u = (v.xMask | v.zMask) & mask;
      if (gType === 'buf') {
        return { width: lhsW, val: v.val & ~u & mask, xMask: u, zMask: 0n };
      }
      return { width: lhsW, val: (~v.val) & ~u & mask, xMask: u, zMask: 0n };
    }

    if (gType === 'and' || gType === 'nand') {
      let any0 = 0n;
      let all1 = mask;
      for (let i = 0; i < inputs.length; i++) {
        const v = _simResize(this._evalExpr(inputs[i], readEnv, lhsW), lhsW);
        const u = (v.xMask | v.zMask) & mask;
        const k1 = v.val & ~u & mask;
        const k0 = (~v.val & ~u) & mask;
        any0 |= k0;
        all1 &= k1;
      }
      const outX = (~(any0 | all1)) & mask;
      return {
        width: lhsW,
        val: gType === 'and' ? all1 : any0,
        xMask: outX,
        zMask: 0n,
      };
    }

    if (gType === 'or' || gType === 'nor') {
      let any1 = 0n;
      let all0 = mask;
      for (let i = 0; i < inputs.length; i++) {
        const v = _simResize(this._evalExpr(inputs[i], readEnv, lhsW), lhsW);
        const u = (v.xMask | v.zMask) & mask;
        const k1 = v.val & ~u & mask;
        const k0 = (~v.val & ~u) & mask;
        any1 |= k1;
        all0 &= k0;
      }
      const outX = (~(any1 | all0)) & mask;
      return {
        width: lhsW,
        val: gType === 'or' ? any1 : all0,
        xMask: outX,
        zMask: 0n,
      };
    }

    if (gType === 'xor' || gType === 'xnor') {
      let anyU = 0n;
      let parity = 0n;
      for (let i = 0; i < inputs.length; i++) {
        const v = _simResize(this._evalExpr(inputs[i], readEnv, lhsW), lhsW);
        const u = (v.xMask | v.zMask) & mask;
        anyU |= u;
        parity ^= v.val & ~u & mask;
      }
      const outX = anyU & mask;
      const outVal = gType === 'xor' ? (parity & ~outX & mask) : ((~parity) & ~outX & mask);
      return { width: lhsW, val: outVal, xMask: outX, zMask: 0n };
    }

    return makeAllX(lhsW);
  }

  /**
   * Deterministically evaluate a combinational Verilog `function ... endfunction` call
   * with isolated local variable & return-value scope.
   */
  _evalFuncCall(node, env, contextWidth) {
    const fnDef = this._functions[node.name] || (node.localName ? this._functions[node.localName] : null);
    if (!fnDef) return makeAllX(contextWidth || 1);
    const depth = (env && env.funcDepth) ? env.funcDepth : 0;
    if (depth >= _SIM_MAX_FUNC_DEPTH) return makeAllX(fnDef.returnWidth || 1);

    const localScope = new Map();
    const retName = fnDef.localName || fnDef.name;
    const retW = Math.max(1, fnDef.returnWidth || 1);
    const retMask = _simMask(retW);
    localScope.set(retName, {
      width: retW,
      val: 0n,
      xMask: retMask,
      zMask: 0n,
      baseLsb: Math.min(fnDef.returnMsb ?? 0, fnDef.returnLsb ?? 0),
      mask: retMask,
    });

    const formalArgs = fnDef.args || [];
    const actualArgs = node.args || [];
    for (let i = 0; i < formalArgs.length; i++) {
      const fa = formalArgs[i];
      const aw = Math.max(1, fa.width || 1);
      const aMask = _simMask(aw);
      const evaled = i < actualArgs.length
        ? _simResize(this._evalExpr(actualArgs[i], env, aw), aw)
        : makeAllX(aw);
      localScope.set(fa.name, {
        width: aw,
        val: evaled.val,
        xMask: evaled.xMask,
        zMask: evaled.zMask,
        baseLsb: Math.min(fa.msb ?? 0, fa.lsb ?? 0),
        mask: aMask,
      });
    }

    for (const loc of fnDef.locals || []) {
      const lw = Math.max(1, loc.width || 1);
      const lMask = _simMask(lw);
      localScope.set(loc.name, {
        width: lw,
        val: 0n,
        xMask: lMask,
        zMask: 0n,
        baseLsb: Math.min(loc.msb ?? 0, loc.lsb ?? 0),
        mask: lMask,
      });
    }

    const fnEnv = {
      ...(env || { useOverlay: false }),
      isSeq: false,
      funcLocals: localScope,
      funcReturnName: retName,
      funcReturned: false,
      funcDepth: depth + 1,
    };

    this._execStmt(fnDef.body, fnEnv);
    const retSlot = localScope.get(retName);
    return {
      width: retSlot.width,
      val: retSlot.val,
      xMask: retSlot.xMask,
      zMask: retSlot.zMask,
    };
  }

  _evalUnary(node, env, contextWidth) {
    const isReductionOrLogical =
      node.op === '!' ||
      node.op === '&' ||
      node.op === '|' ||
      node.op === '^' ||
      node.op === '~&' ||
      node.op === '~|' ||
      node.op === '~^' ||
      node.op === '^~';
    const opV = this._evalExpr(node.operand, env, isReductionOrLogical ? null : contextWidth);

    switch (node.op) {
      case '~': {
        const w = Math.max(contextWidth || 0, opV.width);
        const a = _simResize(opV, w);
        const mask = _simMask(w);
        const u = (a.xMask | a.zMask) & mask;
        return { width: w, val: (~a.val) & ~u & mask, xMask: u, zMask: 0n };
      }
      case '!': {
        const t = _simTruthiness(opV);
        if (t === null) return makeAllX(1);
        return { width: 1, val: t === 0n ? 1n : 0n, xMask: 0n, zMask: 0n };
      }
      case '+': {
        const w = Math.max(contextWidth || 0, opV.width);
        const a = _simResize(opV, w);
        return _simHasUnknown(a) ? makeAllX(w) : a;
      }
      case '-': {
        const w = Math.max(contextWidth || 0, opV.width);
        const a = _simResize(opV, w);
        if (_simHasUnknown(a)) return makeAllX(w);
        return { width: w, val: (-a.val) & _simMask(w), xMask: 0n, zMask: 0n };
      }
      case '&':
      case '~&': {
        const mask = _simMask(opV.width);
        const u = (opV.xMask | opV.zMask) & mask;
        const known0 = (~opV.val & ~u) & mask;
        const inv = node.op === '~&';
        if (known0 !== 0n) return { width: 1, val: inv ? 1n : 0n, xMask: 0n, zMask: 0n };
        if (u !== 0n) return makeAllX(1);
        return { width: 1, val: inv ? 0n : 1n, xMask: 0n, zMask: 0n };
      }
      case '|':
      case '~|': {
        const mask = _simMask(opV.width);
        const u = (opV.xMask | opV.zMask) & mask;
        const known1 = (opV.val & ~u) & mask;
        const inv = node.op === '~|';
        if (known1 !== 0n) return { width: 1, val: inv ? 0n : 1n, xMask: 0n, zMask: 0n };
        if (u !== 0n) return makeAllX(1);
        return { width: 1, val: inv ? 1n : 0n, xMask: 0n, zMask: 0n };
      }
      case '^':
      case '~^':
      case '^~': {
        if (_simHasUnknown(opV)) return makeAllX(1);
        let parity = 0n;
        let tmp = opV.val;
        for (let b = 0; b < opV.width; b++) {
          parity ^= tmp & 1n;
          tmp >>= 1n;
        }
        const inv = node.op !== '^';
        return { width: 1, val: inv ? (parity ^ 1n) : parity, xMask: 0n, zMask: 0n };
      }
      default:
        return makeAllX(1);
    }
  }

  _evalBinary(node, env, contextWidth) {
    const op = node.op;

    if (op === '&&' || op === '||') {
      const l = this._evalExpr(node.left, env, null);
      const r = this._evalExpr(node.right, env, null);
      const lt = _simTruthiness(l);
      const rt = _simTruthiness(r);
      if (op === '&&') {
        if (lt === 0n || rt === 0n) return { width: 1, val: 0n, xMask: 0n, zMask: 0n };
        if (lt === null || rt === null) return makeAllX(1);
        return { width: 1, val: 1n, xMask: 0n, zMask: 0n };
      }
      if (lt === 1n || rt === 1n) return { width: 1, val: 1n, xMask: 0n, zMask: 0n };
      if (lt === null || rt === null) return makeAllX(1);
      return { width: 1, val: 0n, xMask: 0n, zMask: 0n };
    }

    if (
      op === '==' || op === '!=' || op === '===' || op === '!==' ||
      op === '<' || op === '<=' || op === '>' || op === '>='
    ) {
      const l = this._evalExpr(node.left, env, null);
      const r = this._evalExpr(node.right, env, null);
      const w = Math.max(l.width, r.width);
      const a = _simResize(l, w);
      const b = _simResize(r, w);

      if (op === '===') return { width: 1, val: _simEquals(a, b) ? 1n : 0n, xMask: 0n, zMask: 0n };
      if (op === '!==') return { width: 1, val: _simEquals(a, b) ? 0n : 1n, xMask: 0n, zMask: 0n };

      if (_simHasUnknown(a) || _simHasUnknown(b)) {
        return makeAllX(1);
      }
      const isSignedRef = (nd) =>
        nd && nd.kind === 'Ident' && nd._sigId >= 0 && this.sigMeta[nd._sigId]?.isSigned;
      let av = a.val;
      let bv = b.val;
      if ((op === '<' || op === '<=' || op === '>' || op === '>=') && (isSignedRef(node.left) || isSignedRef(node.right))) {
        const signBit = 1n << BigInt(w - 1);
        const mod = 1n << BigInt(w);
        if (av & signBit) av -= mod;
        if (bv & signBit) bv -= mod;
      }
      let res = false;
      if (op === '==') res = av === bv;
      else if (op === '!=') res = av !== bv;
      else if (op === '<') res = av < bv;
      else if (op === '<=') res = av <= bv;
      else if (op === '>') res = av > bv;
      else if (op === '>=') res = av >= bv;
      return { width: 1, val: res ? 1n : 0n, xMask: 0n, zMask: 0n };
    }

    if (op === '<<' || op === '>>' || op === '<<<' || op === '>>>') {
      const l = this._evalExpr(node.left, env, contextWidth);
      const r = this._evalExpr(node.right, env, null);
      const w = Math.max(contextWidth || 0, l.width);
      const a = _simResize(l, w);
      if (_simHasUnknown(r)) return makeAllX(w);
      const sh = r.val;
      if (op === '<<' || op === '<<<') {
        if (sh >= BigInt(w)) return { width: w, val: 0n, xMask: 0n, zMask: 0n };
        return createLogic4(w, a.val << sh, a.xMask << sh, a.zMask << sh);
      }
      if (op === '>>>') {
        const msbBit = 1n << BigInt(w - 1);
        const signVal = (a.val & msbBit) !== 0n;
        const signX = ((a.xMask | a.zMask) & msbBit) !== 0n;
        const mask = _simMask(w);
        if (sh >= BigInt(w)) {
          if (signX) return makeAllX(w);
          return { width: w, val: signVal ? mask : 0n, xMask: 0n, zMask: 0n };
        }
        const fillMask = mask ^ ((1n << (BigInt(w) - sh)) - 1n);
        const outV = (a.val >> sh) | (signVal && !signX ? fillMask : 0n);
        const outX = (a.xMask >> sh) | (signX ? fillMask : 0n);
        const outZ = a.zMask >> sh;
        return createLogic4(w, outV, outX, outZ);
      }
      if (sh >= BigInt(w)) {
        return { width: w, val: 0n, xMask: 0n, zMask: 0n };
      }
      return createLogic4(w, a.val >> sh, a.xMask >> sh, a.zMask >> sh);
    }

    const lRaw = this._evalExpr(node.left, env, contextWidth);
    const rRaw = this._evalExpr(node.right, env, contextWidth);

    const lEffW = (node.left.kind === 'Number' && !node.left.sized) ? 0 : lRaw.width;
    const rEffW = (node.right.kind === 'Number' && !node.right.sized) ? 0 : rRaw.width;
    const w = Math.max(contextWidth || 0, lEffW, rEffW) || Math.max(lRaw.width, rRaw.width);

    const a = _simResize(lRaw, w);
    const b = _simResize(rRaw, w);
    const mask = _simMask(w);

    if (op === '&' || op === '|' || op === '^' || op === '~^' || op === '^~') {
      const aU = (a.xMask | a.zMask) & mask;
      const bU = (b.xMask | b.zMask) & mask;
      const a1 = a.val & ~aU;
      const b1 = b.val & ~bU;
      const a0 = ~a.val & ~aU & mask;
      const b0 = ~b.val & ~bU & mask;

      if (op === '&') {
        const known0 = a0 | b0;
        const known1 = a1 & b1;
        const outX = ~(known0 | known1) & mask;
        return { width: w, val: known1, xMask: outX, zMask: 0n };
      }
      if (op === '|') {
        const known1 = a1 | b1;
        const known0 = a0 & b0;
        const outX = ~(known0 | known1) & mask;
        return { width: w, val: known1, xMask: outX, zMask: 0n };
      }
      const outX = (aU | bU) & mask;
      const xorVal = a.val ^ b.val;
      const outVal = (op === '^' ? xorVal : ~xorVal) & ~outX & mask;
      return { width: w, val: outVal, xMask: outX, zMask: 0n };
    }

    if (_simHasUnknown(a) || _simHasUnknown(b)) {
      return makeAllX(w);
    }

    switch (op) {
      case '+':
        return { width: w, val: (a.val + b.val) & mask, xMask: 0n, zMask: 0n };
      case '-':
        return { width: w, val: (a.val - b.val) & mask, xMask: 0n, zMask: 0n };
      case '*':
        return { width: w, val: (a.val * b.val) & mask, xMask: 0n, zMask: 0n };
      case '/':
        if (b.val === 0n) return makeAllX(w);
        return { width: w, val: (a.val / b.val) & mask, xMask: 0n, zMask: 0n };
      case '%':
        if (b.val === 0n) return makeAllX(w);
        return { width: w, val: (a.val % b.val) & mask, xMask: 0n, zMask: 0n };
      default:
        return makeAllX(w);
    }
  }
}

/**
 * Convenience factory compiling an AST or HDL source into a ready Simulator instance.
 * @param {string|object} astOrSource
 * @param {object} [options={}]
 * @returns {Simulator}
 */
export function createSimulator(astOrSource, options = {}) {
  return new Simulator(astOrSource, options);
}
