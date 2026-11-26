```markdown
# SPEC: Virtual FPGA Development Board & RTL Simulator (Single-File HTML)

## 1. Overview & Hard Constraints
**Virtual FPGA Simulator** is a zero-dependency, browser-based Verilog / SystemVerilog HDL simulator and virtual development board modeled after the Intel/Altera DE2 platform.

- **Zero-Dependency:** No CDNs, no external libraries or frameworks (no React, Tailwind, CodeMirror, Ace, etc.), and no npm packages. Implement everything in Vanilla JS (ES6+), CSS3, HTML5 Canvas, and inline SVG.
- **Single-File Artifact:** All modules under `src/` must bundle into a single self-contained HTML file at `dist/virtual-fpga.html` that runs directly via `file://` without a local server.
- **Color System:**
  - IDE Background: Dark Navy `#0D111D`, Panels `#131A2B`, Borders `#1E2D45`.
  - PCB Surface: Deep PCB Green `#0E4D2E`, copper traces `#16683F`, white/light-yellow silkscreen labels.
  - UI Accents: Electric Cyan `#3B9ED8`, Oceanic Blue `#0060A2`.
  - **Strict Prohibition:** Do not use purple or violet tones anywhere in the UI, board, or diagrams.

---

## 2. Project Structure & Bundling Convention
```text
virtual-fpga-sim/
├── SPEC.md                 # Core technical specification (Single Source of Truth)
├── build.mjs               # Zero-dependency Node.js bundler -> dist/virtual-fpga.html
├── src/
│   ├── index.html          # Main application shell
│   ├── styles.css          # Dark Navy + PCB Green theme
│   ├── engine/
│   │   ├── lexer.js        # Verilog / SystemVerilog tokenizer
│   │   ├── parser.js       # Recursive-descent parser -> AST
│   │   ├── simulator.js    # 4-state, 2-phase RTL simulation engine
│   │   └── synthesizer.js  # AST-based LUT/FF estimator & DRC checker
│   ├── ui/
│   │   ├── board.js        # Interactive SVG DE2 FPGA Board
│   │   ├── editor.js       # Lightweight syntax-highlighted HDL editor
│   │   └── waveform.js     # HTML5 Canvas Logic Analyzer
│   ├── presets.js          # Built-in HDL circuit presets
│   └── main.js             # Connects Engine <-> UI <-> Clock & render loops
├── tests/
│   └── engine.test.mjs     # Node.js unit tests for Parser, Simulator, Synthesizer
└── dist/
    └── virtual-fpga.html   # Final single-file production bundle

```

* **Module & Bundling Rule:** All files under `src/` use standard ES Modules (`import` / `export`) so they run natively under Node.js for unit testing (`node --test`). `build.mjs` uses pure Node.js (`fs`, `path`) to inline `src/styles.css` into `<style>`, strip `import`/`export` statements, concatenate JS files in strict dependency order inside a single IIFE (`(() => { ... })();`), and emit `dist/virtual-fpga.html` so it executes cleanly over `file://` without ES module CORS errors.

---

## 3. Target Virtual Board I/O Mapping (DE2 Standard)

Top-level module ports automatically bind to board peripherals by name (with an optional Pin Planner view):

| Port Name | Direction | Width | Peripheral | Behavior & Notes |
| --- | --- | --- | --- | --- |
| `CLOCK_50` / `CLK` / `clk` | `input` | 1-bit | Clock Generator | Supports all three aliases. Auto Clock (`0.5 Hz` – `100 Hz`) and Manual Step (1 full clock cycle per click). |
| `SW` | `input` | `[17:0]` | 18x Slide Switches | Latched toggle (`0` = down, `1` = up). Optional keyboard shortcuts (`0`–`9`). |
| `KEY` | `input` | `[3:0]` | 4x Push Buttons | **Active-Low** (released = `1`, pressed = `0`). Includes optional **"Simulate Bounce"** toggle to inject realistic contact bounce. |
| `LEDR` | `output` | `[17:0]` | 18x Red LEDs | Active-High (`1` = lit with glow). Displays dim/warning indicator when bit is `X`. |
| `LEDG` | `output` | `[8:0]` | 9x Green LEDs | Active-High (`1` = lit with glow). Displays dim/warning indicator when bit is `X`. |
| `HEX0` .. `HEX7` | `output` | `[6:0]` | 8x 7-Segment Displays | **Active-Low** (`0` = segment lit, `1` = off). Bit `[0]` = seg `a` through `[6]` = seg `g`. Rendered as crisp inline SVG. |

---

## 4. Supported HDL Subset (Synthesizable Verilog / SystemVerilog)

