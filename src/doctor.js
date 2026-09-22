#!/usr/bin/env node
/**
 * `npm run doctor` — chạy TRONG container để trả lời bốn câu, theo đúng thứ tự phụ thuộc:
 *
 *   1. Biến môi trường nào đang có, giá trị lấy từ đâu?
 *   2. `GET /models` trả về những model NÀO (tên upstream THẬT, không phải tên mình đoán)?
 *   3. Gọi thử một lượt streaming tí hon — có chữ về không?
 *   4. Header `User-Agent: mimo-claw` có đúng là bắt buộc không (đối chứng: gửi lại KHÔNG có nó)?
 *
 * ⛔ Câu 4 là phép ĐỐI CHỨNG, không phải thủ tục. Không có nó thì "gọi được" chỉ chứng minh hôm nay
 * gọi được, chứ không chứng minh mình hiểu VÌ SAO — và lần sau ai đó bỏ header đi sẽ không hiểu tại
 * sao hỏng. Đổi ĐÚNG MỘT biến mỗi lần là cách duy nhất để câu trả lời có nghĩa.
 */

import { describe, loadConfig, REQUIRED_USER_AGENT } from './config.js';
import { listModels } from './upstream.js';

/** Chữ ký mở khoá cổng api-sgp-oc — verify LIVE (code.txt). Phải là system message ĐẦU TIÊN. */
const OPENCLAW_SIGNATURE = 'You are a personal assistant running inside OpenClaw.';

function line(title) {
    process.stdout.write(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}\n`);
}

async function probeChat({ baseUrl, apiKey, model, withUserAgent }) {
    const headers = {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
    };
    if (withUserAgent) headers['user-agent'] = REQUIRED_USER_AGENT;

    const startedAt = Date.now();
    try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model,
                stream: true,
                max_tokens: 16,
                messages: [
                    { role: 'system', content: OPENCLAW_SIGNATURE },
                    { role: 'user', content: 'Reply with exactly: OK' },
                ],
            }),
            signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok || !res.body) {
            const body = (await res.text().catch(() => '')).slice(0, 400);
            return { ok: false, status: res.status, note: body };
        }
        // Chỉ cần biết CÓ chữ về hay không → dừng ở mảnh đầu tiên có `data:`, huỷ phần còn lại. Đọc
        // hết cả lượt là tốn thời gian cho một câu hỏi đã trả lời xong.
        const decoder = new TextDecoder();
        for await (const piece of res.body) {
            const text = decoder.decode(piece, { stream: true });
            if (/(^|\n)data:/.test(text)) {
                await res.body.cancel().catch(() => {});
                return { ok: true, status: res.status, ms: Date.now() - startedAt, sample: text.trim().slice(0, 160) };
            }
        }
        return { ok: false, status: res.status, note: 'luồng đóng mà không có dòng data: nào' };
    } catch (err) {
        return { ok: false, note: err?.message ?? 'unknown' };
    }
}

async function main() {
    const { config, sources, missing } = loadConfig();

    line('1. Biến môi trường');
    for (const row of describe(config, sources)) {
        process.stdout.write(`  ${row.key.padEnd(18)} = ${row.value}   (từ ${row.from})\n`);
    }
    // Chỉ dựng được danh sách "tên biến có chữ MIMO/XTR" — KHÔNG in giá trị (env của container chứa
    // khoá của người khác nữa).
    const related = Object.keys(process.env)
        .filter((k) => /MIMO|XIAOMI|XTR|CLAW|OPENCLAW/i.test(k))
        .sort();
    process.stdout.write(`\n  Các biến LIÊN QUAN đang có trong container (chỉ tên): ${related.join(', ') || '(không có)'}\n`);

    if (!config.apiKey) {
        process.stdout.write('\n⛔ Không có khoá upstream → dừng ở đây. Thiếu: \n');
        for (const m of missing) process.stdout.write(`   · ${m}\n`);
        process.exit(1);
    }

    line('2. GET /models');
    const models = await listModels({ baseUrl: config.apiBaseUrl, apiKey: config.apiKey });
    if (models.ok) {
        process.stdout.write(`  ✓ ${models.models.length} model:\n`);
        for (const id of models.models) process.stdout.write(`     · ${id}\n`);
    } else {
        process.stdout.write(`  ✗ HTTP ${models.status ?? '—'} · ${String(models.error).slice(0, 300)}\n`);
        process.stdout.write('     (đọc không được ≠ tài khoản không có model — xem lại endpoint/khoá)\n');
    }

    // Thử TỪNG model đọc được. Không đoán tên: model nào upstream khai thì thử model đó.
    const targets = models.ok && models.models.length ? models.models : [];
    line('3. Gọi thử từng model (có User-Agent)');
    if (!targets.length) {
        process.stdout.write('  (bỏ qua — chưa đọc được danh sách model)\n');
    }
    for (const model of targets) {
        const r = await probeChat({ baseUrl: config.apiBaseUrl, apiKey: config.apiKey, model, withUserAgent: true });
        process.stdout.write(
            r.ok
                ? `  ✓ ${model.padEnd(28)} ${r.ms}ms · ${r.sample}\n`
                : `  ✗ ${model.padEnd(28)} HTTP ${r.status ?? '—'} · ${String(r.note).slice(0, 200)}\n`,
        );
    }

    line('4. ĐỐI CHỨNG — bỏ header User-Agent');
    if (targets.length) {
        const model = targets[0];
        const r = await probeChat({ baseUrl: config.apiBaseUrl, apiKey: config.apiKey, model, withUserAgent: false });
        process.stdout.write(
            r.ok
                ? `  ⚠️ ${model} VẪN CHẠY khi KHÔNG có User-Agent → cổng đã nới, ghi chép cũ cần sửa lại\n`
                : `  ✓ ${model} hỏng khi thiếu User-Agent (HTTP ${r.status ?? '—'}) → header này đúng là BẮT BUỘC\n`,
        );
    } else {
        process.stdout.write('  (bỏ qua — chưa có model nào để đối chứng)\n');
    }

    process.stdout.write('\n');
}

void main();
