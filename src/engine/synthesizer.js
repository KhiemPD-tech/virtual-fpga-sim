/**
 * Phase 2 / v2.0 — AST-Based FPGA Resource Estimator & Static DRC Checker
 * Supports hierarchical multi-module designs, 2D memory BRAM bit estimation,
 * and configurable target FPGA devices (default: Altera Cyclone II EP2C35).
 */

import { createDiagnostic } from './lexer.js';
import { parseProgram, elaborate, evalConstExprAst } from './parser.js';

export const EP2C35_TOTAL_LES = 33216;
export const EP2C35_BRAM_BITS = 483840; // 105 x M4K blocks (4,608 bits/block)
export const CYCLONE2_LUT_DELAY_NS = 0.65;
export const CYCLONE2_ROUTING_DELAY_NS = 0.35;

export const DEFAULT_FPGA_DEVICE = Object.freeze({
  name: 'Altera Cyclone II EP2C35',
  totalLEs: EP2C35_TOTAL_LES,
  bramBits: EP2C35_BRAM_BITS,
  dspCount: 35,
});

function _synEvalStaticInt(node, params) {
  if (!node) return null;
  if (node.kind === 'Number' && node.xMask === 0n && node.zMask === 0n) {
    return Number(node.val);
  }
  if (node.kind === 'Ident' && params && node.name in params) {
    return Number(params[node.name].val);
  }
  if (node.kind === 'Binary' || node.kind === 'Unary' || node.kind === 'Ternary' || node.kind === 'SysFunc') {
    return evalConstExprAst(node, params || {});
  }
  return null;
}

function _synIsMemory(name, ast) {
  return Boolean(ast.memories && name in ast.memories);
}

function _synCollectTargetRanges(target, ast, out = []) {
  if (!target) return out;
  if (target.kind === 'Concat') {
    for (const part of target.parts) {
      _synCollectTargetRanges(part, ast, out);
    }
    return out;
  }

  // Unpacked 2D memory write targets (MemSelect / MemBitSelect / MemPartSelect)
  if (
    target.kind === 'MemSelect' ||
    target.kind === 'MemBitSelect' ||
    target.kind === 'MemPartSelect' ||
    (target.kind === 'BitSelect' && _synIsMemory(target.name, ast))
  ) {
    const mem = ast.memories?.[target.name];
    const fullLo = mem ? Math.min(mem.msb, mem.lsb) : 0;
    const fullHi = mem ? Math.max(mem.msb, mem.lsb) : 0;
    let width = mem ? mem.width : 1;
    if (target.kind === 'MemBitSelect') {
      width = 1;
    } else if (target.kind === 'MemPartSelect') {
      const m = _synEvalStaticInt(target.msb, ast.params);
      const l = _synEvalStaticInt(target.lsb, ast.params);
      if (m !== null && l !== null) width = Math.abs(m - l) + 1;
    }
    out.push({
      name: target.name,
      lo: fullLo,
      hi: fullHi,
      width,
      isMemory: true,
      line: target.line,
    });
    return out;
  }

  const sig = ast.signals[target.name];
  const fullLo = sig ? Math.min(sig.msb, sig.lsb) : 0;
  const fullHi = sig ? Math.max(sig.msb, sig.lsb) : 0;

  if (target.kind === 'Ident') {
    out.push({ name: target.name, lo: fullLo, hi: fullHi, width: fullHi - fullLo + 1, isMemory: false, line: target.line });
  } else if (target.kind === 'BitSelect') {
    const idx = _synEvalStaticInt(target.index, ast.params);
    if (idx !== null) {
      out.push({ name: target.name, lo: idx, hi: idx, width: 1, isMemory: false, line: target.line });
    } else {
      out.push({ name: target.name, lo: fullLo, hi: fullHi, width: 1, isMemory: false, line: target.line });
    }
  } else if (target.kind === 'PartSelect') {
    const m = _synEvalStaticInt(target.msb, ast.params);
    const l = _synEvalStaticInt(target.lsb, ast.params);
    if (m !== null && l !== null) {
      const lo = Math.min(m, l);
      const hi = Math.max(m, l);
      out.push({ name: target.name, lo, hi, width: hi - lo + 1, isMemory: false, line: target.line });
    } else {
      out.push({ name: target.name, lo: fullLo, hi: fullHi, width: fullHi - fullLo + 1, isMemory: false, line: target.line });
    }
  }
  return out;
}

function _synCollectStmtDepKeys(stmt, ast, out, readBitsBySig, fnSeen) {
  if (!stmt || stmt.kind === 'Noop' || stmt.kind === 'SystemCall') return;
  if (stmt.kind === 'Block') {
    for (const s of stmt.statements) _synCollectStmtDepKeys(s, ast, out, readBitsBySig, fnSeen);
  } else if (stmt.kind === 'ProcAssign') {
    _synCollectExprDepKeys(stmt.expr, ast, out, readBitsBySig, fnSeen);
  } else if (stmt.kind === 'Return') {
    if (stmt.expr) _synCollectExprDepKeys(stmt.expr, ast, out, readBitsBySig, fnSeen);
  } else if (stmt.kind === 'If') {
    _synCollectExprDepKeys(stmt.cond, ast, out, readBitsBySig, fnSeen);
    _synCollectStmtDepKeys(stmt.thenBranch, ast, out, readBitsBySig, fnSeen);
    if (stmt.elseBranch) _synCollectStmtDepKeys(stmt.elseBranch, ast, out, readBitsBySig, fnSeen);
  } else if (stmt.kind === 'Case') {
    _synCollectExprDepKeys(stmt.expr, ast, out, readBitsBySig, fnSeen);
    for (const it of stmt.items) _synCollectStmtDepKeys(it.stmt, ast, out, readBitsBySig, fnSeen);
    if (stmt.defaultBranch) _synCollectStmtDepKeys(stmt.defaultBranch, ast, out, readBitsBySig, fnSeen);
  }
}

/**
 * Collect bit-accurate dependency keys (`sig[k]` for static BitSelect, `sig` otherwise)
 * so carry vectors like `c[0] -> fa0 -> c[1] -> fa1 -> c[2]` form an acyclic DAG.
 */
function _synCollectExprDepKeys(expr, ast, out = new Set(), readBitsBySig = null, fnSeen = null) {
  if (!expr) return out;
  const addKey = (name, bitIdx = null) => {
    if (!name || (ast.params && name in ast.params) || _synIsMemory(name, ast)) return;
    if (bitIdx !== null) {
      out.add(`${name}[${bitIdx}]`);
      if (readBitsBySig) {
        if (!readBitsBySig.has(name)) readBitsBySig.set(name, new Set());
        readBitsBySig.get(name).add(bitIdx);
      }
    } else {
      out.add(name);
    }
  };
  switch (expr.kind) {
    case 'Ident':
      if (!expr.isLocal) addKey(expr.name, null);
      break;
    case 'BitSelect': {
      if (!expr.isLocal) {
        const idx = _synEvalStaticInt(expr.index, ast.params);
        addKey(expr.name, idx !== null ? idx : null);
      }
      _synCollectExprDepKeys(expr.index, ast, out, readBitsBySig, fnSeen);
      break;
    }
    case 'PartSelect':
      if (!expr.isLocal) addKey(expr.name, null);
      _synCollectExprDepKeys(expr.msb, ast, out, readBitsBySig, fnSeen);
      _synCollectExprDepKeys(expr.lsb, ast, out, readBitsBySig, fnSeen);
      break;
    case 'MemSelect':
    case 'MemBitSelect':
    case 'MemPartSelect':
      _synCollectExprDepKeys(expr.addr, ast, out, readBitsBySig, fnSeen);
      if (expr.index) _synCollectExprDepKeys(expr.index, ast, out, readBitsBySig, fnSeen);
      if (expr.msb) _synCollectExprDepKeys(expr.msb, ast, out, readBitsBySig, fnSeen);
      if (expr.lsb) _synCollectExprDepKeys(expr.lsb, ast, out, readBitsBySig, fnSeen);
      break;
    case 'Unary':
      _synCollectExprDepKeys(expr.operand, ast, out, readBitsBySig, fnSeen);
      break;
    case 'Binary':
      _synCollectExprDepKeys(expr.left, ast, out, readBitsBySig, fnSeen);
      _synCollectExprDepKeys(expr.right, ast, out, readBitsBySig, fnSeen);
      break;
    case 'Ternary':
      _synCollectExprDepKeys(expr.cond, ast, out, readBitsBySig, fnSeen);
      _synCollectExprDepKeys(expr.thenExpr, ast, out, readBitsBySig, fnSeen);
      _synCollectExprDepKeys(expr.elseExpr, ast, out, readBitsBySig, fnSeen);
      break;
    case 'Concat':
      for (const p of expr.parts) _synCollectExprDepKeys(p, ast, out, readBitsBySig, fnSeen);
      break;
    case 'Repeat':
      _synCollectExprDepKeys(expr.count, ast, out, readBitsBySig, fnSeen);
      _synCollectExprDepKeys(expr.expr, ast, out, readBitsBySig, fnSeen);
      break;
    case 'FuncCall': {
      for (const arg of expr.args || []) _synCollectExprDepKeys(arg, ast, out, readBitsBySig, fnSeen);
      const fnDef = ast?.functions?.[expr.name];
      if (fnDef) {
        const seen = fnSeen || new Set();
        if (!seen.has(expr.name)) {
          seen.add(expr.name);
          _synCollectStmtDepKeys(fnDef.body, ast, out, readBitsBySig, seen);
        }
      }
      break;
    }
    case 'SysFunc':
      for (const arg of expr.args || []) _synCollectExprDepKeys(arg, ast, out, readBitsBySig, fnSeen);
      break;
  }
  return out;
}

