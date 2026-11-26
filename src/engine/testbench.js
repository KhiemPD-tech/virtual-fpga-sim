/**
 * Phase 2 (v4.0-B) — Deterministic Discrete-Event Testbench Engine ("Mini-ModelSim")
 *
 * Executes Verilog testbenches (`initial`, `#delay`, `always #T`, `@(posedge/negedge)`,
 * `repeat (N)`, runtime `for`, `$display`, `$write`, `$monitor`, `$finish`, `$stop`,
 * `$time`, `$readmemh`/`$readmemb`) synchronously in a deterministic time-ordered
 * priority queue with hard `maxTime` and `maxEvents` guards (never uses timers).
 */

import { parseProgram, elaborate } from './parser.js';
import { Simulator, createLogic4 } from './simulator.js';
import { synthesize, selectTopModule, isTestbenchModule } from './synthesizer.js';

export const TB_DEFAULT_MAX_TIME = 100000;
export const TB_DEFAULT_MAX_EVENTS = 100000;
export const TB_DEFAULT_MAX_TRACE = 4000;
const _TB_MAX_DELTAS_PER_TS = 128;
const _TB_MAX_SAME_TIME_LOOPS = 64;

// ============================================================================
// 4-State Display & Monitor Formatter (IEEE 1364)
// ============================================================================

function _tbFormatBin(v, widthSpec) {
  const w = Math.max(1, v.width || 1);
  let out = '';
  for (let b = w - 1; b >= 0; b--) {
    const sh = BigInt(b);
    if ((v.zMask >> sh) & 1n) out += 'z';
    else if ((v.xMask >> sh) & 1n) out += 'x';
    else out += ((v.val >> sh) & 1n) ? '1' : '0';
  }
  if (widthSpec === '0') {
    out = out.replace(/^0+(?=.)/, '');
  } else if (widthSpec) {
    const minW = parseInt(widthSpec, 10);
    if (minW > out.length) out = out.padStart(minW, '0');
  }
  return out;
}

function _tbFormatHex(v, widthSpec, upper = false) {
  const w = Math.max(1, v.width || 1);
  const nibbles = Math.ceil(w / 4);
  let out = '';
  for (let n = nibbles - 1; n >= 0; n--) {
    const sh = BigInt(n * 4);
    const bitCount = Math.min(4, w - n * 4);
    const nibMask = (1n << BigInt(bitCount)) - 1n;
    const nv = (v.val >> sh) & nibMask;
    const nx = (v.xMask >> sh) & nibMask;
    const nz = (v.zMask >> sh) & nibMask;
    if (nz === nibMask) out += upper ? 'Z' : 'z';
    else if (nx !== 0n || nz !== 0n) out += upper ? 'X' : 'x';
    else out += nv.toString(16);
  }
  if (upper) out = out.toUpperCase();
  if (widthSpec === '0') {
    out = out.replace(/^0+(?=.)/, '');
  } else if (widthSpec) {
    const minW = parseInt(widthSpec, 10);
    if (minW > out.length) out = out.padStart(minW, '0');
  }
  return out;
}

function _tbFormatOct(v, widthSpec) {
  const w = Math.max(1, v.width || 1);
  const digits = Math.ceil(w / 3);
  let out = '';
  for (let d = digits - 1; d >= 0; d--) {
    const sh = BigInt(d * 3);
    const bitCount = Math.min(3, w - d * 3);
    const mask = (1n << BigInt(bitCount)) - 1n;
    const ov = (v.val >> sh) & mask;
    const ox = (v.xMask >> sh) & mask;
    const oz = (v.zMask >> sh) & mask;
    if (oz === mask) out += 'z';
    else if (ox !== 0n || oz !== 0n) out += 'x';
    else out += ov.toString(8);
  }
  if (widthSpec === '0') out = out.replace(/^0+(?=.)/, '');
  return out;
}

function _tbFormatDec(v, widthSpec) {
  const w = Math.max(1, v.width || 1);
  const mask = (1n << BigInt(w)) - 1n;
  let out;
  if ((v.zMask & mask) === mask && (v.xMask & mask) === 0n) {
    out = 'z';
  } else if (((v.xMask | v.zMask) & mask) !== 0n) {
    out = 'x';
  } else {
    out = (v.val & mask).toString(10);
  }
  if (widthSpec && widthSpec !== '0') {
    const minW = parseInt(widthSpec, 10);
    if (minW > out.length) out = out.padStart(minW, ' ');
  }
  return out;
}

