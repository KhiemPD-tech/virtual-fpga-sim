import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_HDL_FILE_BYTES,
  sanitizeHdlText,
  validateUploadedHdlFile,
  preprocessWorkspace,
  resolveSourceLocation,
  mapDiagnosticToSource,
} from '../src/engine/preprocessor.js';
import { HdlError } from '../src/engine/lexer.js';
import { parse } from '../src/engine/parser.js';
import { createSimulator } from '../src/engine/simulator.js';
import { synthesize } from '../src/engine/synthesizer.js';
import {
  WORKSPACE_SCHEMA_VERSION,
  serializeWorkspace,
  deserializeWorkspace,
} from '../src/engine/exporters.js';
import { formatDiagnostic, setLanguage } from '../src/i18n.js';
import { HdlEditor } from '../src/ui/editor.js';

// ============================================================================
// Test 1: Preprocessor Directives (`timescale, `default_nettype, `define) & Source Map
// ============================================================================

test('v3.1 Preprocessor: skips synthesis directives, expands `define macros, and maps errors back to exact file & line', () => {
  const macroSrc = [
    '`timescale 1ns / 1ps',
    '`default_nettype none',
    '`celldefine',
    '`define BUS_W 4',
    '`define OFFSET 4\'d3',
    '`define DOUBLE_W (`BUS_W * 2)',
    'module macro_adder (',
    '  input  logic [`BUS_W-1:0] a,',
    '  output logic [`BUS_W-1:0] y,',
    '  output logic [`DOUBLE_W-1:0] wide_out',
    ');',
    '  assign y = a + `OFFSET;',
    '  assign wide_out = {4\'d0, a};',
    'endmodule',
    '`endcelldefine',
  ].join('\n');

  const pp = preprocessWorkspace([{ name: 'macro_adder.sv', content: macroSrc }]);

  assert.equal(pp.warnings.length, 0);
  assert.equal(pp.infos.length, 4);
  assert.deepEqual(
    pp.infos.map((i) => i.params.directive),
    ['`timescale', '`default_nettype', '`celldefine', '`endcelldefine']
  );
  assert.equal(pp.defines.BUS_W, '4');
  assert.equal(pp.defines.OFFSET, "4'd3");

  const ast = parse(pp.mergedCode);
  assert.equal(ast.name, 'macro_adder');
  assert.equal(ast.signals.a.width, 4);
  assert.equal(ast.signals.y.width, 4);
  assert.equal(ast.signals.wide_out.width, 8);

  const sim = createSimulator(ast);
  sim.setInput('a', 5);
  assert.equal(sim.getSignal('y').val, 8n);
  assert.equal(sim.getSignal('wide_out').val, 5n);

  // Verify exact multi-file source-map localization on a syntax error in Tab 2
  const file1 = [
    '`timescale 1ns/1ps',
    'module sub_ok(',
    '  input logic x,',
    '  output logic y',
    ');',
    '  assign y = x;',
    'endmodule',
  ].join('\n');

  const file2 = [
    '// Second tab with syntax error on line 6',
    'module top_broken(',
    '  input logic clk,',
    '  output reg q',
    ');',
    '  always @(posedge clk) begin',
    '    q <= 1\'b1',
    '  end',
    'endmodule',
  ].join('\n');

  const ppErr = preprocessWorkspace([
    { name: 'sub_ok.v', content: file1 },
    { name: 'top_broken.sv', content: file2 },
  ]);

  let caught = null;
  try {
    parse(ppErr.mergedCode);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof HdlError, 'Expected HdlError from broken second tab');

  const mapped = mapDiagnosticToSource(caught.toDiagnostic(), ppErr.sourceMap);
  assert.equal(mapped.file, 'top_broken.sv');
  assert.equal(mapped.line, 8);
  const loc = resolveSourceLocation(ppErr.sourceMap, caught.line);
  assert.deepEqual(loc, { fileName: 'top_broken.sv', originalLine: 8 });

  setLanguage('en');
  const formattedEn = formatDiagnostic(mapped);
  assert.ok(formattedEn.includes('[top_broken.sv]'), `Expected filename prefix, got: ${formattedEn}`);
  assert.ok(formattedEn.includes('Line 8'), `Expected Line 8, got: ${formattedEn}`);
});

// ============================================================================
// Test 2: Multi-File Compilation (`defs.vh` + `sub_adder.v` + `top.v`) & Missing `include
// ============================================================================

