-- Chuyển mọi ngưỡng điện áp sang pack 12 V.
--
-- Các giá trị mặc định từ 0001/0009/0023 được viết cho pack 48 V (13S Li-ion,
-- 54.6 V đầy). Pin thực nghiệm là pack 12 V (đo được 12.6–13.6 V khi chạy), nên:
--   * `alert_thresholds.minVoltage = 46` mở cảnh báo `undervoltage` ngay ở bản
--     tin đầu tiên và giữ trạm ở trạng thái "Cảnh báo" vĩnh viễn;
--   * `battery_modes.*.maxVoltage` (53.8–55.2 V) là ngưỡng dừng sạc mà pack 12 V
--     không bao giờ chạm tới — firmware sẽ không bao giờ ngắt sạc theo điện áp.
--
-- Ngưỡng mới dùng được cho cả ắc quy chì 12 V lẫn LiFePO4 4S:
--   minVoltage 11.5 V; maxVoltage Thấp 14.6 / Cân bằng 14.4 / Tối đa 14.2 V.
-- Giữ khớp với BATTERY_MODE_DEFAULTS + PACK_MAX_VOLTAGE_* (DevConsole.jsx),
-- fallback của send-battery-config và BatteryConfig trong firmware/esp32s3.ino.

-- ---------------------------------------------------------------------
-- 1. Mặc định cho trạm tạo mới
-- ---------------------------------------------------------------------
alter table public.station_settings
  alter column alert_thresholds
    set default jsonb_build_object('minVoltage', 11.5, 'maxTempC', 45, 'maxLoadKw', 2.0);

-- Phần thân sao y 0014, chỉ đổi ba giá trị maxVoltage và maxCurrent (8/6/4 A,
-- dải dòng sạc 3–8 A của pack 12 V).
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
        'minSoc', 10, 'maxSoc', 95, 'maxCurrent', 8, 'maxVoltage', 14.6, 'deepDischargeProtect', false
      ),
      'balanced', jsonb_build_object(
        'desc', 'Cân bằng giữa hiệu suất sử dụng và tuổi thọ pin, phù hợp cho vận hành hàng ngày.',
        'minSoc', 20, 'maxSoc', 90, 'maxCurrent', 6, 'maxVoltage', 14.4, 'deepDischargeProtect', true
      ),
      'max', jsonb_build_object(
        'desc', 'Ưu tiên bảo vệ tuổi thọ pin ở mức cao nhất, vận hành trong dải an toàn hẹp hơn. Dung lượng khả dụng thấp hơn nhưng pin bền hơn lâu dài.',
        'minSoc', 30, 'maxSoc', 80, 'maxCurrent', 4, 'maxVoltage', 14.2, 'deepDischargeProtect', true
      )
    ),
    jsonb_build_object('flow', true, 'chart', true, 'battery', true, 'load', true, 'alerts', true, 'reports', true)
  )
  on conflict (station_id) do nothing;

  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. Trạm đang có — chỉ sửa giá trị còn nằm ngoài dải pack 12 V (> 15 V),
--    không đụng tới ngưỡng người dùng đã tự chỉnh cho đúng.
-- ---------------------------------------------------------------------
update public.station_settings
set alert_thresholds = alert_thresholds || jsonb_build_object('minVoltage', 11.5)
where (alert_thresholds ->> 'minVoltage')::numeric > 15;

update public.station_settings ss
set battery_modes = (
  select jsonb_object_agg(
    m.key,
    case
      when (m.value ->> 'maxVoltage')::numeric > 15 then
        m.value || jsonb_build_object('maxVoltage',
          case m.key when 'low' then 14.6 when 'max' then 14.2 else 14.4 end)
      else m.value
    end
  )
  from jsonb_each(ss.battery_modes) m
)
where exists (
  select 1 from jsonb_each(ss.battery_modes) m
  where (m.value ->> 'maxVoltage')::numeric > 15
);

-- ---------------------------------------------------------------------
-- 3. Đóng các đợt `undervoltage` mở theo ngưỡng 48 V cũ. Nếu điện áp thật sự
--    dưới 11.5 V, bản tin kế tiếp sẽ mở lại một đợt với ngưỡng đúng.
-- ---------------------------------------------------------------------
update public.alerts
set resolved_at = now()
where kind = 'undervoltage'
  and resolved_at is null
  and threshold > 15;