function _tbFormatStr(argNode, v) {
  if (argNode && argNode.kind === 'String') return argNode.value;
  if (!v) return '';
  const bytes = Math.ceil(Math.max(1, v.width || 8) / 8);
  let s = '';
  for (let i = bytes - 1; i >= 0; i--) {
    const ch = Number((v.val >> BigInt(i * 8)) & 0xFFn);
    if (ch !== 0) s += String.fromCharCode(ch);
  }
  return s;
}

/**
 * Format a Verilog `$display` / `$write` / `$monitor` argument list with full
 * 4-state (`x`/`z`) support for `%b`, `%h`/`%x`, `%d`, `%0d`, `%0h`, `%0b`, `%o`, `%s`, `%c`, `%t`.
 *
 * @param {object[]} args
 * @param {(expr: object) => { width: number, val: bigint, xMask: bigint, zMask: bigint }} evalExpr
 * @param {number} [simTime=0]
 * @returns {string}
 */
export function formatVerilogDisplay(args, evalExpr, simTime = 0) {
  if (!args || args.length === 0) return '';
  const outParts = [];
  let i = 0;

  while (i < args.length) {
    const arg = args[i++];
    if (arg && arg.kind === 'String') {
      const formatted = arg.value.replace(/%([0-9]*)([bBhHxXdDoOsScCtT%])/g, (_, widthSpec, spec) => {
        if (spec === '%') return '%';
        const valNode = i < args.length ? args[i++] : null;
        if (spec === 's' || spec === 'S') {
          if (valNode && valNode.kind === 'String') return valNode.value;
          return _tbFormatStr(valNode, valNode ? evalExpr(valNode) : null);
        }
        if (spec === 't' || spec === 'T') {
          const tv = valNode ? evalExpr(valNode) : createLogic4(64, BigInt(Math.max(0, Math.trunc(simTime))));
          return _tbFormatDec(tv, widthSpec);
        }
        const v = valNode ? evalExpr(valNode) : createLogic4(1, 0n, 1n, 0n);
        switch (spec) {
          case 'b':
          case 'B':
            return _tbFormatBin(v, widthSpec);
          case 'h':
          case 'x':
            return _tbFormatHex(v, widthSpec, false);
          case 'H':
          case 'X':
            return _tbFormatHex(v, widthSpec, true);
          case 'o':
          case 'O':
            return _tbFormatOct(v, widthSpec);
          case 'd':
          case 'D':
            return _tbFormatDec(v, widthSpec);
          case 'c':
          case 'C':
            return String.fromCharCode(Number(v.val & 0xFFn));
          default:
            return '';
        }
      });
      outParts.push(formatted);
    } else if (arg) {
      const v = evalExpr(arg);
      outParts.push(_tbFormatDec(v, '0'));
    }
  }

  return outParts.join('');
}

// ============================================================================
// Binary Min-Heap & Expression / Case / Edge Helpers
// ============================================================================

function _tbHeapLess(a, b) {
  return a.time < b.time || (a.time === b.time && a.seq < b.seq);
}

function _tbHeapPush(heap, item) {
  heap.push(item);
  let i = heap.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (!_tbHeapLess(heap[i], heap[p])) break;
    const tmp = heap[p];
    heap[p] = heap[i];
    heap[i] = tmp;
    i = p;
  }
}

function _tbHeapPop(heap) {
  if (heap.length === 0) return null;
  const top = heap[0];
  const last = heap.pop();
  if (heap.length > 0) {
    heap[0] = last;
    let i = 0;
    const n = heap.length;
    while (true) {
      const l = (i << 1) + 1;
      const r = l + 1;
      let sm = i;
      if (l < n && _tbHeapLess(heap[l], heap[sm])) sm = l;
      if (r < n && _tbHeapLess(heap[r], heap[sm])) sm = r;
      if (sm === i) break;
      const tmp = heap[sm];
      heap[sm] = heap[i];
      heap[i] = tmp;
      i = sm;
    }
  }
  return top;
}

function _tbIsTruthy(v) {
  const mask = (1n << BigInt(Math.max(1, v.width || 1))) - 1n;
  return (v.val & ~(v.xMask | v.zMask) & mask) !== 0n;
}

