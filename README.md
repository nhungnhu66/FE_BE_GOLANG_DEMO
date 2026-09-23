# XTRouter Container — MiMo Claw Gateway

Tiến trình Node.js chạy **trong container MiMo**. Nó nối ngược về `XTRouter_Backend` bằng socket.io,
nghe yêu cầu suy luận, gọi API MiMo của container đó, rồi đẩy **byte SSE nguyên văn** trả lại backend.

```
XTRouter_Backend  ──(mở cổng socket.io /gw/mimo)──┐
                                                  │  container tự nối VÀO
                     ┌────────────────────────────┴──────────────┐
                     │  XTRouter_Container_Mimo_Claw (source này) │
                     │      chat.start ──▶ gọi api-sgp-oc         │
                     │      chat.chunk ◀── SSE nguyên văn         │
                     └────────────────────────────────────────────┘
```

**Container gọi ra ngoài, backend không gọi vào.** Không cần tunnel, không cần IP công khai, không
cần mở cổng nào trên container — đó chính là thứ đã giết đường Claw cũ (tunnel tạm đứt liên tục).

## Chạy

```bash
git clone https://github.com/nhungnhu66/XTRouter_Container_Mimo_Claw.git
cd XTRouter_Container_Mimo_Claw
npm install --omit=dev      # chỉ 1 phụ thuộc: socket.io-client

export XTR_JOIN='https://api.xkiro.com|<bí-mật-xin-từ-quản-trị>'
export XTR_ACCOUNT_EMAIL='email-tai-khoan-mimo-cua-container@example.com'

npm run doctor              # kiểm env + endpoint + model + header bắt buộc
npm start
```

**Chỉ hai biến.** Mọi thứ khác có mặc định hợp lý:

| | |
|---|---|
| `XTR_JOIN` | `<url backend>\|<bí mật>`. Gộp một biến để **không set được một nửa** — thiếu nửa nào thì lỗi báo về (`not_configured` / `bad_sig`) đều không dẫn tới nguyên nhân. Bỏ phần url thì dùng mặc định `https://api.xkiro.com`. |
| `XTR_ACCOUNT_EMAIL` | Email tài khoản MiMo của container này — **chính là danh tính** trên bảng quản trị. Mỗi container một email riêng. |

Khoá MiMo và endpoint thì container **đã có sẵn** ở env global, không phải đặt lại. Số tiến trình
**tự dò theo số lõi**.

⛔ **Bí mật KHÔNG nhúng trong mã**, và đó là cố ý: repo này công khai, nhúng vào là ai cũng cắm được
một gateway **giả** vào backend rồi nhận prompt thật của khách.

## `npm run doctor` — chạy TRƯỚC khi nghi ngờ bất cứ thứ gì

Nó trả lời bốn câu, theo đúng thứ tự phụ thuộc:

1. **Biến môi trường nào đang có** và mỗi giá trị lấy từ biến nào (khoá đã che).
2. **`GET /models` trả về model nào** — tên upstream THẬT, không phải tên mình đoán.
3. **Gọi thử từng model** một lượt tí hon, có chữ về không.
4. **Đối chứng:** gửi lại y hệt nhưng **bỏ header `User-Agent: mimo-claw`**.

Câu 4 không phải thủ tục. Thiếu nó thì "gọi được" chỉ chứng minh hôm nay gọi được, chứ không chứng
minh mình hiểu **vì sao** — và người sau bỏ header đi sẽ không hiểu tại sao hỏng.

## Ba sự thật về upstream (verify LIVE, đừng sửa nếu chưa đo lại)

- Đích `https://api-sgp-oc.xiaomimimo.com/v1/chat/completions`, wire **OpenAI-compatible**.
- Auth `Authorization: Bearer <MIMO_API_KEY>`.
- ⛔ **`User-Agent: mimo-claw` là BẮT BUỘC** — thiếu là `400`, không phải lỗi thỉnh thoảng.
- System message **đầu tiên** phải là `You are a personal assistant running inside OpenClaw.` —
  cổng gác theo đúng chuỗi này. *Backend dựng thân request nên nó lo phần này; container không tự
  chèn gì vào thân.*

