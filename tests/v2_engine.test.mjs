import test from 'node:test';
import assert from 'node:assert/strict';

import { HdlError } from '../src/engine/lexer.js';
import { parse, parseProgram, elaborate } from '../src/engine/parser.js';
import { createSimulator, logic4ToString } from '../src/engine/simulator.js';
import { synthesize, EP2C35_TOTAL_LES } from '../src/engine/synthesizer.js';
import { EdgeBus } from '../src/engine/edge_bus.js';

// ============================================================================
// Test 1: Multi-Module Hierarchy with #(parameter) Overrides & Named/Positional Ports
// ============================================================================

test('v2.0 Hierarchy: multi-module top instantiating parameterized counters & adders with #(.WIDTH(...))', () => {
  const hdl = `
    module param_counter #(
      parameter WIDTH = 4,
      parameter STEP  = 1
    ) (
      input  logic             clk,
      input  logic             rst_n,
      input  logic             en,
      output logic [WIDTH-1:0] q
    );
      always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n)
          q <= '0;
        else if (en)
          q <= q + STEP;
      end
    endmodule

    module param_adder #(
      parameter WIDTH = 4
    ) (
      input  logic [WIDTH-1:0] a,
      input  logic [WIDTH-1:0] b,
      output logic [WIDTH:0]   sum
    );
      assign sum = a + b;
    endmodule

    module top_hier (
      input  logic       CLOCK_50,
      input  logic [3:0] KEY,
      input  logic [1:0] SW,
      output logic [3:0] cnt_lo,
      output logic [5:0] cnt_hi,
      output logic [4:0] sum_out
    );
      // Named parameter overrides & named port connections
      param_counter #(.WIDTH(4), .STEP(1)) u_cnt4 (
        .clk(CLOCK_50),
        .rst_n(KEY[0]),
        .en(SW[0]),
        .q(cnt_lo)
      );

      // Different parameter values on sibling instance verify isolated parameter propagation
      param_counter #(.WIDTH(6), .STEP(2)) u_cnt6 (
        .clk(CLOCK_50),
        .rst_n(KEY[0]),
        .en(SW[1]),
        .q(cnt_hi)
      );

      // Positional parameter override & positional port connection
      param_adder #(4) u_add (cnt_lo, cnt_hi[3:0], sum_out);
    endmodule
  `;

  // Auto-detects uninstantiated root module (`top_hier`) regardless of order
  const prog = parseProgram(hdl);
  assert.equal(prog.topModule.name, 'top_hier');
  assert.equal(prog.moduleList.length, 3);

  // Explicit topModule override works too
  const subOnly = parse(hdl, { topModule: 'param_adder' });
  assert.equal(subOnly.name, 'param_adder');

  // Elaboration flattens hierarchical signals with exact overridden widths
  const elab = elaborate(hdl);
  assert.equal(elab.signals['u_cnt4.q'].width, 4);
  assert.equal(elab.signals['u_cnt6.q'].width, 6);
  assert.equal(elab.signals['u_add.sum'].width, 5);

  // Simulation: async KEY[0] reset propagates into both child counters simultaneously
  const sim = createSimulator(hdl);
  sim.setInput('SW', 0b11); // Enable both counters
  sim.setInput('KEY', 0b1111);
  sim.setInput('KEY', 0b1110); // Active-low async reset pulse
  sim.setInput('KEY', 0b1111);

  assert.equal(sim.getSignal('cnt_lo').val, 0n);
  assert.equal(sim.getSignal('cnt_lo').xMask, 0n);
  assert.equal(sim.getSignal('cnt_hi').val, 0n);
  assert.equal(sim.getSignal('u_cnt4.q').val, 0n);
  assert.equal(sim.getSignal('u_cnt6.q').val, 0n);
  assert.equal(sim.getSignal('sum_out').val, 0n);

  // Step 5 cycles: u_cnt4 increments by 1 (-> 5), u_cnt6 increments by 2 (-> 10), u_add sums 5 + 10 = 15
  for (let i = 0; i < 5; i++) sim.stepClock();
  assert.equal(sim.getSignal('cnt_lo').val, 5n);
  assert.equal(sim.getSignal('u_cnt4.q').val, 5n);
  assert.equal(sim.getSignal('cnt_hi').val, 10n);
  assert.equal(sim.getSignal('u_cnt6.q').val, 10n);
  assert.equal(sim.getSignal('sum_out').val, 15n);

  // Step 12 more cycles (total 17): u_cnt4 wraps at 4 bits (17 % 16 = 1), u_cnt6 = 34 (low 4 bits = 2), sum = 3
  sim.stepCycles(12, 100);
  assert.equal(sim.getSignal('cnt_lo').val, 1n);
  assert.equal(sim.getSignal('cnt_hi').val, 34n);
  assert.equal(sim.getSignal('sum_out').val, 3n);

  // Synthesizer traverses child modules & supports configurable target FPGA device
  const ep2cReport = synthesize(hdl);
  assert.equal(ep2cReport.errors.length, 0);
  assert.equal(ep2cReport.warnings.length, 0);
  assert.equal(ep2cReport.device, 'Altera Cyclone II EP2C35');
  assert.equal(ep2cReport.totalLEs, EP2C35_TOTAL_LES);
  assert.equal(ep2cReport.ffs, 10); // 4-bit + 6-bit child registers
  assert.ok(ep2cReport.luts > 0);
  assert.equal(ep2cReport.hierarchy.children.length, 3);
  assert.equal(ep2cReport.hierarchy.children[0].instancePath, 'u_cnt4');
  assert.equal(ep2cReport.hierarchy.children[0].ffs, 4);
  assert.equal(ep2cReport.hierarchy.children[1].instancePath, 'u_cnt6');
  assert.equal(ep2cReport.hierarchy.children[1].ffs, 6);

  // Configurable target device (e.g., Artix-7 XC7A35T for Basys 3)
  const artixReport = synthesize(hdl, {
    device: { name: 'Xilinx Artix-7 XC7A35T', totalLEs: 33280, bramBits: 1843200 },
  });
  assert.equal(artixReport.device, 'Xilinx Artix-7 XC7A35T');
  assert.equal(artixReport.totalLEs, 33280);
  assert.equal(artixReport.totalBramBits, 1843200);
});

