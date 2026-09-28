# SoftAP cục bộ và cập nhật firmware OTA

> [← Quay lại mục lục IoT](../IOT.md)

## 9. Điểm phát WiFi cục bộ (SoftAP)

Khi trạm mất internet, dashboard cloud không vào được. ESP32-S3 tự phát một
mạng WiFi riêng để người dùng kết nối tại chỗ và mở trang cục bộ tại
`http://192.168.4.1`.

**Thiết bị là nguồn sự thật của cấu hình này** — ngược chiều với ngưỡng pin
(mục 8) và điều khiển tải (mục 6), vốn đi cloud → thiết bị:

```
ESP32 phát AP_SSID/AP_PASSWORD (secrets.h)
   │  báo lên trong telemetry (bản tin đầu sau mỗi lần reconnect)
   ▼
ingest-telemetry → devices.ap_ssid / ap_password / ap_reported_at
   ▼
DevConsole → Cấu hình mạng (chỉ hiển thị, không sửa được)
```

Lý do không cho sửa từ dashboard: không có gì bảo đảm ESP32 phát đúng thứ
cloud đã lưu, nên một ô nhập trên dashboard sẽ hiển thị giá trị chưa chắc
đúng với mạng đang phát thật. Đổi AP = sửa `AP_SSID`/`AP_PASSWORD` trong
`secrets.h` rồi nạp lại firmware; `.ino` có `static_assert` chặn SSID > 32
byte và mật khẩu ngoài khoảng 8–63 ký tự ngay lúc biên dịch.

Cũng vì lý do đó, **WiFi uplink cố tình không nằm trên dashboard**: sai
SSID/mật khẩu uplink là thiết bị mất mạng vĩnh viễn, không sửa được từ xa.

### 9.1 Lưu ý vận hành

- AP và STA dùng **chung một radio** và bị ép về cùng kênh. Khi có client bám
  vào AP, thông lượng/độ ổn định của đường MQTT giảm. Nếu thấy MQTT chập chờn,
  chuyển sang bật AP theo yêu cầu (nút nhấn / sau N phút mất kết nối) thay vì
  phát thường trực — sửa `startAccessPoint()` trong `.ino`.
- Mật khẩu AP lưu plaintext ở `devices.ap_password` (cần đúng chuỗi PSK để
  người dùng gõ vào máy). RLS của `devices` giới hạn về đúng chủ trạm.
- Firmware cũ chưa có SoftAP thì `devices.ap_ssid` = null → DevConsole hiển
  thị "Thiết bị chưa báo cấu hình AP".

### 9.2 Dashboard cục bộ (đã triển khai)

Firmware nhúng một dashboard độc lập ngay trong flash và phục vụ bằng HTTP tại
`http://192.168.4.1`. Trang này không tải CDN, không gọi Supabase và không cần
đăng nhập cloud; JavaScript đọc `GET /api/telemetry` mỗi giây nên số liệu đi
thẳng từ ESP32 đến điện thoại/máy tính đang nối AP.

Quy trình sử dụng khi mất internet:

1. Kết nối WiFi có tên `AP_SSID` bằng `AP_PASSWORD` trong `secrets.h`.
2. Chạm thông báo đăng nhập mạng nếu hệ điều hành hiện captive portal, hoặc mở
   rõ `http://192.168.4.1` (phải là `http`, không phải `https`).
3. Dashboard local hiển thị PV, pin, tải, nhiệt độ, trạng thái bảo vệ, liên kết
   STM32 và trạng thái đồng bộ cloud; dữ liệu tự cập nhật mỗi giây.

API trả JSON, CORS và Private Network Access header tại
`http://192.168.4.1/api/telemetry`. Bản Windows/Electron tự dò endpoint này:
khi kết nối được, `LocalConnectionProvider` ánh xạ `device` (AWS thing name)
sang trạm tương ứng rồi đưa dữ liệu local vào chính `useStations`,
`useTelemetry` và `useDevices`. Vì vậy User Dashboard và DevConsole hiện tại
tự cập nhật trực tiếp, đồng thời có dải **Kết nối cục bộ** để người vận hành
biết dữ liệu không đi qua cloud. Rời AP hoặc mất hai request liên tiếp thì app
tự quay về nguồn Supabase/realtime.

