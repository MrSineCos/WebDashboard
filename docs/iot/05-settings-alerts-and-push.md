# Cài đặt hệ thống, cảnh báo và thông báo đẩy

> [← Quay lại mục lục IoT](../IOT.md)

## 13. Múi giờ của trạm & đơn vị năng lượng (Cài đặt → Hệ thống)

Hai tuỳ chọn hiển thị, migration `0021_station_prefs.sql` và
`0022_energy_rpc_timezone.sql`.

**`stations.timezone`** (mặc định `Asia/Ho_Chi_Minh`) — nằm trên `stations`
chứ không phải `station_settings` vì đây là nơi lắp đặt vật lý của trạm, cùng
loại thông tin với `name`/`location` và cùng nằm trên form "Thông tin trạm".

**`user_settings.energy_unit`** (`kWh` | `Wh`) — nằm trên `user_settings` chứ
không theo trạm: đây thuần là gu đọc số của người xem, ai theo dõi nhiều trạm
cũng muốn một đơn vị nhất quán. Chỉ đổi CÁCH HIỂN THỊ; mọi công thức (EFC, RPC
năng lượng, ETA) vẫn luôn làm việc bằng kWh. Điểm đổi duy nhất là
`fmtEnergy()` trong `lib/stations.js`.

### 13.1 Múi giờ phải áp dụng ở cả hai tầng

Định dạng để hiển thị thì chỉ cần truyền `timeZone` cho `toLocaleString`.
Nhưng chỗ dễ sót là tầng **gom nhóm** — "hôm nay bắt đầu từ lúc nào", "bản tin
này rơi vào giờ nào", "khung 14 ngày gồm những ngày nào". `Date.getHours()` /
`getDate()` luôn trả lời theo múi giờ TRÌNH DUYỆT, nên nếu chỉ sửa tầng hiển
thị thì trạm đặt ở Tokyo sẽ có nhãn trục ghi giờ Tokyo trong khi các cột lại
gom theo giờ Việt Nam — lệch đúng 2 giờ mà không có dấu hiệu gì trên giao diện.

Client: mọi phép tính theo lịch đi qua `lib/time.js`
(`tzIsoDate` / `tzHour` / `tzStartOfDay` / `tzDayWindow`), không dùng
`getHours()`/`getDate()`/`toISOString().slice(0,10)` trực tiếp nữa.

Server: hai RPC năng lượng nhận thêm tham số `p_tz`:

```
station_daily_energy(p_station_id uuid, p_days int, p_tz text default 'Asia/Ho_Chi_Minh')
station_hourly_energy(p_station_id uuid, p_day date, p_tz text default 'Asia/Ho_Chi_Minh')
```

`p_day` và `p_tz` phải cùng một múi giờ — RPC vừa lọc theo ngày vừa chia giờ
bằng `p_tz`, hai bên lệch nhau sẽ trả về 0 dòng hoặc dữ liệu của ngày kề.

### 13.2 Áp migration — bắt buộc trước khi deploy client

Supabase → SQL Editor, dán nội dung `0021` rồi `0022` (0022 drop + tạo lại hai
hàm nên phải chạy **sau** 0020).

Giá trị mặc định của `p_tz` là để bản dựng client **cũ** (chưa truyền tham số)
chạy tiếp bình thường — nó **không** giúp client mới chạy trên database cũ.
`stations.timezone` luôn có giá trị nên client mới luôn gửi `p_tz`, mà
PostgREST tìm hàm theo đúng bộ tham số: gọi bản RPC 2 tham số kèm `p_tz` sẽ
trả lỗi `Could not find the function public.station_daily_energy(...)`.

Triệu chứng khi quên chạy 0022: trang Báo cáo hiện đủ khung ngày nhưng mọi cột
đều bằng 0 và biểu đồ theo giờ báo "Chưa có dữ liệu telemetry cho ngày này",
còn ô "Sản lượng hôm nay" trên Dashboard đứng ở "Chưa có sản lượng hôm nay".

## 14. Hệ thống cảnh báo (Dashboard → Cảnh báo)