test('v3.1 Multi-File: compiles 3 tabs with `include "defs.vh" + parameterized instantiation and warns on missing include', () => {
  const defsVh = [
    '// Shared parameter definitions',
    '`define DATA_W 4',
    '`define BIAS   4\'d2',
  ].join('\n');

  const subAdderV = [
    '`timescale 1ns/1ps',
    '`include "defs.vh"',
    'module sub_adder #(parameter W = `DATA_W) (',
    '  input  wire [W-1:0] a,',
    '  input  wire [W-1:0] b,',
    '  output wire [W-1:0] sum',
    ');',
    '  assign sum = a + b + `BIAS;',
    'endmodule',
  ].join('\n');

  const topV = [
    '`include "defs.vh"',
    'module multi_top (',
    '  input  wire [17:0] SW,',
    '  output wire [17:0] LEDR',
    ');',
    '  wire [`DATA_W-1:0] res;',
    '  sub_adder #(.W(`DATA_W)) u_add (',
    '    .a(SW[3:0]),',
    '    .b(SW[7:4]),',
    '    .sum(res)',
    '  );',
    '  assign LEDR = {14\'d0, res};',
    'endmodule',
  ].join('\n');

  const pp = preprocessWorkspace([
    { name: 'defs.vh', content: defsVh },
    { name: 'sub_adder.v', content: subAdderV },
    { name: 'top.v', content: topV },
  ]);

  assert.equal(pp.warnings.length, 0);
  assert.ok(pp.includedFiles.includes('defs.vh'));

  const ast = parse(pp.mergedCode);
  assert.equal(ast.name, 'multi_top');

  const report = synthesize(ast);
  assert.equal(report.errors.length, 0);

  const sim = createSimulator(ast);
  // a = 3, b = 4, BIAS = 2 => sum = 9
  sim.setInput('SW', (4 << 4) | 3);
  assert.equal(sim.getSignal('LEDR').val, 9n);

  // a = 10, b = 5, BIAS = 2 => (10 + 5 + 2) & 0xF = 1
  sim.setInput('SW', (5 << 4) | 10);
  assert.equal(sim.getSignal('LEDR').val, 1n);

  // Missing `include warning when defs.vh is not loaded
  const ppMissing = preprocessWorkspace([
    { name: 'top.v', content: '`include "missing_defs.vh"\nmodule m(input a, output y); assign y = a; endmodule' },
  ]);
  assert.equal(ppMissing.warnings.length, 1);
  assert.equal(ppMissing.warnings[0].code, 'PREPROC_MISSING_INCLUDE');
  assert.equal(ppMissing.warnings[0].file, 'top.v');
  assert.equal(ppMissing.warnings[0].line, 1);
  assert.equal(ppMissing.warnings[0].params.includeFile, 'missing_defs.vh');

  // Circular `include protection
  const ppCirc = preprocessWorkspace([
    { name: 'a.vh', content: '`include "b.vh"\n`define A 1' },
    { name: 'b.vh', content: '`include "a.vh"\n`define B 2' },
    { name: 'main.v', content: '`include "a.vh"\nmodule m(input x, output y); assign y = x; endmodule' },
  ]);
  assert.ok(ppCirc.warnings.some((w) => w.code === 'PREPROC_CIRCULAR_INCLUDE'));
});

// ============================================================================
// Test 3: BOM/CRLF Sanitization, Upload Validation (.vhd / Binary / Size) & .lab.json v2/v3
// ============================================================================