Mặc định app dò `http://192.168.4.1`; có thể đổi lúc build bằng
`VITE_LOCAL_DEVICE_URL`. Bản web chạy trên HTTPS có thể bị trình duyệt chặn
HTTP mixed-content/private-network, vì vậy tích hợp tự động này nhắm tới app
Windows (origin HTTP loopback). Trang do ESP32 tự phục vụ vẫn là đường dự phòng
luôn hoạt động trên điện thoại hoặc trình duyệt.

Kết nối STA và AWS đã đổi sang cơ chế retry **không chặn**. Đây là phần bắt
buộc: nếu còn vòng `while` chờ WiFi/MQTT trong `setup()` hoặc `loop()`, AP vẫn
phát tên mạng nhưng HTTP server không có cơ hội xử lý request khi internet mất.
Khi uplink trở lại, firmware tự nối AWS và tiếp tục publish telemetry như cũ.

## 10. Cập nhật firmware qua mạng (OTA)

Luồng đã chạy được đầu-cuối: migration `0015_firmware_ota.sql` dựng **tầng lưu
trữ** (catalog bản phát hành, bucket chứa `.bin`, cột theo dõi phiên bản trên
`devices`, bổ sung phần trăm ở migration `0033_ota_progress.sql`),
`send-ota-command` lo **chiều đẩy lệnh**, firmware lo **tải + kiểm
hash + nạp**, `ingest-telemetry` lo **chiều thiết bị báo về**, và DevConsole lo
**giao diện** (tải lên, chọn bản, đẩy, theo dõi) — xem 10.8.

```
Dev build .bin ──upload──▶ Storage bucket `firmware` (private)
                                    │
                           firmware_releases (version, sha256, size, path)
                                    │  send-ota-command:
                                    │  cấp signed URL + publish lệnh
                                    ▼
                         solgrid/<thing>/command {type:"ota",url,sha256}
                                    │
                                    ▼  firmware: HTTPClient + Update + kiểm hash
                         ESP32 tải, verify SHA-256, ghi slot OTA, reboot
                                    │
                  telemetry kế: fw_version/fw_status ──▶ ingest-telemetry
                                    ▼
                         devices.fw_version / fw_status ──▶ DevConsole
```

Chiều đi và chiều về tách bạch đúng như các cơ chế đã có:
`devices.fw_target_id` là **cloud ra lệnh** (giống `loads.desired_state`),
`devices.fw_version`/`fw_status` là **thiết bị báo về** (giống
`loads.reported_state` và `ap_ssid` mục 9). Chênh lệch giữa hai bên chính là
tín hiệu phát hiện thiết bị nạp hỏng — cloud không được tự coi "đã gửi lệnh"
là "đã nạp xong".

### 10.1 Áp migration

```bash
supabase db push
```

Tạo ra:
- Bảng **`firmware_releases`** — `(owner_id, board, version)` là khoá duy nhất,
  kèm `storage_path`, `size_bytes`, `sha256`, `release_notes`. Phạm vi theo chủ
  sở hữu chứ không theo trạm: một `.bin` gắn với **loại board**
  (`firmware/<board>/`), đẩy được cho mọi ESP32 cùng loại ở mọi trạm.
- Cột mới trên **`devices`**: `fw_version`, `fw_reported_at`, `fw_target_id`,
  `fw_status` (`idle|pending|downloading|applying|success|failed`),
  `fw_status_detail`, `fw_status_at`.
- Bucket **`firmware`** (private, giới hạn 16 MB, chỉ nhận
  `application/octet-stream`) + RLS trên `storage.objects`.

### 10.2 Quy ước đường dẫn

```
<owner_id>/<board>/<version>.bin
```

Segment đầu **bắt buộc** là uuid chủ sở hữu — RLS của `storage.objects` kiểm
tra bằng `storage.foldername(name)[1] = auth.uid()`, và bảng
`firmware_releases` có check `storage_path like owner_id || '/%'` để hai bên
không lệch nhau.

### 10.3 Tải một bản firmware lên

Bucket là **private** — đặt public thì ai đoán ra URL cũng tải về dịch ngược
được. Thiết bị lấy file qua **signed URL ngắn hạn** do Edge Function cấp bằng
user client đã xác thực (RLS giới hạn đúng release của chủ sở hữu). Service
role chỉ được dùng phía server để cập nhật trạng thái `devices` sau khi lệnh
đã publish.