Migration `0023_alerts.sql`. Trước đó mục "Cảnh báo" tự dựng danh sách ở client
từ mỗi `stations.status`, nên chỉ có hai loại — và loại `warning` không bao giờ
xảy ra vì **không có gì trong database từng đặt `status = 'warning'`**. Thẻ
"Ngưỡng cảnh báo" ở Cài đặt là ba ô `defaultValue` và một nút không có `onClick`.

### 14.1 Mô hình: một hàng = một ĐỢT, không phải một lần vượt ngưỡng

Firmware publish 10 giây/lần, nên nếu mỗi bản tin quá nhiệt sinh một hàng thì
một giờ sự cố = 360 hàng nói đúng một việc. Thay vào đó mỗi đợt cảnh báo mở ra
một lần (`started_at`), sống suốt thời gian điều kiện còn đúng, rồi đóng lại
(`resolved_at`). `resolved_at is null` = đang diễn ra.

Bất biến "mỗi trạm tối đa một đợt đang mở cho mỗi loại" là một **chỉ số unique
một phần** (`alerts_open_per_kind_idx`), không phải một quy ước mà mọi chỗ ghi
phải tự nhớ — `raise_alert` dùng chính chỉ số đó cho `ON CONFLICT ... DO NOTHING`.

`DO NOTHING` chứ không `DO UPDATE` là có chủ đích: cập nhật `value` theo từng
bản tin sẽ sinh 6 UPDATE/phút, mỗi UPDATE là một sự kiện realtime bắn xuống mọi
trình duyệt đang mở. Một đợt kéo dài cả ngày vẫn chỉ tốn hai lượt ghi.
Đổi lại, `value`/`threshold` là số đo **lúc mở đợt** — giá trị hiện tại thì
Dashboard đã hiển thị realtime ở các ô thông số rồi.

### 14.2 Ba nguồn kích hoạt

| Nguồn | Chạy ở đâu | Loại cảnh báo |
|---|---|---|
| `evaluate_station_alerts()` | trong `apply_telemetry`, mỗi bản tin | `undervoltage`, `overtemp`, `overload`, `low_battery`, `charge_blocked`, `discharge_blocked` |
| `mark_stale_offline()` | pg_cron, mỗi phút | `offline` |
| `apply_telemetry` | bản tin quay lại | đóng `offline` |

Mất kết nối **phải** phát hiện từ job theo lịch: theo đúng định nghĩa thì lúc đó
không có bản tin nào tới, nên không trigger telemetry nào chạy.

**Chống rung (hysteresis)** ở mọi ngưỡng — điện áp dao động quanh đúng 46 V sẽ
mở/đóng cảnh báo mỗi 10 giây nếu chỉ so sánh thuần:

| Loại | Mở khi | Đóng khi |
|---|---|---|
| `undervoltage` | `V < minVoltage` | `V >= minVoltage + 1` |
| `overtemp` | `T > maxTempC` | `T <= maxTempC − 2` |
| `overload` | `kW > maxLoadKw` | `kW <= maxLoadKw × 0.95` |
| `low_battery` | `SOC < minSoc` | `SOC >= minSoc + 5` |

Nằm giữa hai mốc = giữ nguyên trạng thái hiện tại. Số đo `null` (trạm không gắn
cảm biến nhiệt) thì **bỏ qua hoàn toàn**, không mở mà cũng không đóng đợt đang
mở — mất cảm biến không phải bằng chứng đã hết quá nhiệt.

`charge_blocked` không chống rung vì đó là trạng thái relay do chính firmware
báo (mục 8), nó đã tự trễ trước khi đóng cắt. `protect_reason = 'full'` **không**
phải sự cố: pin đầy thì ngắt sạc là đúng chức năng.

### 14.3 Ngưỡng nằm ở đâu

`station_settings.alert_thresholds` (jsonb) giữ `minVoltage` / `maxTempC` /
`maxLoadKw`. Theo trạm chứ không theo tài khoản: pack 48V và pack 24V có ngưỡng
điện áp thấp khác hẳn nhau. **Giá trị `null` = tắt kiểm tra đó**, khác với "chưa
cấu hình" — vì vậy client không được `?? <số mặc định>` từng khoá, làm vậy sẽ
bật lại đúng kiểm tra người dùng vừa tắt.

