import test from 'node:test';
import assert from 'node:assert/strict';

import { COURSE_LAB_PRESETS, getPresetById } from '../src/presets.js';
import { preprocessWorkspace } from '../src/engine/preprocessor.js';
import { parseProgram } from '../src/engine/parser.js';
import { createSimulator } from '../src/engine/simulator.js';
import { synthesize, selectTopModule, isTestbenchModule } from '../src/engine/synthesizer.js';
import { runTestbench } from '../src/engine/testbench.js';
import { exportConstraints, serializeWorkspace, deserializeWorkspace } from '../src/engine/exporters.js';
import { getBoardDevice } from '../src/boards/registry.js';
import { MemoryViewerPeripheral } from '../src/peripherals/memory_viewer.js';

// ============================================================================
// Test 1: All 6 CE118 / CE213 Course Labs — Board Mode + Testbench Mode
// ============================================================================
test('v4.0-C Test 1: All 6 CE118/CE213 Course Labs compile cleanly in Board Mode and PASS in Testbench Mode', () => {
  const expectedIds = [
    'lab1_loadable_counter',
    'lab2_fsm_moore',
    'lab3_alu_4bit',
    'lab4_mips_datapath',
    'lab5_control_unit',
    'lab6_simple_processor',
  ];
  assert.deepEqual(COURSE_LAB_PRESETS.map((p) => p.id), expectedIds);

  const de2Device = getBoardDevice('de2');

  for (const lab of COURSE_LAB_PRESETS) {
    assert.equal(getPresetById(lab.id).id, lab.id);
    assert.equal(lab.recommendedBoard, 'de2');
    assert.ok(lab.title?.en && lab.title?.vi, `${lab.id} missing bilingual title`);
    assert.ok(lab.description?.en && lab.description?.vi, `${lab.id} missing bilingual description`);
    assert.ok(Array.isArray(lab.files) && lab.files.length >= 2, `${lab.id} must have multi-file tabs (design + tb_*)`);
    assert.ok(lab.files.some((f) => /^tb_/i.test(f.name)), `${lab.id} missing tb_*.v tab`);

    // Preprocess multi-file workspace (design + testbench combined)
    const pp = preprocessWorkspace(lab.files);
    assert.equal(pp.warnings.length, 0, `${lab.id} preprocessor warnings: ${JSON.stringify(pp.warnings)}`);

    const prog = parseProgram(pp.mergedCode);

    // 1) Board Mode: auto-selects design top (skips tb_*)
    const boardTop = selectTopModule(prog, 'board');
    assert.ok(boardTop && !isTestbenchModule(boardTop), `${lab.id} boardTop should be non-TB design`);

    const synthReport = synthesize(boardTop, { device: de2Device });
    assert.equal(synthReport.errors.length, 0, `${lab.id} synth errors: ${JSON.stringify(synthReport.errors)}`);
    assert.equal(synthReport.warnings.length, 0, `${lab.id} synth warnings: ${JSON.stringify(synthReport.warnings)}`);
    assert.ok(synthReport.luts > 0, `${lab.id} expected LUTs > 0`);
    assert.ok(synthReport.logicDepth > 0, `${lab.id} expected logicDepth > 0`);
    assert.ok(synthReport.hierarchy && synthReport.hierarchy.moduleName === boardTop.name);

    const sim = createSimulator(boardTop);
    if (sim.ast.signals.SW) sim.setInput('SW', 0);
    if (sim.ast.signals.KEY) {
      sim.setInput('KEY', 0b1111);
      sim.setInput('KEY', 0b1110);
      sim.setInput('KEY', 0b1111);
    }
    const stepRes = sim.stepCycles(26, 1000);
    assert.equal(stepRes.halted, false, `${lab.id} halted unexpectedly in Board Mode`);
    assert.equal(stepRes.cyclesExecuted, 26);

    // Lab-specific Board Mode checks
    if (lab.id === 'lab4_mips_datapath') {
      assert.ok(lab.recommendedPeripherals.some((p) => p.id === 'memory_viewer'));
      assert.ok(sim.memNameToId.has('u_rf.regs'), 'Lab 4 must expose u_rf.regs memory');
      assert.ok(synthReport.hierarchy.children.length >= 2, 'Lab 4 must have u_rf & u_alu hierarchy children');
    }
    if (lab.id === 'lab6_simple_processor') {
      assert.ok(lab.recommendedPeripherals.some((p) => p.id === 'memory_viewer'));
      assert.ok(sim.memNameToId.has('u_imem.mem'), 'Lab 6 must expose u_imem.mem');
      assert.ok(sim.memNameToId.has('u_dp.u_rf.regs'), 'Lab 6 must expose u_dp.u_rf.regs');
      // After 26 cycles, preloaded program R1=3,R2=4,R3=7,R4=11,R5=14(0x0E) has halted cleanly!
      assert.equal(sim.getSignal('LEDR').val & 0xFFn, 0x0En, 'Lab 6 LEDR[7:0] must reach 0x0E');
      assert.equal((sim.getSignal('LEDG').val >> 3n) & 1n, 1n, 'Lab 6 halted LEDG[3] must be 1');
      assert.equal(sim.getMemory('u_dp.u_rf.regs').read(5).val, 0x0En, 'Lab 6 R5 must equal 0x0E');
      assert.ok(synthReport.hierarchy.children.length >= 3, 'Lab 6 must show u_imem, u_ctrl, u_dp hierarchy');

      // Verify MemoryViewerPeripheral attaches cleanly in Board Mode
      const mv = new MemoryViewerPeripheral();
      mv.attach({ sim, edgeBus: sim.getEdgeBus() });
      assert.ok(mv.selectedMem === 'u_imem.mem' || mv.selectedMem === 'u_dp.u_rf.regs');
    }

    // 2) Testbench Mode: auto-selects tb_*, runs to $finish with PASS and zero FAIL
    const tbTop = selectTopModule(prog, 'testbench');
    assert.ok(tbTop && isTestbenchModule(tbTop), `${lab.id} tbTop should be testbench module`);

    const tbRes = runTestbench(prog, {
      topModule: tbTop.name,
      maxTime: 10000,
      device: de2Device,
      memoryFiles: lab.files,
    });
    assert.equal(tbRes.stats.haltedBy, '$finish', `${lab.id} TB did not halt via $finish (got ${tbRes.stats.haltedBy})`);
    assert.ok(tbRes.dutSynthesis && tbRes.dutSynthesis.moduleName === boardTop.name, `${lab.id} TB must extract DUT synthesis`);

    const logTexts = tbRes.logs.map((l) => l.text);
    assert.ok(
      logTexts.some((txt) => txt.includes('PASS')),
      `${lab.id} TB logs missing PASS: ${JSON.stringify(logTexts)}`
    );
    assert.equal(
      logTexts.some((txt) => txt.includes('FAIL')),
      false,
      `${lab.id} TB emitted FAIL: ${JSON.stringify(logTexts)}`
    );

    // Verify MemoryViewer works in Testbench Mode too (hierarchical dut.* memories)
    if (lab.id === 'lab6_simple_processor') {
      const mvTb = new MemoryViewerPeripheral({ memoryName: 'u_dp.u_rf.regs' });
      mvTb.attach({ sim: tbRes.sim, edgeBus: tbRes.sim.getEdgeBus() });
      assert.equal(mvTb.selectedMem, 'dut.u_dp.u_rf.regs');
      assert.equal(tbRes.sim.getMemory(mvTb.selectedMem).read(5).val, 0x0En);
    }
  }
});

