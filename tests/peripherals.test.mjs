import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BOARD_PROFILES,
  getBoardProfile,
  getBoardDevice,
  resolveBoardPortBinding,
} from '../src/boards/registry.js';
import {
  PERIPHERAL_MANIFESTS,
  getPeripheralManifest,
  autoBindPeripheralPins,
} from '../src/peripherals/registry.js';
import { UartTerminalPeripheral } from '../src/peripherals/uart_terminal.js';
import { PwmServoPeripheral } from '../src/peripherals/pwm_servo.js';
import { BuzzerAudioPeripheral } from '../src/peripherals/buzzer_audio.js';
import { AdcSensorPeripheral } from '../src/peripherals/adc_sensor.js';
import { MemoryViewerPeripheral } from '../src/peripherals/memory_viewer.js';
import { FpgaBoard } from '../src/ui/board.js';
import { parse } from '../src/engine/parser.js';
import { createSimulator } from '../src/engine/simulator.js';
import { synthesize } from '../src/engine/synthesizer.js';
import { PRESETS, V2_PRESETS, ALL_PRESETS, getPresetById } from '../src/presets.js';

// ============================================================================
// Test 1: Validate All 3 Data-Driven Board Profiles & Device Capacities
// ============================================================================

test('v2.5 Boards: all 3 board profiles (DE2, Basys 3, HDLab) validate cleanly with device specs & pin bindings', () => {
  assert.equal(BOARD_PROFILES.length, 3);
  assert.deepEqual(BOARD_PROFILES.map((b) => b.id), ['de2', 'basys3', 'hdlab']);

  // DE2 (Cyclone II EP2C35, 33,216 LEs)
  const de2 = getBoardProfile('de2');
  assert.equal(de2.device.totalLEs, 33216);
  assert.equal(de2.io.switches.width, 18);
  assert.equal(de2.io.buttons.width, 4);
  assert.equal(de2.io.buttons.activeLow, true);
  assert.equal(de2.io.sevenSeg.mode, 'independent');
  assert.equal(de2.io.sevenSeg.count, 8);
  assert.equal(resolveBoardPortBinding(de2, 'CLOCK_50').bound, true);
  assert.equal(resolveBoardPortBinding(de2, 'HEX7').bound, true);
  assert.equal(resolveBoardPortBinding(de2, 'GPIO').bound, true);

  // Basys 3 (Artix-7 XC7A35T, 20,800 LUTs)
  const basys3 = getBoardProfile('basys3');
  assert.equal(basys3.device.totalLEs, 20800);
  assert.equal(basys3.io.switches.width, 16);
  assert.equal(basys3.io.buttons.mode, 'named');
  assert.equal(basys3.io.buttons.activeLow, false);
  assert.equal(basys3.io.buttons.items.length, 5);
  assert.equal(basys3.io.sevenSeg.mode, 'multiplexed');
  assert.equal(basys3.io.sevenSeg.count, 4);
  assert.equal(resolveBoardPortBinding(basys3, 'clk').bound, true);
  assert.equal(resolveBoardPortBinding(basys3, 'sw').bound, true);
  assert.equal(resolveBoardPortBinding(basys3, 'btnC').bound, true);
  assert.equal(resolveBoardPortBinding(basys3, 'an').bound, true);
  assert.equal(resolveBoardPortBinding(basys3, 'seg').bound, true);
  assert.equal(resolveBoardPortBinding(basys3, 'JA').bound, true);
  assert.equal(resolveBoardPortBinding(basys3, 'JB').bound, true);

  // Verify Basys 3 POV multiplexed 7-segment latch retains scanned digits across frames
  const headlessBasys = new FpgaBoard(null, { boardId: 'basys3' });
  headlessBasys.recordMuxSample(0b1110n, 0b1000000n, 1n); // AN0 = '0'
  headlessBasys.recordMuxSample(0b1101n, 0b1111001n, 0n); // AN1 = '1' + DP lit
  assert.equal(headlessBasys._muxDigits[0].val, 0b1000000n);
  assert.equal(headlessBasys._muxDigits[1].val, 0b1111001n);
  assert.equal(headlessBasys._muxDigits[1].dp, 0);
  assert.ok(headlessBasys._muxDigits[0].ttl > 0 && headlessBasys._muxDigits[1].ttl > 0);

  // HDLab Education Board (Spartan-6 / Generic Edu, 14,744 LUTs)
  const hdlab = getBoardProfile('hdlab');
  assert.equal(hdlab.device.totalLEs, 14744);
  assert.equal(hdlab.io.switches.width, 8);
  assert.equal(hdlab.io.buttons.width, 4);
  assert.equal(hdlab.io.sevenSeg.count, 4);
  assert.equal(resolveBoardPortBinding(hdlab, 'BTN').bound, true);
  assert.equal(resolveBoardPortBinding(hdlab, 'LED').bound, true);
  assert.equal(resolveBoardPortBinding(hdlab, 'UART_TX').bound, true);
  assert.equal(resolveBoardPortBinding(hdlab, 'UART_RX').bound, true);
  assert.equal(resolveBoardPortBinding(hdlab, 'BUZZ').bound, true);
  assert.equal(resolveBoardPortBinding(hdlab, 'PWM').bound, true);
  assert.equal(resolveBoardPortBinding(hdlab, 'ADC_DATA').bound, true);
  assert.equal(resolveBoardPortBinding(hdlab, 'GPIO').bound, true);

  // Device lookup feeds synthesizer cleanly
  const synBasys = synthesize(getPresetById('full_adder_4bit').code, { device: getBoardDevice('basys3') });
  assert.equal(synBasys.device, 'Xilinx Artix-7 XC7A35T');
  assert.equal(synBasys.totalLEs, 20800);
});

