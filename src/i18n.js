/**
 * Phase 3 — Bilingual Internationalization (EN / VI)
 * Preserves hardware silkscreen & core FPGA terminology per SPEC Section 8.
 */

const _I18N_STORAGE_KEY = 'virtual_fpga_sim_lang';

export const I18N_DICTIONARIES = Object.freeze({
  en: Object.freeze({
    'app.title': 'Virtual FPGA Simulator',
    'app.badge': 'DE2 / EP2C35',

    // Toolbar
    'toolbar.board': 'Board:',
    'toolbar.preset': 'Preset:',
    'toolbar.compile': 'Compile & Synthesize',
    'toolbar.compileTitle': 'Parse Verilog/SV, run DRC checks, and prepare simulation (Ctrl+Enter)',
    'toolbar.run': 'Run',
    'toolbar.runTitle': 'Start automatic clock generator',
    'toolbar.pause': 'Pause',
    'toolbar.pauseTitle': 'Pause automatic clock generator',
    'toolbar.step': 'Step 1 Clock',
    'toolbar.stepTitle': 'Advance simulation by one full clock cycle (posedge -> negedge)',
    'toolbar.reset': 'Reset Board',
    'toolbar.resetTitle': 'Reset switches, push buttons, and simulation state',
    'toolbar.clockSpeed': 'Clock:',
    'toolbar.speedManual': 'Manual',
    'toolbar.speed05Hz': '0.5 Hz',
    'toolbar.speed1Hz': '1 Hz',
    'toolbar.speed5Hz': '5 Hz',
    'toolbar.speed20Hz': '20 Hz',
    'toolbar.speed100Hz': '100 Hz',
    'toolbar.speed500Hz': '500 Hz',
    'toolbar.speed2kHz': '2 kHz',
    'toolbar.speed10kHz': '10 kHz',
    'toolbar.bounce': 'Simulate Bounce',
    'toolbar.bounceTitle': 'Inject realistic 15-30ms mechanical contact bounce on push buttons',
    'toolbar.saveLab': 'Save .lab.json',
    'toolbar.saveLabTitle': 'Download current workspace (board, HDL, peripherals, memories) as .lab.json',
    'toolbar.loadLab': 'Load .lab.json',
    'toolbar.loadLabTitle': 'Restore a saved .lab.json workspace file',
    'toolbar.langTitle': 'Switch UI language between English and Vietnamese',

    // Editor Panel
    'editor.title': 'HDL Editor',
    'editor.importHdl': 'Import HDL',
    'editor.importHdlTitle': 'Upload local .v, .sv, .vh, or .svh HDL files into workspace tabs',
    'editor.downloadHdl': 'Download HDL',
    'editor.downloadHdlTitle': 'Download the currently active HDL tab to disk',
    'editor.newFileTitle': 'New HDL file tab',
    'editor.closeTab': 'Close file tab',
    'editor.renameHint': 'Double-click to rename file',
    'editor.dropHint': 'Drop .v / .sv / .vh / .svh files here to import',
    'editor.statusReady': 'Ready',
    'editor.statusCompiled': 'Compiled',
    'editor.statusWarning': 'Warnings',
    'editor.statusError': 'Error',
    'editor.statusRunning': 'Running',
    'editor.statusPaused': 'Paused',
    'editor.statusHalted': 'Halted',
    'editor.cursorPos': 'Ln {line}, Col {col}',

    // Board Panel
    'board.title': 'Virtual FPGA Board',
    'board.de2.name': 'Altera DE2 (Cyclone II)',
    'board.de2.hint': 'Keys 0-9: toggle SW0-SW9 | KEY[3:0]: Active-Low',
    'board.basys3.name': 'Digilent Basys 3 (Artix-7)',
    'board.basys3.hint': 'Keys 0-9: toggle sw0-sw9 | BTNC/U/D/L/R: Active-High | an/seg: Active-Low',
    'board.hdlab.name': 'HDLab Education Board (Spartan-6)',
    'board.hdlab.hint': 'Keys 0-7: toggle SW0-SW7 | BTN[3:0]: Active-Low | UART/PWM/BUZZ/ADC headers',
    'board.cycle': 'Cycle: {count}',
    'board.shortcutHint': 'Keys 0-9: toggle SW0-SW9 | KEY[3:0]: Active-Low',
    'board.clkLabel': 'CLK',
    'board.unknownTip': 'Unknown logic state (X)',
    'board.keyActiveLowTip': 'Push button (Active-Low: released=1, pressed=0)',
    'board.swTip': 'Slide switch (click or press 0-9)',

    // Bottom Dock Tabs
    'tab.waveform': 'Logic Analyzer (Waveform)',
    'tab.peripherals': 'Expansion Peripherals',
    'tab.synthesis': 'Synthesis Report',
    'tab.console': 'Compiler Console',

    // Expansion Peripherals Dock
    'periph.dock.add': '+ Add Peripheral',
    'periph.dock.clearAll': 'Clear All',
    'periph.dock.empty': 'No expansion peripherals attached. Select one above and click "+ Add Peripheral".',
    'periph.dock.remove': 'Remove peripheral',
    'periph.dock.unbound': '-- Unbound --',
    'periph.uart.name': 'UART Terminal (8N1)',
    'periph.uart.pinTx': 'TX (RTL → Term):',
    'periph.uart.pinRx': 'RX (Term → RTL):',
    'periph.uart.divider': 'Divider:',
    'periph.uart.send': 'Send',
    'periph.uart.placeholder': 'Type ASCII text to send on UART_RX...',
    'periph.uart.empty': '(Waiting for 8N1 bytes on UART_TX...)',
    'periph.pwm.name': 'PWM Meter & Servo',
    'periph.pwm.pinPwm': 'PWM Pin:',
    'periph.pwm.duty': 'Duty Cycle',
    'periph.pwm.angle': 'Servo Angle',
    'periph.buzzer.name': 'Piezo Buzzer (Web Audio)',
    'periph.buzzer.pinBuzz': 'Tone Pin:',
    'periph.buzzer.unmute': 'Unmute Audio',
    'periph.buzzer.mute': 'Mute Audio',
    'periph.buzzer.idle': '0 Hz (Silent)',
    'periph.adc.name': 'Virtual ADC / Sensor',
    'periph.adc.pinOut': 'ADC Port:',
    'periph.adc.modeLight': 'Ambient Light (Lux)',
    'periph.adc.modeTemp': 'Temperature (°C)',
    'periph.mem.name': 'Memory / SRAM Viewer',
    'periph.mem.none': 'No 2D memory array found in compiled HDL.',
    'periph.mem.loadHex': 'Load Hex',
    'periph.mem.loaded': 'Loaded {count} words into {name}.',

    // Waveform / Logic Analyzer
    'waveform.placeholder': 'Logic Analyzer Canvas (1,000-sample Ring Buffer) — Ready.',
    'wave.signals': 'Signals',
    'wave.radix': 'Radix:',
    'wave.zoomIn': 'Zoom in (Mouse Wheel Up)',
    'wave.zoomOut': 'Zoom out (Mouse Wheel Down)',
    'wave.fit': 'Fit',
    'wave.fitTitle': 'Fit all captured samples into view',
    'wave.autoFollow': 'Auto-Follow',
    'wave.autoFollowTitle': 'Track latest waveform sample automatically while running',
    'wave.clear': 'Clear',
    'wave.clearTitle': 'Clear captured waveform samples',
    'wave.exportVcd': 'Export .VCD',
    'wave.exportVcdTitle': 'Download IEEE 1364 .vcd waveform file (GTKWave compatible)',
    'wave.empty': 'No samples captured yet. Step or Run the clock to record waveforms.',
    'wave.cursorInfo': 'Sample #{sample} | Cycle {cycle}',
    'wave.cursorTimeInfo': 'Time {time} ns | Sample #{sample}',
    'wave.timeSpanInfo': '0–{endTime} ns ({count} frames)',
    'wave.samplesInfo': '{count} / {cap} samples',

    // Dual-Mode & Testbench (v4.0-B)
    'mode.board': 'Board Mode (DE2)',
    'mode.testbench': 'Testbench Mode (ModelSim)',
    'tb.run': 'Run Testbench',
    'tb.runTitle': 'Execute discrete-event Verilog testbench and plot ns waveform',
    'tb.maxTime': 'Max Time (ns):',
    'tb.panelTitle': 'Testbench Summary & DUT Watch',
    'tb.timeCounter': 'Time: {time} ns',
    'tb.noTbFound': 'No testbench module (tb_* or initial/#delay) found in workspace. Add a tb_*.v tab or switch to Board Mode.',
    'tb.autoSwitched': "Detected testbench module '{module}' — switched to Testbench Mode (ModelSim).",
    'tb.runDone': "Testbench '{tb}' finished at {time} ns ({events} events, halt: {halt}, {logs} log line(s)).",
    'tb.emptySummary': 'Click "Run Testbench" to execute discrete-event simulation and inspect DUT signals.',
    'tb.statTb': 'TB',
    'tb.statDut': 'DUT',
    'tb.statEnd': 'End',
    'tb.statEvents': 'Events',
    'tb.statHalt': 'Halt',
    'synth.logicDepth': 'Logic Depth: {depth} (~{ns} ns)',
    'synth.logicDepthLabel': 'Critical Path / Logic Depth',
    'synth.logicDepthVal': '{depth} lvls',
    'synth.memBitsLabel': 'Memory Bits',
    'synth.hierarchyTitle': 'Module Hierarchy Breakdown',
    'synth.hierColModule': 'Module / Instance',
    'synth.hierColMem': 'Mem Bits',
    'synth.hierColDepth': 'Logic Depth',
    'preset.group.labs': 'CE118 / CE213 Course Labs (Altera DE2 + ModelSim)',
    'preset.group.v1': 'Core FPGA Circuits (Altera DE2)',
    'preset.group.v2': 'Peripherals & Memory Demos',
    'preset.runPairedTb': 'Run Paired Testbench →',

    // Synthesis Report
    'synth.deviceLabel': 'Target Device',
    'synth.deviceName': 'Altera Cyclone II EP2C35',
    'synth.luts': '4-Input LUTs',
    'synth.ffs': 'Flip-Flops',
    'synth.totalLEs': 'Total Logic Elements',
    'synth.dsp': 'DSP / Multipliers',
    'synth.utilization': 'Device Utilization',
    'synth.utilizationDetail': '{used} / {total} LEs ({pct}%)',
    'synth.pinMapping': 'Pin Mapping',
    'synth.pinColPort': 'Port',
    'synth.pinColDir': 'Direction',
    'synth.pinColWidth': 'Width',
    'synth.pinColPeripheral': 'Board Peripheral',
    'synth.pinBound': 'Bound',
    'synth.pinUnbound': 'Custom / Unbound',
    'synth.drcTitle': 'DRC Checks',
    'synth.drcClean': 'No DRC warnings or errors detected.',
    'synth.drcJumpTip': 'Click to highlight line {line} in the editor',
    'synth.drcJumpFileTip': 'Click to open {file} at line {line}',
    'synth.noData': 'Click "Compile & Synthesize" to generate the resource & DRC report.',
    'synth.exportPack': 'Export FPGA Pack',
    'synth.exportPackTitle': 'Export synthesizable RTL (.v) and board pin constraints (.qsf / .xdc / .ucf)',

    // Hardware Export & Workspace Persistence
    'export.modalTitle': 'Export FPGA Hardware Pack',
    'export.copy': 'Copy',
    'export.copied': 'Copied to clipboard!',
    'export.download': 'Download',
    'export.downloadBoth': 'Download Both Files',
    'export.metaSummary': 'Board: {board} ({device}) | Format: {format} | Mapped Pins: {count}',
    'console.vcdExported': "Exported IEEE 1364 waveform '{file}' ({samples} samples, {bytes} bytes).",
    'console.fpgaPackExported': "Generated FPGA Pack for {board}: '{hdl}' + '{con}' ({pins} mapped pins).",
    'console.labSaved': "Saved workspace to '{file}' ({bytes} bytes).",
    'console.labLoaded': "Loaded workspace '{file}' (board: {board}, peripherals: {count}).",
    'console.labLoadErr': 'Failed to load .lab.json workspace: {error}',
    'console.hdlImported': 'Imported {count} HDL file(s): {files}.',
    'console.hdlDownloaded': "Downloaded HDL file '{file}' ({bytes} bytes).",

    // Console
    'console.clear': 'Clear',
    'console.ready': 'Virtual FPGA Simulator ready. Press KEY[0] for async reset on sequential circuits.',
    'console.compiledOk': "Compiled module '{module}' — LUTs: {luts}, Flip-Flops: {ffs}, LEs: {les} ({pct}%).",
    'console.compiledWarn': "Compiled module '{module}' with {count} DRC warning(s).",
    'console.compiledErr': "Compilation / DRC failed for '{module}' with {count} error(s).",
    'console.presetLoaded': "Loaded preset '{name}'.",
    'console.simStarted': 'Auto clock started ({freq} Hz).',
    'console.simPaused': 'Auto clock paused at cycle {cycle}.',
    'console.simHalted': 'Simulation halted due to runtime error.',
    'console.resetDone': 'Board inputs, simulator state, and waveform buffer reset.',
    'console.bounceOn': 'KEY[3:0] mechanical contact bounce simulation enabled.',
    'console.bounceOff': 'KEY[3:0] mechanical contact bounce simulation disabled.',
    'console.keyInput': 'Input {signal} = 0x{hex} (bin: {bin})',

    // Structured Diagnostics (i18n templates matching Phase 2 codes)
    'diag.INFERRED_LATCH': "Line {line}: Inferred Latch on signal '{signal}' (missing assignment in combinational path).",
    'diag.COMBINATIONAL_LOOP': "Line {line}: Combinational Loop detected involving '{signal}' ({cycle}).",
    'diag.MULTI_DRIVEN_NET': "Line {line}: Multi-driven Net '{signal}' driven by multiple assign/always blocks.",
    'diag.BLOCKING_NONBLOCKING_MIX': "Line {line}: Mixed assignment '{actualOp}' on '{signal}' (recommended '{expectedOp}').",
    'diag.UNTERMINATED_COMMENT': 'Line {line}: Unterminated block comment /* ... */.',
    'diag.INVALID_LITERAL': "Line {line}: Invalid numeric literal '{literal}'.",
    'diag.UNEXPECTED_CHAR': "Line {line}: Unexpected character '{char}'.",
    'diag.UNEXPECTED_TOKEN': "Line {line}: Unexpected token '{token}'.",
    'diag.EXPECTED_SEMICOLON': "Line {line}: Missing ';' (got '{got}').",
    'diag.SYNTAX_ERROR': 'Line {line}: Syntax error (expected {expected}, got {got}).',
    'diag.UPLOAD_VHDL_UNSUPPORTED': "Skipped '{file}': VHDL (.vhd/.vhdl) is not supported. Please upload Verilog/SystemVerilog (.v, .sv, .vh, .svh).",
    'diag.UPLOAD_UNSUPPORTED_EXT': "Skipped '{file}': unsupported file extension '{ext}'. Supported: .v, .sv, .vh, .svh.",
    'diag.UPLOAD_FILE_TOO_LARGE': "Rejected '{file}': exceeds {maxKb} KB limit ({sizeKb} KB).",
    'diag.UPLOAD_BINARY_REJECTED': "Rejected '{file}': binary content detected (null bytes).",
    'diag.PREPROC_DIRECTIVE_SKIPPED': '[{file}:{line}] Skipped directive {directive}.',
    'diag.PREPROC_MISSING_INCLUDE': "[{file}:{line}] Included file '{includeFile}' not found in workspace tabs — please upload '{includeFile}'.",
    'diag.PREPROC_CIRCULAR_INCLUDE': "[{file}:{line}] Circular `include '{includeFile}' ignored.",
    'diag.PREPROC_UNKNOWN_DIRECTIVE': '[{file}:{line}] Skipped unsupported directive {directive}.',

    // Presets (for Phase 3/4 dropdown)
    'preset.bcd_counter': 'BCD Counter 0–99 + 7-Segment (Active-Low)',
    'preset.full_adder': '4-bit Full Adder (SW → LEDR / LEDG)',
    'preset.led_chaser': 'LED Chaser / Bidirectional Shift Register',
    'preset.traffic_fsm': 'Traffic Light FSM',
    'preset.uart_echo_demo': 'UART TX/RX Echo + Byte Counter (Multi-Module)',
    'preset.pwm_servo_buzzer': 'PWM Servo & Piezo Buzzer Generator',
    'preset.mini_sram_demo': 'Mini 16×8 Synchronous SRAM Controller',
    'console.boardSwitched': "Switched virtual board to '{board}' ({device}).",
  }),

  vi: Object.freeze({
    'app.title': 'Mô Phỏng FPGA Ảo',
    'app.badge': 'DE2 / EP2C35',

    // Toolbar
    'toolbar.board': 'Board:',
    'toolbar.preset': 'Mạch mẫu:',
    'toolbar.compile': 'Biên dịch & Tổng hợp',
    'toolbar.compileTitle': 'Phân tích cú pháp Verilog/SV, kiểm tra DRC và nạp mô phỏng (Ctrl+Enter)',
    'toolbar.run': 'Chạy',
    'toolbar.runTitle': 'Bật bộ tạo xung clock tự động',
    'toolbar.pause': 'Tạm dừng',
    'toolbar.pauseTitle': 'Tạm dừng bộ tạo xung clock tự động',
    'toolbar.step': 'Bước 1 Clock',
    'toolbar.stepTitle': 'Tiến hành mô phỏng thêm 1 chu kỳ xung clock hoàn chỉnh (posedge -> negedge)',
    'toolbar.reset': 'Reset Board',
    'toolbar.resetTitle': 'Đưa toàn bộ công tắc, nút nhấn và trạng thái mô phỏng về mặc định',
    'toolbar.clockSpeed': 'Tần số:',
    'toolbar.speedManual': 'Thủ công',
    'toolbar.speed05Hz': '0.5 Hz',
    'toolbar.speed1Hz': '1 Hz',
    'toolbar.speed5Hz': '5 Hz',
    'toolbar.speed20Hz': '20 Hz',
    'toolbar.speed100Hz': '100 Hz',
    'toolbar.speed500Hz': '500 Hz',
    'toolbar.speed2kHz': '2 kHz',
    'toolbar.speed10kHz': '10 kHz',
    'toolbar.bounce': 'Giả lập dội phím',
    'toolbar.bounceTitle': 'Chèn nhiễu dội tiếp điểm cơ học 15-30ms khi nhấn/nhả nút',
    'toolbar.saveLab': 'Lưu .lab.json',
    'toolbar.saveLabTitle': 'Tải về không gian làm việc hiện tại (board, mã HDL, ngoại vi, bộ nhớ) dạng .lab.json',
    'toolbar.loadLab': 'Mở .lab.json',
    'toolbar.loadLabTitle': 'Khôi phục không gian làm việc từ tệp .lab.json đã lưu',
    'toolbar.langTitle': 'Chuyển đổi ngôn ngữ giao diện giữa Tiếng Anh và Tiếng Việt',

    // Editor Panel
    'editor.title': 'Trình soạn thảo HDL',
    'editor.importHdl': 'Tải lên HDL',
    'editor.importHdlTitle': 'Tải lên tệp mã nguồn .v, .sv, .vh hoặc .svh vào các tab làm việc',
    'editor.downloadHdl': 'Tải về HDL',
    'editor.downloadHdlTitle': 'Tải về tệp HDL đang mở xuống máy',
    'editor.newFileTitle': 'Tạo tab tệp HDL mới',
    'editor.closeTab': 'Đóng tab tệp',
    'editor.renameHint': 'Nhấp đúp để đổi tên tệp',
    'editor.dropHint': 'Thả các tệp .v / .sv / .vh / .svh vào đây để nạp',
    'editor.statusReady': 'Sẵn sàng',
    'editor.statusCompiled': 'Đã biên dịch',
    'editor.statusWarning': 'Cảnh báo',
    'editor.statusError': 'Lỗi',
    'editor.statusRunning': 'Đang chạy',
    'editor.statusPaused': 'Tạm dừng',
    'editor.statusHalted': 'Đã dừng (Lỗi)',
    'editor.cursorPos': 'Dòng {line}, Cột {col}',

    // Board Panel
    'board.title': 'Board FPGA Ảo',
    'board.de2.name': 'Altera DE2 (Cyclone II)',
    'board.de2.hint': 'Phím 0-9: gạt SW0-SW9 | KEY[3:0]: Active-Low',
    'board.basys3.name': 'Digilent Basys 3 (Artix-7)',
    'board.basys3.hint': 'Phím 0-9: gạt sw0-sw9 | BTNC/U/D/L/R: Active-High | an/seg: Active-Low',
    'board.hdlab.name': 'HDLab Education Board (Spartan-6)',
    'board.hdlab.hint': 'Phím 0-7: gạt SW0-SW7 | BTN[3:0]: Active-Low | Cổng UART/PWM/BUZZ/ADC',
    'board.cycle': 'Chu kỳ: {count}',
    'board.shortcutHint': 'Phím 0-9: gạt SW0-SW9 | KEY[3:0]: Active-Low',
    'board.clkLabel': 'CLK',
    'board.unknownTip': 'Trạng thái logic không xác định (X)',
    'board.keyActiveLowTip': 'Nút nhấn (Active-Low: nhả=1, nhấn=0)',
    'board.swTip': 'Công tắc gạt (nhấn chuột hoặc phím 0-9)',

    // Bottom Dock Tabs
    'tab.waveform': 'Logic Analyzer (Dạng sóng)',
    'tab.peripherals': 'Ngoại vi mở rộng',
    'tab.synthesis': 'Báo cáo Tổng hợp',
    'tab.console': 'Console Biên dịch',

    // Expansion Peripherals Dock
    'periph.dock.add': '+ Thêm ngoại vi',
    'periph.dock.clearAll': 'Xóa tất cả',
    'periph.dock.empty': 'Chưa gắn ngoại vi mở rộng. Chọn một thiết bị phía trên và nhấn "+ Thêm ngoại vi".',
    'periph.dock.remove': 'Gỡ ngoại vi',
    'periph.dock.unbound': '-- Chưa gắn --',
    'periph.uart.name': 'UART Terminal (8N1)',
    'periph.uart.pinTx': 'TX (RTL → Term):',
    'periph.uart.pinRx': 'RX (Term → RTL):',
    'periph.uart.divider': 'Bộ chia:',
    'periph.uart.send': 'Gửi',
    'periph.uart.placeholder': 'Nhập chuỗi ASCII gửi tới UART_RX...',
    'periph.uart.empty': '(Đang chờ byte 8N1 trên UART_TX...)',
    'periph.pwm.name': 'Đo PWM & Servo',
    'periph.pwm.pinPwm': 'Chân PWM:',
    'periph.pwm.duty': 'Chu kỳ nhiệm vụ (Duty)',
    'periph.pwm.angle': 'Góc Servo',
    'periph.buzzer.name': 'Còi Piezo (Web Audio)',
    'periph.buzzer.pinBuzz': 'Chân Tone:',
    'periph.buzzer.unmute': 'Bật âm thanh',
    'periph.buzzer.mute': 'Tắt tiếng',
    'periph.buzzer.idle': '0 Hz (Im lặng)',
    'periph.adc.name': 'Cảm biến ADC ảo',
    'periph.adc.pinOut': 'Cổng ADC:',
    'periph.adc.modeLight': 'Ánh sáng (Lux)',
    'periph.adc.modeTemp': 'Nhiệt độ (°C)',
    'periph.mem.name': 'Trình xem Bộ nhớ / SRAM',
    'periph.mem.none': 'Không có mảng bộ nhớ 2D trong mã HDL hiện tại.',
    'periph.mem.loadHex': 'Nạp Hex',
    'periph.mem.loaded': 'Đã nạp {count} từ vào {name}.',

    // Waveform / Logic Analyzer
    'waveform.placeholder': 'Logic Analyzer (Ring Buffer 1.000 mẫu) — Sẵn sàng.',
    'wave.signals': 'Tín hiệu',
    'wave.radix': 'Hệ số:',
    'wave.zoomIn': 'Phóng to (Cuộn chuột lên)',
    'wave.zoomOut': 'Thu nhỏ (Cuộn chuột xuống)',
    'wave.fit': 'Vừa khung',
    'wave.fitTitle': 'Thu gọn toàn bộ mẫu đã ghi vào khung nhìn',
    'wave.autoFollow': 'Theo dõi mới nhất',
    'wave.autoFollowTitle': 'Tự động cuộn theo mẫu mới nhất khi mô phỏng đang chạy',
    'wave.clear': 'Xóa sóng',
    'wave.clearTitle': 'Xóa toàn bộ bộ đệm dạng sóng',
    'wave.exportVcd': 'Xuất .VCD',
    'wave.exportVcdTitle': 'Tải về tệp dạng sóng chuẩn IEEE 1364 .vcd (mở được bằng GTKWave)',
    'wave.empty': 'Chưa có mẫu dữ liệu. Nhấn Bước 1 Clock hoặc Chạy để ghi dạng sóng.',
    'wave.cursorInfo': 'Mẫu #{sample} | Chu kỳ {cycle}',
    'wave.cursorTimeInfo': 'Thời gian {time} ns | Mẫu #{sample}',
    'wave.timeSpanInfo': '0–{endTime} ns ({count} khung)',
    'wave.samplesInfo': '{count} / {cap} mẫu',

    // Dual-Mode & Testbench (v4.0-B)
    'mode.board': 'Chế độ Board (DE2)',
    'mode.testbench': 'Chế độ Testbench (ModelSim)',
    'tb.run': 'Chạy Testbench',
    'tb.runTitle': 'Chạy testbench Verilog rời rạc và vẽ dạng sóng theo trục thời gian ns',
    'tb.maxTime': 'Thời gian tối đa (ns):',
    'tb.panelTitle': 'Tóm tắt Testbench & Tín hiệu DUT',
    'tb.timeCounter': 'Thời gian: {time} ns',
    'tb.noTbFound': 'Không tìm thấy module testbench (tb_* hoặc initial/#delay). Hãy thêm tab tb_*.v hoặc chuyển sang Chế độ Board.',
    'tb.autoSwitched': "Phát hiện module testbench '{module}' — tự chuyển sang Chế độ Testbench (ModelSim).",
    'tb.runDone': "Testbench '{tb}' hoàn tất tại {time} ns ({events} sự kiện, dừng: {halt}, {logs} dòng log).",
    'tb.emptySummary': 'Nhấn "Chạy Testbench" để mô phỏng rời rạc và quan sát tín hiệu DUT.',
    'tb.statTb': 'TB',
    'tb.statDut': 'DUT',
    'tb.statEnd': 'Kết thúc',
    'tb.statEvents': 'Sự kiện',
    'tb.statHalt': 'Trạng thái',
    'synth.logicDepth': 'Logic Depth: {depth} (~{ns} ns)',
    'synth.logicDepthLabel': 'Đường găng / Logic Depth',
    'synth.logicDepthVal': '{depth} tầng',
    'synth.memBitsLabel': 'Memory Bits',
    'synth.hierarchyTitle': 'Phân rã Phân cấp Module (Hierarchy)',
    'synth.hierColModule': 'Module / Thực thể',
    'synth.hierColMem': 'Mem Bits',
    'synth.hierColDepth': 'Logic Depth',
    'preset.group.labs': 'Bài Lab CE118 / CE213 (Altera DE2 + ModelSim)',
    'preset.group.v1': 'Mạch FPGA cơ bản (Altera DE2)',
    'preset.group.v2': 'Mạch Ngoại vi & Bộ nhớ',
    'preset.runPairedTb': 'Chạy Testbench kèm theo →',

    // Synthesis Report
    'synth.deviceLabel': 'Chip mục tiêu',
    'synth.deviceName': 'Altera Cyclone II EP2C35',
    'synth.luts': '4-Input LUTs',
    'synth.ffs': 'Flip-Flops',
    'synth.totalLEs': 'Tổng Logic Elements',
    'synth.dsp': 'Khối DSP / Nhân',
    'synth.utilization': 'Tỷ lệ tài nguyên FPGA',
    'synth.utilizationDetail': '{used} / {total} LEs ({pct}%)',
    'synth.pinMapping': 'Ánh xạ chân (Pin Mapping)',
    'synth.pinColPort': 'Cổng',
    'synth.pinColDir': 'Hướng',
    'synth.pinColWidth': 'Độ rộng',
    'synth.pinColPeripheral': 'Ngoại vi trên Board',
    'synth.pinBound': 'Đã ánh xạ',
    'synth.pinUnbound': 'Tùy biến / Chưa gắn',
    'synth.drcTitle': 'Kiểm tra quy tắc thiết kế (DRC)',
    'synth.drcClean': 'Không phát hiện lỗi hoặc cảnh báo DRC.',
    'synth.drcJumpTip': 'Nhấn để tô sáng dòng {line} trong trình soạn thảo',
    'synth.drcJumpFileTip': 'Nhấn để mở {file} tại dòng {line}',
    'synth.noData': 'Nhấn "Biên dịch & Tổng hợp" để xem ước lượng tài nguyên và kiểm tra DRC.',
    'synth.exportPack': 'Xuất Gói FPGA',
    'synth.exportPackTitle': 'Xuất mã RTL (.v) và tệp gán chân phần cứng (.qsf / .xdc / .ucf)',

    // Hardware Export & Workspace Persistence
    'export.modalTitle': 'Xuất Gói Phần Cứng FPGA',
    'export.copy': 'Sao chép',
    'export.copied': 'Đã sao chép vào bộ nhớ tạm!',
    'export.download': 'Tải về',
    'export.downloadBoth': 'Tải Cả 2 Tệp',
    'export.metaSummary': 'Board: {board} ({device}) | Định dạng: {format} | Chân đã gán: {count}',
    'console.vcdExported': "Đã xuất dạng sóng IEEE 1364 '{file}' ({samples} mẫu, {bytes} byte).",
    'console.fpgaPackExported': "Đã tạo Gói FPGA cho {board}: '{hdl}' + '{con}' ({pins} chân đã gán).",
    'console.labSaved': "Đã lưu workspace vào '{file}' ({bytes} byte).",
    'console.labLoaded': "Đã nạp workspace '{file}' (board: {board}, ngoại vi: {count}).",
    'console.labLoadErr': 'Không thể nạp tệp .lab.json: {error}',
    'console.hdlImported': 'Đã nạp {count} tệp HDL: {files}.',
    'console.hdlDownloaded': "Đã tải về tệp HDL '{file}' ({bytes} byte).",

    // Console
    'console.clear': 'Xóa log',
    'console.ready': 'Trình mô phỏng FPGA ảo đã sẵn sàng. Nhấn KEY[0] để reset bất đồng bộ cho mạch tuần tự.',
    'console.compiledOk': "Đã biên dịch module '{module}' — LUTs: {luts}, Flip-Flops: {ffs}, LEs: {les} ({pct}%).",
    'console.compiledWarn': "Đã biên dịch module '{module}' kèm {count} cảnh báo DRC.",
    'console.compiledErr': "Biên dịch / kiểm tra DRC thất bại cho '{module}' với {count} lỗi.",
    'console.presetLoaded': "Đã nạp mạch mẫu '{name}'.",
    'console.simStarted': 'Đã bật xung clock tự động ({freq} Hz).',
    'console.simPaused': 'Đã tạm dừng xung clock tại chu kỳ {cycle}.',
    'console.simHalted': 'Mô phỏng đã dừng do lỗi thực thi.',
    'console.resetDone': 'Đã reset công tắc, nút nhấn, trạng thái mô phỏng và dạng sóng.',
    'console.bounceOn': 'Đã bật giả lập dội tiếp điểm cơ học cho KEY[3:0].',
    'console.bounceOff': 'Đã tắt giả lập dội tiếp điểm cơ học cho KEY[3:0].',
    'console.keyInput': 'Đầu vào {signal} = 0x{hex} (nhị phân: {bin})',

    // Structured Diagnostics (preserving core hardware terms in English per Section 8)
    'diag.INFERRED_LATCH': "Dòng {line}: Phát hiện Inferred Latch trên tín hiệu '{signal}' (thiếu nhánh gán trong khối tổ hợp).",
    'diag.COMBINATIONAL_LOOP': "Dòng {line}: Phát hiện Combinational Loop liên quan đến '{signal}' ({cycle}).",
    'diag.MULTI_DRIVEN_NET': "Dòng {line}: Phát hiện Multi-driven Net '{signal}' bị điều khiển bởi nhiều khối assign/always.",
    'diag.BLOCKING_NONBLOCKING_MIX': "Dòng {line}: Dùng lẫn toán tử gán '{actualOp}' cho '{signal}' (khuyến nghị '{expectedOp}').",
    'diag.UNTERMINATED_COMMENT': 'Dòng {line}: Chú thích khối /* ... */ chưa được đóng.',
    'diag.INVALID_LITERAL': "Dòng {line}: Hằng số không hợp lệ '{literal}'.",
    'diag.UNEXPECTED_CHAR': "Dòng {line}: Ký tự không hợp lệ '{char}'.",
    'diag.UNEXPECTED_TOKEN': "Dòng {line}: Token không mong đợi '{token}'.",
    'diag.EXPECTED_SEMICOLON': "Dòng {line}: Thiếu dấu ';' (nhận được '{got}').",
    'diag.SYNTAX_ERROR': 'Dòng {line}: Lỗi cú pháp (mong đợi {expected}, nhận được {got}).',
    'diag.UPLOAD_VHDL_UNSUPPORTED': "Đã bỏ qua '{file}': Không hỗ trợ VHDL (.vhd/.vhdl). Vui lòng tải lên Verilog/SystemVerilog (.v, .sv, .vh, .svh).",
    'diag.UPLOAD_UNSUPPORTED_EXT': "Đã bỏ qua '{file}': Định dạng tệp '{ext}' không được hỗ trợ. Hỗ trợ: .v, .sv, .vh, .svh.",
    'diag.UPLOAD_FILE_TOO_LARGE': "Từ chối '{file}': Vượt quá giới hạn {maxKb} KB ({sizeKb} KB).",
    'diag.UPLOAD_BINARY_REJECTED': "Từ chối '{file}': Phát hiện dữ liệu nhị phân (byte null).",
    'diag.PREPROC_DIRECTIVE_SKIPPED': '[{file}:{line}] Đã bỏ qua chỉ thị {directive}.',
    'diag.PREPROC_MISSING_INCLUDE': "[{file}:{line}] Không tìm thấy tệp '{includeFile}' trong các tab — vui lòng tải lên '{includeFile}'.",
    'diag.PREPROC_CIRCULAR_INCLUDE': "[{file}:{line}] Bỏ qua vòng lặp `include '{includeFile}'.",
    'diag.PREPROC_UNKNOWN_DIRECTIVE': '[{file}:{line}] Đã bỏ qua chỉ thị chưa hỗ trợ {directive}.',

    // Presets
    'preset.bcd_counter': 'Bộ đếm BCD 0–99 + LED 7 đoạn (Active-Low)',
    'preset.full_adder': 'Mạch cộng toàn phần 4-bit (SW → LEDR / LEDG)',
    'preset.led_chaser': 'Mạch LED chạy 2 chiều / Thanh ghi dịch',
    'preset.traffic_fsm': 'Máy trạng thái FSM Đèn giao thông',
    'preset.uart_echo_demo': 'UART TX/RX Echo + Bộ đếm byte (Đa module)',
    'preset.pwm_servo_buzzer': 'Bộ phát PWM Servo & Còi Piezo',
    'preset.mini_sram_demo': 'Bộ điều khiển SRAM đồng bộ 16×8',
    'console.boardSwitched': "Đã chuyển board ảo sang '{board}' ({device}).",
  }),
});

