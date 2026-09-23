# XTRouter MiMo Gateway (binary)

Agent gateway chạy **trong container/VPS MiMo**. Nó **tự nối RA** tới XTRouter_Backend bằng socket.io,
nghe yêu cầu suy luận, gọi API MiMo của máy đó, rồi đẩy **byte SSE nguyên văn** trả lại backend.

> Container gọi ra ngoài, backend **không** gọi vào — không cần tunnel, không cần IP công khai, không mở
> cổng nào. Chỉ cần máy này ra được Internet.

Repo này **chỉ chứa binary đã build** (Go, một tệp, không phụ thuộc runtime nào). Không có Node, không
`npm install`, không mã nguồn.

## Chạy

Chọn binary theo hệ điều hành trong `build/`:

| máy | tệp |
|---|---|
| Linux x86-64 | `build/mimo-claw-linux-amd64` |
| Linux ARM64  | `build/mimo-claw-linux-arm64` |
| Windows x64  | `build/mimo-claw-windows-amd64.exe` |

Đặt **hai** biến môi trường rồi chạy:

```bash
# Linux
export XTR_JOIN='https://api.xkiro.com|<bí-mật-xin-từ-quản-trị>'
export XTR_ACCOUNT_EMAIL='email-tài-khoản-mimo-của-máy-này@example.com'
chmod +x build/mimo-claw-linux-amd64
./build/mimo-claw-linux-amd64
```

```powershell
# Windows (PowerShell)
$env:XTR_JOIN='https://api.xkiro.com|<bí-mật-xin-từ-quản-trị>'
$env:XTR_ACCOUNT_EMAIL='email-tài-khoản-mimo-của-máy-này@example.com'
.\build\mimo-claw-windows-amd64.exe
```

**Chỉ hai biến.** Mọi thứ khác có mặc định hợp lý — xem `.env.example`. Khoá MiMo (`MIMO_API_KEY`) và
endpoint thường đã có sẵn trong env global của container; nếu chưa, đặt thêm `MIMO_API_KEY`.

## Kiểm tra trước khi nghi ngờ

```bash
./build/mimo-claw-linux-amd64 doctor
```

`doctor` trả lời bốn câu theo thứ tự: biến môi trường nào đang có · `GET /models` khai model nào · model
nào **thực sự** phục vụ được · và header bắt buộc có đúng là bắt buộc không (đối chứng). Chạy nó trước
khi đoán bất cứ điều gì.

## Chạy nền

Dùng process manager của máy (systemd / pm2 / nssm…). Binary tự nối lại khi rớt mạng và tự thoát êm khi
nhận `SIGTERM` (chờ các lượt đang chạy xong tới `XTR_SHUTDOWN_GRACE_MS`).

Ví dụ systemd (`/etc/systemd/system/mimo-claw.service`):

```ini
[Service]
Environment=XTR_JOIN=https://api.xkiro.com|<bí-mật>
Environment=XTR_ACCOUNT_EMAIL=email@example.com
ExecStart=/opt/mimo-claw/mimo-claw-linux-amd64
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
```

## Dựng lại binary

Mã nguồn Go giữ ở LOCAL (không nằm trong repo). Sau khi sửa mã: chạy `./build.sh` (cần Go ≥ 1.24) để
build lại cả ba binary vào `build/`, rồi commit.
