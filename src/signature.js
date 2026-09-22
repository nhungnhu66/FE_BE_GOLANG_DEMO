/**
 * Bắt tay CÓ KÝ giữa container và backend.
 *
 * ⛔ KHÔNG gửi bí mật dùng chung lên dây. Gửi CHỮ KÝ của nó: `HMAC-SHA256(secret, canonical)` với
 * `canonical = v|email|ts|nonce`. Bí mật nằm lại hai đầu; ai xem được dây cũng không tái dùng được gì
 * ngoài đúng một lượt bắt tay đã hết hạn.
 *
 * Ba lớp, mỗi lớp chặn một kiểu tấn công khác nhau — thiếu lớp nào là hở đúng kiểu đó:
 *  1. `secret` → chặn kẻ không có khoá.
 *  2. `ts` + cửa sổ lệch giờ → chặn PHÁT LẠI một chữ ký bắt được từ lâu.
 *  3. `nonce` (backend nhớ trong cửa sổ đó) → chặn phát lại NGAY trong cửa sổ còn hiệu lực.
 *
 * `email` nằm TRONG chuỗi ký nên không đổi được danh tính mà vẫn giữ chữ ký hợp lệ — nếu không, bất
 * kỳ container nào cũng mạo danh được gateway của tài khoản khác.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

/** Cửa sổ lệch giờ cho phép (ms). Rộng đủ cho đồng hồ container trôi, hẹp đủ để chữ ký cũ vô dụng. */
export const CLOCK_SKEW_MS = 5 * 60_000;

/** Chuỗi được ký — thứ tự trường là một phần của hợp đồng, hai bên phải dựng GIỐNG HỆT. */
export function canonicalString({ version, email, ts, nonce }) {
    return `${version}|${email}|${ts}|${nonce}`;
}

export function sign({ version, email, ts, nonce, secret }) {
    return createHmac('sha256', secret).update(canonicalString({ version, email, ts, nonce })).digest('hex');
}

/** Dựng gói bắt tay MỚI (ts/nonce mới mỗi lần nối lại — chữ ký cũ không dùng lại được). */
export function buildAuth({ version, email, secret, now = Date.now() }) {
    const ts = now;
    const nonce = randomUUID();
    return { v: version, email, ts, nonce, sig: sign({ version, email, ts, nonce, secret }) };
}

/**
 * Kiểm chữ ký — dùng ở phía BACKEND (để đây cho hai bên soi chung một bản).
 *
 * ⛔ So bằng `timingSafeEqual`, KHÔNG bằng `===`: so chuỗi thường thoát ra ở byte lệch đầu tiên, nên
 * thời gian trả lời rò rỉ số ký tự đã đoán đúng. Độ dài lệch thì trả false trước (hàm kia sẽ ném).
 */
export function verify({ version, email, ts, nonce, sig, secret, now = Date.now(), skewMs = CLOCK_SKEW_MS }) {
    // ⛔ KHÔNG dùng `!ts` để hỏi "có trường này không": `ts = 0` là một mốc thời gian HỢP LỆ mà lại
    // falsy, nên nó sẽ bị dán nhãn "thiếu trường" thay vì "quá cũ". Lỗi kiểu này không làm hỏng việc
    // chặn (cả hai đều từ chối), nó làm hỏng việc CHẨN — người đọc log đi tìm sai chỗ.
    if (!email || ts === undefined || ts === null || !nonce || !sig) return { ok: false, reason: 'missing_fields' };
    if (typeof ts !== 'number' || !Number.isFinite(ts)) return { ok: false, reason: 'bad_ts' };
    if (Math.abs(now - ts) > skewMs) return { ok: false, reason: 'stale_ts' };

    const expected = sign({ version, email, ts, nonce, secret });
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(String(sig), 'utf8');
    if (a.length !== b.length) return { ok: false, reason: 'bad_sig' };
    return timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: 'bad_sig' };
}
