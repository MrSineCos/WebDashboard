# SolGrid IoT — kết nối thiết bị thật (AWS IoT Core → Supabase)

Tài liệu này mô tả cách đưa dữ liệu ESP32 thật vào SolGrid.

## Luồng dữ liệu

```
ESP32 ──MQTT/TLS + X.509 cert──▶ AWS IoT Core ──Rule + HTTPS action──▶ Supabase Edge Function
   (mỗi thiết bị 1 cert)          (broker + auth + rules)  (Bearer secret)   ingest-telemetry
                                                                                   │ service role
                                                                                   ▼
                                     insert telemetry → trigger cập nhật stations + devices
                                                                                   │ RLS (auth.uid)
                                                                                   ▼
                                                                     React dashboard đọc dữ liệu thật
```

Hai tầng xác thực:
1. **Thiết bị ↔ AWS IoT Core**: X.509 mutual TLS, mỗi thiết bị một cert riêng.
2. **AWS IoT Rule ↔ Edge Function**: header `Authorization: Bearer <INGEST_SHARED_SECRET>`.

## 1. Cơ sở dữ liệu

Áp các migration `supabase/migrations/0003_devices_telemetry.sql` và
`0010_loads.sql`:

```bash
supabase db push          # hoặc `supabase db reset` khi dev local
```

Bảng: `devices` (ánh xạ 1 thiết bị ↔ 1 AWS "thing"), `telemetry` (time-series),
`loads` (tải người dùng thêm/xóa ở Dashboard → Điều khiển tải, mỗi tải có
thể gắn `device_id` là ESP32 phụ trách đóng/cắt nó).
RLS trên `devices`/`telemetry` chỉ cho **SELECT** theo `owner_id = auth.uid()`;
mọi ghi đi qua service role. `loads` thì khác — người dùng CRUD trực tiếp
(thêm/xóa/đổi tên/đặt `desired_state`) vì đó là cấu hình của họ; chỉ riêng
`reported_state`/`reported_at` (thiết bị thật sự xác nhận) bị khoá, chỉ
service role ghi được (trigger `loads_protect_reported_columns`).

## 2. Đăng ký thiết bị trong Supabase

Mỗi thiết bị cần một hàng trong `devices`, với `aws_thing_name` **trùng** client id sẽ dùng ở AWS.

**Cách khuyến nghị:** DevConsole → *Quản lý trạm* → chọn trạm → *+ Thêm thiết bị*.
Form này gọi RPC `register_device` (migration `0008_register_device_rpc.sql`),
tự kiểm tra bạn là chủ trạm nên không cần service role. Trang này cũng hiện
sẵn `station-uuid`/`owner-uuid` (có nút copy) nếu bạn cần dùng cho SQL thủ công.

Cách thủ công (fallback, chạy với service role / SQL editor):

```sql
insert into public.devices (station_id, owner_id, name, type, aws_thing_name)
values (
  '<station-uuid>',                       -- trạm thiết bị thuộc về
  '<owner-uuid>',                         -- = stations.owner_id của trạm đó
  'ESP32 Trạm 01', 'esp32',
  'solgrid-esp32-01'                      -- = AWS thing name / MQTT client id
);
```

## 3. Deploy Edge Function

```bash
# Secrets (KHÔNG để trong .env frontend):
supabase secrets set INGEST_SHARED_SECRET="$(openssl rand -hex 32)"
# SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY được nạp tự động trên nền tảng hosted.

# Deploy — tắt verify JWT vì caller là AWS, không phải user Supabase:
supabase functions deploy ingest-telemetry --no-verify-jwt
```

URL sau khi deploy: `https://<project-ref>.functions.supabase.co/ingest-telemetry`.

Test nhanh (giả lập AWS gọi):

```bash
curl -X POST "https://<project-ref>.functions.supabase.co/ingest-telemetry" \
  -H "Authorization: Bearer <INGEST_SHARED_SECRET>" \
  -H "content-type: application/json" \
  -d '{"client_id":"solgrid-esp32-01","solar_kw":2.1,"battery_pct":80,"battery_voltage":48.5}'
# → {"ok":true}; sai secret → 401; client_id lạ → 403
```

## 4. Cấu hình AWS IoT Core

### 4.1 Policy

