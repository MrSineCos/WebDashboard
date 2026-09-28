# Chẩn đoán thiết bị, nhật ký và lưu trữ

> [← Quay lại mục lục IoT](../IOT.md)

## 11. Chẩn đoán phần cứng (DevConsole → Tổng quan thiết bị)

Ba ô chỉ số ở đầu DevConsole. Trước đây chúng lấy từ hằng số `DIAG_BY_STATUS`
trong `DevConsole.jsx` (chỉ đổi theo status của trạm) dù tiêu đề ghi "thời gian
thực"; migration `0017_device_diagnostics.sql` dựng đường ống thật.

| Ô | Nguồn | Cần firmware mới? |
|---|---|---|
| Thời gian hoạt động | `devices.uptime_s` | Có |
| Số lần khởi động lại | `devices.boot_count` | Có |
| Kết nối MQTT Broker | `devices.status` | Không — đã có sẵn |

**Nhiệt độ MCU đã gỡ hẳn (migration `0029`).** Ô này từng là ô thứ tư, lấy từ
`mcu_temp_c` mà 0017 dựng lên. Nay bỏ ở **mọi tầng**: firmware/simulator không
gửi, `ingest-telemetry` không nhận, `archive-telemetry` không lưu trữ, và hai
cột `telemetry.mcu_temp_c` + `devices.mcu_temp_c` đã bị drop — **lịch sử nhiệt
độ MCU trong `telemetry` mất theo, không hoàn tác được**. Riêng các gói CSV đã
lưu trữ trong bucket thì vẫn còn cột đó bên trong (file tĩnh); nạp lại một gói
cũ phải bỏ cột ra trước. Xem chi tiết ở đầu file `0029_drop_mcu_temp.sql`.

Đi cùng đường với mọi số đo khác, không thêm Edge Function nào:

```
firmware: uptime_s / boot_count kèm MỖI bản tin telemetry
   ▼
ingest-telemetry (chỉ thêm tên vào NUMERIC_FIELDS) → insert telemetry
   ▼
trigger apply_telemetry → snapshot mới nhất lên devices.*  ──▶ DevConsole
```

- **Hai nơi lưu, có chủ đích.** `telemetry` giữ chuỗi thời gian (biết thiết bị
  reboot lúc nào); `devices` giữ snapshot để UI đọc một phát ra giá trị hiện tại
  của từng thiết bị. Trigger `apply_telemetry` vốn đã cập nhật
  `devices.status`/`last_seen_at` mỗi bản tin, nên các phép gán thêm **không tốn
  lượt ghi nào**.
- **Chỉ số là của MỘT thiết bị, không phải của trạm.** Một trạm nhiều ESP32 thì
  mỗi con có uptime riêng — DevConsole hiện `<select>` chọn thiết bị khi trạm có
  >1 ESP32, mặc định lấy con báo dữ liệu gần đây nhất.
- **Firmware cũ vẫn chạy bình thường**: cột null → ô hiện "—" kèm chú thích
  "Thiết bị chưa báo", cố tình không hiện `0` (không phân biệt được "chưa biết"
  với "bằng 0"). Cùng quy ước với `ap_ssid` (mục 9) và `fw_version` (mục 10).
  Firmware chưa nạp lại vẫn gửi `mcu_temp_c` — `IGNORED_FIELDS` trong
  `ingest-telemetry` vứt nó đi thay vì để nó dồn vào cột `extra`.
- **`boot_count` nằm trong NVS** (`Preferences`, namespace `diag`) nên sống qua
  mất điện, và tăng ở ngay đầu `setup()` — để đếm được cả những lần boot rồi
  chết ngay sau đó, vốn là những lần đáng quan tâm nhất.
- **`uptime_s` chống tràn `millis()`**: `millis()` quay vòng sau 49.7 ngày, mà
  trạm điện mặt trời chạy liên tục hàng tháng nên tràn là chuyện chắc chắn xảy
  ra. `uptimeSeconds()` đếm số vòng đã qua, nếu không uptime sẽ tụt về 0 và báo
  sai là thiết bị vừa reboot.
- **Buffer JSON của firmware nâng lên 1024** (trước là 768). Bản tin nặng nhất
  (bản đầu sau reconnect: số đo + chẩn đoán + bảo vệ + AP + firmware) không còn
  vừa 768, mà **ArduinoJson im lặng bỏ trường khi tràn** — thiếu chỗ là mất dữ
  liệu chứ không có lỗi nào báo ra.