`maxLoadKw` **lưu bằng kW** dù ô nhập ở Cài đặt ghi "Tải tối đa (W)" và mọi con
số công suất trên giao diện đều là W: Dashboard.jsx quy đổi ngay tại ô đó (hiện
`×1000`, lưu `÷1000`). Đổi đơn vị của chính khoá này thì phải migrate dữ liệu
của mọi trạm đang chạy, và bản client cũ nào còn mở sẽ ghi đè lại bằng kW — lệch
1000 lần theo cả hai chiều. Vì vậy phép so sánh trong `evaluate_station_alerts`
vẫn chạy bằng kW (bảng 14.2), chỉ **câu chữ** của cảnh báo `overload` in ra W
(0032) để không nói khác thẻ "Tải tiêu thụ" đứng ngay cạnh nó.

Ngưỡng phần trăm pin **cố ý không nằm ở đây**: nó đã tồn tại và đang chạy thật
ở `battery_modes -> <mode đang chọn> ->> 'minSoc'` (mục 8), và 0018 đã ghi log
theo đúng nguồn đó. Thêm một con số thứ hai cho cùng một khái niệm là tạo hai
nguồn sự thật lệch nhau.

### 14.4 `status = 'warning'` được hồi sinh

`apply_telemetry` không còn đặt cứng `status = 'online'`: trạm có đợt cảnh báo
mở ở mức `warning`/`danger` thì đọc là `'warning'` — đúng giá trị mà 0001 đã cho
phép, `STATION_STATUS_META` đã có sẵn màu, và cho tới nay chưa có gì từng đặt.

Bộ luật chạy **trước** câu UPDATE `stations` để `status` được tính trong cùng
một lượt ghi; đánh giá sau rồi update lần hai sẽ thành hai lượt ghi mỗi 10 giây
và kích hoạt lại toàn bộ chuỗi trigger của 0018/0020.

### 14.5 Kênh gửi

Đã làm xong ở **mục 15** (thông báo đẩy, migration 0024). Hai công tắc
`emailAlerts` và `weeklyReport` đã bị **bỏ hẳn** — dự án không nối dịch vụ gửi
email nào, và một công tắc vĩnh viễn mang nhãn "Chưa khả dụng" chỉ làm dài màn
hình cài đặt chứ không cho người dùng thêm lựa chọn. Migration 0024 mục 1 xoá
luôn hai khoá đó khỏi `notif_prefs`.

Còn lại đúng hai công tắc, cả hai đều có tác dụng thật:

- `push` — mục 15;
- `lowBattery` — tắt đi thì `evaluate_station_alerts` ngừng mở cảnh báo pin yếu
  và đóng đợt đang mở.

### 14.6 Áp migration

Supabase → SQL Editor, dán nội dung `0023_alerts.sql`. Migration tự nạp trạng
thái hiện tại ở mục 9 của file: trạm **đang** offline sẵn sẽ được mở một đợt
`offline`, vì `mark_stale_offline` chỉ khớp `status <> 'offline'` nên không bao
giờ tự phát hiện chúng — không có bước đó thì mục "Cảnh báo" hiện trống trơn
cho đúng những trạm đang hỏng nặng nhất.

Dọn lịch sử dùng chung `log_retention_days` với nhật ký hệ thống (job
`purge-resolved-alerts`, 19:30 UTC). Đợt **đang mở** không bao giờ bị dọn dù kéo
dài bao lâu.

## 15. Thông báo đẩy (Cài đặt → Thông báo)

Cảnh báo của mục 14 chỉ tồn tại **khi có người đang mở dashboard**. Một trạm mất
kết nối lúc 2 giờ sáng thì tới sáng hôm sau mới có ai biết — đó là lỗ hổng thật
của hệ thống cảnh báo, không phải chuyện tiện nghi. Mục này dựng kênh đẩy để
cảnh báo tự tìm đến người dùng.

Chuẩn dùng là **Web Push** (RFC 8291 + VAPID): chạy được ngay trên Chrome/Edge/
Firefox ở cả Android lẫn máy tính, không cần Firebase, không cần app.

### 15.1 Các mảnh ghép

