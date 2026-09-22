/**
 * Kiểm TOÀN TUYẾN: socket.io server THẬT (đóng vai XTRouter_Backend) + máy chủ SSE THẬT (đóng vai
 * upstream MiMo) + `GatewayLink` THẬT chạy ở giữa.
 *
 * ⛔ Đây mới là phép thử có nghĩa. Các test đơn vị phía trên chứng minh từng mảnh đúng; chỉ bài này
 * chứng minh chúng NỐI ĐƯỢC VỚI NHAU — mà chỗ hỏng của một hệ phân tán gần như luôn nằm ở mối nối:
 * sai tên sự kiện, sai hình dạng payload, sai thứ tự bắt tay. Không mảnh nào sai mà cả tuyến vẫn câm.
 */

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import test from 'node:test';

import { Server } from 'socket.io';

import { GatewayLink } from '../src/link.js';
import { createLogger } from '../src/logger.js';
import { CLIENT_EVENTS, GATEWAY_NAMESPACE, PROTOCOL_VERSION, SERVER_EVENTS, END_CODES } from '../src/protocol.js';
import { verify } from '../src/signature.js';

const SECRET = 'bi-mat-tich-hop';
const EMAIL = 'gateway-1@example.com';

const SSE_BODY = [
    'data: {"choices":[{"delta":{"reasoning_content":"nghĩ…"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"Xin chào"}}]}\n\n',
    'data: {"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}\n\n',
    'data: [DONE]\n\n',
].join('');

/** Máy chủ giả lập upstream MiMo. `mode` quyết định nó cư xử thế nào. */
async function startUpstream(mode = 'ok') {
    const server = createServer((req, res) => {
        if (req.url.endsWith('/models')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ data: [{ id: 'mimo-v2.5' }, { id: 'mimo-v2.5-pro' }] }));
            return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (mode === 'slow') {
            // Giữ luồng mở, nhỏ giọt — để kiểm đường HUỶ.
            const t = setInterval(() => res.write('data: {"choices":[{"delta":{"content":"."}}]}\n\n'), 30);
            res.on('close', () => clearInterval(t));
            return;
        }
        res.end(SSE_BODY);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((r) => server.close(r)) };
}

/** Máy chủ giả lập XTRouter_Backend: đúng namespace, đúng luật kiểm chữ ký. */
async function startBackend() {
    const http = createServer();
    const io = new Server(http, { path: '/socket.io', transports: ['websocket'] });
    const state = { hello: null, rejected: [] };

    const ns = io.of(GATEWAY_NAMESPACE);
    ns.use((socket, next) => {
        const auth = socket.handshake.auth ?? {};
        const res = verify({ version: PROTOCOL_VERSION, ...auth, secret: SECRET });
        if (!res.ok) {
            state.rejected.push(res.reason);
            const err = new Error('unauthorized');
            err.data = { reason: res.reason };
            next(err);
            return;
        }
        socket.data.email = auth.email;
        next();
    });
    ns.on('connection', (socket) => {
        socket.on(CLIENT_EVENTS.hello, (payload) => {
            state.hello = payload;
            state.onHello?.(payload);
        });
    });

    await new Promise((r) => http.listen(0, '127.0.0.1', r));
    return {
        url: `http://127.0.0.1:${http.address().port}`,
        ns,
        state,
        close: async () => {
            await io.close();
            await new Promise((r) => http.close(r));
        },
    };
}

function baseConfig({ backendUrl, upstreamUrl, secret = SECRET, overrides = {} }) {
    return {
        gatewayUrl: backendUrl,
        gatewayPath: '/socket.io',
        gatewaySecret: secret,
        accountEmail: EMAIL,
        label: 'container-test',
        apiKey: 'khoa-test',
        apiBaseUrl: upstreamUrl,
        maxConcurrency: 4,
        requestTimeoutMs: 15_000,
        firstTokenMs: 5_000,
        flushIntervalMs: 5,
        flushBytes: 16_384,
        statsIntervalMs: 60_000,
        modelsRefreshMs: 600_000,
        shutdownGraceMs: 1_000,
        logLevel: 'error',
        logJson: false,
        ...overrides,
    };
}

