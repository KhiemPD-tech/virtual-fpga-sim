/**
 * Phase 4 / v2.5 — Main Application Controller
 * Connects Lexer -> Parser/Elaborator -> Synthesizer -> 4-State Simulator & EdgeBus ->
 * Multi-Board SVG Renderer, Expansion Peripheral Dock, HiDPI Logic Analyzer,
 * Bilingual i18n, and Decoupled Clock + Time-Sliced 60 FPS Render Loop.
 */

import {
  t,
  formatDiagnostic,
  getLanguage,
  setLanguage,
  applyTranslations,
} from './i18n.js';
import {
  preprocessWorkspace,
  validateUploadedHdlFile,
  mapDiagnosticToSource,
} from './engine/preprocessor.js';
import { parseProgram } from './engine/parser.js';
import {
  CLOCK_PORT_ALIASES,
  logic4ToString,
  Simulator,
} from './engine/simulator.js';
import { runTestbench } from './engine/testbench.js';
import {
  synthesize,
  selectTopModule,
  isTestbenchModule,
} from './engine/synthesizer.js';
import {
  exportVCD,
  exportConstraints,
  serializeWorkspace,
  deserializeWorkspace,
  downloadTextFile,
  readTextFileFromInput,
  readBinaryFileFromInput,
} from './engine/exporters.js';
import {
  DEFAULT_BOARD_ID,
  listBoardProfiles,
  getBoardProfile,
  getBoardDevice,
  resolveBoardPortBinding,
} from './boards/registry.js';
import {
  PRESETS,
  V2_PRESETS,
  COURSE_LAB_PRESETS,
  ALL_PRESETS,
  getPresetById,
} from './presets.js';
import { HdlEditor } from './ui/editor.js';
import { FpgaBoard } from './ui/board.js';
import { WaveformViewer } from './ui/waveform.js';
import { PeripheralDock } from './ui/peripheral_dock.js';

function _mainBuildOrderedSignals(ast, clockPort) {
  if (!ast) return [];
  const rankOf = (sig) => {
    if (sig.name === clockPort || CLOCK_PORT_ALIASES.includes(sig.name)) return 0;
    if (sig.name === 'KEY' || sig.name === 'BTN' || sig.name.startsWith('btn')) return 1;
    if (sig.name === 'SW' || sig.name === 'sw') return 2;
    if (sig.dir === 'input') return 3;
    if (sig.name === 'LEDR' || sig.name === 'LED' || sig.name === 'led') return 4;
    if (sig.name === 'LEDG') return 5;
    if (/^HEX[0-7]$/.test(sig.name) || sig.name === 'seg' || sig.name === 'an') return 6;
    if (sig.dir === 'output' || sig.dir === 'inout') return 7;
    return 8;
  };

  return Object.values(ast.signals)
    .map((s) => ({
      name: s.name,
      width: s.width ?? 1,
      dir: s.dir || 'internal',
      isClock: s.name === clockPort || CLOCK_PORT_ALIASES.includes(s.name),
    }))
    .sort((a, b) => {
      const ra = rankOf(a);
      const rb = rankOf(b);
      if (ra !== rb) return ra - rb;
      return a.name.localeCompare(b.name);
    });
}

