# Sao chép file này thành `config.py` và điền giá trị thật.
# `config.py` đã được .gitignore — không commit endpoint/thing name thật nếu
# bạn coi đó là nhạy cảm (bản thân cert/key luôn bị .gitignore ở gốc repo).

# --- AWS IoT Core ---
# Lấy bằng: aws iot describe-endpoint --endpoint-type iot:Data-ATS
AWS_IOT_ENDPOINT = "xxxxxxxxxx-ats.iot.ap-southeast-1.amazonaws.com"
AWS_IOT_PORT = 8883

# --- Định danh thiết bị ---
# THING_NAME phải trùng client id đã dùng khi tạo cert (aws iot create-thing)
# VÀ trùng cột `devices.aws_thing_name` của hàng đã đăng ký cho Trạm 01 ở
# DevConsole → Quản lý trạm → + Thêm thiết bị. Đây là thứ thật sự quyết định
# dữ liệu rơi vào trạm nào — không phải STATION_SLUG bên dưới.
THING_NAME = "solgrid-esp32-01"

# STATION_SLUG chỉ dùng để dựng tên topic (solgrid/<slug>/telemetry), cho khớp
# với SQL của AWS IoT Rule (`FROM 'solgrid/+/telemetry'`) và Resource trong
# IoT policy (`topic/solgrid/*/telemetry`). Đặt gì cũng được miễn khớp policy.
STATION_SLUG = "tram01"

# --- Chứng chỉ X.509 của thiết bị (cấp qua `aws iot create-keys-and-certificate`) ---
CA_CERT_PATH = "./certs/AmazonRootCA1.pem"
DEVICE_CERT_PATH = "./certs/cert.pem"
DEVICE_KEY_PATH = "./certs/priv.key"

# --- Chu kỳ gửi dữ liệu ---
PUBLISH_INTERVAL_SECONDS = 10

# --- Tuỳ chọn: cấu hình thiết bị tự khai (chỉ gửi ở bản tin đầu sau mỗi lần
# kết nối, đúng như firmware) ---
# SoftAP mà "ESP32" này phát (docs/IOT.md mục 9) → DevConsole → Cấu hình mạng.
# Bỏ trống/xoá hai dòng này thì simulator không gửi, DevConsole sẽ hiện
# "Thiết bị chưa báo cấu hình AP". SSID ≤ 32 byte, mật khẩu 8–63 ký tự, sai
# giới hạn là ingest-telemetry bỏ qua kèm cảnh báo trong log.
AP_SSID = ""
AP_PASSWORD = ""

# Phiên bản firmware "đang chạy" (mục 10) → DevConsole → Quản lý Firmware MCU.
# Đặt trùng `version` của một hàng firmware_releases để thử luồng OTA phía
# cloud. Lưu ý simulator KHÔNG mô phỏng việc nạp: lệnh "Đẩy OTA" chỉ được ghi
# log, thiết bị sẽ nằm ở trạng thái 'pending' cho tới khi bạn sửa giá trị này
# thành phiên bản vừa đẩy rồi chạy lại script.
FW_VERSION = ""

# --- Tải mà "ESP32 giả lập" này điều khiển (khớp firmware relays[]) ---
# Khoá = loads.id (UUID) đã tạo ở Dashboard → Điều khiển tải → + Thêm tải,
# với "Thiết bị điều khiển" chọn đúng thiết bị có aws_thing_name = THING_NAME
# ở trên. Để trống {} nếu chỉ muốn gửi telemetry, không cần test điều khiển
# tải. `watt` chỉ ảnh hưởng tới load_w giả lập cho có ý nghĩa, không bắt buộc
# khớp với watt đã khai trên Dashboard.
RELAYS = {
    # "3f2a1c9e-xxxx-xxxx-xxxx-xxxxxxxxxxxx": {"watt": 250, "state": False},
}
