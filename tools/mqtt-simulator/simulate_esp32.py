#!/usr/bin/env python3
"""
SolGrid — mô phỏng ESP32 bằng MQTT client Python (thay thế phần cứng thật
để test end-to-end AWS IoT Core -> ingest-telemetry -> Supabase -> Dashboard).

Đi đúng đường thật của firmware (firmware/esp32-solgrid/esp32-solgrid.ino):
kết nối TLS mutual-auth (X.509) tới AWS IoT Core, publish telemetry định kỳ
lên `solgrid/<station_slug>/telemetry`, subscribe `solgrid/<thing_name>/command`
để nhận lệnh bật/tắt tải từ Dashboard (xem docs/IOT.md mục 6).

Cấu hình: sao chép config.example.py -> config.py rồi điền giá trị thật.

Cài đặt:
    pip install -r requirements.txt

Chạy:
    python simulate_esp32.py
    python simulate_esp32.py --interval 5   # ghi đè chu kỳ gửi (giây)
"""

import argparse
import json
import random
import signal
import ssl
import sys
import time
from datetime import datetime

import paho.mqtt.client as mqtt

try:
    import config
except ImportError:
    sys.exit(
        "Thiếu config.py — sao chép config.example.py thành config.py rồi điền "
        "endpoint/thing name/đường dẫn cert trước khi chạy."
    )


class StationSimulator:
    """Giữ trạng thái mô phỏng (pin, tải...) qua các lần publish, để dữ liệu
    trôi mượt theo thời gian thay vì random hoàn toàn mỗi lần gửi."""

    def __init__(self):
        self.battery_pct = 70.0
        self.relays = {load_id: dict(cfg) for load_id, cfg in config.RELAYS.items()}

    def solar_kw(self, hour):
        # Đường cong hình chuông, đạt đỉnh ~giữa trưa, bằng 0 ngoài khung 6h-18h.
        if hour < 6 or hour > 18:
            return 0.0
        x = (hour - 12) / 6
        peak = 3.0
        return max(0.0, peak * (1 - x * x) + random.uniform(-0.15, 0.15))

    def relay_load_w(self):
        return sum(r["watt"] for r in self.relays.values() if r["state"])

    def base_load_w(self):
        return random.uniform(300, 700)

    def tick(self):
        now = datetime.now()
        solar_kw = round(self.solar_kw(now.hour), 2)
        load_w = round(self.base_load_w() + self.relay_load_w(), 1)

        # Pin trôi theo chênh lệch năng lượng nạp/xả — chỉ để giả lập có vẻ
        # thật, không phải mô hình pin chính xác.
        net_w = solar_kw * 1000 - load_w
        self.battery_pct = min(100.0, max(0.0, self.battery_pct + net_w / 20000))
        battery_voltage = round(42 + (self.battery_pct / 100) * 12 + random.uniform(-0.2, 0.2), 1)
        temp_c = round(28 + (solar_kw * 3) + random.uniform(-1.5, 1.5), 1)
        rssi = random.randint(-75, -40)

        payload = {
            "solar_kw": solar_kw,
            "battery_pct": round(self.battery_pct, 1),
            "battery_voltage": battery_voltage,
            "load_w": load_w,
            "temp_c": temp_c,
            "rssi": rssi,
        }
        if self.relays:
            payload["loads"] = {
                load_id: ("on" if r["state"] else "off") for load_id, r in self.relays.items()
            }
        return payload

    def apply_command(self, load_id, action):
        relay = self.relays.get(load_id)
        if relay is None:
            print(f"  (bỏ qua — {load_id} không có trong RELAYS của config.py)")
            return False
        relay["state"] = action == "on"
        return True


sim = StationSimulator()
command_topic = f"solgrid/{config.THING_NAME}/command"
telemetry_topic = f"solgrid/{config.STATION_SLUG}/telemetry"


def on_connect(client, userdata, flags, rc):
    if rc != 0:
        print(f"Kết nối AWS IoT thất bại, rc={rc}")
        return
    print(f"Đã kết nối AWS IoT Core như '{config.THING_NAME}'")
    client.subscribe(command_topic)
    print(f"Đã subscribe {command_topic}")


def on_message(client, userdata, msg):
    try:
        cmd = json.loads(msg.payload.decode())
    except json.JSONDecodeError:
        print(f"Lệnh không đọc được từ {msg.topic}: {msg.payload!r}")
        return

    load_id, action = cmd.get("load_id"), cmd.get("action")
    if not load_id or action not in ("on", "off"):
        print(f"Lệnh thiếu load_id/action: {cmd}")
        return

    print(f"Nhận lệnh: {load_id} -> {action}")
    sim.apply_command(load_id, action)


def on_disconnect(client, userdata, rc):
    if rc != 0:
        print(f"Mất kết nối ngoài ý muốn (rc={rc}), paho sẽ tự reconnect...")


def on_publish(client, userdata, mid):
    # Broker đã PUBACK (QoS 1) — nghĩa là AWS IoT Core THẬT SỰ nhận được tin,
    # khác với việc client.publish() chỉ xếp hàng gửi (in ra ngay cả khi mất
    # kết nối). Nếu không thấy dòng "broker đã nhận" nào dù publish() không
    # báo lỗi, nghĩa là kết nối có vấn đề chứ không phải lỗi ở AWS Rule/Supabase.
    print(f"  ↳ broker đã nhận (mid={mid})")


def build_client():
    client = mqtt.Client(client_id=config.THING_NAME)
    client.tls_set(
        ca_certs=config.CA_CERT_PATH,
        certfile=config.DEVICE_CERT_PATH,
        keyfile=config.DEVICE_KEY_PATH,
        tls_version=ssl.PROTOCOL_TLSv1_2,
    )
    client.on_connect = on_connect
    client.on_message = on_message
    client.on_disconnect = on_disconnect
    client.on_publish = on_publish
    return client


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--interval", type=float, default=config.PUBLISH_INTERVAL_SECONDS,
        help="Chu kỳ gửi telemetry (giây), mặc định lấy từ config.py",
    )
    args = parser.parse_args()

    client = build_client()
    client.connect(config.AWS_IOT_ENDPOINT, config.AWS_IOT_PORT)
    client.loop_start()

    stop = False

    def handle_sigint(signum, frame):
        nonlocal stop
        stop = True

    signal.signal(signal.SIGINT, handle_sigint)

    print(f"Publish mỗi {args.interval}s lên {telemetry_topic} (Ctrl+C để dừng)")
    try:
        while not stop:
            payload = sim.tick()
            body = json.dumps(payload)
            connected = client.is_connected()
            info = client.publish(telemetry_topic, body, qos=1)
            status = "queued" if connected and info.rc == mqtt.MQTT_ERR_SUCCESS else f"LỖI rc={info.rc}"
            if not connected:
                status = "CHƯA KẾT NỐI — tin này chắc chắn KHÔNG tới được AWS"
            print(f"[{datetime.now().strftime('%H:%M:%S')}] publish ({status}) -> {body}")
            time.sleep(args.interval)
    finally:
        client.loop_stop()
        client.disconnect()
        print("Đã ngắt kết nối.")


if __name__ == "__main__":
    main()