* **Comments & Literals:**
* Single-line (`// ...`) and multi-line (`/* ... */`) comments.
* Unsized decimals (`10`), sized binary/hex/decimal literals (`4'b1010`, `8'hFF`, `7'd42`), and underscore digit separators (`8'b1010_0101`, `16'hFF_00`).


* **Declarations:** `module`, `endmodule`, `input`, `output`, `wire`, `reg`, `logic`, `parameter`, `localparam`, packed vectors `[MSB:LSB]`.
* **Bit Operations:** Bit-select `sig[i]`, part-select `sig[hi:lo]`, concatenation `{a, b}`.
* **Continuous Assignment:** `assign target = expr;`
* **Procedural Blocks:**
* Sequential: `always @(posedge ...)`, `always @(negedge ...)`, `always_ff` (including async reset sensitivity lists such as `posedge CLOCK_50 or negedge KEY[0]`).
* Combinational: `always @(*)`, `always @*` (without parentheses), `always_comb`.


* **Statements:** `begin ... end`, `if / else if / else`, `case / default / endcase`, blocking (`=`), non-blocking (`<=`).
* **Operators:**
* Arithmetic: `+`, `-`, `*`
* Bitwise: `~`, `&`, `|`, `^`
* Reduction: `&a`, `|a`, `^a`
* Logical: `!`, `&&`, `||`
* Relational: `==`, `!=`, `<`, `<=`, `>`, `>=`
* Shift: `<<`, `>>`
* Ternary: `cond ? a : b`



---

## 5. Simulation Engine Architecture (`simulator.js`)

* **4-State Logic (`0`, `1`, `X`, `Z`):** Represent every signal value using `BigInt` bitfields (`val`, `xMask`, `zMask`, plus `width`) to avoid 32-bit JS integer overflow and accurately propagate uninitialized (`X`) or high-impedance (`Z`) states.
* **Two-Phase Cycle-Accurate Execution:**
1. **Phase 1 — Sequential:** On clock edge or async reset trigger, evaluate all matching sequential blocks against the current state. Stage non-blocking (`<=`) assignments in a `nextState` buffer, then commit atomically to preserve hardware concurrency.
2. **Phase 2 — Combinational:** Iteratively evaluate all `assign` statements and combinational `always` blocks until fixed-point convergence. Enforce a hard cap of **64 iterations** to detect and halt combinational loops.


* **Render Decoupling:** Decouple the simulation tick timer from UI updates; throttle DOM/SVG/Canvas redraws via `requestAnimationFrame` (max 60 FPS) so high-frequency Auto Clock runs remain responsive.

---

## 6. Logic Analyzer & Synthesis Report

### Logic Analyzer (`waveform.js`)

* Rendered on a HiDPI-aware HTML5 `<canvas>` (`devicePixelRatio`).
* Backed by a **Ring Buffer** storing at least **1,000 samples** across all ports and internal `wire`/`reg`/`logic` signals.
* Visuals: 1-bit signals as square waves (cyan/green); multi-bit buses as transition hexagons displaying values in selectable **Hex / Dec / Bin** radix; `X` shaded with red hatching; `Z` drawn as an orange center line.
* Controls: Horizontal Zoom (mouse wheel), Pan (drag/scrollbar), signal visibility selector, and an interactive vertical Cursor displaying exact signal values at the hovered timestamp.

### Synthesis & DRC (`synthesizer.js`)

* **Resource Estimation (AST Traversal):**
* **Flip-Flops (FFs):** Sum of bit-widths of all target signals assigned inside sequential blocks.
* **4-Input LUTs:** Weighted estimate from AST nodes (2–4 input bitwise ops = 1 LUT/bit; `if/case` N:1 muxes = `ceil((N-1)/2)` LUTs/bit; `+`/`-` carry chains = 1 LUT/bit; `*` flagged as DSP/high-LUT usage).
* **Device Utilization:** Report percentage utilization against reference FPGA **Altera Cyclone II EP2C35 (33,216 LEs)**.


* **Design Rule Checks (DRC):**
* `Inferred Latch`: Combinational block missing an `else` or `default` assignment for a signal.
* `Combinational Loop`: Signal depends on itself without a register break.
* `Multi-driven Net`: Same signal driven by multiple `assign` or `always` blocks.
* `Blocking/Non-blocking Mix`: Warning when `=` is used in sequential blocks or `<=` in combinational blocks.



---

## 7. Built-in Presets (`presets.js`)

1. **BCD Counter 0–99 + 7-Segment Active-Low (Default on Load):** Synchronous 2-digit counter displayed on `HEX0` and `HEX1`, async reset on `KEY[0]`, pause on `SW[0]`.
2. **4-bit Full Adder:** Combinational addition of `SW[3:0] + SW[7:4]`, outputting sum to `LEDR[3:0]` and carry-out to `LEDG[0]`.
3. **LED Chaser / Shift Register:** Bidirectional running light across `LEDR[17:0]`, direction controlled by `SW[1]`, reset via `KEY[0]`.
4. **Traffic Light FSM:** Moore/Mealy state machine driving `LEDR` and `LEDG` with clear state transitions observable on the Logic Analyzer.

