# Đặc tả đồng bộ cấu hình BMS: DevConsole → AWS IoT Core → ESP32-S3 → STM32

## 1. Mục đích

Tài liệu này là nguồn đầu vào cho việc triển khai tính năng cấu hình BMS trong SolGrid.

Phạm vi:

- Lưu cấu hình ngưỡng pin theo từng chế độ trên DevConsole.
- Lưu ngưỡng bảo vệ pin, tối thiểu gồm điện áp tối đa và dòng sạc tối đa.
- Lưu thông tin hiệu chỉnh cảm biến.
- Gửi cấu hình từ AWS IoT Core tới ESP32-S3.
- ESP32-S3 kiểm tra, lưu bền vững và chuyển cấu hình tới STM32 điều khiển BMS.
- STM32 xác nhận đã nhận và áp dụng cấu hình.
- ESP32-S3 gửi trạng thái xác nhận ngược về cloud để DevConsole hiển thị.

Trong giai đoạn này, STM32 được xem là bộ điều khiển BMS. Chưa triển khai đường cấu hình cho buck-boost. Nếu sau này buck-boost dùng chung UART hoặc chung nhóm cảm biến, phải tách rõ owner của từng cấu hình trước khi mở rộng.

## 1.1 Trạng thái sau khi bổ sung tính năng xác nhận

Phần theo dõi kết quả cấu hình đã được bổ sung cho luồng battery_config hiện tại:

- DevConsole hiển thị theo từng ESP32: pending, received, applying, applied, rejected, timeout và publish_failed.
- send-battery-config sinh configId/configVersion/configHash, publish xong ghi snapshot mong muốn vào devices.
- ingest-telemetry nhận bms_config_ack, chỉ cập nhật snapshot khi id/version/hash khớp request đang chờ.
- firmware/esp32s3.ino xác nhận received sau khi validate và lưu NVS thành công; ACK được gửi trong telemetry tiếp theo.
- Trạng thái applied chưa được ESP32 tự gán, vì giao thức UART ghi/áp dụng cấu hình STM32 chưa có trong code hiện tại. Không được hiểu received là STM32 đã áp dụng.

Migration cần áp dụng là supabase/migrations/0034_bms_config_sync.sql.

## 2. Hiện trạng cần giữ tương thích

### 2.1 ESP32-S3

Firmware trong firmware/esp32s3.ino hiện có:

- MQTT command topic: solgrid/<aws_thing_name>/command.
- UART Serial1, GPIO17 TX / GPIO18 RX, 115200 8N1.
- Khung UART: SOF / sender_id / payload_len / payload / CRC8.
- Lệnh UART CMD_GET_TLM = 0x01, chỉ dùng để hỏi telemetry.
- battery_config nhận từ MQTT được ESP32-S3 tự lưu vào NVS và tự dùng để điều khiển relay.
- BatteryConfig hiện có minSoc, maxSoc, maxVoltage, maxCurrent và deepDischargeProtect; maxCurrent được lưu NVS và dùng cho bảo vệ quá dòng sạc cục bộ.
- readBattery() hiện vẫn trả dữ liệu mẫu; chưa đọc BMS thật.

Không được để callback MQTT tự ghi Serial1 hoặc thực hiện thao tác dài. Một task duy nhất phải sở hữu runtime access tới UART.

### 2.2 Cloud và DevConsole

- station_settings.battery_modes đã có các mode low, balanced, max.
- Mỗi mode hiện có minSoc, maxSoc, maxCurrent, maxVoltage và deepDischargeProtect.
- send-battery-config hiện chỉ chọn mode đang hoạt động rồi publish qua MQTT.
- send-battery-config hiện vẫn gửi mode đang hoạt động; payload đã có configId/configVersion/configHash để đối chiếu ACK.
- Mục Hiệu chỉnh cảm biến trong DevConsole hiện là giao diện demo, chưa có state, lưu database hoặc nút gửi cấu hình.

Các file liên quan:

- firmware/esp32s3.ino
- src/pages/DevConsole.jsx
- src/lib/userSettings.js
- supabase/functions/send-battery-config/index.ts
- supabase/migrations/0009_station_settings.sql

## 3. Kiến trúc đích

~~~text
DevConsole
   │ lưu station_settings + tạo config_version/config_hash
   ▼
Edge Function send-bms-config
   │ publish JSON QoS 1
   ▼
AWS IoT Core
   │ solgrid/<thing>/command
   ▼
