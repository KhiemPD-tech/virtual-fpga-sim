/**
 * Phase 4 — Built-in Synthesizable Verilog / SystemVerilog Presets (SPEC Section 7)
 * Every preset conforms strictly to src/engine/parser.js and compiles with
 * zero syntax errors and zero unintended DRC warnings.
 */

export const PRESETS = [
  {
    id: 'bcd_counter',
    filename: 'bcd_counter.sv',
    name: 'BCD Counter 0-99 + 7-Segment (Active-Low)',
    title: {
      en: 'BCD Counter 0–99 + 7-Segment (Active-Low)',
      vi: 'Bộ đếm BCD 0–99 + LED 7 đoạn (Active-Low)',
    },
    description: {
      en: '2-digit synchronous BCD counter (00–99) driving HEX0/HEX1 (Active-Low) and LEDR[7:0]. Press KEY[0] for async Active-Low reset; toggle SW[0] up to pause.',
      vi: 'Bộ đếm BCD 2 chữ số (00–99) hiển thị trên HEX0/HEX1 (Active-Low) và LEDR[7:0]. Nhấn KEY[0] để reset bất đồng bộ (Active-Low); gạt SW[0] lên để tạm dừng.',
    },
    code: `// ============================================================
// Preset 1: 2-Digit BCD Counter (00-99) + Active-Low 7-Segment
// - KEY[0] (Active-Low): Async Reset to 00
// - SW[0]              : Pause / Hold when 1
// - HEX1, HEX0         : Active-Low 7-Segment Displays
// - LEDR[7:0]          : Raw BCD {tens, ones}
// ============================================================
module bcd_counter (
  input  logic        CLOCK_50,
  input  logic [17:0] SW,
  input  logic [3:0]  KEY,
  output logic [17:0] LEDR,
  output logic [8:0]  LEDG,
  output logic [6:0]  HEX0,
  output logic [6:0]  HEX1
);
  logic [3:0] ones;
  logic [3:0] tens;

  // Sequential BCD counter with async Active-Low reset on KEY[0]
  always_ff @(posedge CLOCK_50 or negedge KEY[0]) begin
    if (!KEY[0]) begin
      ones <= 4'd0;
      tens <= 4'd0;
    end else if (!SW[0]) begin
      if (ones == 4'd9) begin
        ones <= 4'd0;
        if (tens == 4'd9) begin
          tens <= 4'd0;
        end else begin
          tens <= tens + 4'd1;
        end
      end else begin
        ones <= ones + 4'd1;
      end
    end
  end

  // Raw BCD output on LEDR[7:0]; running indicator on LEDG[0]
  assign LEDR = {10'd0, tens, ones};
  assign LEDG = {8'd0, ~SW[0]};

  // Active-Low 7-Segment Decoder for Ones digit (HEX0)
  always_comb begin
    case (ones)
      4'd0: HEX0 = 7'b100_0000;
      4'd1: HEX0 = 7'b111_1001;
      4'd2: HEX0 = 7'b010_0100;
      4'd3: HEX0 = 7'b011_0000;
      4'd4: HEX0 = 7'b001_1001;
      4'd5: HEX0 = 7'b001_0010;
      4'd6: HEX0 = 7'b000_0010;
      4'd7: HEX0 = 7'b111_1000;
      4'd8: HEX0 = 7'b000_0000;
      4'd9: HEX0 = 7'b001_0000;
      default: HEX0 = 7'b111_1111;
    endcase
  end

  // Active-Low 7-Segment Decoder for Tens digit (HEX1)
  always_comb begin
    case (tens)
      4'd0: HEX1 = 7'b100_0000;
      4'd1: HEX1 = 7'b111_1001;
      4'd2: HEX1 = 7'b010_0100;
      4'd3: HEX1 = 7'b011_0000;
      4'd4: HEX1 = 7'b001_1001;
      4'd5: HEX1 = 7'b001_0010;
      4'd6: HEX1 = 7'b000_0010;
      4'd7: HEX1 = 7'b111_1000;
      4'd8: HEX1 = 7'b000_0000;
      4'd9: HEX1 = 7'b001_0000;
      default: HEX1 = 7'b111_1111;
    endcase
  end
endmodule
`,
  },

  {
    id: 'full_adder_4bit',
    filename: 'full_adder_4bit.sv',
    name: '4-bit Full Adder (SW -> LEDR / LEDG)',
    title: {
      en: '4-bit Full Adder (SW → LEDR / LEDG)',
      vi: 'Mạch cộng toàn phần 4-bit (SW → LEDR / LEDG)',
    },
    description: {
      en: 'Combinational 4-bit adder computing SW[3:0] + SW[7:4]. Sum drives LEDR[3:0] and carry-out drives LEDG[0] (try 4\'hF + 4\'h1 to trigger overflow carry).',
      vi: 'Mạch cộng tổ hợp 4-bit tính SW[3:0] + SW[7:4]. Tổng xuất ra LEDR[3:0] và bit nhớ (carry-out) ra LEDG[0] (thử 4\'hF + 4\'h1 để quan sát tràn bit nhớ).',
    },
    code: `// ============================================================
// Preset 2: 4-bit Combinational Full Adder
// - SW[3:0]  : 4-bit Operand A
// - SW[7:4]  : 4-bit Operand B
// - LEDR[3:0]: 4-bit Sum
// - LEDG[0]  : Carry-Out bit
// ============================================================
module full_adder_4bit (
  input  logic [17:0] SW,
  output logic [17:0] LEDR,
  output logic [8:0]  LEDG
);
  logic [3:0] op_a;
  logic [3:0] op_b;
  logic [4:0] sum_ext;

  assign op_a    = SW[3:0];
  assign op_b    = SW[7:4];
  assign sum_ext = {1'b0, op_a} + {1'b0, op_b};

  assign LEDR = {14'd0, sum_ext[3:0]};
  assign LEDG = {8'd0, sum_ext[4]};
endmodule
`,
  },

  {
    id: 'led_chaser',
    filename: 'led_chaser.sv',
    name: 'LED Chaser / Bidirectional Shift Register',
    title: {
      en: 'LED Chaser / Bidirectional Shift Register',
      vi: 'Mạch LED chạy 2 chiều / Thanh ghi dịch',
    },
    description: {
      en: '18-bit rotating running light across LEDR[17:0]. Press KEY[0] to reset seed bit; SW[1] selects shift direction (0=Left, 1=Right); SW[0] pauses.',
      vi: 'Mạch LED chạy xoay vòng 18-bit trên LEDR[17:0]. Nhấn KEY[0] để nạp bit khởi tạo; SW[1] chọn chiều dịch (0=Trái, 1=Phải); SW[0] tạm dừng.',
    },
    code: `// ============================================================
// Preset 3: Bidirectional LED Chaser (18-bit Barrel Rotate)
// - KEY[0] (Active-Low): Async Reset to LEDR[0] = 1
// - SW[0]              : Pause / Hold when 1
// - SW[1]              : Direction (0 = Shift Left, 1 = Shift Right)
// - LEDR[17:0]         : Running Light Pattern
// ============================================================
module led_chaser (
  input  logic        CLOCK_50,
  input  logic [17:0] SW,
  input  logic [3:0]  KEY,
  output logic [17:0] LEDR,
  output logic [8:0]  LEDG
);
  logic [17:0] pattern;

  always_ff @(posedge CLOCK_50 or negedge KEY[0]) begin
    if (!KEY[0]) begin
      pattern <= 18'b00_0000_0000_0000_0001;
    end else if (!SW[0]) begin
      if (SW[1]) begin
        // Rotate right (MSB -> LSB)
        pattern <= {pattern[0], pattern[17:1]};
      end else begin
        // Rotate left (LSB -> MSB)
        pattern <= {pattern[16:0], pattern[17]};
      end
    end
  end

  assign LEDR = pattern;
  assign LEDG = {7'd0, SW[1], ~SW[0]};
endmodule
`,
  },

  {
    id: 'traffic_light_fsm',
    filename: 'traffic_light_fsm.sv',
    name: 'Traffic Light FSM',
    title: {
      en: 'Traffic Light FSM',
      vi: 'Máy trạng thái FSM Đèn giao thông',
    },
    description: {
      en: 'Moore Traffic Light FSM (GREEN -> YELLOW -> RED) driving LEDG and LEDR with internal state & timer registers observable on the Logic Analyzer. Reset via KEY[0].',
      vi: 'Máy trạng thái Moore đèn giao thông (XANH -> VÀNG -> ĐỎ) điều khiển LEDG và LEDR với thanh ghi state & timer quan sát trực tiếp trên Logic Analyzer. Reset bằng KEY[0].',
    },
    code: `// ============================================================
// Preset 4: Traffic Light Moore FSM
// - KEY[0] (Active-Low): Async Reset to S_GREEN
// - SW[0]              : Hold / Freeze timer when 1
// - LEDG[3:0]          : Green Light
// - LEDR[3:0]          : Yellow / Caution Light
// - LEDR[17:14]        : Red Light
// - HEX0               : Current Timer Count (0-3)
// ============================================================
module traffic_light_fsm (
  input  logic        CLOCK_50,
  input  logic [17:0] SW,
  input  logic [3:0]  KEY,
  output logic [17:0] LEDR,
  output logic [8:0]  LEDG,
  output logic [6:0]  HEX0
);
  localparam [1:0] S_GREEN  = 2'd0;
  localparam [1:0] S_YELLOW = 2'd1;
  localparam [1:0] S_RED    = 2'd2;

  logic [1:0] state;
  logic [3:0] timer;

  // Next-state & timer sequential logic
  always_ff @(posedge CLOCK_50 or negedge KEY[0]) begin
    if (!KEY[0]) begin
      state <= S_GREEN;
      timer <= 4'd0;
    end else if (!SW[0]) begin
      case (state)
        S_GREEN: begin
          if (timer == 4'd3) begin
            state <= S_YELLOW;
            timer <= 4'd0;
          end else begin
            timer <= timer + 4'd1;
          end
        end

        S_YELLOW: begin
          if (timer == 4'd1) begin
            state <= S_RED;
            timer <= 4'd0;
          end else begin
            timer <= timer + 4'd1;
          end
        end

        S_RED: begin
          if (timer == 4'd3) begin
            state <= S_GREEN;
            timer <= 4'd0;
          end else begin
            timer <= timer + 4'd1;
          end
        end

        default: begin
          state <= S_GREEN;
          timer <= 4'd0;
        end
      endcase
    end
  end

  // Moore output decoder for Traffic Lights
  always_comb begin
    LEDR = 18'd0;
    LEDG = 9'd0;
    case (state)
      S_GREEN:  LEDG = 9'b0_0000_1111;
      S_YELLOW: LEDR = 18'b00_0000_0000_0000_1111;
      S_RED:    LEDR = 18'b11_1100_0000_0000_0000;
      default:  LEDR = 18'd0;
    endcase
  end

  // Display timer digit on HEX0 (Active-Low)
  always_comb begin
    case (timer)
      4'd0: HEX0 = 7'b100_0000;
      4'd1: HEX0 = 7'b111_1001;
      4'd2: HEX0 = 7'b010_0100;
      4'd3: HEX0 = 7'b011_0000;
      default: HEX0 = 7'b111_1111;
    endcase
  end
endmodule
`,
  },
];

