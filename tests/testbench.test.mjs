import test from 'node:test';
import assert from 'node:assert/strict';

import { runTestbench, formatVerilogDisplay } from '../src/engine/testbench.js';
import { exportVCD } from '../src/engine/exporters.js';
import { WaveformViewer } from '../src/ui/waveform.js';
import { createLogic4 } from '../src/engine/simulator.js';

// ============================================================================
// Test 1: Counter Testbench (always #5, reset, repeat (4) @(posedge clk), $display, $finish)
// ============================================================================
test('v4.0-B Test 1: Counter Testbench runs deterministic timestamps, repeat @(posedge), $display, $finish', () => {
  const src = `
    module counter4 (
      input wire clk,
      input wire rst_n,
      output reg [3:0] q
    );
      always @(posedge clk or negedge rst_n) begin
        if (!rst_n)
          q <= 4'd0;
        else
          q <= q + 4'd1;
      end
    endmodule

    module tb_counter4;
      reg clk;
      reg rst_n;
      wire [3:0] q;

      counter4 dut (
        .clk(clk),
        .rst_n(rst_n),
        .q(q)
      );

      always #5 clk = ~clk;

      initial begin
        clk = 1'b0;
        rst_n = 1'b0;
        #12;
        rst_n = 1'b1;
        repeat (4) @(posedge clk);
        $display("DONE t=%0t q=%0d hex=%h bin=%b", $time, q, q, q);
        $finish;
      end
    endmodule
  `;

  const res = runTestbench(src, { maxTime: 1000 });

  assert.equal(res.topModule, 'tb_counter4');
  assert.equal(res.dutModule, 'counter4');
  assert.equal(res.stats.haltedBy, '$finish');
  // t=0: clk=0,rst_n=0; t=5: clk=1; t=10: clk=0; t=12: rst_n=1;
  // posedges after reset release: t=15 (q=1), t=25 (q=2), t=35 (q=3), t=45 (q=4)
  assert.equal(res.stats.endTime, 45);
  assert.equal(res.sim.getSignal('q').val, 4n);
  assert.equal(res.sim.getSignal('q').xMask, 0n);

  const displayLogs = res.logs.filter((l) => l.type === 'display');
  assert.equal(displayLogs.length, 1);
  assert.equal(displayLogs[0].time, 45);
  assert.equal(displayLogs[0].text, 'DONE t=45 q=4 hex=4 bin=0100');

  // Verify exact monotonic timestamps in waveform trace
  const times = res.trace.map((f) => f.time);
  assert.deepEqual(times, [0, 5, 10, 12, 15, 20, 25, 30, 35, 40, 45]);

  const frameAt15 = res.trace.find((f) => f.time === 15);
  const frameAt35 = res.trace.find((f) => f.time === 35);
  const frameAt45 = res.trace.find((f) => f.time === 45);
  assert.equal(frameAt15.signals.q.val, 1n);
  assert.equal(frameAt35.signals.q.val, 3n);
  assert.equal(frameAt45.signals.q.val, 4n);
});

