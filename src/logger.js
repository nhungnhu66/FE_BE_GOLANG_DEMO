/**
 * Log gọn, zero-dep. Hai chế độ: đọc-bằng-mắt (mặc định) và JSON một dòng (`XTR_LOG_JSON=1`) cho bộ
 * gom log của container.
 *
 * ⛔ KHÔNG bao giờ in khoá/bí mật. Nơi duy nhất được in là `config.describe()` — và ở đó đã che sẵn.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger({ level = 'info', json = false, name = 'mimo-claw' } = {}) {
    const floor = LEVELS[level] ?? LEVELS.info;

    const write = (lvl, msg, data) => {
        if (LEVELS[lvl] < floor) return;
        const at = new Date().toISOString();
        if (json) {
            // Never-throw: dữ liệu vòng (circular) không được phép giết tiến trình chỉ vì một dòng log.
            let line;
            try {
                line = JSON.stringify({ at, lvl, name, msg, ...(data ?? {}) });
            } catch {
                line = JSON.stringify({ at, lvl, name, msg, data: '(không tuần tự hoá được)' });
            }
            process.stdout.write(`${line}\n`);
            return;
        }
        const tail = data && Object.keys(data).length ? ` ${format(data)}` : '';
        process.stdout.write(`${at} ${lvl.toUpperCase().padEnd(5)} [${name}] ${msg}${tail}\n`);
    };

    return {
        debug: (msg, data) => write('debug', msg, data),
        info: (msg, data) => write('info', msg, data),
        warn: (msg, data) => write('warn', msg, data),
        error: (msg, data) => write('error', msg, data),
        child: (childName) => createLogger({ level, json, name: `${name}:${childName}` }),
    };
}

function format(data) {
    return Object.entries(data)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' ');
}
