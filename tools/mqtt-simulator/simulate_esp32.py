#!/usr/bin/env python3
"""
SolGrid — mô phỏng ESP32 bằng MQTT client Python (thay thế phần cứng thật
để test end-to-end AWS IoT Core -> ingest-telemetry -> Supabase -> Dashboard).

Đi đúng đường thật của firmware (firmware/esp32s3.ino): kết nối TLS mutual-auth
(X.509) tới AWS IoT Core, publish telemetry định kỳ lên
`solgrid/<station_slug>/telemetry`, subscribe `solgrid/<thing_name>/command`
để nhận lệnh bật/tắt tải (docs/IOT.md mục 6) và ngưỡng bảo vệ sạc/xả pin
(mục 8) từ Dashboard.

Payload gửi lên bám theo `publishTelemetry()` của firmware — mọi trường mà
`ingest-telemetry` biết đọc, để các thẻ trên Dashboard (Dòng pin, Điều khiển
bảo vệ sạc/xả, Chẩn đoán phần cứng) có dữ liệu thật thay vì trống.

Cấu hình: sao chép config.example.py -> config.py rồi điền giá trị thật.

Cài đặt:
    pip install -r requirements.txt

Chạy:
    python simulate_esp32.py
    python simulate_esp32.py --interval 5   # ghi đè chu kỳ gửi (giây)
"""

import argparse
import json
import os
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


# Ngưỡng mặc định + dải trễ, lấy đúng theo `BatteryConfig` và các hằng
# SOC_*_RESUME_MARGIN / VOLT_CHARGE_RESUME_MARGIN trong firmware/esp32s3.ino.
# Firmware giữ ngưỡng trong NVS nên sống qua reboot; ở đây chỉ giữ trong RAM —
# chạy lại script là quay về mặc định (tương đương mode `balanced`).
DEFAULT_PROTECT = {
    "minSoc": 20.0,
    "maxSoc": 90.0,
    "maxVoltage": 54.6,
    "deepDischargeProtect": True,
}
SOC_CHARGE_RESUME_MARGIN = 3.0
SOC_DISCHARGE_RESUME_MARGIN = 5.0
VOLT_CHARGE_RESUME_MARGIN = 0.4


