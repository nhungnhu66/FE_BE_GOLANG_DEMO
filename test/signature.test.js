import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAuth, sign, verify } from '../src/signature.js';

const SECRET = 'bi-mat-dung-chung';
const EMAIL = 'tai-khoan@example.com';
const V = 1;

test('chữ ký ổn định với cùng đầu vào', () => {
    const a = sign({ version: V, email: EMAIL, ts: 1000, nonce: 'n1', secret: SECRET });
    const b = sign({ version: V, email: EMAIL, ts: 1000, nonce: 'n1', secret: SECRET });
    assert.equal(a, b);
});

test('chữ ký hợp lệ được chấp nhận', () => {
    const auth = buildAuth({ version: V, email: EMAIL, secret: SECRET, now: 5_000 });
    assert.deepEqual(verify({ version: V, ...auth, secret: SECRET, now: 5_000 }), { ok: true });
});

test('đổi email mà giữ chữ ký cũ thì BỊ TỪ CHỐI — chống mạo danh gateway tài khoản khác', () => {
    const auth = buildAuth({ version: V, email: EMAIL, secret: SECRET, now: 5_000 });
    const res = verify({ version: V, ...auth, email: 'ke-khac@example.com', secret: SECRET, now: 5_000 });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'bad_sig');
});

test('chữ ký quá cũ bị từ chối — chống phát lại', () => {
    const auth = buildAuth({ version: V, email: EMAIL, secret: SECRET, now: 0 });
    const res = verify({ version: V, ...auth, secret: SECRET, now: 10 * 60_000 });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'stale_ts');
});

test('sai bí mật thì từ chối', () => {
    const auth = buildAuth({ version: V, email: EMAIL, secret: SECRET, now: 5_000 });
    const res = verify({ version: V, ...auth, secret: 'bi-mat-khac', now: 5_000 });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'bad_sig');
});

test('chữ ký dài ngắn khác nhau KHÔNG làm hàm ném — timingSafeEqual bắt buộc cùng độ dài', () => {
    const auth = buildAuth({ version: V, email: EMAIL, secret: SECRET, now: 5_000 });
    const res = verify({ version: V, ...auth, sig: 'ngan', secret: SECRET, now: 5_000 });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'bad_sig');
});

test('thiếu trường thì từ chối trước khi tính gì', () => {
    assert.equal(verify({ version: V, email: EMAIL, secret: SECRET }).reason, 'missing_fields');
});

test('mỗi lần bắt tay sinh nonce MỚI — chữ ký cũ không dùng lại được', () => {
    const a = buildAuth({ version: V, email: EMAIL, secret: SECRET, now: 1 });
    const b = buildAuth({ version: V, email: EMAIL, secret: SECRET, now: 1 });
    assert.notEqual(a.nonce, b.nonce);
    assert.notEqual(a.sig, b.sig);
});