- **Cả ba ô cập nhật qua realtime trên `devices`** (migration `0028` +
  subscription trong `useDevices`). Không có nó thì mọi thứ phía server vẫn đúng
  nhưng màn hình đứng ở giá trị lúc mở trang, chỉ F5 mới thấy — trong khi đèn
  trạm ngay bên cạnh (`stations`, realtime từ `0027`) vẫn chuyển xanh, nên rất
  dễ tưởng là lỗi ingest. Xem mục 16.1.

### 11.1 Kiểm thử

Simulator (mục 7.1) đã gửi đủ các trường, nên thử được không cần phần cứng:

```bash
supabase db push                       # 0017 + 0028 (realtime) + 0029 (bỏ mcu_temp_c)
supabase functions deploy ingest-telemetry --no-verify-jwt
supabase functions deploy archive-telemetry --no-verify-jwt
cd tools/mqtt-simulator && python simulate_esp32.py
```

Deploy **cả hai** function sau khi áp 0029: `ingest-telemetry` vì nó còn liệt kê
`mcu_temp_c` trong `NUMERIC_FIELDS` — bản cũ sẽ cố ghi vào cột không còn tồn tại
và **hỏng toàn bộ insert telemetry**, chứ không phải bỏ qua im lặng.

→ DevConsole → Tổng quan thiết bị: uptime tăng dần theo thời gian chạy script,
`boot_count` tăng thêm 1 mỗi lần khởi động lại script (lưu ở
`tools/mqtt-simulator/.boot_count`, đóng vai NVS). Tắt script và chờ 90 giây →
ô MQTT chuyển **Disconnected** (`mark_stale_offline`, mục 0006).

## 12. Nhật ký hệ thống + lưu trữ & dọn dữ liệu

Migration `0018_system_logs.sql` và `0019_telemetry_retention.sql`, Edge
Function `archive-telemetry`, UI ở DevConsole → **Nhật ký hệ thống** và
**Lưu trữ & dọn dữ liệu**.

### 12.1 Vì sao cần

`telemetry` là bảng duy nhất tăng tuyến tính theo thời gian. Firmware publish
~10 giây/lần → 8.640 dòng/ngày/thiết bị, mỗi dòng ~250 byte kể cả hai index
của 0003 → **~2,2 MB/ngày/thiết bị**. Năm thiết bị chạy liên tục chạm hạn mức
500 MB của Supabase free plan sau khoảng sáu tuần — và khi database đầy thì
`ingest-telemetry` bắt đầu lỗi, tức là **mất dữ liệu mới**, không phải dữ liệu cũ.

Nhật ký hệ thống thì ngược lại: chỉ ghi **sự kiện rời rạc**, vài trăm dòng/ngày
cho toàn hệ thống — nhỏ hơn telemetry 20–100 lần.

Storage (1 GB) và database (500 MB) là **hai hạn mức tách biệt**, nên chuyển
dữ liệu cũ sang Storage thực sự giải phóng chỗ chứ không phải chuyển chỗ đau.

### 12.2 Nguồn sinh log

Mỗi dòng có một `source` — nhóm nguồn, cũng là bộ lọc chính trên DevConsole
(0030 mục 1). Bảy nhóm, xếp theo câu hỏi người đọc đang có:

**`alert` — sự cố vận hành** (trigger `alerts_log_opened` / `alerts_log_resolved`,
0030 mục 3). Bắc cầu từ bảng `alerts` (0023), nên mỗi loại cảnh báo sinh đúng
hai dòng cho một đợt: lúc mở và lúc đóng (kèm thời lượng).

| Sự kiện | Mức |
|---|---|
| `alert_offline`, `alert_undervoltage`, `alert_overtemp`, `alert_discharge_blocked` | error |
| `alert_overload`, `alert_low_battery`, `alert_charge_blocked` | warn |
| `alert_<loại>_cleared` | info |

**`device` — kết nối & sức khoẻ thiết bị** (0018 mục 4, 0030 mục 4).

| Sự kiện | Mức |
|---|---|
| `device_offline` | error |
| `device_rebooted` (`boot_count` tăng), `device_removed` | warn |
| `device_online`, `device_registered`, `device_firmware_changed`, `device_ap_changed` | info |

**`control` — điều khiển tải** (0030 mục 6).

| Sự kiện | Mức |
|---|---|
| `load_state_mismatch` (lệnh đi mà relay không đổi sau 2 phút), `load_removed` | warn |
| `load_switched_on` / `load_switched_off`, `load_state_confirmed`, `load_created`, `load_updated` | info |

