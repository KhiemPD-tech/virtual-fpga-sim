import test from 'node:test';
import assert from 'node:assert/strict';

import { parse, parseProgram, elaborate } from '../src/engine/parser.js';
import { createSimulator, createLogic4, makeAllX, makeAllZ } from '../src/engine/simulator.js';
import { synthesize, selectTopModule, isTestbenchModule } from '../src/engine/synthesizer.js';

// ============================================================================
// Test 1: Structural 1-bit & 4-bit Full Adder (Primitive Gates) + 4-State Truth Tables
// ============================================================================

test('v4.0-A Test 1: Structural 1-bit & 4-bit Full Adder (xor/and/or primitives) & 4-state controlling values', () => {
  const fa1Hdl = `
    module full_adder_gate (
      input  wire a,
      input  wire b,
      input  wire cin,
      output wire sum,
      output wire cout
    );
      wire p, g, c1;
      xor u1 (p, a, b);
      xor u2 (sum, p, cin);
      and u3 (g, a, b);
      and u4 (c1, p, cin);
      or  u5 (cout, g, c1);
    endmodule
  `;

  // 1a. Exhaustive 8-row truth table for structural 1-bit Full Adder
  const sim1 = createSimulator(fa1Hdl);
  for (let a = 0; a <= 1; a++) {
    for (let b = 0; b <= 1; b++) {
      for (let cin = 0; cin <= 1; cin++) {
        sim1.setInput('a', a);
        sim1.setInput('b', b);
        sim1.setInput('cin', cin);
        const expected = a + b + cin;
        assert.equal(sim1.getSignal('sum').val, BigInt(expected & 1), `sum mismatch for ${a}+${b}+${cin}`);
        assert.equal(sim1.getSignal('sum').xMask, 0n);
        assert.equal(sim1.getSignal('cout').val, BigInt((expected >> 1) & 1), `cout mismatch for ${a}+${b}+${cin}`);
        assert.equal(sim1.getSignal('cout').xMask, 0n);
      }
    }
  }

  const rep1 = synthesize(fa1Hdl);
  assert.equal(rep1.errors.length, 0, `Unexpected DRC errors: ${JSON.stringify(rep1.errors)}`);
  assert.equal(rep1.warnings.length, 0, `Unexpected DRC warnings: ${JSON.stringify(rep1.warnings)}`);
  assert.equal(rep1.ffs, 0);
  assert.equal(rep1.luts, 5);
  assert.equal(rep1.hierarchy.children.length, 5);
  assert.equal(rep1.hierarchy.children[0].isPrimitive, true);
  assert.equal(rep1.hierarchy.children[0].moduleName, 'xor');
  assert.equal(rep1.logicDepth, 3); // a,b -> p(1) -> c1(2) -> cout(3)

  // 1b. Structural 4-bit Ripple-Carry Adder built from 4 gate-level full adders
  const rca4Hdl = `
    ${fa1Hdl}
    module rca4_gate (
      input  wire [3:0] a,
      input  wire [3:0] b,
      input  wire       cin,
      output wire [3:0] sum,
      output wire       cout
    );
      wire [4:0] c;
      assign c[0] = cin;
      full_adder_gate fa0 (.a(a[0]), .b(b[0]), .cin(c[0]), .sum(sum[0]), .cout(c[1]));
      full_adder_gate fa1 (.a(a[1]), .b(b[1]), .cin(c[1]), .sum(sum[1]), .cout(c[2]));
      full_adder_gate fa2 (.a(a[2]), .b(b[2]), .cin(c[2]), .sum(sum[2]), .cout(c[3]));
      full_adder_gate fa3 (.a(a[3]), .b(b[3]), .cin(c[3]), .sum(sum[3]), .cout(c[4]));
      assign cout = c[4];
    endmodule
  `;

  const sim4 = createSimulator(rca4Hdl);
  const vectors = [
    [0, 0, 0],
    [5, 7, 0],
    [15, 1, 0],
    [15, 15, 1],
    [9, 6, 1],
  ];
  for (const [a, b, cin] of vectors) {
    sim4.setInput('a', a);
    sim4.setInput('b', b);
    sim4.setInput('cin', cin);
    const total = a + b + cin;
    assert.equal(sim4.getSignal('sum').val, BigInt(total & 0xF));
    assert.equal(sim4.getSignal('cout').val, BigInt((total >> 4) & 1));
  }

  const rep4 = synthesize(rca4Hdl);
  assert.equal(rep4.errors.length, 0, `RCA4 must have zero false comb-loop errors: ${JSON.stringify(rep4.errors)}`);
  assert.equal(rep4.warnings.length, 0);
  assert.equal(rep4.luts, 20); // 4 x 5 primitive gates
  assert.equal(rep4.hierarchy.children.length, 4);
  assert.ok(
    rep4.logicDepth > rep1.logicDepth,
    `4-bit RCA depth (${rep4.logicDepth}) must exceed 1-bit FA depth (${rep1.logicDepth})`
  );

  // 1c. All 8 primitive gates 4-state controlling values (0 & X == 0, 1 | X == 1, Z -> X) + === / !==
  const gates4StateHdl = `
    module gate_4state (
      input  wire a,
      input  wire b,
      input  wire c,
      output wire y_and,
      output wire y_nand,
      output wire y_or,
      output wire y_nor,
      output wire y_xor,
      output wire y_xnor,
      output wire y_not,
      output wire y_buf,
      output wire eq_case,
      output wire neq_case
    );
      and  (y_and,  a, b);
      nand (y_nand, a, b, c);
      or   (y_or,   a, b);
      nor  (y_nor,  a, b);
      xor  (y_xor,  a, b);
      xnor (y_xnor, a, b);
      not  (y_not,  a);
      buf  (y_buf,  a);
      assign eq_case  = (a === b);
      assign neq_case = (a !== b);
    endmodule
  `;
  const gSim = createSimulator(gates4StateHdl);

  // a = 0, b = X, c = 1 -> 0 & X == 0, ~(0 & X & 1) == 1, 0 | X == X, ~(0 | X) == X
  gSim.setInput('a', createLogic4(1, 0n));
  gSim.setInput('b', makeAllX(1));
  gSim.setInput('c', createLogic4(1, 1n));
  assert.equal(gSim.getSignal('y_and').val, 0n);
  assert.equal(gSim.getSignal('y_and').xMask, 0n);
  assert.equal(gSim.getSignal('y_nand').val, 1n);
  assert.equal(gSim.getSignal('y_nand').xMask, 0n);
  assert.equal(gSim.getSignal('y_or').xMask, 1n);
  assert.equal(gSim.getSignal('y_nor').xMask, 1n);
  assert.equal(gSim.getSignal('y_xor').xMask, 1n);
  assert.equal(gSim.getSignal('y_xnor').xMask, 1n);
  assert.equal(gSim.getSignal('y_not').val, 1n);
  assert.equal(gSim.getSignal('y_buf').val, 0n);
  assert.equal(gSim.getSignal('eq_case').val, 0n);
  assert.equal(gSim.getSignal('eq_case').xMask, 0n);
  assert.equal(gSim.getSignal('neq_case').val, 1n);
  assert.equal(gSim.getSignal('neq_case').xMask, 0n);

  // a = 1, b = X -> 1 | X == 1, ~(1 | X) == 0, 1 & X == X
  gSim.setInput('a', createLogic4(1, 1n));
  assert.equal(gSim.getSignal('y_or').val, 1n);
  assert.equal(gSim.getSignal('y_or').xMask, 0n);
  assert.equal(gSim.getSignal('y_nor').val, 0n);
  assert.equal(gSim.getSignal('y_nor').xMask, 0n);
  assert.equal(gSim.getSignal('y_and').xMask, 1n);

  // a = Z, b = Z -> gate inputs treat Z as X (buf(Z)==X, not(Z)==X), while Z === Z is known 1!
  gSim.setInput('a', makeAllZ(1));
  gSim.setInput('b', makeAllZ(1));
  assert.equal(gSim.getSignal('y_buf').xMask, 1n);
  assert.equal(gSim.getSignal('y_buf').zMask, 0n);
  assert.equal(gSim.getSignal('y_not').xMask, 1n);
  assert.equal(gSim.getSignal('y_not').zMask, 0n);
  assert.equal(gSim.getSignal('eq_case').val, 1n);
  assert.equal(gSim.getSignal('eq_case').xMask, 0n);
  assert.equal(gSim.getSignal('neq_case').val, 0n);
});

