/**
 * Đường dây về XTRouter_Backend: giữ kết nối socket.io, nhận job, trả byte SSE ngược lên.
 *
 * Vì sao socket.io chứ không phải `ws` trần: backend đã cài sẵn `socket.io` và đang chạy một cổng
 * thật (`/notifications`), nên đây là hạ tầng CÓ SẴN, không phải thứ thêm vào. Đổi lại mình được
 * miễn phí ba thứ mà tự viết `ws` sẽ phải làm lại và sẽ làm thiếu: nối lại tự động có lùi dần + xóc
 * ngẫu nhiên, nhịp tim hai chiều phát hiện kết nối chết, và cơ chế ack cho từng sự kiện.
 *
 * ⛔ MẤT KẾT NỐI = HUỶ MỌI LƯỢT ĐANG CHẠY. Kết quả không còn đường về thì chạy tiếp chỉ để đốt hạn
 * mức thật của tài khoản cho một câu trả lời không ai nhận (§16.2).
 */

import { io } from 'socket.io-client';

import { ChunkPump } from './chunk-pump.js';
import { JobRegistry } from './jobs.js';
import { CLIENT_EVENTS, END_CODES, GATEWAY_NAMESPACE, PROTOCOL_VERSION, SERVER_EVENTS } from './protocol.js';
import { buildAuth } from './signature.js';
import { listModels, streamChat } from './upstream.js';

export class GatewayLink {
    constructor({ config, logger }) {
        this.config = config;
        this.logger = logger;
        this.jobs = new JobRegistry({ maxConcurrency: config.maxConcurrency });
        this.socket = null;
        this.statsTimer = undefined;
        this.modelsTimer = undefined;
        this.startedAt = Date.now();
        /** Danh sách model đọc được từ upstream. `null` = CHƯA ĐỌC ĐƯỢC (khác hẳn mảng rỗng). */
        this.models = null;
        this.modelsError = null;
    }

    start() {
        const { config } = this;
        const url = `${config.gatewayUrl.replace(/\/+$/, '')}${GATEWAY_NAMESPACE}`;

        this.socket = io(url, {
            path: config.gatewayPath,
            transports: ['websocket'],
            // ⛔ Ký LẠI mỗi lần nối: `auth` dạng hàm được gọi ở MỌI lần thử nối, kể cả nối lại. Ký một
            // lần rồi dùng mãi thì sau vài giờ chữ ký quá hạn cửa sổ lệch giờ và container không bao
            // giờ nối lại được nữa — hỏng đúng lúc không ai ngồi nhìn.
            auth: (cb) =>
                cb({
                    ...buildAuth({
                        version: PROTOCOL_VERSION,
                        email: config.accountEmail,
                        secret: config.gatewaySecret,
                    }),
                    label: config.label || undefined,
                }),
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1_000,
            // Trần lùi dần 30s: đủ thưa để không đập vào backend đang sập, đủ mau để container tự sống
            // lại trong vòng nửa phút sau khi backend hồi — không cần ai vào restart container.
            reconnectionDelayMax: 30_000,
            randomizationFactor: 0.5,
            timeout: 20_000,
        });

        this.bind();
        void this.refreshModels();
        return this;
    }

    bind() {
        const s = this.socket;

        s.on('connect', () => {
            this.logger.info('Đã nối backend', { id: s.id, email: this.config.accountEmail });
            this.sendHello();
            this.startStats();
        });

        s.on('disconnect', (reason) => {
            const killed = this.jobs.cancelAll(`disconnected: ${reason}`);
            this.stopStats();
            this.logger.warn('Mất kết nối backend', { reason, huyLuot: killed });
        });

        // ⛔ Lỗi bắt tay (sai chữ ký / sai bản nghi thức) KHÔNG tự chữa bằng cách thử lại. In ĐÚNG lý
        // do backend trả về để người vận hành sửa env, thay vì để container quay vòng im lặng mãi mãi.
        s.on('connect_error', (err) => {
            this.logger.error('Nối backend hỏng', { loi: err?.message, chiTiet: err?.data?.reason });
        });

        s.io.on('reconnect_attempt', (n) => this.logger.debug('Thử nối lại', { lan: n }));

        s.on(SERVER_EVENTS.chatStart, (payload, ack) => this.onChatStart(payload, ack));
        s.on(SERVER_EVENTS.chatCancel, ({ jobId, reason } = {}) => {
            const hit = this.jobs.cancel(jobId, reason ?? 'backend canceled');
            this.logger.debug('Backend huỷ lượt', { jobId, batDuoc: hit });
        });
        s.on(SERVER_EVENTS.modelsRefresh, async (_payload, ack) => {
            await this.refreshModels();
            ack?.({ models: this.models ?? [], error: this.modelsError });
        });
    }