function _synTargetDepKey(range, ast) {
  const sig = ast.signals?.[range.name];
  const fullW = sig?.width ?? 1;
  if (fullW > 1 && range.lo === range.hi) {
    return { key: `${range.name}[${range.lo}]`, isBit: true, bit: range.lo, sigName: range.name };
  }
  return { key: range.name, isBit: false, bit: null, sigName: range.name };
}

function _synExprWidth(expr, ast) {
  if (!expr) return 1;
  switch (expr.kind) {
    case 'Number':
      return expr.sized ? expr.width : 1;
    case 'Ident':
      if (ast.params && expr.name in ast.params) return ast.params[expr.name].width;
      return ast.signals[expr.name]?.width ?? 1;
    case 'BitSelect':
      if (_synIsMemory(expr.name, ast)) return ast.memories[expr.name].width;
      return 1;
    case 'MemSelect':
      return ast.memories?.[expr.name]?.width ?? 1;
    case 'MemBitSelect':
      return 1;
    case 'MemPartSelect': {
      const m = _synEvalStaticInt(expr.msb, ast.params);
      const l = _synEvalStaticInt(expr.lsb, ast.params);
      return (m !== null && l !== null) ? Math.abs(m - l) + 1 : (ast.memories?.[expr.name]?.width ?? 1);
    }
    case 'PartSelect': {
      const m = _synEvalStaticInt(expr.msb, ast.params);
      const l = _synEvalStaticInt(expr.lsb, ast.params);
      return (m !== null && l !== null) ? Math.abs(m - l) + 1 : (ast.signals[expr.name]?.width ?? 1);
    }
    case 'Concat':
      return expr.parts.reduce((acc, p) => acc + _synExprWidth(p, ast), 0);
    case 'Repeat': {
      const c = _synEvalStaticInt(expr.count, ast.params) ?? 1;
      return c * _synExprWidth(expr.expr, ast);
    }
    case 'Unary':
      if (
        expr.op === '!' || expr.op === '&' || expr.op === '|' || expr.op === '^' ||
        expr.op === '~&' || expr.op === '~|' || expr.op === '~^' || expr.op === '^~'
      ) {
        return 1;
      }
      return _synExprWidth(expr.operand, ast);
    case 'Binary':
      if (
        expr.op === '==' || expr.op === '!=' || expr.op === '===' || expr.op === '!==' ||
        expr.op === '<' || expr.op === '<=' || expr.op === '>' || expr.op === '>=' ||
        expr.op === '&&' || expr.op === '||'
      ) {
        return 1;
      }
      return Math.max(_synExprWidth(expr.left, ast), _synExprWidth(expr.right, ast));
    case 'Ternary':
      return Math.max(_synExprWidth(expr.thenExpr, ast), _synExprWidth(expr.elseExpr, ast));
    case 'FuncCall':
      return ast.functions?.[expr.name]?.returnWidth ?? 1;
    default:
      return 1;
  }
}

function _synTargetWidth(target, ast) {
  const ranges = _synCollectTargetRanges(target, ast, []);
  return ranges.reduce((acc, r) => acc + r.width, 0) || 1;
}

/**
 * Estimate 4-input LUTs and DSP blocks for an expression node.
 */
function _synEstimateExpr(expr, ast, targetWidth, metrics, fnStack = null) {
  if (!expr) return;
  switch (expr.kind) {
    case 'Unary': {
      _synEstimateExpr(expr.operand, ast, targetWidth, metrics, fnStack);
      const opW = Math.max(1, _synExprWidth(expr.operand, ast));
      if (expr.op === '~' || expr.op === '-') {
        metrics.luts += Math.max(opW, targetWidth);
      } else if (expr.op === '!') {
        metrics.luts += 1;
      } else if (
        expr.op === '&' || expr.op === '|' || expr.op === '^' ||
        expr.op === '~&' || expr.op === '~|' || expr.op === '~^' || expr.op === '^~'
      ) {
        metrics.luts += Math.max(1, Math.ceil(Math.max(1, opW - 1) / 3));
      }
      break;
    }

    case 'Binary': {
      const lw = _synExprWidth(expr.left, ast);
      const rw = _synExprWidth(expr.right, ast);
      const opW = Math.max(1, targetWidth, lw, rw);
      _synEstimateExpr(expr.left, ast, lw, metrics, fnStack);
      _synEstimateExpr(expr.right, ast, rw, metrics, fnStack);

      switch (expr.op) {
        case '&':
        case '|':
        case '^':
        case '~^':
        case '^~':
          metrics.luts += opW;
          break;
        case '&&':
        case '||':
          metrics.luts += 1;
          break;
        case '==':
        case '!=':
        case '===':
        case '!==':
        case '<':
        case '<=':
        case '>':
        case '>=':
          metrics.luts += Math.max(1, Math.ceil(Math.max(lw, rw) / 2));
          break;
        case '+':
        case '-':
          metrics.luts += opW;
          break;
        case '*': {
          metrics.dspBlocks += 1;
          metrics.luts += Math.max(4, opW * opW);
          break;
        }
        case '/':
        case '%':
          metrics.luts += Math.max(4, opW * opW);
          break;
        case '<<':
        case '>>':
        case '<<<':
        case '>>>': {
          const isConstShift = expr.right.kind === 'Number';
          if (!isConstShift) {
            metrics.luts += opW * 2;
          }
          break;
        }
      }
      break;
    }

    case 'Ternary': {
      _synEstimateExpr(expr.cond, ast, 1, metrics, fnStack);
      _synEstimateExpr(expr.thenExpr, ast, targetWidth, metrics, fnStack);
      _synEstimateExpr(expr.elseExpr, ast, targetWidth, metrics, fnStack);
      const w = Math.max(1, targetWidth, _synExprWidth(expr.thenExpr, ast), _synExprWidth(expr.elseExpr, ast));
      metrics.luts += w;
      break;
    }

    case 'Concat':
      for (const p of expr.parts) {
        _synEstimateExpr(p, ast, _synExprWidth(p, ast), metrics, fnStack);
      }
      break;

    case 'Repeat':
      _synEstimateExpr(expr.expr, ast, _synExprWidth(expr.expr, ast), metrics, fnStack);
      break;

    case 'FuncCall': {
      for (const arg of expr.args || []) {
        _synEstimateExpr(arg, ast, _synExprWidth(arg, ast), metrics, fnStack);
      }
      const fnDef = ast?.functions?.[expr.name];
      if (fnDef) {
        const stack = fnStack || new Set();
        if (!stack.has(expr.name)) {
          stack.add(expr.name);
          _synEstimateStmt(fnDef.body, ast, metrics, stack);
          stack.delete(expr.name);
        }
      }
      break;
    }

    case 'BitSelect':
      _synEstimateExpr(expr.index, ast, 1, metrics, fnStack);
      break;

    case 'MemSelect':
      _synEstimateExpr(expr.addr, ast, 1, metrics, fnStack);
      break;

    case 'MemBitSelect':
      _synEstimateExpr(expr.addr, ast, 1, metrics, fnStack);
      _synEstimateExpr(expr.index, ast, 1, metrics, fnStack);
      break;

    case 'MemPartSelect':
      _synEstimateExpr(expr.addr, ast, 1, metrics, fnStack);
      _synEstimateExpr(expr.msb, ast, 1, metrics, fnStack);
      _synEstimateExpr(expr.lsb, ast, 1, metrics, fnStack);
      break;

    case 'PartSelect':
      _synEstimateExpr(expr.msb, ast, 1, metrics, fnStack);
      _synEstimateExpr(expr.lsb, ast, 1, metrics, fnStack);
      break;
  }
}

/**
 * Collect all target signals and maximum bit width written anywhere inside a statement subtree.
 */
function _synCollectAssignedSignals(stmt, ast, outMap = new Map()) {
  if (!stmt) return outMap;
  switch (stmt.kind) {
    case 'Block':
      for (const s of stmt.statements) _synCollectAssignedSignals(s, ast, outMap);
      break;
    case 'ProcAssign': {
      const ranges = _synCollectTargetRanges(stmt.target, ast, []);
      for (const r of ranges) {
        const cur = outMap.get(r.name) ?? 0;
        outMap.set(r.name, Math.max(cur, r.width));
      }
      break;
    }
    case 'If':
      _synCollectAssignedSignals(stmt.thenBranch, ast, outMap);
      _synCollectAssignedSignals(stmt.elseBranch, ast, outMap);
      break;
    case 'Case':
      for (const it of stmt.items) _synCollectAssignedSignals(it.stmt, ast, outMap);
      _synCollectAssignedSignals(stmt.defaultBranch, ast, outMap);
      break;
  }
  return outMap;
}