// ============================================================================
// Test 2: UART Terminal 8N1 Decode & Bidirectional Echo with uart_echo_demo
// ============================================================================

test('v2.5 UART Terminal: decodes 8N1 byte transmitted by uart_echo_demo and echoes sent ASCII back', () => {
  const preset = getPresetById('uart_echo_demo');
  assert.equal(preset.id, 'uart_echo_demo');

  const sim = createSimulator(preset.code);
  const uartManifest = getPeripheralManifest('uart_terminal');
  const bindings = autoBindPeripheralPins(uartManifest, sim.ast);
  assert.equal(bindings.tx, 'UART_TX');
  assert.equal(bindings.rx, 'UART_RX');

  const uart = new UartTerminalPeripheral({ cyclesPerBit: 16, bindings });
  uart.attach({ sim, edgeBus: sim.getEdgeBus(), getClockFreqHz: () => 2000 });

  // Pulse async Active-Low reset on KEY[0] (UART_RX held idle-high=1 by uart.attach)
  sim.setInput('SW', 0);
  sim.setInput('KEY', 0b1111);
  sim.setInput('KEY', 0b1110);
  sim.setInput('KEY', 0b1111);

  // Settle a few idle cycles so rx_prev latches 1
  sim.stepCycles(4, 500);

  // Part A: Trigger RTL transmit test byte ('A' = 0x41) by toggling SW[0] 0 -> 1
  sim.setInput('SW', 1);
  sim.stepCycles(220, 500); // > 10 bits * 16 cycles/bit = 160 cycles
  assert.deepEqual(uart.getReceivedBytes(), [0x41]);
  assert.equal(uart.getReceivedText(), 'A');

  // Part B: Send "Hi" from UART Terminal onto UART_RX -> RTL receives, counts, and echoes "Hi" back on UART_TX!
  uart.clear();
  uart.sendText('Hi');

  // 2 bytes TX (2 * 12 * 16 = 384 cyc) + echo TX of 2nd byte (~180 cyc) -> 700 cycles safely completes both
  sim.stepCycles(700, 1000);

  assert.equal(uart.getReceivedText(), 'Hi');
  assert.deepEqual(uart.getReceivedBytes(), [0x48, 0x69]);
  assert.equal(sim.getSignal('last_byte').val, 0x69n); // 'i'
  assert.equal(sim.getSignal('echo_count').val, 2n);
  assert.equal(sim.getSignal('LEDR').val & 0xFFFFn, 0x0269n); // {echo_count=2, last_byte=0x69}

  uart.destroy();
  assert.equal(sim.getEdgeBus().hasWatchers(), false);
});

// ============================================================================
// Test 3: PWM Servo, Piezo Buzzer, Virtual ADC & Memory Viewer Peripherals
// ============================================================================