Tạo IoT policy `solgrid-device-policy` cho phép connect + publish topic riêng của mỗi thiết bị:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "iot:Connect",
      "Resource": "arn:aws:iot:<region>:<account>:client/${iot:Connection.Thing.ThingName}" },
    { "Effect": "Allow", "Action": "iot:Publish",
      "Resource": "arn:aws:iot:<region>:<account>:topic/solgrid/*/telemetry" },
    { "Effect": "Allow", "Action": ["iot:Subscribe", "iot:Receive"],
      "Resource": [
        "arn:aws:iot:<region>:<account>:topicfilter/solgrid/${iot:Connection.Thing.ThingName}/command",
        "arn:aws:iot:<region>:<account>:topic/solgrid/${iot:Connection.Thing.ThingName}/command"
      ]
    }
  ]
}
```

Hai dòng cuối cho phép mỗi thiết bị subscribe **đúng topic lệnh của chính
nó** (`solgrid/<thing-name>/command`) — cần cho mục 6 "Điều khiển tải".

### 4.2 Provisioning mỗi thiết bị

Trên AWS Console (IoT Core → Manage → Things) hoặc CLI:

```bash
aws iot create-thing --thing-name solgrid-esp32-01
aws iot create-keys-and-certificate --set-as-active \
  --certificate-pem-outfile cert.pem \
  --public-key-outfile pub.key --private-key-outfile priv.key
aws iot attach-policy --policy-name solgrid-device-policy --target <cert-arn>
aws iot attach-thing-principal --thing-name solgrid-esp32-01 --principal <cert-arn>
```

Hoặc chạy 1 lệnh bằng `tools/mqtt-simulator/provision_device.py` (tạo thing
nếu chưa có, tạo policy nếu chưa có, luôn tạo **cert mới** và gắn vào thing —
kể cả khi thing đã tồn tại từ trước và bạn chỉ mất private key cũ):

```bash
cd tools/mqtt-simulator
pip install -r requirements.txt
python provision_device.py --thing-name solgrid-esp32-01 --write-config
```

In ra endpoint + đường dẫn cert để dán vào `config.py`/firmware (dùng
`--write-config` để tự sinh luôn `config.py` cho simulator ở mục 7.1).
Cần AWS credentials của tài khoản bạn (`aws configure`) với quyền quản trị
IoT — khác với cặp `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` chỉ có quyền
`iot:Publish` mà `send-load-command` dùng ở mục 6.2.

Nạp `cert.pem` + `priv.key` + AWS root CA (AmazonRootCA1.pem) vào firmware (mục 5).
**Thing name phải khớp `devices.aws_thing_name` và MQTT client id.**

### 4.3 Rule chuyển tiếp về Supabase

IoT Core → Message routing → Rules → Create:

- **SQL**: `SELECT *, clientid() AS client_id, timestamp() AS ts FROM 'solgrid/+/telemetry'`
- **Action**: HTTPS
  - URL: `https://<project-ref>.supabase.co/functions/v1/ingest-telemetry`
  - Header: `Authorization: Bearer <INGEST_SHARED_SECRET>`
  - **Xác nhận destination:** lần đầu, AWS gửi một request xác nhận tới URL. Edge Function
    đã ghi `enableUrl` ra log. CLI bản hiện tại không có `supabase functions logs`; xem log
    qua Dashboard: **Project → Edge Functions → ingest-telemetry → Logs**, tìm dòng
    `AWS IoT destination confirmation...` rồi mở `enableUrl` một lần trên trình duyệt để
    kích hoạt (destination chuyển sang ENABLED).

### 4.4 Cấp chứng chỉ ngay trong DevConsole (không cần CLI)

Thay cho việc chạy tay `provision_device.py` (mục 4.2), có thể cấp cert thẳng
trong web: **DevConsole → Tổng quan thiết bị → bấm vào thiết bị → "Tạo chứng
chỉ mới"**. Edge Function `provision-device` sẽ tạo thing (nếu chưa có) +
policy + **cert/key mới**, gắn vào thing, rồi trả về 3 khối (Amazon Root CA,
cert.pem, priv.key) + endpoint và một block `secrets.h` sẵn sàng dán vào
firmware (mục 5). Private key chỉ trả về **đúng 1 lần** ra trình duyệt,
**không được lưu** ở server — copy ngay. Mỗi lần bấm lại tạo **thêm** một cert
mới trên AWS (cert cũ vẫn còn cho tới khi tự vô hiệu/xoá trong AWS Console).