export const V2_PRESETS = [
  {
    id: 'uart_echo_demo',
    filename: 'uart_echo_demo.sv',
    name: 'UART TX/RX Echo + Byte Counter (Multi-Module)',
    recommendedBoard: 'hdlab',
    recommendedClockSpeed: '2000',
    recommendedPeripherals: [
      { id: 'uart_terminal', config: { cyclesPerBit: 16 }, bindings: { tx: 'UART_TX', rx: 'UART_RX' } },
    ],
    title: {
      en: 'UART TX/RX Echo + Byte Counter (Multi-Module)',
      vi: 'UART TX/RX Echo + Bộ đếm byte (Đa module)',
    },
    description: {
      en: 'Multi-module 8N1 UART transceiver (CLKS_PER_BIT=16). Press KEY[0]/BTN[0] to reset, run at 2 kHz, type text in UART Terminal to echo back, or flip SW[0] to transmit A/B/C test bytes.',
      vi: 'Bộ thu phát UART 8N1 đa module (CLKS_PER_BIT=16). Nhấn KEY[0]/BTN[0] để reset, chạy ở 2 kHz, gõ ký tự vào UART Terminal để echo phản hồi, hoặc gạt SW[0] để phát byte thử nghiệm A/B/C.',
    },
    code: `// ============================================================
// Preset 5 (v2.5): Multi-Module UART TX/RX Echo + Byte Counter
// - Submodules: uart_tx #(16) and uart_rx #(16)
// - Auto-attaches UART Terminal (tx -> UART_TX, rx -> UART_RX)
// - Flip SW[0] up to emit test ASCII ('A', 'B', ...) on UART_TX
// - Send text from UART Terminal to echo back & count on LEDR
// ============================================================
module uart_tx #(
  parameter CLKS_PER_BIT = 16
) (
  input  logic       clk,
  input  logic       rst_n,
  input  logic       tx_start,
  input  logic [7:0] tx_data,
  output logic       tx_line,
  output logic       tx_busy
);
  logic [9:0] shift_reg;
  logic [3:0] bit_idx;
  logic [7:0] clk_cnt;

  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      tx_line   <= 1'b1;
      tx_busy   <= 1'b0;
      shift_reg <= 10'h3FF;
      bit_idx   <= 4'd0;
      clk_cnt   <= 8'd0;
    end else if (!tx_busy) begin
      tx_line <= 1'b1;
      if (tx_start) begin
        tx_busy   <= 1'b1;
        shift_reg <= {1'b1, tx_data, 1'b0};
        bit_idx   <= 4'd0;
        clk_cnt   <= 8'd0;
      end
    end else begin
      tx_line <= shift_reg[0];
      if (clk_cnt == CLKS_PER_BIT - 1) begin
        clk_cnt   <= 8'd0;
        shift_reg <= {1'b1, shift_reg[9:1]};
        if (bit_idx == 4'd9) begin
          tx_busy <= 1'b0;
        end else begin
          bit_idx <= bit_idx + 4'd1;
        end
      end else begin
        clk_cnt <= clk_cnt + 8'd1;
      end
    end
  end
endmodule

module uart_rx #(
  parameter CLKS_PER_BIT = 16
) (
  input  logic       clk,
  input  logic       rst_n,
  input  logic       rx_line,
  output logic [7:0] rx_data,
  output logic       rx_valid
);
  localparam [1:0] S_IDLE  = 2'd0;
  localparam [1:0] S_START = 2'd1;
  localparam [1:0] S_DATA  = 2'd2;
  localparam [1:0] S_STOP  = 2'd3;

  logic [1:0] state;
  logic [7:0] clk_cnt;
  logic [2:0] bit_idx;
  logic [7:0] shift_reg;
  logic       rx_prev;

  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      state     <= S_IDLE;
      clk_cnt   <= 8'd0;
      bit_idx   <= 3'd0;
      shift_reg <= 8'd0;
      rx_data   <= 8'd0;
      rx_valid  <= 1'b0;
      rx_prev   <= 1'b0;
    end else begin
      rx_prev  <= rx_line;
      rx_valid <= 1'b0;

      case (state)
        S_IDLE: begin
          clk_cnt <= 8'd0;
          if (rx_prev && !rx_line) begin
            state <= S_START;
          end
        end

        S_START: begin
          if (clk_cnt == (CLKS_PER_BIT / 2) - 1) begin
            clk_cnt <= 8'd0;
            if (!rx_line) begin
              state   <= S_DATA;
              bit_idx <= 3'd0;
            end else begin
              state <= S_IDLE;
            end
          end else begin
            clk_cnt <= clk_cnt + 8'd1;
          end
        end

        S_DATA: begin
          if (clk_cnt == CLKS_PER_BIT - 1) begin
            clk_cnt   <= 8'd0;
            shift_reg <= {rx_line, shift_reg[7:1]};
            if (bit_idx == 3'd7) begin
              state <= S_STOP;
            end else begin
              bit_idx <= bit_idx + 3'd1;
            end
          end else begin
            clk_cnt <= clk_cnt + 8'd1;
          end
        end

        S_STOP: begin
          if (clk_cnt == CLKS_PER_BIT - 1) begin
            clk_cnt  <= 8'd0;
            rx_data  <= shift_reg;
            rx_valid <= 1'b1;
            state    <= S_IDLE;
          end else begin
            clk_cnt <= clk_cnt + 8'd1;
          end
        end

        default: state <= S_IDLE;
      endcase
    end
  end
endmodule

module uart_echo_demo (
  input  logic        CLOCK_50,
  input  logic [17:0] SW,
  input  logic [3:0]  KEY,
  input  logic        UART_RX,
  output logic        UART_TX,
  output logic [17:0] LEDR,
  output logic [8:0]  LEDG,
  output logic [6:0]  HEX0,
  output logic [6:0]  HEX1
);
  logic [7:0] rx_byte;
  logic       rx_done;
  logic       tx_busy;
  logic       tx_start;
  logic [7:0] tx_payload;
  logic [7:0] last_byte;
  logic [7:0] echo_count;
  logic [3:0] test_seq;
  logic       sw0_prev;

  uart_rx #(.CLKS_PER_BIT(16)) u_rx (
    .clk(CLOCK_50),
    .rst_n(KEY[0]),
    .rx_line(UART_RX),
    .rx_data(rx_byte),
    .rx_valid(rx_done)
  );

  uart_tx #(.CLKS_PER_BIT(16)) u_tx (
    .clk(CLOCK_50),
    .rst_n(KEY[0]),
    .tx_start(tx_start),
    .tx_data(tx_payload),
    .tx_line(UART_TX),
    .tx_busy(tx_busy)
  );

  always_ff @(posedge CLOCK_50 or negedge KEY[0]) begin
    if (!KEY[0]) begin
      tx_start   <= 1'b0;
      tx_payload <= 8'h41;
      last_byte  <= 8'd0;
      echo_count <= 8'd0;
      test_seq   <= 4'd0;
      sw0_prev   <= 1'b0;
    end else begin
      tx_start <= 1'b0;
      sw0_prev <= SW[0];

      if (rx_done) begin
        last_byte  <= rx_byte;
        echo_count <= echo_count + 8'd1;
        if (!tx_busy) begin
          tx_payload <= rx_byte;
          tx_start   <= 1'b1;
        end
      end else if (SW[0] && !sw0_prev && !tx_busy) begin
        tx_payload <= 8'h41 + {4'd0, test_seq};
        tx_start   <= 1'b1;
        test_seq   <= test_seq + 4'd1;
      end
    end
  end

  assign LEDR = {2'b00, echo_count, last_byte};
  assign LEDG = {7'd0, rx_done, tx_busy};

  always_comb begin
    case (last_byte[3:0])
      4'h0: HEX0 = 7'b100_0000;
      4'h1: HEX0 = 7'b111_1001;
      4'h2: HEX0 = 7'b010_0100;
      4'h3: HEX0 = 7'b011_0000;
      4'h4: HEX0 = 7'b001_1001;
      4'h5: HEX0 = 7'b001_0010;
      4'h6: HEX0 = 7'b000_0010;
      4'h7: HEX0 = 7'b111_1000;
      4'h8: HEX0 = 7'b000_0000;
      4'h9: HEX0 = 7'b001_0000;
      4'hA: HEX0 = 7'b000_1000;
      4'hB: HEX0 = 7'b000_0011;
      4'hC: HEX0 = 7'b100_0110;
      4'hD: HEX0 = 7'b010_0001;
      4'hE: HEX0 = 7'b000_0110;
      default: HEX0 = 7'b000_1110;
    endcase
  end

  always_comb begin
    case (last_byte[7:4])
      4'h0: HEX1 = 7'b100_0000;
      4'h1: HEX1 = 7'b111_1001;
      4'h2: HEX1 = 7'b010_0100;
      4'h3: HEX1 = 7'b011_0000;
      4'h4: HEX1 = 7'b001_1001;
      4'h5: HEX1 = 7'b001_0010;
      4'h6: HEX1 = 7'b000_0010;
      4'h7: HEX1 = 7'b111_1000;
      4'h8: HEX1 = 7'b000_0000;
      4'h9: HEX1 = 7'b001_0000;
      4'hA: HEX1 = 7'b000_1000;
      4'hB: HEX1 = 7'b000_0011;
      4'hC: HEX1 = 7'b100_0110;
      4'hD: HEX1 = 7'b010_0001;
      4'hE: HEX1 = 7'b000_0110;
      default: HEX1 = 7'b000_1110;
    endcase
  end
endmodule
`,
  },

  {
    id: 'pwm_servo_buzzer',
    filename: 'pwm_servo_buzzer.sv',
    name: 'PWM Servo & Piezo Buzzer Generator',
    recommendedBoard: 'hdlab',
    recommendedClockSpeed: '2000',
    recommendedPeripherals: [
      { id: 'pwm_servo', bindings: { pwm: 'PWM' } },
      { id: 'buzzer_audio', bindings: { buzz: 'BUZZ' } },
    ],
    title: {
      en: 'PWM Servo & Piezo Buzzer Generator',
      vi: 'Bộ phát PWM Servo & Còi Piezo',
    },
    description: {
      en: 'Parameterized PWM channel + programmable tone divider. Toggle SW[3:0] to sweep servo angle (0°–180°), SW[7:4] to change buzzer pitch, and click Unmute in Piezo Buzzer.',
      vi: 'Kênh PWM tham số hóa + bộ chia tần số âm thanh. Gạt SW[3:0] để xoay góc Servo (0°–180°), SW[7:4] đổi cao độ còi, và nhấn Bật âm thanh ở Còi Piezo.',
    },
    code: `// ============================================================
// Preset 6 (v2.5): Parameterized PWM Servo & Piezo Tone Generator
// - SW[3:0] : PWM duty cycle (6% to 96% -> Servo 10° to 173°)
// - SW[7:4] : Tone divider pitch control for BUZZ
// - KEY[0]  : Active-Low async reset
// ============================================================
module pwm_channel #(
  parameter PERIOD = 100
) (
  input  logic       clk,
  input  logic       rst_n,
  input  logic [7:0] duty,
  output logic       pwm_out
);
  logic [7:0] cnt;

  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      cnt     <= 8'd0;
      pwm_out <= 1'b0;
    end else begin
      if (cnt == PERIOD - 1)
        cnt <= 8'd0;
      else
        cnt <= cnt + 8'd1;
      pwm_out <= (cnt < duty);
    end
  end
endmodule

module tone_divider #(
  parameter WIDTH = 8
) (
  input  logic             clk,
  input  logic             rst_n,
  input  logic [WIDTH-1:0] half_period,
  output logic             tone_out
);
  logic [WIDTH-1:0] cnt;

  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      cnt      <= '0;
      tone_out <= 1'b0;
    end else if (cnt >= half_period) begin
      cnt      <= '0;
      tone_out <= ~tone_out;
    end else begin
      cnt <= cnt + 1;
    end
  end
endmodule

module pwm_servo_buzzer (
  input  logic        CLOCK_50,
  input  logic [17:0] SW,
  input  logic [3:0]  KEY,
  output logic        PWM,
  output logic        BUZZ,
  output logic [17:0] LEDR,
  output logic [8:0]  LEDG
);
  wire [7:0] duty_val   = {2'b00, SW[3:0], 2'b00} + 8'd6;
  wire [7:0] tone_limit = {2'b00, SW[7:4], 2'b00} + 8'd4;

  pwm_channel #(.PERIOD(100)) u_pwm (
    .clk(CLOCK_50),
    .rst_n(KEY[0]),
    .duty(duty_val),
    .pwm_out(PWM)
  );

  tone_divider #(.WIDTH(8)) u_tone (
    .clk(CLOCK_50),
    .rst_n(KEY[0]),
    .half_period(tone_limit),
    .tone_out(BUZZ)
  );

  assign LEDR = {10'd0, duty_val};
  assign LEDG = {7'd0, BUZZ, PWM};
endmodule
`,
  },

  {
    id: 'mini_sram_demo',
    filename: 'mini_sram_demo.sv',
    name: 'Mini 16×8 Synchronous SRAM Controller',
    recommendedBoard: 'de2',
    recommendedClockSpeed: '5',
    recommendedPeripherals: [
      {
        id: 'memory_viewer',
        config: {
          memoryName: 'mem',
          sampleHex: '@00\n48 44 4C 20 46 50 47 41\n10 20 30 40 50 60 70 80',
        },
      },
    ],
    title: {
      en: 'Mini 16×8 Synchronous SRAM Controller',
      vi: 'Bộ điều khiển SRAM đồng bộ 16×8',
    },
    description: {
      en: 'Unpacked 2D memory array reg [7:0] mem [0:15]. Load hex data in Memory Viewer, pick address on SW[3:0], write data on SW[11:4], and raise SW[12] (WE) to write synchronously.',
      vi: 'Mảng bộ nhớ 2D reg [7:0] mem [0:15]. Nạp dữ liệu Hex trong Trình xem Bộ nhớ, chọn địa chỉ trên SW[3:0], dữ liệu ghi SW[11:4] và gạt SW[12] (WE) để ghi đồng bộ.',
    },
    code: `// ============================================================
// Preset 7 (v2.5): Synchronous 16x8 SRAM Controller (2D Array)
// - SW[3:0]  : Address (0..15)
// - SW[11:4] : Write Data (8-bit)
// - SW[12]   : Write Enable (WE = 1 writes mem[addr] on posedge)
// - KEY[0]   : Async Active-Low reset for output register rdata
// - HEX1/HEX0 & LEDR[7:0] : Registered read data
// ============================================================
module mini_sram_demo (
  input  logic        CLOCK_50,
  input  logic [17:0] SW,
  input  logic [3:0]  KEY,
  output logic [17:0] LEDR,
  output logic [8:0]  LEDG,
  output logic [6:0]  HEX0,
  output logic [6:0]  HEX1
);
  reg   [7:0] mem [0:15];
  logic [7:0] rdata;

  wire [3:0] addr  = SW[3:0];
  wire [7:0] wdata = SW[11:4];
  wire       we    = SW[12];

  always_ff @(posedge CLOCK_50 or negedge KEY[0]) begin
    if (!KEY[0]) begin
      rdata <= 8'd0;
    end else begin
      if (we) begin
        mem[addr] <= wdata;
      end
      rdata <= mem[addr];
    end
  end

  assign LEDR = {2'b00, wdata, rdata};
  assign LEDG = {we, mem[addr]};

  always_comb begin
    case (rdata[3:0])
      4'h0: HEX0 = 7'b100_0000;
      4'h1: HEX0 = 7'b111_1001;
      4'h2: HEX0 = 7'b010_0100;
      4'h3: HEX0 = 7'b011_0000;
      4'h4: HEX0 = 7'b001_1001;
      4'h5: HEX0 = 7'b001_0010;
      4'h6: HEX0 = 7'b000_0010;
      4'h7: HEX0 = 7'b111_1000;
      4'h8: HEX0 = 7'b000_0000;
      4'h9: HEX0 = 7'b001_0000;
      4'hA: HEX0 = 7'b000_1000;
      4'hB: HEX0 = 7'b000_0011;
      4'hC: HEX0 = 7'b100_0110;
      4'hD: HEX0 = 7'b010_0001;
      4'hE: HEX0 = 7'b000_0110;
      default: HEX0 = 7'b000_1110;
    endcase
  end

  always_comb begin
    case (rdata[7:4])
      4'h0: HEX1 = 7'b100_0000;
      4'h1: HEX1 = 7'b111_1001;
      4'h2: HEX1 = 7'b010_0100;
      4'h3: HEX1 = 7'b011_0000;
      4'h4: HEX1 = 7'b001_1001;
      4'h5: HEX1 = 7'b001_0010;
      4'h6: HEX1 = 7'b000_0010;
      4'h7: HEX1 = 7'b111_1000;
      4'h8: HEX1 = 7'b000_0000;
      4'h9: HEX1 = 7'b001_0000;
      4'hA: HEX1 = 7'b000_1000;
      4'hB: HEX1 = 7'b000_0011;
      4'hC: HEX1 = 7'b100_0110;
      4'hD: HEX1 = 7'b010_0001;
      4'hE: HEX1 = 7'b000_0110;
      default: HEX1 = 7'b000_1110;
    endcase
  end
endmodule
`,
  },
];