let _i18nCurrentLang = _i18nLoadSavedLang();

function _i18nLoadSavedLang() {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const saved = window.localStorage.getItem(_I18N_STORAGE_KEY);
      if (saved === 'en' || saved === 'vi') return saved;
    }
  } catch {
    // Ignore storage access errors under file:// or restricted browser contexts
  }
  return 'vi';
}

export function getLanguage() {
  return _i18nCurrentLang;
}

export function setLanguage(lang) {
  const normalized = lang === 'en' ? 'en' : 'vi';
  _i18nCurrentLang = normalized;
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(_I18N_STORAGE_KEY, normalized);
    }
  } catch {
    // Safe fallback under file://
  }
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.lang = normalized;
  }
  return _i18nCurrentLang;
}

/**
 * Translate a dictionary key with optional `{param}` interpolation.
 * @param {string} key
 * @param {Record<string, string|number>} [params={}]
 * @returns {string}
 */
export function t(key, params = {}) {
  const dict = I18N_DICTIONARIES[_i18nCurrentLang] || I18N_DICTIONARIES.en;
  const template = dict[key] ?? I18N_DICTIONARIES.en[key] ?? key;
  return String(template).replace(/\{(\w+)\}/g, (match, name) => (
    name in params && params[name] !== undefined && params[name] !== null
      ? String(params[name])
      : match
  ));
}

