-- Múi giờ hiển thị của trạm + đơn vị năng lượng người dùng chọn ở Cài đặt.
--
-- Trước migration này, cả hai đều chỉ là state cục bộ trong Dashboard.jsx:
-- nút "Lưu thay đổi" của thẻ "Thông tin trạm" không có onClick, select múi
-- giờ chỉ có đúng một option cố định, và hai nút kWh/Wh đổi state rồi không
-- ai đọc lại. Không có cột nào đứng sau ba thứ đó cả.
--
-- `timezone` nằm trên `stations` (không phải `station_settings`): đây là nơi
-- lắp đặt vật lý của trạm, cùng loại thông tin với name/location đã có sẵn
-- trên chính bảng này và cùng nằm trên form "Thông tin trạm".
--
-- `energy_unit` nằm trên `user_settings` (không phải theo trạm): đây thuần là
-- gu hiển thị con số của người xem — ai xem nhiều trạm cũng muốn nhất quán
-- một đơn vị, không phải đặc tính vật lý của từng trạm.
alter table public.stations
  add column if not exists timezone text not null default 'Asia/Ho_Chi_Minh';

alter table public.user_settings
  add column if not exists energy_unit text not null default 'kWh'
    check (energy_unit in ('kWh', 'Wh'));