// ============================================================================
// Test 2: Authentic Terasic/Altera DE2 (Cyclone II EP2C35F672C6) .qsf Pinout Audit
// ============================================================================
test('v4.0-C Test 2: Quartus DE2 (.qsf) pinout matches authentic EP2C35F672C6 physical pins', () => {
  const fullDe2Top = `
    module de2_full_io (
      input  wire        CLOCK_50,
      input  wire [17:0] SW,
      input  wire [3:0]  KEY,
      output wire [17:0] LEDR,
      output wire [8:0]  LEDG,
      output wire [6:0]  HEX0,
      output wire [6:0]  HEX1,
      output wire [6:0]  HEX2,
      output wire [6:0]  HEX3,
      output wire [6:0]  HEX4,
      output wire [6:0]  HEX5,
      output wire [6:0]  HEX6,
      output wire [6:0]  HEX7
    );
      assign LEDR = SW;
      assign LEDG = {5'd0, KEY};
      assign HEX0 = 7'h7F; assign HEX1 = 7'h7F; assign HEX2 = 7'h7F; assign HEX3 = 7'h7F;
      assign HEX4 = 7'h7F; assign HEX5 = 7'h7F; assign HEX6 = 7'h7F; assign HEX7 = 7'h7F;
    endmodule
  `;

  const pack = exportConstraints('de2', fullDe2Top);
  assert.equal(pack.format, 'qsf');
  assert.equal(pack.filename, 'de2_full_io.qsf');
  assert.ok(pack.content.includes('set_global_assignment -name FAMILY "Cyclone II"'));
  assert.ok(pack.content.includes('set_global_assignment -name DEVICE EP2C35F672C6'));
  assert.ok(pack.content.includes('set_location_assignment PIN_N2 -to CLOCK_50'));

  const expectedPins = {
    SW: ['N25', 'N26', 'P25', 'AE14', 'AF14', 'AD13', 'AC13', 'C13', 'B13', 'A13', 'N1', 'P1', 'P2', 'T7', 'U3', 'U4', 'V1', 'V2'],
    KEY: ['G26', 'N23', 'P23', 'W26'],
    LEDR: ['AE23', 'AF23', 'AB21', 'AC22', 'AD22', 'AD23', 'AD21', 'AC21', 'AA14', 'Y13', 'AA13', 'AC14', 'AD15', 'AE15', 'AF13', 'AE13', 'AE12', 'AD12'],
    LEDG: ['AE22', 'AF22', 'W19', 'V18', 'U18', 'U17', 'AA20', 'Y18', 'Y12'],
    HEX0: ['AF10', 'AB12', 'AC12', 'AD11', 'AE11', 'V14', 'V13'],
    HEX1: ['V20', 'V21', 'W21', 'Y22', 'AA24', 'AA23', 'AB24'],
    HEX2: ['AB23', 'V22', 'AC25', 'AC26', 'AB26', 'AB25', 'Y24'],
    HEX3: ['Y23', 'AA25', 'AA26', 'Y26', 'Y25', 'U22', 'W24'],
    HEX4: ['U9', 'U1', 'U2', 'T4', 'R7', 'R6', 'T3'],
    HEX5: ['T2', 'P6', 'P7', 'T9', 'R5', 'R4', 'R3'],
    HEX6: ['R2', 'P4', 'P3', 'M2', 'M3', 'M5', 'M4'],
    HEX7: ['L3', 'L2', 'L9', 'L6', 'L7', 'P9', 'N9'],
  };

  for (const [port, pins] of Object.entries(expectedPins)) {
    pins.forEach((pin, idx) => {
      const line = `set_location_assignment PIN_${pin} -to ${port}[${idx}]`;
      assert.ok(pack.content.includes(line), `Missing DE2 QSF pin assignment: ${line}`);
    });
  }

  // Multi-file source containing tb_* still exports constraints for the DE2 design module
  const lab6 = getPresetById('lab6_simple_processor');
  const mergedLab6 = preprocessWorkspace(lab6.files).mergedCode;
  const lab6Pack = exportConstraints('de2', mergedLab6);
  assert.equal(lab6Pack.filename, 'simple_processor.qsf');
  assert.ok(lab6Pack.content.includes('set_location_assignment PIN_N2 -to CLOCK_50'));
  assert.ok(lab6Pack.content.includes('set_location_assignment PIN_N25 -to SW[0]'));
  assert.ok(lab6Pack.content.includes('set_location_assignment PIN_G26 -to KEY[0]'));
  assert.ok(lab6Pack.content.includes('set_location_assignment PIN_AE23 -to LEDR[0]'));
});

// ============================================================================
// Test 3: .lab.json Persistence Preserves simMode & Multi-File Tabs
// ============================================================================
test('v4.0-C Test 3: .lab.json serializeWorkspace / deserializeWorkspace preserves simMode & multi-file tabs', () => {
  const lab6 = getPresetById('lab6_simple_processor');
  const json = serializeWorkspace({
    boardId: 'de2',
    simMode: 'testbench',
    clockMode: '5',
    files: lab6.files,
    activeFile: 'tb_processor.v',
    presetId: lab6.id,
    activePeripherals: [{ id: 'memory_viewer', config: {}, bindings: {} }],
    language: 'vi',
  });
  const ws = deserializeWorkspace(json);
  assert.equal(ws.simMode, 'testbench');
  assert.equal(ws.boardId, 'de2');
  assert.equal(ws.files.length, 2);
  assert.equal(ws.activeFile, 'tb_processor.v');
  assert.equal(ws.language, 'vi');

  // Backward compatibility: older .lab.json without simMode defaults to 'board'
  const parsed = JSON.parse(json);
  delete parsed.simMode;
  const legacyWs = deserializeWorkspace(JSON.stringify(parsed));
  assert.equal(legacyWs.simMode, 'board');
});
