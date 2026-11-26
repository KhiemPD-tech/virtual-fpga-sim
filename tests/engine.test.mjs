import test from 'node:test';
import assert from 'node:assert/strict';

import { TokenType, HdlError, tokenize } from '../src/engine/lexer.js';
import { parseVerilogLiteral, parse } from '../src/engine/parser.js';
import {
  MAX_COMB_ITERATIONS,
  createLogic4,
  logic4ToString,
  Simulator,
  createSimulator,
} from '../src/engine/simulator.js';
import { EP2C35_TOTAL_LES, synthesize } from '../src/engine/synthesizer.js';
import { PRESETS, getPresetById } from '../src/presets.js';
import { RING_BUFFER_CAPACITY, WaveformViewer } from '../src/ui/waveform.js';
import { stripModuleSyntax } from '../build.mjs';

// ============================================================================
// 1. Lexer & Literal Parsing Tests
// ============================================================================

test('Lexer: tokenizes keywords, comments, underscores, X/Z literals, operators, and line/col', () => {
  const src = `
// Single-line comment
module demo (
  /* Multi-line
     comment */
  input logic clk,
  output reg [7:0] y
);
  assign y = 8'b1010_0101;
  assign z = 4'bx;
  assign w = 4'bz;
  assign d = 7'd42 + 8'hFF + 10;
endmodule
`;
  const tokens = tokenize(src);
  const modTok = tokens[0];
  assert.equal(modTok.type, TokenType.KEYWORD);
  assert.equal(modTok.value, 'module');
  assert.equal(modTok.line, 3);
  assert.equal(modTok.col, 1);

  const literals = tokens.filter((t) => t.type === TokenType.NUMBER).map((t) => t.value);
  assert.deepEqual(literals, ['7', '0', "8'b1010_0101", "4'bx", "4'bz", "7'd42", "8'hFF", '10']);

  // Verify 4-state literal decoding
  const binLit = parseVerilogLiteral("8'b1010_0101");
  assert.equal(binLit.width, 8);
  assert.equal(binLit.val, 0xA5n);
  assert.equal(binLit.xMask, 0n);

  const xLit = parseVerilogLiteral("4'bx");
  assert.equal(xLit.width, 4);
  assert.equal(xLit.val, 0n);
  assert.equal(xLit.xMask, 0b1111n);
  assert.equal(xLit.zMask, 0n);

  const zLit = parseVerilogLiteral("4'bz");
  assert.equal(zLit.width, 4);
  assert.equal(zLit.val, 0n);
  assert.equal(zLit.xMask, 0n);
  assert.equal(zLit.zMask, 0b1111n);
});

test('Lexer: throws structured HdlError with exact line number on malformed input', () => {
  assert.throws(
    () => tokenize('module a;\n  assign x = \\invalid;\nendmodule'),
    (err) => {
      assert.ok(err instanceof HdlError);
      const diag = err.toDiagnostic();
      assert.equal(diag.code, 'UNEXPECTED_CHAR');
      assert.equal(diag.severity, 'error');
      assert.equal(diag.line, 2);
      assert.equal(diag.params.char, '\\');
      return true;
    }
  );

  assert.throws(
    () => tokenize("module a;\n  assign x = 4'b ;\nendmodule"),
    (err) => {
      assert.ok(err instanceof HdlError);
      assert.equal(err.code, 'INVALID_LITERAL');
      assert.equal(err.line, 2);
      return true;
    }
  );

  assert.throws(
    () => tokenize('module a;\n/* unclosed comment\nendmodule'),
    (err) => {
      assert.ok(err instanceof HdlError);
      assert.equal(err.code, 'UNTERMINATED_COMMENT');
      assert.equal(err.line, 2);
      return true;
    }
  );
});

// ============================================================================
// 2. Parser Tests (ANSI & Classic Ports, <= Disambiguation, Always Styles)
// ============================================================================

