/**
 * Sổ theo dõi các lượt ĐANG CHẠY + trần chạy song song.
 *
 * ⛔ Vượt trần thì TỪ CHỐI NGAY bằng `busy`, KHÔNG xếp hàng im lặng. Xếp hàng ở đây là hai cái hại
 * cùng lúc: khách chờ mà không biết mình đang chờ, và backend tưởng gateway này đang phục vụ nên
 * không đổi sang gateway khác đang rảnh. Từ chối nhanh là thông tin — và thông tin đó cứu được request.
 *
 * ⛔ Trần đếm số lượt ĐANG BAY, không phải số lượt mỗi phút: hai đại lượng khác nhau thì phải hai
 * thước đo. Một khách mở 100 luồng song song vẫn hợp lệ với mọi giới hạn tính theo phút.
 */

export class JobRegistry {
    constructor({ maxConcurrency = 4 } = {}) {
        this.maxConcurrency = maxConcurrency;
        this.jobs = new Map();
        this.accepting = true;
        this.totalStarted = 0;
        this.totalOk = 0;
        this.totalFailed = 0;
    }

    get inflight() {
        return this.jobs.size;
    }

    get full() {
        return this.jobs.size >= this.maxConcurrency;
    }

    /** Còn nhận việc mới không (trần + cờ tắt máy). */
    canAccept() {
        return this.accepting && !this.full;
    }

    /**
     * Ghi nhận một lượt mới và trả về `AbortController` của nó.
     *
     * Trả `null` khi trùng `jobId` — backend gửi lại cùng id là dấu hiệu nó tưởng lượt trước đã chết;
     * chạy thêm một lượt nữa dưới cùng id thì hai luồng byte trộn vào nhau, hỏng theo kiểu không ai
     * đọc ra được.
     */
    open(jobId) {
        if (this.jobs.has(jobId)) return null;
        const ac = new AbortController();
        this.jobs.set(jobId, { ac, startedAt: Date.now() });
        this.totalStarted += 1;
        return ac;
    }

    close(jobId, ok) {
        if (!this.jobs.delete(jobId)) return false;
        if (ok) this.totalOk += 1;
        else this.totalFailed += 1;
        return true;
    }

    cancel(jobId, reason = 'canceled') {
        const job = this.jobs.get(jobId);
        if (!job) return false;
        job.ac.abort(new Error(reason));
        return true;
    }

    /** Huỷ TẤT CẢ — dùng khi mất kết nối (kết quả không còn đường về) và khi tắt máy. */
    cancelAll(reason) {
        for (const [, job] of this.jobs) job.ac.abort(new Error(reason));
        return this.jobs.size;
    }

    /** Ngừng nhận việc mới nhưng để việc đang chạy chạy nốt (tắt máy êm). */
    stopAccepting() {
        this.accepting = false;
    }

    snapshot() {
        return {
            inflight: this.jobs.size,
            maxConcurrency: this.maxConcurrency,
            accepting: this.accepting,
            totalStarted: this.totalStarted,
            totalOk: this.totalOk,
            totalFailed: this.totalFailed,
        };
    }
}