export function initApp() {
  if (typeof document === 'undefined') {
    return null;
  }

  // Toolbar controls
  const platformBadgeEl = document.getElementById('platform-badge');
  const boardSelect = document.getElementById('board-select');
  const presetSelect = document.getElementById('preset-select');
  const btnModeBoard = document.getElementById('btn-mode-board');
  const btnModeTb = document.getElementById('btn-mode-tb');
  const boardControlsEl = document.getElementById('board-controls');
  const tbControlsEl = document.getElementById('tb-controls');
  const btnRunTb = document.getElementById('btn-run-tb');
  const tbMaxTimeInput = document.getElementById('tb-max-time');
  const btnCompile = document.getElementById('btn-compile');
  const btnRun = document.getElementById('btn-run');
  const btnPause = document.getElementById('btn-pause');
  const btnStep = document.getElementById('btn-step');
  const btnReset = document.getElementById('btn-reset');
  const clockSpeedSelect = document.getElementById('clock-speed');
  const toggleBounce = document.getElementById('toggle-bounce');
  const btnSaveLab = document.getElementById('btn-save-lab');
  const btnLoadLab = document.getElementById('btn-load-lab');
  const inputLoadLab = document.getElementById('input-load-lab');
  const btnLangToggle = document.getElementById('btn-lang-toggle');
  const btnClearConsole = document.getElementById('btn-clear-console');

  // Synthesis export & modal elements
  const btnExportFpga = document.getElementById('btn-export-fpga');
  const synthModuleSummaryEl = document.getElementById('synth-module-summary');
  const exportModalEl = document.getElementById('export-modal');
  const btnExportClose = document.getElementById('btn-export-close');
  const exportModalMetaEl = document.getElementById('export-modal-meta');
  const exportHdlNameEl = document.getElementById('export-hdl-name');
  const exportHdlPreEl = document.getElementById('export-hdl-pre');
  const exportConNameEl = document.getElementById('export-con-name');
  const exportConPreEl = document.getElementById('export-con-pre');
  const exportModalStatusEl = document.getElementById('export-modal-status');
  const btnCopyHdl = document.getElementById('btn-copy-hdl');
  const btnDlHdl = document.getElementById('btn-dl-hdl');
  const btnCopyCon = document.getElementById('btn-copy-con');
  const btnDlCon = document.getElementById('btn-dl-con');
  const btnDlBoth = document.getElementById('btn-dl-both');

  // Editor & Board header elements
  const editorFilenameEl = document.getElementById('editor-filename');
  const btnImportHdl = document.getElementById('btn-import-hdl');
  const btnDownloadHdl = document.getElementById('btn-download-hdl');
  const inputImportHdl = document.getElementById('input-import-hdl');
  const presetDescBar = document.getElementById('preset-desc-bar');
  const presetDescText = document.getElementById('preset-desc-text');
  const btnQuickTb = document.getElementById('btn-quick-tb');
  const statusBadge = document.getElementById('editor-status-badge');
  const cursorPosEl = document.getElementById('editor-cursor-pos');
  const boardPanelEl = document.getElementById('board-panel');
  const boardPanelTitleEl = document.getElementById('board-panel-title');
  const boardRootEl = document.getElementById('board-root');
  const tbSummaryBarEl = document.getElementById('tb-summary-bar');
  const boardShortcutHintEl = document.getElementById('board-shortcut-hint');
  const cycleCounterEl = document.getElementById('cycle-counter');

  // Dock badges & panels
  const periphCountBadge = document.getElementById('periph-count-badge');
  const synthDrcBadge = document.getElementById('synth-drc-badge');
  const consoleErrBadge = document.getElementById('console-err-badge');
  const consoleLogEl = document.getElementById('console-log');

  // Synthesis Report elements
  const synthLutsEl = document.getElementById('synth-luts-val');
  const synthFfsEl = document.getElementById('synth-ffs-val');
  const synthLesEl = document.getElementById('synth-les-val');
  const synthDspSubEl = document.getElementById('synth-dsp-sub');
  const synthDepthEl = document.getElementById('synth-depth-val');
  const synthDelaySubEl = document.getElementById('synth-delay-sub');
  const synthMemEl = document.getElementById('synth-mem-val');
  const synthBramSubEl = document.getElementById('synth-bram-sub');
  const synthHierTbody = document.getElementById('synth-hier-tbody');
  const synthUtilText = document.getElementById('synth-util-text');
  const synthUtilBar = document.getElementById('synth-util-bar');
  const synthDeviceNameEl = document.getElementById('synth-device-name');
  const synthDrcList = document.getElementById('synth-drc-list');
  const synthPinTbody = document.getElementById('synth-pin-tbody');

  // Core simulation & UI state
  const sim = new Simulator();
  let activeSim = sim;
  let simMode = 'board'; // 'board' | 'testbench'
  let activeBoardId = DEFAULT_BOARD_ID;
  let currentPreset = ALL_PRESETS[0]; // Default: bcd_counter
  let lastAst = null;
  let lastDutAst = null;
  let lastReport = null;
  let lastTbResult = null;
  let lastDiagnostics = [];
  let lastSourceMap = [];

  let cursorState = { line: 1, col: 1 };
  let statusKey = 'editor.statusReady';
  let statusClass = 'status-ready';
  let consoleErrCount = 0;

  // Decoupled simulation timer + time-sliced high-speed rAF runner
  let clockTimerId = null;
  let batchRafId = null;
  let batchLastTs = 0;
  let batchCycleCarry = 0;
  let activeFreqHz = 5;
  let isRunning = false;
  let uiDirty = false;
  let rafId = null;
  let unsubMuxEdge = null;

  // Tab switching helper
  const dockTabs = document.querySelectorAll('.dock-tab');
  const dockPanes = document.querySelectorAll('.dock-pane');
  const activateDockTab = (tabName) => {
    for (const btn of dockTabs) {
      const active = btn.getAttribute('data-tab') === tabName;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    for (const pane of dockPanes) {
      pane.classList.toggle('active', pane.id === `tab-${tabName}`);
    }
    if (tabName === 'waveform' || tabName === 'peripherals') {
      scheduleRender();
    }
  };

  for (const tabBtn of dockTabs) {
    tabBtn.addEventListener('click', () => {
      activateDockTab(tabBtn.getAttribute('data-tab'));
    });
  }

  const appendConsole = (message, level = 'info', location = null) => {
    if (!consoleLogEl) return;
    const now = new Date();
    const ts = now.toTimeString().slice(0, 8);
    const tagMap = { info: 'INFO', ok: 'OK', warn: 'WARN', error: 'ERR' };
    const tag = tagMap[level] || 'INFO';

    const row = document.createElement('div');
    row.className = `log-line log-${level}`;

    const tsSpan = document.createElement('span');
    tsSpan.className = 'log-ts';
    tsSpan.textContent = `[${ts}]`;

    const tagSpan = document.createElement('span');
    tagSpan.className = `log-tag log-tag-${level}`;
    tagSpan.textContent = tag;

    row.appendChild(tsSpan);
    row.appendChild(tagSpan);
    row.appendChild(document.createTextNode(message));

    if (location && Number.isInteger(Number(location.line)) && Number(location.line) >= 1) {
      const ln = Number(location.line);
      const file = location.file || null;
      row.classList.add('is-clickable');
      row.title = file
        ? t('synth.drcJumpFileTip', { file, line: ln })
        : t('synth.drcJumpTip', { line: ln });
      row.addEventListener('click', () => editor.scrollToLine(ln, file));
    }

    consoleLogEl.appendChild(row);
    consoleLogEl.scrollTop = consoleLogEl.scrollHeight;

    if (level === 'error' && consoleErrBadge) {
      consoleErrCount += 1;
      consoleErrBadge.textContent = String(consoleErrCount);
      consoleErrBadge.classList.remove('hidden');
      consoleErrBadge.classList.add('has-error');
    }
  };

  const setEditorStatus = (i18nKey, cssClass) => {
    statusKey = i18nKey;
    statusClass = cssClass;
    if (!statusBadge) return;
    statusBadge.className = `status-badge ${cssClass}`;
    statusBadge.textContent = t(i18nKey);
  };

  const renderCursor = () => {
    if (cursorPosEl) cursorPosEl.textContent = t('editor.cursorPos', cursorState);
  };

  const renderCycle = () => {
    if (!cycleCounterEl) return;
    if (simMode === 'testbench') {
      const endTime = lastTbResult ? lastTbResult.stats.endTime : 0;
      cycleCounterEl.textContent = t('tb.timeCounter', { time: endTime });
    } else {
      cycleCounterEl.textContent = t('board.cycle', { count: sim.cycle });
    }
  };

  const renderTbSummary = () => {
    if (!tbSummaryBarEl) return;
    tbSummaryBarEl.innerHTML = '';
    if (!lastTbResult) {
      const empty = document.createElement('div');
      empty.className = 'tb-empty-note';
      empty.textContent = t('tb.emptySummary');
      tbSummaryBarEl.appendChild(empty);
      return;
    }

    const r = lastTbResult;
    const metaRow = document.createElement('div');
    metaRow.className = 'tb-meta-row';
    const pills = [
      [t('tb.statTb'), r.topModule, ''],
      [t('tb.statDut'), r.dutModule || '-', ''],
      [t('tb.statEnd'), `${r.stats.endTime} ns`, 'is-ok'],
      [t('tb.statEvents'), String(r.stats.eventsExecuted), ''],
      [t('tb.statHalt'), r.stats.haltedBy, r.stats.haltedBy === '$finish' || r.stats.haltedBy === 'completed' ? 'is-ok' : 'is-warn'],
    ];
    for (const [k, v, cls] of pills) {
      const sp = document.createElement('span');
      sp.className = `tb-pill${cls ? ` ${cls}` : ''}`;
      sp.appendChild(document.createTextNode(`${k}: `));
      const st = document.createElement('strong');
      st.textContent = v;
      sp.appendChild(st);
      metaRow.appendChild(sp);
    }
    tbSummaryBarEl.appendChild(metaRow);

    // Compact DUT Signal Watch (final values of top-level TB & DUT signals)
    const watchGrid = document.createElement('div');
    watchGrid.className = 'tb-watch-grid';
    const sigEntries = Object.values(r.sim.ast.signals || {})
      .filter((s) => !s.name.includes('.') && !s.isInteger)
      .slice(0, 14);
    for (const sig of sigEntries) {
      const sv = r.sim.getSignal(sig.name);
      const chip = document.createElement('span');
      chip.className = 'tb-watch-chip';
      const nEl = document.createElement('span');
      nEl.className = 'tb-w-name';
      nEl.textContent = sig.width > 1 ? `${sig.name}[${sig.width - 1}:0]` : sig.name;
      const vEl = document.createElement('span');
      const vStr = sig.width === 1 ? logic4ToString(sv, 'bin') : `0x${logic4ToString(sv, 'hex')}`;
      vEl.className = `tb-w-val${sv.xMask !== 0n ? ' val-x' : (sv.zMask !== 0n ? ' val-z' : '')}`;
      vEl.textContent = vStr;
      chip.appendChild(nEl);
      chip.appendChild(vEl);
      watchGrid.appendChild(chip);
    }
    if (watchGrid.childNodes.length > 0) {
      tbSummaryBarEl.appendChild(watchGrid);
    }
  };

  const setSimMode = (nextMode, opts = {}) => {
    const mode = nextMode === 'testbench' ? 'testbench' : 'board';
    simMode = mode;
    if (mode === 'testbench') pauseClock(true);

    if (btnModeBoard) btnModeBoard.classList.toggle('is-active', mode === 'board');
    if (btnModeTb) btnModeTb.classList.toggle('is-active', mode === 'testbench');
    if (boardControlsEl) boardControlsEl.classList.toggle('hidden', mode === 'testbench');
    if (tbControlsEl) tbControlsEl.classList.toggle('hidden', mode !== 'testbench');
    if (boardPanelEl) boardPanelEl.classList.toggle('is-tb-mode', mode === 'testbench');
    if (boardRootEl) boardRootEl.classList.toggle('hidden', mode === 'testbench');
    if (boardShortcutHintEl) boardShortcutHintEl.classList.toggle('hidden', mode === 'testbench');
    if (tbSummaryBarEl) tbSummaryBarEl.classList.toggle('hidden', mode !== 'testbench');

    if (boardPanelTitleEl) {
      boardPanelTitleEl.textContent = t(mode === 'testbench' ? 'tb.panelTitle' : 'board.title');
    }

    waveform.setTimeMode(mode === 'testbench');
    if (mode === 'testbench') {
      renderTbSummary();
    } else {
      activeSim = sim;
    }
    renderCycle();
    updateQuickTbButton();

    if (opts.run) {
      compileAndSynthesize();
    } else {
      scheduleRender();
    }
  };

  const renderBoardHeaderMeta = () => {
    const profile = getBoardProfile(activeBoardId);
    if (platformBadgeEl) platformBadgeEl.textContent = profile.badge;
    if (boardShortcutHintEl) boardShortcutHintEl.textContent = t(profile.shortcutHintKey || 'board.de2.hint');
    if (synthDeviceNameEl) synthDeviceNameEl.textContent = profile.device.name;
    if (typeof document !== 'undefined') {
      document.title = `Virtual FPGA Simulator — ${profile.badge}`;
    }
  };

  const populateBoards = () => {
    if (!boardSelect) return;
    boardSelect.innerHTML = '';
    for (const bp of listBoardProfiles()) {
      const opt = document.createElement('option');
      opt.value = bp.id;
      opt.textContent = t(bp.nameKey);
      if (bp.id === activeBoardId) opt.selected = true;
      boardSelect.appendChild(opt);
    }
    renderBoardHeaderMeta();
  };

  let editor = null;

  const updateQuickTbButton = () => {
    if (!btnQuickTb || !editor) return;
    const hasTb = editor.getFiles().some((f) => /^tb_/i.test(f.name) || /\bmodule\s+tb_/i.test(f.content));
    btnQuickTb.classList.toggle('hidden', !hasTb || simMode === 'testbench');
  };

  const renderPresetMeta = () => {
    const lang = getLanguage();
    if (editorFilenameEl) {
      if (editor) {
        editorFilenameEl.textContent = editor.getActiveFile().name;
      } else if (currentPreset) {
        editorFilenameEl.textContent = currentPreset.filename || `${currentPreset.id}.sv`;
      }
    }
    const descTarget = presetDescText || presetDescBar;
    if (descTarget && currentPreset) {
      descTarget.textContent = currentPreset.description?.[lang] || currentPreset.description?.en || '';
    }
    updateQuickTbButton();
  };

  const populatePresets = () => {
    if (!presetSelect) return;
    const lang = getLanguage();
    const activeId = currentPreset ? currentPreset.id : ALL_PRESETS[0].id;
    presetSelect.innerHTML = '';

    const groups = [
      { labelKey: 'preset.group.v1', list: PRESETS },
      { labelKey: 'preset.group.v2', list: V2_PRESETS },
      { labelKey: 'preset.group.labs', list: COURSE_LAB_PRESETS },
    ];
    for (const grp of groups) {
      if (!grp.list || grp.list.length === 0) continue;
      const og = document.createElement('optgroup');
      og.label = t(grp.labelKey);
      for (const preset of grp.list) {
        const opt = document.createElement('option');
        opt.value = preset.id;
        opt.textContent = preset.title?.[lang] || preset.title?.en || preset.name;
        if (preset.id === activeId) opt.selected = true;
        og.appendChild(opt);
      }
      presetSelect.appendChild(og);
    }
    renderPresetMeta();
  };

  // Mount UI components
  editor = new HdlEditor(document.getElementById('editor-root'), {
    initialFiles: [
      {
        name: currentPreset.filename || `${currentPreset.id}.sv`,
        content: currentPreset.code,
      },
    ],
    onCursorChange: (pos) => {
      cursorState = pos;
      renderCursor();
    },
    onFilesDrop: (fileList) => {
      handleUploadedFiles(fileList);
    },
    onActiveFileChange: (activeFile) => {
      if (editorFilenameEl && activeFile?.name) {
        editorFilenameEl.textContent = activeFile.name;
      }
    },
  });

  const waveform = new WaveformViewer(document.getElementById('waveform-root'));

  const peripheralDock = new PeripheralDock(document.getElementById('peripherals-root'), {
    onCountChange: (count) => {
      if (!periphCountBadge) return;
      periphCountBadge.textContent = String(count);
      periphCountBadge.classList.toggle('hidden', count === 0);
    },
  });

  const pushAllBoardInputsToSim = () => {
    if (!sim.ast) return;
    const inputs = board.getInputs();
    const sigs = sim.ast.signals;
    for (const [portName, val] of Object.entries(inputs)) {
      if (portName in sigs && sigs[portName].dir === 'input') {
        sim.setInput(portName, val);
      }
    }
  };

  const renderBoardFromSim = () => {
    if (!sim.ast) return;
    const sigs = sim.ast.signals;
    const clkName = sim.getClockPort();
    const outputs = {
      clk: sigs[clkName] ? sim.getSignal(clkName) : 0n,
    };

    for (const sigName of Object.keys(sigs)) {
      if (sigName === clkName) continue;
      if (!sigName.includes('.')) {
        outputs[sigName] = sim.getSignal(sigName);
      }
    }

    board.updateOutputs(outputs);
  };

  const flushRender = () => {
    rafId = null;
    if (!uiDirty) return;
    uiDirty = false;
    if (simMode === 'board') {
      renderBoardFromSim();
    } else {
      renderTbSummary();
    }
    renderCycle();
    waveform.render();
    peripheralDock.onFrame();
  };

  const scheduleRender = () => {
    uiDirty = true;
    if (rafId === null && typeof requestAnimationFrame === 'function') {
      rafId = requestAnimationFrame(flushRender);
    } else if (typeof requestAnimationFrame !== 'function') {
      flushRender();
    }
  };

  const handleRuntimeHalt = () => {
    if (!sim.halted) return false;
    pauseClock(true);
    setEditorStatus('editor.statusHalted', 'status-error');
    if (sim.runtimeError) {
      appendConsole(formatDiagnostic(sim.runtimeError), 'error');
    } else {
      appendConsole(t('console.simHalted'), 'error');
    }
    activateDockTab('console');
    scheduleRender();
    return true;
  };

  const mapBoardInputToSim = (name, value) => {
    if (!sim.ast) return;
    const sigs = sim.ast.signals;
    const profile = board.getBoardProfile();
    const candidates = [name];
    if (profile.io.switches && profile.io.switches.port === name) {
      candidates.push(...profile.io.switches.aliases);
    }
    if (profile.io.buttons?.mode === 'vector' && profile.io.buttons.port === name) {
      candidates.push(...profile.io.buttons.aliases);
    }

    const applied = new Set();
    for (const target of candidates) {
      if (!applied.has(target) && target in sigs) {
        applied.add(target);
        sim.setInput(target, value);
      }
    }
  };

  const board = new FpgaBoard(document.getElementById('board-root'), {
    boardId: activeBoardId,
    onInputChange: (name, value) => {
      if (!sim.ast) return;
      mapBoardInputToSim(name, value);
      waveform.pushSample({ ...sim.getSnapshot(), phase: 'input' });

      if (name === 'KEY' || name === 'BTN') {
        appendConsole(
          t('console.keyInput', {
            signal: name,
            hex: value.toString(16).toUpperCase(),
            bin: value.toString(2).padStart(4, '0'),
          }),
          'info'
        );
      }

      if (!handleRuntimeHalt()) {
        scheduleRender();
      }
    },
  });

  const makePeripheralCtx = () => ({
    sim: activeSim,
    edgeBus: activeSim.getEdgeBus(),
    board: board.getBoardProfile(),
    getClockFreqHz: () => activeFreqHz,
    onExternalInput: () => {
      if (simMode === 'board' && sim.ast) {
        waveform.pushSample({ ...sim.getSnapshot(), phase: 'input' });
        if (!handleRuntimeHalt()) scheduleRender();
      }
    },
  });

  const hookBasys3MuxPov = () => {
    if (unsubMuxEdge) {
      unsubMuxEdge();
      unsubMuxEdge = null;
    }
    const profile = board.getBoardProfile();
    const segSpec = profile.io.sevenSeg;
    if (!segSpec || segSpec.mode !== 'multiplexed' || !sim.ast) return;

    const sigs = sim.ast.signals;
    const anPort = segSpec.anodeAliases.find((a) => a in sigs);
    const segPort = segSpec.segAliases.find((s) => s in sigs);
    const dpPort = (segSpec.dpAliases || []).find((d) => d in sigs);
    if (!anPort || !segPort) return;

    const unsubs = [];
    for (let bit = 0; bit < segSpec.count; bit++) {
      unsubs.push(
        sim.getEdgeBus().subscribe(
          anPort,
          () => {
            board.recordMuxSample(
              sim.getSignal(anPort),
              sim.getSignal(segPort),
              dpPort ? sim.getSignal(dpPort) : 1n
            );
          },
          { bit, edge: 'both' }
        )
      );
    }
    unsubMuxEdge = () => { for (const fn of unsubs) fn(); };
  };

  const renderSynthesisReport = (ast, report) => {
    if (!report) return;
    const profile = board.getBoardProfile();

    if (synthModuleSummaryEl) {
      const subCount = report.hierarchy?.children?.length || 0;
      synthModuleSummaryEl.textContent = subCount > 0
        ? `${report.moduleName} (+${subCount} sub)`
        : report.moduleName;
    }

    if (synthLutsEl) synthLutsEl.textContent = String(report.luts);
    if (synthFfsEl) synthFfsEl.textContent = String(report.ffs);
    if (synthLesEl) synthLesEl.textContent = String(report.estimatedLEs);
    if (synthDspSubEl) synthDspSubEl.textContent = `DSP: ${report.dspBlocks ?? 0}`;
    if (synthDepthEl) synthDepthEl.textContent = t('synth.logicDepthVal', { depth: report.logicDepth ?? 0 });
    if (synthDelaySubEl) synthDelaySubEl.textContent = `~${Number(report.estimatedDelayNs ?? 0).toFixed(2)} ns`;
    if (synthMemEl) synthMemEl.textContent = `${report.memoryBits ?? 0} b`;
    if (synthBramSubEl) synthBramSubEl.textContent = `BRAM: ${report.bramBlocks ?? 0}`;
    if (synthDeviceNameEl) synthDeviceNameEl.textContent = report.device || profile.device.name;

    // Render Module Hierarchy Breakdown Table (per-instance LUTs, FFs, Mem Bits, Logic Depth)
    if (synthHierTbody && report.hierarchy) {
      synthHierTbody.innerHTML = '';
      const appendHierRows = (node, depth) => {
        const tr = document.createElement('tr');
        const tdMod = document.createElement('td');
        if (depth > 0) {
          const ind = document.createElement('span');
          ind.className = 'hier-indent';
          ind.textContent = `${'  '.repeat(depth - 1)}└─`;
          tdMod.appendChild(ind);
        }
        tdMod.appendChild(document.createTextNode(node.instanceName || node.moduleName));
        if (node.moduleName && node.moduleName !== node.instanceName) {
          const tag = document.createElement('span');
          tag.className = 'hier-mod-tag';
          tag.textContent = `(${node.moduleName})`;
          tdMod.appendChild(tag);
        }

        const tdLuts = document.createElement('td');
        tdLuts.textContent = String(node.luts ?? 0);
        const tdFfs = document.createElement('td');
        tdFfs.textContent = String(node.ffs ?? 0);
        const tdMem = document.createElement('td');
        tdMem.textContent = `${node.memBits ?? node.memoryBits ?? 0} b`;
        const tdDepth = document.createElement('td');
        tdDepth.textContent = String(node.logicDepth ?? 0);

        tr.appendChild(tdMod);
        tr.appendChild(tdLuts);
        tr.appendChild(tdFfs);
        tr.appendChild(tdMem);
        tr.appendChild(tdDepth);
        synthHierTbody.appendChild(tr);

        for (const ch of node.children || []) {
          appendHierRows(ch, depth + 1);
        }
      };
      appendHierRows(report.hierarchy, 0);
    }

    const pctFixed = Number(report.utilizationPct || 0).toFixed(2);
    if (synthUtilText) {
      synthUtilText.textContent = t('synth.utilizationDetail', {
        used: report.estimatedLEs.toLocaleString(),
        total: report.totalLEs.toLocaleString(),
        pct: pctFixed,
      });
    }
    if (synthUtilBar) {
      const barPct = report.estimatedLEs > 0 ? Math.max(1, Math.min(100, report.utilizationPct)) : 0;
      synthUtilBar.style.width = `${barPct}%`;
    }

    if (synthDrcList) {
      synthDrcList.innerHTML = '';
      if (report.diagnostics.length === 0) {
        const clean = document.createElement('div');
        clean.className = 'drc-clean';
        clean.textContent = t('synth.drcClean');
        synthDrcList.appendChild(clean);
      } else {
        for (const diag of report.diagnostics) {
          const item = document.createElement('div');
          item.className = `drc-item drc-${diag.severity === 'error' ? 'error' : 'warning'}`;
          item.textContent = formatDiagnostic(diag);
          if (diag.line != null) {
            item.title = diag.file
              ? t('synth.drcJumpFileTip', { file: diag.file, line: diag.line })
              : t('synth.drcJumpTip', { line: diag.line });
            item.addEventListener('click', () => editor.scrollToLine(diag.line, diag.file || null));
          }
          synthDrcList.appendChild(item);
        }
      }
    }

    if (synthDrcBadge) {
      const count = report.diagnostics.length;
      if (count > 0) {
        synthDrcBadge.textContent = String(count);
        synthDrcBadge.classList.remove('hidden');
        synthDrcBadge.classList.toggle('has-error', report.errors.length > 0);
      } else {
        synthDrcBadge.classList.add('hidden');
      }
    }

    if (synthPinTbody && ast) {
      synthPinTbody.innerHTML = '';
      for (const port of ast.ports) {
        const tr = document.createElement('tr');
        const rangeText = port.width > 1 ? `[${port.msb}:${port.lsb}] (${port.width}b)` : '1b';
        const binding = resolveBoardPortBinding(profile, port.name);

        const tdPort = document.createElement('td');
        tdPort.textContent = port.name;

        const tdDir = document.createElement('td');
        tdDir.textContent = port.dir || 'internal';

        const tdWidth = document.createElement('td');
        tdWidth.textContent = rangeText;

        const tdPerip = document.createElement('td');
        const pill = document.createElement('span');
        pill.className = `pin-status ${binding.bound ? 'pin-bound' : 'pin-unbound'}`;
        pill.textContent = binding.bound ? t('synth.pinBound') : t('synth.pinUnbound');
        tdPerip.appendChild(pill);
        if (binding.peripheral) {
          tdPerip.appendChild(document.createTextNode(binding.peripheral));
        }

        tr.appendChild(tdPort);
        tr.appendChild(tdDir);
        tr.appendChild(tdWidth);
        tr.appendChild(tdPerip);
        synthPinTbody.appendChild(tr);
      }
    }
  };

  // ==========================================================================
  // Clock Loop Controls (Low-Freq Timer + High-Speed Time-Sliced rAF Batching)
  // ==========================================================================

  const syncRunButtons = () => {
    if (btnRun) btnRun.classList.toggle('is-active', isRunning);
  };

  const pauseClock = (silent = false) => {
    if (clockTimerId !== null) {
      clearInterval(clockTimerId);
      clockTimerId = null;
    }
    if (batchRafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(batchRafId);
      batchRafId = null;
    }
    const wasRunning = isRunning;
    isRunning = false;
    syncRunButtons();
    if (wasRunning && !silent) {
      setEditorStatus('editor.statusPaused', 'status-ready');
      appendConsole(t('console.simPaused', { cycle: sim.cycle }), 'info');
    }
  };

  const stepOneFullCycle = () => {
    if (!sim.ast || sim.halted) return;
    sim.stepClock(undefined, (phase, snap) => {
      waveform.pushSample({ ...snap, phase });
    });
    if (!handleRuntimeHalt()) {
      scheduleRender();
    }
  };

  const startClock = () => {
    if (!sim.ast) return;
    if (sim.halted) {
      handleRuntimeHalt();
      return;
    }

    let speedVal = clockSpeedSelect ? clockSpeedSelect.value : '5';
    if (speedVal === 'manual') {
      speedVal = '5';
      if (clockSpeedSelect) clockSpeedSelect.value = '5';
    }
    const freqHz = Number(speedVal) || 5;
    activeFreqHz = freqHz;

    pauseClock(true);
    isRunning = true;
    syncRunButtons();
    setEditorStatus('editor.statusRunning', 'status-compiled');
    appendConsole(t('console.simStarted', { freq: freqHz }), 'info');

    if (freqHz <= 20) {
      const halfMs = Math.max(16, Math.round(500 / freqHz));
      clockTimerId = setInterval(() => {
        if (!sim.ast || sim.halted) {
          handleRuntimeHalt();
          return;
        }
        const res = sim.stepHalfClock();
        waveform.pushSample({ ...sim.getSnapshot(), phase: res.phase });
        if (!handleRuntimeHalt()) scheduleRender();
      }, halfMs);
    } else if (freqHz <= 100) {
      const tickMs = Math.max(10, Math.round(1000 / freqHz));
      clockTimerId = setInterval(() => {
        if (!sim.ast || sim.halted) {
          handleRuntimeHalt();
          return;
        }
        sim.stepClock(undefined, (phase, snap) => {
          waveform.pushSample({ ...snap, phase });
        });
        if (!handleRuntimeHalt()) scheduleRender();
      }, tickMs);
    } else {
      // High-speed batched execution (500 Hz, 2 kHz, 10 kHz) via stepCycles inside rAF (8ms budget)
      batchLastTs = typeof performance !== 'undefined' ? performance.now() : Date.now();
      batchCycleCarry = 0;

      const runBatchFrame = (nowTs) => {
        if (!isRunning) return;
        if (!sim.ast || sim.halted) {
          handleRuntimeHalt();
          return;
        }
        const elapsedSec = Math.min(0.05, Math.max(0.001, (nowTs - batchLastTs) / 1000));
        batchLastTs = nowTs;
        const totalCycles = elapsedSec * freqHz + batchCycleCarry;
        const wholeCycles = Math.floor(totalCycles);
        batchCycleCarry = totalCycles - wholeCycles;

        if (wholeCycles > 0) {
          const res = sim.stepCycles(wholeCycles, 8);
          if (res.cyclesExecuted > 0) {
            waveform.pushSample({ ...sim.getSnapshot(), phase: 'batch' });
          }
        }

        if (!handleRuntimeHalt()) {
          renderBoardFromSim();
          renderCycle();
          waveform.render();
          peripheralDock.onFrame();
          batchRafId = requestAnimationFrame(runBatchFrame);
        }
      };
      batchRafId = requestAnimationFrame(runBatchFrame);
    }
  };

  // ==========================================================================
  // Compile & Synthesize Pipeline (Board Mode + Testbench Mode)
  // ==========================================================================

  const executeTestbench = (prog, pp, tbTop) => {
    const maxTime = Math.max(10, Math.min(100000, Number(tbMaxTimeInput?.value) || 10000));
    const device = getBoardDevice(activeBoardId);
    const res = runTestbench(prog, {
      topModule: tbTop.name,
      maxTime,
      device,
      memoryFiles: editor.getFiles(),
    });

    lastTbResult = res;
    activeSim = res.sim;
    lastAst = res.sim.ast;
    const dutMod = res.dutModule && prog.modules?.[res.dutModule] ? prog.modules[res.dutModule] : null;
    lastDutAst = dutMod;

    let report = null;
    let allDiagnostics = [...pp.warnings];
    if (res.dutSynthesis) {
      const mappedSynthDiags = res.dutSynthesis.diagnostics.map((d) => mapDiagnosticToSource(d, pp.sourceMap));
      allDiagnostics = [...pp.warnings, ...mappedSynthDiags];
      report = {
        ...res.dutSynthesis,
        diagnostics: allDiagnostics,
        errors: mappedSynthDiags.filter((d) => d.severity === 'error'),
        warnings: [...pp.warnings, ...mappedSynthDiags.filter((d) => d.severity !== 'error')],
      };
    }
    lastReport = report;
    lastDiagnostics = allDiagnostics;

    editor.setErrors(allDiagnostics.map((d) => ({ ...d, message: formatDiagnostic(d) })));
    if (report) renderSynthesisReport(dutMod || lastAst, report);

    const orderedSigs = _mainBuildOrderedSignals(res.sim.ast, res.sim.getClockPort()).map((s) => ({
      ...s,
      visible: !s.name.includes('.') && !res.sim.ast.signals?.[s.name]?.isInteger,
    }));
    if (orderedSigs.every((s) => !s.visible)) {
      orderedSigs.slice(0, 12).forEach((s) => { s.visible = true; });
    }
    waveform.loadTrace(res.trace, orderedSigs);
    peripheralDock.syncContext(makePeripheralCtx());

    for (const log of res.logs) {
      appendConsole(`[${log.time}ns] ${log.text}`, log.type === 'warning' ? 'warn' : 'info');
    }
    appendConsole(
      t('tb.runDone', {
        tb: res.topModule,
        time: res.stats.endTime,
        events: res.stats.eventsExecuted,
        halt: res.stats.haltedBy,
        logs: res.logs.length,
      }),
      res.stats.haltedBy === 'runtimeError' ? 'error' : 'ok'
    );

    setEditorStatus(
      res.stats.haltedBy === 'runtimeError' ? 'editor.statusHalted' : 'editor.statusCompiled',
      res.stats.haltedBy === 'runtimeError' ? 'status-error' : 'status-compiled'
    );
    renderTbSummary();
    renderCycle();
    scheduleRender();
    return true;
  };

  const compileAndSynthesize = () => {
    pauseClock(true);
    editor.clearErrors();

    const pp = preprocessWorkspace(editor.getFiles());
    lastSourceMap = pp.sourceMap;

    for (const info of pp.infos) {
      appendConsole(formatDiagnostic(info), 'info', { file: info.file, line: info.line });
    }
    for (const warn of pp.warnings) {
      appendConsole(formatDiagnostic(warn), 'warn', { file: warn.file, line: warn.line });
    }

    try {
      const prog = parseProgram(pp.mergedCode);
      const boardTop = selectTopModule(prog, 'board');
      const tbTop = selectTopModule(prog, 'testbench');

      // Smart auto-switch when user clicks Compile on a testbench without an active DE2 module
      const activeFile = editor.getActiveFile();
      const activeIsTbTab = Boolean(
        tbTop &&
        activeFile &&
        (/^tb_/i.test(activeFile.name) || /\bmodule\s+tb_\w+\s*(?:\(\s*\))?\s*;/.test(activeFile.content))
      );
      const hasBoardPorts = Boolean(
        boardTop &&
        !isTestbenchModule(boardTop) &&
        (boardTop.ports || []).some((p) => resolveBoardPortBinding(board.getBoardProfile(), p.name).bound)
      );

      if (simMode === 'board' && tbTop && (!boardTop || isTestbenchModule(boardTop) || (activeIsTbTab && !hasBoardPorts))) {
        setSimMode('testbench', { run: false });
        appendConsole(t('tb.autoSwitched', { module: tbTop.name }), 'info');
        return executeTestbench(prog, pp, tbTop);
      }

      if (simMode === 'testbench') {
        if (!tbTop) {
          lastTbResult = null;
          renderTbSummary();
          appendConsole(t('tb.noTbFound'), 'warn');
          activateDockTab('console');
          return false;
        }
        return executeTestbench(prog, pp, tbTop);
      }

      const ast = boardTop || prog.topModule;
      const device = getBoardDevice(activeBoardId);
      const rawReport = synthesize(ast, { device });
      const mappedSynthDiags = rawReport.diagnostics.map((d) => mapDiagnosticToSource(d, pp.sourceMap));
      const allDiagnostics = [...pp.warnings, ...mappedSynthDiags];
      const mappedErrors = mappedSynthDiags.filter((d) => d.severity === 'error');
      const mappedSynthWarnings = mappedSynthDiags.filter((d) => d.severity !== 'error');
      const report = {
        ...rawReport,
        diagnostics: allDiagnostics,
        errors: mappedErrors,
        warnings: [...pp.warnings, ...mappedSynthWarnings],
      };

      activeSim = sim;
      sim.compile(ast);

      pushAllBoardInputsToSim();
      sim.evalCombinational();

      lastAst = sim.ast;
      lastDutAst = sim.ast;
      lastReport = report;
      lastDiagnostics = allDiagnostics;

      const localizedDiags = allDiagnostics.map((d) => ({
        ...d,
        message: formatDiagnostic(d),
      }));
      editor.setErrors(localizedDiags);
      renderSynthesisReport(lastAst, report);

      waveform.setTimeMode(false);
      waveform.setSignals(_mainBuildOrderedSignals(lastAst, sim.getClockPort()));
      waveform.clear();
      waveform.setAutoFollow(true);
      waveform.pushSample({ ...sim.getSnapshot(), phase: 'init' });

      hookBasys3MuxPov();
      peripheralDock.syncContext(makePeripheralCtx());

      if (report.errors.length > 0) {
        setEditorStatus('editor.statusError', 'status-error');
        appendConsole(t('console.compiledErr', { module: ast.name, count: report.errors.length }), 'error');
        for (const d of report.errors) {
          appendConsole(formatDiagnostic(d), 'error', { file: d.file, line: d.line });
        }
      } else if (report.warnings.length > 0) {
        setEditorStatus('editor.statusWarning', 'status-warning');
        appendConsole(t('console.compiledWarn', { module: ast.name, count: report.warnings.length }), 'warn');
        for (const d of mappedSynthWarnings) {
          appendConsole(formatDiagnostic(d), 'warn', { file: d.file, line: d.line });
        }
      } else {
        setEditorStatus('editor.statusCompiled', 'status-compiled');
        appendConsole(
          t('console.compiledOk', {
            module: ast.name,
            luts: report.luts,
            ffs: report.ffs,
            les: report.estimatedLEs,
            pct: report.utilizationPct.toFixed(2),
          }),
          'ok'
        );
      }

      if (!handleRuntimeHalt()) {
        scheduleRender();
      }
      return true;
    } catch (err) {
      const rawDiag = typeof err?.toDiagnostic === 'function'
        ? err.toDiagnostic()
        : {
          code: 'SYNTAX_ERROR',
          severity: 'error',
          line: 1,
          signal: null,
          message: String(err?.message || err),
          params: {},
        };
      const mappedDiag = mapDiagnosticToSource(rawDiag, pp.sourceMap);
      lastDiagnostics = [...pp.warnings, mappedDiag];
      const msg = formatDiagnostic(mappedDiag);
      editor.setErrors(lastDiagnostics.map((d) => ({ ...d, message: formatDiagnostic(d) })));
      setEditorStatus('editor.statusError', 'status-error');
      appendConsole(msg, 'error', { file: mappedDiag.file, line: mappedDiag.line });
      activateDockTab('console');
      return false;
    }
  };

  async function handleUploadedFiles(fileList) {
    const incoming = Array.from(fileList || []);
    if (incoming.length === 0) return;

    const importedNames = [];
    let hadRejected = false;

    for (const file of incoming) {
      try {
        const bytes = await readBinaryFileFromInput(file);
        const validation = validateUploadedHdlFile(file.name, bytes);
        if (!validation.ok) {
          hadRejected = true;
          appendConsole(
            formatDiagnostic({
              code: validation.code,
              severity: 'warning',
              params: validation.params,
              message: validation.message,
            }),
            'warn'
          );
          continue;
        }
        editor.upsertFile(validation.name, validation.content, true);
        importedNames.push(validation.name);
      } catch (err) {
        hadRejected = true;
        appendConsole(String(err?.message || err), 'error');
      }
    }

    if (importedNames.length > 0) {
      if (editorFilenameEl) editorFilenameEl.textContent = editor.getActiveFile().name;
      appendConsole(
        t('console.hdlImported', {
          count: importedNames.length,
          files: importedNames.join(', '),
        }),
        'ok'
      );
      compileAndSynthesize();
    } else if (hadRejected) {
      activateDockTab('console');
    }
  }

  const switchBoard = (nextBoardId, silent = false) => {
    const profile = getBoardProfile(nextBoardId);
    activeBoardId = profile.id;
    if (boardSelect) boardSelect.value = activeBoardId;
    board.setBoard(profile);
    renderBoardHeaderMeta();

    if (lastAst) {
      const rawReport = synthesize(lastAst, { device: getBoardDevice(activeBoardId) });
      const mappedDiags = rawReport.diagnostics.map((d) => mapDiagnosticToSource(d, lastSourceMap));
      const report = {
        ...rawReport,
        diagnostics: mappedDiags,
        errors: mappedDiags.filter((d) => d.severity === 'error'),
        warnings: mappedDiags.filter((d) => d.severity !== 'error'),
      };
      lastReport = report;
      lastDiagnostics = report.diagnostics;
      renderSynthesisReport(lastAst, report);
      pushAllBoardInputsToSim();
      sim.evalCombinational();
      hookBasys3MuxPov();
      peripheralDock.syncContext(makePeripheralCtx());
      scheduleRender();
    }

    if (!silent) {
      appendConsole(
        t('console.boardSwitched', { board: t(profile.nameKey), device: profile.device.name }),
        'info'
      );
    }
  };

  // ==========================================================================
  // Event Wiring
  // ==========================================================================

  if (boardSelect) {
    boardSelect.addEventListener('change', () => {
      switchBoard(boardSelect.value, false);
    });
  }

  if (btnModeBoard) btnModeBoard.addEventListener('click', () => setSimMode('board', { run: true }));
  if (btnModeTb) btnModeTb.addEventListener('click', () => setSimMode('testbench', { run: true }));
  if (btnQuickTb) btnQuickTb.addEventListener('click', () => setSimMode('testbench', { run: true }));
  if (btnRunTb) btnRunTb.addEventListener('click', compileAndSynthesize);
  if (btnCompile) btnCompile.addEventListener('click', compileAndSynthesize);
  if (btnRun) btnRun.addEventListener('click', startClock);
  if (btnPause) btnPause.addEventListener('click', () => pauseClock(false));

  if (btnStep) {
    btnStep.addEventListener('click', () => {
      if (isRunning) pauseClock(true);
      stepOneFullCycle();
    });
  }

  if (btnReset) {
    btnReset.addEventListener('click', () => {
      pauseClock(true);
      board.resetInputs();
      if (sim.ast) {
        sim.reset();
        pushAllBoardInputsToSim();
        sim.evalCombinational();
        peripheralDock.syncContext(makePeripheralCtx());
        waveform.clear();
        waveform.setAutoFollow(true);
        waveform.pushSample({ ...sim.getSnapshot(), phase: 'reset' });
        setEditorStatus('editor.statusCompiled', 'status-compiled');
      }
      scheduleRender();
      appendConsole(t('console.resetDone'), 'info');
    });
  }

  if (clockSpeedSelect) {
    clockSpeedSelect.addEventListener('change', () => {
      if (clockSpeedSelect.value === 'manual') {
        if (isRunning) pauseClock(false);
      } else {
        activeFreqHz = Number(clockSpeedSelect.value) || 5;
        if (isRunning) startClock();
      }
    });
  }

  if (toggleBounce) {
    toggleBounce.addEventListener('change', () => {
      board.setBounceEnabled(toggleBounce.checked);
      appendConsole(t(toggleBounce.checked ? 'console.bounceOn' : 'console.bounceOff'), 'info');
    });
  }

  if (btnImportHdl && inputImportHdl) {
    btnImportHdl.addEventListener('click', () => {
      inputImportHdl.value = '';
      inputImportHdl.click();
    });
    inputImportHdl.addEventListener('change', async () => {
      try {
        const selected = Array.from(inputImportHdl.files || []);
        if (selected.length > 0) {
          await handleUploadedFiles(selected);
        }
      } finally {
        inputImportHdl.value = '';
      }
    });
  }

  if (btnDownloadHdl) {
    btnDownloadHdl.addEventListener('click', () => {
      const active = editor.getActiveFile();
      const res = downloadTextFile(active.name, active.content, 'text/plain;charset=utf-8');
      appendConsole(t('console.hdlDownloaded', { file: active.name, bytes: res.byteLength }), 'ok');
    });
  }

  if (presetSelect) {
    presetSelect.addEventListener('change', () => {
      const nextPreset = getPresetById(presetSelect.value);
      if (!nextPreset) return;
      currentPreset = nextPreset;
      const presetFiles = Array.isArray(currentPreset.files) && currentPreset.files.length > 0
        ? currentPreset.files.map((f) => ({ name: f.name, content: f.content }))
        : [{ name: currentPreset.filename || `${currentPreset.id}.sv`, content: currentPreset.code }];
      editor.setFiles(presetFiles);
      renderPresetMeta();

      if (simMode === 'testbench' && !presetFiles.some((f) => /^tb_/i.test(f.name))) {
        setSimMode('board', { run: false });
      }

      if (currentPreset.recommendedBoard && currentPreset.recommendedBoard !== activeBoardId) {
        switchBoard(currentPreset.recommendedBoard, true);
      }
      if (currentPreset.recommendedClockSpeed && clockSpeedSelect) {
        clockSpeedSelect.value = currentPreset.recommendedClockSpeed;
        activeFreqHz = Number(currentPreset.recommendedClockSpeed) || 5;
      }

      const lang = getLanguage();
      appendConsole(
        t('console.presetLoaded', { name: currentPreset.title?.[lang] || currentPreset.name }),
        'info'
      );
      compileAndSynthesize();

      if (currentPreset.recommendedPeripherals && currentPreset.recommendedPeripherals.length > 0) {
        peripheralDock.applyPresetPeripherals(currentPreset.recommendedPeripherals);
        activateDockTab('peripherals');
      }
    });
  }

  // Live Bilingual Switching (EN | VI) without resetting running simulation
  if (btnLangToggle) {
    btnLangToggle.addEventListener('click', () => {
      const nextLang = getLanguage() === 'vi' ? 'en' : 'vi';
      setLanguage(nextLang);
      applyTranslations(document);
      populateBoards();
      populatePresets();
      renderCursor();
      renderCycle();
      if (boardPanelTitleEl) {
        boardPanelTitleEl.textContent = t(simMode === 'testbench' ? 'tb.panelTitle' : 'board.title');
      }
      if (simMode === 'testbench') renderTbSummary();
      setEditorStatus(statusKey, statusClass);
      editor.updateTranslations();
      if (lastReport) renderSynthesisReport(lastDutAst || lastAst, lastReport);
      if (lastDiagnostics.length > 0) {
        editor.setErrors(lastDiagnostics.map((d) => ({ ...d, message: formatDiagnostic(d) })));
      }
      waveform.updateTranslations();
      peripheralDock.updateTranslations();
    });
  }

  if (btnClearConsole && consoleLogEl) {
    btnClearConsole.addEventListener('click', () => {
      consoleLogEl.innerHTML = '';
      consoleErrCount = 0;
      if (consoleErrBadge) {
        consoleErrBadge.textContent = '0';
        consoleErrBadge.classList.add('hidden');
      }
    });
  }

  // ==========================================================================
  // Phase C / D (v3.1) — VCD, Multi-File FPGA Pack & .lab.json Workspace Handlers
  // ==========================================================================

  let activeExportPack = null;

  const handleExportVcd = () => {
    const modName = lastAst?.name || 'virtual_fpga';
    const vcdContent = exportVCD(waveform, { moduleName: modName });
    const filename = `${modName}.vcd`;
    const res = downloadTextFile(filename, vcdContent, 'text/plain;charset=utf-8');
    appendConsole(
      t('console.vcdExported', {
        file: filename,
        samples: waveform.getSampleCount(),
        bytes: res.byteLength,
      }),
      'ok'
    );
    return { filename, content: vcdContent };
  };
  waveform.setExportVcdHandler(handleExportVcd);

  const openFpgaExportModal = () => {
    if (!lastAst) compileAndSynthesize();
    if (!lastAst) return null;

    const profile = board.getBoardProfile();
    const workspaceFiles = editor.getFiles();
    const isMultiFile = workspaceFiles.length > 1;
    const hdlFilename = isMultiFile
      ? `${workspaceFiles.length} HDL files (${workspaceFiles.map((f) => f.name).join(', ')})`
      : workspaceFiles[0].name;
    const hdlCode = isMultiFile
      ? workspaceFiles
        .map((f) => `// ============================================================\n// File: ${f.name}\n// ============================================================\n${f.content}`)
        .join('\n\n')
      : workspaceFiles[0].content;
    const conPack = exportConstraints(profile, lastDutAst || lastAst);

    activeExportPack = {
      hdlFilename,
      hdlCode,
      hdlFiles: workspaceFiles,
      conFilename: conPack.filename,
      conContent: conPack.content,
      conPack,
    };

    if (exportHdlNameEl) exportHdlNameEl.textContent = hdlFilename;
    if (exportHdlPreEl) exportHdlPreEl.textContent = hdlCode;
    if (exportConNameEl) exportConNameEl.textContent = conPack.filename;
    if (exportConPreEl) exportConPreEl.textContent = conPack.content;
    if (exportModalMetaEl) {
      exportModalMetaEl.textContent = t('export.metaSummary', {
        board: t(profile.nameKey),
        device: profile.device.part,
        format: conPack.extension.toUpperCase(),
        count: conPack.mappedPinCount,
      });
    }
    if (exportModalStatusEl) exportModalStatusEl.textContent = '';
    if (exportModalEl) exportModalEl.classList.remove('hidden');

    appendConsole(
      t('console.fpgaPackExported', {
        board: profile.defaultName,
        hdl: hdlFilename,
        con: conPack.filename,
        pins: conPack.mappedPinCount,
      }),
      'ok'
    );
    return activeExportPack;
  };

  const closeFpgaExportModal = () => {
    if (exportModalEl) exportModalEl.classList.add('hidden');
  };

  const copyExportText = async (text) => {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      }
      if (exportModalStatusEl) exportModalStatusEl.textContent = t('export.copied');
    } catch {
      if (exportModalStatusEl) exportModalStatusEl.textContent = t('export.copied');
    }
  };

  const downloadPackHdlFiles = () => {
    if (!activeExportPack) return 0;
    const list = activeExportPack.hdlFiles || [{ name: activeExportPack.hdlFilename, content: activeExportPack.hdlCode }];
    list.forEach((f, idx) => {
      if (idx === 0) downloadTextFile(f.name, f.content);
      else setTimeout(() => downloadTextFile(f.name, f.content), idx * 120);
    });
    return list.length;
  };

  if (btnExportFpga) btnExportFpga.addEventListener('click', openFpgaExportModal);
  if (btnExportClose) btnExportClose.addEventListener('click', closeFpgaExportModal);
  if (exportModalEl) {
    exportModalEl.addEventListener('click', (e) => {
      if (e.target === exportModalEl) closeFpgaExportModal();
    });
  }
  if (btnCopyHdl) btnCopyHdl.addEventListener('click', () => activeExportPack && copyExportText(activeExportPack.hdlCode));
  if (btnCopyCon) btnCopyCon.addEventListener('click', () => activeExportPack && copyExportText(activeExportPack.conContent));
  if (btnDlHdl) btnDlHdl.addEventListener('click', () => downloadPackHdlFiles());
  if (btnDlCon) btnDlCon.addEventListener('click', () => activeExportPack && downloadTextFile(activeExportPack.conFilename, activeExportPack.conContent));
  if (btnDlBoth) {
    btnDlBoth.addEventListener('click', () => {
      if (!activeExportPack) return;
      const count = downloadPackHdlFiles();
      setTimeout(() => downloadTextFile(activeExportPack.conFilename, activeExportPack.conContent), Math.max(1, count) * 120);
    });
  }

  const collectMemoryHexSnapshot = () => {
    const out = {};
    for (const m of activeSim.listMemories()) {
      const snap = activeSim.getMemory(m.name);
      if (!snap) continue;
      const lines = [];
      let curRun = [];
      let runStart = null;
      const flushRun = () => {
        if (curRun.length > 0 && runStart !== null) {
          lines.push(`@${runStart.toString(16).toUpperCase().padStart(2, '0')} ${curRun.join(' ')}`);
        }
        curRun = [];
        runStart = null;
      };
      for (const w of snap.words) {
        const allX = w.xMask === ((1n << BigInt(w.width)) - 1n) && w.zMask === 0n;
        if (allX) {
          flushRun();
        } else {
          if (runStart === null) runStart = w.addr;
          curRun.push(logic4ToString(w, 'hex'));
        }
      }
      flushRun();
      if (lines.length > 0) out[m.name] = lines.join('\n');
    }
    return out;
  };

  const handleSaveWorkspace = () => {
    const periphState = peripheralDock.serializeState();
    const files = editor.getFiles();
    const activeFile = editor.getActiveFile().name;
    const jsonText = serializeWorkspace({
      boardId: activeBoardId,
      simMode,
      clockMode: clockSpeedSelect ? clockSpeedSelect.value : String(activeFreqHz),
      files,
      activeFile,
      hdlCode: editor.getValue(),
      filename: activeFile,
      presetId: currentPreset?.id || null,
      activePeripherals: periphState.activePeripherals,
      pinBindings: periphState.pinBindings,
      memoryHex: collectMemoryHexSnapshot(),
      language: getLanguage(),
    });
    const filename = `${lastAst?.name || 'virtual_fpga'}.lab.json`;
    const res = downloadTextFile(filename, jsonText, 'application/json;charset=utf-8');
    appendConsole(t('console.labSaved', { file: filename, bytes: res.byteLength }), 'ok');
    return { filename, jsonText };
  };

  const restoreWorkspaceObject = (ws, sourceLabel = 'workspace.lab.json') => {
    pauseClock(true);
    if (ws.language && ws.language !== getLanguage()) {
      setLanguage(ws.language);
      applyTranslations(document);
      populateBoards();
      populatePresets();
      editor.updateTranslations();
      waveform.updateTranslations();
      peripheralDock.updateTranslations();
    }
    switchBoard(ws.boardId, true);
    if (clockSpeedSelect && ws.clockMode) {
      clockSpeedSelect.value = ws.clockMode;
      activeFreqHz = Number(ws.clockMode) || 5;
    }
    editor.setFiles(ws.files, ws.activeFile);
    if (editorFilenameEl) {
      editorFilenameEl.textContent = editor.getActiveFile().name;
    }
    setSimMode(ws.simMode === 'testbench' ? 'testbench' : 'board', { run: false });
    compileAndSynthesize();
    updateQuickTbButton();

    // Restore memories
    for (const [memName, hexText] of Object.entries(ws.memoryHex || {})) {
      if (activeSim.memNameToId.has(memName)) {
        activeSim.loadMemoryHex(memName, hexText);
      }
    }

    // Restore expansion peripherals + bindings
    peripheralDock.applyPresetPeripherals(ws.activePeripherals || []);
    if ((ws.activePeripherals || []).length > 0) {
      activateDockTab('peripherals');
    }
    scheduleRender();

    appendConsole(
      t('console.labLoaded', {
        file: sourceLabel,
        board: getBoardProfile(activeBoardId).defaultName,
        count: (ws.activePeripherals || []).length,
      }),
      'ok'
    );
  };

  if (btnSaveLab) btnSaveLab.addEventListener('click', handleSaveWorkspace);
  if (btnLoadLab && inputLoadLab) {
    btnLoadLab.addEventListener('click', () => {
      inputLoadLab.value = '';
      inputLoadLab.click();
    });
    inputLoadLab.addEventListener('change', async () => {
      const file = inputLoadLab.files?.[0];
      if (!file) return;
      try {
        const text = await readTextFileFromInput(file);
        const ws = deserializeWorkspace(text);
        restoreWorkspaceObject(ws, file.name);
      } catch (err) {
        appendConsole(t('console.labLoadErr', { error: err?.message || String(err) }), 'error');
        activateDockTab('console');
      } finally {
        inputLoadLab.value = '';
      }
    });
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && exportModalEl && !exportModalEl.classList.contains('hidden')) {
      closeFpgaExportModal();
    }
  });

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      compileAndSynthesize();
    }
  });

  // Startup initialization: Altera DE2 + default bcd_counter
  applyTranslations(document);
  populateBoards();
  populatePresets();
  renderCursor();
  renderCycle();
  appendConsole(t('console.ready'), 'ok');
  compileAndSynthesize();

  return { sim, editor, board, waveform, peripheralDock, compileAndSynthesize, switchBoard, setSimMode };
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initApp());
  } else {
    initApp();
  }
}