```js
// sha256 của đúng file .bin — firmware kiểm lại hash này trước khi commit ảnh,
// nên phải tính từ chính bytes sắp upload.
const buf = await file.arrayBuffer();
const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))]
  .map((b) => b.toString(16).padStart(2, '0')).join('');

const path = `${user.id}/esp32s3-solgrid/v2.3.1.bin`;
await supabase.storage.from('firmware').upload(path, file, {
  contentType: 'application/octet-stream',   // bắt buộc — bucket chặn mime khác
});
await supabase.from('firmware_releases').insert({
  board: 'esp32s3-solgrid', version: 'v2.3.1',
  storage_path: path, size_bytes: file.size, sha256,
  release_notes: 'Sửa lỗi đọc cảm biến dòng điện khi tải cao',
});
// owner_id lấy default auth.uid(), không cần truyền.
```

Tính hash bằng CLI để đối chiếu: `sha256sum firmware.bin`.

### 10.4 Bất biến và dọn dẹp

- Một bản phát hành đã tạo là **bất biến**: chỉ `release_notes` sửa được, mọi
  cột định danh (`version`, `sha256`, `storage_path`, `size_bytes`...) bị
  trigger `firmware_releases_protect_identity` ghim lại. Bucket cũng không có
  policy `update`. Lý do: `fw_version` thiết bị báo về phải trỏ đúng **một**
  binary duy nhất, nếu không lịch sử phiên bản và rollback đều vô nghĩa. Sửa
  bản phát hành = tải lên version mới.
- **Xoá hàng `firmware_releases` không xoá file trong bucket.** Phải
  `storage.from('firmware').remove([path])` trước rồi mới xoá hàng, nếu không
  object thành mồ côi. SQL không xoá được object khỏi S3 nên không làm bằng
  trigger.
- Xoá bản phát hành khi có thiết bị đang nạp dở nó: FK `on delete set null` gỡ
  `fw_target_id`, trigger `devices_clear_fw_target` đánh `fw_status='failed'`,
  `fw_status_detail='release_deleted'` — đúng thực tế, vì signed URL trỏ tới
  object đã xoá thì thiết bị chắc chắn tải thất bại.

### 10.5 Đẩy OTA — Edge Function `send-ota-command`

File `.bin` **không đi qua MQTT**: payload AWS IoT giới hạn 128 KB còn ảnh
firmware cỡ vài MB. Lệnh MQTT chỉ mang **signed URL ngắn hạn**, thiết bị tự
tải qua HTTPS — cũng là lý do bucket giữ được chế độ private.

Trong triển khai hiện tại, `send-ota-command` publish trực tiếp payload
`{type:"ota",...}` lên `solgrid/<aws_thing_name>/command`. Đây là đường được
Dashboard sử dụng khi bấm **Cập nhật** hoặc **Đẩy OTA đến tất cả thiết bị**.
Firmware cũng lắng nghe AWS IoT Jobs (`notify-next`/`start-next`) và có thể xử
lý job document cùng loại, nhưng Edge Function này **không tạo AWS Job**; vì
vậy lệnh direct MQTT không có `jobId` và trạng thái/tiến trình của nó được xác
nhận qua telemetry `fw_*`.

```bash
# Dùng chung cặp khoá iot:Publish + AWS_IOT_ENDPOINT với send-load-command
# (mục 6.2) — cùng namespace topic solgrid/*/command, không cần secret mới.
# Tuỳ chọn: TTL của signed URL, mặc định 3600 giây.
supabase secrets set OTA_SIGNED_URL_TTL=3600

# Có verify JWT (mặc định): caller là người dùng đã đăng nhập, không phải AWS.
supabase functions deploy send-ota-command
```

Gọi từ dashboard — đúng **một** trong `device_id` (nút "Cập nhật" một thiết bị)
hoặc `station_id` (nút "Đẩy OTA đến tất cả thiết bị"); truyền cả hai hoặc
không truyền gì đều bị từ chối `need_device_id_or_station_id`, vì đây là thao
tác ghi lên phần cứng thật nên không đoán ý định:

```js
const { data, error } = await supabase.functions.invoke('send-ota-command', {
  body: { release_id: '<uuid firmware_releases>', station_id: '<uuid trạm>' },
});
// → { ok:true, published:2, failed:0, version:'v2.3.1', board:'esp32s3-solgrid', expires_in:3600 }
```

Payload MQTT gửi xuống `solgrid/<thing>/command` (tên trường khớp firmware
`onCommand()`):

```json
{"type":"ota","release_id":"...","board":"esp32s3-solgrid","version":"v2.3.1",
 "url":"https://<ref>.supabase.co/storage/v1/object/sign/firmware/...",
 "sha256":"<64 hex>","size":1048576,"expires_in":3600,"ts":1750000000000}
```

Vài điểm về hành vi:

- **Chỉ thiết bị `type='esp32'`** là đích — inverter/BMS/sensor là thiết bị
  hãng khác, không nói giao thức OTA này.
- **`board` đi kèm để firmware tự từ chối** ảnh build cho board khác. Cloud
  không kiểm được việc này: bảng `devices` chỉ có `type`, không có `board` —
  còn thiết bị thì biết chắc chắn nó là board gì. Cùng nguyên tắc "thiết bị là
  nguồn sự thật" như SoftAP (mục 9). **Firmware bắt buộc phải kiểm** trường
  này, nếu không nạp nhầm ảnh khác board là mất board (chỉ còn cứu bằng
  rollback).
- **Publish lỗi từng phần**: chỉ thiết bị mà lệnh thật sự tới được AWS mới bị
  đánh `fw_status='pending'`; thiết bị lỗi giữ nguyên trạng thái cũ và tên nó
  nằm trong `failed_devices` của response. Tất cả đều lỗi → 502.
- **Signed URL hết hạn** trước khi thiết bị tải xong (mạng yếu, hoặc thiết bị
  offline lúc publish rồi lên mạng muộn) → thiết bị báo `fw_status='failed'`;
  đẩy lại là có URL mới. Giống `send-load-command`, QoS 1 **không** đảm bảo
  thiết bị đang offline sẽ nhận được lệnh sau.
- Đẩy lại cùng một bản cho thiết bị đang `pending` được phép — hữu ích khi
  thiết bị lỡ mất bản tin trước.
- Ghi `fw_target_id`/`fw_status` dùng **service role** (bảng `devices` không có
  policy update cho client — 0003). Nếu bước ghi này lỗi mà lệnh đã publish
  xong, function vẫn trả `ok:true` kèm `status_write_failed`: lệnh đã rời khỏi
  cloud rồi, báo lỗi cứng sẽ khiến UI hiểu nhầm là chưa đẩy gì.
- Signed URL tạo bằng **user client** chứ không phải service role: policy
  `firmware_objects_select_own` đã đủ quyền, không cần nâng đặc quyền. Lỗi ở
  bước này gần như luôn là object đã bị xoá khỏi bucket trong khi hàng
  `firmware_releases` vẫn còn (mục 10.4) → `release_object_missing`.

### 10.6 Thiết bị báo ngược — `ingest-telemetry`

Chiều về khép kín vòng lặp: thiết bị báo phiên bản nó **thực sự đang chạy** và
tiến trình nạp, ngay trong bản tin telemetry bình thường (không cần function
riêng, không cần deploy gì thêm — `ingest-telemetry` đã xử lý sẵn):

```json
{"client_id":"solgrid-esp32-01","solar_kw":2.1,
 "fw_version":"v2.3.1",                    // gửi sau mỗi lần (re)connect
 "fw_status":"downloading","fw_status_detail":"v2.3.1",
 "fw_progress":42}                          // số nguyên 0..100 khi đang nạp
```

Cả bốn trường đều **tuỳ chọn** và ghi vào `devices` chứ không vào `telemetry` —
giá trị gần như không đổi, nhân bản vào mọi hàng time-series là lãng phí (cùng
lý do với `ap_ssid`, mục 9). Đây là đường ghi **duy nhất** cho các cột này:
`devices` không có policy update cho client, nên người dùng không thể tự khai
thiết bị của mình đã lên bản mới.

Quy tắc xử lý:

- **`fw_version`** chỉ ghi khi **khác** giá trị cũ — thiết bị publish lại phiên
  bản sau mỗi lần reconnect, ghi mỗi lần là thừa. Nhờ vậy `fw_reported_at` mang
  nghĩa "bản này bắt đầu chạy lúc nào", chứ không trùng lặp với `last_seen_at`.
  Chuỗi rỗng hoặc dài quá 64 ký tự bị bỏ qua kèm cảnh báo trong log.
- **`fw_status`** chỉ nhận `idle | downloading | applying | success | failed`.
  **`pending` cố tình không cho thiết bị khai** — đó là trạng thái do
  `send-ota-command` đặt, nghĩa là "cloud đã gửi lệnh nhưng thiết bị chưa lên
  tiếng"; cho thiết bị tự đặt lại thành `pending` là để nó xoá bằng chứng rằng
  nó chưa từng nhận bản cập nhật. Giá trị lạ bị bỏ qua kèm cảnh báo.
- **`fw_status_detail`** luôn được ghi đè (hoặc xoá về null) cùng với
  `fw_status`, cắt còn 200 ký tự. Nếu không, lý do của lần hỏng cũ sẽ nằm lại
  bên cạnh một trạng thái `downloading` mới và gây hiểu nhầm.
- **`fw_progress`** là số nguyên `0..100`, lưu ở snapshot `devices` thay vì bảng
  time-series. `send-ota-command` đặt `0` cho lần đẩy mới; firmware báo theo số
  byte đã tải/ghi; `applying` và `success` được chuẩn hoá thành `100`. Giá trị
  ngoài miền bị bỏ qua nhưng phần telemetry hợp lệ còn lại vẫn được ghi nhận.
- **Suy ra `success`**: firmware tối giản có thể chỉ báo `fw_version` mà không
  bao giờ báo `fw_status`. Nếu phiên bản vừa nhận **đúng bằng** phiên bản của
  bản đã đẩy (`fw_target_id`) trong khi trạng thái vẫn dang dở, function tự
  đánh `success` — nếu không `fw_status` sẽ kẹt ở `'pending'` vĩnh viễn. Việc
  tra bảng `firmware_releases` chỉ xảy ra khi đang có OTA dở dang, không đụng
  vào đường telemetry thường.
- **`fw_target_id` không bị xoá** sau khi nạp xong: nó ghi lại bản đã đẩy, và
  dashboard so nó với `fw_version` để phân biệt "đã nạp xong" với "thiết bị lờ
  lệnh đi". Cùng nguyên tắc `desired_state` ↔ `reported_state` của điều khiển
  tải (mục 6).
- Payload rác **không làm hỏng cả bản tin**: telemetry đã ghi xong và quan
  trọng hơn, nên trường firmware sai chỉ đáng một dòng log, không phải 500.

### 10.7 Firmware

Đã làm trong `firmware/esp32s3.ino`. Ba việc cần làm
trước khi nạp:

1. **Partition Scheme** (Tools → Partition Scheme) phải có **hai** phân vùng
   app. Sơ đồ **mặc định đã đạt** (`app0`/`app1`, mỗi cái 1.25 MB) — chỉ cần
   tránh "Huge APP (3MB No OTA)" vốn chỉ có một app partition, khi đó
   `Update.begin()` luôn thất bại và thiết bị báo `detail=no_space`.
2. URL tải thuộc **Supabase Storage**, không thuộc AWS IoT, nên **không dùng
   `AWS_ROOT_CA`/`AmazonRootCA1.pem`** cho HTTP OTA. Có thể khai báo
   `OTA_DOWNLOAD_ROOT_CA` trong `secrets.h` để ghim CA của endpoint Storage.
   Nếu không khai báo, transport TLS không ghim CA nhưng firmware vẫn bắt buộc
   kiểm SHA-256 của toàn bộ ảnh với hash nhận qua AWS IoT mutual-TLS trước khi
   kích hoạt. Chế độ này tránh hỏng OTA khi signed URL redirect qua hostname có
   chuỗi CA khác.
3. **Tăng `FW_VERSION`** trong `secrets.h` mỗi lần build một bản mới, và chuỗi đó
   phải **trùng** `version` của hàng `firmware_releases` khi tải lên (mục 10.3).
   Cloud so hai chuỗi để biết thiết bị đã nạp xong chưa.