Mở modal cũng tự động gọi `provision-device` với `{ action: "list" }` để hỏi
AWS (`ListThingPrincipals` + `DescribeCertificate`) xem thiết bị **đã có cert
nào gắn sẵn chưa** — hiện thành danh sách (id, trạng thái Active/Inactive,
ngày cấp) phía trên nút tạo, mỗi cert có thể bấm xem lại `cert.pem` (phần
certificate là public, AWS cho xem lại thoải mái; chỉ private key là không
bao giờ lấy lại được, đúng giới hạn của AWS).

Function này cần **AWS credentials quyền quản trị IoT** — rộng hơn cặp khoá
`iot:Publish` mà `send-load-command` dùng (mục 6.2): cần `iot:CreateThing`,
`CreateKeysAndCertificate`, `CreatePolicy`, `AttachPolicy`,
`AttachThingPrincipal`, `DescribeEndpoint`, `ListThingPrincipals`,
`DescribeCertificate`, `sts:GetCallerIdentity` — `AWSIoTFullAccess` (policy
quản lý của AWS) là đủ; đúng bằng quyền mà `provision_device.py` cần (mục 4.2)
cộng thêm hai quyền đọc cho phần liệt kê.

```bash
supabase secrets set \
  AWS_PROVISION_REGION="ap-southeast-1" \
  AWS_PROVISION_ACCESS_KEY_ID="..." \
  AWS_PROVISION_SECRET_ACCESS_KEY="..."
# Có verify JWT (mặc định) — chỉ chủ trạm (RLS select-own trên devices) mới
# cấp được cert cho thiết bị của mình:
supabase functions deploy provision-device
```

Nếu không set `AWS_PROVISION_*`, function fallback về `AWS_REGION` /
`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` — nhưng **đừng** tái dùng cặp
khoá publish-only của `send-load-command` vì nó thiếu quyền provisioning.

## 5. Firmware ESP32

Xem mẫu ở `firmware/esp32-solgrid/esp32-solgrid.ino`. Thiết bị:
- Kết nối WiFi, rồi TLS tới AWS IoT ATS endpoint (`<prefix>-ats.iot.<region>.amazonaws.com:8883`) bằng cert/key.
- Client id = thing name (vd `solgrid-esp32-01`).
- Publish JSON theo chu kỳ lên `solgrid/<station>/telemetry`, ví dụ:
  `{"solar_kw":2.1,"battery_pct":80,"battery_voltage":48.5,"battery_current":12,"load_w":900,"temp_c":42,"rssi":-58,"charge_enabled":true,"discharge_enabled":true,"protect_reason":"ok","uptime_s":523920,"mcu_temp_c":42,"boot_count":3}`
  (`battery_current`/`charge_enabled`/`discharge_enabled`/`protect_reason` là
  của cơ chế bảo vệ sạc/xả — mục 8; `uptime_s`/`mcu_temp_c`/`boot_count` là
  chẩn đoán phần cứng — mục 11; đều tuỳ chọn).
  **`temp_c` là nhiệt độ PACK PIN, `mcu_temp_c` là nhiệt độ lõi MCU** — hai
  đại lượng khác nhau, hai cột khác nhau, đừng gửi lẫn.
- Nếu ESP32 này điều khiển tải (mục 6), payload còn kèm
  `"loads":{"<load-uuid>":"on"}` — trạng thái relay thật, không phải lệnh vừa nhận.
- Nếu ESP32 phát SoftAP (mục 9), **bản tin đầu sau mỗi lần reconnect** kèm
  `"ap_ssid":"SolGrid-Tram02","ap_password":"..."` — cấu hình mạng cục bộ nó
  đang thực sự phát, để dashboard hiển thị.
- Nếu firmware hỗ trợ OTA (mục 10), **bản tin đầu sau mỗi lần reconnect** kèm
  `"fw_version":"v2.3.1"` — bản đang thực sự chạy; trong lúc nạp thì kèm
  `"fw_status":"downloading"` (+ `"fw_status_detail"` tuỳ chọn). Đều tuỳ chọn.