/**
 * Estimate LUTs for a statement tree (handling N-way if/else-if chains and case muxes).
 */
function _synEstimateStmt(stmt, ast, metrics, fnStack = null) {
  if (!stmt || stmt.kind === 'Noop' || stmt.kind === 'SystemCall') return;

  switch (stmt.kind) {
    case 'Block':
      for (const s of stmt.statements) _synEstimateStmt(s, ast, metrics, fnStack);
      break;

    case 'ProcAssign': {
      const w = _synTargetWidth(stmt.target, ast);
      _synEstimateExpr(stmt.expr, ast, w, metrics, fnStack);
      break;
    }

    case 'Return': {
      if (stmt.expr) _synEstimateExpr(stmt.expr, ast, _synExprWidth(stmt.expr, ast), metrics, fnStack);
      break;
    }

    case 'If': {
      const branches = [];
      let cur = stmt;
      while (cur && cur.kind === 'If') {
        _synEstimateExpr(cur.cond, ast, 1, metrics, fnStack);
        branches.push(cur.thenBranch);
        cur = cur.elseBranch;
      }
      if (cur) {
        branches.push(cur);
      } else {
        branches.push(null);
      }

      const assignedWidths = new Map();
      for (const br of branches) {
        if (br) {
          _synEstimateStmt(br, ast, metrics, fnStack);
          _synCollectAssignedSignals(br, ast, assignedWidths);
        }
      }

      const nBranches = Math.max(2, branches.length);
      const muxLutsPerBit = Math.max(1, Math.ceil((nBranches - 1) / 2));
      let totalTargetBits = 0;
      for (const w of assignedWidths.values()) totalTargetBits += w;
      metrics.luts += muxLutsPerBit * Math.max(1, totalTargetBits);
      break;
    }

    case 'Case': {
      _synEstimateExpr(stmt.expr, ast, _synExprWidth(stmt.expr, ast), metrics, fnStack);
      const assignedWidths = new Map();

      for (const it of stmt.items) {
        _synEstimateStmt(it.stmt, ast, metrics, fnStack);
        _synCollectAssignedSignals(it.stmt, ast, assignedWidths);
      }
      if (stmt.defaultBranch) {
        _synEstimateStmt(stmt.defaultBranch, ast, metrics, fnStack);
        _synCollectAssignedSignals(stmt.defaultBranch, ast, assignedWidths);
      }

      const nBranches = Math.max(2, stmt.items.length + (stmt.defaultBranch ? 1 : 0));
      const muxLutsPerBit = Math.max(1, Math.ceil((nBranches - 1) / 2));
      let totalTargetBits = 0;
      for (const w of assignedWidths.values()) totalTargetBits += w;
      metrics.luts += muxLutsPerBit * Math.max(1, totalTargetBits);
      break;
    }
  }
}

function _synUnion(a, b) {
  const res = new Set(a);
  for (const x of b) res.add(x);
  return res;
}

function _synIntersect(a, b) {
  const res = new Set();
  for (const x of a) {
    if (b.has(x)) res.add(x);
  }
  return res;
}

/**
 * Path-sensitive definite assignment analysis for INFERRED_LATCH detection.
 */
function _synAnalyzeCombPaths(stmt, ast) {
  const empty = () => ({ must: new Set(), may: new Set(), firstLine: new Map() });
  if (!stmt || stmt.kind === 'Noop' || stmt.kind === 'SystemCall') return empty();

  const recordLine = (map, name, line) => {
    if (!map.has(name) && line != null) map.set(name, line);
  };

  if (stmt.kind === 'ProcAssign') {
    const res = empty();
    const ranges = _synCollectTargetRanges(stmt.target, ast, []);
    for (const r of ranges) {
      if (r.isMemory) continue;
      res.must.add(r.name);
      res.may.add(r.name);
      recordLine(res.firstLine, r.name, stmt.line);
    }
    return res;
  }

  if (stmt.kind === 'Block') {
    let must = new Set();
    let may = new Set();
    const firstLine = new Map();
    for (const child of stmt.statements) {
      const c = _synAnalyzeCombPaths(child, ast);
      must = _synUnion(must, c.must);
      may = _synUnion(may, c.may);
      for (const [k, l] of c.firstLine) recordLine(firstLine, k, l);
    }
    return { must, may, firstLine };
  }

  if (stmt.kind === 'If') {
    const t = _synAnalyzeCombPaths(stmt.thenBranch, ast);
    const e = stmt.elseBranch ? _synAnalyzeCombPaths(stmt.elseBranch, ast) : empty();
    const may = _synUnion(t.may, e.may);
    const must = stmt.elseBranch ? _synIntersect(t.must, e.must) : new Set();
    const firstLine = new Map(t.firstLine);
    for (const [k, l] of e.firstLine) recordLine(firstLine, k, l);
    return { must, may, firstLine };
  }

  if (stmt.kind === 'Case') {
    let may = new Set();
    const firstLine = new Map();
    const branchMusts = [];

    for (const it of stmt.items) {
      const r = _synAnalyzeCombPaths(it.stmt, ast);
      may = _synUnion(may, r.may);
      branchMusts.push(r.must);
      for (const [k, l] of r.firstLine) recordLine(firstLine, k, l);
    }

    let must = new Set();
    if (stmt.defaultBranch) {
      const def = _synAnalyzeCombPaths(stmt.defaultBranch, ast);
      may = _synUnion(may, def.may);
      branchMusts.push(def.must);
      for (const [k, l] of def.firstLine) recordLine(firstLine, k, l);

      if (branchMusts.length > 0) {
        must = new Set(branchMusts[0]);
        for (let i = 1; i < branchMusts.length; i++) {
          must = _synIntersect(must, branchMusts[i]);
        }
      }
    }

    return { must, may, firstLine };
  }

  return empty();
}

/**
 * Collect bit-accurate combinational dependencies (targetKey -> Set<sourceKeys>) from a combinational block.
 */
function _synCollectCombDeps(stmt, ast, condDeps, shared) {
  if (!stmt || stmt.kind === 'Noop' || stmt.kind === 'SystemCall') return;

  switch (stmt.kind) {
    case 'Block':
      for (const child of stmt.statements) {
        _synCollectCombDeps(child, ast, condDeps, shared);
      }
      break;
    case 'ProcAssign': {
      const rhsDeps = _synCollectExprDepKeys(stmt.expr, ast, new Set(condDeps), shared.readBitsBySig);
      const ranges = _synCollectTargetRanges(stmt.target, ast, []);
      for (const r of ranges) {
        if (!r.isMemory) {
          shared.recordCombDep(r, rhsDeps, stmt.line);
        }
      }
      break;
    }
    case 'If': {
      const nextCondDeps = _synCollectExprDepKeys(stmt.cond, ast, new Set(condDeps), shared.readBitsBySig);
      _synCollectCombDeps(stmt.thenBranch, ast, nextCondDeps, shared);
      if (stmt.elseBranch) {
        _synCollectCombDeps(stmt.elseBranch, ast, nextCondDeps, shared);
      }
      break;
    }
    case 'Case': {
      const nextCondDeps = _synCollectExprDepKeys(stmt.expr, ast, new Set(condDeps), shared.readBitsBySig);
      for (const it of stmt.items) {
        _synCollectCombDeps(it.stmt, ast, nextCondDeps, shared);
      }
      if (stmt.defaultBranch) {
        _synCollectCombDeps(stmt.defaultBranch, ast, nextCondDeps, shared);
      }
      break;
    }
  }
}

/**
 * Bridge whole-signal keys <-> static bit-slice keys ONLY where it cannot introduce
 * a false self-loop (e.g., ripple-carry vectors c[0] -> fa0 -> c[1] stay strictly acyclic).
 */
function _synApplyBitBridges(combDeps, readBitsBySig, drivenBitsBySig, wholeDrivenSigs) {
  // 1. If bit `sig[k]` is read, and NOT individually driven, it inherits from whole `sig`
  for (const [sig, bitSet] of readBitsBySig.entries()) {
    const drivenBits = drivenBitsBySig.get(sig);
    for (const k of bitSet) {
      if (!drivenBits || !drivenBits.has(k)) {
        const bitKey = `${sig}[${k}]`;
        if (!combDeps.has(bitKey)) combDeps.set(bitKey, new Set());
        combDeps.get(bitKey).add(sig);
      }
    }
  }

  // 2. If whole `sig` is NOT whole-driven, it aggregates all individually driven bits `sig[k]`
  for (const [sig, bitSet] of drivenBitsBySig.entries()) {
    if (!wholeDrivenSigs.has(sig)) {
      if (!combDeps.has(sig)) combDeps.set(sig, new Set());
      const bucket = combDeps.get(sig);
      for (const k of bitSet) {
        bucket.add(`${sig}[${k}]`);
      }
    }
  }
}

