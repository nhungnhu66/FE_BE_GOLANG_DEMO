/**
 * Kiểm `streamChat` bằng một máy chủ HTTP THẬT dựng tại chỗ (`node:http`, zero-dep).
 *
 * ⛔ Cố ý KHÔNG giả lập `fetch`: thứ dễ sai nhất ở đây là hành vi của LUỒNG (mảnh cắt ở đâu, đóng lúc
 * nào, huỷ giữa chừng thì sao) — mà đó đúng là phần một bản giả lập sẽ dựng theo ĐÚNG hiểu nhầm của
 * người viết test, rồi xanh trong khi thật thì hỏng.
 */

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import test from 'node:test';

import { END_CODES } from '../src/protocol.js';
import { streamChat } from '../src/upstream.js';

/** Dựng máy chủ tạm, trả `{ baseUrl, close, lastRequest }`. */
async function withServer(handler, run) {
    const seen = { headers: null, body: null };
    const server = createServer((req, res) => {
        seen.headers = req.headers;
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            seen.body = Buffer.concat(chunks).toString('utf8');
            handler(req, res);
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    try {
        return await run({ baseUrl, seen });
    } finally {
        await new Promise((r) => server.close(r));
    }
}

function sseHead(res) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
}

const BODY = { model: 'mimo-v2.5-pro', messages: [{ role: 'user', content: 'hi' }], stream: true };

test('đường thành công: byte SSE về NGUYÊN VĂN, đúng thứ tự', async () => {
    await withServer(
        (_req, res) => {
            sseHead(res);
            res.write('data: {"choices":[{"delta":{"content":"Xin"}}]}\n\n');
            res.write('data: {"choices":[{"delta":{"content":" chào"}}]}\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
        },
        async ({ baseUrl }) => {
            const got = [];
            const r = await streamChat({
                baseUrl,
                apiKey: 'k',
                body: BODY,
                firstTokenMs: 5_000,
                deadlineMs: 10_000,
                onChunk: (t) => got.push(t),
            });
            assert.equal(r.ok, true);
            assert.equal(r.code, END_CODES.ok);
            assert.ok(Buffer.isBuffer(got[0]), 'phải chuyển tiếp BYTE THÔ, không giải mã ra chuỗi');
            const joined = Buffer.concat(got).toString('utf8');
            assert.ok(joined.includes('"Xin"'));
            assert.ok(joined.indexOf('Xin') < joined.indexOf('chào'), 'thứ tự phải giữ nguyên');
            assert.ok(joined.endsWith('data: [DONE]\n\n'));
        },
    );
});

test('gửi ĐÚNG hai header sống còn: Bearer + User-Agent mimo-claw', async () => {
    await withServer(
        (_req, res) => {
            sseHead(res);
            res.write('data: x\n\n');
            res.end();
        },
        async ({ baseUrl, seen }) => {
            await streamChat({
                baseUrl,
                apiKey: 'khoa-bi-mat',
                body: BODY,
                firstTokenMs: 5_000,
                deadlineMs: 10_000,
                onChunk: () => {},
            });
            assert.equal(seen.headers['user-agent'], 'mimo-claw');
            assert.equal(seen.headers.authorization, 'Bearer khoa-bi-mat');
            assert.equal(JSON.parse(seen.body).model, 'mimo-v2.5-pro');
        },
    );
});

test('upstream trả mã lỗi ⇒ upstream_status kèm NGUYÊN VĂN thân lỗi', async () => {
    await withServer(
        (_req, res) => {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end('{"error":{"message":"Param Incorrect"}}');
        },
        async ({ baseUrl }) => {
            const r = await streamChat({
                baseUrl,
                apiKey: 'k',
                body: BODY,
                firstTokenMs: 5_000,
                deadlineMs: 10_000,
                onChunk: () => {},
            });
            assert.equal(r.ok, false);
            assert.equal(r.code, END_CODES.upstreamStatus);
            assert.equal(r.status, 400);
            assert.ok(r.error.includes('Param Incorrect'), 'phải giữ nguyên văn để còn chẩn được');
        },
    );
});

test('CÂM: mở được luồng nhưng không có dòng data nào trong hạn', async () => {
    await withServer(
        (_req, res) => {
            sseHead(res);
            // Giữ luồng mở, không gửi gì cả.
        },
        async ({ baseUrl }) => {
            const r = await streamChat({
                baseUrl,
                apiKey: 'k',
                body: BODY,
                firstTokenMs: 200,
                deadlineMs: 10_000,
                onChunk: () => {},
            });
            assert.equal(r.code, END_CODES.mute);
        },
    );
});

test('dòng bình luận keep-alive KHÔNG tính là có chữ — vẫn phải kết luận CÂM', async () => {
    await withServer(
        (_req, res) => {
            sseHead(res);
            const t = setInterval(() => res.write(': keep-alive\n\n'), 20);
            res.on('close', () => clearInterval(t));
        },
        async ({ baseUrl }) => {
            const r = await streamChat({
                baseUrl,
                apiKey: 'k',
                body: BODY,
                firstTokenMs: 200,
                deadlineMs: 10_000,
                onChunk: () => {},
            });
            assert.equal(r.code, END_CODES.mute, 'upstream vỗ về kết nối ≠ upstream đang sinh chữ');
        },
    );
});

test('luồng đóng SẠCH mà không có data nào vẫn là CÂM, không phải "trả lời xong, rỗng"', async () => {
    await withServer(
        (_req, res) => {
            sseHead(res);
            res.end();
        },
        async ({ baseUrl }) => {
            const r = await streamChat({
                baseUrl,
                apiKey: 'k',
                body: BODY,
                firstTokenMs: 5_000,
                deadlineMs: 10_000,
                onChunk: () => {},
            });
            assert.equal(r.ok, false);
            assert.equal(r.code, END_CODES.mute);
        },
    );
});

test('khách huỷ giữa chừng ⇒ canceled (KHÔNG phải mute — không được đổ lỗi cho upstream)', async () => {
    await withServer(
        (_req, res) => {
            sseHead(res);
            res.write('data: a\n\n');
            const t = setInterval(() => res.write('data: b\n\n'), 20);
            res.on('close', () => clearInterval(t));
        },
        async ({ baseUrl }) => {
            const ac = new AbortController();
            const p = streamChat({
                baseUrl,
                apiKey: 'k',
                body: BODY,
                signal: ac.signal,
                firstTokenMs: 5_000,
                deadlineMs: 10_000,
                onChunk: () => {},
            });
            setTimeout(() => ac.abort(), 80);
            const r = await p;
            assert.equal(r.code, END_CODES.canceled);
        },
    );
});

test('quá hạn tổng ⇒ deadline, tách khỏi mute (đã có chữ rồi thì không phải câm)', async () => {
    await withServer(
        (_req, res) => {
            sseHead(res);
            res.write('data: a\n\n');
            const t = setInterval(() => res.write('data: b\n\n'), 20);
            res.on('close', () => clearInterval(t));
        },
        async ({ baseUrl }) => {
            const r = await streamChat({
                baseUrl,
                apiKey: 'k',
                body: BODY,
                firstTokenMs: 5_000,
                deadlineMs: 150,
                onChunk: () => {},
            });
            assert.equal(r.code, END_CODES.deadline);
        },
    );
});

test('không nối được ⇒ network (lỗi của container/proxy, không phải của hãng)', async () => {
    const r = await streamChat({
        // Cổng 1 chắc chắn không có ai nghe.
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKey: 'k',
        body: BODY,
        firstTokenMs: 2_000,
        deadlineMs: 5_000,
        onChunk: () => {},
    });
    assert.equal(r.code, END_CODES.network);
});

test('ký tự nhiều byte bị cắt ĐÔI giữa hai mảnh vẫn ghép lại đúng', async () => {
    await withServer(
        (_req, res) => {
            sseHead(res);
            const full = Buffer.from('data: {"t":"Chào"}\n\n', 'utf8');
            // Cắt giữa ký tự 'à' (2 byte) — đúng ca mà bộ giải mã không có chế độ luồng sẽ ra '<?>'.
            const at = full.indexOf(Buffer.from('à', 'utf8')) + 1;
            res.write(full.subarray(0, at));
            setTimeout(() => {
                res.write(full.subarray(at));
                res.end();
            }, 20);
        },
        async ({ baseUrl }) => {
            const got = [];
            const r = await streamChat({
                baseUrl,
                apiKey: 'k',
                body: BODY,
                firstTokenMs: 5_000,
                deadlineMs: 10_000,
                onChunk: (t) => got.push(t),
            });
            assert.equal(r.ok, true);
            assert.ok(Buffer.concat(got).toString('utf8').includes('Chào'), 'không được ra ký tự hỏng');
        },
    );
});

test('mốc `\ndata:` bị mạng cắt ĐÔI vẫn dò ra — nếu không thì đồng hồ câm CẮT OAN lượt đang chạy tốt', async () => {
    await withServer(
        (_req, res) => {
            sseHead(res);
            res.write(Buffer.from('\nda', 'utf8'));
            setTimeout(() => res.write(Buffer.from('ta: {"choices":[]}\n\n', 'utf8')), 60);
            setTimeout(() => res.end(), 500);
        },
        async ({ baseUrl }) => {
            const r = await streamChat({
                baseUrl,
                apiKey: 'k',
                // Hạn CÂM 250ms: ngắn hơn lúc luồng kết thúc (500ms) nên nếu không ghép được mốc bị
                // cắt đôi thì đồng hồ câm sẽ nổ — đó chính là ca cần bắt.
                body: BODY,
                firstTokenMs: 250,
                deadlineMs: 10_000,
                onChunk: () => {},
            });
            assert.equal(r.ok, true, `phải chạy tới cùng, nhận được: ${r.code}`);
        },
    );
});

test('onChunk trả Promise thì vòng đọc PHẢI chờ — đó là đường áp lực ngược', async () => {
    await withServer(
        (_req, res) => {
            sseHead(res);
            for (let i = 0; i < 20; i++) res.write(`data: {"i":${i}}\n\n`);
            res.end();
        },
        async ({ baseUrl }) => {
            let inFlight = 0;
            let overlap = false;
            const r = await streamChat({
                baseUrl,
                apiKey: 'k',
                body: BODY,
                firstTokenMs: 5_000,
                deadlineMs: 10_000,
                onChunk: () => {
                    inFlight += 1;
                    if (inFlight > 1) overlap = true;
                    return new Promise((resolve) => {
                        setTimeout(() => {
                            inFlight -= 1;
                            resolve();
                        }, 5);
                    });
                },
            });
            assert.equal(r.ok, true);
            assert.equal(overlap, false, 'không được đọc mảnh kế khi mảnh trước chưa được nhận xong');
        },
    );
});
