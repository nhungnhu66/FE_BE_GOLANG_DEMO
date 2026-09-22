/**
 * GOM mảnh SSE trước khi bắn lên dây.
 *
 * Vì sao cần: upstream trả token nhỏ li ti, có lúc vài chục byte một mảnh. Bắn thẳng mỗi mảnh thành
 * một frame websocket là hàng nghìn frame cho MỘT câu trả lời — mỗi frame tốn một lần đóng gói, một
 * lần `JSON.stringify`, một lần đi qua vòng lặp sự kiện ở CẢ HAI đầu. Gom theo nhịp ~25ms cắt được
 * gần hết chi phí đó mà người dùng không cảm nhận nổi (mắt người không phân biệt dưới ~100ms).
 *
 * ⛔ GOM chứ TUYỆT ĐỐI KHÔNG sắp xếp lại, không hợp nhất nội dung, không bỏ byte nào: nối các mảnh
 * theo đúng thứ tự nhận được. Chuỗi byte backend đọc phải GIỐNG HỆT chuỗi byte upstream phát ra —
 * chỉ khác chỗ cắt mảnh, mà bộ đọc SSE vốn không quan tâm chỗ cắt.
 *
 * ⛔ Và phải có TRẦN BYTE song song với nhịp thời gian: một mảnh 2MB mà vẫn đợi cho đủ 25ms thì độ
 * trễ do mình tự thêm vào lại lớn hơn thứ đang tiết kiệm.
 */

export class ChunkPump {
    /**
     * @param {object}   p
     * @param {Function} p.onFlush      (data, seq) — gọi mỗi lần bắn một frame
     * @param {number}   p.intervalMs   nhịp gom; 0 = bắn ngay, không gom
     * @param {number}   p.maxBytes     đủ ngần này ký tự thì bắn ngay, không đợi hết nhịp
     */
    constructor({ onFlush, intervalMs = 25, maxBytes = 16_384 }) {
        this.onFlush = onFlush;
        this.intervalMs = intervalMs;
        this.maxBytes = maxBytes;
        this.buffer = [];
        this.size = 0;
        this.seq = 0;
        this.timer = undefined;
        this.closed = false;
    }

    push(text) {
        if (this.closed || !text) return;
        if (this.intervalMs <= 0) {
            this.emit(text);
            return;
        }
        this.buffer.push(text);
        this.size += text.length;
        if (this.size >= this.maxBytes) {
            this.flush();
            return;
        }
        if (!this.timer) {
            this.timer = setTimeout(() => this.flush(), this.intervalMs);
            this.timer.unref?.();
        }
    }

    flush() {
        this.clearTimer();
        if (!this.buffer.length) return;
        const data = this.buffer.join('');
        this.buffer = [];
        this.size = 0;
        this.emit(data);
    }

    /**
     * Đóng ống: xả nốt phần còn trong bộ đệm rồi khoá lại.
     *
     * ⛔ PHẢI gọi trên MỌI đường thoát (xong, lỗi, huỷ) — bỏ sót một đường là mất đúng mảnh CUỐI, mà
     * mảnh cuối thường chứa `usage` (số token để tính tiền) và `[DONE]`.
     *
     * @returns {number} số thứ tự frame CUỐI đã bắn — backend dùng nó để biết mình đã nhận đủ chưa.
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