function _tbCaseMatch(a, b, caseKind) {
  const w = Math.max(a.width || 1, b.width || 1);
  const mask = (1n << BigInt(w)) - 1n;
  const av = a.val & mask;
  const ax = a.xMask & mask;
  const az = a.zMask & mask;
  const bv = b.val & mask;
  const bx = b.xMask & mask;
  const bz = b.zMask & mask;

  if (caseKind === 'casex') {
    const dc = ax | az | bx | bz;
    return ((av ^ bv) & ~dc & mask) === 0n;
  }
  if (caseKind === 'casez') {
    const dc = az | bz;
    const care = ~dc & mask;
    return (((av ^ bv) | (ax ^ bx)) & care) === 0n;
  }
  return av === bv && ax === bx && az === bz;
}

function _tbCheckWaiterMatch(waiter, preSnap, sim) {
  for (let i = 0; i < waiter.sensitivity.length; i++) {
    const sens = waiter.sensitivity[i];
    const sigId = sens._sigId;
    if (sigId === undefined || sigId < 0 || sigId >= sim.sigCount) continue;
    const prev = preSnap.get(sigId);
    if (!prev) continue;

    const curV = sim.sigVal[sigId];
    const curX = sim.sigX[sigId];
    const curZ = sim.sigZ[sigId];
    if (curV === prev.v && curX === prev.x && curZ === prev.z) continue;

    if (!sens.edge) return true; // Level/any-change `@(sig)`

    const meta = sim.sigMeta[sigId];
    let bitOffset = 0;
    if (sens.index) {
      const idxV = sim.tbEvalExpr(sens.index, null);
      if ((idxV.xMask | idxV.zMask) !== 0n) continue;
      bitOffset = Number(idxV.val) - meta.baseLsb;
    }
    if (bitOffset < 0 || bitOffset >= meta.width) continue;

    const sh = BigInt(bitOffset);
    const pU = ((prev.x | prev.z) >> sh) & 1n;
    const cU = ((curX | curZ) >> sh) & 1n;
    const pBit = (prev.v >> sh) & 1n;
    const cBit = (curV >> sh) & 1n;

    if (cU === 0n) {
      if (sens.edge === 'posedge' && cBit === 1n && (pU !== 0n || pBit === 0n)) return true;
      if (sens.edge === 'negedge' && cBit === 0n && (pU !== 0n || pBit === 1n)) return true;
    }
  }
  return false;
}

function _tbIsTimeArg(node) {
  return Boolean(
    node &&
    node.kind === 'SysFunc' &&
    (node.name === '$time' || node.name === '$stime' || node.name === '$realtime')
  );
}

function _tbMonitorKey(args, sim) {
  const parts = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a || a.kind === 'String' || _tbIsTimeArg(a)) continue;
    const v = sim.tbEvalExpr(a, null);
    parts.push(`${v.width}:${v.val}:${v.xMask}:${v.zMask}`);
  }
  return parts.join('|');
}

function _tbResolveMemFile(fileName, options) {
  if (!fileName) return null;
  const target = String(fileName).trim();
  const baseTarget = target.split(/[\\/]/).pop().toLowerCase();

  if (options.inlineMemories && typeof options.inlineMemories === 'object') {
    if (target in options.inlineMemories) return options.inlineMemories[target];
    for (const [k, v] of Object.entries(options.inlineMemories)) {
      if (k.toLowerCase() === target.toLowerCase() || k.split(/[\\/]/).pop().toLowerCase() === baseTarget) {
        return v;
      }
    }
  }

  if (Array.isArray(options.memoryFiles)) {
    for (const f of options.memoryFiles) {
      if (!f || !f.name) continue;
      const fn = String(f.name).trim();
      if (fn.toLowerCase() === target.toLowerCase() || fn.split(/[\\/]/).pop().toLowerCase() === baseTarget) {
        return f.content ?? f.code ?? '';
      }
    }
  }
  return null;
}

function _tbResolveMemName(sim, rawName) {
  if (!rawName) return null;
  if (sim.memNameToId.has(rawName)) return rawName;
  const suffix = `.${rawName}`;
  for (const name of sim.memNames) {
    if (name.endsWith(suffix)) return name;
  }
  return null;
}