test('Parser: supports ANSI ports, classic Verilog ports, always @*, always_comb, always_ff, and <= disambiguation', () => {
  const classicSrc = `
    module classic_mod(clk, SW, LEDR);
      input clk;
      input [17:0] SW;
      output [17:0] LEDR;
      reg [17:0] LEDR;

      always @* begin
        LEDR = (SW[3:0] <= 4'd9) ? {14'b0, SW[3:0]} : 18'd0;
      end
    endmodule
  `;
  const classicAst = parse(classicSrc);
  assert.equal(classicAst.name, 'classic_mod');
  assert.equal(classicAst.signals.SW.dir, 'input');
  assert.equal(classicAst.signals.SW.width, 18);
  assert.equal(classicAst.signals.LEDR.dir, 'output');
  assert.equal(classicAst.signals.LEDR.storage, 'reg');
  assert.equal(classicAst.signals.LEDR.width, 18);
  assert.equal(classicAst.alwaysBlocks[0].mode, 'comb');

  // Disambiguate statement NBA `<=` vs relational expression `<=`
  const nbaAndRelSrc = `
    module disambig(
      input logic clk,
      input [3:0] a,
      input [3:0] b,
      output logic flag
    );
      always_ff @(posedge clk) begin
        flag <= (a <= b);
      end
    endmodule
  `;
  const ast = parse(nbaAndRelSrc);
  const assignStmt = ast.alwaysBlocks[0].body.statements[0];
  assert.equal(assignStmt.kind, 'ProcAssign');
  assert.equal(assignStmt.op, '<=');
  assert.equal(assignStmt.expr.kind, 'Binary');
  assert.equal(assignStmt.expr.op, '<=');

  // Execute to verify runtime evaluation of disambiguated <=
  const sim = createSimulator(ast);
  sim.setInput('a', 3);
  sim.setInput('b', 5);
  sim.stepClock();
  assert.equal(sim.getSignal('flag').val, 1n);

  sim.setInput('a', 7);
  sim.setInput('b', 5);
  sim.stepClock();
  assert.equal(sim.getSignal('flag').val, 0n);
});

test('Parser: throws structured syntax error with exact line number on malformed HDL', () => {
  const badHdl = `module broken(
  input clk,
  output reg y
);
  always @(posedge clk) begin
    y <= 1'b1
  end
endmodule`;

  assert.throws(
    () => parse(badHdl),
    (err) => {
      assert.ok(err instanceof HdlError);
      const diag = err.toDiagnostic();
      assert.equal(diag.code, 'EXPECTED_SEMICOLON');
      assert.equal(diag.severity, 'error');
      assert.equal(diag.line, 7);
      return true;
    }
  );
});

// ============================================================================
// Scenario 1: 4-bit Full Adder (Combinational)
// ============================================================================

test('Scenario 1: 4-bit Full Adder (SW[3:0] + SW[7:4] -> LEDR[3:0] sum & LEDG[0] carry-out)', () => {
  const adderHdl = `
    module full_adder_4bit (
      input [17:0] SW,
      output [17:0] LEDR,
      output [8:0] LEDG
    );
      assign {LEDG[0], LEDR[3:0]} = SW[3:0] + SW[7:4];
      assign LEDR[17:4] = 14'd0;
      assign LEDG[8:1] = 8'd0;
    endmodule
  `;

  const ast = parse(adderHdl);
  const sim = createSimulator(ast);
  const report = synthesize(ast);

  assert.equal(report.errors.length, 0);
  assert.equal(report.warnings.length, 0);
  assert.equal(report.ffs, 0);
  assert.ok(report.luts >= 4, `Expected >= 4 LUTs for 4-bit adder, got ${report.luts}`);

  const testCases = [
    { a: 0x0, b: 0x0, sum: 0x0, carry: 0n },
    { a: 0x5, b: 0x9, sum: 0xE, carry: 0n },
    { a: 0x7, b: 0x8, sum: 0xF, carry: 0n },
    { a: 0xF, b: 0x1, sum: 0x0, carry: 1n }, // Overflow case: 4'hF + 4'h1 -> sum=0, carry=1
    { a: 0xF, b: 0xF, sum: 0xE, carry: 1n }, // Max overflow: 15 + 15 = 30 -> sum=14, carry=1
  ];

  for (const tc of testCases) {
    const sw = (tc.b << 4) | tc.a;
    sim.setInput('SW', sw);

    const ledr = sim.getSignal('LEDR');
    const ledg = sim.getSignal('LEDG');
    assert.equal(ledr.xMask, 0n);
    assert.equal(ledg.xMask, 0n);
    assert.equal(ledr.val & 0xFn, BigInt(tc.sum), `Failed sum for ${tc.a} + ${tc.b}`);
    assert.equal(ledg.val & 1n, tc.carry, `Failed carry for ${tc.a} + ${tc.b}`);
  }
});