// ============================================================================
// Test 2: Self-Checking ALU Testbench (for loop, ===, $monitor change-only, 4-state format)
// ============================================================================
test('v4.0-B Test 2: Self-Checking ALU Testbench with runtime for, === check, and change-only $monitor', () => {
  const src = `
    module alu4 (
      input wire [3:0] a,
      input wire [3:0] b,
      input wire [1:0] op,
      output reg [3:0] y
    );
      always @* begin
        case (op)
          2'd0: y = a + b;
          2'd1: y = a - b;
          2'd2: y = a & b;
          default: y = a | b;
        endcase
      end
    endmodule

    module tb_alu4;
      reg [3:0] a, b;
      reg [1:0] op;
      wire [3:0] y;
      reg [3:0] exp_y;
      integer i;
      integer errors;

      alu4 dut (.a(a), .b(b), .op(op), .y(y));

      initial begin
        errors = 0;
        a = 4'd6;
        b = 4'd3;
        op = 2'd0;
        $monitor("MON t=%0t op=%0d y=%0h", $time, op, y);
        #10;
        // Re-apply identical values — $monitor MUST NOT re-fire!
        a = 4'd6;
        b = 4'd3;
        op = 2'd0;
        #10;

        for (i = 0; i < 4; i = i + 1) begin
          op = i[1:0];
          #10;
          case (op)
            2'd0: exp_y = 4'd9;
            2'd1: exp_y = 4'd3;
            2'd2: exp_y = 4'd2;
            default: exp_y = 4'd7;
          endcase
          if (y !== exp_y) begin
            errors = errors + 1;
            $display("FAIL op=%0d got=%h exp=%h", op, y, exp_y);
          end
        end

        $display("SUMMARY errors=%0d", errors);
        $finish;
      end
    endmodule
  `;

  const res = runTestbench(src, { maxTime: 5000 });
  assert.equal(res.stats.haltedBy, '$finish');
  assert.equal(res.sim.getSignal('errors').val, 0n);

  const summaryLogs = res.logs.filter((l) => l.type === 'display');
  assert.equal(summaryLogs.length, 1);
  assert.equal(summaryLogs[0].text, 'SUMMARY errors=0');

  // $monitor should fire at:
  // t=0 (op=0, y=9)
  // NOT at t=10 (identical op=0, y=9)
  // NOT at t=20 (loop i=0 sets op=0, still op=0, y=9)
  // t=30 (loop i=1 sets op=1, y=3)
  // t=40 (loop i=2 sets op=2, y=2)
  // t=50 (loop i=3 sets op=3, y=7)
  // (t=60 executes $finish before postponed $monitor)
  const monLogs = res.logs.filter((l) => l.type === 'monitor');
  assert.equal(monLogs.length, 4, `Expected 4 $monitor events, got: ${JSON.stringify(monLogs)}`);
  assert.deepEqual(
    monLogs.map((m) => m.text),
    [
      'MON t=0 op=0 y=9',
      'MON t=30 op=1 y=3',
      'MON t=40 op=2 y=2',
      'MON t=50 op=3 y=7',
    ]
  );

  // Verify 4-state format specifiers (%b, %h, %0h, %d, %0d, %s, %t) with X and Z
  const xVal = createLogic4(8, 0b0000_0101n, 0b1111_0000n, 0n);
  const zVal = createLogic4(4, 0n, 0n, 0b1111n);
  const fmt = formatVerilogDisplay(
    [
      { kind: 'String', value: 'b=%b h=%h d=%d z=%h zb=%b s=%s t=%0t' },
      { kind: 'Mock', v: xVal },
      { kind: 'Mock', v: xVal },
      { kind: 'Mock', v: xVal },
      { kind: 'Mock', v: zVal },
      { kind: 'Mock', v: zVal },
      { kind: 'String', value: 'OK' },
      { kind: 'Mock', v: createLogic4(64, 125n) },
    ],
    (node) => node.v,
    125
  );
  assert.equal(fmt, 'b=xxxx0101 h=x5 d=x z=z zb=zzzz s=OK t=125');
});

// ============================================================================
// Test 3: Safety Cap Guard (infinite always #5 without $finish terminates cleanly)
// ============================================================================
test('v4.0-B Test 3: Safety Cap Guard terminates infinite clock loop cleanly at maxTime and maxEvents', () => {
  const src = `
    module tb_infinite_clk;
      reg clk;
      initial clk = 1'b0;
      always #5 clk = ~clk;
    endmodule
  `;

  const resTime = runTestbench(src, { maxTime: 250, maxEvents: 100000 });
  assert.equal(resTime.stats.haltedBy, 'maxTime');
  assert.equal(resTime.stats.endTime, 250);
  // 0, 5, 10, ..., 250 => 51 discrete timestamps
  assert.equal(resTime.trace.length, 51);
  assert.equal(resTime.trace[0].signals.clk.val, 0n);
  assert.equal(resTime.trace[1].time, 5);
  assert.equal(resTime.trace[1].signals.clk.val, 1n);
  assert.equal(resTime.trace[2].time, 10);
  assert.equal(resTime.trace[2].signals.clk.val, 0n);

  const resEvents = runTestbench(src, { maxTime: 100000, maxEvents: 100 });
  assert.equal(resEvents.stats.haltedBy, 'maxEvents');
  assert.ok(resEvents.stats.eventsExecuted <= 105);
  assert.ok(resEvents.stats.endTime < 1000);
});