// ============================================================================
// Test 2: PH002 Lab 5 Asynchronous 4-bit Ripple Counter (`always @(negedge q[0])`)
// ============================================================================

test('v4.0-A Test 2: PH002 Lab 5 Async 4-bit Ripple Counter counts 0..15 -> 0 via cascaded internal edges', () => {
  const ripple4Hdl = `
    module async_ripple_counter_4bit (
      input  logic       clk,
      input  logic       rst_n,
      output logic [3:0] q
    );
      always_ff @(negedge clk or negedge rst_n) begin
        if (!rst_n) q[0] <= 1'b0;
        else        q[0] <= ~q[0];
      end

      always_ff @(negedge q[0] or negedge rst_n) begin
        if (!rst_n) q[1] <= 1'b0;
        else        q[1] <= ~q[1];
      end

      always_ff @(negedge q[1] or negedge rst_n) begin
        if (!rst_n) q[2] <= 1'b0;
        else        q[2] <= ~q[2];
      end

      always_ff @(negedge q[2] or negedge rst_n) begin
        if (!rst_n) q[3] <= 1'b0;
        else        q[3] <= ~q[3];
      end
    endmodule
  `;

  const rep = synthesize(ripple4Hdl);
  assert.equal(rep.errors.length, 0, `Unexpected DRC errors: ${JSON.stringify(rep.errors)}`);
  assert.equal(rep.warnings.length, 0);
  assert.equal(rep.ffs, 4);

  const sim = createSimulator(ripple4Hdl);

  // Pulse async active-low reset: 1 -> 0 -> 1
  sim.setInput('rst_n', 1);
  sim.setInput('rst_n', 0);
  sim.setInput('rst_n', 1);
  assert.equal(sim.getSignal('q').val, 0n);
  assert.equal(sim.getSignal('q').xMask, 0n);

  // Step 16 clock cycles and verify exact 1..15 -> 0 sequence (including 7->8 and 15->0 cascades)
  for (let cycle = 1; cycle <= 16; cycle++) {
    sim.stepClock();
    const expected = BigInt(cycle % 16);
    const actual = sim.getSignal('q');
    assert.equal(actual.xMask, 0n, `Unexpected X at cycle ${cycle}`);
    assert.equal(actual.val, expected, `Ripple counter mismatch at cycle ${cycle}: got ${actual.val}, expected ${expected}`);
  }

  // Also test 8-bit ripple counter constructed with generate-for to verify deep cascade (> 4 stages)
  const ripple8Hdl = `
    module async_ripple_8 (
      input  logic       clk,
      input  logic       rst_n,
      output logic [7:0] q
    );
      genvar i;
      always_ff @(negedge clk or negedge rst_n) begin
        if (!rst_n) q[0] <= 1'b0;
        else        q[0] <= ~q[0];
      end
      generate
        for (i = 1; i < 8; i = i + 1) begin : stage
          always_ff @(negedge q[i-1] or negedge rst_n) begin
            if (!rst_n) q[i] <= 1'b0;
            else        q[i] <= ~q[i];
          end
        end
      endgenerate
    endmodule
  `;
  const sim8 = createSimulator(ripple8Hdl);
  sim8.setInput('rst_n', 1);
  sim8.setInput('rst_n', 0);
  sim8.setInput('rst_n', 1);
  sim8.stepCycles(128, 500);
  assert.equal(sim8.getSignal('q').val, 128n); // 0111_1111 -> 1000_0000 8-stage ripple cascade
});