Nếu thiết bị đang chạy bản firmware cũ chưa có luồng HTTPS OTA hiện tại (ví dụ
bản còn dùng nhầm `AWS_ROOT_CA` cho URL Supabase), phải nạp bản sửa qua USB một
lần. Không thể dùng chính downloader lỗi để tự tải bản vá. Sau khi thiết bị đã
chạy bản sửa, hãy build một version mới khác (release đã tạo là bất biến) rồi
kiểm tra cập nhật OTA từ bản đang chạy sang version mới đó.

Luồng khi nhận lệnh `{type:"ota"}`:

```
onCommand()  ── kiểm board ─▶ khác FW_BOARD        → failed / board_mismatch
             ── kiểm version ▶ trùng FW_VERSION    → success / already_running
             ── ghi nhận job, báo 'downloading'
                     │  (KHÔNG tải trong callback — xem bên dưới)
loop()  ── runOtaUpdate()
             ├─ GET signed URL qua HTTPS (theo redirect)
             ├─ đối chiếu Content-Length với `size` trong lệnh
             ├─ Update.begin() → vừa ghi flash vừa băm SHA-256
             │                    └─ báo fw_progress 0..100 (có giới hạn tần suất)
             ├─ hash khớp?  không → Update.abort()  → failed / sha_mismatch
             └─ Update.end(true) → 'applying' → ESP.restart()
                     │
             bản mới boot → báo fw_version → cloud suy ra 'success' (mục 10.6)
```

Vài điểm đáng lưu ý về cách hiện thực:

- **Không tải trong callback MQTT.** Callback chạy bên trong `mqtt.loop()`;
  một lần tải vài MB mất hàng chục giây sẽ chặn keepalive và làm đứt phiên
  MQTT giữa chừng. Callback chỉ ghi nhận job, `loop()` mới tải.
- **Cũng không publish trong callback.** PubSubClient dùng **chung một buffer**
  cho gói vào và gói ra, publish tại đó sẽ ghi đè lên chính payload đang đọc
  dở. `setFwStatus()` chỉ ghi nhận, `flushFwStatus()` ngay sau `mqtt.loop()`
  mới gửi.
- **Buffer MQTT nâng lên 1536 byte** (trước là 640). Chiều **nhận** mới là
  chiều quyết định: lệnh OTA mang signed URL ~450 ký tự nên gói vào chạm
  ~800 byte — nhỏ hơn thì PubSubClient **lặng lẽ bỏ gói** và lệnh "Đẩy OTA"
  không bao giờ tới nơi.
- **Ghi flash trước, kiểm hash sau** là an toàn: ảnh đã ghi không được boot cho
  tới khi phân vùng được đánh dấu, nên hash sai thì `Update.abort()` bỏ luôn và
  thiết bị vẫn chạy bản cũ.
- **Vì sao chỉ hash là đủ**: chuỗi `sha256` tới qua MQTT trên kênh mutual-TLS
  X.509 với AWS IoT — kênh đã xác thực. Kẻ can thiệp đường tải HTTPS không thể
  đổi nội dung ảnh mà vẫn khớp hash đó.
- **Chặn vòng lặp reboot**: lệnh đẩy lại đúng bản đang chạy trả về ngay
  `success / already_running` thay vì tải rồi khởi động lại vô tận.

**Giới hạn của rollback tự động.** `esp_ota_mark_app_valid_cancel_rollback()`
được gọi sau khi nối lại được AWS IoT (tức WiFi + TLS + cert + MQTT đều còn
chạy trên bản mới), nhưng nó **chỉ thực sự có tác dụng khi ảnh được build với
`CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE`** — Arduino-ESP32 **không** bật mặc
định. Không bật thì lệnh đó vô hại nhưng cũng vô tác dụng: một ảnh hợp lệ
nhưng hỏng logic (ví dụ sai SSID) sẽ ở lại cho tới khi nạp tay qua USB. Chốt
chặn luôn hoạt động là kiểm SHA-256 trước khi kích hoạt phân vùng — ảnh tải
lỗi thì không bao giờ được boot.

**Dung lượng.** Bản build kiểm chứng hiện tại chiếm khoảng **84%** phân vùng
app 1.25 MB (1,105 KB / 1,311 KB), còn khoảng 200 KB dư. Đây là tổng của
firmware, OTA và dashboard cục bộ; cần kiểm tra lại kích thước sau khi thêm
tính năng (nhất là trang web cục bộ ở mục 9.2).