- Subscribe `solgrid/<thing_name>/command` để nhận **lệnh bật/tắt tải** (mục 6,
  `{load_id,action}`), **cấu hình ngưỡng bảo vệ pin** (mục 8,
  `{type:"battery_config",...}`) và **lệnh cập nhật firmware** (mục 10,
  `{type:"ota",url,sha256,...}`).

## 6. Điều khiển tải

Cho phép dashboard bật/tắt một tải (ví dụ máy bơm) từ xa qua ESP32 gắn relay.
Khác chiều với telemetry: **cloud → thiết bị**, nên không đi qua IoT Rule mà
qua một Edge Function publish thẳng vào AWS IoT.

```
Dashboard bấm Switch ──▶ Edge Function send-load-command ──AWS SDK (SigV4)──▶ AWS IoT Core
                              │ xác thực JWT người dùng,                    │ publish
                              │ tra loads.device_id → devices.aws_thing_name│
                              ▼                                             ▼
                    cập nhật loads.desired_state              solgrid/<thing_name>/command
                                                                             │
                                                                             ▼
                                                              ESP32 (subscribed) đổi relay
                                                                             │
                                                    kỳ publish telemetry kế tiếp, kèm "loads"
                                                                             ▼
                                              ingest-telemetry ghi loads.reported_state
```

### 6.1 Thêm/xóa tải trong UI

Dashboard → **Điều khiển tải** → *+ Thêm tải*: đặt tên, công suất (W), và
tuỳ chọn chọn ESP32 sẽ đóng/cắt tải đó (danh sách lấy từ các thiết bị
type=`esp32` đã đăng ký cho trạm — xem mục 2). Không chọn thiết bị vẫn thêm
được, nhưng khi đó chỉ để "theo dõi", nút bật/tắt sẽ báo lỗi vì không có
đích để gửi lệnh. Nút "Xóa" xoá thẳng hàng (RLS `loads_delete_own`), không
cần xác nhận phía server.

### 6.2 Deploy Edge Function

```bash
supabase secrets set \
  AWS_ACCESS_KEY_ID="..." \
  AWS_SECRET_ACCESS_KEY="..." \
  AWS_REGION="ap-southeast-1" \
  AWS_IOT_ENDPOINT="xxxxxxxxxx-ats.iot.ap-southeast-1.amazonaws.com"

# Có verify JWT (mặc định) vì caller là người dùng đã đăng nhập, không phải AWS:
supabase functions deploy send-load-command
```

IAM user/role gắn với cặp khóa trên cần quyền `iot:Publish` (tối thiểu:
`Resource: arn:aws:iot:<region>:<account>:topic/solgrid/*/command`).

### 6.3 Cấu hình firmware

Trong `esp32-solgrid.ino`, sửa mảng `relays[]` — mỗi hàng khớp một
`loads.id` (UUID, copy từ Supabase/DevConsole) với một chân GPIO relay thật:

```cpp
RelayLoad relays[] = {
  { "3f2a1c9e-....-....-....-............", 25 },  // ví dụ: relay máy bơm
};
```

Không cần sửa policy/Rule đã tạo ở mục 4 nếu đã thêm 2 statement Subscribe/
Receive ở 4.1.

### 6.4 Kiểm thử

1. Deploy function (6.2), nạp firmware mới (6.3).
2. Dashboard → Điều khiển tải → bật tải đã gắn ESP32 → xem log ESP32 (Serial)
   in `command <load_id> -> on` và relay đổi trạng thái.
3. Chờ chu kỳ publish kế tiếp → cột `loads.reported_state` trong Supabase
   chuyển thành `true`; UI hiển thị đúng theo giá trị này (ưu tiên hơn
   `desired_state` một khi thiết bị đã xác nhận).
4. Rút WiFi/tắt ESP32 → bật tải từ dashboard vẫn ghi được `desired_state`
   (lệnh publish tới AWS IoT thành công) nhưng relay thật không đổi và
   `reported_state` không cập nhật — dùng chênh lệch hai cột này để phát hiện
   thiết bị không phản hồi lệnh.

## 7. Kiểm thử end-to-end (telemetry)