    sendHello() {
        this.socket.emit(CLIENT_EVENTS.hello, {
            v: PROTOCOL_VERSION,
            email: this.config.accountEmail,
            label: this.config.label || null,
            // Chỉ MÁY CHỦ của upstream, KHÔNG bao giờ kèm khoá — dây này để chẩn đoán, không phải để
            // vận chuyển bí mật.
            endpoint: safeHost(this.config.apiBaseUrl),
            models: this.models ?? [],
            modelsError: this.modelsError,
            maxConcurrency: this.config.maxConcurrency,
            agent: { version: '1.0.0', node: process.version, platform: process.platform },
        });
    }

    startStats() {
        this.stopStats();
        this.statsTimer = setInterval(() => {
            if (!this.socket?.connected) return;
            this.socket.emit(CLIENT_EVENTS.stats, {
                ...this.jobs.snapshot(),
                uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
                rssMb: Math.round(process.memoryUsage().rss / 1_048_576),
                models: this.models?.length ?? null,
            });
        }, this.config.statsIntervalMs);
        this.statsTimer.unref?.();

        if (!this.modelsTimer) {
            this.modelsTimer = setInterval(() => void this.refreshModels(), this.config.modelsRefreshMs);
            this.modelsTimer.unref?.();
        }
    }

    stopStats() {
        if (this.statsTimer) {
            clearInterval(this.statsTimer);
            this.statsTimer = undefined;
        }
    }

    async refreshModels() {
        const res = await listModels({ baseUrl: this.config.apiBaseUrl, apiKey: this.config.apiKey });
        if (res.ok) {
            this.models = res.models;
            this.modelsError = null;
            this.logger.info('Đọc được danh sách model', { soLuong: res.models.length, models: res.models.join(',') });
        } else {
            // GIỮ danh sách cũ: một lần chập mạng không phải bằng chứng tài khoản mất model.
            this.modelsError = res.error ?? 'không đọc được';
            this.logger.warn('Không đọc được danh sách model', { loi: this.modelsError, status: res.status });
        }
        if (this.socket?.connected) {
            this.socket.emit(CLIENT_EVENTS.models, {
                models: this.models ?? [],
                error: this.modelsError,
                at: new Date().toISOString(),
            });
        }
    }

    /**
     * Nhận một lượt từ backend.
     *
     * `ack` trả lời NGAY (nhận hay từ chối) rồi mới chạy — nhờ vậy backend biết trong vài mili giây là
     * nên chờ hay nên đổi gateway khác, thay vì phải chờ hết hạn mới đoán ra.
     */
    onChatStart(payload, ack) {
        const { jobId, body, deadlineMs, firstTokenMs } = payload ?? {};

        if (!jobId || !body || typeof body !== 'object') {
            ack?.({ accepted: false, code: END_CODES.internal, error: 'thiếu jobId hoặc body' });
            return;
        }
        if (!this.jobs.canAccept()) {
            // KHÔNG phải lỗi của container — backend đổi gateway khác và KHÔNG phạt gateway này.
            ack?.({ accepted: false, code: END_CODES.busy, inflight: this.jobs.inflight });
            return;
        }

        const ac = this.jobs.open(jobId);
        if (!ac) {
            ack?.({ accepted: false, code: END_CODES.internal, error: 'jobId trùng' });
            return;
        }
        ack?.({ accepted: true });
        void this.runJob({ jobId, body, deadlineMs, firstTokenMs, ac });
    }