/**
 * Detect static cycles in combinational dependency graph using 3-color DFS.
 */
function _synFindCombCycles(depsMap, lineMap) {
  const color = new Map();
  const stack = [];
  const seenSignatures = new Set();
  const cycles = [];

  const dfs = (node) => {
    color.set(node, 1);
    stack.push(node);

    const neighbors = depsMap.get(node);
    if (neighbors) {
      for (const next of neighbors) {
        const nextColor = color.get(next) ?? 0;
        if (nextColor === 1) {
          const startIdx = stack.indexOf(next);
          const rawCycle = stack.slice(startIdx);
          let minIdx = 0;
          for (let i = 1; i < rawCycle.length; i++) {
            if (rawCycle[i] < rawCycle[minIdx]) minIdx = i;
          }
          const rotated = [...rawCycle.slice(minIdx), ...rawCycle.slice(0, minIdx)];
          const sig = rotated.join('->');
          if (!seenSignatures.has(sig)) {
            seenSignatures.add(sig);
            const cyclePath = [...rotated, rotated[0]];
            cycles.push({
              signal: rotated[0],
              cycle: cyclePath,
              line: lineMap.get(rotated[0]) ?? null,
            });
          }
        } else if (nextColor === 0 && depsMap.has(next)) {
          dfs(next);
        }
      }
    }

    stack.pop();
    color.set(node, 2);
  };

  for (const node of depsMap.keys()) {
    if ((color.get(node) ?? 0) === 0) {
      dfs(node);
    }
  }

  return cycles;
}

// ============================================================================
// Critical Path / Logic Depth Static Timing Estimator (v4.0-A / CE118)
// ============================================================================

function _synDelayFromDepth(depth) {
  const d = Math.max(0, depth | 0);
  if (d === 0) return 0;
  return Number((d * CYCLONE2_LUT_DELAY_NS + Math.max(0, d - 1) * CYCLONE2_ROUTING_DELAY_NS).toFixed(2));
}

function _synExprDepth(expr, ast, depthMap, localDepths = null, fnStack = null) {
  if (!expr) return { depth: 0, srcKey: null };

  const pickMax = (a, b) => (b.depth > a.depth ? b : a);
  const readKeyDepth = (key) => ({ depth: depthMap.get(key) ?? 0, srcKey: key });

  switch (expr.kind) {
    case 'Number':
    case 'String':
      return { depth: 0, srcKey: null };

    case 'Ident': {
      if (expr.isLocal && localDepths && localDepths.has(expr.name)) {
        return localDepths.get(expr.name);
      }
      if (ast.params && expr.name in ast.params) return { depth: 0, srcKey: null };
      return readKeyDepth(expr.name);
    }

    case 'BitSelect': {
      if (expr.isLocal && localDepths && localDepths.has(expr.name)) {
        const base = localDepths.get(expr.name);
        const idx = _synExprDepth(expr.index, ast, depthMap, localDepths, fnStack);
        const isStatic = _synEvalStaticInt(expr.index, ast.params) !== null;
        return isStatic ? base : { depth: Math.max(base.depth, idx.depth) + 1, srcKey: base.depth >= idx.depth ? base.srcKey : idx.srcKey };
      }
      if (_synIsMemory(expr.name, ast)) {
        const ad = _synExprDepth(expr.index, ast, depthMap, localDepths, fnStack);
        return { depth: ad.depth + 1, srcKey: ad.srcKey || expr.name };
      }
      const staticIdx = _synEvalStaticInt(expr.index, ast.params);
      if (staticIdx !== null) {
        const bitKey = `${expr.name}[${staticIdx}]`;
        if (depthMap.has(bitKey)) return readKeyDepth(bitKey);
        return readKeyDepth(expr.name);
      }
      const base = readKeyDepth(expr.name);
      const idx = _synExprDepth(expr.index, ast, depthMap, localDepths, fnStack);
      const best = pickMax(base, idx);
      return { depth: best.depth + 1, srcKey: best.srcKey };
    }

    case 'PartSelect': {
      const base = (expr.isLocal && localDepths && localDepths.has(expr.name))
        ? localDepths.get(expr.name)
        : readKeyDepth(expr.name);
      const md = _synExprDepth(expr.msb, ast, depthMap, localDepths, fnStack);
      const ld = _synExprDepth(expr.lsb, ast, depthMap, localDepths, fnStack);
      return pickMax(base, pickMax(md, ld));
    }

    case 'MemSelect':
    case 'MemBitSelect':
    case 'MemPartSelect': {
      let best = _synExprDepth(expr.addr, ast, depthMap, localDepths, fnStack);
      if (expr.index) best = pickMax(best, _synExprDepth(expr.index, ast, depthMap, localDepths, fnStack));
      if (expr.msb) best = pickMax(best, _synExprDepth(expr.msb, ast, depthMap, localDepths, fnStack));
      if (expr.lsb) best = pickMax(best, _synExprDepth(expr.lsb, ast, depthMap, localDepths, fnStack));
      return { depth: best.depth + 1, srcKey: best.srcKey || expr.name };
    }

    case 'Concat': {
      let best = { depth: 0, srcKey: null };
      for (const p of expr.parts || []) {
        best = pickMax(best, _synExprDepth(p, ast, depthMap, localDepths, fnStack));
      }
      return best;
    }

    case 'Repeat':
      return _synExprDepth(expr.expr, ast, depthMap, localDepths, fnStack);

    case 'Unary': {
      const op = _synExprDepth(expr.operand, ast, depthMap, localDepths, fnStack);
      const opW = Math.max(1, _synExprWidth(expr.operand, ast));
      if (expr.op === '+') return op;
      if (expr.op === '~' || expr.op === '!') return { depth: op.depth + 1, srcKey: op.srcKey };
      if (expr.op === '-') return { depth: op.depth + Math.max(1, Math.ceil(opW / 4)), srcKey: op.srcKey };
      // Reduction operators: 4-input LUT reduction tree
      const levels = Math.max(1, Math.ceil(Math.log2(Math.max(2, opW)) / 2));
      return { depth: op.depth + levels, srcKey: op.srcKey };
    }

    case 'Binary': {
      const l = _synExprDepth(expr.left, ast, depthMap, localDepths, fnStack);
      const r = _synExprDepth(expr.right, ast, depthMap, localDepths, fnStack);
      const best = pickMax(l, r);
      const lw = _synExprWidth(expr.left, ast);
      const rw = _synExprWidth(expr.right, ast);
      const opW = Math.max(1, lw, rw);

      switch (expr.op) {
        case '&':
        case '|':
        case '^':
        case '~^':
        case '^~':
        case '&&':
        case '||':
          return { depth: best.depth + 1, srcKey: best.srcKey };
        case '==':
        case '!=':
        case '===':
        case '!==':
        case '<':
        case '<=':
        case '>':
        case '>=':
          return { depth: best.depth + Math.max(1, Math.ceil(Math.log2(Math.max(2, opW)) / 2)), srcKey: best.srcKey };
        case '+':
        case '-':
          // Carry-chain model: 1 logic level per 4-bit carry group
          return { depth: best.depth + Math.max(1, Math.ceil(opW / 4)), srcKey: best.srcKey };
        case '*':
        case '/':
        case '%':
          return { depth: best.depth + Math.max(2, Math.ceil(opW / 2)), srcKey: best.srcKey };
        case '<<':
        case '>>':
        case '<<<':
        case '>>>': {
          if (expr.right.kind === 'Number') return l; // Constant shift is pure wiring
          return { depth: best.depth + Math.max(1, Math.ceil(Math.log2(Math.max(2, opW)))), srcKey: best.srcKey };
        }
        default:
          return { depth: best.depth + 1, srcKey: best.srcKey };
      }
    }

    case 'Ternary': {
      const c = _synExprDepth(expr.cond, ast, depthMap, localDepths, fnStack);
      const t = _synExprDepth(expr.thenExpr, ast, depthMap, localDepths, fnStack);
      const e = _synExprDepth(expr.elseExpr, ast, depthMap, localDepths, fnStack);
      const best = pickMax(c, pickMax(t, e));
      return { depth: best.depth + 1, srcKey: best.srcKey };
    }

    case 'FuncCall': {
      const fnDef = ast?.functions?.[expr.name];
      if (!fnDef) {
        let best = { depth: 0, srcKey: null };
        for (const a of expr.args || []) best = pickMax(best, _synExprDepth(a, ast, depthMap, localDepths, fnStack));
        return best;
      }
      const stack = fnStack || new Set();
      if (stack.has(expr.name)) return { depth: 1, srcKey: null };
      stack.add(expr.name);

      const childLocals = new Map();
      const retName = fnDef.localName || fnDef.name;
      childLocals.set(retName, { depth: 0, srcKey: null });
      for (let i = 0; i < (fnDef.args || []).length; i++) {
        const argDepth = i < (expr.args || []).length
          ? _synExprDepth(expr.args[i], ast, depthMap, localDepths, stack)
          : { depth: 0, srcKey: null };
        childLocals.set(fnDef.args[i].name, argDepth);
      }
      for (const loc of fnDef.locals || []) {
        childLocals.set(loc.name, { depth: 0, srcKey: null });
      }

      _synCollectStmtDepthUpdates(
        fnDef.body,
        ast,
        depthMap,
        { depth: 0, srcKey: null },
        (r, combined) => {
          if (childLocals.has(r.name)) {
            childLocals.set(r.name, pickMax(childLocals.get(r.name), combined));
          }
        },
        childLocals,
        stack,
        retName
      );
      stack.delete(expr.name);
      return childLocals.get(retName) || { depth: 0, srcKey: null };
    }

    default:
      return { depth: 0, srcKey: null };
  }
}