1. Áp migration, đăng ký device (mục 1–2).
2. Deploy function, test bằng `curl` (mục 3) → hàng `telemetry` xuất hiện, `stations` snapshot cập nhật.
3. Provisioning AWS + Rule (mục 4). Dùng **AWS IoT MQTT test client** publish thử lên `solgrid/tram01/telemetry` → kiểm tra Rule kích hoạt → function → hàng trong Supabase.
4. Chạy firmware trên ESP32 thật.
5. Mở dashboard → station card của trạm phản ánh giá trị vừa gửi (không cần sửa frontend); charts dùng `useTelemetry` (nếu đã nối ở Phase 2).

### 7.1 Mô phỏng ESP32 bằng Python (không cần phần cứng)

`tools/mqtt-simulator/simulate_esp32.py` — MQTT client Python đi đúng đường
thật (TLS X.509 tới AWS IoT Core), thay cho firmware khi chưa có board vật
lý. Cùng cert/thing name với một thiết bị đã đăng ký thật (mục 2/4.2):

```bash
cd tools/mqtt-simulator
pip install -r requirements.txt
cp config.example.py config.py   # điền AWS_IOT_ENDPOINT, THING_NAME, đường dẫn cert
python simulate_esp32.py
```

Gửi telemetry giả lập (solar/pin/nhiệt độ trôi theo thời gian trong ngày)
định kỳ lên `solgrid/<STATION_SLUG>/telemetry`, đồng thời subscribe
`solgrid/<THING_NAME>/command` để test luôn "Điều khiển tải" (mục 6) — khai
`RELAYS` trong `config.py` với `loads.id` thật thì bấm Switch trên Dashboard
sẽ thấy log lệnh in ra và lần publish kế tiếp phản ánh đúng trạng thái.

## 8. Điều khiển ngắt sạc / xả pin theo ngưỡng

Bảo vệ pin khi SOC/điện áp chạm ngưỡng của "Chế độ bảo vệ pin" (trang Pin lưu
trữ). Nguyên tắc: **quyết định đóng/cắt nằm ở thiết bị (firmware)**, không phụ
thuộc cloud — mất WiFi/mất Supabase thì pin vẫn được bảo vệ. Cloud chỉ **đẩy
ngưỡng xuống** và **hiển thị trạng thái** thiết bị báo về.

```
Đổi mode ở trang Pin ──▶ send-battery-config ──publish──▶ solgrid/<thing>/command
   (station_settings)        (đọc battery_modes[mode])        {type:"battery_config",...}
                                                                        │
                                                                        ▼
                                              ESP32 lưu ngưỡng vào NVS + applyProtection()
                                              tự đóng/cắt relay đường sạc & đường xả
                                                                        │
                                          kỳ telemetry kế: charge_enabled/discharge_enabled/
                                                            protect_reason ──▶ ingest-telemetry
                                                                        │
                                                            stations snapshot ──▶ dashboard
```

### 8.1 Phần cứng

Hai relay/contactor riêng, khai ở đầu firmware (`CHARGE_RELAY_PIN`,
`DISCHARGE_RELAY_PIN`):
- **Đường sạc**: giữa solar charge controller và pin.
- **Đường xả**: giữa pin và tải/inverter.

Mức `HIGH` = cho phép, `LOW` = ngắt (đảo lại nếu relay active-low). Đặt chân =
`255` để vô hiệu một đường. Đây **không thay thế BMS phần cứng** — BMS vẫn là
lớp bảo vệ cuối cùng. Nếu BMS của bạn có sẵn chân bật/tắt sạc-xả (JK/JBD qua
UART/RS485), có thể điều khiển thẳng BMS thay cho relay ngoài; điểm tích hợp là
`writeProtectRelays()` và `readBattery()` (đọc SOC/V/I/nhiệt độ thật — hiện là
`TODO` trả giá trị mẫu).

### 8.2 Ngưỡng và hysteresis

`send-battery-config` đọc `station_settings.battery_modes[mode]` và gửi:
`{minSoc, maxSoc, maxVoltage, maxCurrent, deepDischargeProtect}`. Firmware áp
dụng với dải trễ để relay không đóng/cắt dao động quanh ngưỡng:
- Ngắt sạc khi `SOC ≥ maxSoc` hoặc `V ≥ maxVoltage`; cho sạc lại khi
  `SOC < maxSoc−3%` **và** `V < maxVoltage−0.4V`.