test('Simulator: supports unary reduction operators (&, |, ^) and >32-bit BigInt vectors without overflow', () => {
  const hdl = `
    module wide_and_reduce (
      input [39:0] a,
      input [39:0] b,
      output [39:0] sum,
      output r_and,
      output r_or,
      output r_xor
    );
      assign sum = a + b;
      assign r_and = &a[3:0];
      assign r_or  = |a[3:0];
      assign r_xor = ^a[3:0];
    endmodule
  `;
  const sim = createSimulator(hdl);
  sim.setInput('a', 0xFF_FFFF_FFFFn);
  sim.setInput('b', 1n);
  assert.equal(sim.getSignal('sum').val, 0n); // Wraps cleanly at 40 bits
  assert.equal(sim.getSignal('r_and').val, 1n);
  assert.equal(sim.getSignal('r_or').val, 1n);
  assert.equal(sim.getSignal('r_xor').val, 0n); // 4 ones -> even parity = 0

  sim.setInput('a', 0x1_0000_0007n);
  sim.setInput('b', 0x2_0000_0001n);
  assert.equal(sim.getSignal('sum').val, 0x3_0000_0008n); // Preserves bits > 32
  assert.equal(sim.getSignal('r_and').val, 0n); // 0111 -> & = 0
  assert.equal(sim.getSignal('r_or').val, 1n);  // 0111 -> | = 1
  assert.equal(sim.getSignal('r_xor').val, 1n); // 0111 -> ^ = 1
});

// ============================================================================
// Scenario 2: Sequential Counter (always_ff, <=, Async KEY[0] Reset & NBA Swap)
// ============================================================================

test('Scenario 2a: Sequential counter with async active-low KEY[0] reset and posedge CLOCK_50 increment', () => {
  const counterHdl = `
    module counter_4bit (
      input CLOCK_50,
      input [17:0] SW,
      input [3:0] KEY,
      output logic [3:0] count
    );
      always_ff @(posedge CLOCK_50 or negedge KEY[0]) begin
        if (!KEY[0]) begin
          count <= 4'd0;
        end else if (SW[0]) begin
          count <= count + 4'd1;
        end
      end
    endmodule
  `;

  const ast = parse(counterHdl);
  const sim = createSimulator(ast);
  assert.equal(sim.getClockPort(), 'CLOCK_50');

  // Release KEY[0] (0 -> 1, not a negedge) -> count still X
  sim.setInput('KEY', 0b1111);
  assert.notEqual(sim.getSignal('count').xMask, 0n);

  // Trigger async active-low reset: KEY[0] transitions 1 -> 0 (NO clock pulse needed)
  sim.setInput('KEY', 0b1110);
  assert.equal(sim.getSignal('count').xMask, 0n);
  assert.equal(sim.getSignal('count').val, 0n);

  // Release reset (KEY[0] = 1) and enable counting (SW[0] = 1)
  sim.setInput('KEY', 0b1111);
  sim.setInput('SW', 1);

  for (let expected = 1n; expected <= 5n; expected++) {
    sim.stepClock();
    assert.equal(sim.getSignal('count').val, expected);
    assert.equal(sim.getSignal('count').xMask, 0n);
  }

  // Pause when SW[0] == 0
  sim.setInput('SW', 0);
  sim.stepClock();
  assert.equal(sim.getSignal('count').val, 5n);

  // Re-assert async reset mid-count (KEY[0] 1 -> 0) -> resets immediately without clock
  sim.setInput('KEY', 0b1110);
  assert.equal(sim.getSignal('count').val, 0n);

  // Snapshot check
  const snap = sim.getSnapshot();
  assert.equal(snap.cycle, 6);
  assert.equal(snap.halted, false);
  assert.equal(snap.signals.count.val, 0n);
});

