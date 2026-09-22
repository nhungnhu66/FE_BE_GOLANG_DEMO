#!/usr/bin/env node
/**
 * Điểm vào của container gateway MiMo.
 *
 * Việc của tiến trình này, đúng ba dòng: nối về XTRouter_Backend → nghe job → gọi upstream MiMo rồi
 * trả byte SSE ngược lên. Nó KHÔNG mở cổng nào, KHÔNG nhận request từ bên ngoài, KHÔNG giữ trạng thái
 * nào qua lần khởi động — nên container bị giết lúc nào cũng được, dựng lại là tự nối về.
 */

import { describe, loadConfig } from './config.js';
import { GatewayLink } from './link.js';
import { createLogger } from './logger.js';

function main() {
    const { config, sources, missing } = loadConfig();
    const logger = createLogger({ level: config.logLevel, json: config.logJson });

    // ⛔ In bảng "giá trị này lấy từ biến nào" NGAY ở dòng đầu, kể cả khi chạy tốt. Container do người
    // khác dựng nên tên biến môi trường là thứ mình không nắm chắc; bảng này biến một buổi mò mẫm
    // thành một cái liếc mắt. Bí mật đã che sẵn trong `describe`.
    logger.info('Cấu hình đã đọc:');
    for (const row of describe(config, sources)) {
        logger.info(`  ${row.key.padEnd(18)} = ${row.value}`, { tuBien: row.from });
    }

    if (missing.length) {
        logger.error('THIẾU cấu hình bắt buộc — không khởi động được:');
        for (const m of missing) logger.error(`  · ${m}`);
        process.exit(1);
    }

    const link = new GatewayLink({ config, logger }).start();

    // Tắt êm. `once` chứ không `on`: tín hiệu thứ hai (người vận hành sốt ruột bấm Ctrl-C lần nữa) phải
    // giết thẳng, không chạy lại quy trình tắt đang dở.
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

    // ⛔ Không để một lỗi lẻ giết tiến trình: container chết = gateway của tài khoản đó biến mất khỏi
    // pool cho tới khi có người dựng lại. Ghi log rồi chạy tiếp là lựa chọn đúng ở đây, vì mọi đường
    // xử lý job đã never-throw sẵn — thứ rơi vào đây là ca hiếm mình chưa lường.
    process.on('unhandledRejection', (err) => logger.error('Promise lỗi không ai bắt', { loi: String(err) }));
    process.on('uncaughtException', (err) => logger.error('Ngoại lệ không ai bắt', { loi: err?.message, stack: err?.stack }));
}

main();