test('v2.0 Hierarchy: detects top-down module ordering, unknown modules, and recursive cycles', () => {
  // Top-down ordering (top defined BEFORE submodule)
  const topDownHdl = `
    module top_first(input [3:0] x, output [3:0] y);
      inv4 u0(.a(x), .b(y));
    endmodule

    module inv4(input [3:0] a, output [3:0] b);
      assign b = ~a;
    endmodule
  `;
  const sim = createSimulator(topDownHdl);
  assert.equal(sim.ast.name, 'top_first');
  sim.setInput('x', 0b1010);
  assert.equal(sim.getSignal('y').val, 0b0101n);

  // Recursive instantiation throws structured HdlError
  const recursiveHdl = `
    module a(input x, output y);
      b u0(.x(x), .y(y));
    endmodule
    module b(input x, output y);
      a u1(.x(x), .y(y));
    endmodule
  `;
  assert.throws(
    () => elaborate(recursiveHdl),
    (err) => err instanceof HdlError && err.code === 'RECURSIVE_INSTANTIATION'
  );
});

// ============================================================================
// Test 2: Unpacked 2D Memory Arrays, loadMemoryHex, X-Safety & Static For-Loop
// ============================================================================

test('v2.0 Memory Arrays: reg [7:0] ram [0:15], loadMemoryHex, sync read/write, X on uninitialized, and BRAM report', () => {
  const ramHdl = `
    module sync_ram_16x8 (
      input  logic       clk,
      input  logic       we,
      input  logic [3:0] addr,
      input  logic [7:0] wdata,
      output logic [7:0] rdata,
      output logic [7:0] comb_peek
    );
      reg [7:0] ram [0:15];

      // Asynchronous/combinational peek at current address
      assign comb_peek = ram[addr];

      // Synchronous read & write
      always_ff @(posedge clk) begin
        if (we) begin
          ram[addr] <= wdata;
        end
        rdata <= ram[addr];
      end
    endmodule
  `;

  const sim = createSimulator(ramHdl);

  // Verify memory introspection API
  const mems = sim.listMemories();
  assert.equal(mems.length, 1);
  assert.equal(mems[0].name, 'ram');
  assert.equal(mems[0].width, 8);
  assert.equal(mems[0].depth, 16);
  assert.equal(mems[0].totalBits, 128);

  // Uninitialized addresses start as all-X (xMask = 0xFFn)
  sim.setInput('addr', 5);
  assert.equal(sim.getSignal('comb_peek').xMask, 0xFFn);
  assert.equal(logic4ToString(sim.getMemoryWord('ram', 5), 'hex'), 'XX');

  // Load partial image with @addr directives, comments, underscores, and whitespace
  const hexImage = `
    // Initial RAM contents
    @00
    AA 55 0F_F0
    /* Sparse upper segment */
    @0A
    12
    34
  `;
  const loadInfo = sim.loadMemoryHex('ram', hexImage);
  assert.equal(loadInfo.loadedWords, 5);
  assert.equal(loadInfo.startAddr, 0);
  assert.equal(loadInfo.endAddr, 0x0B);

  const memSnap = sim.getMemory('ram');
  assert.equal(memSnap.read(0).val, 0xAAn);
  assert.equal(memSnap.read(1).val, 0x55n);
  assert.equal(memSnap.read(2).val, 0xF0n); // Masked to 8-bit width
  assert.equal(memSnap.read(0x0A).val, 0x12n);
  assert.equal(memSnap.read(0x0B).val, 0x34n);

  // Unloaded address 0x05 must STILL be X!
  assert.equal(memSnap.read(5).xMask, 0xFFn);
  assert.equal(sim.getSignal('comb_peek').xMask, 0xFFn);

  // Read loaded address 0x0A synchronously
  sim.setInput('we', 0);
  sim.setInput('addr', 0x0A);
  assert.equal(sim.getSignal('comb_peek').val, 0x12n);
  sim.stepClock();
  assert.equal(sim.getSignal('rdata').val, 0x12n);
  assert.equal(sim.getSignal('rdata').xMask, 0n);

  // Synchronous write to previously-X address 0x05
  sim.setInput('we', 1);
  sim.setInput('addr', 5);
  sim.setInput('wdata', 0xC3);
  sim.stepClock();

  assert.equal(sim.getMemoryWord('ram', 5).val, 0xC3n);
  assert.equal(sim.getMemoryWord('ram', 5).xMask, 0n);
  assert.equal(sim.getSignal('comb_peek').val, 0xC3n);

  // Next cycle readback of address 0x05 confirms synchronous read
  sim.setInput('we', 0);
  sim.stepClock();
  assert.equal(sim.getSignal('rdata').val, 0xC3n);

  // Uninitialized neighbor address 0x06 remains X
  assert.equal(sim.getMemoryWord('ram', 6).xMask, 0xFFn);

  // Synthesizer accounts for memoryBits (128 bits) separately from FFs (only rdata = 8 FFs)
  const report = synthesize(ramHdl);
  assert.equal(report.errors.length, 0);
  assert.equal(report.warnings.length, 0);
  assert.equal(report.ffs, 8); // rdata [7:0], NOT 128 FFs for ram
  assert.equal(report.memoryBits, 128);
  assert.equal(report.bramBlocks, 1);
});

