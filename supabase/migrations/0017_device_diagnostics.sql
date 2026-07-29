-- Chẩn đoán phần cứng của từng thiết bị: uptime, nhiệt độ MCU, số lần khởi
-- động lại.
--
-- Bối cảnh: khối "Tổng quan thiết bị" trong DevConsole hiển thị các ô chẩn
-- đoán với tiêu đề "Chỉ số chẩn đoán phần cứng thời gian thực", nhưng số liệu
-- lấy từ hằng số `DIAG_BY_STATUS` trong DevConsole.jsx — chỉ đổi theo status
-- của trạm. Migration này dựng đường ống thật cho những trường đó. (Ô thứ tư,
-- "Kết nối MQTT Broker", không cần cột mới: `devices.status` đã là tín hiệu
-- thật rồi — trigger dưới đây đặt 'connected', `mark_stale_offline` (0006)
-- gạt về 'disconnected' sau 90 giây im lặng.)
--
-- Vì sao KHÔNG dùng lại `telemetry.temp_c`: đó là nhiệt độ **pack pin**
-- (`readBattery().tempC` trong firmware, trang Pin lưu trữ đang đọc đúng như
-- vậy), không phải nhiệt độ MCU. Hai đại lượng khác nhau, cần cột riêng —
-- nối ô "Nhiệt độ MCU" vào `temp_c` sẽ là gắn nhãn sai chứ không phải nối
-- vào dữ liệu thật.
--
-- Vì sao chia làm hai nơi (giống hệt 0003 và 0012):
--   * `telemetry` giữ **chuỗi thời gian** — `boot_count` đổi lúc nào cho biết
--     thiết bị reboot lúc nào, `mcu_temp_c` theo giờ cho thấy MCU nóng lên vào
--     khung nào trong ngày. Snapshot không trả lời được những câu đó.
--   * `devices` giữ **snapshot mới nhất** để UI đọc một phát ra giá trị hiện
--     tại của từng thiết bị, không phải tự đi tìm "hàng telemetry mới nhất của
--     mỗi device" (PostgREST không làm DISTINCT ON được).
-- Trigger `apply_telemetry` chép chiều telemetry → snapshot, đúng như nó đang
-- làm cho `stations` — nên KHÔNG tốn thêm round-trip nào từ Edge Function.

-- ---------------------------------------------------------------------
-- 1. telemetry: 3 cột chẩn đoán mới.
--
-- Đều nullable: firmware cũ chưa biết báo → null → UI hiện "thiết bị chưa
-- báo" thay vì đoán bừa, cùng quy ước với `ap_ssid` (0014) và `fw_version`
-- (0015).
-- ---------------------------------------------------------------------
alter table public.telemetry
  -- Giây kể từ lần khởi động gần nhất. bigint chứ không integer: int4 tràn ở
  -- ~68 năm nhưng millis() của ESP32 tràn ở 49.7 ngày và firmware cộng dồn —
  -- rẻ hơn nhiều so với việc phải đổi kiểu cột sau này.
  add column if not exists uptime_s bigint,
  -- Nhiệt độ lõi MCU (temperatureRead() trên ESP32-S3) — KHÁC `temp_c`.
  add column if not exists mcu_temp_c numeric,
  -- Bộ đếm lưu trong NVS, tăng mỗi lần boot. Reboot dồn dập = brownout/watchdog.
  add column if not exists boot_count integer;

-- ---------------------------------------------------------------------
-- 2. devices: snapshot giá trị mới nhất của chính thiết bị đó.
--
-- `devices` không có policy insert/update cho client (0003) nên không cần
-- trigger bảo vệ: người dùng vốn không tự khai được uptime cho thiết bị mình.
-- Thời điểm của snapshot chính là `last_seen_at` (firmware gửi chẩn đoán kèm
-- MỌI bản tin telemetry), nên cố tình không thêm cột `diag_reported_at` —
-- nó sẽ luôn trùng `last_seen_at`.
-- ---------------------------------------------------------------------
alter table public.devices
  add column if not exists uptime_s bigint,
  add column if not exists mcu_temp_c numeric,
  add column if not exists boot_count integer;

-- ---------------------------------------------------------------------
-- 3. Chép vào snapshot khi có telemetry.
--
-- Giữ nguyên toàn bộ hành vi của 0012 (snapshot `stations`) và mở rộng đúng
-- nhánh cập nhật `devices` vốn đã chạy sẵn cho status/last_seen_at — thêm 3
-- phép gán vào một UPDATE đã có, không phát sinh thêm lượt ghi nào.
--
-- `coalesce` để một bản tin thiếu trường không xoá giá trị đã biết trước đó:
-- thiết bị báo chẩn đoán kèm mọi bản tin, nhưng bản tin từ firmware cũ (hoặc
-- từ simulator chưa cập nhật) không được phép làm trắng bảng điều khiển.
-- ---------------------------------------------------------------------
create or replace function public.apply_telemetry()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  update public.stations s
  set
    solar_kw = coalesce(new.solar_kw, s.solar_kw),
    battery_pct = coalesce(new.battery_pct, s.battery_pct),
    battery_voltage = coalesce(new.battery_voltage, s.battery_voltage),
    battery_current = coalesce(new.battery_current, s.battery_current),
    charge_enabled = coalesce(new.charge_enabled, s.charge_enabled),
    discharge_enabled = coalesce(new.discharge_enabled, s.discharge_enabled),
    protect_reason = coalesce(new.protect_reason, s.protect_reason),
    status = 'online'
  where s.id = new.station_id;

  if new.device_id is not null then
    update public.devices d
    set status = 'connected',
        last_seen_at = new.ts,
        uptime_s = coalesce(new.uptime_s, d.uptime_s),
        mcu_temp_c = coalesce(new.mcu_temp_c, d.mcu_temp_c),
        boot_count = coalesce(new.boot_count, d.boot_count)
    where d.id = new.device_id;
  end if;

  return new;
end;
$$;