---

## 8. Internationalization (Bilingual UI: EN / VI)
- Add `src/i18n.js` (bundled before `src/presets.js` and `src/ui/*` in `build.mjs`) containing `en` and `vi` dictionaries, a `t(key, params)` helper, and `setLanguage(lang)`.
- Provide an `EN | VI` toggle button in the Top Toolbar that switches all UI labels (`data-i18n` / `data-i18n-title`), dynamic panels (Synthesis Report, DRC warnings, Console messages, Preset descriptions) live without resetting the simulation state.
- Persist the selected language in `localStorage` inside a `try/catch` block (safe for `file://`). Default language: `vi` (or `en`).
- **Terminology Rule:** Keep PCB silkscreen labels (`SW`, `KEY`, `LEDR`, `LEDG`, `HEX0..7`, `CLOCK_50`) and core hardware terms (`LUTs`, `Flip-Flops`, `Active-Low`, `Inferred Latch`, `Combinational Loop`) in English even in Vietnamese mode; translate controls, tooltips, explanations, and preset descriptions cleanly into technical Vietnamese.

---

## 9. v2.0 Core Engine & Performance

All v2.0 upgrades must preserve **100% backward compatibility** with existing v1 single-module Verilog/SV designs, v1 presets, and the `tests/engine.test.mjs` regression suite.

### 9.1 Multi-Module Instantiation & `#(parameter)` Overrides
- **Multi-Module Compilation Units:** Extend `src/engine/parser.js` to parse multiple `module ... endmodule` definitions in a single source buffer while keeping `parse(src)` backward-compatible (returning the resolved top-level module AST with attached `modules` / `instances` metadata).
- **Instantiation & Overrides:** Support submodule instantiation with both named and positional parameter overrides (`submod #(.WIDTH(8), .MAX_VAL(99)) u_cnt (.clk(CLOCK_50), .rst_n(KEY[0]), .q(count));`) as well as positional port connections.
- **Elaboration & Scoped Hierarchy:** Elaborate instantiated submodules with resolved parameter values, check for missing modules, port mismatches, and recursive instantiation cycles via structured `HdlError` / DRC diagnostics, and expose hierarchical signal paths (`u_cnt.count`) cleanly to the Logic Analyzer, Synthesis Report, and `.vcd` exporter.

### 9.2 2D Unpacked Memory Arrays & Hex Loader
- **HDL Memory Syntax:** Support 2D unpacked array declarations (`reg [W-1:0] mem [0:D-1];`, `logic [W-1:0] mem [0:D-1];`, and `logic [W-1:0] mem [D];`), indexed reads (`rdata <= mem[addr];`), indexed writes (`mem[addr] <= wdata;`), and part/bit selection on addressed words.
- **Hex Image Loader:** Support `$readmemh` / `$readmemb` initialization directives and provide a zero-dependency runtime loader (`sim.loadMemoryHex(memName, text)` + UI import) accepting raw hex (one word per line with optional `@ADDR` offsets) and Intel HEX (`.hex`) files.
- **Synthesis Attribution:** Track unpacked memories as Block RAM / M4K bits in `src/engine/synthesizer.js` so RAM arrays are reported accurately without inflating Flip-Flop utilization estimates.

### 9.3 Flat Signal Table & Dirty-Fanout Propagation
- **Flat Signal Table:** During `sim.compile()`, assign every top-level and elaborated hierarchical signal a contiguous integer ID (`0 .. N-1`) stored in flat indexed arrays (`val`, `xMask`, `zMask`, `width`, `dir`, `nameToId`) to eliminate repeated object-map lookups on hot simulation paths.
- **Dirty-Fanout Combinational Evaluation:** Precompute static driver -> consumer adjacency lists (`fanout[sigId]`) at compile time. During Phase 2 combinational settlement, queue and re-evaluate only `assign` statements and combinational `always` blocks whose input signals became dirty, while strictly preserving:
  - 4-state (`0`, `1`, `X`, `Z`) `BigInt` logic semantics,
  - Atomic Phase 1 non-blocking (`<=`) staging and commit,
  - The hard **64-iteration** combinational loop guard (`MAX_COMB_ITERATIONS`).