ESP32-S3 MQTT callback
   │ validate → queue → BmsConfigTask/Stm32Task
   ▼
ESP32-S3 NVS pending
   │ UART binary protocol
   ▼
STM32-BMS
   │ validate toàn bộ gói → ghi flash → áp dụng → ACK
   ▼
ESP32-S3
   │ commit NVS active + tạo config_ack
   ▼
Telemetry/ACK MQTT → AWS IoT Rule → ingest-telemetry
   │
   ▼
Supabase device_config_sync + devices snapshot
   │
   ▼
DevConsole: Pending / Đã áp dụng / Từ chối / Timeout
~~~

Trạng thái “đã nhận MQTT” không được hiển thị là “đã áp dụng”. Chỉ hiển thị thành công sau khi STM32 trả ACK hợp lệ và ESP32-S3 đã commit cấu hình active vào NVS.

## 4. Mô hình cấu hình chuẩn

### 4.1 Cấu hình lưu theo trạm

Thêm vào station_settings:

~~~sql
sensor_calibration jsonb not null default '{}'::jsonb,
config_version bigint not null default 0,
config_hash text,
updated_at timestamptz not null default now()
~~~

Nên cập nhật config_version bằng RPC hoặc transaction phía server để tránh hai lần lưu đồng thời dùng cùng một version. Không để browser tự chọn version.

Ví dụ sensor_calibration:

~~~json
{
  "battery_voltage": {
    "gain": 0.0812,
    "offset": -0.4,
    "unit": "V",
    "enabled": true
  },
  "charge_current": {
    "gain": 0.0431,
    "offset": 0.0,
    "unit": "A",
    "enabled": true
  },
  "battery_temperature": {
    "gain": 0.0512,
    "offset": -2.1,
    "unit": "C",
    "enabled": true
  },
  "pv_power": {
    "gain": 1.0,
    "offset": 0.0,
    "unit": "W",
    "enabled": false,
    "owner": "buckboost"
  }
}
~~~

pv_power chỉ đưa vào gói BMS nếu cảm biến đó thực sự do STM32-BMS quản lý. Không gửi cấu hình cảm biến buck-boost cho STM32-BMS chỉ vì nó đang xuất hiện trên giao diện.

Công thức phải được thống nhất ở cả hai phía:

~~~text
giá trị kỹ thuật = giá trị thô × gain + offset
~~~

Đơn vị, miền hợp lệ và độ phân giải của từng cảm biến phải được cố định trong protocol. Không gửi chuỗi hiển thị như “48.3 V”; chỉ gửi số.

### 4.2 Cấu hình các mode pin

Mỗi mode phải có đầy đủ:

~~~json
{
  "minSoc": 20,
  "maxSoc": 90,
  "maxVoltage": 54.6,
  "maxCurrent": 25,
  "deepDischargeProtect": true
}
~~~

Ý nghĩa:

- minSoc: ngưỡng cắt xả thấp nhất, đơn vị %.
- maxSoc: ngưỡng dừng sạc theo SOC, đơn vị %.
- maxVoltage: ngưỡng dừng sạc theo điện áp, đơn vị V.
- maxCurrent: giới hạn dòng sạc, đơn vị A.
- deepDischargeProtect: có bật bảo vệ xả sâu hay không.

Gói cấu hình phải chứa toàn bộ ba mode và mode đang hoạt động, không chỉ mode đang hoạt động. Như vậy STM32 có thể lưu sẵn các mode và chuyển mode mà không cần cloud gửi lại toàn bộ cấu hình tại thời điểm đó.

### 4.3 JSON gửi từ AWS IoT tới ESP32-S3

Đề xuất dùng type mới bms_config, giữ hỗ trợ battery_config cũ trong một thời gian để tương thích firmware cũ.

~~~json
{
  "type": "bms_config",
  "protocolVersion": 1,
  "configId": "uuid-cua-lan-luu",
  "configVersion": 42,
  "configHash": "sha256-hex-64-ky-tu",
  "activeMode": "balanced",
  "batteryModes": {
    "low": {
      "minSoc": 10,
      "maxSoc": 95,
      "maxVoltage": 55.2,
      "maxCurrent": 35,
      "deepDischargeProtect": false
    },
    "balanced": {
      "minSoc": 20,
      "maxSoc": 90,
      "maxVoltage": 54.6,
      "maxCurrent": 25,
      "deepDischargeProtect": true
    },
    "max": {
      "minSoc": 30,
      "maxSoc": 80,
      "maxVoltage": 53.8,
      "maxCurrent": 15,
      "deepDischargeProtect": true
    }
  },
  "sensorCalibration": {
    "battery_voltage": { "gain": 0.0812, "offset": -0.4, "unit": "V" },
    "charge_current": { "gain": 0.0431, "offset": 0.0, "unit": "A" },
    "battery_temperature": { "gain": 0.0512, "offset": -2.1, "unit": "C" }
  },
  "sentAt": "2026-09-26T00:00:00.000Z"
}
~~~