// ============================================================================
// Test 3: `function ... endfunction` + `generate for` Parameterized Ripple-Carry Adder
// ============================================================================

test('v4.0-A Test 3: function + generate for parameterized Ripple-Carry Adder elaborates & computes accurately', () => {
  const genFuncRcaHdl = `
    module param_rca #(
      parameter N = 8
    ) (
      input  logic [N-1:0] a,
      input  logic [N-1:0] b,
      input  logic         cin,
      output logic [N-1:0] sum,
      output logic         cout,
      output logic [3:0]   ones_cnt
    );
      // ANSI-style combinational function computing 1-bit full adder {cout, sum}
      function [1:0] fa_cell(input x, input y, input ci);
        reg s_bit;
        reg c_bit;
        begin
          s_bit = x ^ y ^ ci;
          c_bit = (x & y) | (ci & (x ^ y));
          fa_cell = {c_bit, s_bit};
        end
      endfunction

      // Classic Verilog-1995 style function with static for loop & integer counter
      function [3:0] popcount8;
        input [7:0] vec;
        integer k;
        reg [3:0] acc;
        begin
          acc = 4'd0;
          for (k = 0; k < 8; k = k + 1) begin
            acc = acc + {3'd0, vec[k]};
          end
          popcount8 = acc;
        end
      endfunction

      wire [N:0] carry;
      assign carry[0] = cin;

      genvar i;
      generate
        for (i = 0; i < N; i = i + 1) begin : bit_slice
          wire [1:0] res;
          assign res = fa_cell(a[i], b[i], carry[i]);
          assign sum[i] = res[0];
          assign carry[i + 1] = res[1];
        end
      endgenerate

      assign cout = carry[N];
      assign ones_cnt = popcount8(sum);
    endmodule

    module top_gen_rca (
      input  logic [7:0] op_a,
      input  logic [7:0] op_b,
      input  logic       op_cin,
      output logic [7:0] out_sum,
      output logic       out_cout,
      output logic [3:0] out_ones
    );
      param_rca #(.N(8)) u_rca8 (
        .a(op_a),
        .b(op_b),
        .cin(op_cin),
        .sum(out_sum),
        .cout(out_cout),
        .ones_cnt(out_ones)
      );
    endmodule
  `;

  const rep = synthesize(genFuncRcaHdl);
  assert.equal(rep.errors.length, 0, `Unexpected DRC errors: ${JSON.stringify(rep.errors)}`);
  assert.equal(rep.warnings.length, 0, `Unexpected DRC warnings: ${JSON.stringify(rep.warnings)}`);
  assert.equal(rep.ffs, 0);
  assert.ok(rep.luts > 16, `Expected >16 LUTs for 8-bit RCA + popcount, got ${rep.luts}`);
  assert.ok(rep.logicDepth >= 8, `Expected >=8 logic depth for 8-bit ripple chain, got ${rep.logicDepth}`);

  const sim = createSimulator(genFuncRcaHdl);
  const cases = [
    [0x00, 0x00, 0, 0x00, 0, 0],
    [0x55, 0xAA, 0, 0xFF, 0, 8],
    [0x55, 0xAA, 1, 0x00, 1, 0],
    [0x37, 0x1E, 0, 0x55, 0, 4], // 0x55 = 0101_0101 -> 4 ones
    [0xFF, 0xFF, 1, 0xFF, 1, 8],
  ];

  for (const [a, b, cin, expSum, expCout, expOnes] of cases) {
    sim.setInput('op_a', a);
    sim.setInput('op_b', b);
    sim.setInput('op_cin', cin);
    assert.equal(sim.getSignal('out_sum').val, BigInt(expSum));
    assert.equal(sim.getSignal('out_cout').val, BigInt(expCout));
    assert.equal(sim.getSignal('out_ones').val, BigInt(expOnes));
  }
});