// Shared compact Active-Low 7-Segment hex decoder function for CE118/CE213 Labs
const _LAB_HEX7_FN = `  function [6:0] hex7(input [3:0] d);
    case (d)
      4'h0:hex7=7'b1000000; 4'h1:hex7=7'b1111001; 4'h2:hex7=7'b0100100; 4'h3:hex7=7'b0110000;
      4'h4:hex7=7'b0011001; 4'h5:hex7=7'b0010010; 4'h6:hex7=7'b0000010; 4'h7:hex7=7'b1111000;
      4'h8:hex7=7'b0000000; 4'h9:hex7=7'b0010000; 4'hA:hex7=7'b0001000; 4'hB:hex7=7'b0000011;
      4'hC:hex7=7'b1000110; 4'hD:hex7=7'b0100001; 4'hE:hex7=7'b0000110; default:hex7=7'b0001110;
    endcase
  endfunction`;

// ============================================================================
// Phase 3 (v4.0-C): CE118 / CE213 6-Lab Multi-File Course Suite (DE2 + ModelSim)
// ============================================================================
export const COURSE_LAB_PRESETS = [
  {
    id: 'lab1_loadable_counter',
    filename: 'loadable_counter.v',
    name: 'Lab 1: 4-bit Loadable Counter (DE2 + TB)',
    recommendedBoard: 'de2',
    recommendedClockSpeed: '1',
    recommendedPeripherals: [],
    title: {
      en: 'Lab 1: 4-bit Loadable Counter (SW/HEX0 + TB)',
      vi: 'Lab 1: Bộ đếm 4-bit có nạp song song (SW/HEX0 + TB)',
    },
    description: {
      en: 'CE118 Lab 1 — Synchronous 4-bit counter with parallel load (SW[3:0] data, SW[4] load, KEY[0] async reset, LEDR[3:0] & HEX0) + tb_counter.v.',
      vi: 'CE118 Lab 1 — Bộ đếm đồng bộ 4-bit nạp song song (SW[3:0] dữ liệu, SW[4] nạp, KEY[0] reset, LEDR[3:0] & HEX0) + tb_counter.v.',
    },
    files: [
      {
        name: 'loadable_counter.v',
        content: `// CE118 Lab 1: 4-bit Synchronous Loadable Counter (Altera DE2)
// SW[3:0]: Parallel Load Data | SW[4]: Load Enable | KEY[0]: Active-Low Reset
module loadable_counter (
  input  wire        CLOCK_50,
  input  wire [17:0] SW,
  input  wire [3:0]  KEY,
  output wire [17:0] LEDR,
  output wire [8:0]  LEDG,
  output wire [6:0]  HEX0
);
  reg [3:0] q;
  initial q = 4'd0;

  always @(posedge CLOCK_50 or negedge KEY[0]) begin
    if (!KEY[0])
      q <= 4'd0;
    else if (SW[4])
      q <= SW[3:0];
    else
      q <= q + 4'd1;
  end

${_LAB_HEX7_FN}

  assign LEDR = {14'd0, q};
  assign LEDG = {8'd0, SW[4]};
  assign HEX0 = hex7(q);
endmodule
`,
      },
      {
        name: 'tb_counter.v',
        content: `// ModelSim Testbench for Lab 1: 4-bit Loadable Counter
module tb_counter;
  reg clk;
  reg [17:0] sw;
  reg [3:0] key;
  wire [17:0] ledr;
  wire [8:0] ledg;
  wire [6:0] hex0;
  integer errs;

  loadable_counter dut (
    .CLOCK_50(clk), .SW(sw), .KEY(key),
    .LEDR(ledr), .LEDG(ledg), .HEX0(hex0)
  );

  always #5 clk = ~clk;

  initial begin
    errs = 0; clk = 0; sw = 18'd0; key = 4'b1110;
    #12;
    if (ledr[3:0] !== 4'd0) begin errs = errs + 1; $display("FAIL reset q=%h", ledr[3:0]); end
    key = 4'b1111;
    // Parallel load 4'hA
    sw = 18'h0001A;
    @(posedge clk); #1;
    if (ledr[3:0] !== 4'hA) begin errs = errs + 1; $display("FAIL load q=%h", ledr[3:0]); end
    // Count up 3 cycles: A -> B -> C -> D
    sw = 18'd0;
    repeat (3) @(posedge clk); #1;
    if (ledr[3:0] !== 4'hD) begin errs = errs + 1; $display("FAIL count q=%h", ledr[3:0]); end
    if (errs === 0) $display("PASS: Lab 1 Loadable Counter (load=A, +3=D, HEX0=%b)", hex0);
    else $display("FAIL: Lab 1 errors=%0d", errs);
    $finish;
  end
endmodule
`,
      },
    ],
  },

  {
    id: 'lab2_fsm_moore',
    filename: 'fsm_moore.v',
    name: 'Lab 2: 1011 Moore FSM Detector (DE2 + TB)',
    recommendedBoard: 'de2',
    recommendedClockSpeed: '1',
    recommendedPeripherals: [],
    title: {
      en: 'Lab 2: 1011 Sequence Detector Moore FSM (+ TB)',
      vi: 'Lab 2: Máy trạng thái Moore nhận chuỗi 1011 (+ TB)',
    },
    description: {
      en: 'CE118 Lab 2 — Overlapping "1011" Moore FSM (SW[0] serial bit, KEY[0] reset, LEDR[2:0] state, LEDG[0] detected, HEX0 state) + tb_fsm.v.',
      vi: 'CE118 Lab 2 — Máy trạng thái Moore nhận chuỗi "1011" chồng lấp (SW[0] bit nối tiếp, KEY[0] reset, LEDR[2:0] trạng thái, LEDG[0] phát hiện) + tb_fsm.v.',
    },
    files: [
      {
        name: 'fsm_moore.v',
        content: `// CE118 Lab 2: Overlapping "1011" Sequence Detector (Moore FSM)
// SW[0]: Serial Input | KEY[0]: Active-Low Reset | LEDG[0]: Detected
module fsm_moore (
  input  wire        CLOCK_50,
  input  wire [17:0] SW,
  input  wire [3:0]  KEY,
  output wire [17:0] LEDR,
  output wire [8:0]  LEDG,
  output wire [6:0]  HEX0
);
  localparam [2:0] S0 = 3'd0, S1 = 3'd1, S2 = 3'd2, S3 = 3'd3, S4 = 3'd4;
  reg [2:0] state, next_state;
  wire x = SW[0];
  initial state = S0;

  always @(posedge CLOCK_50 or negedge KEY[0]) begin
    if (!KEY[0]) state <= S0;
    else         state <= next_state;
  end

  always @* begin
    case (state)
      S0: next_state = x ? S1 : S0;
      S1: next_state = x ? S1 : S2;
      S2: next_state = x ? S3 : S0;
      S3: next_state = x ? S4 : S2;
      S4: next_state = x ? S1 : S2;
      default: next_state = S0;
    endcase
  end

${_LAB_HEX7_FN}

  assign LEDR = {15'd0, state};
  assign LEDG = {8'd0, (state == S4)};
  assign HEX0 = hex7({1'b0, state});
endmodule
`,
      },
      {
        name: 'tb_fsm.v',
        content: `// ModelSim Testbench for Lab 2: Overlapping 1011 Moore FSM
module tb_fsm;
  reg clk;
  reg [17:0] sw;
  reg [3:0] key;
  wire [17:0] ledr;
  wire [8:0] ledg;
  wire [6:0] hex0;
  reg [6:0] seq;
  integer i, hits, errs;

  fsm_moore dut (
    .CLOCK_50(clk), .SW(sw), .KEY(key),
    .LEDR(ledr), .LEDG(ledg), .HEX0(hex0)
  );

  always #5 clk = ~clk;

  initial begin
    clk = 0; sw = 0; key = 4'b1110; hits = 0; errs = 0;
    // Bit stream MSB->LSB: 1,0,1,1,0,1,1 => 2 overlapping hits at idx 3 and 6
    seq = 7'b1011011;
    #12 key = 4'b1111;
    for (i = 6; i >= 0; i = i - 1) begin
      sw[0] = seq[i];
      @(posedge clk); #1;
      if (ledg[0] === 1'b1) hits = hits + 1;
    end
    if (hits !== 2) begin errs = errs + 1; $display("FAIL hits=%0d exp=2", hits); end
    if (errs === 0) $display("PASS: Lab 2 Moore FSM 1011 detected %0d overlapping hits", hits);
    $finish;
  end
endmodule
`,
      },
    ],
  },

  {
    id: 'lab3_alu_4bit',
    filename: 'alu_4bit.v',
    name: 'Lab 3: 4-bit ALU + Flags (DE2 + TB)',
    recommendedBoard: 'de2',
    recommendedClockSpeed: 'manual',
    recommendedPeripherals: [],
    title: {
      en: 'Lab 3: 4-bit ALU (ADD/SUB/AND/OR/XOR/SLT + TB)',
      vi: 'Lab 3: Bộ ALU 4-bit (ADD/SUB/AND/OR/XOR/SLT + TB)',
    },
    description: {
      en: 'CE118 Lab 3 — 4-bit ALU (SW[3:0]=A, SW[7:4]=B, SW[10:8]=Op; LEDR[3:0]=Y, LEDG[2:0]={Cout,Ovf,Zero}, HEX0=Y) + self-checking tb_alu.v.',
      vi: 'CE118 Lab 3 — ALU 4-bit (SW[3:0]=A, SW[7:4]=B, SW[10:8]=Op; LEDR[3:0]=Y, LEDG[2:0]={Cout,Ovf,Zero}, HEX0=Y) + tb_alu.v tự kiểm tra.',
    },
    files: [
      {
        name: 'alu_4bit.v',
        content: `// CE118 Lab 3: 4-bit Combinational ALU with Zero & Signed Overflow Flags
// SW[3:0]=A | SW[7:4]=B | SW[10:8]=Op (0:ADD 1:SUB 2:AND 3:OR 4:XOR 5:SLT)
module alu_4bit (
  input  wire [17:0] SW,
  output wire [17:0] LEDR,
  output wire [8:0]  LEDG,
  output wire [6:0]  HEX0
);
  wire [3:0] a = SW[3:0];
  wire [3:0] b = SW[7:4];
  wire [2:0] op = SW[10:8];
  reg  [3:0] y;
  reg        cout, ovf;
  wire [4:0] sum_ext = {1'b0, a} + {1'b0, b};
  wire [4:0] sub_ext = {1'b0, a} + {1'b0, ~b} + 5'd1;
  wire       slt_res = (a[3] != b[3]) ? a[3] : (a < b);

  always @* begin
    y = 4'd0; cout = 1'b0; ovf = 1'b0;
    case (op)
      3'd0: begin
        y = sum_ext[3:0]; cout = sum_ext[4];
        ovf = (a[3] == b[3]) && (y[3] != a[3]);
      end
      3'd1: begin
        y = sub_ext[3:0]; cout = sub_ext[4];
        ovf = (a[3] != b[3]) && (y[3] != a[3]);
      end
      3'd2: y = a & b;
      3'd3: y = a | b;
      3'd4: y = a ^ b;
      3'd5: y = {3'd0, slt_res};
      default: y = 4'd0;
    endcase
  end

${_LAB_HEX7_FN}

  wire zero = (y == 4'd0);
  assign LEDR = {14'd0, y};
  assign LEDG = {6'd0, cout, ovf, zero};
  assign HEX0 = hex7(y);
endmodule
`,
      },
      {
        name: 'tb_alu.v',
        content: `// ModelSim Self-Checking Testbench for Lab 3: 4-bit ALU
module tb_alu;
  reg [17:0] sw;
  wire [17:0] ledr;
  wire [8:0] ledg;
  wire [6:0] hex0;
  integer errs;

  alu_4bit dut (.SW(sw), .LEDR(ledr), .LEDG(ledg), .HEX0(hex0));

  initial begin
    errs = 0;
    // 1) ADD with signed overflow: 7 + 2 = 9 (ovf=1, zero=0)
    sw = {7'd0, 3'd0, 4'd2, 4'd7}; #10;
    if (ledr[3:0] !== 4'd9 || ledg[1] !== 1'b1) begin errs = errs + 1; $display("FAIL ADD y=%h ovf=%b", ledr[3:0], ledg[1]); end
    // 2) SUB zero flag: 5 - 5 = 0 (zero=1)
    sw = {7'd0, 3'd1, 4'd5, 4'd5}; #10;
    if (ledr[3:0] !== 4'd0 || ledg[0] !== 1'b1) begin errs = errs + 1; $display("FAIL SUB y=%h z=%b", ledr[3:0], ledg[0]); end
    // 3) AND: 0xA & 0xC = 0x8
    sw = {7'd0, 3'd2, 4'hC, 4'hA}; #10;
    if (ledr[3:0] !== 4'h8) begin errs = errs + 1; $display("FAIL AND y=%h", ledr[3:0]); end
    // 4) OR: 0xA | 0x5 = 0xF
    sw = {7'd0, 3'd3, 4'h5, 4'hA}; #10;
    if (ledr[3:0] !== 4'hF) begin errs = errs + 1; $display("FAIL OR y=%h", ledr[3:0]); end
    // 5) XOR: 0xF ^ 0xA = 0x5
    sw = {7'd0, 3'd4, 4'hA, 4'hF}; #10;
    if (ledr[3:0] !== 4'h5) begin errs = errs + 1; $display("FAIL XOR y=%h", ledr[3:0]); end
    // 6) Signed SLT: -2 (4'hE) < +1 (4'h1) => 1
    sw = {7'd0, 3'd5, 4'h1, 4'hE}; #10;
    if (ledr[3:0] !== 4'd1) begin errs = errs + 1; $display("FAIL SLT y=%h", ledr[3:0]); end

    if (errs === 0) $display("PASS: Lab 3 4-bit ALU verified all 6 ops & flags (t=%0t)", $time);
    else $display("FAIL: Lab 3 errors=%0d", errs);
    $finish;
  end
endmodule
`,
      },
    ],
  },

  {
    id: 'lab4_mips_datapath',
    filename: 'mips_datapath.v',
    name: 'Lab 4: MIPS Datapath (RegFile + ALU + TB)',
    recommendedBoard: 'de2',
    recommendedClockSpeed: '1',
    recommendedPeripherals: [{ id: 'memory_viewer' }],
    title: {
      en: 'Lab 4: Simplified MIPS Datapath (RegFile + ALU + MemView)',
      vi: 'Lab 4: Datapath MIPS rút gọn (RegFile + ALU + MemView)',
    },
    description: {
      en: 'CE213 Lab 4 — Multi-module MIPS Datapath (reg_file 8×8 + alu_8bit + WB mux). Auto-attaches Memory Viewer to inspect u_rf.regs + tb_datapath.v.',
      vi: 'CE213 Lab 4 — Datapath MIPS đa module (reg_file 8×8 + alu_8bit + Mux ghi ngược). Tự gắn Memory Viewer xem u_rf.regs + tb_datapath.v.',
    },
    files: [
      {
        name: 'mips_datapath.v',
        content: `// CE213 Lab 4: Simplified MIPS Datapath (RegFile + 8-bit ALU + WB Mux)
// SW[2:0]=ra1 | SW[5:3]=ra2 | SW[8:6]=wa | SW[10:9]=alu_op | SW[11]=wb_sel | SW[12]=we | SW[17:13]=imm
module reg_file (
  input  wire       clk,
  input  wire       rst_n,
  input  wire       we,
  input  wire [2:0] ra1,
  input  wire [2:0] ra2,
  input  wire [2:0] wa,
  input  wire [7:0] wd,
  output wire [7:0] rd1,
  output wire [7:0] rd2
);
  reg [7:0] regs [0:7];
  integer k;

  initial begin
    for (k = 0; k < 8; k = k + 1) regs[k] = 8'd0;
  end

  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      for (k = 0; k < 8; k = k + 1) regs[k] <= 8'd0;
    end else if (we && (wa != 3'd0)) begin
      regs[wa] <= wd;
    end
  end

  assign rd1 = (ra1 == 3'd0) ? 8'd0 : regs[ra1];
  assign rd2 = (ra2 == 3'd0) ? 8'd0 : regs[ra2];
endmodule

module alu_8bit (
  input  wire [7:0] a,
  input  wire [7:0] b,
  input  wire [1:0] op,
  output reg  [7:0] y,
  output wire       zero
);
  always @* begin
    case (op)
      2'd0: y = a + b;
      2'd1: y = a - b;
      2'd2: y = a & b;
      default: y = a | b;
    endcase
  end
  assign zero = (y == 8'd0);
endmodule

module mips_datapath (
  input  wire        CLOCK_50,
  input  wire [17:0] SW,
  input  wire [3:0]  KEY,
  output wire [17:0] LEDR,
  output wire [8:0]  LEDG,
  output wire [6:0]  HEX0,
  output wire [6:0]  HEX1
);
  wire [7:0] rd1, rd2, alu_y;
  wire       zero;
  wire [7:0] wb_data = SW[11] ? {3'd0, SW[17:13]} : alu_y;

  reg_file u_rf (
    .clk(CLOCK_50), .rst_n(KEY[0]), .we(SW[12]),
    .ra1(SW[2:0]), .ra2(SW[5:3]), .wa(SW[8:6]),
    .wd(wb_data), .rd1(rd1), .rd2(rd2)
  );

  alu_8bit u_alu (.a(rd1), .b(rd2), .op(SW[10:9]), .y(alu_y), .zero(zero));

${_LAB_HEX7_FN}

  assign LEDR = {2'b00, alu_y, rd1};
  assign LEDG = {7'd0, SW[12], zero};
  assign HEX0 = hex7(alu_y[3:0]);
  assign HEX1 = hex7(alu_y[7:4]);
endmodule
`,
      },
      {
        name: 'tb_datapath.v',
        content: `// ModelSim Testbench for Lab 4: MIPS Datapath (RegFile + ALU)
module tb_datapath;
  reg clk;
  reg [17:0] sw;
  reg [3:0] key;
  wire [17:0] ledr;
  wire [8:0] ledg;
  wire [6:0] hex0, hex1;
  integer errs;

  mips_datapath dut (
    .CLOCK_50(clk), .SW(sw), .KEY(key),
    .LEDR(ledr), .LEDG(ledg), .HEX0(hex0), .HEX1(hex1)
  );

  always #5 clk = ~clk;

  initial begin
    errs = 0; clk = 0; sw = 0; key = 4'b1110;
    #12 key = 4'b1111;
    // Load R1 = 10 via imm WB mux (we=1, wb_sel=1, wa=1, imm=10)
    sw = {5'd10, 1'b1, 1'b1, 2'd0, 3'd1, 3'd0, 3'd0};
    @(posedge clk); #1;
    // Load R2 = 5
    sw = {5'd5, 1'b1, 1'b1, 2'd0, 3'd2, 3'd0, 3'd0};
    @(posedge clk); #1;
    // R3 = R1 + R2 = 15 (we=1, wb_sel=0, op=ADD, wa=3, ra2=2, ra1=1)
    sw = {5'd0, 1'b1, 1'b0, 2'd0, 3'd3, 3'd2, 3'd1};
    @(posedge clk); #1;
    // R4 = R3 - R2 = 10 (op=SUB, wa=4, ra2=2, ra1=3)
    sw = {5'd0, 1'b1, 1'b0, 2'd1, 3'd4, 3'd2, 3'd3};
    @(posedge clk); #1;
    // Read R3 & R4 (we=0)
    sw = {5'd0, 1'b0, 1'b0, 2'd0, 3'd0, 3'd4, 3'd3}; #2;
    if (dut.u_rf.regs[3] !== 8'd15) begin errs = errs + 1; $display("FAIL R3=%0d", dut.u_rf.regs[3]); end
    if (dut.u_rf.regs[4] !== 8'd10) begin errs = errs + 1; $display("FAIL R4=%0d", dut.u_rf.regs[4]); end
    if (errs === 0) $display("PASS: Lab 4 MIPS Datapath (R1=10, R2=5, R3=%0d, R4=%0d)", dut.u_rf.regs[3], dut.u_rf.regs[4]);
    $finish;
  end
endmodule
`,
      },
    ],
  },

  {
    id: 'lab5_control_unit',
    filename: 'control_unit.v',
    name: 'Lab 5: Multi-Cycle Control Unit FSM (DE2 + TB)',
    recommendedBoard: 'de2',
    recommendedClockSpeed: '1',
    recommendedPeripherals: [],
    title: {
      en: 'Lab 5: Multi-Cycle Control Unit FSM (FETCH→WB + TB)',
      vi: 'Lab 5: Khối điều khiển đa chu kỳ FSM (FETCH→WB + TB)',
    },
    description: {
      en: 'CE213 Lab 5 — Multi-cycle Control Unit FSM (FETCH→DECODE→EXEC→WB) generating datapath control word on LEDR[6:0] from opcode SW[2:0] + tb_control_unit.v.',
      vi: 'CE213 Lab 5 — Khối điều khiển đa chu kỳ FSM (FETCH→DECODE→EXEC→WB) sinh từ điều khiển Datapath trên LEDR[6:0] từ opcode SW[2:0] + tb_control_unit.v.',
    },
    files: [
      {
        name: 'control_unit.v',
        content: `// CE213 Lab 5: Multi-Cycle Control Unit FSM (FETCH -> DECODE -> EXEC -> WB)
// SW[2:0]: Opcode (0:ADD 1:SUB 2:AND 3:OR 4:ADDI 5:HALT) | LEDR[6:0]: Control Word
module control_unit (
  input  wire        CLOCK_50,
  input  wire [17:0] SW,
  input  wire [3:0]  KEY,
  output wire [17:0] LEDR,
  output wire [8:0]  LEDG,
  output wire [6:0]  HEX0,
  output wire [6:0]  HEX1
);
  localparam [1:0] S_FETCH = 2'd0, S_DECODE = 2'd1, S_EXEC = 2'd2, S_WB = 2'd3;
  reg [1:0] state, next_state;
  wire [2:0] opcode = SW[2:0];
  reg pc_we, ir_we, reg_we, alu_src, wb_sel;
  reg [1:0] alu_op;
  initial state = S_FETCH;

  always @(posedge CLOCK_50 or negedge KEY[0]) begin
    if (!KEY[0]) state <= S_FETCH;
    else         state <= next_state;
  end

  always @* begin
    pc_we = 0; ir_we = 0; reg_we = 0; alu_src = 0; wb_sel = 0; alu_op = 2'd0;
    next_state = S_FETCH;
    case (state)
      S_FETCH: begin
        ir_we = 1'b1;
        pc_we = (opcode != 3'd5);
        next_state = (opcode == 3'd5) ? S_FETCH : S_DECODE;
      end
      S_DECODE: begin
        next_state = S_EXEC;
      end
      S_EXEC: begin
        alu_src = (opcode == 3'd4);
        alu_op  = (opcode == 3'd4) ? 2'd0 : opcode[1:0];
        next_state = S_WB;
      end
      S_WB: begin
        reg_we  = (opcode != 3'd5);
        alu_src = (opcode == 3'd4);
        wb_sel  = (opcode == 3'd4);
        alu_op  = (opcode == 3'd4) ? 2'd0 : opcode[1:0];
        next_state = S_FETCH;
      end
      default: next_state = S_FETCH;
    endcase
  end

${_LAB_HEX7_FN}

  wire [6:0] ctrl_word = {pc_we, ir_we, reg_we, alu_src, wb_sel, alu_op};
  assign LEDR = {11'd0, ctrl_word};
  assign LEDG = {7'd0, state};
  assign HEX0 = hex7({2'b00, state});
  assign HEX1 = hex7({1'b0, opcode});
endmodule
`,
      },
      {
        name: 'tb_control_unit.v',
        content: `// ModelSim Testbench for Lab 5: Multi-Cycle Control Unit FSM
module tb_control_unit;
  reg clk;
  reg [17:0] sw;
  reg [3:0] key;
  wire [17:0] ledr;
  wire [8:0] ledg;
  wire [6:0] hex0, hex1;
  integer errs;

  control_unit dut (
    .CLOCK_50(clk), .SW(sw), .KEY(key),
    .LEDR(ledr), .LEDG(ledg), .HEX0(hex0), .HEX1(hex1)
  );

  always #5 clk = ~clk;

  initial begin
    errs = 0; clk = 0; sw = 18'd4; key = 4'b1110; // opcode=4 (ADDI)
    #12 key = 4'b1111;
    // S_FETCH: pc_we=1, ir_we=1 -> ledr[6:5]=2'b11
    if (ledg[1:0] !== 2'd0 || ledr[6:5] !== 2'b11) begin errs = errs + 1; $display("FAIL FETCH st=%d cw=%b", ledg[1:0], ledr[6:0]); end
    @(posedge clk); #1; // S_DECODE
    if (ledg[1:0] !== 2'd1 || ledr[4] !== 1'b0) begin errs = errs + 1; $display("FAIL DECODE st=%d", ledg[1:0]); end
    @(posedge clk); #1; // S_EXEC: alu_src=1 (ledr[3])
    if (ledg[1:0] !== 2'd2 || ledr[3] !== 1'b1) begin errs = errs + 1; $display("FAIL EXEC st=%d cw=%b", ledg[1:0], ledr[6:0]); end
    @(posedge clk); #1; // S_WB: reg_we=1 (ledr[4]), wb_sel=1 (ledr[2])
    if (ledg[1:0] !== 2'd3 || ledr[4] !== 1'b1 || ledr[2] !== 1'b1) begin errs = errs + 1; $display("FAIL WB st=%d cw=%b", ledg[1:0], ledr[6:0]); end
    @(posedge clk); #1; // Wrap back to S_FETCH
    if (ledg[1:0] !== 2'd0) begin errs = errs + 1; $display("FAIL WRAP st=%d", ledg[1:0]); end

    if (errs === 0) $display("PASS: Lab 5 Control Unit verified FETCH->DECODE->EXEC->WB (t=%0t)", $time);
    $finish;
  end
endmodule
`,
      },
    ],
  },

  {
    id: 'lab6_simple_processor',
    filename: 'simple_processor.v',
    name: 'Lab 6: Simple Multi-Cycle Processor (DE2 + TB)',
    recommendedBoard: 'de2',
    recommendedClockSpeed: '5',
    recommendedPeripherals: [{ id: 'memory_viewer' }],
    title: {
      en: 'Lab 6: Complete Multi-Module Simple Processor (+ MemView + TB)',
      vi: 'Lab 6: Bộ vi xử lý đa chu kỳ hoàn chỉnh (+ MemView + TB)',
    },
    description: {
      en: 'CE213 Capstone Lab 6 — Multi-module Simple Processor (imem_rom + proc_ctrl + proc_datapath -> u_rf, u_alu). Runs preloaded sum program (R5=0x0E), drives HEX0..HEX3 & Memory Viewer + tb_processor.v.',
      vi: 'CE213 Lab 6 — Bộ xử lý hoàn chỉnh đa module (imem_rom + proc_ctrl + proc_datapath -> u_rf, u_alu). Chạy sẵn chương trình cộng (R5=0x0E), hiển thị HEX0..HEX3 & Memory Viewer + tb_processor.v.',
    },
    files: [
      {
        name: 'simple_processor.v',
        content: `// CE213 Lab 6: Complete Multi-Module Simple Processor (Altera DE2)
// ISA [15:0]: [15:13]=op (0:LI 1:ADD 2:SUB 3:AND 4:OR 7:HALT) [12:10]=rd [9:7]=rs1 [6:4]=rs2 [3:0]=imm4
// Preloaded Program: R1=3; R2=4; R3=R1+R2(7); R4=R3+R2(11); R5=R4+R1(14=0x0E); HALT
module imem_rom (
  input  wire [2:0]  addr,
  output wire [15:0] instr
);
  reg [15:0] mem [0:7];
  initial begin
    mem[0] = 16'h0403; // LI  R1, 3
    mem[1] = 16'h0804; // LI  R2, 4
    mem[2] = 16'h2CA0; // ADD R3, R1, R2 (= 7)
    mem[3] = 16'h31A0; // ADD R4, R3, R2 (= 11)
    mem[4] = 16'h3610; // ADD R5, R4, R1 (= 14 = 0x0E)
    mem[5] = 16'hE000; // HALT
    mem[6] = 16'hE000;
    mem[7] = 16'hE000;
  end
  assign instr = mem[addr];
endmodule

module proc_ctrl (
  input  wire       clk,
  input  wire       rst_n,
  input  wire [2:0] op,
  output reg  [1:0] state,
  output reg        pc_we,
  output reg        ir_we,
  output reg        reg_we,
  output reg        wb_imm,
  output reg  [1:0] alu_op,
  output wire       halted
);
  localparam [1:0] S_FETCH = 2'd0, S_DEC = 2'd1, S_EX = 2'd2, S_WB = 2'd3;
  reg [1:0] next_state;
  initial state = S_FETCH;

  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) state <= S_FETCH;
    else        state <= next_state;
  end

  always @* begin
    pc_we = 0; ir_we = 0; reg_we = 0; wb_imm = 0; alu_op = 2'd0;
    next_state = S_FETCH;
    case (state)
      S_FETCH: begin
        ir_we = 1'b1;
        next_state = S_DEC;
      end
      S_DEC: begin
        next_state = (op == 3'd7) ? S_DEC : S_EX;
      end
      S_EX: begin
        wb_imm = (op == 3'd0);
        alu_op = (op == 3'd2) ? 2'd1 : (op == 3'd3) ? 2'd2 : (op == 3'd4) ? 2'd3 : 2'd0;
        next_state = S_WB;
      end
      S_WB: begin
        reg_we = (op != 3'd7);
        pc_we  = (op != 3'd7);
        wb_imm = (op == 3'd0);
        alu_op = (op == 3'd2) ? 2'd1 : (op == 3'd3) ? 2'd2 : (op == 3'd4) ? 2'd3 : 2'd0;
        next_state = S_FETCH;
      end
      default: next_state = S_FETCH;
    endcase
  end

  assign halted = (state == S_DEC) && (op == 3'd7);
endmodule

module proc_regfile (
  input  wire       clk,
  input  wire       rst_n,
  input  wire       we,
  input  wire [2:0] ra1,
  input  wire [2:0] ra2,
  input  wire [2:0] ra_dbg,
  input  wire [2:0] wa,
  input  wire [7:0] wd,
  output wire [7:0] rd1,
  output wire [7:0] rd2,
  output wire [7:0] rd_dbg
);
  reg [7:0] regs [0:7];
  integer k;
  initial begin
    for (k = 0; k < 8; k = k + 1) regs[k] = 8'd0;
  end
  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      for (k = 0; k < 8; k = k + 1) regs[k] <= 8'd0;
    end else if (we && (wa != 3'd0)) begin
      regs[wa] <= wd;
    end
  end
  assign rd1    = (ra1 == 3'd0) ? 8'd0 : regs[ra1];
  assign rd2    = (ra2 == 3'd0) ? 8'd0 : regs[ra2];
  assign rd_dbg = regs[ra_dbg];
endmodule

module proc_alu (
  input  wire [7:0] a,
  input  wire [7:0] b,
  input  wire [1:0] op,
  output reg  [7:0] y
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

module proc_datapath (
  input  wire        clk,
  input  wire        rst_n,
  input  wire        reg_we,
  input  wire        wb_imm,
  input  wire [1:0]  alu_op,
  input  wire [15:0] ir,
  input  wire [2:0]  dbg_reg,
  output wire [7:0]  wb_val,
  output wire [7:0]  dbg_val
);
  wire [7:0] rd1, rd2, alu_y;
  assign wb_val = wb_imm ? {4'd0, ir[3:0]} : alu_y;

  proc_regfile u_rf (
    .clk(clk), .rst_n(rst_n), .we(reg_we),
    .ra1(ir[9:7]), .ra2(ir[6:4]), .ra_dbg(dbg_reg),
    .wa(ir[12:10]), .wd(wb_val), .rd1(rd1), .rd2(rd2), .rd_dbg(dbg_val)
  );
  proc_alu u_alu (.a(rd1), .b(rd2), .op(alu_op), .y(alu_y));
endmodule

module simple_processor (
  input  wire        CLOCK_50,
  input  wire [17:0] SW,
  input  wire [3:0]  KEY,
  output wire [17:0] LEDR,
  output wire [8:0]  LEDG,
  output wire [6:0]  HEX0,
  output wire [6:0]  HEX1,
  output wire [6:0]  HEX2,
  output wire [6:0]  HEX3
);
  reg  [2:0]  pc;
  reg  [15:0] ir;
  reg  [7:0]  last_result;
  wire [15:0] imem_out;
  wire [1:0]  state, alu_op;
  wire        pc_we, ir_we, reg_we, wb_imm, halted;
  wire [7:0]  wb_val, dbg_val;

  initial begin
    pc = 3'd0; ir = 16'd0; last_result = 8'd0;
  end

  imem_rom u_imem (.addr(pc), .instr(imem_out));
  proc_ctrl u_ctrl (
    .clk(CLOCK_50), .rst_n(KEY[0]), .op(ir[15:13]),
    .state(state), .pc_we(pc_we), .ir_we(ir_we),
    .reg_we(reg_we), .wb_imm(wb_imm), .alu_op(alu_op), .halted(halted)
  );
  proc_datapath u_dp (
    .clk(CLOCK_50), .rst_n(KEY[0]), .reg_we(reg_we), .wb_imm(wb_imm),
    .alu_op(alu_op), .ir(ir), .dbg_reg(SW[2:0]), .wb_val(wb_val), .dbg_val(dbg_val)
  );

  always @(posedge CLOCK_50 or negedge KEY[0]) begin
    if (!KEY[0]) begin
      pc <= 3'd0; ir <= 16'd0; last_result <= 8'd0;
    end else begin
      if (ir_we)  ir <= imem_out;
      if (pc_we)  pc <= pc + 3'd1;
      if (reg_we) last_result <= wb_val;
    end
  end

${_LAB_HEX7_FN}

  assign LEDR = {2'b00, dbg_val, last_result};
  assign LEDG = {5'd0, halted, state, 1'b1};
  assign HEX0 = hex7(last_result[3:0]);
  assign HEX1 = hex7(last_result[7:4]);
  assign HEX2 = hex7({1'b0, pc});
  assign HEX3 = hex7({2'b00, state});
endmodule
`,
      },
      {
        name: 'tb_processor.v',
        content: `// ModelSim Testbench for Lab 6: Simple Multi-Cycle Processor
module tb_processor;
  reg clk;
  reg [17:0] sw;
  reg [3:0] key;
  wire [17:0] ledr;
  wire [8:0] ledg;
  wire [6:0] hex0, hex1, hex2, hex3;
  integer errs;

  simple_processor dut (
    .CLOCK_50(clk), .SW(sw), .KEY(key),
    .LEDR(ledr), .LEDG(ledg),
    .HEX0(hex0), .HEX1(hex1), .HEX2(hex2), .HEX3(hex3)
  );

  always #5 clk = ~clk;

  initial begin
    errs = 0; clk = 0; sw = 18'd5; key = 4'b1110; // probe R5 on SW[2:0]
    #12 key = 4'b1111;
    // 5 instructions x 4 cycles + 2 cycles to reach HALT = 22 cycles
    repeat (24) @(posedge clk); #1;
    if (ledg[3] !== 1'b1) begin errs = errs + 1; $display("FAIL halted=%b pc=%0d", ledg[3], dut.pc); end
    if (ledr[7:0] !== 8'h0E) begin errs = errs + 1; $display("FAIL result=0x%h exp=0x0e", ledr[7:0]); end
    if (dut.u_dp.u_rf.regs[5] !== 8'h0E) begin errs = errs + 1; $display("FAIL R5=0x%h", dut.u_dp.u_rf.regs[5]); end
    if (errs === 0) $display("PASS: Lab 6 Simple Processor halted at PC=%0d with R5=0x%0h (14)", dut.pc, dut.u_dp.u_rf.regs[5]);
    $finish;
  end
endmodule
`,
      },
    ],
  },
];

export const ALL_PRESETS = [...PRESETS, ...V2_PRESETS];

export function getPresetById(id) {
  return [...PRESETS, ...V2_PRESETS, ...COURSE_LAB_PRESETS].find((preset) => preset.id === id) ?? PRESETS[0];
}
