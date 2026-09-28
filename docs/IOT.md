# SolGrid IoT — tài liệu kết nối thiết bị thật

Nội dung IoT đã được tách theo từng nhóm chức năng để dễ tra cứu và bảo trì. Các tài liệu bên dưới giữ nguyên quy trình, cấu hình và ví dụ kỹ thuật từ tài liệu gốc.

## Bắt đầu từ đâu

Nếu thiết lập hệ thống từ đầu, đọc theo thứ tự:

1. [Kiến trúc và đăng ký thiết bị](iot/01-architecture-and-device-onboarding.md) — luồng dữ liệu, Supabase, AWS IoT Core và provisioning.
2. [Firmware, điều khiển tải và telemetry](iot/02-firmware-load-control-and-telemetry.md) — firmware ESP32, tải, telemetry và ngưỡng sạc/xả.
3. [SoftAP và OTA](iot/03-softap-and-ota.md) — mạng WiFi cục bộ và cập nhật firmware qua mạng.
4. [Chẩn đoán, nhật ký và lưu trữ](iot/04-diagnostics-logs-and-retention.md) — chẩn đoán phần cứng, log hệ thống và dọn dữ liệu.
5. [Cài đặt, cảnh báo và thông báo đẩy](iot/05-settings-alerts-and-push.md) — múi giờ, đơn vị năng lượng, cảnh báo và push notification.
6. [Chẩn đoán realtime](iot/06-realtime-troubleshooting.md) — các nguyên nhân dashboard đứng số và hướng xử lý.

## Tra cứu nhanh

| Chủ đề | Tài liệu |
| --- | --- |
| Kết nối thiết bị thật | [01 — Architecture & device onboarding](iot/01-architecture-and-device-onboarding.md) |
| Firmware, tải, telemetry | [02 — Firmware, load control & telemetry](iot/02-firmware-load-control-and-telemetry.md) |
| SoftAP, OTA | [03 — SoftAP & OTA](iot/03-softap-and-ota.md) |
| Chẩn đoán, log, retention | [04 — Diagnostics, logs & retention](iot/04-diagnostics-logs-and-retention.md) |
| Cài đặt, cảnh báo, push | [05 — Settings, alerts & push](iot/05-settings-alerts-and-push.md) |
| Realtime troubleshooting | [06 — Realtime troubleshooting](iot/06-realtime-troubleshooting.md) |

> [!NOTE]
> Mục [Ngoài phạm vi (làm sau)](iot/06-realtime-troubleshooting.md#ngoài-phạm-vi-làm-sau) vẫn được giữ ở cuối tài liệu realtime.
