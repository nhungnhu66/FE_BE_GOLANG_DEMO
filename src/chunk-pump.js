/**
 * GOM mảnh SSE trước khi bắn lên dây, và ÉP NGƯỢC áp lực khi dây tắc.
 *
 * Vì sao gom: upstream trả token nhỏ li ti, có lúc vài chục byte một mảnh. Bắn thẳng mỗi mảnh thành
 * một frame websocket là hàng nghìn frame cho MỘT câu trả lời — nhân với hàng trăm lượt chạy cùng lúc
 * thì chi phí đóng gói mới là nút thắt, không phải mạng. Gom theo nhịp ~25ms cắt gần hết chi phí đó
 * mà mắt người không phân biệt nổi (ngưỡng cảm nhận ~100ms).
 *
 * ⛔ GOM chứ TUYỆT ĐỐI KHÔNG sắp xếp lại, không hợp nhất nội dung, không bỏ byte nào: nối các mảnh
 * theo đúng thứ tự nhận được. Chuỗi byte backend đọc phải GIỐNG HỆT chuỗi byte upstream phát ra.
 *
 * ⛔ Làm việc trên **Buffer**, không đổi sang chuỗi. Giải mã ra chuỗi rồi để socket.io mã hoá lại về
 * UTF-8 là hai lần đụng vào cùng một khối byte mà chẳng để làm gì — và nó còn đẻ ra cái bẫy ký tự
 * nhiều byte bị cắt đôi giữa hai mảnh mạng. Chuyển tiếp byte thô thì cả hai vấn đề biến mất.
 */

import { Buffer } from 'node:buffer';

export class ChunkPump {
    /**
     * @param {object}   p
     * @param {Function} p.onFlush     (buffer, seq) — gọi mỗi lần bắn một frame
     * @param {number}   p.intervalMs  nhịp gom; 0 = bắn ngay, không gom
     * @param {number}   p.maxBytes    đủ ngần này byte thì bắn ngay, không đợi hết nhịp
     * @param {object}  [p.pressure]   {congested(), drain()} — hỏi dây có tắc không và chờ nó thoáng
     */
    constructor({ onFlush, intervalMs = 25, maxBytes = 16_384, pressure }) {
        this.onFlush = onFlush;
        this.intervalMs = intervalMs;
        this.maxBytes = maxBytes;
        this.pressure = pressure;
        this.buffer = [];
        this.size = 0;
        this.seq = 0;
        this.timer = undefined;
        this.closed = false;
    }

    /**
     * Nạp một mảnh byte.
     *
     * Trả `undefined` ở đường thường (nhanh, không cấp phát Promise), hoặc trả một Promise khi dây
     * ĐANG TẮC — bên gọi `await` nó để ngừng đọc upstream.
     *
     * ⛔ Đây là chỗ duy nhất ép được áp lực ngược. Thiếu nó thì một backend đọc chậm (hoặc một khách
     * mạng yếu) làm bộ đệm của socket.io phình theo dung lượng upstream sinh ra — tức RAM của container
     * tăng không có trần, và nó tăng đúng lúc đang tải nặng nhất.
     */
    push(chunk) {
        if (this.closed || !chunk || chunk.length === 0) return undefined;

        if (this.intervalMs <= 0) {
            this.emit(chunk);
        } else {
            this.buffer.push(chunk);
            this.size += chunk.length;
            if (this.size >= this.maxBytes) this.flush();
            else if (!this.timer) {
                this.timer = setTimeout(() => this.flush(), this.intervalMs);
                this.timer.unref?.();
            }
        }

        return this.pressure?.congested() ? this.pressure.drain() : undefined;
    }

    flush() {
        this.clearTimer();
        if (!this.buffer.length) return;
        // `concat` một lần cho cả nhịp: một lần cấp phát thay vì N lần nối chuỗi.
        const data = this.buffer.length === 1 ? this.buffer[0] : Buffer.concat(this.buffer, this.size);
        this.buffer = [];
        this.size = 0;
        this.emit(data);
    }

    /**
     * Đóng ống: xả nốt phần còn trong bộ đệm rồi khoá lại.
     *
     * ⛔ PHẢI gọi trên MỌI đường thoát (xong, lỗi, huỷ) — nó xả nốt mảnh CUỐI, mà mảnh cuối thường
     * mang `usage` (số token để tính tiền) và `[DONE]`.
     *
     * @returns {number} số thứ tự frame CUỐI đã bắn — backend đối chiếu để biết đã nhận đủ chưa.
     */
    end() {
        this.flush();
        this.closed = true;
        return this.seq;
    }

    clearTimer() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }

    emit(data) {
        this.seq += 1;
        this.onFlush(data, this.seq);
    }
}
