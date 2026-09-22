import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';

import { ChunkPump } from '../src/chunk-pump.js';

function collector() {
    const out = [];
    return { out, onFlush: (data, seq) => out.push({ data, seq }) };
}

const B = (s) => Buffer.from(s, 'utf8');
const joined = (out) => Buffer.concat(out.map((f) => f.data)).toString('utf8');

test('intervalMs = 0 thì bắn ngay từng mảnh, không gom', () => {
    const c = collector();
    const pump = new ChunkPump({ onFlush: c.onFlush, intervalMs: 0 });
    pump.push(B('a'));
    pump.push(B('b'));
    assert.deepEqual(c.out.map((f) => f.data.toString()), ['a', 'b']);
    assert.deepEqual(c.out.map((f) => f.seq), [1, 2]);
});

test('gom nhiều mảnh thành MỘT frame, GIỮ NGUYÊN thứ tự và không mất byte nào', () => {
    const c = collector();
    const pump = new ChunkPump({ onFlush: c.onFlush, intervalMs: 1_000 });
    pump.push(B('data: 1\n\n'));
    pump.push(B('data: 2\n\n'));
    pump.push(B('data: 3\n\n'));
    assert.equal(c.out.length, 0, 'chưa tới nhịp thì chưa bắn');
    pump.end();
    assert.equal(c.out.length, 1);
    assert.equal(c.out[0].data.toString(), 'data: 1\n\ndata: 2\n\ndata: 3\n\n');
});

test('đủ maxBytes thì bắn NGAY, không đợi hết nhịp', () => {
    const c = collector();
    const pump = new ChunkPump({ onFlush: c.onFlush, intervalMs: 60_000, maxBytes: 10 });
    pump.push(B('12345'));
    assert.equal(c.out.length, 0);
    pump.push(B('67890'));
    assert.equal(c.out.length, 1);
    assert.equal(c.out[0].data.toString(), '1234567890');
});

test('end() xả nốt mảnh CUỐI — chỗ thường chứa usage và [DONE]', () => {
    const c = collector();
    const pump = new ChunkPump({ onFlush: c.onFlush, intervalMs: 60_000 });
    pump.push(B('data: {"usage":{"total_tokens":7}}\n\ndata: [DONE]\n\n'));
    const lastSeq = pump.end();
    assert.equal(c.out.length, 1);
    assert.ok(c.out[0].data.toString().includes('[DONE]'));
    assert.equal(lastSeq, 1);
});

test('end() trả về số thứ tự frame CUỐI để backend đối chiếu đã nhận đủ chưa', () => {
    const c = collector();
    const pump = new ChunkPump({ onFlush: c.onFlush, intervalMs: 0 });
    pump.push(B('a'));
    pump.push(B('b'));
    pump.push(B('c'));
    assert.equal(pump.end(), 3);
});

test('đóng rồi thì không nhận thêm — frame muộn không lọt sau chat.end', () => {
    const c = collector();
    const pump = new ChunkPump({ onFlush: c.onFlush, intervalMs: 0 });
    pump.end();
    pump.push(B('muon'));
    assert.equal(c.out.length, 0);
});

test('bắn theo nhịp thời gian khi chưa đủ byte', async () => {
    const c = collector();
    const pump = new ChunkPump({ onFlush: c.onFlush, intervalMs: 10, maxBytes: 1_000 });
    pump.push(B('x'));
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(c.out.length, 1);
    assert.equal(c.out[0].data.toString(), 'x');
});

test('mảnh rỗng không đẻ ra frame rỗng', () => {
    const c = collector();
    const pump = new ChunkPump({ onFlush: c.onFlush, intervalMs: 0 });
    pump.push(Buffer.alloc(0));
    pump.push(null);
    pump.end();
    assert.equal(c.out.length, 0);
});

test('byte thô đi qua NGUYÊN VẸN — kể cả ký tự nhiều byte bị cắt đôi giữa hai mảnh', () => {
    const c = collector();
    const pump = new ChunkPump({ onFlush: c.onFlush, intervalMs: 1_000 });
    const full = B('data: {"t":"Chào bạn"}\n\n');
    const at = 14; // cắt vào GIỮA ký tự 'à'
    pump.push(full.subarray(0, at));
    pump.push(full.subarray(at));
    pump.end();
    assert.equal(joined(c.out), full.toString('utf8'));
});

// ── Áp lực ngược ────────────────────────────────────────────────────────────

test('dây THOÁNG thì push không trả Promise — đường thường không cấp phát thừa', () => {
    const c = collector();
    const pump = new ChunkPump({
        onFlush: c.onFlush,
        intervalMs: 0,
        pressure: { congested: () => false, drain: () => Promise.resolve() },
    });
    assert.equal(pump.push(B('a')), undefined);
});

test('dây TẮC thì push trả Promise để bên gọi ngừng đọc upstream', async () => {
    const c = collector();
    let released;
    const gate = new Promise((r) => {
        released = r;
    });
    const pump = new ChunkPump({
        onFlush: c.onFlush,
        intervalMs: 0,
        pressure: { congested: () => true, drain: () => gate },
    });
    const wait = pump.push(B('a'));
    assert.ok(wait instanceof Promise, 'phải ép được áp lực ngược');

    let done = false;
    void wait.then(() => {
        done = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(done, false, 'chưa thoáng thì vẫn phải chờ');
    released();
    await wait;
    assert.equal(c.out.length, 1, 'mảnh vẫn được gửi, chỉ là bên gọi bị giữ lại');
});
