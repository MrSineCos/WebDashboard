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

# --- Tải mà "ESP32 giả lập" này điều khiển (khớp firmware relays[]) ---
# Khoá = loads.id (UUID) đã tạo ở Dashboard → Điều khiển tải → + Thêm tải,
# với "Thiết bị điều khiển" chọn đúng thiết bị có aws_thing_name = THING_NAME
# ở trên. Để trống {} nếu chỉ muốn gửi telemetry, không cần test điều khiển
# tải. `watt` chỉ ảnh hưởng tới load_w giả lập cho có ý nghĩa, không bắt buộc
# khớp với watt đã khai trên Dashboard.
RELAYS = {
    # "3f2a1c9e-xxxx-xxxx-xxxx-xxxxxxxxxxxx": {"watt": 250, "state": False},
}