test('Scenario 2b: True non-blocking (<=) concurrency swaps registers simultaneously and supports clk alias', () => {
  const swapHdl = `
    module reg_swap (
      input clk,
      input [3:0] KEY,
      output logic [3:0] a,
      output logic [3:0] b
    );
      always_ff @(posedge clk or negedge KEY[0]) begin
        if (!KEY[0]) begin
          a <= 4'hA;
          b <= 4'h5;
        end else begin
          a <= b;
          b <= a;
        end
      end
    endmodule
  `;

  const sim = createSimulator(swapHdl);
  assert.equal(sim.getClockPort(), 'clk');

  // Async reset loads a=0xA, b=0x5
  sim.setInput('KEY', 0b1111);
  sim.setInput('KEY', 0b1110);
  assert.equal(sim.getSignal('a').val, 0xAn);
  assert.equal(sim.getSignal('b').val, 0x5n);

  // Release reset and clock once: true NBA swap -> a=0x5, b=0xA
  sim.setInput('KEY', 0b1111);
  sim.stepClock();
  assert.equal(sim.getSignal('a').val, 0x5n);
  assert.equal(sim.getSignal('b').val, 0xAn);

  // Clock again -> swaps back to a=0xA, b=0x5
  sim.stepClock();
  assert.equal(sim.getSignal('a').val, 0xAn);
  assert.equal(sim.getSignal('b').val, 0x5n);
});

// ============================================================================
// Scenario 3: DRC & Combinational Loop Detection (Static & Runtime)
// ============================================================================

test('Scenario 3a: Synthesizer flags INFERRED_LATCH on incomplete if/case, and passes when all paths assign', () => {
  const latchHdl = `
    module latch_demo (
      input sel,
      input [3:0] d,
      output logic [3:0] q
    );
      always_comb begin
        if (sel)
          q = d;
      end
    endmodule
  `;
  const report = synthesize(latchHdl);
  const latchWarn = report.warnings.find((w) => w.code === 'INFERRED_LATCH');
  assert.ok(latchWarn, 'Expected INFERRED_LATCH warning');
  assert.equal(latchWarn.severity, 'warning');
  assert.equal(latchWarn.signal, 'q');
  assert.equal(typeof latchWarn.line, 'number');
  assert.ok(latchWarn.params && latchWarn.params.signal === 'q');

  // No latch when default assignment precedes incomplete if
  const safeHdl = `
    module no_latch (
      input sel,
      input [3:0] d,
      output logic [3:0] q
    );
      always_comb begin
        q = 4'd0;
        if (sel)
          q = d;
      end
    endmodule
  `;
  const safeReport = synthesize(safeHdl);
  assert.equal(safeReport.warnings.filter((w) => w.code === 'INFERRED_LATCH').length, 0);
});

