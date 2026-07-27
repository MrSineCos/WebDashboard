-- Cấu hình Access Point (SoftAP) của ESP32-S3 — theo trạm.
--
-- Bối cảnh: khi trạm mất internet, dashboard cloud không truy cập được. Để
-- người dùng vẫn theo dõi/cài đặt được tại chỗ, ESP32-S3 sẽ tự phát một mạng
-- WiFi riêng và phục vụ một trang web cục bộ. Bảng này lưu SSID + mật khẩu
-- của CHÍNH mạng do ESP32 phát ra.
--
-- Lưu ý phạm vi — đây KHÔNG phải WiFi uplink (mạng mà ESP32 kết nối ra
-- internet). Uplink vẫn nằm trong `secrets.h` lúc flash firmware và cố tình
-- không đưa lên đây: sai SSID/mật khẩu uplink là thiết bị mất mạng vĩnh viễn,
-- không sửa được từ xa. Sai cấu hình AP thì chỉ mất trang cục bộ, MQTT vẫn
-- chạy nên vẫn sửa lại được từ xa.
--
-- Mật khẩu lưu dạng plaintext (không hash) vì firmware cần đúng chuỗi PSK để
-- gọi WiFi.softAP(). Bù lại bằng RLS: chỉ chủ trạm đọc/ghi được hàng của mình
-- (policy kế thừa từ 0009). Đây là PSK của một AP cục bộ, không phải mật khẩu
-- tài khoản — không dùng lại ở nơi khác.

-- Mặc định sinh theo từng trạm (xem ap_config_default): SSID kèm 6 ký tự đầu
-- của station id để nhiều trạm cạnh nhau không phát trùng tên mạng, mật khẩu
-- ngẫu nhiên 12 ký tự thay vì một chuỗi cố định dùng chung cho mọi cài đặt.
-- `stations` không có cột slug nên định danh ngắn lấy từ id.
create or replace function public.ap_config_default(station_id uuid)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'ssid', 'SolGrid-' || upper(left(replace(station_id::text, '-', ''), 6)),
    'password', left(md5(station_id::text || 'ap-psk'), 12)
  );
$$;

-- DEFAULT của cột không tham chiếu được cột khác cùng hàng, nên để '{}' rồi
-- điền giá trị thật ở trigger (trạm mới) và backfill (trạm cũ) bên dưới.
alter table public.station_settings
  add column if not exists ap_config jsonb not null default '{}'::jsonb;

-- ---------------------------------------------------------------------
-- Trạm mới: sinh sẵn ap_config cùng lúc với các cấu hình khác. Giữ nguyên
-- toàn bộ phần thân 0009, chỉ thêm cột/giá trị ap_config.
-- ---------------------------------------------------------------------
create or replace function public.handle_new_station()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.station_settings (
    station_id, owner_id, active_battery_mode, battery_modes, module_visibility, ap_config
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
    jsonb_build_object('flow', true, 'chart', true, 'battery', true, 'load', true, 'alerts', true, 'reports', true),
    public.ap_config_default(new.id)
  )
  on conflict (station_id) do nothing;

  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- Backfill cho các trạm đã tồn tại. Chỉ đụng vào hàng chưa có ap_config để
-- không ghi đè cấu hình người dùng đã tự đặt (migration an toàn khi chạy lại).
-- ---------------------------------------------------------------------
update public.station_settings
set ap_config = public.ap_config_default(station_id)
where ap_config = '{}'::jsonb or ap_config->>'ssid' is null;