- Ngắt xả khi `deepDischargeProtect` và `SOC ≤ minSoc`; cho xả lại khi
  `SOC > minSoc+5%`.

Ngưỡng nhận được lưu vào NVS (Preferences) nên **giữ qua reboot**; chưa nhận lần
nào thì firmware dùng mặc định an toàn (tương đương mode `balanced`).

### 8.3 Deploy Edge Function

Dùng chung cặp khoá `iot:Publish` + `AWS_IOT_ENDPOINT` với `send-load-command`
(mục 6.2) — cùng namespace topic `solgrid/*/command`:

```bash
supabase functions deploy send-battery-config
```

### 8.4 Kiểm thử

1. Deploy function (8.3), nạp firmware mới (hoặc chạy simulator mục 7.1 — đã
   hỗ trợ `battery_config`).
2. Trang Pin lưu trữ → đổi "Chế độ bảo vệ pin" → xem log thiết bị in
   `battery_config mode=... minSoc=...`.
3. Ép SOC mô phỏng vượt `maxSoc` (hoặc chỉnh ngưỡng thấp xuống) → thiết bị báo
   `charge_enabled=false`, `protect_reason=full` ở telemetry kế; thẻ **Điều
   khiển bảo vệ sạc / xả** trên dashboard chuyển "Đường sạc → Đã ngắt".
4. Rút WiFi ESP32 rồi để SOC chạm ngưỡng → relay vẫn ngắt đúng (bảo vệ không
   phụ thuộc cloud), chỉ là dashboard không cập nhật cho tới khi có mạng lại.

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

### 9.2 Còn thiếu

Trang web cục bộ chạy trên ESP32 **chưa làm**. Dashboard React này không dùng
lại được: nó ~650 KB và mọi truy vấn đều đi Supabase, nên khi mất internet sẽ
trắng màn hình. Cần một trang riêng, nhỏ, nhúng trong LittleFS, đọc thẳng state
firmware qua HTTP server chạy trên chính ESP32.

## 10. Cập nhật firmware qua mạng (OTA)

Luồng đã chạy được đầu-cuối: migration `0015_firmware_ota.sql` dựng **tầng lưu
trữ** (catalog bản phát hành, bucket chứa `.bin`, cột theo dõi phiên bản trên
`devices`), `send-ota-command` lo **chiều đẩy lệnh**, firmware lo **tải + kiểm
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
                                    ▼  firmware: HTTPUpdate + kiểm hash
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
service role (service role bỏ qua RLS).

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
 "fw_status":"downloading","fw_status_detail":"42%"}   // chỉ khi đang nạp