test('Scenario 3b: Static & runtime COMBINATIONAL_LOOP detection', () => {
  // Static self-loop: assign a = ~a;
  const selfLoopHdl = `
    module self_loop (output a);
      assign a = ~a;
    endmodule
  `;
  const rep1 = synthesize(selfLoopHdl);
  const err1 = rep1.errors.find((e) => e.code === 'COMBINATIONAL_LOOP');
  assert.ok(err1, 'Expected static COMBINATIONAL_LOOP error on assign a = ~a');
  assert.equal(err1.severity, 'error');
  assert.equal(err1.signal, 'a');

  // Static 2-node loop: assign a = b; assign b = a;
  const twoNodeLoopHdl = `
    module two_loop (output a, output b);
      assign a = b;
      assign b = a;
    endmodule
  `;
  const rep2 = synthesize(twoNodeLoopHdl);
  const err2 = rep2.errors.find((e) => e.code === 'COMBINATIONAL_LOOP');
  assert.ok(err2, 'Expected static COMBINATIONAL_LOOP error on a <-> b cycle');
  assert.deepEqual(err2.params.cycle, ['a', 'b', 'a']);

  // Runtime oscillating loop: starts stable at 0 when en=0, oscillates when en=1 -> halts at 64 iters
  const runtimeLoopHdl = `
    module osc_loop (
      input en,
      output a
    );
      assign a = en ? ~a : 1'b0;
    endmodule
  `;
  const sim = createSimulator(runtimeLoopHdl);
  assert.equal(sim.halted, false);
  assert.equal(sim.getSignal('a').val, 0n);

  // Enable feedback oscillation
  sim.setInput('en', 1);
  assert.equal(sim.halted, true);
  assert.ok(sim.runtimeError, 'Expected runtimeError to be populated');
  assert.equal(sim.runtimeError.code, 'COMBINATIONAL_LOOP');
  assert.equal(sim.runtimeError.severity, 'error');
  assert.equal(sim.runtimeError.params.maxIterations, MAX_COMB_ITERATIONS);
});

test('Scenario 3c: Synthesizer detects MULTI_DRIVEN_NET, BLOCKING_NONBLOCKING_MIX, and estimates resources', () => {
  const badStyleHdl = `
    module drc_kitchen_sink (
      input CLOCK_50,
      input [3:0] a,
      input [3:0] b,
      output reg [7:0] prod,
      output reg [3:0] comb_out,
      output multi_net
    );
      assign multi_net = a[0];
      assign multi_net = b[0];

      always @(posedge CLOCK_50) begin
        prod = a * b;
      end

      always @(*) begin
        comb_out <= a + b;
      end
    endmodule
  `;

  const report = synthesize(badStyleHdl);
  assert.equal(report.totalLEs, EP2C35_TOTAL_LES);
  assert.equal(report.ffs, 8); // prod [7:0]
  assert.equal(report.dspBlocks, 1); // a * b multiplier flagged as DSP
  assert.ok(report.luts > 0);
  assert.ok(report.utilizationPct > 0);

  assert.ok(
    report.errors.some((e) => e.code === 'MULTI_DRIVEN_NET' && e.signal === 'multi_net'),
    'Expected MULTI_DRIVEN_NET on multi_net'
  );
  assert.equal(
    report.warnings.filter((w) => w.code === 'BLOCKING_NONBLOCKING_MIX').length,
    2,
    'Expected 2 BLOCKING_NONBLOCKING_MIX warnings (seq = and comb <=)'
  );
});

// ============================================================================
// Scenario 4: 4-State X Initialization, Propagation & Reset Resolution
// ============================================================================

test('Scenario 4: Uninitialized registers start as X, propagate X combinationally, and resolve on reset', () => {
  const xPropHdl = `
    module x_prop_demo (
      input CLOCK_50,
      input [3:0] KEY,
      output logic [3:0] q,
      output [3:0] q_plus_one,
      output [3:0] masked_low
    );
      assign q_plus_one = q + 4'd1;
      assign masked_low = q & 4'b0011;

      always_ff @(posedge CLOCK_50 or negedge KEY[0]) begin
        if (!KEY[0])
          q <= 4'd0;
        else
          q <= q + 4'd1;
      end
    endmodule
  `;

  const sim = createSimulator(xPropHdl);

  // 1. Before reset: register q is all-X (xMask = 0b1111n)
  const qInit = sim.getSignal('q');
  assert.equal(qInit.xMask, 0b1111n);
  assert.equal(logic4ToString(qInit, 'bin'), 'XXXX');

  // 2. X propagates through arithmetic (+ -> all X) and obeys 4-state controlling-0 in bitwise AND (0 & X = 0)
  const qPlusInit = sim.getSignal('q_plus_one');
  assert.equal(qPlusInit.xMask, 0b1111n);

  const maskedInit = sim.getSignal('masked_low');
  assert.equal(maskedInit.xMask, 0b0011n); // Upper 2 bits known 0 because 0 & X == 0; lower 2 bits X!
  assert.equal(logic4ToString(maskedInit, 'bin'), '00XX');

  // 3. Assert active-low async reset (KEY[0]: 1 -> 0) -> resolves cleanly to known 0/1
  sim.setInput('KEY', 0b1111);
  sim.setInput('KEY', 0b1110);

  const qReset = sim.getSignal('q');
  assert.equal(qReset.xMask, 0n);
  assert.equal(qReset.zMask, 0n);
  assert.equal(qReset.val, 0n);

  const qPlusReset = sim.getSignal('q_plus_one');
  assert.equal(qPlusReset.xMask, 0n);
  assert.equal(qPlusReset.val, 1n);

  const maskedReset = sim.getSignal('masked_low');
  assert.equal(maskedReset.xMask, 0n);
  assert.equal(maskedReset.val, 0n);

  // 4. Release reset and step clock -> stays known
  sim.setInput('KEY', 0b1111);
  sim.stepClock();
  assert.equal(sim.getSignal('q').val, 1n);
  assert.equal(sim.getSignal('q').xMask, 0n);
  assert.equal(sim.getSignal('q_plus_one').val, 2n);
});