/** Chờ một sự kiện trên socket, kèm hạn giờ để test hỏng thì báo rõ chứ không treo. */
function waitFor(socket, event, timeoutMs = 8_000) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`hết ${timeoutMs}ms chờ sự kiện '${event}'`)), timeoutMs);
        socket.once(event, (payload) => {
            clearTimeout(t);
            resolve(payload);
        });
    });
}

/** Chờ một container nối vào và khai `hello`. */
function waitForGateway(backend, timeoutMs = 8_000) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('không có container nào nối vào')), timeoutMs);
        backend.ns.once('connection', (socket) => {
            socket.once(CLIENT_EVENTS.hello, (hello) => {
                clearTimeout(t);
                resolve({ socket, hello });
            });
        });
    });
}

test('toàn tuyến: bắt tay → khai model → chạy một lượt → byte SSE về NGUYÊN VẸN', async (t) => {
    const upstream = await startUpstream('ok');
    const backend = await startBackend();
    const link = new GatewayLink({
        config: baseConfig({ backendUrl: backend.url, upstreamUrl: upstream.baseUrl }),
        logger: createLogger({ level: 'error' }),
    });
    t.after(async () => {
        await link.shutdown(0);
        await backend.close();
        await upstream.close();
    });

    const waiting = waitForGateway(backend);
    link.start();
    const { socket, hello } = await waiting;

    // Khai đúng danh tính + model đọc được từ upstream (KHÔNG phải danh sách bịa sẵn trong mã).
    assert.equal(hello.email, EMAIL);
    assert.equal(hello.v, PROTOCOL_VERSION);
    assert.deepEqual(hello.models, ['mimo-v2.5', 'mimo-v2.5-pro']);
    // ⛔ Dây chẩn đoán KHÔNG được mang khoá.
    assert.ok(!JSON.stringify(hello).includes('khoa-test'));

    const chunks = [];
    socket.on(CLIENT_EVENTS.chatChunk, (f) => chunks.push(f));
    const opened = waitFor(socket, CLIENT_EVENTS.chatOpen);
    const ended = waitFor(socket, CLIENT_EVENTS.chatEnd);

    const ack = await socket
        .timeout(5_000)
        .emitWithAck(SERVER_EVENTS.chatStart, {
            jobId: 'job-1',
            body: { model: 'mimo-v2.5-pro', stream: true, messages: [{ role: 'user', content: 'hi' }] },
        });
    assert.equal(ack.accepted, true, 'phải nhận việc NGAY bằng ack, không bắt backend đoán');

    const open = await opened;
    assert.equal(open.status, 200);

    const end = await ended;
    assert.equal(end.ok, true);
    assert.equal(end.code, END_CODES.ok);

    // Ghép lại phải BẰNG ĐÚNG luồng upstream — không thiếu, không thừa, không đảo.
    assert.ok(Buffer.isBuffer(chunks[0].data), 'frame phải là BYTE THÔ, không phải chuỗi đã giải mã');
    const rebuilt = Buffer.concat(chunks.map((c) => c.data)).toString('utf8');
    assert.equal(rebuilt, SSE_BODY);
    // `usage` (số token để tính tiền) và `[DONE]` nằm ở mảnh cuối — đúng chỗ dễ mất nhất.
    assert.ok(rebuilt.includes('"total_tokens":7'));
    assert.ok(rebuilt.endsWith('data: [DONE]\n\n'));
    // Số thứ tự liên tục 1..N để backend biết mình có nhận thiếu frame nào không.
    assert.deepEqual(chunks.map((c) => c.seq), chunks.map((_, i) => i + 1));
    assert.equal(end.seq, chunks.length);
});

test('sai bí mật ⇒ backend TỪ CHỐI ngay ở bắt tay, không vào tới job nào', async (t) => {
    const upstream = await startUpstream('ok');
    const backend = await startBackend();
    const link = new GatewayLink({
        config: baseConfig({ backendUrl: backend.url, upstreamUrl: upstream.baseUrl, secret: 'bi-mat-SAI' }),
        logger: createLogger({ level: 'error' }),
    });
    t.after(async () => {
        await link.shutdown(0);
        await backend.close();
        await upstream.close();
    });

    link.start();
    await new Promise((r) => setTimeout(r, 600));
    assert.ok(backend.state.rejected.includes('bad_sig'), `lý do từ chối: ${backend.state.rejected.join(',')}`);
    assert.equal(backend.state.hello, null, 'không được nhận hello từ container chưa qua cửa');
});