### 9.4 Time-Sliced Batch Execution (Up to 50 kHz+, `file://` Safe)
- **8 ms Frame Budget Scheduler:** Extend Auto Clock speeds beyond v1's `0.5 Hz – 100 Hz` to include `1 kHz`, `10 kHz`, `50 kHz`, and adaptive `Max` speeds by executing cycle batches on the main thread inside a `requestAnimationFrame`-aligned loop bounded by an **8 ms/frame CPU budget** (`performance.now()` guard).
- **No Web Workers Required:** Keep execution strictly on the main thread so the single-file `dist/virtual-fpga.html` bundle runs reliably over `file://` without browser Worker origin/CORS failures.
- **UI & Waveform Decoupling:** Keep board SVG and Logic Analyzer redraws capped at 60 FPS and support waveform capture decimation/windowing during multi-kHz bursts so UI responsiveness never degrades.

### 9.5 Protocol Edge & Pulse Tracking (`src/engine/edge_bus.js`)
- Add `src/engine/edge_bus.js` (bundled directly before `src/engine/simulator.js`) providing a lightweight, ring-buffered event bus for cycle-accurate transition tracking.
- Watchers subscribe by signal name/ID to capture exact cycle-stamped `posedge`, `negedge`, high/low pulse widths, and toggle counts even when thousands of clock cycles execute inside a single 8 ms batch frame.
- Zero overhead on unwatched signals so v1 simulations incur no extra allocations.

---

## 10. v2.5 Multi-Board Architecture & Expansion Peripheral Dock

### 10.1 Data-Driven Multi-Board Profiles (`src/boards/`)
- Introduce declarative board profile modules under `src/boards/` feeding a generalized inline-SVG renderer in `src/ui/board.js`:
  - `src/boards/de2.js` **(Default):** Intel/Altera DE2 (`EP2C35F672C6`, 33,216 LEs) — 100% parity with v1 (`CLOCK_50`, `SW[17:0]`, `KEY[3:0]` Active-Low, `LEDR[17:0]`, `LEDG[8:0]`, `HEX0..7` Active-Low, plus `GPIO_0`/`GPIO_1` expansion header mapping).
  - `src/boards/basys3.js`: Digilent Basys 3 (`XC7A35T-1CPG236C`, 33,280 Logic Cells / 20,800 LUTs) — `clk`/`CLK100MHZ`, `sw[15:0]`, 5x Active-High push buttons (`btnC`, `btnU`, `btnL`, `btnR`, `btnD`), `led[15:0]`, 4-digit multiplexed 7-segment display (`seg[6:0]`, `dp`, `an[3:0]` Active-Low with persistence-of-vision scanning across high-speed batches), and Pmod headers (`JA`, `JB`, `JC`).
  - `src/boards/hdlab.js`: HDLab Educational FPGA Kit — classroom board layout with clock input, slide switches, push buttons, LED indicator banks, 7-segment displays, and lab expansion header with `.ucf` / `.pcf` pin definitions.
- **Profile Schema:** Each profile defines `id`, bilingual `name`, target FPGA `device` specs (consumed by `synthesizer.js` for accurate device utilization), PCB color tokens (strictly within the Dark Navy + PCB Green + Electric Cyan palette — zero purple/violet), I/O port descriptors (width, polarity, clock aliases, keyboard shortcuts), SVG layout coordinates, and physical FPGA pinout tables (consumed by `exporters.js`).
- **Generalized `src/ui/board.js`:** Renders any registered board profile dynamically from its descriptor while retaining backward-compatible defaults (`de2`) and v1 `FpgaBoard` public methods.

### 10.2 Expansion Peripheral Dock (`src/peripherals/` + `src/ui/peripheral_dock.js`)
- Provide a plugin-style **Peripheral Dock** panel (`src/ui/peripheral_dock.js`) allowing users to attach virtual lab peripherals to any top-level RTL port or board expansion header via a clean **Port Binding** bar (auto-binding by standard port aliases with manual override dropdowns).
- **Plugin Contract:** Every peripheral under `src/peripherals/` exposes a consistent interface (`id`, bilingual `title`, `ports` descriptor, `mount(el)`, `bind(bindings)`, `onEdge(ev)` / `onCycle(sim)`, `onFrame()`, `reset()`, `serialize()` / `deserialize()`).
- **Built-in Expansion Peripherals:**
  1. **UART Terminal (`src/peripherals/uart.js`):** Bidirectional 8N1 serial console (`TX`/`RX`) with configurable cycles-per-bit divider, ASCII/Hex log view, transmit input queue driving RTL `rx`, and `edge_bus.js`-driven receiver decoding RTL `tx`.
  2. **PWM Meter & Servo (`src/peripherals/pwm_servo.js`):** Measures pulse width, period, frequency, and duty cycle (`0%–100%`) from `edge_bus.js` transitions and animates an inline SVG rotary servo (`0°–180°`).
  3. **Piezo Buzzer (`src/peripherals/buzzer.js`):** Native Web Audio API (`AudioContext`, `OscillatorNode`, `GainNode`) tone generator driven by `edge_bus.js` edge frequency/duty measurement, featuring mute/volume controls, audible frequency clamping, user-gesture unlock, and safe headless fallback in Node.js tests.
  4. **Virtual ADC / Sensor Slider (`src/peripherals/adc_sensor.js`):** Interactive 8/10/12-bit analog sensor control (Potentiometer / Temperature / Light modes plus optional ramp/sine waveform stimulus) driving bound RTL input buses.
  5. **Memory / SRAM Viewer (`src/peripherals/mem_viewer.js`):** Live hex + ASCII inspector for 2D unpacked memory arrays in the simulator, highlighting active writes, supporting direct cell edits, and loading `.hex` / `.mem` files.