test('v2.0 Static For-Loop Unrolling: clears unpacked 2D array on async reset', () => {
  const clearRamHdl = `
    module clearable_ram #(
      parameter DEPTH = 8
    ) (
      input  logic       clk,
      input  logic       rst_n,
      input  logic [2:0] addr,
      output logic [7:0] dout
    );
      reg [7:0] mem [0:DEPTH-1];
      integer i;

      always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
          for (i = 0; i < DEPTH; i = i + 1) begin
            mem[i] <= 8'h5A;
          end
        end
      end

      assign dout = mem[addr];
    endmodule
  `;

  const sim = createSimulator(clearRamHdl);
  // Before reset: X
  assert.equal(sim.getMemoryWord('mem', 3).xMask, 0xFFn);

  // Trigger async reset: unrolled for-loop initializes all 8 entries to 0x5A
  sim.setInput('rst_n', 1);
  sim.setInput('rst_n', 0);
  sim.setInput('rst_n', 1);

  for (let addr = 0; addr < 8; addr++) {
    assert.equal(sim.getMemoryWord('mem', addr).val, 0x5An);
    assert.equal(sim.getMemoryWord('mem', addr).xMask, 0n);
  }
  sim.setInput('addr', 6);
  assert.equal(sim.getSignal('dout').val, 0x5An);
});

