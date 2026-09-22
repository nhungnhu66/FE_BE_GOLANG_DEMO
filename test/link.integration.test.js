/**
 * Kiểm TOÀN TUYẾN: socket.io server THẬT (đóng vai XTRouter_Backend) + máy chủ SSE THẬT (đóng vai
 * upstream MiMo) + `GatewayLink` THẬT chạy ở giữa.
 *
 * ⛔ Đây mới là phép thử có nghĩa. Các test đơn vị phía trên chứng minh từng mảnh đúng; chỉ bài này
 * chứng minh chúng NỐI ĐƯỢC VỚI NHAU — mà chỗ hỏng của một hệ phân tán gần như luôn nằm ở mối nối:
 * sai tên sự kiện, sai hình dạng payload, sai thứ tự bắt tay. Không mảnh nào sai mà cả tuyến vẫn câm.
 */

import assert from 'node:assert/strict';
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
    const rebuilt = chunks.map((c) => c.data).join('');
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