```

Cả ba trường đều **tuỳ chọn** và ghi vào `devices` chứ không vào `telemetry` —
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

Đã làm trong `firmware/esp32s3-solgrid/esp32s3-solgrid.ino`. Ba việc cần làm
trước khi nạp:

1. **Partition Scheme** (Tools → Partition Scheme) phải có **hai** phân vùng
   app. Sơ đồ **mặc định đã đạt** (`app0`/`app1`, mỗi cái 1.25 MB) — chỉ cần
   tránh "Huge APP (3MB No OTA)" vốn chỉ có một app partition, khi đó
   `Update.begin()` luôn thất bại và thiết bị báo `detail=no_space`.
2. **`SUPABASE_ROOT_CA`** trong `secrets.h` (xem `secrets.example.h` để biết
   cách lấy). Thiết bị tải `.bin` từ **Supabase Storage** chứ không phải AWS
   nên cần root CA khác — **không dùng lại `AmazonRootCA1.pem`** của MQTT.
   Thiếu nó firmware vẫn chạy đủ mọi thứ khác, chỉ OTA bị vô hiệu và mọi lệnh
   đẩy trả về `fw_status=failed, detail=ota_not_configured`.
3. **Tăng `FW_VERSION`** trong `.ino` mỗi lần build một bản mới, và chuỗi đó
   phải **trùng** `version` của hàng `firmware_releases` khi tải lên (mục 10.3).
   Cloud so hai chuỗi để biết thiết bị đã nạp xong chưa.

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

**Dung lượng.** Bản build hiện tại chiếm **78%** phân vùng app 1.25 MB
(1,025 KB / 1,311 KB); riêng phần OTA tốn ~38 KB. Còn ~285 KB dư — đủ nhưng
không nhiều, cần để ý khi thêm tính năng (nhất là trang web cục bộ ở mục 9.2).

### 10.8 Giao diện — DevConsole → Quản lý Firmware MCU

Ba khối, đúng ba đường dữ liệu khác nhau (`src/lib/firmware.js` +
`src/pages/DevConsole.jsx`):

1. **Thiết bị** — đọc thẳng `devices` (RLS select-own). Hiện `fw_version` thiết
   bị tự báo, huy hiệu `fw_status`, và `fw_status_detail` đã dịch sang tiếng
   Việt (`sha_mismatch` → "hash không khớp, file tải về hỏng"; `http_403` →
   "link tải đã hết hạn"). Khi `fw_target_id` trỏ tới bản khác với `fw_version`,
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
   mặc định `esp32s3-solgrid`; **Phiên bản** tự gợi ý từ tên file nhưng vẫn
   phải soát — cả hai chuỗi phải trùng `FW_BOARD`/`FW_VERSION` trong `.ino`.

3. **Bản phát hành** — catalog thật. Bấm một hàng để chọn bản sẽ đẩy;
   **rollback = chọn một bản cũ hơn rồi bấm "Cập nhật"**, không có nút riêng vì
   không cần. Huy hiệu "Đang chạy" so theo `devices.fw_version` (thiết bị báo
   về) chứ không theo bản cloud đã gửi lệnh. Nút "Xoá" xoá **file trong bucket
   trước, hàng sau** — đúng thứ tự bắt buộc ở mục 10.4.

Vài điểm về hành vi:

- **Không có realtime trên `devices`.** Sau khi đẩy, trang poll lại 5 giây một
  lần *chỉ khi* có thiết bị đang ở `pending`/`downloading`/`applying`, và tối đa
  5 phút mỗi lần đẩy: thiết bị offline lúc publish sẽ kẹt ở `pending` vô hạn
  (QoS 1 không giao lại), nên vòng poll phải có hạn.
- **"Đã gửi lệnh" ≠ "đã nạp xong".** Thông báo sau khi đẩy chỉ nói số thiết bị
  mà lệnh tới được AWS (kèm tên những thiết bị publish lỗi từ `failed_devices`).
  Xác nhận nạp xong chỉ đến từ `fw_version` thiết bị báo về.
- **Không có "Tự động cập nhật OTA khi có bản mới".** Switch này từng có trong
  bản demo nhưng đã gỡ: không có gì ở server thực hiện nó, và tự đẩy firmware
  lên phần cứng thật mà không ai bấm là hành vi không nên có mặc định.

## 11. Chẩn đoán phần cứng (DevConsole → Tổng quan thiết bị)

Bốn ô chỉ số ở đầu DevConsole. Trước đây chúng lấy từ hằng số `DIAG_BY_STATUS`
trong `DevConsole.jsx` (chỉ đổi theo status của trạm) dù tiêu đề ghi "thời gian
thực"; migration `0017_device_diagnostics.sql` dựng đường ống thật.

| Ô | Nguồn | Cần firmware mới? |
|---|---|---|
| Thời gian hoạt động | `devices.uptime_s` | Có |
| Nhiệt độ MCU | `devices.mcu_temp_c` | Có |
| Số lần khởi động lại | `devices.boot_count` | Có |
| Kết nối MQTT Broker | `devices.status` | Không — đã có sẵn |

Đi cùng đường với mọi số đo khác, không thêm Edge Function nào:

```
firmware: uptime_s / mcu_temp_c / boot_count kèm MỖI bản tin telemetry
   ▼
ingest-telemetry (chỉ thêm 3 tên vào NUMERIC_FIELDS) → insert telemetry
   ▼