/**
 * Localize a structured diagnostic object `{ code, severity, line, signal, message, params }`.
 * @param {object} diag
 * @returns {string}
 */
export function formatDiagnostic(diag) {
  if (!diag) return '';
  const key = `diag.${diag.code}`;
  const dict = I18N_DICTIONARIES[_i18nCurrentLang] || I18N_DICTIONARIES.en;
  if (!(key in dict) && !(key in I18N_DICTIONARIES.en)) {
    const raw = diag.message || diag.code || '';
    return diag.file && !raw.includes(diag.file) ? `[${diag.file}] ${raw}` : raw;
  }
  const template = dict[key] ?? I18N_DICTIONARIES.en[key] ?? '';
  const mergedParams = {
    ...(diag.params || {}),
    file: diag.file ?? diag.params?.file ?? '?',
    line: diag.line ?? '?',
    signal: diag.signal ?? '?',
    cycle: Array.isArray(diag.params?.cycle) ? diag.params.cycle.join(' -> ') : '',
  };
  const rendered = t(key, mergedParams);
  if (diag.file && !String(template).includes('{file}')) {
    return `[${diag.file}] ${rendered}`;
  }
  return rendered;
}

/**
 * Apply active translations to all `[data-i18n]` and `[data-i18n-title]` elements under `root`.
 * @param {ParentNode} [root]
 */
export function applyTranslations(root) {
  const scope = root || (typeof document !== 'undefined' ? document : null);
  if (!scope || typeof scope.querySelectorAll !== 'function') return;

  const textNodes = scope.querySelectorAll('[data-i18n]');
  for (const node of textNodes) {
    const key = node.getAttribute('data-i18n');
    if (key) node.textContent = t(key);
  }

  const titleNodes = scope.querySelectorAll('[data-i18n-title]');
  for (const node of titleNodes) {
    const key = node.getAttribute('data-i18n-title');
    if (key) node.setAttribute('title', t(key));
  }

  const langBtn = scope.querySelector('#btn-lang-toggle');
  if (langBtn) {
    const enSpan = langBtn.querySelector('[data-lang="en"]');
    const viSpan = langBtn.querySelector('[data-lang="vi"]');
    if (enSpan) enSpan.classList.toggle('lang-active', _i18nCurrentLang === 'en');
    if (viSpan) viSpan.classList.toggle('lang-active', _i18nCurrentLang === 'vi');
  }
}
