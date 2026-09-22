import assert from 'node:assert/strict';
import test from 'node:test';

import { ChunkPump } from '../src/chunk-pump.js';

function collector() {
    const out = [];
    return { out, onFlush: (data, seq) => out.push({ data, seq }) };
}

test('intervalMs = 0 thì bắn ngay từng mảnh, không gom', () => {
    const c = collector();
    const pump = new ChunkPump({ onFlush: c.onFlush, intervalMs: 0 });
    pump.push('a');
    pump.push('b');
    assert.deepEqual(c.out.map((f) => f.data), ['a', 'b']);
    assert.deepEqual(c.out.map((f) => f.seq), [1, 2]);
});

test('gom nhiều mảnh thành MỘT frame, GIỮ NGUYÊN thứ tự và không mất byte nào', () => {
    const c = collector();
    const pump = new ChunkPump({ onFlush: c.onFlush, intervalMs: 1_000 });
    pump.push('data: 1\n\n');
    pump.push('data: 2\n\n');
    pump.push('data: 3\n\n');
    assert.equal(c.out.length, 0, 'chưa tới nhịp thì chưa bắn');
    pump.end();
    assert.equal(c.out.length, 1);
    assert.equal(c.out[0].data, 'data: 1\n\ndata: 2\n\ndata: 3\n\n');
});

test('đủ maxBytes thì bắn NGAY, không đợi hết nhịp', () => {
    const c = collector();
    const pump = new ChunkPump({ onFlush: c.onFlush, intervalMs: 60_000, maxBytes: 10 });
    pump.push('12345');
    assert.equal(c.out.length, 0);
    pump.push('67890');
    assert.equal(c.out.length, 1);
    assert.equal(c.out[0].data, '1234567890');
});

test('end() xả nốt mảnh CUỐI — chỗ thường chứa usage và [DONE]', () => {
    const c = collector();
    const pump = new ChunkPump({ onFlush: c.onFlush, intervalMs: 60_000 });
    pump.push('data: {"usage":{"total_tokens":7}}\n\ndata: [DONE]\n\n');
    const lastSeq = pump.end();
    assert.equal(c.out.length, 1);
    assert.ok(c.out[0].data.includes('[DONE]'));
    assert.equal(lastSeq, 1);
});

test('end() trả về số thứ tự frame CUỐI để backend đối chiếu đã nhận đủ chưa', () => {
    const c = collector();
    const pump = new ChunkPump({ onFlush: c.onFlush, intervalMs: 0 });
    pump.push('a');
    pump.push('b');
    pump.push('c');
    assert.equal(pump.end(), 3);
});

test('đóng rồi thì không nhận thêm — frame muộn không lọt sau chat.end', () => {
    const c = collector();
    const pump = new ChunkPump({ onFlush: c.onFlush, intervalMs: 0 });
    pump.end();
    pump.push('muon');
    assert.equal(c.out.length, 0);
});

test('bắn theo nhịp thời gian khi chưa đủ byte', async () => {
    const c = collector();
    const pump = new ChunkPump({ onFlush: c.onFlush, intervalMs: 10, maxBytes: 1_000 });
    pump.push('x');
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(c.out.length, 1);
    assert.equal(c.out[0].data, 'x');
});

test('chuỗi rỗng không đẻ ra frame rỗng', () => {
    const c = collector();
    const pump = new ChunkPump({ onFlush: c.onFlush, intervalMs: 0 });
    pump.push('');
    pump.end();
    assert.equal(c.out.length, 0);
});
