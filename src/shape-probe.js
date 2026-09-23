#!/usr/bin/env node
/**
 * `npm run shape -- <model>` — tìm HÌNH DẠNG request mà một model chấp nhận.
 *
 * ⛔ Vì sao cần một công cụ riêng: một "công thức chạy được" thường đổi NHIỀU biến cùng lúc, nên nó
 * nói được *cái gì chạy* mà KHÔNG nói được *vì sao*. Backend thì phải biết vì sao — nó dựng thân
 * request cho mọi khách, và đoán nhầm biến quyết định là hỏng 100% request của model đó.
 *
 * Ví dụ thật 23/09/2026: `mimo-v2.6-flash` chạy với công thức {bỏ system + content dạng MẢNG +
 * `max_completion_tokens`}. Ba biến. Nếu chỉ chép nguyên công thức thì mình vĩnh viễn không biết
 * model khác có cần cả ba không, và mỗi lần thêm model lại phải mò lại từ đầu.
 *
 * Nên ở đây chạy TRỌN ma trận 2×2×2 và đọc kết quả theo chiều BIẾN, không theo chiều công thức:
 * với mỗi biến, lật MỘT MÌNH nó có đổi kết cục không.
 */

import { loadConfig, REQUIRED_USER_AGENT } from './config.js';

/** Chữ ký mở khoá cổng api-sgp-oc — verify LIVE. Bắt buộc với các model `pro`. */
const OPENCLAW_SIGNATURE = 'You are a personal assistant running inside OpenClaw.';

/** Ba trục đang nghi. Tên ngắn để in bảng cho gọn. */
const AXES = {
    system: [true, false],
    arrayContent: [false, true],
    completionTokens: [false, true],
};

function buildBody({ model, system, arrayContent, completionTokens }) {
    const userText = system ? 'Reply with exactly: OK' : `${OPENCLAW_SIGNATURE}\n\nReply with exactly: OK`;
    const messages = [];
    if (system) messages.push({ role: 'system', content: OPENCLAW_SIGNATURE });
    messages.push({ role: 'user', content: arrayContent ? [{ type: 'text', text: userText }] : userText });

    const body = { model, messages };
    // Chỉ MỘT trong hai tên tham số, không gửi cả hai — gửi cả hai thì không biết upstream đọc cái nào.
    if (completionTokens) body.max_completion_tokens = 32;
    else body.max_tokens = 32;
    return body;
}

async function callOnce(config, body) {
    const startedAt = Date.now();
    try {
        const res = await fetch(`${config.apiBaseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${config.apiKey}`,
                'user-agent': REQUIRED_USER_AGENT,
                'content-type': 'application/json',
                accept: 'application/json',
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(60_000),
        });
        const text = await res.text().catch(() => '');
        if (!res.ok) return { ok: false, status: res.status, note: squash(text) };

        // Không stream ⇒ đọc thẳng nội dung. BẰNG CHỨNG phải là CHỮ model nói ra: 200 với thân rỗng
        // là một cái bẫy đã dính thật ở cổng Kimi.
        const content = readContent(text);
        if (!content) return { ok: false, status: res.status, note: '200 nhưng KHÔNG có nội dung' };
        return { ok: true, ms: Date.now() - startedAt, sample: content.slice(0, 40) };
    } catch (err) {
        return { ok: false, note: err?.message ?? 'unknown' };
    }
}

function readContent(text) {
    try {
        const c = JSON.parse(text)?.choices?.[0]?.message?.content;
        if (typeof c === 'string') return c.trim();
        // Một số model trả content dạng mảng part — đọc một tầng nữa chứ đừng ra '[object Object]'.
        if (Array.isArray(c)) return c.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('').trim();
        return '';
    } catch {
        return '';
    }
}

function squash(body) {
    try {
        const e = JSON.parse(body)?.error ?? {};
        return [e.message, e.param].filter(Boolean).join(' · ') || body.replace(/\s+/g, ' ').trim().slice(0, 160);
    } catch {
        return body.replace(/\s+/g, ' ').trim().slice(0, 160);
    }
}

const flag = (v) => (v ? 'CÓ ' : 'không');

async function main() {
    const { config, missing } = loadConfig();
    if (missing.some((m) => m.includes('MIMO_API_KEY'))) {
        process.stdout.write('⛔ Không có MIMO_API_KEY.\n');
        process.exit(1);
    }
    const model = process.argv[2];
    if (!model) {
        process.stdout.write('Dùng: npm run shape -- <tên-model>\n  ví dụ: npm run shape -- mimo-v2.6-flash\n');
        process.exit(1);
    }

    process.stdout.write(`\nMa trận hình dạng cho: ${model}\n`);
    process.stdout.write(`endpoint: ${config.apiBaseUrl}\n\n`);
    process.stdout.write('  system | content mảng | max_completion_tokens | kết quả\n');
    process.stdout.write('  ' + '─'.repeat(76) + '\n');

    const results = [];
    for (const system of AXES.system) {
        for (const arrayContent of AXES.arrayContent) {
            for (const completionTokens of AXES.completionTokens) {
                const combo = { model, system, arrayContent, completionTokens };
                const r = await callOnce(config, buildBody(combo));
                results.push({ ...combo, ...r });
                const verdict = r.ok ? `✓ ${r.ms}ms · ${r.sample}` : `✗ ${r.status ?? '—'} · ${r.note}`;
                process.stdout.write(
                    `  ${flag(system).padEnd(6)} | ${flag(arrayContent).padEnd(12)} | ${flag(completionTokens).padEnd(21)} | ${verdict}\n`,
                );
            }
        }
    }

    // ── Đọc theo chiều BIẾN, không theo chiều công thức ──────────────────────
    process.stdout.write('\n  Biến nào QUYẾT ĐỊNH (lật một mình nó, giữ nguyên hai cái kia):\n');
    for (const axis of Object.keys(AXES)) {
        let flips = 0;
        let pairs = 0;
        for (const a of results) {
            const b = results.find(
                (x) => x !== a && x[axis] !== a[axis] && Object.keys(AXES).every((k) => k === axis || x[k] === a[k]),
            );
            if (!b || results.indexOf(b) < results.indexOf(a)) continue;
            pairs += 1;
            if (a.ok !== b.ok) flips += 1;
        }
        const label = flips === pairs && pairs > 0 ? 'QUYẾT ĐỊNH' : flips === 0 ? 'không ảnh hưởng' : 'ảnh hưởng MỘT PHẦN';
        process.stdout.write(`    · ${axis.padEnd(18)} → ${label}  (${flips}/${pairs} cặp đổi kết cục)\n`);
    }

    const ok = results.filter((r) => r.ok);
    process.stdout.write(`\n  Tổ hợp CHẠY ĐƯỢC: ${ok.length}/${results.length}\n`);
    if (ok.length) {
        // Tổ hợp ĐƠN GIẢN NHẤT: ít khác biệt nhất so với hình dạng chuẩn (system + chuỗi + max_tokens).
        const simplest = [...ok].sort(
            (a, b) =>
                Number(!a.system) + Number(a.arrayContent) + Number(a.completionTokens) -
                (Number(!b.system) + Number(b.arrayContent) + Number(b.completionTokens)),
        )[0];
        process.stdout.write(
            `  Hình dạng tối giản: system=${flag(simplest.system)} · content mảng=${flag(simplest.arrayContent)} · max_completion_tokens=${flag(simplest.completionTokens)}\n\n`,
        );
    } else {
        process.stdout.write('  ⚠️ KHÔNG tổ hợp nào chạy — nguyên nhân nằm ngoài ba biến này.\n\n');
    }
}

void main();