    async runJob({ jobId, body, deadlineMs, firstTokenMs, ac }) {
        const s = this.socket;
        const startedAt = Date.now();

        const pump = new ChunkPump({
            intervalMs: this.config.flushIntervalMs,
            maxBytes: this.config.flushBytes,
            onFlush: (data, seq) => {
                // Rớt kết nối giữa chừng: đừng nhét frame vào bộ đệm của socket.io (nó sẽ gửi lại sau
                // khi nối lại — lúc đó backend đã bỏ cuộc và frame chỉ còn là rác chiếm bộ nhớ). Huỷ
                // luôn lượt để không đốt tiếp hạn mức của tài khoản.
                if (!s?.connected) {
                    ac.abort(new Error('socket disconnected'));
                    return;
                }
                s.emit(CLIENT_EVENTS.chatChunk, { jobId, seq, data });
            },
        });

        // Trần thời gian: lấy giá trị NHỎ HƠN giữa cấu hình container và hạn backend gửi xuống. Container
        // không được sống lâu hơn đồng hồ của backend, mà cũng không được vượt trần của chính nó.
        const deadline = Math.min(this.config.requestTimeoutMs, positive(deadlineMs) ?? this.config.requestTimeoutMs);
        const firstToken = Math.min(deadline, positive(firstTokenMs) ?? this.config.firstTokenMs);

        let result;
        try {
            result = await streamChat({
                baseUrl: this.config.apiBaseUrl,
                apiKey: this.config.apiKey,
                body,
                signal: ac.signal,
                firstTokenMs: firstToken,
                deadlineMs: deadline,
                onOpen: ({ status, latencyMs }) => {
                    if (s?.connected) s.emit(CLIENT_EVENTS.chatOpen, { jobId, status, latencyMs });
                },
                onChunk: (text) => pump.push(text),
            });
        } catch (err) {
            // `streamChat` đã never-throw; nhánh này chỉ còn bắt bug của CHÍNH container. Tách mã
            // `internal` để không đổ oan cho hãng khi lỗi là của mình.
            result = { ok: false, code: END_CODES.internal, error: err?.message ?? 'unknown' };
        }

        // ⛔ `end()` PHẢI chạy trước khi gửi `chat.end`, trên mọi đường thoát: nó xả nốt mảnh cuối, mà
        // mảnh cuối thường mang `usage` (số token để tính tiền) và `[DONE]`.
        const lastSeq = pump.end();
        this.jobs.close(jobId, result.ok);

        if (s?.connected) {
            s.emit(CLIENT_EVENTS.chatEnd, {
                jobId,
                seq: lastSeq,
                ok: result.ok,
                code: result.code,
                status: result.status,
                error: result.error,
                bytes: result.bytes ?? 0,
                durationMs: Date.now() - startedAt,
            });
        }

        const line = { jobId, code: result.code, bytes: result.bytes ?? 0, ms: Date.now() - startedAt };
        if (result.ok) this.logger.info('Lượt xong', line);
        else this.logger.warn('Lượt hỏng', { ...line, status: result.status, loi: cut(result.error) });
    }

    /**
     * Tắt êm: ngừng nhận việc mới → chờ việc đang chạy tới `graceMs` → huỷ phần còn lại → đóng dây.
     *
     * Ngừng nhận TRƯỚC khi chờ là mấu chốt: nếu vẫn nhận thì hàng đợi cứ đầy lại và "chờ cho xong"
     * không bao giờ kết thúc.
     */
    async shutdown(graceMs) {
        this.jobs.stopAccepting();
        this.stopStats();
        if (this.modelsTimer) clearInterval(this.modelsTimer);

        const until = Date.now() + graceMs;
        while (this.jobs.inflight > 0 && Date.now() < until) {
            await new Promise((r) => {
                const t = setTimeout(r, 200);
                t.unref?.();
            });
        }
        const left = this.jobs.cancelAll('container shutdown');
        if (left) this.logger.warn('Tắt máy khi còn lượt đang chạy', { conLai: left });
        this.socket?.disconnect();
    }
}

/** Chỉ giữ `scheme://host` — cắt sạch đường dẫn/truy vấn (chỗ bí mật hay vô tình nằm lại). */
function safeHost(url) {
    try {
        const u = new URL(url);
        return `${u.protocol}//${u.host}`;
    } catch {
        return 'unknown';
    }
}

function positive(n) {
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

function cut(text, max = 300) {
    return typeof text === 'string' && text.length > max ? `${text.slice(0, max)}…` : text;
}
