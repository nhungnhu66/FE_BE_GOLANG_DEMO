import assert from 'node:assert/strict';
import test from 'node:test';

import { JobRegistry } from '../src/jobs.js';

test('đủ trần thì KHÔNG nhận nữa — để backend đổi gateway khác', () => {
    const r = new JobRegistry({ maxConcurrency: 2 });
    assert.ok(r.canAccept());
    r.open('a');
    r.open('b');
    assert.equal(r.canAccept(), false);
    r.close('a', true);
    assert.ok(r.canAccept());
});

test('jobId trùng bị từ chối — hai luồng byte cùng id là hỏng không đọc ra được', () => {
    const r = new JobRegistry({ maxConcurrency: 4 });
    assert.ok(r.open('a'));
    assert.equal(r.open('a'), null);
});

test('cancel bắn abort đúng lượt, lượt khác không bị đụng', () => {
    const r = new JobRegistry({ maxConcurrency: 4 });
    const a = r.open('a');
    const b = r.open('b');
    assert.ok(r.cancel('a'));
    assert.equal(a.signal.aborted, true);
    assert.equal(b.signal.aborted, false);
});

test('cancel một lượt không tồn tại thì trả false, không ném', () => {
    const r = new JobRegistry({ maxConcurrency: 4 });
    assert.equal(r.cancel('khong-co'), false);
});

test('cancelAll huỷ hết — dùng khi mất kết nối, kết quả không còn đường về', () => {
    const r = new JobRegistry({ maxConcurrency: 4 });
    const a = r.open('a');
    const b = r.open('b');
    assert.equal(r.cancelAll('mat ket noi'), 2);
    assert.ok(a.signal.aborted && b.signal.aborted);
});

test('stopAccepting chặn việc MỚI nhưng để việc đang chạy chạy nốt', () => {
    const r = new JobRegistry({ maxConcurrency: 4 });
    r.open('a');
    r.stopAccepting();
    assert.equal(r.canAccept(), false);
    assert.equal(r.inflight, 1, 'việc đang chạy vẫn còn đó');
});

test('bộ đếm tách ok / hỏng', () => {
    const r = new JobRegistry({ maxConcurrency: 4 });
    r.open('a');
    r.open('b');
    r.close('a', true);
    r.close('b', false);
    const s = r.snapshot();
    assert.equal(s.totalStarted, 2);
    assert.equal(s.totalOk, 1);
    assert.equal(s.totalFailed, 1);
    assert.equal(s.inflight, 0);
});

test('close một lượt không tồn tại KHÔNG làm lệch bộ đếm', () => {
    const r = new JobRegistry({ maxConcurrency: 4 });
    assert.equal(r.close('ma', true), false);
    assert.equal(r.snapshot().totalOk, 0);
});