| Mảnh | Ở đâu | Việc |
|---|---|---|
| `push_subscriptions` | `0024_push_notifications.sql` | Một hàng = một trình duyệt đã cho phép |
| `alerts.notified_at` | 0024 mục 3 | Đánh dấu đã báo ra ngoài, chống gửi trùng |
| `dispatch_push()` + trigger + cron | 0024 mục 4–5 | Hai đường kích hoạt Edge Function |
| `send-push` | `supabase/functions/send-push/` | Mã hoá và gửi, dọn đăng ký chết |
| `public/sw.js` | frontend | Service worker hiện thông báo |
| `src/lib/push.js` | frontend | Xin quyền, đăng ký/huỷ, gửi thử |

### 15.2 Vì sao có cột `provider` khi mới chỉ dùng `webpush`

Khi làm app Android, token FCM vào **đúng bảng này** với `provider = 'fcm'` và
`send-push` rẽ nhánh theo cột đó — không phải dựng bảng thứ hai và một đường gửi
thứ hai chạy song song. Một cột text bây giờ rẻ hơn nhiều so với việc tách đôi
về sau, khi đã có dữ liệu thật trong bảng.

### 15.3 Hai đường kích hoạt

**Trigger `alerts_notify_push`** chạy ngay khi một đợt cảnh báo mở. Một hệ thống
cảnh báo mà chờ tới nhịp quét kế tiếp mới báo thì đã mất phần lớn giá trị.

Chi phí thấp vì `alerts` là bảng **đợt**, không phải bảng số đo: `raise_alert`
dùng `ON CONFLICT DO NOTHING` nên bản tin thứ hai trở đi của cùng một sự cố
không chèn hàng nào, và trigger `AFTER INSERT` không chạy khi không có hàng nào
được chèn. Một đợt kéo dài cả ngày vẫn chỉ gọi đúng một lần.

**Cron `dispatch-push`** (mỗi 15 phút) là lưới an toàn: `pg_net` bắn đi rồi thôi,
không biết kết quả. Không có lưới này thì một lần Edge Function hỏng là mất hẳn
thông báo đó, vì trigger không bao giờ chạy lại cho cùng một hàng.

Cảnh báo cũ hơn **30 phút** chỉ được đánh dấu chứ không gửi (`MAX_ALERT_AGE_MS`).
Một thông báo nảy lên lúc 9 giờ sáng về sự cố từ 2 giờ đêm không giúp được gì mà
còn làm người dùng mất tin vào kênh này.

### 15.4 Cài đặt

**Bước 1 — sinh cặp khoá VAPID (chạy đúng một lần cho cả dự án):**

```bash
node tools/vapid-keys.mjs mailto:ban@email.com
```

Chỉ cần Node 18+, không cần Deno và không cài thêm gói nào: VAPID chỉ là một cặp
khoá ECDSA P-256 mà Web Crypto có sẵn trong Node sinh được.

Script **ghi thẳng ra file**, không in chuỗi để copy tay:

- `.env` ← thêm/cập nhật `VITE_VAPID_PUBLIC_KEY` (87 ký tự)
- `.vapid.env` ← `VAPID_KEYS` + `VAPID_SUBJECT`, đã nằm trong `.gitignore`

Đây là chỗ từng hỏng thật: copy một chuỗi base64url 87 ký tự từ terminal rất dễ
đứt giữa chừng khi dòng bị wrap, mà chuỗi cụt vẫn trông "có vẻ đúng" — lỗi chỉ
lộ ra ở trình duyệt dưới dạng `atob: string not correctly encoded`.

Sinh cặp mới về sau sẽ làm chết mọi đăng ký hiện có: trình duyệt gắn đăng ký với
khoá công khai đã dùng lúc `subscribe()`.

**Bước 2 — nạp secret cho Edge Function:**

```bash
npx supabase secrets set --env-file .vapid.env
rm .vapid.env      # xong việc thì xoá, nó chứa khoá RIÊNG

# MAINTENANCE_SHARED_SECRET dùng chung với archive-telemetry (mục 12), nếu đã
# đặt rồi thì bỏ qua.
npx supabase secrets set MAINTENANCE_SHARED_SECRET=...
```

