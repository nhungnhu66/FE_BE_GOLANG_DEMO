/**
 * Gọi upstream MiMo (wire OpenAI-compatible) bằng `fetch` có sẵn của Node — không thêm SDK nào.
 *
 * ⛔ Container là ỐNG DẪN TRUNG THÀNH: byte SSE của upstream được chuyển tiếp NGUYÊN VĂN, không parse
 * lại, không dựng lại, không sắp xếp lại. Backend đã có bộ đọc SSE của nó (dùng chung với mọi provider
 * OpenAI-compatible khác) — dịch ở đây lần nữa là đẻ ra bộ dịch THỨ HAI cho cùng một định dạng, và bản
 * ít lưu lượng hơn sẽ âm thầm thiếu mọi bản vá của bản kia.
 *
 * Ngoại lệ DUY NHẤT của "không parse": dò xem đã có dòng `data:` nào chưa, để biết upstream CÂM. Đây
 * là thứ cả cơ chế đổi gateway dựa vào, và nó chỉ đọc chứ không sửa byte nào.
 */

import { REQUIRED_USER_AGENT } from './config.js';
import { END_CODES } from './protocol.js';

/** Cắt thân lỗi trước khi đưa lên dây — đủ để chẩn, không đủ để ngập log. */
const ERROR_BODY_CAP = 2_000;

function buildHeaders(apiKey, accept) {
    return {
        // ⛔ Hai header này là ĐIỀU KIỆN SỐNG CÒN, không phải trang trí:
        //  · `authorization: Bearer …` — verify LIVE (code.txt).
        //  · `User-Agent: mimo-claw`   — THIẾU LÀ 400. Cổng api-sgp-oc gác theo đúng chuỗi này.
        authorization: `Bearer ${apiKey}`,
        'user-agent': REQUIRED_USER_AGENT,
        accept,
        'content-type': 'application/json',
    };
}

/** Lỗi `fetch` là lỗi MẠNG (DNS/TLS/đứt kết nối) — tách hẳn khỏi lỗi upstream có mã HTTP. */
function networkError(err) {
    return { ok: false, code: END_CODES.network, error: `network: ${err?.message ?? 'unknown'}` };
}

/**
 * Đọc danh sách model tài khoản này được cấp.
 *
 * ⛔ KHÔNG chép danh sách model từ chỗ khác sang: mỗi tài khoản được cấp một tập khác nhau, và tên
 * upstream thật chỉ upstream mới biết. Đọc không được → trả mảng rỗng kèm lý do, để backend hiện đúng
 * "CHƯA ĐỌC ĐƯỢC" thay vì "tài khoản không có model nào" (hai thứ khác hẳn nhau).
 */
