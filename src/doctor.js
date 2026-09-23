#!/usr/bin/env node
/**
 * `npm run doctor` — chạy TRONG container để trả lời bốn câu, theo đúng thứ tự phụ thuộc:
 *
 *   1. Biến môi trường nào đang có, giá trị lấy từ đâu?
 *   2. `GET /models` trả về những model NÀO (tên upstream THẬT, không phải tên mình đoán)?
 *   3. Model nào THỰC SỰ phục vụ được, và **với hình dạng request nào**?
 *   4. Header `User-Agent: mimo-claw` có đúng là bắt buộc không (đối chứng: gửi lại KHÔNG có nó)?
 *
 * ⛔ Câu 3 phải hỏi "với hình dạng NÀO", không chỉ hỏi "được hay không". Đo thật 23/09/2026: `/models`
 * khai 9 model mà chỉ 2 chạy — và trong số hỏng, có nhóm hỏng vì TÀI KHOẢN không được cấp
 * (`Not supported model`, không chữa được) và nhóm hỏng vì HÌNH DẠNG request (`Param Incorrect`,
 * chữa được). Gộp hai nhóm vào một dấu ✗ là vứt đi đúng thông tin quyết định phải làm gì tiếp.
 *
 * ⛔ Câu 4 là phép ĐỐI CHỨNG, không phải thủ tục. Không có nó thì "gọi được" chỉ chứng minh hôm nay
 * gọi được, chứ không chứng minh mình hiểu VÌ SAO — và lần sau ai đó bỏ header đi sẽ không hiểu tại
 * sao hỏng. Đổi ĐÚNG MỘT biến mỗi lần là cách duy nhất để câu trả lời có nghĩa.
 */

import { describe, loadConfig, REQUIRED_USER_AGENT } from './config.js';
import { listModels } from './upstream.js';

/** Chữ ký mở khoá cổng api-sgp-oc — verify LIVE (code.txt). Phải là system message ĐẦU TIÊN. */
const OPENCLAW_SIGNATURE = 'You are a personal assistant running inside OpenClaw.';

/** Upstream nói thẳng model không được cấp cho tài khoản này — khác hẳn lỗi hình dạng request. */
const NOT_ENTITLED_RE = /not supported model/i;

function line(title) {
    process.stdout.write(`\n── ${title} ${'─'.repeat(Math.max(0, 62 - title.length))}\n`);
}

/**
 * Gọi thử một lượt tí hon.
 *
 * @param {boolean} withSystem  có gửi system message (chữ ký OpenClaw) không — ĐÂY là biến được đổi.
 */
async function probeChat({ baseUrl, apiKey, model, withUserAgent = true, withSystem = true }) {
    const headers = {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
    };
    if (withUserAgent) headers['user-agent'] = REQUIRED_USER_AGENT;

    // Bỏ system thì phải NHẬP chữ ký vào lượt user — bỏ hẳn là đổi HAI biến cùng lúc, và lúc đó
    // kết quả không nói được điều gì.
    const messages = withSystem
        ? [
              { role: 'system', content: OPENCLAW_SIGNATURE },
              { role: 'user', content: 'Reply with exactly: OK' },
          ]
        : [{ role: 'user', content: `${OPENCLAW_SIGNATURE}\n\nReply with exactly: OK` }];

    const startedAt = Date.now();
    try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ model, stream: true, max_tokens: 16, messages }),
            signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok || !res.body) {
            const body = (await res.text().catch(() => '')).slice(0, 400);
            return { ok: false, status: res.status, note: squash(body) };
        }
        // Chỉ cần biết CÓ chữ về hay không → dừng ở mảnh đầu có `data:`, huỷ phần còn lại. Đọc hết
        // cả lượt là tốn thời gian cho một câu hỏi đã trả lời xong.
        const decoder = new TextDecoder();
        for await (const piece of res.body) {
            const text = decoder.decode(piece, { stream: true });
            if (/(^|\n)data:/.test(text)) {
                await res.body.cancel().catch(() => {});
                return { ok: true, status: res.status, ms: Date.now() - startedAt };
            }
        }
        return { ok: false, status: res.status, note: 'luồng đóng mà không có dòng data: nào' };
    } catch (err) {
        return { ok: false, note: err?.message ?? 'unknown' };
    }
}