configHash được tạo trên canonical payload, không tính sentAt. Cùng một cấu hình phải tạo ra cùng hash dù thứ tự key JSON thay đổi. Edge Function phải dùng canonical serializer; ESP32 dùng configVersion + hash để đối chiếu nhận dạng, còn CRC của UART dùng để phát hiện lỗi truyền byte.

## 5. Thay đổi trên DevConsole

### 5.1 Cấu hình mode pin

Giữ các trường UI hiện có nhưng phải nối thật vào station_settings:

- minSoc.
- maxSoc.
- maxVoltage.
- maxCurrent.
- deepDischargeProtect.

Khi bấm lưu:

1. Validate toàn bộ ba mode ở client để phản hồi sớm.
2. Gửi request lưu cấu hình tới Supabase.
3. Server tăng config_version, tính config_hash và trả về version mới.
4. Gọi send-bms-config cho tất cả ESP32 của trạm.
5. Hiển thị trạng thái đồng bộ của từng ESP32.

Không hiển thị “Đã lưu” đồng nghĩa với “Thiết bị đã áp dụng”. Hai trạng thái phải tách riêng:

- Đã lưu trên cloud.
- Đang gửi.
- Đã áp dụng trên STM32.
- Từ chối.
- Timeout.

### 5.2 Hiệu chỉnh cảm biến

Thay mảng SENSORS hard-code bằng dữ liệu lấy từ station_settings.

Mỗi dòng cảm biến cần có:

- tên và sensor_id cố định;
- giá trị raw hiện tại nếu thiết bị có báo;
- gain;
- offset;
- đơn vị;
- trạng thái đã lưu;
- trạng thái đã áp dụng trên STM32.

Các input phải dùng state có kiểm soát, không dùng chỉ defaultValue. Nút Zero lại phải có hành vi rõ ràng:

- lấy trung bình một số mẫu raw liên tiếp;
- tính offset mới theo giá trị chuẩn do người dùng nhập hoặc zero reference;
- lưu cấu hình mới và tạo config_version mới;
- gửi lại toàn bộ bms_config.

Nếu chưa có raw sample đáng tin cậy thì vô hiệu hóa Zero lại, không tự đặt offset về zero.

### 5.3 Hiển thị ACK

DevConsole cần hiển thị theo từng ESP32, vì một trạm có thể có nhiều thiết bị.

Tối thiểu hiển thị:

- version mong muốn trên cloud;
- version đã áp dụng trên STM32;
- mode đang áp dụng;
- thời điểm ACK cuối;
- trạng thái;
- mã lỗi và mô tả nếu thất bại;
- hash rút gọn để đối chiếu.

Realtime nên dựa trên snapshot devices; lịch sử chi tiết lấy từ device_config_sync hoặc system_logs.

## 6. Thay đổi phía Supabase và AWS IoT

### 6.1 Bảng theo dõi đồng bộ

Tạo bảng device_config_sync để lưu trạng thái theo từng thiết bị và version:

~~~sql
create table public.device_config_sync (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices(id) on delete cascade,
  station_id uuid not null references public.stations(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  config_id uuid not null,
  config_version bigint not null,
  config_hash text not null,
  status text not null check (status in (
    'pending', 'received', 'applying', 'applied',
    'rejected', 'timeout', 'superseded'
  )),
  error_code text,
  error_detail text,
  requested_at timestamptz not null default now(),
  received_at timestamptz,
  applied_at timestamptz,
  updated_at timestamptz not null default now(),
  unique(device_id, config_version)
);
~~~

Bật RLS cho owner đọc. Browser không được tự ghi trạng thái ACK. Chỉ Edge Function hoặc service role được cập nhật trạng thái do thiết bị báo về.

Có thể thêm snapshot vào devices để DevConsole đọc nhanh:

~~~sql
config_id_desired uuid,
config_version_desired bigint,
config_version_applied bigint,
config_hash_desired text,
config_sync_status text,
config_sync_error text,
config_sync_requested_at timestamptz,
config_sync_ack_at timestamptz,
config_hash_applied text
~~~

### 6.2 Edge Function gửi cấu hình

Mở rộng send-battery-config hoặc tạo send-bms-config. Khuyến nghị tạo send-bms-config để tên phản ánh đúng phạm vi mới.

Edge Function phải:

1. Xác thực JWT người dùng.
2. Kiểm tra user có quyền trên station_id.
3. Đọc battery_modes, active_battery_mode, sensor_calibration và config_version.
4. Validate lại phía server; không tin validation của browser.
5. Tạo canonical payload và config_hash.
6. Tạo/cập nhật bản ghi device_config_sync trạng thái pending cho từng ESP32 của trạm.
7. Publish JSON tới solgrid/<aws_thing_name>/command bằng QoS 1.
8. Trả về danh sách thiết bị đã publish thành công/thất bại cùng configVersion.

Nếu publish thất bại ở một thiết bị, không đánh dấu thiết bị đó là thành công.

Khi người dùng dùng “Áp dụng cho tất cả trạm”, phải gọi đồng bộ cho từng trạm, không chỉ cập nhật station_settings hàng loạt rồi bỏ qua bước publish.

### 6.3 Nhận ACK từ thiết bị

Khuyến nghị dùng telemetry hiện có để giảm số AWS IoT Rule:

~~~json
{
  "bmsConfigAck": {
    "configId": "uuid-cua-lan-luu",
    "configVersion": 42,
    "configHash": "sha256-hex-64-ky-tu",
    "status": "applied",
    "phase": "stm32_ack",
    "stm32Code": 0,
    "detail": "ok"
  }
}
~~~

ingest-telemetry phải nhận diện, validate và cập nhật device_config_sync. Thông tin ACK cũng có thể lưu vào telemetry.extra để điều tra lịch sử. Không được để ACK sai format làm mất toàn bộ telemetry bình thường.

Nếu cần ACK nhanh hơn chu kỳ telemetry, tạo topic riêng:

~~~text
solgrid/<thing>/config_ack
~~~

và thêm AWS IoT Rule + Edge Function tương ứng. Dù chọn cách nào, dữ liệu phải được xác thực theo AWS Thing đã publish, không cho browser tự ghi ACK.

## 7. Các thay đổi bắt buộc trên ESP32-S3

### 7.1 Tách cấu hình BMS khỏi cấu hình buck-boost

Tạo các kiểu dữ liệu riêng:

~~~cpp
struct SensorCalibration {
  float gain;
  float offset;
  uint8_t enabled;
};

struct BatteryModeConfig {
  float minSoc;
  float maxSoc;
  float maxVoltage;
  float maxCurrent;
  bool deepDischargeProtect;
};

struct BmsConfig {
  uint8_t protocolVersion;
  char configId[40];
  uint32_t configVersion;
  char configHash[65];
  uint8_t activeMode;
  BatteryModeConfig modes[3];
  SensorCalibration sensors[/* số sensor đã chốt */];
};
~~~

Không dùng BatteryConfig hiện tại làm nơi duy nhất lưu cấu hình mới vì nó không có maxCurrent, các mode khác hoặc calibration.

### 7.2 MQTT callback chỉ nhận và xếp hàng

Trong onCommand():

1. Deserialize JSON với giới hạn kích thước rõ ràng.
2. Nhận bms_config; giữ nhánh battery_config cũ để tương thích tạm thời.
3. Kiểm tra đủ configId, configVersion, configHash, activeMode, ba mode và sensor bắt buộc.
4. Kiểm tra số, boolean và chuỗi; loại NaN/Inf, chuỗi quá dài và giá trị ngoài miền.
5. Sao chép payload vào buffer/queue an toàn.
6. Ghi nhận trạng thái received hoặc rejected_validation.
7. Gọi notify cho BmsConfigTask/Stm32Task.
8. Return ngay.

Không làm các việc sau trong callback MQTT:

- ghi Serial1;
- ghi NVS lâu;
- chờ ACK STM32;
- publish ACK ngay trong callback;
- gọi delay() dài.

### 7.3 Kiểm tra version và idempotency

ESP32-S3 phải xử lý:

- Version mới hơn active: tiếp tục xử lý.
- Version bằng active và hash giống nhau: trả ACK already_applied, không ghi lại flash/STM32 không cần thiết.
- Version cũ hơn active: từ chối stale_version.
- Cùng version nhưng hash khác: từ chối version_hash_conflict.
- Nhiều lệnh liên tiếp: giữ bản mới nhất chưa xử lý; bản cũ có thể trả superseded.

### 7.4 Validate cấu hình tại ESP32-S3

Điều kiện tối thiểu:

- 0 <= minSoc < maxSoc <= 100.
- maxVoltage > 0 và nằm trong miền an toàn của pack.
- maxCurrent > 0 và không vượt giới hạn phần cứng/BMS.
- activeMode phải tồn tại.
- gain và offset phải hữu hạn.
- calibration phải đúng sensor ID và đơn vị.
- kích thước cấu hình không vượt buffer đã định.

Nếu không hợp lệ, không được thay đổi cấu hình active đang chạy.

### 7.5 NVS hai pha

Dùng namespace riêng, ví dụ bmscfg, với hai trạng thái:

- active: cấu hình STM32 đã ACK thành công và ESP32 đang tin cậy.
- pending: cấu hình mới đã nhận, đang chờ hoặc đang gửi tới STM32.

Trình tự:

1. Ghi pending vào NVS.
2. Đọc lại pending để kiểm tra write/read.
3. Gửi pending tới STM32.
4. Chờ ACK hợp lệ.
5. Chỉ sau ACK applied mới chuyển pending thành active.
6. Xóa pending.
7. Phát ACK lên cloud.

Nếu ESP32 reboot giữa bước 1–4, không được dùng pending làm active một cách mù quáng. Khi boot phải hỏi STM32 status để quyết định commit, retry hoặc hủy pending.

### 7.6 Task sở hữu UART

Hiện BuckboostTask đang là runtime owner của Serial1. Khi UART này được dùng cho STM32-BMS, phải chọn một trong hai phương án:

- đổi task thành Stm32Task và để task này xử lý cả telemetry lẫn cấu hình BMS;
- hoặc tạo Stm32BusTask duy nhất, các task khác chỉ giao tiếp qua queue.

Không cho CloudTask, BmsTask và BuckboostTask cùng gọi Serial1.write().

Nếu buck-boost và BMS thực sự là hai STM32 khác nhau, phải có hai UART hoặc bus/address rõ ràng. Không dùng chung một UART mà không có arbitration.

### 7.7 Protocol UART đề xuất

Giữ frame ngoài tương thích:

~~~text
[SOF 0xAA][sender_id][payload_len][payload][CRC8]
~~~

Giữ CMD_GET_TLM = 0x01. Có thể dành:

~~~text
CMD_BMS_CONFIG_BEGIN       0x20
CMD_BMS_CONFIG_DATA        0x21
CMD_BMS_CONFIG_COMMIT      0x22
CMD_BMS_CONFIG_STATUS      0x23
MSG_BMS_CONFIG_ACK         0xA0
MSG_BMS_CONFIG_STATUS      0xA1
~~~

Các mã này phải được chốt giống nhau trong firmware STM32.

Do cấu hình toàn bộ mode + calibration có thể lớn hơn MAX_PAYLOAD = 32, phải chọn một trong hai cách:

1. tăng MAX_PAYLOAD ở cả ESP32-S3 và STM32 nếu gói tối đa vẫn nằm trong giới hạn RAM an toàn; hoặc
2. dùng BEGIN/DATA/COMMIT để chia nhiều chunk.

Khuyến nghị dùng chunk.

Mỗi transfer cần có:

- configVersion;
- configId hoặc transfer ID;
- tổng kích thước;
- số chunk và index chunk;
- CRC32 của toàn bộ binary config;
- mode active;
- dữ liệu ngưỡng của cả ba mode;
- calibration theo sensor ID;
- cờ kết thúc/commit.

Frame CRC8 bảo vệ từng frame. CRC32 bảo vệ toàn bộ cấu hình sau khi ghép chunk. STM32 chỉ ghi flash và áp dụng sau khi nhận đủ chunk, kiểm tra CRC32 và nhận COMMIT hợp lệ.

### 7.8 ACK từ STM32

STM32 phải trả tối thiểu:

~~~text
status: OK | ALREADY_APPLIED | REJECTED | CRC_ERROR |
        INVALID_RANGE | STORAGE_ERROR | UNSUPPORTED_VERSION
configVersion
configHash hoặc CRC32
errorCode
~~~

ESP32-S3 phải chờ đúng configVersion và hash/CRC của transfer đang gửi. ACK của version khác là không hợp lệ và không được commit NVS.

Timeout đề xuất:

- timeout mỗi ACK frame: 200 ms;
- retry mỗi chunk: tối đa 3 lần;
- retry toàn transfer: tối đa 2 lần;
- sau toàn bộ retry thất bại: trả timeout hoặc stm32_unreachable.

Không thay đổi relay hoặc ngưỡng active hiện tại khi STM32 từ chối cấu hình.

### 7.9 Áp dụng dòng sạc

maxCurrent phải được dùng thật trong logic BMS. Nếu dòng sạc vượt ngưỡng:

- STM32 ngắt hoặc giảm sạc theo chiến lược an toàn;
- báo reason rõ ràng, ví dụ overcurrent;
- không chỉ lưu giá trị rồi bỏ qua.

Nếu việc điều khiển relay vẫn nằm ở ESP32-S3 trong giai đoạn chuyển tiếp, phải xác định rõ một nơi là nguồn quyết định duy nhất để tránh ESP32 cho phép sạc trong khi STM32 đã cắt, hoặc ngược lại. Mục tiêu cuối cùng là STM32-BMS nắm quyết định an toàn.

### 7.10 Báo trạng thái lên cloud

Thêm snapshot trong telemetry:

~~~json
{
  "bms_config_version": 42,
  "bms_config_hash": "sha256-hex-64-ky-tu",
  "bms_config_mode": "balanced",
  "bms_config_status": "applied",
  "bms_config_ack": {
    "phase": "stm32_ack",
    "status": "applied",
    "stm32Code": 0,
    "detail": "ok"
  }
}
~~~

Các trạng thái nên dùng:

~~~text
idle
received
validating
applying
applied
already_applied
rejected_validation
stale_version
stm32_rejected
stm32_unreachable
storage_error
~~~

Chỉ xóa bms_config_ack one-shot sau khi mqtt.publish() thành công. Nếu publish thất bại, telemetry sau phải gửi lại ACK. Sau reconnect, ESP32 nên gửi lại snapshot version/hash/status hiện tại để DevConsole tự phục hồi.

### 7.11 Khôi phục sau reboot và mất mạng

Trong setup():

1. Đọc active config từ NVS.
2. Đưa active config vào RAM.
3. Khởi tạo relay/BMS với cấu hình an toàn cuối cùng đã ACK.
4. Nếu có pending, hỏi STM32 bằng CMD_BMS_CONFIG_STATUS.
5. Nếu STM32 đã áp dụng pending, commit active.
6. Nếu STM32 chưa áp dụng, retry khi UART sẵn sàng.
7. Nếu không liên lạc được, giữ active cũ và báo lỗi sau khi MQTT kết nối.

Cấu hình BMS không được phụ thuộc vào cloud trong vòng điều khiển an toàn real-time. Mất Wi-Fi hoặc AWS không được làm mất cấu hình active.

## 8. Yêu cầu phía STM32-BMS

Firmware STM32 cần bổ sung:

- parser frame SOF/ID/LEN/CRC8;
- nhận BEGIN/DATA/COMMIT hoặc frame cấu hình đủ lớn;
- buffer ghép chunk có timeout và giới hạn kích thước;
- kiểm tra version, CRC32, miền giá trị và protocol version;
- lưu cấu hình vào flash/backup storage theo hai slot hoặc atomic mechanism;
- chỉ đổi active config sau commit hoàn chỉnh;
- áp dụng calibration trước khi tính điện áp, dòng và nhiệt độ;
- áp dụng maxVoltage, maxCurrent, maxSoc, minSoc và bảo vệ xả sâu;
- trả ACK đầy đủ cho từng trạng thái;
- hỗ trợ truy vấn status sau reboot;
- không trả ACK OK trước khi dữ liệu đã được ghi và áp dụng thành công.

Nếu chưa có mã nguồn STM32 trong repository, cần tạo tài liệu protocol chung hoặc header dùng chung để tránh sai endian, kích thước kiểu và sensor ID.

## 9. Thay đổi ingest và snapshot

ingest-telemetry cần:

1. Giữ các trường cấu hình trong extra hoặc xử lý bằng object riêng.
2. Validate configVersion là số nguyên không âm.
3. Validate status theo enum cho phép.
4. Chỉ cập nhật device_config_sync nếu device_id, version và hash khớp request đang pending.
5. Không cho thiết bị báo thành công cho version mà cloud chưa từng gửi.
6. Ghi system log khi chuyển sang applied, rejected hoặc timeout.
7. Không làm hỏng insert telemetry nếu object ACK bị lỗi; chỉ bỏ ACK và ghi log cảnh báo.

Nên cập nhật snapshot devices có:

- config_version_desired;
- config_version_applied;
- config_sync_status;
- config_sync_error;
- config_sync_at;
- config_hash_applied.

## 10. Kiểm thử bắt buộc

### 10.1 Cấu hình hợp lệ

- Lưu mode balanced.
- Kiểm tra database tăng config_version.
- Kiểm tra Edge Function publish đúng version, hash, cả ba mode và calibration.
- Kiểm tra ESP32 nhận JSON và ghi pending.
- Kiểm tra STM32 ACK.
- Kiểm tra ESP32 commit active.
- Kiểm tra DevConsole chuyển sang “Đã áp dụng trên STM32”.

### 10.2 maxCurrent

- Đặt dòng sạc tối đa thấp hơn dòng thực tế.
- Xác nhận STM32 thực sự giảm/ngắt sạc.
- Xác nhận telemetry báo overcurrent hoặc reason đã thống nhất.
- Đổi mode và xác nhận dòng giới hạn thay đổi.

### 10.3 Calibration

- Gửi gain/offset cho từng sensor.
- Đối chiếu raw value, giá trị sau hiệu chỉnh và telemetry.
- Nhấn Zero lại, kiểm tra offset mới được lưu và tạo version mới.
- Gửi calibration sai miền, NaN, thiếu sensor hoặc sai unit; phải bị từ chối.

### 10.4 Lỗi truyền và mất nguồn

- Làm sai CRC8 một frame.
- Bỏ mất một chunk.
- Gửi sai thứ tự chunk.
- Gửi sai CRC32 toàn bộ config.
- Ngắt nguồn ESP32 giữa lúc pending.
- Ngắt nguồn STM32 trước và sau COMMIT.
- Mất Wi-Fi sau khi STM32 đã áp dụng nhưng trước khi cloud nhận ACK.
- Publish lại cùng version/hash.
- Gửi version cũ hơn và cùng version với hash khác.

Trong mọi trường hợp, active config an toàn cuối cùng không bị ghi đè bởi dữ liệu chưa xác nhận.

## 11. Thứ tự triển khai

1. Chốt danh sách sensor, owner, đơn vị và công thức calibration.
2. Chốt protocol UART và mã lỗi với firmware STM32-BMS.
3. Tạo migration cho sensor_calibration, config_version và config_hash.
4. Tạo device_config_sync và snapshot status trên devices.
5. Hoàn thiện DevConsole lưu mode và calibration thật.
6. Tạo/cập nhật Edge Function send-bms-config.
7. Bổ sung parser, validation, queue và NVS hai pha trên ESP32-S3.
8. Bổ sung task UART duy nhất và cơ chế chunk/ACK.
9. Bổ sung STM32 nhận, lưu, áp dụng và ACK.
10. Bổ sung telemetry ACK và xử lý ingest.
11. Bổ sung UI trạng thái đồng bộ theo thiết bị.
12. Chạy toàn bộ kiểm thử lỗi và mất mạng.

## 12. Tiêu chí hoàn thành

Tính năng chỉ hoàn thành khi:

- Mọi trường cấu hình trên DevConsole đều có dữ liệu thật, không còn DemoBadge, defaultValue độc lập hoặc nút không có handler.
- maxCurrent thực sự ảnh hưởng đến bảo vệ sạc.
- ESP32-S3 lưu được active config và khôi phục sau reboot.
- STM32 xác nhận đúng version/hash của cấu hình.
- Cấu hình chỉ chuyển thành active sau ACK STM32.
- ESP32-S3 gửi lại ACK khi MQTT publish bị lỗi hoặc sau reconnect.
- DevConsole phân biệt được lưu cloud, nhận MQTT, STM32 áp dụng, từ chối và timeout.
- Cấu hình lỗi hoặc mất liên lạc không làm mất active config an toàn.
- Có test chứng minh calibration được áp dụng đúng tại STM32-BMS.
- Đường cấu hình buck-boost chưa bị trộn vào đường cấu hình BMS.