function _tbBinToHexText(binText) {
  const cleaned = String(binText || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
  return cleaned
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => {
      if (tok.startsWith('@')) return tok;
      const bits = tok.replace(/_/g, '');
      const padLen = Math.ceil(bits.length / 4) * 4;
      const padded = bits.padStart(padLen, '0');
      let hex = '';
      for (let i = 0; i < padded.length; i += 4) {
        const chunk = padded.slice(i, i + 4).toLowerCase();
        if (chunk === 'zzzz') hex += 'z';
        else if (/[xz]/.test(chunk)) hex += 'x';
        else hex += parseInt(chunk, 2).toString(16);
      }
      return hex;
    })
    .join('\n');
}

// ============================================================================
// Main Testbench Execution Entry Point
// ============================================================================

/**
 * Execute a Verilog testbench synchronously in a deterministic discrete-event queue.
 *
 * @param {string|object} astOrSource - Raw Verilog source, `parseProgram()` result, or Module AST
 * @param {{
 *   topModule?: string,
 *   maxTime?: number,
 *   maxEvents?: number,
 *   maxTraceFrames?: number,
 *   memoryFiles?: Array<{ name: string, content?: string, code?: string }>,
 *   inlineMemories?: Record<string, string>,
 *   device?: object
 * }} [options={}]
 * @returns {{
 *   topModule: string,
 *   dutModule: string|null,
 *   logs: Array<{ time: number, type: string, text: string }>,
 *   trace: Array<{ time: number, timestamp: number, cycle: number, phase: string, signals: Record<string, object> }>,
 *   stats: { endTime: number, eventsExecuted: number, haltedBy: string, traceFrames: number },
 *   dutSynthesis: object|null,
 *   memories: object[],
 *   sim: Simulator
 * }}
 */