---

## 11. v3.0 Hardware Export, Workspace Persistence & Hard Constraints

### 11.1 Exporters Engine (`src/engine/exporters.js`)
A pure, zero-dependency ES module (unit-testable in Node.js and triggered via `file://`-safe `Blob` downloads in the browser):
- **IEEE 1364 `.vcd` Waveform Export (GTKWave Compatible):**
  - Exports the captured Logic Analyzer / simulator history as standard Value Change Dump (`.vcd`) with `$date`, `$version`, `$timescale`, hierarchical `$scope module ... $upscope $end` definitions, compact ASCII `$var` identifiers, `$dumpvars`, and delta-encoded `#timestamp` updates preserving full 4-state (`0`, `1`, `x`, `z`) scalar and vector values.
- **Real FPGA Constraint Packs:**
  - Generates hardware-ready pin constraint files derived from the compiled top-level ports and the active board profile's physical pinout map:
    - **`.qsf`** — Intel Quartus Settings File (DE2 `EP2C35F672C6`).
    - **`.xdc`** — AMD/Xilinx Vivado Design Constraints (Basys 3 `XC7A35T`, including `PACKAGE_PIN`, `IOSTANDARD LVCMOS33`, and `create_clock`).
    - **`.pcf`** — Physical Constraints File (Lattice iCE40 / open-source `nextpnr` flow).
    - **`.ucf`** — User Constraints File (Xilinx ISE / HDLab educational kit).
- **`.lab.json` Workspace Save / Load:**
  - Serializes and restores the complete lab session into a versioned `.lab.json` file (`schemaVersion: 1`): active `boardId`, HDL source code, preset/filename metadata, clock speed & bounce settings, input states (`SW`, `KEY`), loaded memory hex images, docked peripheral instances + port bindings, Logic Analyzer radix/signal visibility, and UI language.
  - Restores via `<input type="file">` with schema validation and graceful fallback defaults — 100% client-side and `file://` safe.

### 11.2 Preserved Hard Constraints & Verification Guardrails (v1 – v3)
All v2.0, v2.5, and v3.0 additions MUST strictly honor every v1 Hard Constraint:
- **Zero-Dependency:** Pure Vanilla JS (ES6+), CSS3, HTML5 Canvas, inline SVG, Web Audio API, and Node.js built-ins only. Zero npm runtime packages and zero CDNs.
- **Single-File Artifact (< 500 KB Target):** Everything under `src/` bundles cleanly via `node build.mjs` into `dist/virtual-fpga.html` under **500 KB**, executable directly via `file://` without a local server or Web Workers.
- **Color System Lock:** Dark Navy (`#0D111D`, `#131A2B`, `#1E2D45`) + PCB Green (`#0E4D2E`, `#16683F`) + Electric Cyan (`#3B9ED8`) / Oceanic Blue (`#0060A2`). **Strictly NO purple or violet** anywhere in CSS, HTML, SVG, Canvas, or peripherals.
- **Live Bilingual i18n (`EN | VI`):** Every new board label, peripheral card, memory viewer control, and export dialog must support live `EN | VI` switching without resetting simulation state, keeping PCB silkscreen labels and core hardware terms in English.
- **Automated Build Assertions (`build.mjs`):** `node build.mjs` enforces a declarative `BUNDLE_ORDER` across core and expansion directories (`src/boards/`, `src/peripherals/`, `src/engine/edge_bus.js`, `src/engine/exporters.js`, `src/ui/peripheral_dock.js`) and fails the build automatically if:
  1. `dist/virtual-fpga.html` exceeds **500 KB**,
  2. Any forbidden `purple`/`violet` named color or purple/violet hex/RGB/HSL hue appears outside comments, or
  3. Any leftover ES module `import`/`export` statement or syntax collision remains in the bundled IIFE.