class StationSimulator:
    """Giữ trạng thái mô phỏng (pin, tải...) qua các lần publish, để dữ liệu
    trôi mượt theo thời gian thay vì random hoàn toàn mỗi lần gửi."""

    def __init__(self):
        self.battery_pct = 70.0
        self.battery_voltage = self._voltage()
        self.relays = {load_id: dict(cfg) for load_id, cfg in config.RELAYS.items()}
        # Chẩn đoán phần cứng (migration 0017). Mốc thời gian bắt đầu tiến
        # trình = "lần boot" của thiết bị giả lập; boot_count đếm số lần chạy
        # script, giữ trong một file cạnh config để sống qua các lần khởi động
        # lại — đúng vai trò bộ đếm NVS trên ESP32 thật.
        self.started_at = time.time()
        self.boot_count = self._bump_boot_count()
        # Bảo vệ sạc/xả (migration 0012). Cloud chỉ đẩy ngưỡng xuống; quyết
        # định đóng/cắt nằm ở đây, giống applyProtection() của firmware.
        self.protect = dict(DEFAULT_PROTECT)
        self.charge_enabled = True
        self.discharge_enabled = True
        self.protect_reason = "ok"
        # ap_ssid/ap_password (mục 9) và fw_version (mục 10) chỉ gửi ở bản tin
        # ĐẦU TIÊN sau mỗi lần (re)connect, đúng như firmware: giá trị gần như
        # không đổi nên nhân bản vào mọi bản tin là lãng phí.
        self.reported_after_connect = False

    @staticmethod
    def _bump_boot_count():
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".boot_count")
        try:
            with open(path) as f:
                count = int(f.read().strip()) + 1
        except (OSError, ValueError):
            count = 1
        try:
            with open(path, "w") as f:
                f.write(str(count))
        except OSError:
            pass  # chỉ là số liệu chẩn đoán — không đáng làm hỏng lần chạy
        return count

    def _voltage(self):
        # Pack 48V: 42V khi cạn, 54V khi đầy. Không cộng nhiễu ngẫu nhiên vì
        # điện áp này còn dùng để quyết định ngắt sạc (maxVoltage 54.6V) —
        # nhiễu sẽ khiến relay giả lập nhấp nháy quanh ngưỡng.
        return round(42 + (self.battery_pct / 100) * 12, 1)

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

    def apply_protection(self):
        """Bản Python của applyProtection() trong firmware — cùng ngưỡng, cùng
        dải trễ, cùng bộ chuỗi protect_reason mà trang Pin lưu trữ biết dịch."""
        cfg = self.protect
        if self.battery_voltage >= cfg["maxVoltage"]:
            self.charge_enabled = False
            self.protect_reason = "overvoltage"
        elif self.battery_pct >= cfg["maxSoc"]:
            self.charge_enabled = False
            self.protect_reason = "full"
        elif not self.charge_enabled:
            volt_ok = self.battery_voltage < cfg["maxVoltage"] - VOLT_CHARGE_RESUME_MARGIN
            soc_ok = self.battery_pct < cfg["maxSoc"] - SOC_CHARGE_RESUME_MARGIN
            if volt_ok and soc_ok:
                self.charge_enabled = True

        if cfg["deepDischargeProtect"] and self.battery_pct <= cfg["minSoc"]:
            self.discharge_enabled = False
            self.protect_reason = "deep_discharge"
        elif not self.discharge_enabled:
            if self.battery_pct > cfg["minSoc"] + SOC_DISCHARGE_RESUME_MARGIN:
                self.discharge_enabled = True

        if self.charge_enabled and self.discharge_enabled:
            self.protect_reason = "ok"

    def tick(self):
        now = datetime.now()
        solar_kw = round(self.solar_kw(now.hour), 2)
        load_w = round(self.base_load_w() + self.relay_load_w(), 1)

        # Pin trôi theo chênh lệch năng lượng nạp/xả — chỉ để giả lập có vẻ
        # thật, không phải mô hình pin chính xác. Đường nào bị bảo vệ ngắt thì
        # không đóng góp vào cán cân, đúng như relay sạc/xả thật bị cắt.
        charge_w = solar_kw * 1000 if self.charge_enabled else 0.0
        discharge_w = load_w if self.discharge_enabled else 0.0
        net_w = charge_w - discharge_w
        self.battery_pct = min(100.0, max(0.0, self.battery_pct + net_w / 20000))
        self.battery_voltage = self._voltage()
        self.apply_protection()

        # Quy ước dấu: DƯƠNG = đang nạp, ÂM = đang xả. Chỉ để thẻ "Dòng pin"
        # (thay cho ô SOH cũ) có số thật; bộ đếm chu kỳ ở migration 0020 KHÔNG
        # dùng cột này (xem docs/IOT.md mục 8.5).
        battery_current = round(net_w / max(self.battery_voltage, 1.0), 1)
        temp_c = round(28 + (solar_kw * 3) + random.uniform(-1.5, 1.5), 1)
        rssi = random.randint(-75, -40)

        payload = {
            "solar_kw": solar_kw,
            "battery_pct": round(self.battery_pct, 1),
            "battery_voltage": self.battery_voltage,
            "battery_current": battery_current,
            "load_w": load_w,
            # Nhiệt độ pack pin. (Nhiệt độ lõi MCU đã bỏ hẳn ở migration 0029 —
            # không gửi `mcu_temp_c` nữa, ingest cũng đã ngừng nhận.)
            "temp_c": temp_c,
            "rssi": rssi,
            "uptime_s": int(time.time() - self.started_at),
            "boot_count": self.boot_count,
            "charge_enabled": self.charge_enabled,
            "discharge_enabled": self.discharge_enabled,
            "protect_reason": self.protect_reason,
        }
        if self.relays:
            payload["loads"] = {
                load_id: ("on" if r["state"] else "off") for load_id, r in self.relays.items()
            }

        # Bản tin đầu sau mỗi lần (re)connect: khai cấu hình SoftAP và phiên
        # bản firmware đang chạy. Cả ba đều tuỳ chọn — không khai trong
        # config.py thì đơn giản là không gửi, ingest-telemetry bỏ qua.
        if not self.reported_after_connect:
            ap_ssid = getattr(config, "AP_SSID", None)
            ap_password = getattr(config, "AP_PASSWORD", None)
            if ap_ssid and ap_password:
                payload["ap_ssid"] = ap_ssid
                payload["ap_password"] = ap_password
            fw_version = getattr(config, "FW_VERSION", None)
            if fw_version:
                payload["fw_version"] = fw_version
            self.reported_after_connect = True

        return payload

    def apply_command(self, load_id, action):
        relay = self.relays.get(load_id)
        if relay is None:
            print(f"  (bỏ qua — {load_id} không có trong RELAYS của config.py)")
            return False
        relay["state"] = action == "on"
        return True

    def apply_battery_config(self, cmd):
        """Lệnh `{type:"battery_config"}` từ send-battery-config (mục 8).
        Nhận đúng các trường firmware nhận; `maxCurrent` cloud có gửi nhưng
        firmware hiện chưa dùng nên ở đây cũng chỉ in ra."""
        for key in ("minSoc", "maxSoc", "maxVoltage"):
            value = cmd.get(key)
            if isinstance(value, (int, float)):
                self.protect[key] = float(value)
        if isinstance(cmd.get("deepDischargeProtect"), bool):
            self.protect["deepDischargeProtect"] = cmd["deepDischargeProtect"]
        self.apply_protection()
        cfg = self.protect
        print(
            f"  battery_config mode={cmd.get('mode', '?')} minSoc={cfg['minSoc']:.0f} "
            f"maxSoc={cfg['maxSoc']:.0f} maxV={cfg['maxVoltage']:.1f} "
            f"ddp={cfg['deepDischargeProtect']} (maxCurrent={cmd.get('maxCurrent')}, chưa dùng)"
        )