### 10.8 Giao diện — DevConsole → Quản lý Firmware MCU

Ba khối, đúng ba đường dữ liệu khác nhau (`src/lib/firmware.js` +
`src/pages/DevConsole.jsx`):

1. **Thiết bị** — đọc thẳng `devices` (RLS select-own). Hiện `fw_version` thiết
   bị tự báo, huy hiệu `fw_status`, `fw_progress` và `fw_status_detail` đã dịch
   sang tiếng Việt (`sha_mismatch` → "hash không khớp, file tải về hỏng";
   `http_403` → "link tải đã hết hạn"; `https_connection_failed`/`http_-1` →
   "không kết nối được HTTPS tới Storage"). Khi `fw_target_id` trỏ tới bản khác với `fw_version`,
   hàng thiết bị hiện thêm dòng "Đã đẩy vX — thiết bị chưa xác nhận": đó chính
   là tín hiệu nạp hỏng ở mục 10.6, cố tình không rút gọn thành "đã cập nhật".
   `<select>` chọn bản + nút "Đẩy OTA đến tất cả thiết bị" (`station_id`) và
   nút "Cập nhật" từng dòng (`device_id`) — đúng hai nhánh của
   `send-ota-command`. Chỉ liệt kê thiết bị `type='esp32'`, khớp bộ lọc của
   chính function.

2. **Tải bản firmware mới lên** — kéo-thả hoặc chọn `.bin`; SHA-256 tính **tại
   trình duyệt** từ đúng bytes sắp gửi (Web Crypto ⇒ cần HTTPS hoặc
   localhost), rồi upload vào bucket `firmware` với
   `contentType: 'application/octet-stream'` và insert `firmware_releases`.
   Hai bước không nguyên tử: nếu insert lỗi (trùng board+version...), object
   vừa tải lên được xoá lại ngay để không thành mồ côi (mục 10.4). Ô **Board**
   mặc định là `esp32s3-solgrid` nhưng có thể đổi theo loại firmware. Board là
   mã loại firmware, không phải tên hiển thị của thiết bị (ví dụ `YoloUno`).
   **Phiên bản** tự gợi ý từ tên file nhưng vẫn phải soát — hai chuỗi phải
   trùng `FW_BOARD`/`FW_VERSION` trong `secrets.h` của bản build.

3. **Bản phát hành** — catalog thật. Bấm một hàng để chọn bản sẽ đẩy;
   **rollback = chọn một bản cũ hơn rồi bấm "Cập nhật"**, không có nút riêng vì
   không cần. Huy hiệu "Đang chạy" so theo `devices.fw_version` (thiết bị báo
   về) chứ không theo bản cloud đã gửi lệnh. Nút "Xoá" xoá **file trong bucket
   trước, hàng sau** — đúng thứ tự bắt buộc ở mục 10.4.

Vài điểm về hành vi:

- **Vẫn poll trong lúc nạp, dù `devices` đã có realtime (0028).** Sau khi đẩy,
  trang poll lại 5 giây một lần *chỉ khi* có thiết bị đang ở
  `pending`/`downloading`/`applying`, và tối đa 5 phút mỗi lần đẩy: thiết bị
  offline lúc publish sẽ kẹt ở `pending` vô hạn (QoS 1 không giao lại), nên vòng
  poll phải có hạn. Giữ lại vòng poll này vì nó không phụ thuộc vào việc kênh
  realtime có sống hay không ở đúng lúc quan trọng nhất — đang nạp firmware.
- **"Đã gửi lệnh" ≠ "đã nạp xong".** Thông báo sau khi đẩy chỉ nói số thiết bị
  mà lệnh tới được AWS (kèm tên những thiết bị publish lỗi từ `failed_devices`).
  Xác nhận nạp xong chỉ đến từ `fw_version` thiết bị báo về.
- **Không có "Tự động cập nhật OTA khi có bản mới".** Switch này từng có trong
  bản demo nhưng đã gỡ: không có gì ở server thực hiện nó, và tự đẩy firmware
  lên phần cứng thật mà không ai bấm là hành vi không nên có mặc định.