test('quá tải ⇒ trả `busy` để backend đổi gateway khác, KHÔNG xếp hàng im lặng', async (t) => {
    const upstream = await startUpstream('slow');
    const backend = await startBackend();
    const link = new GatewayLink({
        config: baseConfig({
            backendUrl: backend.url,
            upstreamUrl: upstream.baseUrl,
            overrides: { maxConcurrency: 1 },
        }),
        logger: createLogger({ level: 'error' }),
    });
    t.after(async () => {
        await link.shutdown(0);
        await backend.close();
        await upstream.close();
    });

    const waiting = waitForGateway(backend);
    link.start();
    const { socket } = await waiting;

    const body = { model: 'mimo-v2.5-pro', stream: true, messages: [{ role: 'user', content: 'hi' }] };
    const first = await socket.timeout(5_000).emitWithAck(SERVER_EVENTS.chatStart, { jobId: 'j1', body });
    assert.equal(first.accepted, true);

    const second = await socket.timeout(5_000).emitWithAck(SERVER_EVENTS.chatStart, { jobId: 'j2', body });
    assert.equal(second.accepted, false);
    assert.equal(second.code, END_CODES.busy);
    assert.equal(second.inflight, 1);

    // Dọn: huỷ lượt đang chạy để máy chủ chậm nhả kết nối.
    socket.emit(SERVER_EVENTS.chatCancel, { jobId: 'j1' });
    await waitFor(socket, CLIENT_EVENTS.chatEnd);
});

