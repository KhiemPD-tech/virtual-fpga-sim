/**
 * Phase B (v2.5) — Expansion Peripheral Registry & Dynamic Port Binding Resolver
 */

import { UART_TERMINAL_MANIFEST } from './uart_terminal.js';
import { PWM_SERVO_MANIFEST } from './pwm_servo.js';
import { BUZZER_AUDIO_MANIFEST } from './buzzer_audio.js';
import { ADC_SENSOR_MANIFEST } from './adc_sensor.js';
import { MEMORY_VIEWER_MANIFEST } from './memory_viewer.js';
import { parseSignalSpec } from '../engine/edge_bus.js';

export const PERIPHERAL_MANIFESTS = Object.freeze([
  UART_TERMINAL_MANIFEST,
  PWM_SERVO_MANIFEST,
  BUZZER_AUDIO_MANIFEST,
  ADC_SENSOR_MANIFEST,
  MEMORY_VIEWER_MANIFEST,
]);

const _PREG_BY_ID = new Map(PERIPHERAL_MANIFESTS.map((m) => [m.id, m]));

export function getPeripheralManifest(id) {
  return _PREG_BY_ID.get(id) || null;
}

/**
 * List bindable top-level port specifiers (including bit slices like GPIO[0], LEDG[0])
 * filtered by direction (`from_rtl` = outputs/inouts, `to_rtl` = inputs/inouts).
 *
 * @param {object|null} ast
 * @param {'from_rtl'|'to_rtl'|'any'} [dirFilter='any']
 * @returns {string[]}
 */
export function listBindablePortOptions(ast, dirFilter = 'any') {
  if (!ast || !ast.ports) return [];
  const options = [];
  const seen = new Set();
  const add = (spec) => {
    if (!seen.has(spec)) {
      seen.add(spec);
      options.push(spec);
    }
  };

  for (const port of ast.ports) {
    const isInput = port.dir === 'input' || port.dir === 'inout';
    const isOutput = port.dir === 'output' || port.dir === 'inout';
    if (dirFilter === 'to_rtl' && !isInput) continue;
    if (dirFilter === 'from_rtl' && !isOutput) continue;

    add(port.name);
    if (port.width > 1) {
      const bitCap = Math.min(port.width, 8);
      for (let b = 0; b < bitCap; b++) {
        add(`${port.name}[${b}]`);
      }
    }
  }
  return options;
}

/**
 * Automatically bind peripheral manifest pins against matching top-level AST ports
 * using each pin's ordered alias list (e.g. UART_TX, PWM, BUZZ, ADC_DATA, GPIO[0]).
 *
 * @param {object} manifest
 * @param {object|null} ast
 * @param {Record<string, string>} [preferred={}]
 * @returns {Record<string, string>}
 */
export function autoBindPeripheralPins(manifest, ast, preferred = {}) {
  const result = {};
  if (!manifest || !manifest.pins) return result;
  const sigs = ast?.signals || {};

  const portExists = (spec) => {
    if (!spec) return false;
    const parsed = parseSignalSpec(spec, 0);
    const sig = sigs[parsed.signal];
    if (!sig) return false;
    return parsed.bit < sig.width;
  };

  for (const pin of manifest.pins) {
    if (preferred[pin.id] && portExists(preferred[pin.id])) {
      result[pin.id] = preferred[pin.id];
      continue;
    }

    let matched = '';
    for (const alias of pin.aliases || []) {
      if (portExists(alias)) {
        matched = alias;
        break;
      }
    }
    result[pin.id] = matched;
  }

  return result;
}