// ============================================================================
// Test 3: Protocol Edge Bus — PWM Duty-Cycle (25% & 75%) & UART Bit Sampling
// ============================================================================

test('v2.0 EdgeBus: accurately measures 25% and 75% PWM duty cycle across 200 clock cycles', () => {
  const pwmHdl = `
    module pwm_gen (
      input  logic       clk,
      input  logic       rst_n,
      input  logic [7:0] duty_thresh,
      output logic       pwm_out
    );
      logic [7:0] cnt;

      always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
          cnt <= 8'd0;
          pwm_out <= 1'b0;
        end else begin
          if (cnt == 8'd99)
            cnt <= 8'd0;
          else
            cnt <= cnt + 8'd1;

          pwm_out <= (cnt < duty_thresh);
        end
      end
    endmodule
  `;

  const sim = createSimulator(pwmHdl);
  const edgeBus = sim.getEdgeBus();
  const pwmMon = edgeBus.createPwmMonitor('pwm_out');

  // --- Phase 1: 25% duty cycle (period = 100 cycles, high = 25, low = 75) ---
  sim.setInput('duty_thresh', 25);
  sim.setInput('rst_n', 1);
  sim.setInput('rst_n', 0);
  sim.setInput('rst_n', 1);
  pwmMon.reset();

  const batch25 = sim.stepCycles(200, 500);
  assert.equal(batch25.cyclesExecuted, 200);
  assert.equal(batch25.halted, false);
  assert.ok(batch25.events.length >= 4, `Expected >= 4 PWM edges over 200 cycles, got ${batch25.events.length}`);

  const m25 = pwmMon.getMetrics(100_000); // 100 kHz virtual clock -> 1 kHz PWM
  assert.equal(m25.valid, true);
  assert.equal(m25.highCycles, 25);
  assert.equal(m25.lowCycles, 75);
  assert.equal(m25.periodCycles, 100);
  assert.ok(Math.abs(m25.dutyCycle - 0.25) < 1e-6, `Expected 25% duty cycle, got ${m25.dutyPct}%`);
  assert.equal(m25.frequencyHz, 1000);

  // --- Phase 2: 75% duty cycle (period = 100 cycles, high = 75, low = 25) ---
  sim.setInput('duty_thresh', 75);
  sim.setInput('rst_n', 0);
  sim.setInput('rst_n', 1);
  pwmMon.reset();

  const batch75 = sim.stepCycles(200, 500);
  assert.equal(batch75.cyclesExecuted, 200);

  const m75 = pwmMon.getMetrics(100_000);
  assert.equal(m75.valid, true);
  assert.equal(m75.highCycles, 75);
  assert.equal(m75.lowCycles, 25);
  assert.equal(m75.periodCycles, 100);
  assert.ok(Math.abs(m75.dutyCycle - 0.75) < 1e-6, `Expected 75% duty cycle, got ${m75.dutyPct}%`);
  assert.equal(m75.frequencyHz, 1000);

  // Disposing monitor leaves zero watchers (restores zero-overhead fast path)
  pwmMon.dispose();
  assert.equal(edgeBus.hasWatchers(), false);
});