test('Case statement, always @(*), CLK alias, and disjoint slice drivers (no false MULTI_DRIVEN_NET)', () => {
  const bcdSegHdl = `
    module seg_demo (
      input CLK,
      input [3:0] KEY,
      output reg [1:0] state,
      output reg [6:0] HEX0,
      output [7:0] LEDR
    );
      assign LEDR[3:0] = {2'b00, state};
      assign LEDR[7:4] = 4'hA;

      always @(posedge CLK or negedge KEY[0]) begin
        if (!KEY[0])
          state <= 2'd0;
        else
          state <= state + 2'd1;
      end

      always @(*) begin
        case (state)
          2'd0: HEX0 = 7'b1000000;
          2'd1: HEX0 = 7'b1111001;
          2'd2: HEX0 = 7'b0100100;
          default: HEX0 = 7'b0110000;
        endcase
      end
    endmodule
  `;
  const ast = parse(bcdSegHdl);
  const report = synthesize(ast);
  assert.equal(report.errors.length, 0, 'Disjoint LEDR slices should not trigger MULTI_DRIVEN_NET');
  assert.equal(report.warnings.length, 0);
  assert.equal(report.ffs, 2);

  const sim = createSimulator(ast);
  assert.equal(sim.getClockPort(), 'CLK');
  sim.setInput('KEY', 0b1111);
  sim.setInput('KEY', 0b1110);
  sim.setInput('KEY', 0b1111);

  assert.equal(sim.getSignal('HEX0').val, 0b1000000n);
  assert.equal(sim.getSignal('LEDR').val, 0xA0n);

  sim.stepClock();
  assert.equal(sim.getSignal('state').val, 1n);
  assert.equal(sim.getSignal('HEX0').val, 0b1111001n);
  assert.equal(sim.getSignal('LEDR').val, 0xA1n);

  // Also check INFERRED_LATCH on case without default
  const caseLatchHdl = `
    module case_latch(input [1:0] s, output reg y);
      always @(*) begin
        case (s)
          2'd0: y = 1'b1;
          2'd1: y = 1'b0;
        endcase
      end
    endmodule
  `;
  const caseRep = synthesize(caseLatchHdl);
  assert.ok(caseRep.warnings.some((w) => w.code === 'INFERRED_LATCH' && w.signal === 'y'));
});

// ============================================================================
// Phase 4: All Built-in Presets & Waveform Ring Buffer Tests
// ============================================================================