### 11.3 Target Modular Architecture & Test Suite
```text
virtual-fpga-sim/
├── SPEC.md
├── build.mjs                      # Declarative BUNDLE_ORDER + size/palette/syntax assertions
├── package.json                   # Modular test & build scripts (zero dependencies)
├── src/
│   ├── index.html
│   ├── styles.css
│   ├── i18n.js
│   ├── boards/                    # v2.5 board profiles (de2.js, basys3.js, hdlab.js)
│   ├── engine/
│   │   ├── lexer.js
│   │   ├── parser.js              # v2.0 multi-module, #(param), 2D arrays
│   │   ├── edge_bus.js            # v2.0 cycle-stamped edge/pulse bus
│   │   ├── simulator.js           # v2.0 flat signal table, dirty-fanout, time-sliced batching
│   │   ├── synthesizer.js         # v2.0/v2.5 multi-module, BRAM, multi-device utilization
│   │   └── exporters.js           # v3.0 .vcd, .qsf/.xdc/.pcf/.ucf, .lab.json
│   ├── peripherals/               # v2.5 plugins (uart, pwm_servo, buzzer, adc_sensor, mem_viewer)
│   ├── presets.js
│   ├── ui/
│   │   ├── editor.js
│   │   ├── board.js               # v2.5 profile-driven SVG board renderer
│   │   ├── waveform.js            # v3.0 .vcd export hook + decimation support
│   │   └── peripheral_dock.js     # v2.5 peripheral dock & port binding UI
│   └── main.js
└── tests/
    ├── engine.test.mjs            # Frozen v1 regression suite (must stay 100% green)
    ├── parser.test.mjs            # v2.0 multi-module, #(param), 2D memory parser tests
    ├── simulator.test.mjs         # v2.0 flat table, dirty-fanout, batching, edge_bus tests
    ├── peripherals.test.mjs       # v2.5 board profiles & peripheral plugin tests
    └── exporters.test.mjs         # v3.0 .vcd, constraints, .lab.json exporter tests
```
Run the complete modular test suite via `node --test tests/*.test.mjs` (or `npm test`), and the v1 regression baseline via `node --test tests/engine.test.mjs`.

---

## 12. v3.1 Multi-File HDL Workspace, Upload/Download & Preprocessor Resilience

### 12.1 Multi-File Tabbed Code Editor (`src/ui/editor.js`)
- **File Tab Bar:** Compact tab strip at the top of the HDL Editor supporting multiple `.v`, `.sv`, `.vh`, and `.svh` files simultaneously:
  - Active tab indicator in Electric Cyan (`#3B9ED8`, strictly zero purple/violet), per-tab error/warning badges, double-click inline rename, safe close button (never closes the final remaining tab), and `+ New File` button.
  - Header controls: **`Import HDL`** (`multiple`, `.v,.sv,.vh,.svh`) and **`Download HDL`** (client-side `Blob` download, 100% `file://` safe).
  - **Drag & Drop Import:** Dragging HDL files over the editor pane shows a Dark Navy overlay with an Electric Cyan (`#3B9ED8`) dashed border; dropping imports all valid files and auto-runs `Compile & Synthesize`.
- **Upload Validation & Sanitization:**
  - Reject `.vhd` / `.vhdl` files with a clear localized Console warning (Verilog / SystemVerilog only; VHDL unsupported).
  - Reject binary files (null-byte detection) and individual files exceeding **512 KB**.
  - Strip UTF-8 BOM (`\uFEFF`), normalize `\r\n`/`\r` line endings to `\n`, and clear `fileInput.value = ''` after each import so re-uploading a modified file always fires `change`.
  - If an uploaded filename matches an existing tab, replace its content cleanly; otherwise append a new tab and switch focus to it. Switching to a built-in Preset resets tabs cleanly to that preset's file(s).

### 12.2 Preprocessor & Multi-File Source Map (`src/engine/preprocessor.js`)
- Bundled immediately before `src/engine/lexer.js` in `build.mjs`.
- Accepts workspace tabs `[{ name, content }]` and emits `{ mergedCode, sourceMap, warnings, infos, defines }`:
  - Gracefully skips simulation/synthesis directives (`` `timescale ``, `` `default_nettype ``, `` `celldefine ``, `` `endcelldefine ``) by replacing them with blank lines (preserving exact line counts) and logging `INFO` entries in the Compiler Console.
  - Supports single-line `` `define NAME VALUE `` macros, `` `undef ``, `` `ifdef ``/`` `ifndef ``/`` `else ``/`` `endif `` header guards, and `` `NAME `` substitution outside comments and strings.
  - Resolves `` `include "filename.vh" `` directly against other loaded workspace tabs (with circular-include protection); missing include targets emit a structured localized warning reminding the user to upload the missing file.
  - Maintains a 1-based `sourceMap` (`mergedLine -> { fileName, originalLine }`) so syntax errors and DRC warnings highlight the exact line in the exact tab and auto-switch tabs when clicked in the Console or Synthesis Report.