**`config` — dấu vết kiểm toán cấu hình** (0030 mục 5, 7, 8). Đây là thứ trả
lời "cảnh báo biến mất vì trạm đã hết lỗi, hay vì ai đó vừa nâng ngưỡng?".

| Sự kiện | Mức |
|---|---|
| `retention_changed` (đổi số ngày giữ dữ liệu = xoá dữ liệu), `alert_thresholds_changed`, `station_deleted` | warn |
| `battery_mode_changed`, `battery_thresholds_changed`, `ap_config_changed`, `modules_changed`, `notif_prefs_changed`, `energy_unit_changed`, `station_created`, `station_renamed`, `station_timezone_changed` | info |

**`ingest` — Edge Function nhận telemetry** (`ingest-telemetry`). Ba loại dưới
đây do THIẾT BỊ quyết định tần suất nên đi qua `log_event_throttled` (0030 mục
2) — một firmware hỏng gửi sai mỗi 10 giây vẫn chỉ chiếm một dòng/giờ.

| Sự kiện | Mức |
|---|---|
| `telemetry_insert_failed` (mất dữ liệu mới) | error |
| `telemetry_field_rejected`, `ap_report_rejected`, `fw_report_rejected` | warn |

**`ota` — firmware** (`send-ota-command`, `ingest-telemetry`, 0030 mục 9).

| Sự kiện | Mức |
|---|---|
| `ota_failed` | error |
| `firmware_deleted`, `ota_pushed` (khi có thiết bị không gửi được) | warn |
| `firmware_uploaded`, `ota_pushed`, `ota_success` | info |

**`archive` — lưu trữ & dọn dữ liệu** (`archive-telemetry`,
`purge_telemetry_overdue`).

| Sự kiện | Mức |
|---|---|
| `archive_storage_full`, `archive_upload_failed`, `archive_read_failed`, `archive_record_failed`, `archive_crashed`, `purge_failed`, `telemetry_hard_purge` | error |
| `archive_delete_failed` | warn |
| `archive_completed` / `purge_completed` | info |

Nguyên tắc chung: **chỉ ghi khi trạng thái thực sự đổi**. `apply_telemetry`
chạy mỗi bản tin và luôn đặt `status='connected'`; nếu ghi log mỗi lần chạy thì
một thiết bị sinh 8.640 dòng/ngày — nhật ký sẽ tốn chỗ hơn dữ liệu nó mô tả.
Thiết bị chạy ổn định, không ai chỉnh cấu hình → **0 dòng**.

Hệ quả của nguyên tắc đó với các trigger gắn vào bảng bị ghi mỗi 10 giây
(`devices`, `stations`): hàm phải thoát ra ở dòng đầu tiên khi giá trị không
đổi, **trước** mọi truy vấn. Với các bảng còn lại thì trigger chỉ chạy khi có
người thao tác.

**Vì sao KHÔNG ghi "đã nhận bản tin telemetry" vào đây** (câu hỏi hay quay lại
mỗi khi ai đó mở nhật ký thấy trống trong lúc dữ liệu vẫn về):

1. *Trùng lặp* — bảng `telemetry` chính là nhật ký của việc nhận dữ liệu, đủ
   `ts`, `device_id` và cả giá trị đo.
2. *Bản sao đắt hơn bản gốc* — ~250 byte × 8.640 bản tin/ngày = **2,2 MB/ngày/
   thiết bị**, đúng bằng chi phí của telemetry, tức nhân đôi. Tệ hơn:
   `telemetry` có đường nén + đẩy sang Storage (mục 11), còn `system_logs`
   **chỉ có xoá** (`purge_system_logs`) — không có cách nào giữ lại.
3. *Phá hỏng chính công dụng* — nhật ký dùng được vì nó thưa. 8.640 dòng
   "bình thường" mỗi ngày sẽ chôn mất đúng một dòng `device_offline` cần tìm,
   và làm phân trang vô dụng.

Nhu cầu thật phía sau câu hỏi đó — *"làm sao biết đường ống đang sống?"* —
được đáp bằng **dải trạng thái luồng dữ liệu** ngay trên khung nhật ký ở
DevConsole: đèn xanh/đỏ theo cùng ngưỡng 90 giây của `mark_stale_offline`, mốc
"bản tin gần nhất N giây trước" tự chạy mỗi giây, số bản tin trong một giờ qua
(`useIngestRate` — một truy vấn `count` dùng `telemetry_station_ts_idx`, làm
mới mỗi phút), và số thiết bị online. Không tốn dòng log nào.