function _synCollectStmtDepthUpdates(stmt, ast, depthMap, ctrl, onTarget, localDepths = null, fnStack = null, retName = null) {
  if (!stmt || stmt.kind === 'Noop' || stmt.kind === 'SystemCall') return;
  const pickMax = (a, b) => (b.depth > a.depth ? b : a);

  switch (stmt.kind) {
    case 'Block':
      for (const s of stmt.statements) {
        _synCollectStmtDepthUpdates(s, ast, depthMap, ctrl, onTarget, localDepths, fnStack, retName);
      }
      break;
    case 'ProcAssign': {
      const ed = _synExprDepth(stmt.expr, ast, depthMap, localDepths, fnStack);
      const combined = pickMax(ctrl, ed);
      for (const r of _synCollectTargetRanges(stmt.target, ast, [])) onTarget(r, combined);
      break;
    }
    case 'Return': {
      if (stmt.expr && retName) {
        const ed = _synExprDepth(stmt.expr, ast, depthMap, localDepths, fnStack);
        onTarget({ name: retName, isMemory: false }, pickMax(ctrl, ed));
      }
      break;
    }
    case 'If': {
      const cd = _synExprDepth(stmt.cond, ast, depthMap, localDepths, fnStack);
      const nextCtrl = {
        depth: Math.max(ctrl.depth, cd.depth) + 1,
        srcKey: cd.depth >= ctrl.depth ? cd.srcKey : ctrl.srcKey,
      };
      _synCollectStmtDepthUpdates(stmt.thenBranch, ast, depthMap, nextCtrl, onTarget, localDepths, fnStack, retName);
      if (stmt.elseBranch) {
        _synCollectStmtDepthUpdates(stmt.elseBranch, ast, depthMap, nextCtrl, onTarget, localDepths, fnStack, retName);
      }
      break;
    }
    case 'Case': {
      const cd = _synExprDepth(stmt.expr, ast, depthMap, localDepths, fnStack);
      const nBr = Math.max(2, stmt.items.length + (stmt.defaultBranch ? 1 : 0));
      const muxLevels = Math.max(1, Math.ceil(Math.log2(nBr) / 2));
      const nextCtrl = {
        depth: Math.max(ctrl.depth, cd.depth) + muxLevels,
        srcKey: cd.depth >= ctrl.depth ? cd.srcKey : ctrl.srcKey,
      };
      for (const it of stmt.items) {
        _synCollectStmtDepthUpdates(it.stmt, ast, depthMap, nextCtrl, onTarget, localDepths, fnStack, retName);
      }
      if (stmt.defaultBranch) {
        _synCollectStmtDepthUpdates(stmt.defaultBranch, ast, depthMap, nextCtrl, onTarget, localDepths, fnStack, retName);
      }
      break;
    }
  }
}

function _synComputeCriticalPath(ast, seqSignals, cycleNodes, readBitsBySig, drivenBitsBySig, wholeDrivenSigs) {
  const depthMap = new Map();
  const predMap = new Map();

  // Helper: check if a signal key corresponds to a flip-flop output (breaks combinational paths)
  const isSeqKey = (key) => {
    if (seqSignals.has(key)) return true;
    const br = key.indexOf('[');
    if (br > 0) return seqSignals.has(key.slice(0, br));
    return false;
  };

  // Seed all primary inputs and flip-flop outputs at arrival depth 0
  for (const sigName of Object.keys(ast.signals || {})) {
    depthMap.set(sigName, 0);
  }
  for (const [sig, bits] of drivenBitsBySig.entries()) {
    for (const k of bits) depthMap.set(`${sig}[${k}]`, 0);
  }

  const relax = (key, candidateDepth, srcKey) => {
    if (cycleNodes.has(key) || isSeqKey(key)) return false;
    const prev = depthMap.get(key) ?? 0;
    if (candidateDepth > prev) {
      depthMap.set(key, candidateDepth);
      if (srcKey && srcKey !== key) predMap.set(key, srcKey);
      return true;
    }
    return false;
  };

  const MAX_RELAX = 64;
  for (let pass = 0; pass < MAX_RELAX; pass++) {
    let changed = false;

    // 1. Continuous assigns (port wiring = 0 added delay)
    for (const assign of ast.assigns || []) {
      const ed = _synExprDepth(assign.expr, ast, depthMap);
      const ranges = _synCollectTargetRanges(assign.target, ast, []);
      for (const r of ranges) {
        if (r.isMemory) continue;
        const tk = _synTargetDepKey(r, ast);
        if (relax(tk.key, ed.depth, ed.srcKey)) changed = true;
      }
    }

    // 2. Structural primitive gates (logic gates add 1+ level; buf adds 0)
    for (const gate of ast.gates || []) {
      let best = { depth: 0, srcKey: null };
      for (const inp of gate.inputs || []) {
        const d = _synExprDepth(inp, ast, depthMap);
        if (d.depth > best.depth) best = d;
      }
      const gateLevels = gate.gateType === 'buf'
        ? 0
        : Math.max(1, Math.ceil(Math.max(1, (gate.inputs?.length || 2) - 1) / 3));
      const outDepth = best.depth + gateLevels;
      const ranges = _synCollectTargetRanges(gate.target, ast, []);
      for (const r of ranges) {
        if (r.isMemory) continue;
        const tk = _synTargetDepKey(r, ast);
        if (relax(tk.key, outDepth, best.srcKey)) changed = true;
      }
    }

    // 3. Combinational always blocks
    for (const blk of ast.alwaysBlocks || []) {
      if (blk.mode !== 'comb') continue;
      _synCollectStmtDepthUpdates(blk.body, ast, depthMap, { depth: 0, srcKey: null }, (r, res) => {
        if (r.isMemory) return;
        const tk = _synTargetDepKey(r, ast);
        if (relax(tk.key, res.depth, res.srcKey)) changed = true;
      });
    }

    // 4. Bit <-> whole wiring bridges (0 added delay)
    for (const [sig, bitSet] of readBitsBySig.entries()) {
      const drivenBits = drivenBitsBySig.get(sig);
      const wholeD = depthMap.get(sig) ?? 0;
      for (const k of bitSet) {
        if (!drivenBits || !drivenBits.has(k)) {
          if (relax(`${sig}[${k}]`, wholeD, sig)) changed = true;
        }
      }
    }
    for (const [sig, bitSet] of drivenBitsBySig.entries()) {
      if (!wholeDrivenSigs.has(sig)) {
        for (const k of bitSet) {
          const bk = `${sig}[${k}]`;
          if (relax(sig, depthMap.get(bk) ?? 0, bk)) changed = true;
        }
      }
    }

    if (!changed) break;
  }

  // Evaluate sequential register D-input endpoint depths (per instance & global)
  const instanceSeqEndpointDepth = new Map();
  let maxDepth = 0;
  let maxEndpointKey = null;
  let maxEndpointSrc = null;

  for (const [key, d] of depthMap.entries()) {
    if (d > maxDepth) {
      maxDepth = d;
      maxEndpointKey = key;
      maxEndpointSrc = null;
    }
  }

  for (const blk of ast.alwaysBlocks || []) {
    if (blk.mode !== 'seq') continue;
    const instKey = blk.instancePath || '';
    _synCollectStmtDepthUpdates(blk.body, ast, depthMap, { depth: 0, srcKey: null }, (r, res) => {
      const prevInst = instanceSeqEndpointDepth.get(instKey) ?? 0;
      if (res.depth > prevInst) instanceSeqEndpointDepth.set(instKey, res.depth);
      if (res.depth > maxDepth) {
        maxDepth = res.depth;
        maxEndpointKey = r.name;
        maxEndpointSrc = res.srcKey;
      }
    });
  }

  // Reconstruct critical path signal chain (bounded to avoid loops)
  const criticalPathSignals = [];
  const visitedPath = new Set();
  if (maxEndpointKey) {
    criticalPathSignals.push(maxEndpointKey);
    visitedPath.add(maxEndpointKey);
    let cur = maxEndpointSrc || predMap.get(maxEndpointKey) || null;
    while (cur && !visitedPath.has(cur) && criticalPathSignals.length < 64) {
      visitedPath.add(cur);
      criticalPathSignals.push(cur);
      cur = predMap.get(cur) || null;
    }
    criticalPathSignals.reverse();
  }

  return {
    logicDepth: maxDepth,
    estimatedDelayNs: _synDelayFromDepth(maxDepth),
    criticalPathSignals,
    depthMap,
    instanceSeqEndpointDepth,
  };
}

