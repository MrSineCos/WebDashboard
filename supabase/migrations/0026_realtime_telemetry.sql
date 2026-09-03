-- 0026 — Đưa `telemetry` và `loads` vào publication realtime
--
-- Vì sao cần: Dashboard đã subscribe postgres_changes trên hai bảng này từ
-- đầu (lib/telemetry.js, lib/loads.js), nhưng chưa migration nào thêm chúng
-- vào `supabase_realtime`. Postgres chỉ đẩy thay đổi của những bảng NẰM TRONG
-- publication, nên các subscription đó im lặng không bao giờ nhận được gì —
-- kênh vẫn "subscribed" thành công, chỉ là không có sự kiện nào tới.
--
-- Triệu chứng ngoài giao diện: các ô thông số ở trang Giám sát đứng yên trong
-- lúc người dùng đang mở màn hình theo dõi, và chỉ nhảy số khi có thứ gì đó
-- buộc trang tải lại dữ liệu (đổi trạm, F5, chuyển cửa sổ rồi quay lại). Đúng
-- cùng lỗi mà 0018 đã gặp với `system_logs` — xem bảng sự cố ở docs/IOT.md.
--
-- Bọc trong DO theo đúng cách của 0018/0023: publication có thể chưa tồn tại
-- trên môi trường local mới dựng, và thêm lại một bảng đã có sẵn (ví dụ ai đó
-- đã bật bằng tay trong Supabase Studio → Database → Replication) sẽ báo lỗi.
do $$
begin
  alter publication supabase_realtime add table public.telemetry;
exception
  when undefined_object then null;   -- chưa có publication
  when duplicate_object then null;   -- đã thêm rồi
end;
$$;

do $$
begin
  alter publication supabase_realtime add table public.loads;
exception
  when undefined_object then null;
  when duplicate_object then null;
end;
$$;

-- `loads` subscribe event '*' (kể cả DELETE) KÈM filter `station_id=eq...`.
-- Với replica identity mặc định, bản ghi cũ của một DELETE chỉ mang theo khoá
-- chính, nên Realtime không có `station_id` để đối chiếu filter và sự kiện xoá
-- bị loại bỏ — tải đã xoá vẫn nằm lại trên màn hình của các phiên khác cho tới
-- khi tải lại trang. FULL đưa toàn bộ cột cũ vào WAL để filter đúng.
--
-- KHÔNG đặt FULL cho `telemetry`: bảng này chỉ INSERT (INSERT luôn mang đủ cột
-- dù replica identity là gì), lại là bảng ghi dày nhất hệ thống — bật FULL chỉ
-- làm WAL phình ra mà không đổi được gì.
alter table public.loads replica identity full;