test('backend huỷ ⇒ lượt dừng và báo `canceled` (không đổ lỗi cho upstream)', async (t) => {
    const upstream = await startUpstream('slow');
    const backend = await startBackend();
    const link = new GatewayLink({
        config: baseConfig({ backendUrl: backend.url, upstreamUrl: upstream.baseUrl }),
        logger: createLogger({ level: 'error' }),
    });
    t.after(async () => {
        await link.shutdown(0);
        await backend.close();
        await upstream.close();
    });

    const waiting = waitForGateway(backend);
    link.start();
    const { socket } = await waiting;

    const ended = waitFor(socket, CLIENT_EVENTS.chatEnd);
    await socket.timeout(5_000).emitWithAck(SERVER_EVENTS.chatStart, {
        jobId: 'j-cancel',
        body: { model: 'mimo-v2.5-pro', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    });
    await waitFor(socket, CLIENT_EVENTS.chatOpen);
    socket.emit(SERVER_EVENTS.chatCancel, { jobId: 'j-cancel', reason: 'khách bỏ đi' });

    const end = await ended;
    assert.equal(end.ok, false);
    assert.equal(end.code, END_CODES.canceled);
});

test('jobId trùng bị từ chối — hai luồng byte cùng id là hỏng không đọc ra được', async (t) => {
    const upstream = await startUpstream('slow');
    const backend = await startBackend();
    const link = new GatewayLink({
        config: baseConfig({ backendUrl: backend.url, upstreamUrl: upstream.baseUrl }),
        logger: createLogger({ level: 'error' }),
    });
    t.after(async () => {
        await link.shutdown(0);
        await backend.close();
        await upstream.close();
    });

    const waiting = waitForGateway(backend);
    link.start();
    const { socket } = await waiting;

    const body = { model: 'mimo-v2.5-pro', stream: true, messages: [{ role: 'user', content: 'hi' }] };
    await socket.timeout(5_000).emitWithAck(SERVER_EVENTS.chatStart, { jobId: 'same', body });
    const again = await socket.timeout(5_000).emitWithAck(SERVER_EVENTS.chatStart, { jobId: 'same', body });
    assert.equal(again.accepted, false);
    assert.equal(again.code, END_CODES.internal);

    socket.emit(SERVER_EVENTS.chatCancel, { jobId: 'same' });
    await waitFor(socket, CLIENT_EVENTS.chatEnd);
});

test('TẢI NẶNG: 120 lượt song song — không lượt nào lẫn byte sang lượt khác', async (t) => {
    // Upstream nhả byte MANG DẤU của chính lượt đó, chia thành nhiều mảnh nhỏ để ép các lượt đan xen
    // nhau trên cùng một vòng lặp sự kiện. Nếu sổ job hoặc bộ gom mảnh có chỗ dùng chung nhầm, các
    // luồng sẽ trộn vào nhau — và đó là kiểu hỏng tệ nhất: không lỗi, chỉ là câu trả lời của người này
    // rơi sang người kia.
    const PARTS = 12;
    const upstreamServer = createServer((req, res) => {
        if (req.url.endsWith('/models')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ data: [{ id: 'mimo-v2.5-pro' }] }));
            return;
        }
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const mark = JSON.parse(Buffer.concat(chunks).toString('utf8')).messages[0].content;
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            let i = 0;
            const tick = setInterval(() => {
                if (i >= PARTS) {
                    clearInterval(tick);
                    res.end('data: [DONE]\n\n');
                    return;
                }
                res.write(`data: {"m":"${mark}","i":${i}}\n\n`);
                i += 1;
            }, 2);
            res.on('close', () => clearInterval(tick));
        });
    });
    await new Promise((r) => upstreamServer.listen(0, '127.0.0.1', r));
    const upstreamUrl = `http://127.0.0.1:${upstreamServer.address().port}/v1`;

    const backend = await startBackend();
    const link = new GatewayLink({
        config: baseConfig({
            backendUrl: backend.url,
            upstreamUrl,
            overrides: { maxConcurrency: 200, flushIntervalMs: 10 },
        }),
        logger: createLogger({ level: 'error' }),
    });
    t.after(async () => {
        await link.shutdown(0);
        await backend.close();
        await new Promise((r) => upstreamServer.close(r));
    });

    const waiting = waitForGateway(backend);
    link.start();
    const { socket } = await waiting;

    const N = 120;
    const byJob = new Map();
    for (let i = 0; i < N; i++) byJob.set(`job-${i}`, { parts: [], seqs: [], end: null });

    socket.on(CLIENT_EVENTS.chatChunk, ({ jobId, seq, data }) => {
        const slot = byJob.get(jobId);
        slot.parts.push(data);
        slot.seqs.push(seq);
    });

    const allEnded = new Promise((resolve) => {
        let left = N;
        socket.on(CLIENT_EVENTS.chatEnd, (end) => {
            byJob.get(end.jobId).end = end;
            left -= 1;
            if (left === 0) resolve();
        });
    });

    const startedAt = Date.now();
    const acks = await Promise.all(
        [...byJob.keys()].map((jobId) =>
            socket.timeout(10_000).emitWithAck(SERVER_EVENTS.chatStart, {
                jobId,
                body: { model: 'mimo-v2.5-pro', stream: true, messages: [{ role: 'user', content: jobId }] },
            }),
        ),
    );
    assert.equal(acks.filter((a) => a.accepted).length, N, 'phải nhận hết, không cái nào rơi');

    await allEnded;
    const elapsed = Date.now() - startedAt;

    for (const [jobId, slot] of byJob) {
        assert.equal(slot.end.ok, true, `${jobId} phải xong sạch, nhận: ${slot.end.code}`);
        const text = Buffer.concat(slot.parts).toString('utf8');
        // ⛔ Dấu của CHÍNH lượt đó, và TUYỆT ĐỐI không có dấu của lượt nào khác.
        assert.equal((text.match(new RegExp(`"${jobId}"`, 'g')) ?? []).length, PARTS, `${jobId} thiếu/thừa mảnh`);
        assert.ok(!/"job-(?!\d+")/.test(text));
        for (const other of ['job-0', 'job-1', 'job-119']) {
            if (other !== jobId) assert.ok(!text.includes(`"${other}"`), `${jobId} lẫn byte của ${other}`);
        }
        assert.ok(text.endsWith('data: [DONE]\n\n'), `${jobId} mất mảnh cuối`);
        assert.deepEqual(slot.seqs, slot.seqs.map((_, i) => i + 1), `${jobId} lệch số thứ tự`);
        assert.equal(slot.end.seq, slot.seqs.length);
    }

    // Không phải mốc hiệu năng để bám, chỉ là lưới bắt ca "chạy tuần tự" (120 lượt × 24ms nối đuôi
    // nhau là ~3s; song song thật thì xong trong vài trăm ms).
    assert.ok(elapsed < 8_000, `120 lượt song song mất ${elapsed}ms — nghi bị tuần tự hoá`);
});