test('Phase 4 Presets: all 4 presets compile cleanly with 0 errors, 0 warnings, expected FFs/LUTs, and run 12+ cycles', () => {
  assert.equal(PRESETS.length, 4);
  const expectedIds = ['bcd_counter', 'full_adder_4bit', 'led_chaser', 'traffic_light_fsm'];
  assert.deepEqual(PRESETS.map((p) => p.id), expectedIds);

  const expectedFfs = {
    bcd_counter: 8,
    full_adder_4bit: 0,
    led_chaser: 18,
    traffic_light_fsm: 6,
  };

  for (const preset of PRESETS) {
    assert.ok(preset.title?.en && preset.title?.vi, `Preset ${preset.id} missing bilingual title`);
    assert.ok(preset.description?.en && preset.description?.vi, `Preset ${preset.id} missing bilingual description`);

    const ast = parse(preset.code);
    const report = synthesize(ast);

    assert.equal(report.errors.length, 0, `${preset.id} had DRC errors: ${JSON.stringify(report.errors)}`);
    assert.equal(report.warnings.length, 0, `${preset.id} had DRC warnings: ${JSON.stringify(report.warnings)}`);
    assert.equal(report.ffs, expectedFfs[preset.id], `${preset.id} FF count mismatch`);
    assert.ok(report.luts > 0, `${preset.id} expected > 0 LUTs`);

    const sim = createSimulator(ast);
    if (ast.signals.SW) sim.setInput('SW', 0);
    if (ast.signals.KEY) {
      // Pulse async Active-Low reset on KEY[0] (1 -> 0 -> 1)
      sim.setInput('KEY', 0b1111);
      sim.setInput('KEY', 0b1110);
      sim.setInput('KEY', 0b1111);
    }

    for (let c = 0; c < 12; c++) {
      sim.stepClock();
      assert.equal(sim.halted, false, `${preset.id} halted unexpectedly at cycle ${c}`);
    }
    assert.equal(sim.cycle, 12);
  }
});

test('Phase 4 Preset 1 (bcd_counter): counts 00 -> 09 -> 10 with Active-Low HEX0/HEX1 and SW[0] pause', () => {
  const preset = getPresetById('bcd_counter');
  const sim = createSimulator(preset.code);

  // Release then pulse KEY[0] active-low reset -> 00
  sim.setInput('SW', 0);
  sim.setInput('KEY', 0b1111);
  sim.setInput('KEY', 0b1110);
  sim.setInput('KEY', 0b1111);

  assert.equal(sim.getSignal('ones').val, 0n);
  assert.equal(sim.getSignal('tens').val, 0n);
  assert.equal(sim.getSignal('LEDR').val, 0x00n);
  assert.equal(sim.getSignal('HEX0').val, 0b1000000n); // '0' Active-Low
  assert.equal(sim.getSignal('HEX1').val, 0b1000000n); // '0' Active-Low

  // Advance 9 cycles -> 09
  for (let i = 1; i <= 9; i++) {
    sim.stepClock();
    assert.equal(sim.getSignal('ones').val, BigInt(i));
    assert.equal(sim.getSignal('tens').val, 0n);
    assert.equal(sim.getSignal('LEDR').val, BigInt(i));
  }
  assert.equal(sim.getSignal('HEX0').val, 0b0010000n); // '9' Active-Low

  // 10th cycle -> rolls over from 09 to 10
  sim.stepClock();
  assert.equal(sim.getSignal('ones').val, 0n);
  assert.equal(sim.getSignal('tens').val, 1n);
  assert.equal(sim.getSignal('LEDR').val, 0x10n);
  assert.equal(sim.getSignal('HEX0').val, 0b1000000n); // '0'
  assert.equal(sim.getSignal('HEX1').val, 0b1111001n); // '1'

  // Pause when SW[0] = 1
  sim.setInput('SW', 1);
  sim.stepClock();
  assert.equal(sim.getSignal('LEDR').val, 0x10n);
});