/** Ép thân lỗi JSON nhiều dòng về một dòng đọc được. */
function squash(body) {
    try {
        const j = JSON.parse(body);
        const e = j?.error ?? j;
        return [e?.message, e?.param].filter(Boolean).join(' · ') || body.replace(/\s+/g, ' ').trim();
    } catch {
        return body.replace(/\s+/g, ' ').trim().slice(0, 200);
    }
}

async function main() {
    const { config, sources, missing } = loadConfig();

    line('1. Biến môi trường');
    for (const row of describe(config, sources)) {
        process.stdout.write(`  ${row.key.padEnd(18)} = ${row.value}   (từ ${row.from})\n`);
    }
    // Chỉ liệt kê TÊN biến liên quan — KHÔNG in giá trị (env container chứa cả khoá của thứ khác).
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
        process.stdout.write(`  ✓ ${models.models.length} model: ${models.models.join(', ')}\n`);
        process.stdout.write('  ⚠️ Danh sách này là "được KHAI", KHÔNG phải "phục vụ được" — xem mục 3.\n');
    } else {
        process.stdout.write(`  ✗ HTTP ${models.status ?? '—'} · ${String(models.error).slice(0, 300)}\n`);
        process.stdout.write('     (đọc không được ≠ tài khoản không có model — xem lại endpoint/khoá)\n');
    }

    const targets = models.ok ? models.models : [];
    line('3. Model nào PHỤC VỤ ĐƯỢC, và với hình dạng nào');
    if (!targets.length) process.stdout.write('  (bỏ qua — chưa đọc được danh sách model)\n');

    const usable = [];
    const needsFlatten = [];
    const notEntitled = [];
    const broken = [];

    for (const model of targets) {
        const withSystem = await probeChat({ baseUrl: config.apiBaseUrl, apiKey: config.apiKey, model });
        if (withSystem.ok) {
            usable.push(model);
            process.stdout.write(`  ✓ ${model.padEnd(28)} CÓ system · ${withSystem.ms}ms\n`);
            continue;
        }
        // Upstream nói thẳng không được cấp ⇒ đổi hình dạng cũng vô ích, đừng tốn thêm một lượt gọi.
        if (NOT_ENTITLED_RE.test(String(withSystem.note))) {
            notEntitled.push(model);
            process.stdout.write(`  ⊘ ${model.padEnd(28)} tài khoản KHÔNG được cấp · ${withSystem.note}\n`);
            continue;
        }

        // ĐỔI ĐÚNG MỘT BIẾN: bỏ system, giữ nguyên mọi thứ khác.
        const noSystem = await probeChat({ baseUrl: config.apiBaseUrl, apiKey: config.apiKey, model, withSystem: false });
        if (noSystem.ok) {
            needsFlatten.push(model);
            process.stdout.write(`  ✓ ${model.padEnd(28)} CHỈ KHI BỎ system · ${noSystem.ms}ms  ← cần làm phẳng\n`);
        } else {
            broken.push(model);
            process.stdout.write(`  ✗ ${model.padEnd(28)} hỏng cả hai cách · ${withSystem.note}\n`);
        }
    }

    line('4. ĐỐI CHỨNG — bỏ header User-Agent');
    const control = usable[0] ?? needsFlatten[0];
    if (control) {
        const r = await probeChat({
            baseUrl: config.apiBaseUrl,
            apiKey: config.apiKey,
            model: control,
            withUserAgent: false,
            withSystem: usable.includes(control),
        });
        process.stdout.write(
            r.ok
                ? `  ⚠️ ${control} VẪN CHẠY khi KHÔNG có User-Agent → cổng đã nới, ghi chép cũ cần sửa lại\n`
                : `  ✓ ${control} hỏng khi thiếu User-Agent (HTTP ${r.status ?? '—'}) → header này đúng là BẮT BUỘC\n`,
        );
    } else {
        process.stdout.write('  (bỏ qua — chưa model nào chạy được để làm đối chứng)\n');
    }

    line('TÓM TẮT — dán phần này về cho backend');
    process.stdout.write(`  DÙNG NGAY (giữ system)      : ${usable.join(', ') || '(không có)'}\n`);
    process.stdout.write(`  CẦN LÀM PHẲNG (bỏ system)   : ${needsFlatten.join(', ') || '(không có)'}\n`);
    process.stdout.write(`  KHÔNG được cấp cho tài khoản: ${notEntitled.join(', ') || '(không có)'}\n`);
    process.stdout.write(`  Hỏng chưa rõ lý do          : ${broken.join(', ') || '(không có)'}\n\n`);
}

void main();
