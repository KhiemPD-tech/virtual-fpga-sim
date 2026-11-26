# Virtual FPGA Simulator — Trình Mô Phỏng Mạch FPGA & RTL Cho Các Môn Học

![Version](https://img.shields.io/badge/Version-4.0%20Academic%20Edition-0060A2)
![Dependencies](https://img.shields.io/badge/Dependencies-Zero-0E4D2E)
![Format](https://img.shields.io/badge/Bundle-Single--File%20HTML%20(%3C500KB)-3B9ED8)
![Tests](https://img.shields.io/badge/Unit%20Tests-47%2F47%20Passing-16683F)
![Language](https://img.shields.io/badge/UI-Song%20ng%E1%BB%AF%20EN%20%7C%20VI-131A2B)

**Virtual FPGA Simulator** là trình mô phỏng ngôn ngữ mô tả phần cứng (**Verilog / SystemVerilog**), **bo mạch phát triển FPGA ảo** và **trình chạy Testbench (Mini-ModelSim)** hoạt động hoàn toàn trên trình duyệt web.

Dự án được xây dựng theo triết lý **Zero-Dependency** (100% Vanilla JavaScript, CSS3, HTML5 Canvas, inline SVG và Web Audio API) và đóng gói thành **một tệp HTML duy nhất** ([`dist/virtual-fpga.html`](dist/virtual-fpga.html)) có thể mở trực tiếp qua `file://` mà không cần cài đặt phần mềm nặng hay chạy máy chủ cục bộ.

---

## Mục lục

- [Phục vụ các môn học nào?](#phục-vụ-các-môn-học-nào)
- [Tính năng nổi bật](#tính-năng-nổi-bật)
- [Các bo mạch FPGA được hỗ trợ](#các-bo-mạch-fpga-được-hỗ-trợ)
- [Danh sách mạch mẫu & Bộ 6 bài Lab tích hợp](#danh-sách-mạch-mẫu--bộ-6-bài-lab-tích-hợp)
- [Cú pháp Verilog / SystemVerilog được hỗ trợ](#cú-pháp-verilog--systemverilog-được-hỗ-trợ)
- [Hướng dẫn sử dụng & phát triển](#hướng-dẫn-sử-dụng--phát-triển)
- [Cấu trúc thư mục](#cấu-trúc-thư-mục)
- [Tài liệu kỹ thuật](#tài-liệu-kỹ-thuật)

---

## Phục vụ các môn học nào?

Dự án được thiết kế bám sát chương trình học và thực hành các môn học về kỹ thuật số & thiết kế vi mạch trên FPGA (như chương trình đào tạo ngành Kỹ thuật Máy tính):

| Môn học | Nội dung thực hành được hỗ trợ |
| --- | --- |
| **PH002 — Nhập môn Mạch số** | Thiết kế mức cổng (`and`, `or`, `not`, `nand`, `nor`, `xor`, `xnor`, `buf`), mạch tổ hợp (Full Adder, bộ giải mã LED 7 đoạn), Flip-Flop, bộ đếm bất đồng bộ (Async Ripple Counter) với kích cạnh tầng kế tiếp. |
| **CE118 — Thiết kế Luận lý Số** | Bộ đếm đồng bộ có nạp song song, máy trạng thái hữu hạn **FSM** (Moore/Mealy), **ALU** đa chức năng kèm cờ trạng thái, so sánh chi phí tài nguyên (**LUTs / Flip-Flops**) với **Critical Path (Logic Depth)**, kiểm tra lỗi thiết kế (**DRC**) và viết **Testbench tự kiểm tra**. |
| **CE213 — Thiết kế Hệ thống Số với HDL** | Thiết kế phân cấp đa module, tham số hóa `#(parameter)`, `generate for`, `function`, bộ nhớ 2D (Register File, SRAM, Instruction ROM), **Datapath**, **Control Unit** đa chu kỳ, **Bộ vi xử lý đơn giản (Simple Processor)**, kết nối ngoại vi (UART, PWM, SRAM) và xuất file ràng buộc chân **`.qsf`** nạp trực tiếp lên kit **Altera DE2** thật trên Quartus II. |

---

## Tính năng nổi bật

### 1. Hai chế độ mô phỏng song song (Dual-Mode)
- **Board Mode (Mô phỏng Kit FPGA ảo):** Tương tác trực quan trên bo mạch PCB vẽ bằng SVG — gạt công tắc trượt (`SW`, hỗ trợ phím tắt `0`–`9`), nhấn nút bấm (`KEY` / `BTN`, có tùy chọn **Simulate Bounce** mô phỏng hiện tượng dội phím cơ học), quan sát LED đơn, LED 7 đoạn (Active-Low và quét đa hợp 4 chữ số có hiệu ứng lưu ảnh POV), điều khiển xung nhịp từ `Manual`, `0.5 Hz` đến `10 kHz`.
- **Testbench Mode (Mini-ModelSim):** Tự động nhận diện module `tb_*`, chạy mô phỏng sự kiện rời rạc với mốc thời gian thực (`ns`), in nhật ký `$display` / `$monitor` ra **Compiler Console**, vẽ dạng sóng theo trục thời gian `ns` và trích xuất báo cáo tổng hợp cho khối **DUT** bên trong testbench.

### 2. Động cơ mô phỏng RTL 4 trạng thái & Phân tích tổng hợp
- **Logic 4 trạng thái (`0`, `1`, `X`, `Z`):** Sử dụng `BigInt` bitfield tránh tràn số 32-bit, truyền chính xác trạng thái chưa khởi tạo (`X`) và tổng trở cao (`Z`).
- **Thực thi 2 pha chuẩn chu kỳ:** Pha 1 xử lý khối tuần tự (cập nhật đồng thời các phép gán non-blocking `<=` nguyên tử); Pha 2 lan truyền tổ hợp theo cơ chế *dirty-fanout* kèm giới hạn 64 vòng lặp để phát hiện vòng lặp tổ hợp.
- **Synthesis Report & DRC:**
  - Ước lượng `4-Input LUTs`, `Flip-Flops`, `DSP`, `Memory Bits / BRAM` và tỷ lệ chiếm dụng `% Device Utilization` theo từng dòng chip FPGA.
  - Phân tích **Critical Path** (số tầng logic & ước lượng độ trễ `ns`) và hiển thị **Module Hierarchy Breakdown** cho từng module con.
  - Tự động phát hiện lỗi thiết kế (**DRC**): `Inferred Latch`, `Combinational Loop`, `Multi-driven Net`, `Blocking/Non-blocking Mix`.

### 3. Trình soạn thảo HDL đa tệp & Tiền xử lý (Preprocessor)
- Hỗ trợ nhiều tab tệp đồng thời (`.v`, `.sv`, `.vh`, `.svh`), nhập/tải tệp nhanh hoặc kéo-thả trực tiếp vào trình soạn thảo.
- Hỗ trợ chỉ thị tiền xử lý: `` `define ``, `` `undef ``, `` `ifdef `` / `` `ifndef `` / `` `else `` / `` `endif ``, `` `include "header.vh" `` giữa các tab và bỏ qua an toàn `` `timescale `` / `` `default_nettype ``.
- Ánh xạ lỗi ngược (**Source Map**) đến chính xác tên tab và số dòng bị lỗi khi nhấn vào thông báo trong Console.

### 4. Logic Analyzer (Trình xem dạng sóng)
- Vẽ sắc nét trên HTML5 Canvas (hỗ trợ màn hình HiDPI), bộ đệm vòng 1.000 mẫu ở Board Mode và vết thời gian `ns` ở Testbench Mode.
- Hỗ trợ phóng to/thu nhỏ, kéo cuộn ngang, chọn tín hiệu hiển thị, đổi hệ cơ số (`Hex` / `Dec` / `Bin`) và con trỏ đo giá trị tại từng thời điểm.

### 5. Dock ngoại vi mở rộng (Expansion Peripherals)
Gắn thêm ngoại vi ảo và ánh xạ cổng linh hoạt tới bất kỳ port nào của thiết kế:
- **UART Terminal:** Giao tiếp nối tiếp 8N1 hai chiều (`TX` / `RX`), tùy chỉnh `CLKS_PER_BIT`, hiển thị ASCII/Hex.
- **PWM Meter & Servo:** Đo chu kỳ, tần số, độ rộng xung (`duty cycle 0%–100%`) và mô phỏng góc quay động cơ Servo (`0°–180°`).
- **Piezo Buzzer:** Phát âm thanh thực qua **Web Audio API** theo tần số tín hiệu ra từ mạch RTL.
- **Virtual ADC / Sensor Slider:** Tạo tín hiệu cảm biến giả lập (biến trở, nhiệt độ, ánh sáng, sóng ramp/sine) đưa vào bus đầu vào.
- **Memory / SRAM Viewer:** Quan sát trực tiếp mảng bộ nhớ 2D (Hex + ASCII), chỉnh sửa từng ô nhớ và nạp tệp `.hex` / `.mem`.

### 6. Xuất phần cứng & Lưu bài thực hành
- **Xuất dạng sóng `.vcd`** (chuẩn IEEE 1364) để mở và phân tích bằng **GTKWave**.
- **Export FPGA Pack:** Xuất mã nguồn HDL kèm tệp ràng buộc chân vật lý thực tế (`.qsf` cho Quartus II, `.xdc` cho Vivado, `.ucf` cho ISE/HDLab).
- **Lưu / Mở bài lab `.lab.json`:** Đóng gói toàn bộ mã nguồn đa tệp, bo mạch đang chọn, ngoại vi, dữ liệu bộ nhớ và chế độ mô phỏng để sinh viên dễ dàng lưu trữ và nộp bài.
- **Song ngữ trực tiếp (`EN | VI`):** Chuyển đổi Tiếng Việt và Tiếng Anh ngay lập tức mà không reset mạch đang chạy.

---

## Các bo mạch FPGA được hỗ trợ

| Bo mạch | Chip FPGA | Cổng I/O chính | File ràng buộc |
| --- | --- | --- | --- |
| **Altera DE2** *(Mặc định)* | Cyclone II `EP2C35F672C6` (33,216 LEs) | `CLOCK_50`, `SW[17:0]`, `KEY[3:0]` *(Active-Low)*, `LEDR[17:0]`, `LEDG[8:0]`, `HEX0..HEX7` *(Active-Low)*, `GPIO[15:0]` | `.qsf` (Quartus II) |
| **Digilent Basys 3** | Xilinx Artix-7 `XC7A35T-1CPG236C` (20,800 LUTs) | `clk` / `CLK100MHZ`, `sw[15:0]`, `btnC/U/D/L/R` *(Active-High)*, `led[15:0]`, 4-digit Mux 7-Seg (`an[3:0]`, `seg[6:0]`, `dp`), `PMOD JA/JB` | `.xdc` (Vivado) |
| **HDLab Education Board** | Spartan-6 `XC6SLX16-CSG324` (14,744 LEs) | `CLK`, `SW[7:0]`, `BTN[3:0]` *(Active-Low)*, `LED[7:0]`, `HEX0..HEX3`, Bus ngoại vi (`UART_TX`, `UART_RX`, `BUZZ`, `PWM`, `ADC_DATA`), `GPIO[15:0]` | `.ucf` (ISE) |

---

## Danh sách mạch mẫu & Bộ 6 bài Lab tích hợp

### Bộ 6 bài Lab môn học (CE118 / CE213 — kèm sẵn Testbench tự kiểm tra)
Mỗi bài Lab gồm đầy đủ file thiết kế tổng hợp chạy trên kit DE2 và file `tb_*.v` để chạy kiểm chứng ở Testbench Mode:

1. **Lab 1 (CE118):** Bộ đếm đồng bộ 4-bit nạp song song — `loadable_counter.v` + `tb_counter.v`
2. **Lab 2 (CE118):** Máy trạng thái Moore nhận chuỗi chồng lấp `1011` — `fsm_moore.v` + `tb_fsm.v`
3. **Lab 3 (CE118):** Bộ ALU 4-bit (`ADD`, `SUB`, `AND`, `OR`, `XOR`, `SLT`) kèm cờ `Cout`, `Ovf`, `Zero` — `alu_4bit.v` + `tb_alu.v`
4. **Lab 4 (CE213):** Datapath MIPS rút gọn (`reg_file` 8×8 + `alu_8bit` + Mux ghi ngược + Memory Viewer) — `mips_datapath.v` + `tb_datapath.v`
5. **Lab 5 (CE213):** Khối điều khiển đa chu kỳ FSM (`FETCH → DECODE → EXEC → WB`) — `control_unit.v` + `tb_control_unit.v`
6. **Lab 6 (CE213):** Bộ vi xử lý đa chu kỳ hoàn chỉnh (`imem_rom` + `proc_ctrl` + `proc_datapath` + Memory Viewer) — `simple_processor.v` + `tb_processor.v`

### Mạch mẫu cơ bản & Ngoại vi mở rộng
- **BCD Counter 0–99 + 7-Segment (`bcd_counter.sv`):** Bộ đếm BCD 2 chữ số hiển thị trên `HEX0`/`HEX1`.
- **4-bit Full Adder (`full_adder_4bit.sv`):** Mạch cộng tổ hợp 4-bit xuất tổng ra `LEDR[3:0]` và bit nhớ ra `LEDG[0]`.
- **LED Chaser / Shift Register (`led_chaser.sv`):** Mạch LED chạy xoay vòng 2 chiều trên 18 LED đỏ.
- **Traffic Light FSM (`traffic_light_fsm.sv`):** Máy trạng thái Moore đèn giao thông (Xanh → Vàng → Đỏ).
- **UART TX/RX Echo (`uart_echo_demo.sv`):** Bộ thu phát UART 8N1 đa module tích hợp UART Terminal.
- **PWM Servo & Piezo Buzzer (`pwm_servo_buzzer.sv`):** Bộ phát xung PWM điều khiển góc Servo và bộ chia tần số phát âm thanh.
- **Mini 16×8 Synchronous SRAM (`mini_sram_demo.sv`):** Bộ điều khiển RAM đồng bộ dùng mảng 2D tích hợp Memory Viewer.

---

## Cú pháp Verilog / SystemVerilog được hỗ trợ

- **Khai báo:** `module` / `endmodule`, `input`, `output`, `wire`, `reg`, `logic`, `integer`, `parameter`, `localparam`, `genvar`, vector `[MSB:LSB]`, mảng bộ nhớ 2D `reg [W-1:0] mem [0:D-1]`.
- **Thiết kế phân cấp & Cấu trúc:** Gọi module con theo tên hoặc vị trí, ghi đè tham số `#(.PARAM(VAL))`, cổng nguyên thủy mức cổng (`and`, `or`, `not`, `nand`, `nor`, `xor`, `xnor`, `buf`), `generate for` / `generate if`, `function ... endfunction`.
- **Khối xử lý & Câu lệnh:** `assign`, `always @(posedge/negedge ...)`, `always_ff`, `always @(*)`, `always @*`, `always_comb`, `if / else if / else`, `case / default / endcase`, vòng lặp `for`, phép gán blocking (`=`) và non-blocking (`<=`).
- **Toán tử & Biểu thức:** Số học (`+`, `-`, `*`), thao tác bit (`~`, `&`, `|`, `^`), rút gọn (`&a`, `|a`, `^a`), logic (`!`, `&&`, `||`), so sánh (`==`, `!=`, `===`, `!==`, `<`, `<=`, `>`, `>=`), dịch bit (`<<`, `>>`), toán tử điều kiện (`?:`), trích bit/đoạn bit và ghép nối `{a, b}`.
- **Kiểm chứng Testbench:** `initial`, trễ `#delay`, tạo xung `always #T clk = ~clk;`, chờ sự kiện `@(posedge/negedge/sig)`, `repeat (N)`, `$display`, `$monitor`, `$time`, `$readmemh`, `$readmemb`, `$finish`, `$stop`.

> **Lưu ý:** Trình mô phỏng chỉ hỗ trợ **Verilog / SystemVerilog** (không hỗ trợ VHDL `.vhd`/`.vhdl`).

---

## Hướng dẫn sử dụng & phát triển

### Cách 1: Chạy ngay không cần cài đặt (Dành cho sinh viên / người dùng)
1. Tải dự án hoặc tải trực tiếp tệp [`dist/virtual-fpga.html`](dist/virtual-fpga.html).
2. Nhấp đúp để mở tệp bằng bất kỳ trình duyệt hiện đại nào (Chrome, Edge, Firefox...).
3. Chọn **Board** và **Preset / Bài Lab** trên thanh công cụ, sau đó nhấn **Compile & Synthesize**:
   - Ở **Board Mode**: Nhấn **Run** hoặc **Step 1 Clock**, gạt công tắc `SW` / nhấn nút `KEY` trên bo mạch và quan sát dạng sóng ở tab **Logic Analyzer**.
   - Ở **Testbench Mode**: Nhấn **Run Testbench** để chạy mô phỏng kiểm chứng tự động và xem kết quả tại **Compiler Console** & **Logic Analyzer**.

### Cách 2: Build và chạy kiểm thử từ mã nguồn (Dành cho nhà phát triển)
Yêu cầu: **Node.js >= 20** (không cần cài đặt thêm bất kỳ thư viện npm nào).

```bash
# Đóng gói toàn bộ src/ thành 1 file duy nhất dist/virtual-fpga.html
# (Tự động kiểm tra kích thước < 500 KB, cú pháp JS và quy tắc giao diện)
npm run build

# Build bản chưa rút gọn (dễ đọc để debug)
node build.mjs --no-minify

# Chạy toàn bộ bộ kiểm thử tự động (47 tests trên 8 test suites)
npm test

# Chạy riêng bộ kiểm thử hồi quy nền tảng v1
npm run test:v1
```

---

## Cấu trúc thư mục

```text
virtual-fpga-sim/
├── README.md                        # Giới thiệu & hướng dẫn sử dụng dự án
├── SPEC.md                          # Đặc tả kỹ thuật chi tiết (v1 -> v4.0)
├── package.json                     # Các lệnh build & test (không có dependency ngoài)
├── build.mjs                        # Trình đóng gói zero-dependency -> dist/virtual-fpga.html
├── dist/
│   └── virtual-fpga.html            # Bản đóng gói 1 tệp duy nhất chạy trực tiếp trên trình duyệt
├── src/
│   ├── index.html                   # Khung giao diện chính
│   ├── styles.css                   # Giao diện Dark Navy + PCB Green + Electric Cyan
│   ├── i18n.js                      # Từ điển song ngữ EN / VI
│   ├── presets.js                   # Mạch mẫu & Bộ 6 bài Lab môn học (CE118 / CE213)
│   ├── main.js                      # Điều phối Engine <-> UI <-> Board / Testbench Mode
│   ├── boards/                      # Hồ sơ các bo mạch FPGA
│   │   ├── de2.js                   # Altera DE2 (Cyclone II EP2C35)
│   │   ├── basys3.js                # Digilent Basys 3 (Artix-7 XC7A35T)
│   │   ├── hdlab.js                 # HDLab Education Board (Spartan-6)
│   │   └── registry.js
│   ├── engine/                      # Lõi biên dịch, mô phỏng, tổng hợp và xuất file
│   │   ├── preprocessor.js          # Tiền xử lý `define / `ifdef / `include + Source Map
│   │   ├── lexer.js                 # Bộ tách từ vựng Verilog / SystemVerilog
│   │   ├── parser.js                # Bộ phân tích cú pháp -> AST & Elaboration phân cấp
│   │   ├── edge_bus.js              # Bus bắt cạnh xung & độ rộng xung theo chu kỳ
│   │   ├── simulator.js             # Động cơ mô phỏng RTL 4 trạng thái, 2 pha
│   │   ├── testbench.js             # Bộ chạy Testbench sự kiện rời rạc (Mini-ModelSim)
│   │   ├── synthesizer.js           # Ước lượng LUT/FF/BRAM, Critical Path & kiểm tra DRC
│   │   └── exporters.js             # Xuất .vcd (GTKWave), .qsf/.xdc/.ucf và .lab.json
│   ├── peripherals/                 # Ngoại vi mở rộng dạng plugin
│   │   ├── uart_terminal.js         # UART 8N1 Terminal
│   │   ├── pwm_servo.js             # PWM Meter & Servo 0°-180°
│   │   ├── buzzer_audio.js          # Piezo Buzzer (Web Audio API)
│   │   ├── adc_sensor.js            # Virtual ADC / Sensor Slider
│   │   ├── memory_viewer.js         # Trình xem & nạp Hex cho bộ nhớ 2D
│   │   └── registry.js
│   └── ui/                          # Các thành phần giao diện người dùng
│       ├── editor.js                # Trình soạn thảo HDL đa tab có highlight cú pháp
│       ├── board.js                 # Trình vẽ bo mạch FPGA SVG tương tác
│       ├── waveform.js              # Logic Analyzer trên HTML5 Canvas
│       └── peripheral_dock.js       # Dock quản lý và ánh xạ cổng ngoại vi
└── tests/                           # Bộ kiểm thử tự động (Node.js native test runner)
    ├── engine.test.mjs              # Kiểm thử lõi v1 (Lexer, Parser, Simulator, DRC)
    ├── v2_engine.test.mjs           # Đa module, mảng 2D, EdgeBus, hiệu năng
    ├── peripherals.test.mjs         # 3 bo mạch FPGA & 5 ngoại vi mở rộng
    ├── exporters.test.mjs           # Xuất .vcd, .qsf/.xdc/.ucf và .lab.json
    ├── hdl_import.test.mjs          # Tiền xử lý, đa tệp và kiểm tra upload HDL
    ├── v4_academic_rtl.test.mjs     # Cổng nguyên thủy, function, generate, ripple counter
    ├── testbench.test.mjs           # Bộ chạy Testbench & mốc thời gian ns
    └── v4_labs.test.mjs             # Kiểm thử toàn bộ 6 bài Lab CE118/CE213 & pinout DE2
```

---

## Tài liệu kỹ thuật

Chi tiết đầy đủ về kiến trúc nội bộ, quy chuẩn thiết kế và các ràng buộc kỹ thuật được trình bày trong tệp [`SPEC.md`](SPEC.md).