test('v2.5 Peripherals: PWM Servo, Buzzer, Virtual ADC, and Memory Viewer integrate cleanly', () => {
  assert.equal(PERIPHERAL_MANIFESTS.length, 5);

  // 1. PWM Servo + Buzzer on pwm_servo_buzzer preset
  const pwmSim = createSimulator(getPresetById('pwm_servo_buzzer').code);
  const pwmPeriph = new PwmServoPeripheral({ bindings: { pwm: 'PWM' } });
  const buzPeriph = new BuzzerAudioPeripheral({ bindings: { buzz: 'BUZZ' } });
  const pwmCtx = { sim: pwmSim, edgeBus: pwmSim.getEdgeBus(), getClockFreqHz: () => 2000 };
  pwmPeriph.attach(pwmCtx);
  buzPeriph.attach(pwmCtx);

  // SW[3:0] = 4'd11 -> duty = 11*4 + 6 = 50% -> servo angle ~ 90 deg; SW[7:4] = 4'd2 -> tone half_period = 12
  pwmSim.setInput('SW', (2 << 4) | 11);
  pwmSim.setInput('KEY', 0b1111);
  pwmSim.setInput('KEY', 0b1110);
  pwmSim.setInput('KEY', 0b1111);
  pwmSim.stepCycles(260, 500);

  const m = pwmPeriph.getMetrics();
  assert.equal(m.valid, true);
  assert.ok(Math.abs(m.dutyPct - 50) < 0.5, `Expected ~50% duty, got ${m.dutyPct}`);
  assert.ok(Math.abs(m.angleDeg - 90) < 1.0, `Expected ~90 deg servo angle, got ${m.angleDeg}`);
  buzPeriph.onFrame(); // Headless safe (muted by default, no AudioContext crash)
  pwmPeriph.destroy();
  buzPeriph.destroy();

  // 2. Virtual ADC Sensor driving an 8-bit input port
  const adcSim = createSimulator(`
    module adc_pass(input [7:0] ADC_DATA, output [7:0] LED);
      assign LED = ADC_DATA;
    endmodule
  `);
  const adc = new AdcSensorPeripheral({ bits: 8, bindings: { out: 'ADC_DATA' } });
  adc.attach({ sim: adcSim, edgeBus: adcSim.getEdgeBus() });
  adc.setValue(200);
  assert.equal(adcSim.getSignal('LED').val, 200n);
  adc.destroy();

  // 3. Memory Viewer loading hex into mini_sram_demo & synchronous readback
  const sramSim = createSimulator(getPresetById('mini_sram_demo').code);
  const memView = new MemoryViewerPeripheral({ memoryName: 'mem' });
  memView.attach({ sim: sramSim, edgeBus: sramSim.getEdgeBus() });

  sramSim.setInput('KEY', 0b1111);
  sramSim.setInput('KEY', 0b1110);
  sramSim.setInput('KEY', 0b1111);

  const loaded = memView.loadHex('@00\nDE AD BE EF');
  assert.equal(loaded.loadedWords, 4);
  sramSim.setInput('SW', 0x02); // addr = 2, we = 0
  sramSim.stepClock();
  assert.equal(sramSim.getSignal('rdata').val, 0xBEn);
  assert.equal(sramSim.getSignal('LEDR').val & 0xFFn, 0xBEn);
  memView.destroy();
});

// ============================================================================
// Test 4: All 7 Presets (4 v1 + 3 v2) Compile Cleanly & Run 100+ Cycles
// ============================================================================

test('v2.5 All 7 Presets: compile with 0 syntax/DRC errors & warnings and execute 120 cycles cleanly', () => {
  assert.equal(PRESETS.length, 4);
  assert.equal(V2_PRESETS.length, 3);
  assert.equal(ALL_PRESETS.length, 7);

  for (const preset of ALL_PRESETS) {
    assert.ok(preset.title?.en && preset.title?.vi, `Preset ${preset.id} missing bilingual title`);
    assert.ok(preset.description?.en && preset.description?.vi, `Preset ${preset.id} missing bilingual description`);

    const ast = parse(preset.code);
    const device = getBoardDevice(preset.recommendedBoard || 'de2');
    const report = synthesize(ast, { device });

    assert.equal(report.errors.length, 0, `${preset.id} DRC errors: ${JSON.stringify(report.errors)}`);
    assert.equal(report.warnings.length, 0, `${preset.id} DRC warnings: ${JSON.stringify(report.warnings)}`);

    const sim = createSimulator(ast);
    if (ast.signals.SW) sim.setInput('SW', 0);
    if (ast.signals.UART_RX) sim.setInput('UART_RX', 1);
    if (ast.signals.KEY) {
      sim.setInput('KEY', 0b1111);
      sim.setInput('KEY', 0b1110);
      sim.setInput('KEY', 0b1111);
    }

    const res = sim.stepCycles(120, 1000);
    assert.equal(res.cyclesExecuted, 120, `${preset.id} did not execute 120 cycles`);
    assert.equal(res.halted, false, `${preset.id} halted unexpectedly`);
    assert.equal(sim.cycle, 120);
  }
});