function _synAnnotateHierarchyDepth(summaryNode, hierNode, fullAst, timing) {
  let maxDepth = timing.instanceSeqEndpointDepth.get(hierNode.prefix || '') ?? 0;

  // Check local combinational assigns
  for (const assign of hierNode.assigns || []) {
    if (assign.isPortWiring) continue;
    const ranges = _synCollectTargetRanges(assign.target, fullAst, []);
    for (const r of ranges) {
      if (r.isMemory) continue;
      const tk = _synTargetDepKey(r, fullAst);
      const d = timing.depthMap.get(tk.key) ?? timing.depthMap.get(r.name) ?? 0;
      if (d > maxDepth) maxDepth = d;
    }
  }

  // Check local combinational always blocks
  for (const blk of hierNode.alwaysBlocks || []) {
    if (blk.mode !== 'comb') continue;
    const assigned = _synCollectAssignedSignals(blk.body, fullAst, new Map());
    for (const sigName of assigned.keys()) {
      const d = timing.depthMap.get(sigName) ?? 0;
      if (d > maxDepth) maxDepth = d;
    }
  }

  // Annotate primitive gate children & submodule children
  const subHierChildren = hierNode.children || [];
  const gateChildren = hierNode.gates || [];
  let subIdx = 0;
  let gateIdx = 0;

  for (const childSummary of summaryNode.children || []) {
    if (childSummary.isPrimitive) {
      const g = gateChildren[gateIdx++];
      let gd = 0;
      if (g) {
        const ranges = _synCollectTargetRanges(g.target, fullAst, []);
        for (const r of ranges) {
          if (r.isMemory) continue;
          const tk = _synTargetDepKey(r, fullAst);
          const d = timing.depthMap.get(tk.key) ?? timing.depthMap.get(r.name) ?? 0;
          if (d > gd) gd = d;
        }
        if (gd === 0 && g.gateType !== 'buf') gd = 1;
      }
      childSummary.logicDepth = gd;
      if (gd > maxDepth) maxDepth = gd;
    } else {
      const subHier = subHierChildren[subIdx++];
      if (subHier) {
        const cd = _synAnnotateHierarchyDepth(childSummary, subHier, fullAst, timing);
        if (cd > maxDepth) maxDepth = cd;
      }
    }
  }

  summaryNode.logicDepth = maxDepth;
  return maxDepth;
}

function _synAnalyzeInstanceNode(hierNode, fullAst, shared) {
  const localMetrics = {
    luts: 0,
    ffs: 0,
    dspBlocks: 0,
    memoryBits: 0,
    memoryCount: 0,
  };
  const localSeqSignals = new Set();

  // 1. Account for unpacked 2D memories owned by this instance
  for (const mem of Object.values(hierNode.memories || {})) {
    const bits = (mem.width || 1) * (mem.depth || 1);
    localMetrics.memoryBits += bits;
    localMetrics.memoryCount += 1;
    shared.memories.push({
      name: mem.name,
      localName: mem.localName || mem.name,
      instancePath: hierNode.instancePath,
      width: mem.width,
      depth: mem.depth,
      bits,
    });
  }

  // 2. Continuous assign statements in this instance
  for (let idx = 0; idx < (hierNode.assigns || []).length; idx++) {
    const assign = hierNode.assigns[idx];
    const driverId = `${hierNode.instancePath}:assign#${idx}`;

    if (!assign.isPortWiring) {
      const targetW = _synTargetWidth(assign.target, fullAst);
      const lutsBefore = localMetrics.luts;
      _synEstimateExpr(assign.expr, fullAst, targetW, localMetrics);
      const isPureWire =
        assign.expr.kind === 'Number' ||
        assign.expr.kind === 'Ident' ||
        (assign.expr.kind === 'BitSelect' &&
          !_synIsMemory(assign.expr.name, fullAst) &&
          _synEvalStaticInt(assign.expr.index, fullAst.params) !== null) ||
        (assign.expr.kind === 'PartSelect' &&
          _synEvalStaticInt(assign.expr.msb, fullAst.params) !== null &&
          _synEvalStaticInt(assign.expr.lsb, fullAst.params) !== null);
      if (localMetrics.luts === lutsBefore && !isPureWire) {
        localMetrics.luts += 1;
      }
    }

    const ranges = _synCollectTargetRanges(assign.target, fullAst, []);
    shared.recordDriver(driverId, ranges, assign.line);

    const rhsDeps = _synCollectExprDepKeys(assign.expr, fullAst, new Set(), shared.readBitsBySig);
    for (const r of ranges) {
      if (r.isMemory) continue;
      shared.combSignals.add(r.name);
      shared.recordCombDep(r, rhsDeps, assign.line);
    }
  }

  // 2b. Structural primitive gates in this instance (emitted as leaf children in hierarchy tree)
  const gateChildReports = [];
  let totalGateLuts = 0;
  for (let idx = 0; idx < (hierNode.gates || []).length; idx++) {
    const gate = hierNode.gates[idx];
    const driverId = `${hierNode.instancePath}:gate#${idx}`;
    const targetW = _synTargetWidth(gate.target, fullAst);
    const inCount = (gate.inputs || []).length;
    const gateLuts = gate.gateType === 'buf'
      ? 0
      : targetW * Math.max(1, Math.ceil(Math.max(1, inCount - 1) / 3));

    totalGateLuts += gateLuts;

    const ranges = _synCollectTargetRanges(gate.target, fullAst, []);
    shared.recordDriver(driverId, ranges, gate.line);

    const rhsDeps = new Set();
    for (const inp of gate.inputs || []) {
      _synCollectExprDepKeys(inp, fullAst, rhsDeps, shared.readBitsBySig);
    }
    for (const r of ranges) {
      if (r.isMemory) continue;
      shared.combSignals.add(r.name);
      shared.recordCombDep(r, rhsDeps, gate.line);
    }

    gateChildReports.push({
      instanceName: gate.instanceName || `${gate.gateType}_${idx}`,
      instancePath: gate.instancePath || gate.instanceName || `${gate.gateType}_${idx}`,
      moduleName: gate.gateType,
      isPrimitive: true,
      luts: gateLuts,
      selfLuts: gateLuts,
      ffs: 0,
      selfFfs: 0,
      dspBlocks: 0,
      memBits: 0,
      memoryBits: 0,
      selfMemBits: 0,
      memoryCount: 0,
      logicDepth: gate.gateType === 'buf' ? 0 : 1,
      estimatedLEs: gateLuts,
      totalLuts: gateLuts,
      totalFfs: 0,
      totalDspBlocks: 0,
      totalMemBits: 0,
      totalMemoryBits: 0,
      totalEstimatedLEs: gateLuts,
      children: [],
    });
  }

  // 3. Procedural always blocks in this instance
  for (let idx = 0; idx < (hierNode.alwaysBlocks || []).length; idx++) {
    const blk = hierNode.alwaysBlocks[idx];
    if (blk.mode === 'tb') continue;
    const driverId = `${hierNode.instancePath}:always#${idx}`;
    _synEstimateStmt(blk.body, fullAst, localMetrics);

    const blockDrivenRanges = [];
    const inspectStmt = (stmt) => {
      if (!stmt || stmt.kind === 'Noop' || stmt.kind === 'SystemCall') return;
      if (stmt.kind === 'Block') {
        for (const s of stmt.statements) inspectStmt(s);
      } else if (stmt.kind === 'If') {
        inspectStmt(stmt.thenBranch);
        inspectStmt(stmt.elseBranch);
      } else if (stmt.kind === 'Case') {
        for (const it of stmt.items) inspectStmt(it.stmt);
        inspectStmt(stmt.defaultBranch);
      } else if (stmt.kind === 'ProcAssign') {
        const ranges = _synCollectTargetRanges(stmt.target, fullAst, []);
        for (const r of ranges) {
          if (!r.isMemory) {
            blockDrivenRanges.push(r);
            if (blk.mode === 'seq') {
              localSeqSignals.add(r.name);
              shared.seqSignals.add(r.name);
            } else {
              shared.combSignals.add(r.name);
            }
          }
        }

        const primarySig = ranges[0]?.name ?? null;
        if (blk.mode === 'seq' && stmt.op === '=') {
          shared.warnings.push(
            createDiagnostic({
              code: 'BLOCKING_NONBLOCKING_MIX',
              severity: 'warning',
              line: stmt.line,
              signal: primarySig,
              message: `Blocking assignment '=' used inside sequential block for '${primarySig}' at line ${stmt.line}; use '<=' instead.`,
              params: { signal: primarySig, actualOp: '=', expectedOp: '<=', blockMode: 'seq', line: stmt.line },
            })
          );
        } else if (blk.mode === 'comb' && stmt.op === '<=') {
          shared.warnings.push(
            createDiagnostic({
              code: 'BLOCKING_NONBLOCKING_MIX',
              severity: 'warning',
              line: stmt.line,
              signal: primarySig,
              message: `Non-blocking assignment '<=' used inside combinational block for '${primarySig}' at line ${stmt.line}; use '=' instead.`,
              params: { signal: primarySig, actualOp: '<=', expectedOp: '=', blockMode: 'comb', line: stmt.line },
            })
          );
        }
      }
    };

    inspectStmt(blk.body);
    shared.recordDriver(driverId, blockDrivenRanges, blk.line);

    if (blk.mode === 'comb') {
      const pathInfo = _synAnalyzeCombPaths(blk.body, fullAst);
      for (const sigName of pathInfo.may) {
        if (!pathInfo.must.has(sigName)) {
          const line = pathInfo.firstLine.get(sigName) ?? blk.line;
          shared.warnings.push(
            createDiagnostic({
              code: 'INFERRED_LATCH',
              severity: 'warning',
              line,
              signal: sigName,
              message: `Inferred latch for signal '${sigName}' in combinational block at line ${blk.line} (missing assignment on some paths).`,
              params: { signal: sigName, blockLine: blk.line, line },
            })
          );
        }
      }
      _synCollectCombDeps(blk.body, fullAst, new Set(), shared);
    }
  }

  for (const sigName of localSeqSignals) {
    localMetrics.ffs += fullAst.signals[sigName]?.width ?? 1;
  }

  // 4. Recurse into elaborated child instances (submodules + primitive gates)
  const childReports = [];
  let totalLuts = localMetrics.luts + totalGateLuts;
  let totalFfs = localMetrics.ffs;
  let totalDspBlocks = localMetrics.dspBlocks;
  let totalMemoryBits = localMetrics.memoryBits;

  for (const child of hierNode.children || []) {
    const childRep = _synAnalyzeInstanceNode(child, fullAst, shared);
    childReports.push(childRep);
    totalLuts += childRep.totalLuts;
    totalFfs += childRep.totalFfs;
    totalDspBlocks += childRep.totalDspBlocks;
    totalMemoryBits += childRep.totalMemoryBits;
  }

  for (const gateRep of gateChildReports) {
    childReports.push(gateRep);
  }

  const instName = hierNode.instanceName || (hierNode.instancePath ? hierNode.instancePath.split('.').pop() : hierNode.moduleName);
  const summary = {
    instanceName: instName,
    instancePath: hierNode.instancePath,
    moduleName: hierNode.moduleName,
    isPrimitive: false,
    luts: totalLuts,
    selfLuts: localMetrics.luts,
    ffs: totalFfs,
    selfFfs: localMetrics.ffs,
    dspBlocks: totalDspBlocks,
    memBits: totalMemoryBits,
    memoryBits: totalMemoryBits,
    selfMemBits: localMetrics.memoryBits,
    memoryCount: localMetrics.memoryCount,
    logicDepth: 0,
    estimatedLEs: Math.max(totalLuts, totalFfs),
    totalLuts,
    totalFfs,
    totalDspBlocks,
    totalMemBits: totalMemoryBits,
    totalMemoryBits,
    totalEstimatedLEs: Math.max(totalLuts, totalFfs),
    children: childReports,
  };
  shared.modules.push({
    instanceName: summary.instanceName,
    moduleName: summary.moduleName,
    instancePath: summary.instancePath,
    luts: summary.luts,
    selfLuts: summary.selfLuts,
    ffs: summary.ffs,
    selfFfs: summary.selfFfs,
    dspBlocks: summary.dspBlocks,
    memBits: summary.memBits,
    memoryBits: summary.memoryBits,
    totalLuts: summary.totalLuts,
    totalFfs: summary.totalFfs,
    totalMemoryBits: summary.totalMemoryBits,
    logicDepth: 0,
  });

  return summary;
}

