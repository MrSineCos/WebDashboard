-- 0027 — Đưa `stations` vào publication realtime
--
-- Tiếp nối 0026 (telemetry/loads). Bảng này bị bỏ sót vì nó không có
-- subscription nào cả cho tới nay: `useStations` chỉ truy vấn một lần lúc mở
-- trang. Nhưng MỌI thứ đổi `stations.status` đều chạy ở phía server —
-- apply_telemetry đặt 'online' khi có bản tin (0003), mark_stale_offline của
-- pg_cron đặt 'offline' sau 90 giây im lặng (0004/0006) — nên trình duyệt
-- không có cách nào tự biết trạng thái đã đổi.
--
-- Triệu chứng ngoài giao diện: ESP32 gửi telemetry lên mà ô "Trạng thái hệ
-- thống" vẫn đứng ở giá trị cũ; ngắt kết nối thì chuông cảnh báo kêu đúng giờ
-- (bảng `alerts` đã ở trong publication từ 0023) nhưng ô trạng thái vẫn ghi
-- "Ổn định". Chỉ rời trang rồi quay lại mới thấy đúng, vì lúc đó hook chạy lại
-- truy vấn.
--
-- KHÔNG đặt `replica identity full`: client chỉ nghe INSERT/UPDATE (xem chú
-- thích trong lib/stations.js), và bảng này bị apply_telemetry ghi mỗi bản tin
-- telemetry nên đây là bảng nóng thứ hai sau `telemetry` — bật FULL chỉ làm
-- WAL phình mà không thêm được sự kiện nào đang dùng tới.
do $$
begin
  alter publication supabase_realtime add table public.stations;
exception
  when undefined_object then null;   -- chưa có publication
  when duplicate_object then null;   -- đã thêm rồi
end;
$$;