sim = StationSimulator()
command_topic = f"solgrid/{config.THING_NAME}/command"
telemetry_topic = f"solgrid/{config.STATION_SLUG}/telemetry"


def rc_failed(rc):
    """paho 2.x trả về ReasonCode, paho 1.x trả về int — đọc được cả hai."""
    is_failure = getattr(rc, "is_failure", None)
    return bool(is_failure) if is_failure is not None else rc != 0


# Chữ ký callback khác nhau giữa paho 1.x và 2.x (2.x thêm reason_code/
# properties), nên các hàm dưới đây nuốt phần đuôi bằng *args.
def on_connect(client, userdata, flags, reason_code, *args):
    if rc_failed(reason_code):
        print(f"Kết nối AWS IoT thất bại, rc={reason_code}")
        return
    print(f"Đã kết nối AWS IoT Core như '{config.THING_NAME}'")
    # Reconnect = khai lại AP/fw_version ở bản tin kế, giống firmware.
    sim.reported_after_connect = False
    client.subscribe(command_topic)
    print(f"Đã subscribe {command_topic}")


def on_message(client, userdata, msg):
    try:
        cmd = json.loads(msg.payload.decode())
    except json.JSONDecodeError:
        print(f"Lệnh không đọc được từ {msg.topic}: {msg.payload!r}")
        return

    # Cùng cách phân nhánh với onCommand() của firmware: có `type` thì là lệnh
    # cấu hình/OTA, không có thì là lệnh bật/tắt tải của send-load-command.
    cmd_type = cmd.get("type")
    if cmd_type == "battery_config":
        print("Nhận lệnh: battery_config")
        sim.apply_battery_config(cmd)
        return
    if cmd_type == "ota":
        print(
            f"Nhận lệnh: ota {cmd.get('version')} ({cmd.get('board')}) — simulator "
            "không mô phỏng nạp firmware, thiết bị sẽ đứng ở trạng thái 'pending' "
            "trên DevConsole."
        )
        return
    if cmd_type:
        print(f"Lệnh type='{cmd_type}' chưa hỗ trợ: {cmd}")
        return

    load_id, action = cmd.get("load_id"), cmd.get("action")
    if not load_id or action not in ("on", "off"):
        print(f"Lệnh thiếu load_id/action: {cmd}")
        return

    print(f"Nhận lệnh: {load_id} -> {action}")
    sim.apply_command(load_id, action)


def on_disconnect(client, userdata, *args):
    # paho 1.x: (rc[, properties]) — paho 2.x: (disconnect_flags, reason_code, properties)
    reason_code = args[1] if len(args) >= 3 else args[0]
    if rc_failed(reason_code):
        print(f"Mất kết nối ngoài ý muốn (rc={reason_code}), paho sẽ tự reconnect...")


def on_publish(client, userdata, mid, *args):
    # Broker đã PUBACK (QoS 1) — nghĩa là AWS IoT Core THẬT SỰ nhận được tin,
    # khác với việc client.publish() chỉ xếp hàng gửi (in ra ngay cả khi mất
    # kết nối). Nếu không thấy dòng "broker đã nhận" nào dù publish() không
    # báo lỗi, nghĩa là kết nối có vấn đề chứ không phải lỗi ở AWS Rule/Supabase.
    print(f"  ↳ broker đã nhận (mid={mid})")


def build_client():
    # paho 2.0 bỏ constructor cũ: phải truyền CallbackAPIVersion, nếu không sẽ
    # ValueError ngay khi khởi tạo. Vẫn chạy được với paho 1.6 (không có enum
    # này) để không bắt buộc nâng cấp môi trường đang chạy.
    try:
        CallbackAPIVersion = mqtt.CallbackAPIVersion
    except AttributeError:
        CallbackAPIVersion = None

    if CallbackAPIVersion is not None:
        client = mqtt.Client(CallbackAPIVersion.VERSION2, client_id=config.THING_NAME)
    else:
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