trigger apply_telemetry → snapshot mới nhất lên devices.*  ──▶ DevConsole
```

- **Hai nơi lưu, có chủ đích.** `telemetry` giữ chuỗi thời gian (biết thiết bị
  reboot lúc nào, MCU nóng lên vào khung giờ nào); `devices` giữ snapshot để UI
  đọc một phát ra giá trị hiện tại của từng thiết bị. Trigger `apply_telemetry`
  vốn đã cập nhật `devices.status`/`last_seen_at` mỗi bản tin, nên 3 phép gán
  thêm **không tốn lượt ghi nào**.
- **Chỉ số là của MỘT thiết bị, không phải của trạm.** Một trạm nhiều ESP32 thì
  mỗi con có uptime/nhiệt độ riêng — DevConsole hiện `<select>` chọn thiết bị
  khi trạm có >1 ESP32, mặc định lấy con báo dữ liệu gần đây nhất.
- **Firmware cũ vẫn chạy bình thường**: ba cột là null → ô hiện "—" kèm chú
  thích "Thiết bị chưa báo", cố tình không hiện `0` (không phân biệt được
  "chưa biết" với "bằng 0"). Cùng quy ước với `ap_ssid` (mục 9) và
  `fw_version` (mục 10).
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

### 11.1 Kiểm thử

Simulator (mục 7.1) đã gửi đủ ba trường, nên thử được không cần phần cứng:

```bash
supabase db push                       # áp 0017
supabase functions deploy ingest-telemetry --no-verify-jwt
cd tools/mqtt-simulator && python simulate_esp32.py
```

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

| Sự kiện | Mức | Ghi ở đâu |
|---|---|---|
| `device_online` / `device_offline` | info / error | Trigger `devices_log_status_change` (0018) |
| `battery_below_threshold` / `battery_recovered` | warn / info | Trigger `stations_log_battery_alert` (0018) |
| `ota_pushed` | info / warn | `send-ota-command` |
| `ota_success` / `ota_failed` | info / error | `ingest-telemetry` |
| `archive_completed` / `purge_completed` | info | `archive-telemetry` |
| `archive_storage_full`, `archive_upload_failed`, `telemetry_hard_purge` | error | `archive-telemetry` / `purge_telemetry_overdue` |

Nguyên tắc chung: **chỉ ghi khi trạng thái thực sự đổi**. `apply_telemetry`
chạy mỗi bản tin và luôn đặt `status='connected'`; nếu ghi log mỗi lần chạy thì
một thiết bị sinh 8.640 dòng/ngày — nhật ký sẽ tốn chỗ hơn dữ liệu nó mô tả.
Thiết bị chạy ổn định sinh **0 dòng**.

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
| Log mới không tự hiện, phải F5 | Bảng chưa vào publication realtime: `alter publication supabase_realtime add table public.system_logs;` |
| "Chạy dọn ngay" lỗi 401/404 | Chưa `supabase functions deploy archive-telemetry --no-verify-jwt`. |
| `net._http_response` trả 401 `UNAUTHORIZED_INVALID_JWT_FORMAT` | Deploy thiếu `--no-verify-jwt` — cổng chặn shared secret vì nó không phải JWT. Deploy lại kèm cờ đó. |
| `net._http_response` trả 401 `{"error":"unauthorized"}` | Đây là hàm từ chối (không phải cổng): chuỗi trong Vault lệch với `MAINTENANCE_SHARED_SECRET`. Đặt lại cả hai nơi. |
| Job đêm không chạy nhưng nút bấm tay chạy được | Chưa nạp secret vào Vault (mục 12.3) — nút bấm tay dùng JWT người dùng, không cần Vault. |
| Log `archive_storage_full` | Storage đã dùng >900 MB. Xoá bớt gói cũ trong "Gói đã lưu trữ". |
| Log `telemetry_hard_purge` | Lưới an toàn đã phải xoá dữ liệu chưa lưu trữ được — đường lưu trữ đang hỏng, sửa ngay. |

## Ngoài phạm vi (làm sau)
- Tự vô hiệu/xoá cert cũ khi "Tạo lại chứng chỉ" (mục 4.4) — hiện mỗi lần cấp
  để lại cert cũ trên AWS, phải tự dọn trong AWS Console. (Cấp cert ngay trong
  DevConsole đã làm xong ở mục 4.4 qua Edge Function `provision-device`.)
- Audit log lịch sử lệnh điều khiển tải (hiện chỉ có 2 cột `desired_state`/`reported_state`, không lưu lịch sử từng lần bấm).