export async function listModels({ baseUrl, apiKey, signal, timeoutMs = 15_000 }) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    timer.unref?.();
    const merged = signal ? AbortSignal.any([signal, ac.signal]) : ac.signal;
    try {
        const res = await fetch(`${baseUrl}/models`, { headers: buildHeaders(apiKey, 'application/json'), signal: merged });
        if (!res.ok) {
            const body = (await res.text().catch(() => '')).slice(0, ERROR_BODY_CAP);
            return { ok: false, models: [], status: res.status, error: body || `HTTP ${res.status}` };
        }
        const json = await res.json();
        // Chỉ nhận id là CHUỖI. `String(x)` trên `unknown` cho ra '[object Object]' — một dòng rác kiểu
        // đó lọt vào danh mục là model ma, gọi mãi không ra.
        const models = Array.isArray(json?.data)
            ? json.data.map((m) => m?.id).filter((id) => typeof id === 'string' && id.length > 0)
            : [];
        return { ok: true, models, status: res.status };
    } catch (err) {
        return { ok: false, models: [], error: err?.message ?? 'unknown' };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Chạy MỘT lượt suy luận và đẩy từng mảnh byte SSE qua `onChunk`.
 *
 * Never-throw — luôn trả kết cục có `code` thuộc `END_CODES` để backend rẽ nhánh bằng MÃ chứ không
 * bằng câu chữ.
 *
 * @param {object}      p
 * @param {AbortSignal} p.signal        khách huỷ / backend huỷ / container tắt máy
 * @param {number}      p.firstTokenMs  không có dòng `data:` nào trong ngần này ⇒ CÂM
 * @param {number}      p.deadlineMs    trần tổng cả lượt
 * @param {Function}    p.onOpen        gọi khi có response header (đã nối được, chưa chắc có chữ)
 * @param {Function}    p.onChunk       gọi với chuỗi byte SSE NGUYÊN VĂN
 */
export async function streamChat({ baseUrl, apiKey, body, signal, firstTokenMs, deadlineMs, onOpen, onChunk }) {
    const startedAt = Date.now();

    // Ba đồng hồ TÁCH BIỆT vì ba kết cục khác nhau: khách huỷ (`canceled`) · câm (`mute`, đáng đổi
    // gateway) · quá hạn tổng (`deadline`). Gộp chung một signal thì đọc ra `aborted` mà không biết
    // VÌ SAO — và mất luôn quyền quyết định có đổi gateway hay không.
    const muteAc = new AbortController();
    const deadlineAc = new AbortController();
    let muted = false;
    let expired = false;

    let muteTimer = setTimeout(() => {
        muted = true;
        muteAc.abort();
    }, firstTokenMs);
    muteTimer.unref?.();
    const disarmMute = () => {
        if (muteTimer) {
            clearTimeout(muteTimer);
            muteTimer = undefined;
        }
    };

    const deadlineTimer = setTimeout(() => {
        expired = true;
        deadlineAc.abort();
    }, deadlineMs);
    deadlineTimer.unref?.();

    const signals = [muteAc.signal, deadlineAc.signal];
    if (signal) signals.push(signal);
    const merged = AbortSignal.any(signals);

    let res;
    try {
        res = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: buildHeaders(apiKey, 'text/event-stream'),
            body: JSON.stringify(body),
            signal: merged,
        });
    } catch (err) {
        disarmMute();
        clearTimeout(deadlineTimer);
        if (signal?.aborted) return { ok: false, code: END_CODES.canceled, error: 'canceled' };
        if (expired) return { ok: false, code: END_CODES.deadline, error: 'deadline before response' };
        if (muted) return { ok: false, code: END_CODES.mute, error: `no response headers in ${firstTokenMs}ms` };
        return networkError(err);
    }

    onOpen?.({ status: res.status, latencyMs: Date.now() - startedAt });

    if (!res.ok || !res.body) {
        disarmMute();
        clearTimeout(deadlineTimer);
        const raw = (await res.text().catch(() => '')).slice(0, ERROR_BODY_CAP);
        return {
            ok: false,
            code: END_CODES.upstreamStatus,
            status: res.status,
            // NGUYÊN VĂN upstream — backend cần nó để phân loại và để log `raw=`; nó KHÔNG ra thẳng khách.
            error: raw || `HTTP ${res.status} (thân rỗng)`,
        };
    }

    const decoder = new TextDecoder('utf-8');
    let bytes = 0;
    let sawData = false;

    try {
        for await (const piece of res.body) {
            const text = decoder.decode(piece, { stream: true });
            if (!text) continue;
            bytes += text.length;
            // Đã có dòng dữ liệu thật ⇒ tháo đồng hồ câm. Dòng bình luận (`: keep-alive`) KHÔNG tính:
            // upstream vỗ về kết nối không có nghĩa là nó đang sinh chữ.
            if (!sawData && DATA_LINE_RE.test(text)) {
                sawData = true;
                disarmMute();
            }
            onChunk(text);
        }
        const tail = decoder.decode();
        if (tail) {
            bytes += tail.length;
            onChunk(tail);
        }
    } catch (err) {
        if (signal?.aborted) return { ok: false, code: END_CODES.canceled, error: 'canceled', bytes };
        if (expired) return { ok: false, code: END_CODES.deadline, error: `deadline ${deadlineMs}ms`, bytes };
        if (muted) return { ok: false, code: END_CODES.mute, error: `no data in ${firstTokenMs}ms`, bytes };
        return { ...networkError(err), bytes };
    } finally {
        disarmMute();
        clearTimeout(deadlineTimer);
    }

    // Luồng đóng SẠCH nhưng không một dòng `data:` nào ⇒ vẫn là câm, không phải "trả lời xong, rỗng".
    // Báo `ok` cho ca này là biến một lỗi nhìn thấy được thành một lỗi vô hình (§12.6.6).
    if (!sawData) return { ok: false, code: END_CODES.mute, error: 'upstream closed with no data frame', bytes };

    return { ok: true, code: END_CODES.ok, status: res.status, bytes, durationMs: Date.now() - startedAt };
}

/**
 * Dòng dữ liệu SSE — đầu luồng hoặc ngay sau một dấu xuống dòng.
 *
 * ⚠️ Khai ở ngoài để KHÔNG dùng cờ `g`: regex có `g` mang theo `lastIndex` giữa các lần gọi `.test()`,
 * nên cùng một chuỗi lúc đúng lúc sai — đúng loại lỗi chỉ hiện ra khi chạy thật.
 */
const DATA_LINE_RE = /(^|\n)data:/;
