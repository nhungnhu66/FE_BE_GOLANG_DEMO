/**
 * Đọc cấu hình từ BIẾN MÔI TRƯỜNG của container — zero-dep, fail-fast.
 *
 * ⛔ Container do người khác dựng nên TÊN biến môi trường là thứ mình KHÔNG được đoán. Vì vậy mỗi giá
 * trị có một DANH SÁCH tên ứng viên, và `describe()` nói rõ giá trị nào lấy từ biến nào. Khởi động mà
 * thiếu thì chết NGAY kèm danh sách tên đã thử, thay vì chạy tiếp rồi hỏng ở request đầu tiên của khách.
 */

import { availableParallelism, cpus } from 'node:os';

/** Số lõi dùng được của container. `availableParallelism` tôn trọng cgroup, `cpus()` thì không. */
function cpuCount() {
    try {
        return Math.max(1, availableParallelism());
    } catch {
        return Math.max(1, cpus().length || 1);
    }
}

/** Đích mặc định — verify LIVE (xem `code.txt`), đổi được bằng env. */
export const DEFAULT_API_BASE_URL = 'https://api-sgp-oc.xiaomimimo.com/v1';

/**
 * ⛔ Thiếu header này → upstream trả 400. Nó là "chìa khoá" của cổng api-sgp-oc, không phải trang trí.
 * Để CỐ ĐỊNH trong mã (không đọc env) vì đổi nó = hỏng 100%, không có ca dùng hợp lệ nào khác.
 */
export const REQUIRED_USER_AGENT = 'mimo-claw';

/** Đọc biến đầu tiên có giá trị trong danh sách; trả cả TÊN biến đã trúng để báo cáo. */
function pick(env, names, fallback) {
    for (const name of names) {
        const raw = env[name];
        if (typeof raw === 'string' && raw.trim()) return { value: raw.trim(), source: name };
    }
    return fallback === undefined ? { value: null, source: null } : { value: fallback, source: 'default' };
}

function pickInt(env, names, fallback) {
    const got = pick(env, names);
    if (got.value === null) return { value: fallback, source: 'default' };
    const n = Number.parseInt(got.value, 10);
    return Number.isFinite(n) && n > 0 ? { value: n, source: got.source } : { value: fallback, source: 'default' };
}

/** Bỏ dấu `/` thừa cuối URL để nối đường dẫn không đẻ ra `//`. */
function trimSlash(url) {
    return url.replace(/\/+$/, '');
}

/**
 * Chuẩn hoá base URL về dạng CÓ `/v1` ở cuối.
 *
 * Người dựng container có thể set gốc (`https://host`) hoặc set sẵn `https://host/v1`. Nối cứng `/v1`
 * vào cả hai là ra `…/v1/v1` — hỏng 404 mà nhìn như "endpoint sai". Chuẩn hoá ở ĐÚNG MỘT chỗ.
 */
export function normalizeBaseUrl(raw) {
    const base = trimSlash(raw);
    return /\/v\d+$/.test(base) ? base : `${base}/v1`;
}

/** Che khoá khi in ra log: giữ 4 ký tự đầu + 4 cuối, đủ để đối chiếu mà không lộ. */
export function maskSecret(value) {
    if (!value) return '(trống)';
    if (value.length <= 12) return `${value.slice(0, 2)}…(${value.length} ký tự)`;
    return `${value.slice(0, 4)}…${value.slice(-4)} (${value.length} ký tự)`;
}

/**
 * Dựng cấu hình từ `env`. KHÔNG ném — trả `{ config, missing }` để bên gọi quyết định in báo cáo rồi
 * mới thoát (biết thiếu gì còn hơn chỉ thấy một câu ném).
 */
