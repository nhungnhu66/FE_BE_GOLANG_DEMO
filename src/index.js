#!/usr/bin/env node
/**
 * Điểm vào của container gateway MiMo.
 *
 * Hai vai trong CÙNG một tệp, chọn theo `XTR_WORKERS`:
 *  · **Giám sát** (tiến trình chính, khi > 1 worker) — fork các tiến trình con, dựng lại con nào chết,
 *    chuyển tiếp tín hiệu dừng. KHÔNG nối mạng, không giữ job nào.
 *  · **Worker** — nối về XTRouter_Backend, nghe job, gọi upstream MiMo, trả byte SSE ngược lên.
 *
 * ⛔ Vì sao nhiều TIẾN TRÌNH chứ không phải `worker_threads`: việc ở đây gần như toàn I/O, mà luồng
 * phụ chỉ giúp khi nghẽn CPU thuần. Phần CPU còn lại (đóng gói frame, nối Buffer, TLS) nằm rải khắp
 * tầng mạng của Node — đẩy nó sang luồng khác là copy byte qua lại, đắt hơn phần tiết kiệm được.
 * Tiến trình riêng thì mỗi cái có vòng lặp sự kiện riêng, socket riêng, và chết một cái không kéo
 * theo cái nào.
 *
 * Tiến trình này KHÔNG mở cổng nào, KHÔNG nhận request từ ngoài, KHÔNG giữ trạng thái qua lần khởi
 * động — nên container bị giết lúc nào cũng được, dựng lại là tự nối về.
 */

import cluster from 'node:cluster';

import { describe, loadConfig } from './config.js';
import { GatewayLink } from './link.js';
import { createLogger } from './logger.js';

/** Con chết SỚM hơn ngần này kể từ lúc sinh ⇒ coi là hỏng thật, phải lùi dần trước khi dựng lại. */
const HEALTHY_UPTIME_MS = 10_000;
const RESPAWN_BASE_MS = 500;
const RESPAWN_MAX_MS = 30_000;

function supervise(config, logger) {
    logger.info('Chạy chế độ nhiều tiến trình', {
        workers: config.workers,
        songSongMoiWorker: config.maxConcurrency,
        tongCongSuat: config.workers * config.maxConcurrency,
    });

    const bornAt = new Map();
    let failures = 0;
    let closing = false;

    const spawn = (workerId) => {
        const worker = cluster.fork({ XTR_WORKER_ID: String(workerId) });
        bornAt.set(worker.id, { at: Date.now(), workerId });
        return worker;
    };

    for (let i = 0; i < config.workers; i++) spawn(i);

    cluster.on('exit', (worker, code, signal) => {
        const info = bornAt.get(worker.id) ?? { at: Date.now(), workerId: 0 };
        bornAt.delete(worker.id);
        if (closing) return;

        const lived = Date.now() - info.at;
        // ⛔ Lùi dần CHỈ khi con chết sớm. Con chạy ngon hàng giờ rồi mới chết (OOM, hãng đóng kết nối)
        // phải được dựng lại NGAY — lùi dần ở đó là tự rút công suất vì một sự cố đã qua.
        if (lived >= HEALTHY_UPTIME_MS) failures = 0;
        else failures += 1;
        const delay = lived >= HEALTHY_UPTIME_MS ? 0 : Math.min(RESPAWN_BASE_MS * 2 ** (failures - 1), RESPAWN_MAX_MS);

        logger.warn('Worker chết — dựng lại', { workerId: info.workerId, code, signal, songMs: lived, choMs: delay });
        const t = setTimeout(() => spawn(info.workerId), delay);
        t.unref?.();
    });

    const stop = (signal) => {
        if (closing) return;
        closing = true;
        logger.info('Giám sát nhận tín hiệu dừng — bảo các worker tắt êm', { signal });
        for (const worker of Object.values(cluster.workers ?? {})) worker?.kill('SIGTERM');
        // Trần cứng: con nào không tự đi thì giám sát vẫn phải thoát, không treo container mãi.
        const t = setTimeout(() => process.exit(0), config.shutdownGraceMs + 5_000);
        t.unref?.();
        const poll = setInterval(() => {
            if (Object.keys(cluster.workers ?? {}).length === 0) {
                clearInterval(poll);
                process.exit(0);
            }
        }, 200);
        poll.unref?.();
    };
    process.once('SIGTERM', () => stop('SIGTERM'));
    process.once('SIGINT', () => stop('SIGINT'));
}

function runWorker(config, logger) {
    const link = new GatewayLink({ config, logger }).start();

    // Tắt êm. `once` chứ không `on`: tín hiệu thứ hai (người vận hành sốt ruột bấm Ctrl-C lần nữa)
    // phải giết thẳng, không chạy lại quy trình tắt đang dở.
    let closing = false;
    const stop = async (signal) => {
        if (closing) return;
        closing = true;
        logger.info('Nhận tín hiệu dừng — tắt êm', { signal, choToiMs: config.shutdownGraceMs });
        await link.shutdown(config.shutdownGraceMs);
        logger.info('Đã tắt sạch');
        process.exit(0);
    };
    process.once('SIGTERM', () => void stop('SIGTERM'));
    process.once('SIGINT', () => void stop('SIGINT'));

    // ⛔ Không để một lỗi lẻ giết tiến trình: mất một worker là mất một làn công suất. Ghi log rồi
    // chạy tiếp là lựa chọn đúng ở đây, vì mọi đường xử lý job đã never-throw sẵn — thứ rơi vào đây
    // là ca hiếm chưa lường. (Con chết thật thì giám sát dựng lại.)
    process.on('unhandledRejection', (err) => logger.error('Promise lỗi không ai bắt', { loi: String(err) }));
    process.on('uncaughtException', (err) => logger.error('Ngoại lệ không ai bắt', { loi: err?.message, stack: err?.stack }));
}

function main() {
    const { config, sources, missing } = loadConfig();
    const workerId = process.env.XTR_WORKER_ID;
    const isSupervisor = cluster.isPrimary && config.workers > 1;
    const logger = createLogger({
        level: config.logLevel,
        json: config.logJson,
        name: isSupervisor ? 'mimo-claw:sup' : `mimo-claw${workerId ? `:w${workerId}` : ''}`,
    });

    // ⛔ In bảng "giá trị này lấy từ biến nào" NGAY ở dòng đầu, kể cả khi chạy tốt. Container do người
    // khác dựng nên tên biến môi trường là thứ mình không nắm chắc; bảng này biến một buổi mò mẫm
    // thành một cái liếc mắt. Bí mật đã che sẵn trong `describe`. Chỉ in MỘT lần (ở tiến trình chính
    // hoặc worker 0) — N worker cùng in là N lần nhiễu như nhau.
    if (cluster.isPrimary || workerId === '0') {
        logger.info('Cấu hình đã đọc:');
        for (const row of describe(config, sources)) {
            logger.info(`  ${row.key.padEnd(18)} = ${row.value}`, { tuBien: row.from });
        }
    }

    if (missing.length) {
        logger.error('THIẾU cấu hình bắt buộc — không khởi động được:');
        for (const m of missing) logger.error(`  · ${m}`);
        process.exit(1);
    }

    if (isSupervisor) supervise(config, logger);
    else runWorker(config, logger);
}

main();
