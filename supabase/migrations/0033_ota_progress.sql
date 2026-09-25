-- Phần trăm tiến trình OTA gần nhất do MCU báo về.
--
-- `fw_status` (0015) chỉ cho biết thiết bị đang tải hay đang nạp, chưa cho biết
-- đã đi được bao xa. Giá trị này là snapshot trên `devices`, không bị sao chép
-- thành một cột trong từng hàng telemetry lịch sử.
--
-- Quy ước:
--   * null: chưa có lần OTA nào / firmware cũ chưa hỗ trợ báo phần trăm
--   * 0: cloud vừa gửi lệnh hoặc MCU vừa bắt đầu tải
--   * 1..99: số byte ảnh firmware đã tải và ghi vào OTA partition
--   * 100: ảnh đã ghi, kiểm hash và kích hoạt xong; thiết bị sắp reboot
alter table public.devices
  add column if not exists fw_progress smallint
    check (fw_progress between 0 and 100);

comment on column public.devices.fw_progress is
  'OTA progress percent (0..100) last reported by the device; null when unsupported/not started';
