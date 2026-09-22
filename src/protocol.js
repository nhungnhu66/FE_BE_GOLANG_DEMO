/**
 * HỢP ĐỒNG DÂY giữa container và XTRouter_Backend.
 *
 * ⛔ File này là NGUỒN SỰ THẬT và được SAO NGUYÊN VĂN sang backend
 * (`src/services/mimo-claw/mimo-claw.protocol.ts`). Hai bản lệch nhau = hỏng IM LẶNG: sự kiện gửi đi
 * không ai nghe, job treo tới lúc hết giờ. Đổi bất cứ thứ gì ở đây thì PHẢI đổi cả hai bên cùng lúc
 * và nâng `PROTOCOL_VERSION`.
 *
 * Nghi thức một lượt:
 *   backend → `chat.start` {jobId, body, …}
 *   container → `chat.open` {jobId, status}          (đã nối được upstream, chưa chắc có chữ)
 *   container → `chat.chunk` {jobId, seq, data} ×N   (NGUYÊN VĂN byte SSE của upstream)
 *   container → `chat.end`  {jobId, seq, ok, …}      (LUÔN có, kể cả khi hỏng)
 *   backend → `chat.cancel` {jobId}                  (khách huỷ / backend bỏ cuộc)
 */

/** Bản nghi thức. Backend từ chối container khai bản LỚN HƠN bản nó biết. */
export const PROTOCOL_VERSION = 1;

/** Namespace socket.io trên backend. */
export const GATEWAY_NAMESPACE = '/gw/mimo';

/** Sự kiện BACKEND → CONTAINER. */
export const SERVER_EVENTS = {
    /** Giao một lượt suy luận. Payload: {jobId, body, deadlineMs, firstTokenMs}. */
    chatStart: 'chat.start',
    /** Yêu cầu huỷ một lượt đang chạy. Payload: {jobId, reason}. */
    chatCancel: 'chat.cancel',
    /** Yêu cầu đọc lại danh sách model (ack trả về danh sách). */
    modelsRefresh: 'models.refresh',
};

/** Sự kiện CONTAINER → BACKEND. */
export const CLIENT_EVENTS = {
    /** Khai năng lực ngay sau khi nối. Payload: {models, endpointHost, agent}. */
    hello: 'hello',
    /** Nhịp tim tầng ỨNG DỤNG (khác ping/pong của engine.io). Payload: {inflight, uptimeSec, …}. */
    stats: 'stats',
    /** Đã mở được luồng upstream. Payload: {jobId, status, latencyMs}. */
    chatOpen: 'chat.open',
    /** Một mảnh byte SSE nguyên văn. Payload: {jobId, seq, data}. */
    chatChunk: 'chat.chunk',
    /** Kết thúc một lượt — LUÔN được gửi. Payload: {jobId, seq, ok, error?, status?, code?}. */
    chatEnd: 'chat.end',
    /** Danh sách model vừa đọc lại được. Payload: {models, at}. */
    models: 'models',
};

/**
 * Mã lỗi CÓ CẤU TRÚC của `chat.end` — backend rẽ nhánh theo mã, KHÔNG parse câu chữ.
 *
 * ⛔ Phân biệt hai câu hỏi khác nhau (§12.9): *"gateway này có làm sai không"* (quyết định phạt pool)
 * và *"thử lại có cơ hội khác không"* (quyết định mã HTTP trả khách). `upstream_status` mang theo mã
 * thật của hãng nên backend tự trả lời được cả hai; các mã còn lại là chuyện của container.
 */
export const END_CODES = {
    /** Chạy xong sạch. */
    ok: 'ok',
    /** Container đang đủ tải — backend nên đổi gateway khác NGAY, KHÔNG phạt container này. */
    busy: 'busy',
    /** Upstream trả mã lỗi HTTP (kèm `status` + nguyên văn thân lỗi đã cắt). */
    upstreamStatus: 'upstream_status',
    /** Nối được nhưng upstream không trả chữ nào trong hạn — đúng ca đáng đổi gateway. */
    mute: 'mute',
    /** Lỗi mạng/DNS/TLS phía container (thường là proxy riêng của container chết). */
    network: 'network',
    /** Backend bảo huỷ, hoặc container đang tắt máy. */
    canceled: 'canceled',
    /** Quá hạn tổng của một lượt. */
    deadline: 'deadline',
    /** Container tự hỏng (bug) — tách khỏi `upstream_status` để không đổ oan cho hãng. */
    internal: 'internal',
};

/** Lý do container tự đóng kết nối — gửi kèm `disconnect` để log của backend đọc ra được. */
export const BYE_REASON = {
    shutdown: 'shutdown',
};