test('v3.1 Upload Validation & Workspace v2/v3: strips BOM/CRLF, rejects .vhd/binary/>512KB, preserves v2/v3 .lab.json', () => {
  // UTF-8 BOM + CRLF sanitization
  const rawBom = '\uFEFFmodule clean_mod(\r\n  input a,\r\n  output y\r\n);\r\n  assign y = a;\r\nendmodule\r\n';
  const cleaned = sanitizeHdlText(rawBom);
  assert.ok(!cleaned.startsWith('\uFEFF'));
  assert.ok(!cleaned.includes('\r'));
  assert.ok(cleaned.startsWith('module clean_mod(\n'));

  // Valid upload from raw UTF-8 bytes with BOM
  const bytesWithBom = new TextEncoder().encode(rawBom);
  const okRes = validateUploadedHdlFile('C:\\Users\\Student\\clean_mod.v', bytesWithBom);
  assert.equal(okRes.ok, true);
  assert.equal(okRes.name, 'clean_mod.v');
  assert.equal(okRes.content, cleaned);

  // Reject VHDL (.vhd and .vhdl)
  const vhdRes = validateUploadedHdlFile('counter.vhd', 'entity counter is end entity;');
  assert.equal(vhdRes.ok, false);
  assert.equal(vhdRes.code, 'UPLOAD_VHDL_UNSUPPORTED');

  const vhdlRes = validateUploadedHdlFile('alu.VHDL', 'entity alu is end entity;');
  assert.equal(vhdlRes.ok, false);
  assert.equal(vhdlRes.code, 'UPLOAD_VHDL_UNSUPPORTED');

  // Reject unsupported extension
  const txtRes = validateUploadedHdlFile('notes.txt', 'hello');
  assert.equal(txtRes.ok, false);
  assert.equal(txtRes.code, 'UPLOAD_UNSUPPORTED_EXT');

  // Reject binary file with null byte
  const binBytes = new Uint8Array([0x6d, 0x6f, 0x64, 0x00, 0x75, 0x6c, 0x65]);
  const binRes = validateUploadedHdlFile('corrupt.v', binBytes);
  assert.equal(binRes.ok, false);
  assert.equal(binRes.code, 'UPLOAD_BINARY_REJECTED');

  // Reject file exceeding 512 KB
  const oversized = new Uint8Array(MAX_HDL_FILE_BYTES + 16);
  oversized.fill(0x20); // spaces (valid text, no null bytes)
  const bigRes = validateUploadedHdlFile('huge.sv', oversized);
  assert.equal(bigRes.ok, false);
  assert.equal(bigRes.code, 'UPLOAD_FILE_TOO_LARGE');

  // .lab.json v3 multi-file round-trip
  assert.equal(WORKSPACE_SCHEMA_VERSION, 3);
  const v3Json = serializeWorkspace({
    boardId: 'basys3',
    clockMode: '100',
    files: [
      { name: 'defs.vh', content: '`define W 8\r\n' },
      { name: 'top.sv', content: 'module top(input logic a, output logic y); assign y = a; endmodule' },
    ],
    activeFile: 'top.sv',
    language: 'en',
  });
  const v3Parsed = deserializeWorkspace(v3Json);
  assert.equal(v3Parsed.version, 3);
  assert.equal(v3Parsed.boardId, 'basys3');
  assert.equal(v3Parsed.files.length, 2);
  assert.equal(v3Parsed.files[0].name, 'defs.vh');
  assert.equal(v3Parsed.files[0].content, '`define W 8\n');
  assert.equal(v3Parsed.activeFile, 'top.sv');
  assert.equal(v3Parsed.hdlCode, v3Parsed.files[1].content);

  // Backward compatibility: loading legacy v2 single-file .lab.json
  const legacyV2 = JSON.stringify({
    version: 2,
    boardId: 'de2',
    clockMode: '5',
    hdlCode: 'module legacy(input a, output y); assign y = ~a; endmodule',
    filename: 'legacy.sv',
    language: 'vi',
  });
  const v2Parsed = deserializeWorkspace(legacyV2);
  assert.equal(v2Parsed.version, 2);
  assert.equal(v2Parsed.files.length, 1);
  assert.equal(v2Parsed.files[0].name, 'legacy.sv');
  assert.equal(v2Parsed.activeFile, 'legacy.sv');
  assert.equal(v2Parsed.hdlCode, v2Parsed.files[0].content);
});

// ============================================================================
// Test 4: HdlEditor Headless Multi-File Tab Operations
// ============================================================================

test('v3.1 HdlEditor: manages multi-file tabs, rename, safe close, and per-file error diagnostics', () => {
  const ed = new HdlEditor(null, {
    initialFiles: [{ name: 'top.sv', content: 'module top; endmodule' }],
  });

  assert.equal(ed.getFiles().length, 1);
  assert.equal(ed.getActiveFile().name, 'top.sv');
  // Cannot close last remaining tab
  assert.equal(ed.closeFile('top.sv'), false);

  // Upsert new tab & replace existing tab
  ed.upsertFile('sub.v', 'module sub; endmodule', true);
  assert.equal(ed.getFiles().length, 2);
  assert.equal(ed.getActiveFile().name, 'sub.v');

  ed.upsertFile('sub.v', 'module sub_v2; endmodule', false);
  assert.equal(ed.getFiles().length, 2);
  assert.equal(ed.getActiveFile().content, 'module sub_v2; endmodule');

  // Rename & per-file error tracking
  ed.setErrors([{ file: 'sub.v', line: 1, severity: 'error', message: 'Test error' }]);
  assert.equal(ed.renameFile('sub.v', 'sub_renamed.v'), true);
  assert.equal(ed.getActiveFile().name, 'sub_renamed.v');
  assert.ok(ed.errorsByFile.has('sub_renamed.v'));

  // Switch & close
  assert.equal(ed.switchToFile('top.sv'), true);
  assert.equal(ed.getActiveFile().name, 'top.sv');
  assert.equal(ed.closeFile('sub_renamed.v'), true);
  assert.equal(ed.getFiles().length, 1);
  assert.equal(ed.closeFile('top.sv'), false);
});