// ============================================================================
// Smart Top-Module Selector (Board Mode vs. Testbench Mode, v4.0-A)
// ============================================================================

function _synStmtHasTbConstruct(stmt) {
  if (!stmt) return false;
  if (stmt.kind === 'Delay' || stmt.kind === 'EventCtrl') return true;
  if (
    stmt.kind === 'SystemCall' &&
    (stmt.name === '$finish' || stmt.name === '$stop' || stmt.name === '$display' || stmt.name === '$monitor')
  ) {
    return true;
  }
  if (stmt.kind === 'Block') return stmt.statements.some(_synStmtHasTbConstruct);
  if (stmt.kind === 'If') return _synStmtHasTbConstruct(stmt.thenBranch) || _synStmtHasTbConstruct(stmt.elseBranch);
  if (stmt.kind === 'For' || stmt.kind === 'RepeatStmt') return _synStmtHasTbConstruct(stmt.body);
  if (stmt.kind === 'Case') {
    return stmt.items.some((it) => _synStmtHasTbConstruct(it.stmt)) || _synStmtHasTbConstruct(stmt.defaultBranch);
  }
  return false;
}

function _synCollectModInstances(modAst, outSet) {
  for (const inst of modAst?.instances || []) {
    if (inst?.moduleName) outSet.add(inst.moduleName);
  }
  const scanGen = (items) => {
    for (const item of items || []) {
      if (!item) continue;
      if (item.kind === 'Instance' && item.moduleName) {
        outSet.add(item.moduleName);
      } else if (item.kind === 'GenerateFor') {
        scanGen(item.items);
      } else if (item.kind === 'GenerateIf') {
        if (item.thenBlock) scanGen(item.thenBlock.items);
        if (item.elseBlock) scanGen(item.elseBlock.items);
      }
    }
  };
  scanGen(modAst?.generateBlocks);
  return outSet;
}

/**
 * Return true if a parsed Module AST represents a simulation testbench
 * (`tb_*` / `*_tb` / `testbench*`, or a zero-port module containing `initial` / `#delay` / TB tasks).
 *
 * @param {object} modAst
 * @returns {boolean}
 */
export function isTestbenchModule(modAst) {
  if (!modAst || modAst.kind !== 'Module') return false;
  const name = String(modAst.name || '');
  if (/^(?:tb_|testbench)/i.test(name) || /_tb$/i.test(name)) {
    return true;
  }
  const hasPorts = Array.isArray(modAst.ports) && modAst.ports.length > 0;
  if (!hasPorts) {
    if (Array.isArray(modAst.initialBlocks) && modAst.initialBlocks.length > 0) return true;
    for (const blk of modAst.alwaysBlocks || []) {
      if (blk.mode === 'tb' || _synStmtHasTbConstruct(blk.body)) return true;
    }
  }
  return false;
}

/**
 * Smart top-module selector supporting dual Board Mode vs. Testbench Mode.
 * - `mode === 'board'`: skips testbench modules (`tb_*` or zero-port `initial`/`#delay` modules)
 *   to select the true synthesizable top-level design (preferring a DUT instantiated by a testbench).
 * - `mode === 'testbench'`: selects the top-level testbench module (`null` if none exists).
 *
 * Accepts a parsed Module AST, a `parseProgram()` result, or raw HDL source text.
 *
 * @param {string|object} astOrSource
 * @param {'board'|'testbench'} [mode='board']
 * @returns {object|null}
 */
export function selectTopModule(astOrSource, mode = 'board') {
  if (!astOrSource) return null;

  let modules = null;
  let moduleList = [];

  if (typeof astOrSource === 'string') {
    const prog = parseProgram(astOrSource);
    modules = prog.modules;
    moduleList = prog.moduleList;
  } else if (Array.isArray(astOrSource.moduleList) && astOrSource.modules) {
    modules = astOrSource.modules;
    moduleList = astOrSource.moduleList;
  } else if (astOrSource.kind === 'Module') {
    modules = astOrSource.modules || { [astOrSource.name]: astOrSource };
    const order = Array.isArray(astOrSource.moduleOrder)
      ? astOrSource.moduleOrder
      : Object.keys(modules);
    moduleList = order.map((n) => modules[n]).filter(Boolean);
    if (moduleList.length === 0) moduleList = [astOrSource];
  } else {
    return null;
  }

  if (moduleList.length === 0) return null;

  const attachRegistry = (mod) => {
    if (!mod) return null;
    mod.modules = modules;
    mod.moduleOrder = moduleList.map((m) => m.name);
    return mod;
  };

  const tbMods = moduleList.filter(isTestbenchModule);
  const designMods = moduleList.filter((m) => !isTestbenchModule(m));

  if (mode === 'testbench') {
    if (tbMods.length === 0) return null;
    const tbInstantiated = new Set();
    for (const m of tbMods) _synCollectModInstances(m, tbInstantiated);
    const tbRoots = tbMods.filter((m) => !tbInstantiated.has(m.name));
    const chosen = tbRoots.length > 0 ? tbRoots[tbRoots.length - 1] : tbMods[tbMods.length - 1];
    return attachRegistry(chosen);
  }

  // Board mode: pick top synthesizable design module, ignoring testbench wrappers
  if (designMods.length === 0) {
    return attachRegistry(moduleList[moduleList.length - 1]);
  }
  if (designMods.length === 1) {
    return attachRegistry(designMods[0]);
  }

  const designInstantiated = new Set();
  for (const m of designMods) {
    _synCollectModInstances(m, designInstantiated);
  }
  const designRoots = designMods.filter((m) => !designInstantiated.has(m.name));
  const candidates = designRoots.length > 0 ? designRoots : designMods;

  if (candidates.length > 1 && tbMods.length > 0) {
    const tbInstantiated = new Set();
    for (const m of tbMods) _synCollectModInstances(m, tbInstantiated);
    const dutCandidates = candidates.filter((m) => tbInstantiated.has(m.name));
    if (dutCandidates.length > 0) {
      return attachRegistry(dutCandidates[dutCandidates.length - 1]);
    }
  }

  return attachRegistry(candidates[candidates.length - 1]);
}