// ============================================================================
// Test 4: DUT Synthesis Extraction, $readmemh Workspace Loading & Testbench VCD Export
// ============================================================================
test('v4.0-B Test 4: DUT Synthesis extraction, $readmemh workspace loading, Waveform loadTrace & VCD export', () => {
  const src = `
    module rom_accum (
      input wire clk,
      input wire rst_n,
      input wire [1:0] addr,
      output reg [7:0] acc
    );
      reg [7:0] rom [0:3];
      wire [7:0] rdata = rom[addr];

      always @(posedge clk or negedge rst_n) begin
        if (!rst_n)
          acc <= 8'd0;
        else
          acc <= acc + rdata;
      end
    endmodule

    module tb_rom_accum;
      reg clk;
      reg rst_n;
      reg [1:0] addr;
      wire [7:0] acc;

      rom_accum dut (
        .clk(clk),
        .rst_n(rst_n),
        .addr(addr),
        .acc(acc)
      );

      always #10 clk = ~clk;

      initial begin
        $readmemh("prog.hex", dut.rom);
        clk = 1'b0;
        rst_n = 1'b0;
        addr = 2'd0;
        #5 rst_n = 1'b1;

        @(posedge clk); // +0x10 -> 0x10 at t=10
        #2 addr = 2'd1;
        @(posedge clk); // +0x20 -> 0x30 at t=30
        #2 addr = 2'd2;
        @(posedge clk); // +0x05 -> 0x35 at t=50
        #5;
        $display("ACC=0x%0h", acc);
        $finish;
      end
    endmodule
  `;

  const res = runTestbench(src, {
    maxTime: 1000,
    memoryFiles: [{ name: 'prog.hex', content: '10\n20\n05\n01\n' }],
  });

  assert.equal(res.stats.haltedBy, '$finish');
  assert.equal(res.sim.getSignal('acc').val, 0x35n);
  assert.equal(res.logs.find((l) => l.type === 'display')?.text, 'ACC=0x35');

  // DUT Synthesis extracted cleanly (skipping testbench constructs)
  assert.ok(res.dutSynthesis, 'Expected dutSynthesis to be extracted');
  assert.equal(res.dutSynthesis.moduleName, 'rom_accum');
  assert.equal(res.dutSynthesis.errors.length, 0);
  assert.ok(res.dutSynthesis.luts > 0, 'Expected DUT LUTs > 0');
  assert.equal(res.dutSynthesis.ffs, 8, 'Expected 8 Flip-Flops for acc[7:0]');
  assert.equal(res.dutSynthesis.memoryBits, 32, 'Expected 4x8=32 memory bits');
  assert.ok(res.dutSynthesis.logicDepth > 0, 'Expected positive Critical Path logicDepth');
  assert.ok(res.dutSynthesis.hierarchy && res.dutSynthesis.hierarchy.moduleName === 'rom_accum');

  // WaveformViewer.loadTrace + VCD export emits strictly monotonic #time timestamps
  const wv = new WaveformViewer(null);
  wv.loadTrace(res.trace);
  assert.equal(wv.timeMode, true);
  assert.equal(wv.getSampleCount(), res.trace.length);
  assert.equal(wv.getSample(0).time, 0);
  assert.equal(wv.getSample(wv.getSampleCount() - 1).time, res.stats.endTime);

  const vcd = exportVCD(wv, { moduleName: res.topModule });
  assert.ok(vcd.includes('$timescale'), 'VCD must include $timescale');
  assert.ok(vcd.includes('$scope module tb_rom_accum $end'));
  assert.ok(vcd.includes('$scope module dut $end'));
  assert.ok(vcd.includes('$dumpvars'));

  // Extract all #timestamp lines and verify strictly monotonic order matching ns timeline
  const tsLines = vcd
    .split('\n')
    .filter((line) => /^#\d+$/.test(line))
    .map((line) => Number(line.slice(1)));
  assert.ok(tsLines.length >= 4, `Expected >= 4 VCD timestamps, got ${tsLines.length}`);
  assert.equal(tsLines[0], 0);
  for (let i = 1; i < tsLines.length; i++) {
    assert.ok(tsLines[i] > tsLines[i - 1], `VCD timestamps must be strictly increasing: ${tsLines[i - 1]} -> ${tsLines[i]}`);
  }
  // Confirm specific expected testbench timestamps appear in VCD
  assert.ok(tsLines.includes(10), 'Expected #10 in VCD');
  assert.ok(tsLines.includes(30), 'Expected #30 in VCD');
  assert.ok(tsLines.includes(50), 'Expected #50 in VCD');
});