Một chốt an toàn ít thấy nhưng bắt buộc: mọi trigger `after delete` đều gọi
`log_target_alive()` trước (0030 mục 2). Trong lượt xoá dây chuyền (xoá trạm
kéo theo thiết bị/tải, xoá tài khoản kéo theo tất cả), hàng cha đã biến mất
trong cùng transaction — ghi một dòng log trỏ tới nó sẽ ném lỗi khoá ngoại và
làm **hỏng cả lượt xoá**.

Cảnh báo pin yếu: từ 0030 nó đi qua đường `alerts` (`alert_low_battery`), không
còn trigger `stations_log_battery_alert` của 0018 nữa — hai đường đọc cùng một
ngưỡng `minSoc` nên giữ cả hai chỉ làm mỗi lần pin yếu chiếm hai dòng. Đổi lại,
tắt công tắc "Cảnh báo pin yếu" ở Cài đặt → Thông báo cũng tắt luôn dòng nhật
ký này (0023 mục 5).

Bảng `system_logs` không có policy insert/update/delete cho client: mọi lượt
ghi đi qua `log_event()` (security definer) hoặc service role. Nhật ký chỉ có
giá trị khi người dùng không tự sửa được nó.

### 12.3 Cấu hình (bắt buộc, nếu không job đêm không chạy)

```bash
supabase db push                                  # áp 0018 + 0019
supabase functions deploy archive-telemetry --no-verify-jwt

SECRET=$(openssl rand -hex 32)
echo "$SECRET"          # GIỮ LẠI chuỗi này — Vault ở bước dưới cần đúng nó
supabase secrets set MAINTENANCE_SHARED_SECRET="$SECRET"
```

`--no-verify-jwt` **bắt buộc**, cùng lý do với `ingest-telemetry`: hàm này nhận
hai loại credential (shared secret từ pg_cron, JWT người dùng từ DevConsole),
mà cổng Edge Functions chỉ hiểu JWT — thiếu cờ này thì cron nhận
`UNAUTHORIZED_INVALID_JWT_FORMAT` trước khi code hàm chạy. Xác thực vẫn đầy đủ,
chỉ là do hàm tự làm (xem đầu file `archive-telemetry/index.ts`).

Đừng chạy `supabase secrets set MAINTENANCE_SHARED_SECRET=$(openssl rand -hex 32)`
một dòng: chuỗi sinh ra không hiện ra đâu cả, mà Vault ở bước sau cần đúng nó,
và Supabase không cho đọc lại giá trị secret (`supabase secrets list` chỉ hiện
digest).

Rồi nạp URL + secret vào Vault để pg_cron gọi được Edge Function (SQL Editor):

```sql
select vault.create_secret(
  'https://<project-ref>.supabase.co/functions/v1/archive-telemetry',
  'archive_telemetry_url');
select vault.create_secret('<MAINTENANCE_SHARED_SECRET vừa tạo>',
  'archive_telemetry_key');
```

Đọc từ Vault chứ không nhúng khoá vào định nghĩa job vì `cron.job` là bảng đọc
được — nhúng vào đó là để lộ khoá cho bất kỳ ai xem được bảng.

Kiểm tra ba job đã lên lịch:

```sql
select jobname, schedule, active from cron.job;
-- archive-telemetry        0 19 * * *   (02:00 giờ VN)
-- purge-system-logs       20 19 * * *
-- purge-telemetry-overdue 40 19 * * *
```

Biến môi trường tuỳ chọn: `ARCHIVE_STORAGE_BUDGET_BYTES` (mặc định 900 MB —
chừa chỗ cho bucket `firmware` và `avatars` trong hạn mức 1 GB).

### 12.4 Luồng lưu trữ

```
telemetry cũ hơn N ngày
   │  (theo từng trạm, dùng index telemetry_station_ts_idx)
   ▼
gom theo THÁNG → CSV → gzip
   ▼
upload → bucket telemetry-archive (private)
   │      <owner_id>/<station_id>/YYYY-MM/part-<epoch>-<rows>.csv.gz
   ▼
insert telemetry_archives (sổ theo dõi)
   ▼
delete_telemetry_rows(ids)   ← CHỈ những dòng đã lên Storage
```

