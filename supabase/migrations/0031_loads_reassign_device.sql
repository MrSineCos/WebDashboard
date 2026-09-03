-- Gán lại thiết bị điều khiển cho một tải ĐÃ TẠO.
--
-- Trước migration này `loads.device_id` chỉ đặt được đúng một lần, ở form
-- "+ Thêm tải": client không có đường update nào cho bảng `loads`. Hậu quả là
-- xoá một ESP32 (khoá ngoại `on delete set null`, migration 0010) biến mọi tải
-- của nó thành vĩnh viễn không điều khiển được — cách duy nhất để cứu là xoá
-- tải rồi tạo lại. Chính DevConsole đã hứa với người dùng điều ngược lại khi
-- cảnh báo lúc xoá thiết bị ("…cho tới khi gán lại").
--
-- Phần QUYỀN không phải thêm gì: policy `loads_update_own` (0010) đã cho chủ
-- tải update hàng của mình. Thứ còn thiếu là một BẤT BIẾN — đổi thiết bị thì
-- những gì ta biết về trạng thái relay phải mất hiệu lực.
--
-- Vì sao phải xoá `reported_state` / `reported_at`:
--   Ý nghĩa của hai cột là "thiết bị ĐÓ đã xác nhận relay đang ở trạng thái
--   này". Gán tải sang một ESP32 khác thì câu đó không còn đúng với ai cả:
--   thiết bị mới chưa từng ack. Giữ nguyên sẽ khiến dashboard hiện trạng thái
--   relay của thiết bị CŨ như thể là của thiết bị mới, vì giao diện ưu tiên
--   `reported_state` hơn `desired_state` (xem Dashboard.jsx). Với một cái máy
--   bơm, đó là hiện "Đã tắt" trong khi relay mới có thể đang đóng.
--
-- Vì sao xoá luôn `desired_state`:
--   Nó là lệnh đã gửi tới thiết bị CŨ qua send-load-command. Thiết bị mới chưa
--   nhận lệnh nào, mà relay ESP32 mặc định mở lúc khởi động, nên `false` mô tả
--   thực tế sát hơn. Không reset thì một tải đang bật sau khi gán lại sẽ hiện
--   "Đang bật" dù chưa hề có lệnh nào tới thiết bị mới.
--
-- LƯU Ý VẬN HÀNH: gán lại KHÔNG tự tắt relay trên thiết bị cũ — thiết bị cũ có
-- thể đã bị xoá hoặc đang mất mạng, nên không có cách nào đảm bảo lệnh tắt tới
-- nơi. Giao diện nói thẳng điều này ngay dưới danh sách tải.
--
-- Sửa TRONG hàm trigger sẵn có thay vì thêm trigger thứ hai: hai trigger BEFORE
-- UPDATE trên cùng một bảng chạy theo thứ tự tên và cùng ghi vào NEW, lúc đó
-- thứ tự chữ cái trở thành thứ phải nhớ mới đọc hiểu được code. Một hàm, đọc từ
-- trên xuống, không có thứ tự ngầm nào. (Tên hàm vì vậy hẹp hơn việc nó làm —
-- đổi tên thì phải drop cả trigger lẫn hàm, không đáng cho một cái tên.)

create or replace function public.loads_protect_reported_columns()
returns trigger
language plpgsql
as $$
begin
  -- Giữ nguyên hành vi của 0010: client không được tự khai reported_*, nếu
  -- không người dùng có thể tự nhận tải đang bật mà relay chưa hề đóng.
  if auth.role() <> 'service_role' then
    new.reported_state := old.reported_state;
    new.reported_at := old.reported_at;
  end if;

  -- Đổi thiết bị điều khiển → mọi thứ đã biết về trạng thái relay đều là của
  -- thiết bị cũ. Đặt SAU khối trên để áp dụng cho cả service_role
  -- (ingest-telemetry) lẫn client, và cho cả trường hợp khoá ngoại
  -- `on delete set null` tự đặt device_id = null khi thiết bị bị xoá — trước
  -- đây tải mồ côi vẫn giữ nguyên "Đang bật" của một thiết bị không còn tồn tại.
  --
  -- `is distinct from` chứ không phải `<>`: một trong hai vế là null ở đúng
  -- những trường hợp cần bắt nhất (gỡ thiết bị, hoặc gán cho tải chưa có).
  if new.device_id is distinct from old.device_id then
    new.reported_state := null;
    new.reported_at := null;
    new.desired_state := false;
  end if;

  return new;
end;
$$;