**Bước 3 — build lại.** Vite chỉ đọc `.env` lúc khởi động, nên phải restart dev
server hoặc chạy lại `npm run build`. Bỏ trống khoá cũng không sao: công tắc
hiện mờ kèm ghi chú nói rõ đang thiếu gì, phần còn lại của app không đổi.

**Bước 4 — áp migration.** `npx supabase db push`, hoặc dán
`0024_push_notifications.sql` vào Supabase → SQL Editor.

**Bước 5 — deploy Edge Function:**

```bash
supabase functions deploy send-push --no-verify-jwt
```

`--no-verify-jwt` là **bắt buộc**, cùng lý do với `archive-telemetry`: hàm nhận
hai loại credential (shared secret từ pg_cron, JWT từ nút "Gửi thử") mà cổng Edge
Functions chỉ hiểu được một. Nó tự xác thực bên dưới — request không mang đúng
shared secret hoặc JWT hợp lệ vẫn nhận 401.

**Bước 6 — nạp Vault cho pg_cron/trigger.** Migration `0025_push_vault_secrets.sql`
làm tự động: nó suy hai secret ra từ cặp `archive_telemetry_url/key` mà 0019 đã
nạp (0024 cố ý dùng chung shared secret với archive-telemetry), nên không secret
nào phải nằm trong Git và cũng không phải tra project-ref.

Chỉ khi chưa từng cấu hình `archive-telemetry` thì mới phải tạo tay:

```sql
select vault.create_secret('https://<ref>.supabase.co/functions/v1/send-push',
                           'send_push_url');
select vault.create_secret('<MAINTENANCE_SHARED_SECRET>', 'send_push_key');
```

Đây là bước dễ bỏ sót nhất và bỏ sót nó **không gây lỗi ở đâu cả**:
`dispatch_push()` ghi `raise notice` rồi thoát, cảnh báo vẫn vào database bình
thường, chỉ là không bao giờ đẩy đi. Kiểm tra bằng mục 15.5.

### 15.5 Kiểm thử

1. Mở Cài đặt → Thông báo, bật **"Thông báo đẩy trên thiết bị này"**, cho phép
   khi trình duyệt hỏi.
2. Bấm **"Gửi thông báo thử"** — thông báo phải hiện trong vài giây. Bước này
   kiểm tra đúng chuỗi mà cảnh báo thật sẽ đi qua (Edge Function → push service
   → service worker), nên nó chạy được cả khi không có cảnh báo nào.
3. Thử cảnh báo thật: tắt simulator MQTT (mục 7.1) và chờ `mark_stale_offline`
   mở đợt `offline`.

Kiểm tra đăng ký còn sống:

```sql
select provider, failure_count, last_success_at, left(user_agent, 40)
from push_subscriptions where owner_id = auth.uid();
```

### 15.6 Lỗi thường gặp

- **`Failed to execute 'atob'… string not correctly encoded`.** Khoá trong `.env`
  bị cắt cụt lúc copy. Phải đúng **87 ký tự**; kiểm tra nhanh:
  `node -e "console.log(process.env.X?.length)"` hoặc chỉ cần chạy lại
  `node tools/vapid-keys.mjs` (nay tự ghi file, không còn khâu copy tay). Từ bản
  hiện tại `lib/push.js` bắt lỗi này ngay và nói rõ độ dài đang sai.
- **Yêu cầu HTTPS.** Service Worker và Push API chỉ chạy trên `https://` hoặc
  `http://localhost`. Mở dashboard qua IP LAN (`http://192.168.x.x:5173`) thì
  công tắc báo trình duyệt không hỗ trợ — đó là trình duyệt chặn, không phải lỗi
  của app.
- **Đã lỡ bấm "Chặn".** Ứng dụng không tự mở lại quyền được. Ghi chú dưới công
  tắc chỉ đúng chỗ cần bấm (biểu tượng ổ khoá cạnh thanh địa chỉ).
- **Không nhận được gì mà "Gửi thử" vẫn báo thành công.** Kiểm tra chế độ Không
  làm phiền của hệ điều hành, và trên Android là quyền thông báo của chính trình
  duyệt trong Cài đặt hệ thống.
- **`failure_count` tăng dần.** Push service từ chối. 404/410 thì `send-push` xoá
  hàng ngay; các lỗi khác đủ 5 lần mới bỏ.