**Thứ tự tải lên trước, xoá sau là điểm quan trọng nhất.** Nếu bước xoá hỏng,
lần chạy sau lưu trữ lại đúng những dòng đó thành gói thứ hai — thừa dữ liệu
trong kho lạnh, chứ không mất. Đảo thứ tự thì một lỗi mạng giữa chừng là mất hẳn.

Một tháng có thể gồm **nhiều gói**: mỗi lượt chỉ xử lý một lô có giới hạn
(20.000 dòng, tối đa 200.000 dòng hoặc 100 giây mỗi lần gọi). Ghép thành một
file/tháng sẽ phải tải file cũ về, giải nén, nối, nén lại — với gói vài chục MB
là hết bộ nhớ Edge Function.

### 12.5 Hai cơ chế an toàn

**Hết chỗ Storage** → dừng lưu trữ và **không xoá gì cả**, ghi log `error`.
Xoá mà không lưu được chính là thứ người dùng đã tắt khi bật chế độ lưu trữ.

**Lưới an toàn `purge_telemetry_overdue`** → nếu đường lưu trữ chết (chưa
deploy, secret sai, Storage đầy), telemetry cũ hơn **hạn giữ + 30 ngày ân hạn**
vẫn bị xoá, kèm log `error` mỗi lần. Đánh đổi có chủ đích: 30 ngày là quãng để
nhận ra và sửa (log hiện ngay trên DevConsole), còn để database đầy thì mất
toàn bộ dữ liệu đang tới. Muốn giữ lâu hơn thì tăng `p_grace_days` khi lên lịch
lại job.

### 12.6 Kiểm thử

```bash
supabase db push
supabase functions deploy archive-telemetry
```

1. DevConsole → **Lưu trữ & dọn dữ liệu**: đặt "Giữ telemetry trong" = 7 ngày,
   bật "Nén và lưu lên Storage", **Lưu cài đặt**.
2. Bấm **Chạy dọn ngay**. Chưa có dữ liệu quá 7 ngày → "Không có bản ghi nào
   quá hạn". Muốn thử thật, chèn dữ liệu cũ:
   ```sql
   insert into public.telemetry (device_id, station_id, owner_id, ts, solar_kw, battery_pct)
   select device_id, station_id, owner_id, now() - interval '40 days', 1.5, 70
   from public.telemetry limit 1;
   ```
3. Bấm lại **Chạy dọn ngay** → hiện số bản ghi đã nén + gói xuất hiện trong
   "Gói đã lưu trữ", tải về giải nén ra CSV đọc được.
4. **Nhật ký hệ thống** có dòng `INFO … Đã nén và lưu trữ …`.
5. Tắt simulator, chờ 90 giây → nhật ký có dòng `ERROR Mất kết nối MQTT với …`;
   bật lại → `INFO … kết nối MQTT thành công`.

### 12.7 Lỗi thường gặp

| Hiện tượng | Nguyên nhân |
|---|---|
| Nhật ký trống dù thiết bị đang chạy | Đúng như thiết kế — chỉ ghi khi trạng thái đổi. Tắt simulator 90 giây để thấy dòng đầu tiên. |
| Log mới không tự hiện, phải F5 | Bảng chưa vào publication realtime: `alter publication supabase_realtime add table public.system_logs;` (cùng lỗi với `telemetry`/`loads` — xem mục 16) |
| "Chạy dọn ngay" lỗi 401/404 | Chưa `supabase functions deploy archive-telemetry --no-verify-jwt`. |
| `net._http_response` trả 401 `UNAUTHORIZED_INVALID_JWT_FORMAT` | Deploy thiếu `--no-verify-jwt` — cổng chặn shared secret vì nó không phải JWT. Deploy lại kèm cờ đó. |
| `net._http_response` trả 401 `{"error":"unauthorized"}` | Đây là hàm từ chối (không phải cổng): chuỗi trong Vault lệch với `MAINTENANCE_SHARED_SECRET`. Đặt lại cả hai nơi. |
| Job đêm không chạy nhưng nút bấm tay chạy được | Chưa nạp secret vào Vault (mục 12.3) — nút bấm tay dùng JWT người dùng, không cần Vault. |
| Log `archive_storage_full` | Storage đã dùng >900 MB. Xoá bớt gói cũ trong "Gói đã lưu trữ". |
| Log `telemetry_hard_purge` | Lưới an toàn đã phải xoá dữ liệu chưa lưu trữ được — đường lưu trữ đang hỏng, sửa ngay. |