## Đa tiến trình & hiệu năng

Một container có thể phải gánh **rất nhiều** lượt cùng lúc, nên ba thứ được làm sẵn:

**1. Nhiều tiến trình, không phải nhiều luồng.** `XTR_WORKERS` (mặc định = số lõi, trần 8) fork bấy
nhiêu tiến trình con; mỗi con mở **một kết nối riêng** về backend và tự khai là một **làn** riêng,
nên backend rải tải giữa chúng mà không cần biết gì về cụm bên này. Tiến trình chính chỉ giám sát:
con nào chết thì dựng lại (lùi dần **chỉ khi** con chết sớm — con chạy ngon hàng giờ rồi mới chết
phải được dựng lại ngay, lùi dần ở đó là tự rút công suất vì một sự cố đã qua).

*Vì sao không `worker_threads`:* việc ở đây gần như toàn I/O, mà luồng phụ chỉ giúp khi nghẽn CPU
thuần. Phần CPU còn lại (đóng gói frame, nối Buffer, TLS) nằm rải khắp tầng mạng của Node — đẩy nó
sang luồng khác là copy byte qua lại, đắt hơn phần tiết kiệm được.

**2. Byte thô suốt tuyến.** SSE không bao giờ bị giải mã ra chuỗi rồi mã hoá lại về UTF-8. Bỏ được
hai lần đụng vào cùng một khối byte mỗi mảnh, **và** bỏ luôn cái bẫy ký tự nhiều byte bị cắt đôi giữa
hai mảnh mạng.

**3. Áp lực ngược THẬT.** Chạm `XTR_WRITE_HIGH_WATER` frame đang chờ gửi thì container **ngừng đọc
upstream** cho tới khi dây thoáng — TCP tự khép cửa sổ về phía hãng. Không có chốt này thì một backend
đọc chậm làm bộ đệm phình theo tốc độ upstream sinh chữ: RAM tăng không có trần, đúng lúc tải nặng nhất.

Gom mảnh (`XTR_FLUSH_INTERVAL_MS` 25ms / `XTR_FLUSH_BYTES` 16KB) cắt gần hết chi phí đóng gói frame
mà mắt người không phân biệt nổi (ngưỡng cảm nhận ~100ms).

**Đo được:** `test/link.integration.test.js` chạy **120 lượt song song** qua MỘT tiến trình (1.560
frame SSE) xong trong **~1,1 giây**, và kiểm từng lượt: đủ mảnh, `seq` liên tục, mảnh `[DONE]` không
mất, và **không lượt nào lẫn một byte nào sang lượt khác**.

## Nguyên tắc thiết kế (đọc trước khi sửa)

**Container là ống dẫn trung thành.** Byte SSE của upstream đi lên backend **nguyên văn** — không
parse lại, không dựng lại, không sắp xếp lại. Backend đã có bộ đọc SSE dùng chung cho mọi provider
OpenAI-compatible; viết bộ dịch thứ hai cho cùng một định dạng thì bản ít lưu lượng hơn sẽ âm thầm
thiếu mọi bản vá của bản kia.

**Mọi tham số do backend quyết.** Container không chọn model, không đặt `temperature`, không chèn
system prompt. Nó nhận nguyên `body` và gửi đi. Nhờ vậy đổi chính sách = sửa backend, không phải đi
deploy lại từng container.

**Mất kết nối ⇒ huỷ mọi lượt đang chạy.** Kết quả không còn đường về thì chạy tiếp chỉ để đốt hạn
mức thật của tài khoản cho một câu trả lời không ai nhận.

**Quá tải ⇒ từ chối bằng `busy`, không xếp hàng.** Xếp hàng im lặng làm khách chờ mà không biết mình
đang chờ, và làm backend tưởng gateway này đang phục vụ nên không đổi sang gateway đang rảnh.

**Mã lỗi có cấu trúc, không parse câu chữ** (`src/protocol.js` → `END_CODES`): `busy` ·
`upstream_status` · `mute` · `network` · `canceled` · `deadline` · `internal`. Mỗi mã trả lời được
hai câu tách biệt mà backend cần: *gateway này có làm sai không* (phạt pool hay không) và *thử lại có
cơ hội khác không* (mã HTTP trả khách).