// ============================================================================
// Test 4: Hierarchical Register File + ALU + Critical Path Latency + selectTopModule
// ============================================================================

test('v4.0-A Test 4: Hierarchical RegFile (async read/sync write) + ALU + Critical Path & selectTopModule', () => {
  const sharedSubmodules = `
    module reg_file_8x8 (
      input  logic       clk,
      input  logic       we,
      input  logic [2:0] waddr,
      input  logic [7:0] wdata,
      input  logic [2:0] raddr1,
      input  logic [2:0] raddr2,
      output logic [7:0] rdata1,
      output logic [7:0] rdata2
    );
      reg [7:0] regs [0:7];

      // Asynchronous combinational dual-port read
      assign rdata1 = regs[raddr1];
      assign rdata2 = regs[raddr2];

      // Synchronous single-port write
      always_ff @(posedge clk) begin
        if (we) begin
          regs[waddr] <= wdata;
        end
      end
    endmodule

    module alu_8bit (
      input  logic [7:0] a,
      input  logic [7:0] b,
      input  logic [1:0] op,
      output logic [7:0] y
    );
      always_comb begin
        case (op)
          2'd0: y = a + b;
          2'd1: y = a - b;
          2'd2: y = a & b;
          default: y = a ^ b;
        endcase
      end
    endmodule
  `;

  // Deep combinational datapath: RegFile -> ALU1 -> ALU2 -> ALU3 -> Output (no pipeline FFs between ALUs)
  const combChainHdl = `
    ${sharedSubmodules}
    module datapath_comb (
      input  logic       clk,
      input  logic       we,
      input  logic [2:0] waddr,
      input  logic [7:0] wdata,
      input  logic [2:0] raddr1,
      input  logic [2:0] raddr2,
      input  logic [1:0] op,
      output logic [7:0] result
    );
      wire [7:0] rf_a, rf_b;
      wire [7:0] s1, s2, s3;

      reg_file_8x8 u_rf (
        .clk(clk), .we(we), .waddr(waddr), .wdata(wdata),
        .raddr1(raddr1), .raddr2(raddr2), .rdata1(rf_a), .rdata2(rf_b)
      );

      alu_8bit u_alu1 (.a(rf_a), .b(rf_b), .op(op), .y(s1));
      alu_8bit u_alu2 (.a(s1),   .b(rf_b), .op(op), .y(s2));
      alu_8bit u_alu3 (.a(s2),   .b(rf_a), .op(op), .y(s3));

      assign result = s3;
    endmodule
  `;

  // Pipelined datapath: breaks the 3-ALU chain with Flip-Flop pipeline stages between each ALU
  const pipelinedHdl = `
    ${sharedSubmodules}
    module datapath_pipe (
      input  logic       clk,
      input  logic       we,
      input  logic [2:0] waddr,
      input  logic [7:0] wdata,
      input  logic [2:0] raddr1,
      input  logic [2:0] raddr2,
      input  logic [1:0] op,
      output logic [7:0] result
    );
      wire [7:0] rf_a, rf_b;
      wire [7:0] s1, s2, s3;
      logic [7:0] r1, r2, r_a1, r_b1;

      reg_file_8x8 u_rf (
        .clk(clk), .we(we), .waddr(waddr), .wdata(wdata),
        .raddr1(raddr1), .raddr2(raddr2), .rdata1(rf_a), .rdata2(rf_b)
      );

      alu_8bit u_alu1 (.a(rf_a), .b(rf_b), .op(op), .y(s1));
      always_ff @(posedge clk) begin
        r1   <= s1;
        r_a1 <= rf_a;
        r_b1 <= rf_b;
      end

      alu_8bit u_alu2 (.a(r1), .b(r_b1), .op(op), .y(s2));
      always_ff @(posedge clk) begin
        r2 <= s2;
      end

      alu_8bit u_alu3 (.a(r2), .b(r_a1), .op(op), .y(s3));
      always_ff @(posedge clk) begin
        result <= s3;
      end
    endmodule
  `;

  // 4a. Functional check: child Register File sync write + immediate async read into ALU chain
  const sim = createSimulator(combChainHdl);
  sim.setInput('op', 0); // ADD: s1 = a+b, s2 = a+2b, s3 = 2a+2b

  // Sync write regs[1] = 10, regs[2] = 5
  sim.setInput('we', 1);
  sim.setInput('waddr', 1);
  sim.setInput('wdata', 10);
  sim.stepClock();

  sim.setInput('waddr', 2);
  sim.setInput('wdata', 5);
  sim.stepClock();

  sim.setInput('we', 0);

  // Asynchronous read without stepping clock: raddr1=1 (10), raddr2=2 (5) -> s1=15, s2=20, s3=30
  sim.setInput('raddr1', 1);
  sim.setInput('raddr2', 2);
  assert.equal(sim.getSignal('u_rf.rdata1').val, 10n);
  assert.equal(sim.getSignal('u_rf.rdata2').val, 5n);
  assert.equal(sim.getSignal('s1').val, 15n);
  assert.equal(sim.getSignal('result').val, 30n);

  // Switch read address asynchronously to raddr2=1 (10) -> s1=20, s2=30, s3=40 immediately (no clock)
  sim.setInput('raddr2', 1);
  assert.equal(sim.getSignal('result').val, 40n);

  // 4b. Hierarchy tree sums & Cost vs. Latency comparison
  const repComb = synthesize(combChainHdl);
  const repPipe = synthesize(pipelinedHdl);

  assert.equal(repComb.errors.length, 0);
  assert.equal(repComb.warnings.length, 0);
  assert.equal(repPipe.errors.length, 0);
  assert.equal(repPipe.warnings.length, 0);

  // Verify hierarchy tree invariant: parent total === self + sum(children)
  const checkTreeSums = (node) => {
    const childLuts = node.children.reduce((acc, c) => acc + c.luts, 0);
    const childFfs = node.children.reduce((acc, c) => acc + c.ffs, 0);
    const childMem = node.children.reduce((acc, c) => acc + c.memBits, 0);
    assert.equal(node.luts, node.selfLuts + childLuts, `LUT sum mismatch at ${node.instanceName}`);
    assert.equal(node.ffs, node.selfFfs + childFfs, `FF sum mismatch at ${node.instanceName}`);
    assert.equal(node.memBits, node.selfMemBits + childMem, `memBits sum mismatch at ${node.instanceName}`);
    for (const c of node.children) checkTreeSums(c);
  };
  checkTreeSums(repComb.hierarchy);
  checkTreeSums(repPipe.hierarchy);

  // Register File memory bits = 8 x 8 = 64 bits (and 0 FFs!)
  const rfNode = repComb.hierarchy.children.find((c) => c.instanceName === 'u_rf');
  assert.ok(rfNode, 'Expected u_rf child node in hierarchy tree');
  assert.equal(rfNode.moduleName, 'reg_file_8x8');
  assert.equal(rfNode.memBits, 64);
  assert.equal(rfNode.ffs, 0);
  assert.equal(repComb.memBits, 64);
  assert.equal(repComb.ffs, 0);
  assert.equal(repPipe.ffs, 40); // r1, r2, r_a1, r_b1, result = 5 x 8-bit registers

  // Critical path latency: pipelined version MUST have strictly lower logicDepth & estimatedDelayNs!
  assert.ok(
    repPipe.logicDepth < repComb.logicDepth,
    `Expected pipelined logicDepth (${repPipe.logicDepth}) < comb-chain logicDepth (${repComb.logicDepth})`
  );
  assert.ok(
    repPipe.estimatedDelayNs < repComb.estimatedDelayNs,
    `Expected pipelined delay (${repPipe.estimatedDelayNs} ns) < comb-chain delay (${repComb.estimatedDelayNs} ns)`
  );
  assert.ok(repComb.criticalPathSignals.length > 0);

  // 4c. Smart Top-Module Selector (`selectTopModule`) + Phase 2 Testbench AST Parsing Hooks
  const withTbHdl = `
    ${combChainHdl}
    module tb_datapath;
      reg clk;
      reg we;
      reg [2:0] waddr, raddr1, raddr2;
      reg [7:0] wdata;
      reg [1:0] op;
      wire [7:0] result;

      datapath_comb dut (
        .clk(clk), .we(we), .waddr(waddr), .wdata(wdata),
        .raddr1(raddr1), .raddr2(raddr2), .op(op), .result(result)
      );

      always #5 clk = ~clk;

      initial begin
        clk = 0;
        we = 1;
        waddr = 3'd1;
        wdata = 8'h12;
        @(posedge clk);
        repeat (2) @(posedge clk);
        #10;
        $display("t=%0t res=%h", $time, result);
        $finish;
      end
    endmodule
  `;

  const prog = parseProgram(withTbHdl);
  const boardTop = selectTopModule(prog, 'board');
  const tbTop = selectTopModule(prog, 'testbench');

  assert.equal(boardTop.name, 'datapath_comb');
  assert.equal(isTestbenchModule(boardTop), false);
  assert.equal(tbTop.name, 'tb_datapath');
  assert.equal(isTestbenchModule(tbTop), true);
  assert.equal(selectTopModule(combChainHdl, 'testbench'), null);

  // Verify Phase 2 testbench AST nodes parsed cleanly inside tb_datapath
  assert.equal(tbTop.alwaysBlocks.length, 1);
  assert.equal(tbTop.alwaysBlocks[0].mode, 'tb');
  assert.equal(tbTop.alwaysBlocks[0].body.kind, 'Delay');
  assert.equal(tbTop.initialBlocks.length, 1);
  const initStmts = tbTop.initialBlocks[0].body.statements;
  assert.ok(initStmts.some((s) => s.kind === 'EventCtrl'));
  assert.ok(initStmts.some((s) => s.kind === 'RepeatStmt'));
  assert.ok(initStmts.some((s) => s.kind === 'Delay'));
  assert.ok(initStmts.some((s) => s.kind === 'SystemCall' && s.name === '$display'));
  assert.ok(initStmts.some((s) => s.kind === 'SystemCall' && s.name === '$finish'));

  // Board-mode synthesis on selectTopModule(prog, 'board') produces full DUT metrics cleanly
  const dutReport = synthesize(boardTop);
  assert.equal(dutReport.moduleName, 'datapath_comb');
  assert.equal(dutReport.memBits, 64);
  assert.equal(dutReport.errors.length, 0);
});