export function runTestbench(astOrSource, options = {}) {
  const maxTime = Number.isFinite(options.maxTime) ? Math.max(0, options.maxTime) : TB_DEFAULT_MAX_TIME;
  const maxEvents = Number.isFinite(options.maxEvents) ? Math.max(1, options.maxEvents) : TB_DEFAULT_MAX_EVENTS;
  const maxTraceFrames = Number.isFinite(options.maxTraceFrames) ? Math.max(1, options.maxTraceFrames) : TB_DEFAULT_MAX_TRACE;

  let sourceObj = astOrSource;
  if (typeof astOrSource === 'string') {
    sourceObj = parseProgram(astOrSource, options);
  }

  let tbMod = null;
  if (options.topModule && sourceObj?.modules?.[options.topModule]) {
    tbMod = sourceObj.modules[options.topModule];
    tbMod.modules = sourceObj.modules;
  } else {
    tbMod = selectTopModule(sourceObj, 'testbench') || sourceObj?.topModule || sourceObj;
  }

  const elabAst = elaborate(tbMod);

  // Extract standalone DUT synthesis report (skipping testbench wrapper & timing blocks)
  let dutMod = selectTopModule(sourceObj, 'board');
  if (dutMod && (dutMod.name === elabAst.name || isTestbenchModule(dutMod))) {
    dutMod = null;
  }
  if (!dutMod && Array.isArray(elabAst.instances) && elabAst.instances.length > 0 && elabAst.modules) {
    for (const inst of elabAst.instances) {
      const candidate = elabAst.modules[inst.moduleName];
      if (candidate && !isTestbenchModule(candidate)) {
        candidate.modules = elabAst.modules;
        dutMod = candidate;
        break;
      }
    }
  }
  if (!dutMod && !isTestbenchModule(tbMod)) {
    dutMod = tbMod;
  }

  let dutSynthesis = null;
  if (dutMod) {
    try {
      dutSynthesis = synthesize(dutMod, { device: options.device });
    } catch (_) {
      dutSynthesis = null;
    }
  }

  const sim = new Simulator(elabAst, { skipInitial: true, ieeeEdges: true });
  const logs = [];
  const trace = [];
  const heap = [];
  const eventWaiters = [];

  let nextSeq = 1;
  let simTime = 0;
  let eventsExecuted = 0;
  let halted = false;
  let haltedBy = 'completed';
  let activeMonitor = null;
  let monitorEnabled = true;

  // Spawn initial blocks first (deterministic t=0 init order), then always #T blocks
  let procIdCounter = 0;
  for (const initBlk of elabAst.initialBlocks || []) {
    const proc = {
      id: procIdCounter++,
      isAlways: false,
      stack: [{ kind: 'stmt', stmt: initBlk.body }],
      done: false,
      sameTimeLoops: 0,
      lastLoopTime: -1,
    };
    _tbHeapPush(heap, { time: 0, seq: nextSeq++, proc });
  }
  for (const blk of elabAst.alwaysBlocks || []) {
    if (blk.mode !== 'tb') continue;
    const proc = {
      id: procIdCounter++,
      isAlways: true,
      stack: [{ kind: 'always', body: blk.body }],
      done: false,
      sameTimeLoops: 0,
      lastLoopTime: -1,
    };
    _tbHeapPush(heap, { time: 0, seq: nextSeq++, proc });
  }

  const evalExpr = (expr, cw = null) => sim.tbEvalExpr(expr, cw);

  const stepProcess = (proc, changedMap, dirtyMemIds, nbaQueue) => {
    while (proc.stack.length > 0 && !halted) {
      eventsExecuted++;
      if (eventsExecuted > maxEvents) {
        halted = true;
        haltedBy = 'maxEvents';
        return 'halted';
      }

      const top = proc.stack[proc.stack.length - 1];

      if (top.kind === 'always') {
        if (proc.lastLoopTime === simTime) {
          proc.sameTimeLoops++;
          if (proc.sameTimeLoops > _TB_MAX_SAME_TIME_LOOPS) {
            proc.done = true;
            proc.stack.length = 0;
            logs.push({
              time: simTime,
              type: 'warning',
              text: `[tb] Zero-delay loop guard halted always process at t=${simTime}ns`,
            });
            return 'done';
          }
        } else {
          proc.lastLoopTime = simTime;
          proc.sameTimeLoops = 0;
        }
        proc.stack.push({ kind: 'stmt', stmt: top.body });
        continue;
      }

      if (top.kind === 'block') {
        if (top.idx >= top.statements.length) {
          proc.stack.pop();
          continue;
        }
        const nextStmt = top.statements[top.idx++];
        proc.stack.push({ kind: 'stmt', stmt: nextStmt });
        continue;
      }

      if (top.kind === 'repeat') {
        if (top.remaining <= 0) {
          proc.stack.pop();
          continue;
        }
        top.remaining--;
        proc.stack.push({ kind: 'stmt', stmt: top.body });
        continue;
      }

      if (top.kind === 'for') {
        const fs = top.stmt;
        const sid = fs._loopSigId;
        if (sid === undefined || sid < 0 || sid >= sim.sigCount) {
          proc.stack.pop();
          continue;
        }
        const meta = sim.sigMeta[sid];
        if (top.phase === 'init') {
          const iv = evalExpr(fs.initExpr, meta.width);
          sim.tbWriteTarget({ kind: 'Ident', name: fs.loopVar, _sigId: sid }, iv, changedMap, dirtyMemIds);
          top.phase = 'cond';
          continue;
        }
        if (top.phase === 'cond') {
          const cv = evalExpr(fs.condExpr, null);
          if (_tbIsTruthy(cv)) {
            top.phase = 'step';
            proc.stack.push({ kind: 'stmt', stmt: fs.body });
          } else {
            proc.stack.pop();
          }
          continue;
        }
        // phase === 'step'
        const sv = evalExpr(fs.stepExpr, meta.width);
        sim.tbWriteTarget({ kind: 'Ident', name: fs.loopVar, _sigId: sid }, sv, changedMap, dirtyMemIds);
        top.phase = 'cond';
        continue;
      }

      // top.kind === 'stmt'
      proc.stack.pop();
      const stmt = top.stmt;
      if (!stmt || stmt.kind === 'Noop') continue;

      switch (stmt.kind) {
        case 'Block':
          if (stmt.statements && stmt.statements.length > 0) {
            proc.stack.push({ kind: 'block', statements: stmt.statements, idx: 0 });
          }
          break;

        case 'ProcAssign': {
          const lhsW = sim.tbGetTargetWidth(stmt.target);
          const rhsV = evalExpr(stmt.expr, lhsW);
          if (stmt.op === '<=') {
            nbaQueue.push({ target: stmt.target, val: rhsV });
          } else {
            sim.tbWriteTarget(stmt.target, rhsV, changedMap, dirtyMemIds);
          }
          break;
        }

        case 'If': {
          const cv = evalExpr(stmt.cond, null);
          if (_tbIsTruthy(cv)) {
            if (stmt.thenBranch) proc.stack.push({ kind: 'stmt', stmt: stmt.thenBranch });
          } else if (stmt.elseBranch) {
            proc.stack.push({ kind: 'stmt', stmt: stmt.elseBranch });
          }
          break;
        }

        case 'Case': {
          const kv = evalExpr(stmt.expr, null);
          let matched = false;
          for (let ci = 0; ci < (stmt.items || []).length; ci++) {
            const it = stmt.items[ci];
            for (let pi = 0; pi < (it.patterns || []).length; pi++) {
              const pv = evalExpr(it.patterns[pi], kv.width);
              if (_tbCaseMatch(kv, pv, stmt.caseKind || 'case')) {
                if (it.stmt) proc.stack.push({ kind: 'stmt', stmt: it.stmt });
                matched = true;
                break;
              }
            }
            if (matched) break;
          }
          if (!matched && stmt.defaultBranch) {
            proc.stack.push({ kind: 'stmt', stmt: stmt.defaultBranch });
          }
          break;
        }

        case 'For':
          proc.stack.push({ kind: 'for', stmt, phase: 'init' });
          break;

        case 'RepeatStmt': {
          const cntV = evalExpr(stmt.count, null);
          if ((cntV.xMask | cntV.zMask) === 0n) {
            const n = Math.max(0, Number(cntV.val));
            if (n > 0) proc.stack.push({ kind: 'repeat', remaining: n, body: stmt.body });
          }
          break;
        }

        case 'Delay': {
          const dv = evalExpr(stmt.delay, null);
          const dt = (dv.xMask | dv.zMask) === 0n ? Math.max(0, Number(dv.val)) : 0;
          if (stmt.stmt) {
            proc.stack.push({ kind: 'stmt', stmt: stmt.stmt });
          }
          _tbHeapPush(heap, { time: simTime + dt, seq: nextSeq++, proc });
          return 'suspended';
        }

        case 'EventCtrl': {
          if (stmt.stmt) {
            proc.stack.push({ kind: 'stmt', stmt: stmt.stmt });
          }
          eventWaiters.push({ proc, sensitivity: stmt.sensitivity || [] });
          return 'suspended';
        }

        case 'SystemCall': {
          const name = stmt.name;
          if (name === '$display' || name === '$write') {
            const text = formatVerilogDisplay(stmt.args, evalExpr, simTime);
            logs.push({ time: simTime, type: name === '$write' ? 'write' : 'display', text });
          } else if (name === '$monitor') {
            activeMonitor = { args: stmt.args || [], lastKey: null, dirty: true };
            monitorEnabled = true;
          } else if (name === '$monitoroff') {
            monitorEnabled = false;
          } else if (name === '$monitoron') {
            monitorEnabled = true;
          } else if (name === '$finish' || name === '$stop') {
            halted = true;
            haltedBy = name;
            return 'halted';
          } else if (name === '$readmemh' || name === '$readmemb') {
            const fArg = stmt.args?.[0];
            const mArg = stmt.args?.[1];
            const fileName = fArg && fArg.kind === 'String' ? fArg.value : '';
            const rawMemName = mArg?.name || '';
            const memName = _tbResolveMemName(sim, rawMemName);
            const rawContent = _tbResolveMemFile(fileName, options);
            if (!memName) {
              logs.push({ time: simTime, type: 'warning', text: `${name}: unknown memory '${rawMemName}'` });
            } else if (rawContent === null) {
              logs.push({ time: simTime, type: 'warning', text: `${name}: file '${fileName}' not found in workspace` });
            } else {
              const hexText = name === '$readmemb' ? _tbBinToHexText(rawContent) : rawContent;
              sim.loadMemoryHex(memName, hexText);
              const memId = sim.memNameToId.get(memName);
              if (memId !== undefined) dirtyMemIds.push(memId);
            }
          }
          break;
        }
      }
    }

    if (!halted) proc.done = true;
    return halted ? 'halted' : 'done';
  };

  const snapshotWaiterSignals = () => {
    const snap = new Map();
    for (let i = 0; i < eventWaiters.length; i++) {
      const sensList = eventWaiters[i].sensitivity;
      for (let j = 0; j < sensList.length; j++) {
        const sid = sensList[j]._sigId;
        if (sid !== undefined && sid >= 0 && sid < sim.sigCount && !snap.has(sid)) {
          snap.set(sid, { v: sim.sigVal[sid], x: sim.sigX[sid], z: sim.sigZ[sid] });
        }
      }
    }
    return snap;
  };

  const wakeMatchingWaiters = (preSnap, outQueue) => {
    if (eventWaiters.length === 0 || preSnap.size === 0) return;
    let writeIdx = 0;
    for (let i = 0; i < eventWaiters.length; i++) {
      const w = eventWaiters[i];
      if (_tbCheckWaiterMatch(w, preSnap, sim)) {
        outQueue.push(w.proc);
      } else {
        eventWaiters[writeIdx++] = w;
      }
    }
    eventWaiters.length = writeIdx;
  };

  // Main synchronous discrete-event simulation loop
  while (heap.length > 0 && !halted) {
    const peekEv = heap[0];
    if (peekEv.time > maxTime) {
      haltedBy = 'maxTime';
      break;
    }

    simTime = peekEv.time;
    sim._simTime = simTime;

    let readyQueue = [];
    while (heap.length > 0 && heap[0].time === simTime) {
      readyQueue.push(_tbHeapPop(heap).proc);
    }

    const nbaQueue = [];
    let deltaCount = 0;

    while (!halted && deltaCount < _TB_MAX_DELTAS_PER_TS) {
      deltaCount++;
      const preSnap = snapshotWaiterSignals();
      const changedMap = new Map();
      const dirtyMemIds = [];

      for (let i = 0; i < readyQueue.length && !halted; i++) {
        stepProcess(readyQueue[i], changedMap, dirtyMemIds, nbaQueue);
      }

      if (changedMap.size > 0 || dirtyMemIds.length > 0) {
        sim.tbPropagateChanges(changedMap, dirtyMemIds);
      }
      if (sim.halted) {
        halted = true;
        haltedBy = 'runtimeError';
        break;
      }

      const nextReady = [];
      if (!halted) {
        wakeMatchingWaiters(preSnap, nextReady);
      }

      // Pop any #0 scheduled processes at the current timestamp
      while (!halted && heap.length > 0 && heap[0].time === simTime) {
        nextReady.push(_tbHeapPop(heap).proc);
      }

      // IEEE 1364 NBA region: commit queued <= writes once active delta drains
      if (!halted && nextReady.length === 0 && nbaQueue.length > 0) {
        const nbaPreSnap = snapshotWaiterSignals();
        const nbaChanged = new Map();
        const nbaMems = [];
        const batch = nbaQueue.splice(0, nbaQueue.length);
        for (let i = 0; i < batch.length; i++) {
          sim.tbWriteTarget(batch[i].target, batch[i].val, nbaChanged, nbaMems);
        }
        if (nbaChanged.size > 0 || nbaMems.length > 0) {
          sim.tbPropagateChanges(nbaChanged, nbaMems);
        }
        if (sim.halted) {
          halted = true;
          haltedBy = 'runtimeError';
          break;
        }
        wakeMatchingWaiters(nbaPreSnap, nextReady);
      }

      if (nextReady.length === 0) break;
      readyQueue = nextReady;
    }

    // Postponed region: evaluate $monitor (only on non-$time value changes)
    if (!halted && activeMonitor && monitorEnabled) {
      const curKey = _tbMonitorKey(activeMonitor.args, sim);
      if (activeMonitor.dirty || curKey !== activeMonitor.lastKey) {
        activeMonitor.lastKey = curKey;
        activeMonitor.dirty = false;
        const text = formatVerilogDisplay(activeMonitor.args, evalExpr, simTime);
        logs.push({ time: simTime, type: 'monitor', text });
      }
    }

    // Record timestamped waveform frame for this discrete timestamp
    if (trace.length < maxTraceFrames) {
      trace.push({
        time: simTime,
        timestamp: simTime,
        cycle: sim.cycle,
        phase: 'tb',
        signals: sim.getSnapshot().signals,
      });
    }
  }

  return {
    topModule: elabAst.name,
    dutModule: dutSynthesis ? dutSynthesis.moduleName : (dutMod ? dutMod.name : null),
    logs,
    trace,
    stats: {
      endTime: simTime,
      eventsExecuted,
      haltedBy,
      traceFrames: trace.length,
    },
    dutSynthesis,
    memories: sim.listMemories(),
    sim,
  };
}
