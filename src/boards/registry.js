/**
 * Phase B (v2.5) — Board Profile Registry
 * Centralizes board lookup, port alias resolution, pin-mapping diagnostics,
 * and active target FPGA device capacity for synthesizer.js.
 */

import { BOARD_DE2 } from './de2.js';
import { BOARD_BASYS3 } from './basys3.js';
import { BOARD_HDLAB } from './hdlab.js';

export const DEFAULT_BOARD_ID = 'de2';

export const BOARD_PROFILES = Object.freeze([
  BOARD_DE2,
  BOARD_BASYS3,
  BOARD_HDLAB,
]);

const _BREG_BY_ID = new Map(BOARD_PROFILES.map((b) => [b.id, b]));

/**
 * Retrieve a board profile by ID, falling back to Altera DE2.
 * @param {string} [id]
 */
export function getBoardProfile(id = DEFAULT_BOARD_ID) {
  return _BREG_BY_ID.get(id) || BOARD_DE2;
}

/**
 * List all registered board profiles in display order.
 */
export function listBoardProfiles() {
  return [...BOARD_PROFILES];
}

/**
 * Return the target FPGA device specification passed to `synthesize(ast, { device })`.
 * @param {string|object} [boardOrId]
 */
export function getBoardDevice(boardOrId = DEFAULT_BOARD_ID) {
  const board = typeof boardOrId === 'string' ? getBoardProfile(boardOrId) : (boardOrId || BOARD_DE2);
  return { ...board.device };
}

/**
 * Find the first matching signal name in `astSignals` from a list of aliases.
 * @param {Record<string, object>|null} astSignals
 * @param {string[]} aliases
 * @returns {string|null}
 */
export function findMatchingPort(astSignals, aliases = []) {
  if (!astSignals) return null;
  for (const name of aliases) {
    if (name in astSignals) return name;
  }
  return null;
}

/**
 * Resolve how a top-level HDL port binds to the active board profile's peripherals.
 * Used by the Synthesis Report Pin Mapping table and board I/O routing.
 *
 * @param {string|object} boardOrId
 * @param {string} portName
 */
export function resolveBoardPortBinding(boardOrId, portName) {
  const board = typeof boardOrId === 'string' ? getBoardProfile(boardOrId) : (boardOrId || BOARD_DE2);
  const io = board.io;

  if (board.clock.aliases.includes(portName)) {
    return { bound: true, kind: 'clock', peripheral: `${board.clock.port} (${board.clock.freqLabel})` };
  }

  if (io.switches && io.switches.aliases.includes(portName)) {
    return {
      bound: true,
      kind: 'switches',
      peripheral: `${io.switches.port}[${io.switches.width - 1}:0] Switches`,
    };
  }

  if (io.buttons) {
    if (io.buttons.mode === 'vector' && io.buttons.aliases.includes(portName)) {
      const pol = io.buttons.activeLow ? 'Active-Low' : 'Active-High';
      return {
        bound: true,
        kind: 'buttons',
        peripheral: `${io.buttons.port}[${io.buttons.width - 1}:0] (${pol})`,
      };
    }
    if (io.buttons.mode === 'named') {
      const btn = io.buttons.items.find((b) => b.port === portName);
      if (btn) {
        const pol = io.buttons.activeLow ? 'Active-Low' : 'Active-High';
        return { bound: true, kind: 'button', peripheral: `${btn.label} (${pol})` };
      }
    }
  }

  for (const bank of io.ledBanks || []) {
    if (bank.aliases.includes(portName)) {
      return {
        bound: true,
        kind: 'leds',
        peripheral: `${bank.port}[${bank.width - 1}:0] LEDs`,
      };
    }
  }

  if (io.sevenSeg) {
    if (io.sevenSeg.mode === 'independent') {
      const re = new RegExp(`^${io.sevenSeg.portPrefix}(\\d+)$`);
      const m = re.exec(portName);
      if (m) {
        const idx = parseInt(m[1], 10);
        if (idx >= 0 && idx < io.sevenSeg.count) {
          return {
            bound: true,
            kind: 'sevenSeg',
            peripheral: `${portName}[6:0] 7-Seg (${io.sevenSeg.activeLow ? 'Active-Low' : 'Active-High'})`,
          };
        }
      }
    } else if (io.sevenSeg.mode === 'multiplexed') {
      if (io.sevenSeg.anodeAliases.includes(portName)) {
        return { bound: true, kind: 'sevenSegAnode', peripheral: `an[${io.sevenSeg.count - 1}:0] 7-Seg Anodes (Active-Low)` };
      }
      if (io.sevenSeg.segAliases.includes(portName)) {
        return { bound: true, kind: 'sevenSegCathode', peripheral: 'seg[6:0] 7-Seg Cathodes (Active-Low)' };
      }
      if (io.sevenSeg.dpAliases && io.sevenSeg.dpAliases.includes(portName)) {
        return { bound: true, kind: 'sevenSegDp', peripheral: 'dp 7-Seg Decimal Point (Active-Low)' };
      }
    }
  }

  for (const hdr of io.headers || []) {
    if (hdr.aliases && hdr.aliases.includes(portName)) {
      return {
        bound: true,
        kind: 'header',
        peripheral: hdr.silkLabel || `${hdr.name}[${hdr.width - 1}:0]`,
      };
    }
  }

  if (io.extraPorts && portName in io.extraPorts) {
    return { bound: true, kind: 'peripheralHeader', peripheral: io.extraPorts[portName] };
  }

  return { bound: false, kind: null, peripheral: null };
}