### 12.3 Multi-File `.lab.json` v3 & FPGA Pack Export (`src/engine/exporters.js`)
- Upgrade `.lab.json` to `version: 3` storing `files: [{ name, content }]` and `activeFile` (alongside `boardId`, `clockMode`, `activePeripherals`, `pinBindings`, `memoryHex`, `language`), while maintaining **100% backward compatibility** when loading v1/v2 `.lab.json` files containing only a single `hdlCode` string.
- `Export FPGA Pack` includes all loaded workspace HDL tabs alongside the board's real `.qsf` / `.xdc` / `.ucf` constraint file.
- Automated tests live in `tests/hdl_import.test.mjs` and run via `node --test tests/*.test.mjs`.

---

## 13. v4.0 Academic Edition (PH002 / CE118 / CE213)

The **v4.0 Academic Edition** extends the v3.1 single-file simulator for university digital design coursework — **PH002 (Digital Circuits)**, **CE118 (Digital Logic Design)**, and **CE213 (Digital System Design with HDL)** — while preserving **100% backward compatibility** across all existing boards (`de2`, `basys3`, `hdlab`), peripherals, presets, exporters, and all 5 existing test suites (`engine.test.mjs`, `v2_engine.test.mjs`, `peripherals.test.mjs`, `exporters.test.mjs`, `hdl_import.test.mjs`).

All v1–v3.1 Hard Constraints remain strictly enforced: **Zero-Dependency**, **Single-File `file://`-safe `< 500 KB` bundle**, **Dark Navy + PCB Green + Electric Cyan palette (strictly zero purple/violet)**, and **live bilingual `EN | VI` UI**.

### 13.1 Phase 1 (v4.0-A) — Academic RTL Completeness
- **Structural Verilog Primitive Gates (`lexer.js`, `parser.js`, `simulator.js`, `synthesizer.js`):**
  - Support IEEE 1364 gate-level primitives: `and`, `or`, `not`, `nand`, `nor`, `xor`, `xnor`, and `buf` (both named instances such as `and u1(y, a, b);` and unnamed instances `nand (y, a, b, c);`, including N-input gates and multi-output `not`/`buf`).
  - Evaluate all primitive gates with full **4-state (`0`, `1`, `X`, `Z`) truth tables** (preserving controlling values such as `0 & X = 0`, `1 | X = 1`, `~(0 & X) = 1`, `~(1 | X) = 0`, and mapping `Z` inputs to `X` on gate evaluation).
  - Account for primitive gates cleanly in `synthesizer.js` LUT estimation, driver tracking (`MULTI_DRIVEN_NET`), combinational loop analysis, and critical-path depth.
- **`function ... endfunction`:**
  - Support combinational Verilog function declarations (`function [MSB:LSB] fname; input ...; ... endfunction` and ANSI-style argument headers), local `reg`/`integer` declarations, return assignment (`fname = expr;`), and function calls inside continuous `assign` and procedural expressions.
- **`generate for` & `genvar`:**
  - Support `genvar` declarations and `generate ... for (...) begin : label ... end ... endgenerate` (plus optional `generate if`) static elaboration in `parser.js`, unrolling module-level `assign`, `always`, primitive gates, and submodule instances with deterministic scoped hierarchy paths (`label[i].inst`).
- **`integer` & Case Equality (`===`, `!==`):**
  - Preserve and verify `integer` 32-bit variables (ensuring loop counters / temporaries do not inflate sequential Flip-Flop counts or emit false `BLOCKING_NONBLOCKING_MIX` warnings) and strict 4-state bit-exact case equality (`===`, `!==`), which always yields a known 1-bit `0` or `1` even when comparing `X`/`Z` bits.
- **Cascaded Internal-Signal Edge Triggering (`simulator.js`):**
  - Extend `_evalSequentialForEdgeChanges()` and `_processSignalTransition()` delta passes so sequential register commits mutating any signal bit marked in `_isSeqSensitive` capture pre-commit 4-state values and trigger downstream edge-sensitive blocks (e.g., `always @(negedge q[0]) q[1] <= ~q[1];` for multi-stage asynchronous ripple counters in PH002), bounded by a safe delta-pass iteration cap.
- **Synthesizer Enhancements (`src/engine/synthesizer.js` + Synthesis Report UI):**
  - **Critical Path / Logic Depth Estimation:** Traverse the elaborated combinational dependency DAG from primary inputs and flip-flop outputs to primary outputs and register D-inputs to report `criticalPathDepth` (logic levels), `criticalPathSignals` (signal chain), and `estimatedDelayNs` so CE118 students can compare architectural cost vs. latency (e.g., Ripple-Carry Adder vs. Carry-Lookahead Adder).
  - **Structured Module Hierarchy Tree:** Expose and render a hierarchical per-instance breakdown tree in the Synthesis Report showing local and cumulative **LUTs**, **FFs**, **DSP**, and **Memory Bits** for the top module and every elaborated submodule / generated instance.

