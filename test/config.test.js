import assert from 'node:assert/strict';
import test from 'node:test';

import { describe as describeConfig, DEFAULT_API_BASE_URL, loadConfig, maskSecret, normalizeBaseUrl } from '../src/config.js';

const FULL = {
    XTR_GATEWAY_URL: 'https://api.example.com',
    XTR_GATEWAY_SECRET: 'secret-dung-chung',
    XTR_ACCOUNT_EMAIL: 'tk@example.com',
    MIMO_API_KEY: 'sk-abcdefghijklmnop',
};

test('đủ biến bắt buộc thì không thiếu gì', () => {
    const { missing } = loadConfig(FULL);
    assert.deepEqual(missing, []);
});

test('thiếu biến nào thì NÓI RÕ biến đó, không ném một câu chung chung', () => {
    const { missing } = loadConfig({ XTR_GATEWAY_URL: 'https://a.b' });
    assert.equal(missing.length, 3);
    assert.ok(missing.some((m) => m.includes('XTR_GATEWAY_SECRET')));
    assert.ok(missing.some((m) => m.includes('XTR_ACCOUNT_EMAIL')));
    assert.ok(missing.some((m) => m.includes('MIMO_API_KEY')));
});

test('nhận tên biến DỰ PHÒNG và báo đúng biến nào đã trúng', () => {
    const { config, sources } = loadConfig({ ...FULL, MIMO_API_KEY: '', XIAOMI_MIMO_API_KEY: 'sk-du-phong' });
    assert.equal(config.apiKey, 'sk-du-phong');
    assert.equal(sources.apiKey, 'XIAOMI_MIMO_API_KEY');
});

test('không set endpoint thì dùng mặc định đã verify live', () => {
    const { config, sources } = loadConfig(FULL);
    assert.equal(config.apiBaseUrl, DEFAULT_API_BASE_URL);
    assert.equal(sources.apiBaseUrl, 'default');
});

test('endpoint đã có /v1 thì KHÔNG nối thêm /v1 lần nữa', () => {
    assert.equal(normalizeBaseUrl('https://host/v1'), 'https://host/v1');
    assert.equal(normalizeBaseUrl('https://host/v1/'), 'https://host/v1');
    assert.equal(normalizeBaseUrl('https://host'), 'https://host/v1');
    assert.equal(normalizeBaseUrl('https://host/'), 'https://host/v1');
});

test('số không hợp lệ rơi về mặc định thay vì thành NaN', () => {
    const { config } = loadConfig({ ...FULL, XTR_MAX_CONCURRENCY: 'nhieu', XTR_FLUSH_BYTES: '-5' });
    assert.equal(config.maxConcurrency, 16);
    assert.equal(config.flushBytes, 16_384);
});

test('số hợp lệ được nhận', () => {
    const { config } = loadConfig({ ...FULL, XTR_MAX_CONCURRENCY: '12' });
    assert.equal(config.maxConcurrency, 12);
});

test('số tiến trình mặc định bám theo số lõi, và đặt tay thì nghe theo', () => {
    const { config } = loadConfig(FULL);
    assert.ok(config.workers >= 1 && config.workers <= 8, `workers = ${config.workers}`);
    assert.equal(loadConfig({ ...FULL, XTR_WORKERS: '3' }).config.workers, 3);
});

test('bảng cấu hình CHE khoá và bí mật', () => {
    const { config, sources } = loadConfig(FULL);
    const rows = describeConfig(config, sources);
    const key = rows.find((r) => r.key === 'apiKey');
    const secret = rows.find((r) => r.key === 'gatewaySecret');
    assert.ok(!key.value.includes('abcdefghijklmnop'));
    assert.ok(!secret.value.includes('secret-dung-chung'));
    // Vẫn phải đối chiếu được: giữ đầu/cuối.
    assert.ok(key.value.startsWith('sk-a'));
});

test('email được hạ về chữ thường — backend cũng hạ trước khi ký lại, lệch là bad_sig vĩnh viễn', () => {
    const { config } = loadConfig({ ...FULL, XTR_ACCOUNT_EMAIL: '  Ten.Toi@Gmail.COM ' });
    assert.equal(config.accountEmail, 'ten.toi@gmail.com');
});

test('maskSecret không làm lộ chuỗi ngắn', () => {
    assert.ok(!maskSecret('abcdefgh').includes('cdefgh'));
    assert.equal(maskSecret(''), '(trống)');
});