## Bảo mật

- Bắt tay ký **HMAC-SHA256** trên `version|email|ts|nonce`. **Bí mật không bao giờ đi lên dây**, chỉ
  chữ ký của nó đi. Ba lớp: khoá (chặn kẻ không có bí mật) · mốc thời gian ±5 phút (chặn phát lại
  chữ ký cũ) · nonce (chặn phát lại ngay trong cửa sổ còn hiệu lực).
- `email` nằm **trong** chuỗi ký ⇒ không thể đổi danh tính mà vẫn giữ chữ ký hợp lệ. Nếu không, bất
  kỳ container nào cũng mạo danh được gateway của tài khoản khác.
- Ký **lại mỗi lần nối** (kể cả nối lại) — ký một lần dùng mãi thì sau vài giờ chữ ký quá hạn và
  container không bao giờ nối lại được nữa, hỏng đúng lúc không ai ngồi nhìn.
- So chữ ký bằng `timingSafeEqual`, không bằng `===`.
- Khoá upstream **không bao giờ** rời khỏi container: `hello` chỉ khai `scheme://host`.

## Tinh chỉnh (đừng đụng nếu chưa đo được vấn đề)

| biến | mặc định | là gì |
|---|---|---|
| `XTR_WORKERS` | số lõi (trần 8) | số tiến trình con |
| `XTR_MAX_CONCURRENCY` | 16 | trần lượt song song **mỗi tiến trình** |
| `XTR_WRITE_HIGH_WATER` | 64 | số frame chờ gửi trước khi ngừng đọc upstream |
| `XTR_REQUEST_TIMEOUT_MS` | 600000 | trần tổng một lượt |
| `XTR_FIRST_TOKEN_TIMEOUT_MS` | 180000 | không có chữ nào trong ngần này ⇒ coi là câm |
| `XTR_FLUSH_INTERVAL_MS` / `XTR_FLUSH_BYTES` | 25 / 16384 | nhịp gom mảnh SSE |
| `XTR_STATS_INTERVAL_MS` | 15000 | nhịp tim gửi lên backend |
| `XTR_MODELS_REFRESH_MS` | 1800000 | nhịp đọc lại danh sách model |
| `XTR_SHUTDOWN_GRACE_MS` | 20000 | chờ lượt đang chạy khi nhận SIGTERM |
| `XTR_GATEWAY_PATH` | `/socket.io` | đường dẫn engine.io nếu nginx đặt khác |
| `XTR_LOG_LEVEL` / `XTR_LOG_JSON` | info / tắt | mức log, và log JSON một dòng |

## Cấu trúc

| tệp | việc |
|---|---|
| `src/protocol.js` | **hợp đồng dây** — sao nguyên văn sang backend, lệch là hỏng im lặng |
| `src/config.js` | đọc env theo danh sách tên ứng viên + báo cáo giá trị nào từ biến nào |
| `src/signature.js` | ký/kiểm bắt tay (backend dùng chung logic này) |
| `src/upstream.js` | gọi MiMo, đẩy SSE nguyên văn, phân loại kết cục |
| `src/chunk-pump.js` | gom mảnh SSE theo nhịp/byte — giảm số frame, giữ nguyên thứ tự |
| `src/jobs.js` | sổ lượt đang chạy + trần song song |
| `src/link.js` | vòng đời socket.io: bắt tay, nhận job, nhịp tim, tắt êm |
| `src/doctor.js` | công cụ chẩn đoán tại chỗ |

## Kiểm thử

```bash
npm test     # 55 test, zero-dep (node:test)
```

Bài quan trọng nhất là `test/link.integration.test.js`: dựng **socket.io server thật** + **máy chủ
SSE thật** rồi chạy `GatewayLink` thật ở giữa. Test đơn vị chứng minh từng mảnh đúng; chỉ bài này
chứng minh chúng **nối được với nhau** — mà chỗ hỏng của hệ phân tán gần như luôn nằm ở mối nối.
