-- 0028 — Đưa `devices` vào publication realtime
--
-- Tiếp nối 0026 (telemetry/loads) và 0027 (stations). Bảng này bị bỏ sót vì
-- `useDevices` chỉ truy vấn một lần lúc mở trang, trong khi mọi thứ ghi vào
-- snapshot của nó đều chạy ở phía server: trigger `apply_telemetry` đặt
-- status='connected' + last_seen_at + uptime_s/mcu_temp_c/boot_count mỗi bản
-- tin (0017), `mark_stale_offline` của pg_cron gạt về 'disconnected' sau 90
-- giây im lặng (0004/0006), và send-ota-command/telemetry đổi fw_status,
-- fw_version, ap_ssid (0014/0015).
--
-- Triệu chứng ngoài giao diện: chạy simulator (hoặc ESP32 thật), đèn trạng
-- thái TRẠM chuyển xanh ngay — `stations` đã có realtime từ 0027 — nhưng khối
-- "Tổng quan thiết bị" trong DevConsole vẫn đứng nguyên số cũ: Thời gian hoạt
-- động / Nhiệt độ MCU / Số lần khởi động lại giữ giá trị của lần tải trang,
-- "Kết nối MQTT Broker" vẫn ghi Disconnected, và dòng "nhận dữ liệu N phút
-- trước" cứ già đi. Hai ô cạnh nhau nói hai chuyện trái ngược về cùng một
-- trạm. Chỉ F5 mới thấy đúng.
--
-- KHÔNG đặt `replica identity full`: client chỉ nghe INSERT/UPDATE (xem chú
-- thích trong lib/telemetry.js — xoá thiết bị đã tự sửa state ngay tại phiên
-- thực hiện), nên bản ghi cũ của DELETE không cần có mặt trong WAL. Cùng lý
-- do với 0027, và `devices` cũng bị ghi mỗi bản tin telemetry.
do $$
begin
  alter publication supabase_realtime add table public.devices;
exception
  when undefined_object then null;   -- chưa có publication
  when duplicate_object then null;   -- đã thêm rồi
end;
$$;