export function loadConfig(env = process.env) {
    const sources = {};
    const take = (key, got) => {
        sources[key] = got.source;
        return got.value;
    };

    const config = {
        // ── Nối về XTRouter_Backend ────────────────────────────────────────
        gatewayUrl: take('gatewayUrl', pick(env, ['XTR_GATEWAY_URL', 'XTROUTER_GATEWAY_URL'])),
        gatewaySecret: take('gatewaySecret', pick(env, ['XTR_GATEWAY_SECRET', 'XTROUTER_GATEWAY_SECRET'])),
        /**
         * Đường dẫn engine.io (mặc định `/socket.io`). Tách khỏi `gatewayUrl` vì nginx trước backend
         * có thể đặt nó ở chỗ khác — và sai đường dẫn thì triệu chứng là 404 nhìn hệt "backend chết".
         */
        gatewayPath: take('gatewayPath', pick(env, ['XTR_GATEWAY_PATH'], '/socket.io')),
        /**
         * DANH TÍNH của gateway này = email tài khoản MiMo (chốt owner). Nhờ nó mà bảng quản trị nói
         * được "gateway của tài khoản NÀO đang chạy / đang hỏng" thay vì một id vô nghĩa.
         */
        accountEmail: take('accountEmail', pick(env, ['XTR_ACCOUNT_EMAIL', 'MIMO_ACCOUNT_EMAIL', 'XIAOMI_ACCOUNT_EMAIL'])),
        /** Nhãn người đọc (tuỳ chọn) — ví dụ tên container. */
        label: take('label', pick(env, ['XTR_LABEL', 'HOSTNAME'], '')),

        // ── Upstream MiMo ──────────────────────────────────────────────────
        apiKey: take('apiKey', pick(env, ['MIMO_API_KEY', 'XIAOMI_MIMO_API_KEY', 'MIMO_KEY'])),
        apiBaseUrl: take(
            'apiBaseUrl',
            pick(env, ['MIMO_API_BASE_URL', 'MIMO_BASE_URL', 'MIMO_ENDPOINT', 'MIMO_API_BASE'], DEFAULT_API_BASE_URL),
        ),

        // ── Tuỳ chỉnh vận hành ─────────────────────────────────────────────
        /**
         * SỐ TIẾN TRÌNH con. Mặc định = số CPU (trần 8).
         *
         * ⛔ Node chạy JavaScript trên MỘT luồng. Việc ở đây gần như toàn I/O (gọi upstream + đẩy byte
         * lên dây) nên một tiến trình đã gánh được rất nhiều lượt — nhưng phần CPU còn lại (đóng gói
         * frame socket.io, nối Buffer, TLS) thì vẫn dồn vào đúng luồng đó, và đó mới là nút thắt khi
         * tải cao. Nhiều tiến trình = nhiều vòng lặp sự kiện = dùng được hết lõi của container.
         *
         * Mỗi tiến trình mở MỘT kết nối riêng về backend và tự khai là một LÀN riêng, nên backend rải
         * tải giữa chúng mà không cần biết gì về cụm bên này.
         */
        workers: take('workers', pickInt(env, ['XTR_WORKERS'], Math.min(cpuCount(), 8))),
        /**
         * Trần số lượt chạy CÙNG LÚC **mỗi tiến trình**. Vượt trần thì từ chối bằng `busy` để backend
         * đổi gateway khác. Công suất cả container = `workers × maxConcurrency`.
         *
         * 16 chứ không phải 4: mỗi lượt chờ chủ yếu là chờ upstream nghĩ, gần như không tốn CPU. Đặt
         * thấp là tự bóp cổ chai ở chỗ không có nút thắt.
         */
        maxConcurrency: take('maxConcurrency', pickInt(env, ['XTR_MAX_CONCURRENCY'], 16)),
        /**
         * Mức nước cao của bộ đệm gửi (số frame đang chờ đẩy đi). Chạm mức này thì NGỪNG đọc upstream
         * cho tới khi dây thoáng.
         *
         * ⛔ Không có trần này thì một backend đọc chậm làm bộ đệm phình theo tốc độ upstream sinh chữ
         * — RAM tăng không có trần, và tăng đúng lúc đang tải nặng nhất.
         */
        writeHighWater: take('writeHighWater', pickInt(env, ['XTR_WRITE_HIGH_WATER'], 64)),
        /** Trần tổng một lượt (backend gửi `deadlineMs` riêng thì lấy giá trị NHỎ HƠN). */
        requestTimeoutMs: take('requestTimeoutMs', pickInt(env, ['XTR_REQUEST_TIMEOUT_MS'], 600_000)),
        /** Chờ chữ đầu — không có chữ nào trong ngần này là coi gateway câm. */
        firstTokenMs: take('firstTokenMs', pickInt(env, ['XTR_FIRST_TOKEN_TIMEOUT_MS'], 180_000)),
        /** Gom mảnh SSE trước khi bắn lên dây (ms). 0 = gửi ngay từng mảnh. */
        flushIntervalMs: take('flushIntervalMs', pickInt(env, ['XTR_FLUSH_INTERVAL_MS'], 25)),
        /** Gom tới ngần này byte thì bắn ngay, không đợi hết nhịp. */
        flushBytes: take('flushBytes', pickInt(env, ['XTR_FLUSH_BYTES'], 16_384)),
        /** Nhịp gửi `stats` lên backend. */
        statsIntervalMs: take('statsIntervalMs', pickInt(env, ['XTR_STATS_INTERVAL_MS'], 15_000)),
        /** Đọc lại danh sách model mỗi ngần này. */
        modelsRefreshMs: take('modelsRefreshMs', pickInt(env, ['XTR_MODELS_REFRESH_MS'], 1_800_000)),
        /** Chờ các lượt đang chạy xong khi nhận SIGTERM. */
        shutdownGraceMs: take('shutdownGraceMs', pickInt(env, ['XTR_SHUTDOWN_GRACE_MS'], 20_000)),
        logLevel: take('logLevel', pick(env, ['XTR_LOG_LEVEL'], 'info')),
        logJson: take('logJson', pick(env, ['XTR_LOG_JSON'], '')) === '1',
    };

    config.apiBaseUrl = normalizeBaseUrl(config.apiBaseUrl);

    const missing = [];
    if (!config.gatewayUrl) missing.push('XTR_GATEWAY_URL (địa chỉ socket.io của XTRouter_Backend)');
    if (!config.gatewaySecret) missing.push('XTR_GATEWAY_SECRET (bí mật dùng chung để ký bắt tay)');
    if (!config.accountEmail) missing.push('XTR_ACCOUNT_EMAIL (email tài khoản MiMo — chính là danh tính gateway)');
    if (!config.apiKey) missing.push('MIMO_API_KEY (khoá gọi upstream — container thường đã set sẵn)');

    return { config, sources, missing };
}

/** Bảng "giá trị này lấy từ biến nào" để in lúc khởi động — bí mật đã che. */
export function describe(config, sources) {
    const secretKeys = new Set(['gatewaySecret', 'apiKey']);
    return Object.keys(config)
        .filter((k) => config[k] !== '' && config[k] !== null)
        .map((k) => ({
            key: k,
            value: secretKeys.has(k) ? maskSecret(config[k]) : String(config[k]),
            from: sources[k] ?? 'default',
        }));
}
