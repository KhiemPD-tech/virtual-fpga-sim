import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WORKSPACE_SCHEMA_VERSION,
  exportVCD,
  exportConstraints,
  serializeWorkspace,
  deserializeWorkspace,
} from '../src/engine/exporters.js';
import { createLogic4, makeAllX, makeAllZ, createSimulator } from '../src/engine/simulator.js';
import { parse } from '../src/engine/parser.js';
import { WaveformViewer, RING_BUFFER_CAPACITY } from '../src/ui/waveform.js';
import { getPresetById } from '../src/presets.js';

// ============================================================================
// Test 1: IEEE 1364 .VCD Generation (Identifiers, 4-State Buses, Monotonic Timestamps)
// ============================================================================

test('v3.0 Exporters: exportVCD emits valid $var IDs, 4-state bXXXX/z buses, hierarchical scopes, and monotonic #timestamps', () => {
  const viewer = new WaveformViewer(null, RING_BUFFER_CAPACITY);

  // Push 4 samples covering 1-bit scalar, 4-bit bus, X/Z 4-state masks, and hierarchical submodule signal
  viewer.pushSample({
    cycle: 0,
    phase: 'init',
    signals: {
      clk: createLogic4(1, 0n),
      bus4: makeAllX(4),
      tri1: makeAllZ(1),
      'u_sub.cnt': createLogic4(4, 0b0101n, 0b1000n, 0b0010n), // bits [3:0] = x1z1
    },
  });
  viewer.pushSample({
    cycle: 0,
    phase: 'posedge',
    signals: {
      clk: createLogic4(1, 1n),
      bus4: createLogic4(4, 0b1010n),
      tri1: createLogic4(1, 1n),
      'u_sub.cnt': createLogic4(4, 0b1100n),
    },
  });
  viewer.pushSample({
    cycle: 1,
    phase: 'negedge',
    signals: {
      clk: createLogic4(1, 0n),
      bus4: createLogic4(4, 0b1010n), // Unchanged -> should be delta-compressed
      tri1: createLogic4(1, 0n),
      'u_sub.cnt': createLogic4(4, 0b1101n),
    },
  });

  const vcd = exportVCD(viewer, { moduleName: 'demo_top', timescale: '1ns', stepNs: 10 });

  // Header & hierarchical scopes
  assert.ok(vcd.includes('$timescale\n  1ns\n$end'));
  assert.ok(vcd.includes('$scope module demo_top $end'));
  assert.ok(vcd.includes('$scope module u_sub $end'));
  assert.ok(vcd.includes('$enddefinitions $end'));
  assert.ok(vcd.includes('$dumpvars'));

  // Extract $var declarations & verify unique printable ASCII IDs
  const varLines = vcd.split('\n').filter((l) => l.startsWith('$var '));
  assert.equal(varLines.length, 4);

  const idByVar = new Map();
  for (const line of varLines) {
    const m = /^\$var wire (\d+) ([!-~]+) (\S+)/.exec(line);
    assert.ok(m, `Malformed $var line: ${line}`);
    assert.ok(!idByVar.has(m[3]), `Duplicate var name: ${m[3]}`);
    idByVar.set(m[3], { width: Number(m[1]), id: m[2] });
  }
  assert.equal(new Set([...idByVar.values()].map((v) => v.id)).size, 4);

  // Verify 4-state initial $dumpvars values (0, 1, x, z, bxxxx, bx1z1)
  assert.ok(vcd.includes(`0${idByVar.get('clk').id}`), 'Expected initial clk = 0');
  assert.ok(vcd.includes(`bxxxx ${idByVar.get('bus4').id}`), 'Expected initial bus4 = bxxxx');
  assert.ok(vcd.includes(`z${idByVar.get('tri1').id}`), 'Expected initial tri1 = z');
  assert.ok(vcd.includes(`bx1z1 ${idByVar.get('cnt').id}`), 'Expected mixed 4-state bus bx1z1');

  // Verify transitions on subsequent timestamps
  assert.ok(vcd.includes(`b1010 ${idByVar.get('bus4').id}`));
  assert.ok(vcd.includes(`b1101 ${idByVar.get('cnt').id}`));

  // Verify strictly monotonic #timestamps
  const tsList = vcd
    .split('\n')
    .filter((l) => /^#\d+$/.test(l))
    .map((l) => Number(l.slice(1)));
  assert.deepEqual(tsList, [0, 10, 20]);
  for (let i = 1; i < tsList.length; i++) {
    assert.ok(tsList[i] > tsList[i - 1], 'Timestamps must be strictly increasing');
  }
});

// ============================================================================
// Test 2: Real FPGA Constraint Packs (.qsf DE2, .xdc Basys 3, .ucf HDLab)
// ============================================================================

test('v3.0 Exporters: exportConstraints emits valid .qsf (DE2), .xdc (Basys 3), and .ucf (HDLab) only for declared ports', () => {
  // DE2 partial design: declares CLOCK_50, SW[3:0], KEY[0:0], LEDR[3:0], HEX0 (NO HEX1..7, NO LEDG)
  const de2Hdl = `
    module mini_de2 (
      input  logic       CLOCK_50,
      input  logic [3:0] SW,
      input  logic [3:0] KEY,
      output logic [3:0] LEDR,
      output logic [6:0] HEX0
    );
      assign LEDR = SW;
      assign HEX0 = 7'b1000000;
    endmodule
  `;
  const qsf = exportConstraints('de2', parse(de2Hdl));
  assert.equal(qsf.format, 'qsf');
  assert.equal(qsf.filename, 'mini_de2.qsf');
  assert.equal(qsf.unboundPorts.length, 0);
  assert.equal(qsf.mappedPinCount, 1 + 4 + 4 + 4 + 7);
  assert.ok(qsf.content.includes('set_global_assignment -name DEVICE EP2C35F672C6'));
  assert.ok(qsf.content.includes('set_location_assignment PIN_N2 -to CLOCK_50'));
  assert.ok(qsf.content.includes('set_location_assignment PIN_N25 -to SW[0]'));
  assert.ok(qsf.content.includes('set_location_assignment PIN_G26 -to KEY[0]'));
  assert.ok(qsf.content.includes('set_location_assignment PIN_AE23 -to LEDR[0]'));
  assert.ok(qsf.content.includes('set_location_assignment PIN_AF10 -to HEX0[0]'));
  // Must NOT emit pins for undeclared ports (HEX1, LEDG, SW[4])
  assert.ok(!qsf.content.includes('HEX1'));
  assert.ok(!qsf.content.includes('LEDG'));
  assert.ok(!qsf.content.includes('SW[4]'));

  // Basys 3 design: declares clk, sw[3:0], btnC, led[3:0], an[3:0], seg[6:0] + 1 custom port
  const basysHdl = `
    module mini_basys (
      input  logic       clk,
      input  logic [3:0] sw,
      input  logic       btnC,
      output logic [3:0] led,
      output logic [3:0] an,
      output logic [6:0] seg,
      output logic       custom_dbg
    );
      assign led = sw;
      assign an = 4'b1110;
      assign seg = 7'b1000000;
      assign custom_dbg = btnC;
    endmodule
  `;
  const xdc = exportConstraints('basys3', parse(basysHdl));
  assert.equal(xdc.format, 'xdc');
  assert.equal(xdc.filename, 'mini_basys.xdc');
  assert.deepEqual(xdc.unboundPorts, ['custom_dbg']);
  assert.ok(xdc.content.includes('set_property PACKAGE_PIN W5 [get_ports {clk}]'));
  assert.ok(xdc.content.includes('create_clock -add -name sys_clk_pin -period 10.00'));
  assert.ok(xdc.content.includes('set_property PACKAGE_PIN V17 [get_ports {sw[0]}]'));
  assert.ok(xdc.content.includes('set_property PACKAGE_PIN U18 [get_ports {btnC}]'));
  assert.ok(xdc.content.includes('set_property PACKAGE_PIN U16 [get_ports {led[0]}]'));
  assert.ok(xdc.content.includes('set_property PACKAGE_PIN U2 [get_ports {an[0]}]'));
  assert.ok(xdc.content.includes('set_property PACKAGE_PIN W7 [get_ports {seg[0]}]'));
  assert.ok(!xdc.content.includes('btnU'));
  assert.ok(!xdc.content.includes('sw[4]'));

  // HDLab design (.ucf)
  const hdlabHdl = `
    module mini_hdlab (
      input  logic       CLK,
      input  logic [3:0] SW,
      input  logic       UART_RX,
      output logic       UART_TX,
      output logic       PWM
    );
      assign UART_TX = UART_RX;
      assign PWM = SW[0];
    endmodule
  `;
  const ucf = exportConstraints('hdlab', parse(hdlabHdl));
  assert.equal(ucf.format, 'ucf');
  assert.equal(ucf.filename, 'mini_hdlab.ucf');
  assert.ok(ucf.content.includes('NET "CLK" LOC = "V10" | IOSTANDARD = LVCMOS33;'));
  assert.ok(ucf.content.includes('NET "SW<0>" LOC = "T10" | IOSTANDARD = LVCMOS33;'));
  assert.ok(ucf.content.includes('NET "UART_TX" LOC = "N17" | IOSTANDARD = LVCMOS33;'));
  assert.ok(ucf.content.includes('NET "PWM" LOC = "K16" | IOSTANDARD = LVCMOS33;'));
  assert.ok(!ucf.content.includes('BUZZ'));
});

// ============================================================================
// Test 3: .lab.json Workspace Round-Trip & Corrupt Schema Validation
// ============================================================================

test('v3.0 Exporters: .lab.json serializeWorkspace / deserializeWorkspace round-trip and error validation', () => {
  const sramPreset = getPresetById('mini_sram_demo');

  const inputState = {
    boardId: 'hdlab',
    clockMode: '2000',
    hdlCode: sramPreset.code,
    filename: 'mini_sram_demo.sv',
    presetId: 'mini_sram_demo',
    activePeripherals: [
      { id: 'uart_terminal', config: { cyclesPerBit: 16 }, bindings: { tx: 'UART_TX', rx: 'UART_RX' } },
      { id: 'memory_viewer', config: { memoryName: 'mem' }, bindings: {} },
    ],
    memoryHex: { mem: '@00 48 44 4C 21' },
    language: 'en',
  };

  const jsonText = serializeWorkspace(inputState);
  const parsed = deserializeWorkspace(jsonText);

  assert.equal(parsed.version, WORKSPACE_SCHEMA_VERSION);
  assert.equal(parsed.boardId, 'hdlab');
  assert.equal(parsed.clockMode, '2000');
  assert.equal(parsed.hdlCode, sramPreset.code);
  assert.equal(parsed.filename, 'mini_sram_demo.sv');
  assert.equal(parsed.language, 'en');
  assert.equal(parsed.activePeripherals.length, 2);
  assert.deepEqual(parsed.activePeripherals[0].bindings, { tx: 'UART_TX', rx: 'UART_RX' });
  assert.equal(parsed.activePeripherals[0].config.cyclesPerBit, 16);
  assert.equal(parsed.memoryHex.mem, '@00 48 44 4C 21');

  // Verify restored code + memoryHex actually simulate cleanly
  const sim = createSimulator(parsed.hdlCode);
  sim.loadMemoryHex('mem', parsed.memoryHex.mem);
  assert.equal(sim.getMemoryWord('mem', 0).val, 0x48n);
  assert.equal(sim.getMemoryWord('mem', 3).val, 0x21n);

  // Corrupt JSON & invalid schema error handling
  assert.throws(() => deserializeWorkspace('{ broken json'), /Corrupt \.lab\.json/);
  assert.throws(() => deserializeWorkspace('{"version": 99, "hdlCode": ""}'), /Unsupported \.lab\.json/);
  assert.throws(() => deserializeWorkspace('{"version": 2}'), /missing string field "hdlCode"/);
});