test('v2.0 EdgeBus: async UART 8N1 bit sampler decodes transmitted byte cleanly', () => {
  // Simple 8N1 UART transmitter sending 0x53 ('S') at 4 cycles per bit
  const uartTxHdl = `
    module mini_uart_tx (
      input  logic clk,
      input  logic rst_n,
      input  logic start,
      output logic tx
    );
      // Frame LSB-first: {stop=1, data=8'h53 (0101_0011), start=0}
      logic [9:0] shift_reg;
      logic [3:0] bit_cnt;
      logic [1:0] baud_cnt;
      logic       busy;

      always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
          tx <= 1'b1;
          busy <= 1'b0;
          bit_cnt <= 4'd0;
          baud_cnt <= 2'd0;
          shift_reg <= 10'h3FF;
        end else if (!busy) begin
          tx <= 1'b1;
          if (start) begin
            busy <= 1'b1;
            shift_reg <= {1'b1, 8'h53, 1'b0};
            bit_cnt <= 4'd0;
            baud_cnt <= 2'd0;
          end
        end else begin
          tx <= shift_reg[0];
          if (baud_cnt == 2'd3) begin
            baud_cnt <= 2'd0;
            shift_reg <= {1'b1, shift_reg[9:1]};
            if (bit_cnt == 4'd9) begin
              busy <= 1'b0;
            end else begin
              bit_cnt <= bit_cnt + 4'd1;
            end
          end else begin
            baud_cnt <= baud_cnt + 2'd1;
          end
        end
      end
    endmodule
  `;

  const sim = createSimulator(uartTxHdl);
  const decoded = [];
  const sampler = sim.getEdgeBus().createBitSampler('tx', {
    mode: 'uart',
    cyclesPerBit: 4,
    dataBits: 8,
    onByte: (val, meta) => decoded.push({ val, ...meta }),
  });

  sim.setInput('start', 0);
  sim.setInput('rst_n', 1);
  sim.setInput('rst_n', 0);
  sim.setInput('rst_n', 1);

  // Idle cycles, then trigger transmission
  sim.stepCycles(4, 200);
  sim.setInput('start', 1);
  sim.stepClock();
  sim.setInput('start', 0);

  // Advance 50 cycles (> 10 bits * 4 cycles/bit)
  sim.stepCycles(50, 200);

  assert.equal(decoded.length, 1);
  assert.equal(decoded[0].val, 0x53); // 'S'
  assert.equal(decoded[0].framingError, false);
  assert.deepEqual(sampler.getBytes(), [0x53]);

  sampler.dispose();
  assert.equal(sim.getEdgeBus().hasWatchers(), false);
  assert.equal(sim.getEdgeBus().hasScheduledSamplers(), false);
});

// ============================================================================
// Test 4: High-Throughput Performance Sanity Test (10,000 Cycles via stepCycles)
// ============================================================================

test('v2.0 Performance: 16-bit counter runs 10,000 cycles via stepCycles in < 500 ms with exact count & budget control', () => {
  const counter16Hdl = `
    module fast_counter_16 (
      input  logic        CLOCK_50,
      input  logic        rst_n,
      output logic [15:0] count,
      output logic        msb_flag
    );
      assign msb_flag = count[15];

      always_ff @(posedge CLOCK_50 or negedge rst_n) begin
        if (!rst_n)
          count <= 16'd0;
        else
          count <= count + 16'd1;
      end
    endmodule
  `;

  const sim = createSimulator(counter16Hdl);
  sim.setInput('rst_n', 1);
  sim.setInput('rst_n', 0);
  sim.setInput('rst_n', 1);
  assert.equal(sim.getSignal('count').val, 0n);

  const t0 = performance.now();
  const res = sim.stepCycles(10_000, 500);
  const elapsedMs = performance.now() - t0;

  assert.equal(res.cyclesExecuted, 10_000);
  assert.equal(res.hitBudget, false);
  assert.equal(res.halted, false);
  assert.equal(sim.cycle, 10_000);
  assert.equal(sim.getSignal('count').val, 10_000n);
  assert.equal(sim.getSignal('count').xMask, 0n);
  assert.equal(sim.getSignal('msb_flag').val, 0n);
  assert.ok(
    elapsedMs < 500,
    `Expected 10,000 cycles to complete in < 500 ms, took ${elapsedMs.toFixed(2)} ms`
  );

  // Verify 8 ms budget slicing stops gracefully on huge requested counts without hanging
  const sliced = sim.stepCycles(2_000_000, 8);
  assert.equal(sliced.hitBudget, true);
  assert.ok(sliced.cyclesExecuted > 0 && sliced.cyclesExecuted < 2_000_000);
  assert.equal(sim.getSignal('count').val, BigInt((10_000 + sliced.cyclesExecuted) & 0xFFFF));
});