/**
 * Analyze an elaborated Module AST (or Verilog/SV source string) for FPGA resources,
 * Critical Path / Logic Depth, Module Hierarchy Tree, and static DRC checks.
 *
 * @param {string|object} astOrSource
 * @param {{ device?: { name?: string, totalLEs?: number, bramBits?: number, dspCount?: number }, topModule?: string }} [options={}]
 */
export function synthesize(astOrSource, options = {}) {
  const ast = elaborate(astOrSource, options);
  const devOpt = options.device || {};
  const deviceName = devOpt.name || DEFAULT_FPGA_DEVICE.name;
  const totalLEs = Number(devOpt.totalLEs ?? DEFAULT_FPGA_DEVICE.totalLEs) || EP2C35_TOTAL_LES;
  const deviceBramBits = Number(devOpt.bramBits ?? DEFAULT_FPGA_DEVICE.bramBits) || EP2C35_BRAM_BITS;

  const warnings = [];
  const errors = [];
  const seqSignals = new Set();
  const combSignals = new Set();
  const combDeps = new Map();
  const combLines = new Map();
  const readBitsBySig = new Map();
  const drivenBitsBySig = new Map();
  const wholeDrivenSigs = new Set();
  const driverMap = new Map();
  const memories = [];
  const modules = [];

  const recordDriver = (driverId, rangeList, line) => {
    for (const r of rangeList) {
      if (r.isMemory) continue;
      if (!driverMap.has(r.name)) driverMap.set(r.name, []);
      driverMap.get(r.name).push({
        driverId,
        lo: r.lo,
        hi: r.hi,
        line: line ?? r.line ?? null,
      });
    }
  };

  const recordCombDep = (range, rhsDepKeys, line) => {
    const tk = _synTargetDepKey(range, ast);
    if (tk.isBit) {
      if (!drivenBitsBySig.has(tk.sigName)) drivenBitsBySig.set(tk.sigName, new Set());
      drivenBitsBySig.get(tk.sigName).add(tk.bit);
    } else {
      wholeDrivenSigs.add(tk.sigName);
    }
    if (!combDeps.has(tk.key)) combDeps.set(tk.key, new Set());
    const bucket = combDeps.get(tk.key);
    for (const s of rhsDepKeys) {
      bucket.add(s);
    }
    if (!combLines.has(tk.key) && line != null) combLines.set(tk.key, line);
  };

  const shared = {
    warnings,
    errors,
    seqSignals,
    combSignals,
    combDeps,
    combLines,
    readBitsBySig,
    drivenBitsBySig,
    wholeDrivenSigs,
    recordDriver,
    recordCombDep,
    memories,
    modules,
  };

  const rootHier = ast.hierarchy || {
    moduleName: ast.name,
    instanceName: ast.name,
    instancePath: ast.name,
    prefix: '',
    signals: ast.signals || {},
    memories: ast.memories || {},
    assigns: ast.assigns || [],
    gates: ast.gates || [],
    alwaysBlocks: ast.alwaysBlocks || [],
    children: [],
  };

  const hierarchyReport = _synAnalyzeInstanceNode(rootHier, ast, shared);

  // DRC: MULTI_DRIVEN_NET (different assign/gate/always blocks driving overlapping bits)
  for (const [sigName, drivers] of driverMap.entries()) {
    const byDriver = new Map();
    for (const d of drivers) {
      if (!byDriver.has(d.driverId)) byDriver.set(d.driverId, []);
      byDriver.get(d.driverId).push(d);
    }

    const driverIds = [...byDriver.keys()];
    if (driverIds.length < 2) continue;

    let conflictFound = false;
    const conflictLines = new Set();

    for (let i = 0; i < driverIds.length; i++) {
      for (let j = i + 1; j < driverIds.length; j++) {
        const spansA = byDriver.get(driverIds[i]);
        const spansB = byDriver.get(driverIds[j]);
        for (const a of spansA) {
          for (const b of spansB) {
            if (a.lo <= b.hi && b.lo <= a.hi) {
              conflictFound = true;
              if (a.line != null) conflictLines.add(a.line);
              if (b.line != null) conflictLines.add(b.line);
            }
          }
        }
      }
    }

    if (conflictFound) {
      const sortedLines = [...conflictLines].sort((a, b) => a - b);
      errors.push(
        createDiagnostic({
          code: 'MULTI_DRIVEN_NET',
          severity: 'error',
          line: sortedLines[0] ?? null,
          signal: sigName,
          message: `Multi-driven net '${sigName}': driven by multiple blocks/assignments (lines: ${sortedLines.join(', ')}).`,
          params: { signal: sigName, driverCount: driverIds.length, driverLines: sortedLines },
        })
      );
    }
  }

  // Apply safe bit <-> whole wiring bridges before cycle & timing analysis
  _synApplyBitBridges(combDeps, readBitsBySig, drivenBitsBySig, wholeDrivenSigs);

  // DRC: Static COMBINATIONAL_LOOP detection (bit-accurate across full elaborated hierarchy)
  const cycles = _synFindCombCycles(combDeps, combLines);
  const cycleNodes = new Set();
  for (const c of cycles) {
    for (const n of c.cycle) cycleNodes.add(n);
    errors.push(
      createDiagnostic({
        code: 'COMBINATIONAL_LOOP',
        severity: 'error',
        line: c.line,
        signal: c.signal,
        message: `Static combinational loop detected: ${c.cycle.join(' -> ')}.`,
        params: { signal: c.signal, cycle: c.cycle, line: c.line },
      })
    );
  }

  // Critical Path / Logic Depth static timing estimation
  const timing = _synComputeCriticalPath(
    ast,
    seqSignals,
    cycleNodes,
    readBitsBySig,
    drivenBitsBySig,
    wholeDrivenSigs
  );
  _synAnnotateHierarchyDepth(hierarchyReport, rootHier, ast, timing);
  if (timing.logicDepth > hierarchyReport.logicDepth) {
    hierarchyReport.logicDepth = timing.logicDepth;
  }

  // Sync flat modules[] list with annotated logicDepth
  const depthByPath = new Map();
  const indexDepths = (node) => {
    depthByPath.set(node.instancePath, node.logicDepth);
    for (const ch of node.children || []) indexDepths(ch);
  };
  indexDepths(hierarchyReport);
  for (const modEntry of modules) {
    modEntry.logicDepth = depthByPath.get(modEntry.instancePath) ?? 0;
  }

  const totalLuts = hierarchyReport.totalLuts;
  const totalFfs = hierarchyReport.totalFfs;
  const totalDspBlocks = hierarchyReport.totalDspBlocks;
  const memoryBits = hierarchyReport.totalMemoryBits;
  const bramBlocks = memoryBits > 0 ? Math.ceil(memoryBits / 4096) : 0;
  const estimatedLEs = Math.max(totalLuts, totalFfs);
  const utilizationPct = Number(((estimatedLEs / totalLEs) * 100).toFixed(4));
  const bramUtilizationPct = Number(((memoryBits / deviceBramBits) * 100).toFixed(4));

  return {
    moduleName: ast.name,
    device: deviceName,
    luts: totalLuts,
    ffs: totalFfs,
    dspBlocks: totalDspBlocks,
    memBits: memoryBits,
    memoryBits,
    bramBlocks,
    totalBramBits: deviceBramBits,
    bramUtilizationPct,
    memories,
    estimatedLEs,
    totalLEs,
    utilizationPct,
    logicDepth: timing.logicDepth,
    criticalPathDepth: timing.logicDepth,
    estimatedDelayNs: timing.estimatedDelayNs,
    criticalPathSignals: timing.criticalPathSignals,
    hierarchy: hierarchyReport,
    modules,
    warnings,
    errors,
    diagnostics: [...errors, ...warnings],
    seqSignals: [...seqSignals],
    combSignals: [...combSignals],
  };
}
