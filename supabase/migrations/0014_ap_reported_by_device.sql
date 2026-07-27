-- Đảo chiều nguồn sự thật của cấu hình Access Point: THIẾT BỊ, không phải cloud.
--
-- 0013 lưu ap_config trên `station_settings` và để cloud sinh SSID/mật khẩu.
-- Cách đó có một lỗ hổng thực tế: không gì bắt ESP32 phát đúng SSID/mật khẩu
-- đã lưu, nên dashboard hiển thị một giá trị chưa chắc đúng với mạng đang phát
-- thật. Vì dashboard chỉ HIỂN THỊ (không cho sửa), để thiết bị làm chủ giá trị
-- là đúng bản chất hơn: firmware giữ AP trong secrets.h, tự phát, rồi BÁO
-- NGƯỢC lên qua telemetry; dashboard chỉ phản chiếu thứ có thật.
--
-- Kéo theo: AP là của TỪNG THIẾT BỊ chứ không phải của trạm — mỗi ESP32 phát
-- một mạng riêng, một trạm có thể có nhiều ESP32. Nên cột nằm ở `devices`.
--
-- Mật khẩu vẫn plaintext (cần đúng chuỗi PSK để người dùng gõ vào máy khi kết
-- nối). RLS của `devices` (migration 0003) đã giới hạn về đúng chủ trạm.

-- ---------------------------------------------------------------------
-- 1. devices: snapshot AP mà thiết bị báo lên.
-- Không thêm cột tương ứng vào `telemetry`: đây là giá trị gần như không đổi,
-- nhân bản nó vào mọi hàng time-series là lãng phí. ingest-telemetry ghi
-- thẳng vào `devices` (cùng cách nó xử lý loads ack — xem migration 0010).
-- ---------------------------------------------------------------------
alter table public.devices
  add column if not exists ap_ssid text,
  add column if not exists ap_password text,
  -- Lần gần nhất thiết bị báo AP. null = chưa từng báo (firmware cũ chưa có
  -- SoftAP, hoặc chưa kết nối lần nào) → UI hiển thị "chưa báo" thay vì trống.
  add column if not exists ap_reported_at timestamptz;

-- ---------------------------------------------------------------------
-- 2. Gỡ hướng cũ của 0013. Dùng `if exists` để migration chạy được cả khi
-- 0013 chưa từng được apply lên database này.
-- ---------------------------------------------------------------------
alter table public.station_settings drop column if exists ap_config;
drop function if exists public.ap_config_default(uuid);

-- handle_new_station() trở về đúng phần thân của 0009 (không còn ap_config).
create or replace function public.handle_new_station()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.station_settings (
    station_id, owner_id, active_battery_mode, battery_modes, module_visibility
  )
  values (
    new.id,
    new.owner_id,
    'balanced',
    jsonb_build_object(
      'low', jsonb_build_object(
        'desc', 'Sử dụng tối đa dung lượng pin, sạc nhanh và xả sâu hơn để khai thác tối đa năng lượng. Có thể làm giảm tuổi thọ pin theo thời gian.',
        'minSoc', 10, 'maxSoc', 95, 'maxCurrent', 35, 'maxVoltage', 55.2, 'deepDischargeProtect', false
      ),
      'balanced', jsonb_build_object(
        'desc', 'Cân bằng giữa hiệu suất sử dụng và tuổi thọ pin, phù hợp cho vận hành hàng ngày.',
        'minSoc', 20, 'maxSoc', 90, 'maxCurrent', 25, 'maxVoltage', 54.6, 'deepDischargeProtect', true
      ),
      'max', jsonb_build_object(
        'desc', 'Ưu tiên bảo vệ tuổi thọ pin ở mức cao nhất, vận hành trong dải an toàn hẹp hơn. Dung lượng khả dụng thấp hơn nhưng pin bền hơn lâu dài.',
        'minSoc', 30, 'maxSoc', 80, 'maxCurrent', 15, 'maxVoltage', 53.8, 'deepDischargeProtect', true
      )
    ),
    jsonb_build_object('flow', true, 'chart', true, 'battery', true, 'load', true, 'alerts', true, 'reports', true)
  )
  on conflict (station_id) do nothing;

  return new;
end;
$$;
