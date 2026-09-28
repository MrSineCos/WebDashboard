# Firmware, điều khiển tải và telemetry

> [← Quay lại mục lục IoT](../IOT.md)

## 5. Firmware ESP32

Xem mẫu ở `firmware/esp32-solgrid/esp32-solgrid.ino`. Thiết bị:
- Kết nối WiFi, rồi TLS tới AWS IoT ATS endpoint (`<prefix>-ats.iot.<region>.amazonaws.com:8883`) bằng cert/key.
- Client id = thing name (vd `solgrid-esp32-01`).
- Publish JSON theo chu kỳ lên `solgrid/<station>/telemetry`, ví dụ:
  `{"solar_kw":2.1,"battery_pct":80,"battery_voltage":48.5,"battery_current":12,"load_w":900,"temp_c":42,"rssi":-58,"charge_enabled":true,"discharge_enabled":true,"protect_reason":"ok","uptime_s":523920,"boot_count":3}`
  (`battery_current`/`charge_enabled`/`discharge_enabled`/`protect_reason` là
  của cơ chế bảo vệ sạc/xả — mục 8; `uptime_s`/`boot_count` là chẩn đoán phần
  cứng — mục 11; đều tuỳ chọn).
  **`temp_c` là nhiệt độ PACK PIN.** Nhiệt độ lõi MCU (`mcu_temp_c`) đã bỏ hẳn ở
  migration `0029` — firmware không gửi nữa, gửi lên cũng bị bỏ qua.
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

### 6.1b Gán lại thiết bị cho một tải đã tạo

Mỗi dòng tải có một ô chọn thiết bị ngay cạnh công tắc — đổi ở đó là ghi
thẳng `loads.device_id` qua RLS (`loads_update_own`), không đi qua Edge
Function nào vì không có lệnh nào phải publish ra AWS IoT.

Đây là đường **duy nhất** để cứu một tải sau khi thiết bị của nó bị xoá:
khoá ngoại `on delete set null` (0010) đặt `device_id` về null, và trước
migration `0031` thì client không có đường update nào nên tải đó mất khả
năng điều khiển vĩnh viễn.

**Đổi thiết bị làm mất hiệu lực trạng thái cũ.** Trigger
`loads_protect_reported_columns` (sửa ở `0031_loads_reassign_device.sql`) xoá
`reported_state`, `reported_at` và đặt `desired_state = false` mỗi khi
`device_id` đổi. Lý do: hai cột `reported_*` nghĩa là "thiết bị ĐÓ đã xác
nhận relay đang thế này" — gán sang ESP32 khác thì câu đó không còn đúng với
ai cả, mà giao diện lại ưu tiên `reported_state` hơn `desired_state`, nên giữ
nguyên sẽ hiện trạng thái relay của thiết bị **cũ** như thể là của thiết bị
mới. Bất biến này đặt ở database chứ không ở client vì nó phải đúng với cả
đường khoá ngoại tự đặt null lúc xoá thiết bị.

**Gán lại KHÔNG tắt relay trên thiết bị cũ.** Thiết bị cũ có thể vừa bị xoá
hoặc đang mất mạng nên không có cách nào đảm bảo lệnh tắt tới nơi — cố gửi
rồi coi như xong còn nguy hiểm hơn là không gửi. Nếu tải đang bật, hãy tắt
nó **trước** khi đổi thiết bị; giao diện có ghi chú nhắc điều này ngay dưới
danh sách tải.

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

### 8.5 Đếm chu kỳ sạc (EFC)

Ô "Chu kỳ sạc" ở Dashboard/Pin lưu trữ/Báo cáo trước đây là số viết chết trong
JSX (`214`, hoặc `kwh / 1.8` ở Báo cáo). Migration `0020_battery_cycles.sql`
thay bằng bộ đếm thật, tính theo chuẩn **Equivalent Full Cycles**:

```
chu kỳ = cycle_offset + (năng lượng nạp + năng lượng xả) / (2 × dung lượng pack)
```

Cộng dồn **ngay trong trigger `apply_telemetry`** mỗi khi có bản tin mới, KHÔNG
tính lại từ `telemetry` mỗi lần hiển thị — vì mục 12 xoá telemetry thô cũ hơn
`telemetry_retention_days` (mặc định 30 ngày); một hàm tính từ dữ liệu thô sẽ
khiến số chu kỳ tụt xuống sau mỗi lượt dọn, sai với ý nghĩa "tuổi thọ tích luỹ"
của con số này. Trigger giữ một mốc neo (`cycle_anchor_ts`/`cycle_anchor_kw`) —
mẫu liền trước — để tính diện tích hình thang giữa hai bản tin liên tiếp, bỏ
qua khoảng trống > 1 giờ (thiết bị mất kết nối) cùng ngưỡng với
`station_daily_energy` (mục 12 / migration 0005, nay là 0020) để các trang
không lệch số nhau.

Công suất pin ròng dùng để cộng dồn là `solar_kw − load_w/1000` (cùng công
thức với ô "Dòng DC bus" và trang Pin lưu trữ), **không dùng `battery_current`**
dù cột đó đã có từ mục 8 phía trên: firmware hiện chưa chốt quy ước dấu
(dương là nạp hay xả), đoán sai dấu sẽ khiến bộ đếm chạy ngược. Khi firmware
chốt quy ước, đổi công thức trong `apply_telemetry` sang
`battery_voltage × battery_current` là đủ — schema và các trang đọc
`stations.battery_cycles` không phải sửa gì.

`stations.battery_cycles` là cột **sinh** (generated, stored) từ
`charge_energy_kwh`/`discharge_energy_kwh`/`cycle_offset`/`battery_capacity_kwh`
— mọi client (web, và sau này app Android) chỉ cần `select battery_cycles`,
không tính lại công thức ở phía mình. `battery_capacity_kwh` (mặc định 4.8 kWh
= 100Ah/48V) là dung lượng pack người dùng khai báo, dùng chung làm mẫu số cho
cả số chu kỳ lẫn ước tính "còn mấy giờ đến đầy/hết" ở trang Pin lưu trữ.

Bốn cột tích luỹ (`charge_energy_kwh`, `discharge_energy_kwh`,
`cycle_anchor_ts`, `cycle_anchor_kw`) bị trigger `stations_protect_cycle` khoá
— chỉ service role (đường ingest) ghi được, giống `loads_protect_reported`
(mục 6). `battery_capacity_kwh`/`cycle_offset` thì KHÔNG bị khoá vì đó là
thông số người dùng tự khai (dung lượng pack, số chu kỳ pack đã đi trước khi
lắp vào hệ thống này).

**Không** dựng lại "Sức khỏe pin" (SOH) — suy ra SOH đúng cần đo dung lượng
thực qua một lần xả đầy có kiểm soát, firmware hiện không làm việc đó. Ô đó đã
đổi thành "Dòng pin" (đọc thẳng `battery_current`, có sẵn từ mục 8) thay vì
đoán ra một con số sai.