test('Phase 4 Presets 2, 3, 4: functional checks for full_adder_4bit, led_chaser, and traffic_light_fsm', () => {
  // Preset 2: full_adder_4bit
  const adder = createSimulator(getPresetById('full_adder_4bit').code);
  adder.setInput('SW', (0x1 << 4) | 0xF); // 15 + 1 = 16 -> sum=0, carry=1
  assert.equal(adder.getSignal('LEDR').val, 0n);
  assert.equal(adder.getSignal('LEDG').val, 1n);

  // Preset 3: led_chaser bidirectional rotation
  const chaser = createSimulator(getPresetById('led_chaser').code);
  chaser.setInput('SW', 0); // shift left, unpaused
  chaser.setInput('KEY', 0b1111);
  chaser.setInput('KEY', 0b1110);
  chaser.setInput('KEY', 0b1111);
  assert.equal(chaser.getSignal('LEDR').val, 1n);
  chaser.stepClock();
  chaser.stepClock();
  chaser.stepClock();
  assert.equal(chaser.getSignal('LEDR').val, 8n); // 1 << 3
  chaser.setInput('SW', 0b10); // SW[1]=1 -> shift right
  chaser.stepClock();
  chaser.stepClock();
  chaser.stepClock();
  assert.equal(chaser.getSignal('LEDR').val, 1n);
  chaser.stepClock(); // wrap around to bit 17
  assert.equal(chaser.getSignal('LEDR').val, 1n << 17n);

  // Preset 4: traffic_light_fsm state transitions GREEN (4) -> YELLOW (2) -> RED (4) -> GREEN
  const fsm = createSimulator(getPresetById('traffic_light_fsm').code);
  fsm.setInput('SW', 0);
  fsm.setInput('KEY', 0b1111);
  fsm.setInput('KEY', 0b1110);
  fsm.setInput('KEY', 0b1111);
  assert.equal(fsm.getSignal('state').val, 0n); // S_GREEN
  assert.equal(fsm.getSignal('LEDG').val, 0xFn);

  for (let i = 0; i < 4; i++) fsm.stepClock();
  assert.equal(fsm.getSignal('state').val, 1n); // S_YELLOW
  assert.equal(fsm.getSignal('LEDR').val, 0xFn);
  assert.equal(fsm.getSignal('LEDG').val, 0n);

  for (let i = 0; i < 2; i++) fsm.stepClock();
  assert.equal(fsm.getSignal('state').val, 2n); // S_RED
  assert.equal(fsm.getSignal('LEDR').val, 0x3C000n);

  for (let i = 0; i < 4; i++) fsm.stepClock();
  assert.equal(fsm.getSignal('state').val, 0n); // Back to S_GREEN
});

test('Phase 4 WaveformViewer: circular ring buffer stores 1,000 samples and wraps cleanly', () => {
  const viewer = new WaveformViewer(null, RING_BUFFER_CAPACITY);
  assert.equal(viewer.capacity, 1000);

  for (let i = 0; i < 1250; i++) {
    viewer.pushSample({
      cycle: Math.floor(i / 2),
      phase: i % 2 === 0 ? 'posedge' : 'negedge',
      signals: {
        CLOCK_50: createLogic4(1, BigInt(i % 2)),
        count: createLogic4(4, BigInt(i % 16)),
      },
    });
  }

  assert.equal(viewer.getSampleCount(), 1000);
  assert.equal(viewer.getSample(0).index, 250);
  assert.equal(viewer.getSample(999).index, 1249);
  assert.equal(viewer.getSample(1000), null);

  viewer.clear();
  assert.equal(viewer.getSampleCount(), 0);
});

// ============================================================================
// Bundler Sanity Check
// ============================================================================

test('Bundler: stripModuleSyntax strips ES module syntax while preserving strings & comments', () => {
  const sample = `
// Comment mentioning import x from 'y' and export const z = 1;
import a from './a.js';
import {
  b,
  c,
} from './bc.js';
export const msg = "import fake from 'x'; export default 1;";
export const tpl = \`
export const insideTemplate = 1;
import alsoInside from 'tpl';
\`;
export default function run() { return msg; }
export { msg, tpl };
`;
  const stripped = stripModuleSyntax(sample);
  assert.ok(stripped.includes("// Comment mentioning import x from 'y'"));
  assert.ok(stripped.includes(`const msg = "import fake from 'x'; export default 1;";`));
  assert.ok(!/^\s*import\s+a\b/m.test(stripped));
  assert.ok(!/^\s*export\s*\{/m.test(stripped));
  assert.doesNotThrow(() => new Function(stripped));
});