### 13.2 Phase 2 (v4.0-B) — Mini-ModelSim Testbench Runner (`src/engine/testbench.js`)
- **Deterministic Synchronous Discrete-Event Queue (`src/engine/testbench.js`):**
  - Bundled immediately after `src/engine/simulator.js` in `build.mjs`; runs 100% on the main thread (`file://` safe, zero Web Workers) with bounded event/time safety limits (`MAX_TB_EVENTS`, `MAX_TB_TIME_NS`).
  - Supports core IEEE 1364 verification constructs:
    - `initial` procedural stimulus threads,
    - `#delay` timing controls (`#10;`, `#5 a = 1;`) and clock generators (`always #T clk = ~clk;`),
    - Procedural event waits (`@(posedge sig)`, `@(negedge sig)`, `@(sig)`),
    - `repeat (N)` iteration statements,
    - System tasks & functions: `$display`, `$monitor`, `$finish`, `$stop`, `$time` (current simulation timestamp in `ns`), and `$readmemh` (loading hex data from matching workspace tabs or embedded hex tables).
- **Dual-Mode UI Switch (`Board Mode` vs. `Testbench Mode`):**
  - **Board Mode (Default):** Auto-picks the top-level synthesizable design module while skipping `tb_*` / `*_tb` testbench modules; retains full v3.1 Virtual FPGA Board (`DE2`, `Basys 3`, `HDLab`) and Peripheral Dock behavior.
  - **Testbench Mode:** Auto-picks the `tb_*` top module, executes `testbench.js`, streams `$display`/`$monitor` output into the Compiler Console transcript, renders **time-axis (`ns`) waveforms** in `src/ui/waveform.js` (with `ns` ruler labels and cursor timestamps), extracts synthesis metrics / DRC / Critical Path / Hierarchy from the instantiated **DUT** module, and exports timestamped `.vcd` waveforms via `src/engine/exporters.js`.

### 13.3 Phase 3 (v4.0-C) — CE118/CE213 6-Lab Preset Suite & Quartus DE2 Audit
- **6-Lab Academic Preset Suite (`src/presets.js`):**
  - Grouped under a dedicated `<optgroup>` in the Preset selector without altering existing v1 (`PRESETS`) or v2.5 (`V2_PRESETS`) presets.
  - Each lab provides **multi-file tabs** (synthesizable design `.v` + self-checking `tb_*.v`), spanning PH002, CE118, and CE213:
    1. **Lab 1 (PH002):** Structural Gate-Level Full Adder & 4-bit Ripple-Carry Adder (`and`/`or`/`xor` primitives + `generate for`).
    2. **Lab 2 (PH002/CE118):** 4-bit Asynchronous Ripple Counter (`always @(negedge q[i])`) vs. Synchronous Counter.
    3. **Lab 3 (CE118):** Parameterized ALU / Carry-Lookahead Adder (`function`, critical path vs. LUT cost trade-off).
    4. **Lab 4 (CE118):** Sequence Detector / Vending Machine FSM with automated `tb_*` verification.
    5. **Lab 5 (CE213):** Register File & Datapath + Control Unit (FSMD) with auto-attached `memory_viewer.js`.
    6. **Lab 6 (CE213):** Mini Single-Cycle RISC / MIPS-Lite Processor (`$readmemh` instruction ROM + data RAM) with auto-attached `memory_viewer.js`.
- **Quartus DE2 (`Cyclone II EP2C35F672C6`) Pinout Audit (`src/boards/de2.js` & `src/engine/exporters.js`):**
  - Audit and verify all Terasic/Altera DE2 physical pin assignments (`CLOCK_50`, `CLOCK_27`, `SW[17:0]`, `KEY[3:0]`, `LEDR[17:0]`, `LEDG[8:0]`, `HEX0..7`, `UART_RXD`/`UART_TXD`, `GPIO_0`/`GPIO_1`) against the official DE2 User Manual so exported `.qsf` files compile directly in Intel Quartus II for real lab hardware.

### 13.4 Safe Zero-Dependency Bundle Compaction (`build.mjs`)
- `build.mjs` applies a tokenizer-aware compaction pass over bundled JS, CSS, and HTML (stripping `//` and `/* ... */` comments, HTML comments outside preserved tags, redundant blank lines, indentation, and safe non-semantic whitespace) without corrupting string literals, template literals (including nested `${...}` expressions), regex literals (including those after keywords such as `return /.../`), or `<pre>`/`<textarea>` elements — keeping the v4.0 single-file bundle comfortably under **500 KB**.
- Provides a `--no-minify` CLI flag (and `build({ minify: false })` API option) for human-readable debug builds while preserving all automated post-build assertions (`new Function` syntax check, zero leftover `import`/`export`, zero `purple`/`violet` colors, zero external URLs).
