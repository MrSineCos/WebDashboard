-- 1. Sửa trigger nhật ký của `station_settings`.
--
-- 0030 viết `log_station_settings_changed()` có nhánh so sánh `new.ap_config`,
-- nhưng cột này đã bị xoá từ 0014 (ap_config chuyển sang `devices`). PL/pgSQL
-- chỉ báo lỗi khi chạy tới dòng đó, nên MỌI lệnh UPDATE trên station_settings
-- (lưu ngưỡng pin, đổi chế độ, ngưỡng cảnh báo, module hiển thị) đều thất bại
-- với `record "new" has no field "ap_config"`. Phần thân sao y 0030, bỏ nhánh
-- ap_config.
--
-- 2. Dòng sạc tối đa của pack 12 V thực nghiệm chỉ trong dải 3–8 A (khớp
-- CHARGE_CURRENT_MIN/MAX ở DevConsole.jsx và send-battery-config).

create or replace function public.log_station_settings_changed()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_old jsonb;
  v_new jsonb;
begin
  if new.active_battery_mode is distinct from old.active_battery_mode then
    perform public.log_event(
      new.owner_id, 'info', 'battery_mode_changed',
      format('Đã chuyển chế độ bảo vệ pin: %s → %s (ngưỡng pin yếu nay là %s%%)',
             old.active_battery_mode, new.active_battery_mode,
             coalesce(new.battery_modes -> new.active_battery_mode ->> 'minSoc', '?')),
      new.station_id, null,
      jsonb_build_object('from', old.active_battery_mode, 'to', new.active_battery_mode),
      'config'
    );
  end if;

  if new.battery_modes is distinct from old.battery_modes then
    v_old := old.battery_modes -> new.active_battery_mode;
    v_new := new.battery_modes -> new.active_battery_mode;
    perform public.log_event(
      new.owner_id, 'info', 'battery_thresholds_changed',
      format('Đã sửa ngưỡng pin của chế độ "%s": pin tối thiểu %s%% → %s%%, '
             || 'dòng sạc tối đa %s A → %s A',
             new.active_battery_mode,
             coalesce(v_old ->> 'minSoc', '?'), coalesce(v_new ->> 'minSoc', '?'),
             coalesce(v_old ->> 'maxCurrent', '?'), coalesce(v_new ->> 'maxCurrent', '?')),
      new.station_id, null,
      jsonb_build_object('mode', new.active_battery_mode, 'from', v_old, 'to', v_new),
      'config'
    );
  end if;

  if new.alert_thresholds is distinct from old.alert_thresholds then
    perform public.log_event(
      new.owner_id, 'warn', 'alert_thresholds_changed',
      format('Đã sửa ngưỡng cảnh báo: điện áp tối thiểu %s → %s V, nhiệt độ tối đa '
             || '%s → %s °C, tải tối đa %s → %s kW',
             coalesce(old.alert_thresholds ->> 'minVoltage', 'tắt'),
             coalesce(new.alert_thresholds ->> 'minVoltage', 'tắt'),
             coalesce(old.alert_thresholds ->> 'maxTempC', 'tắt'),
             coalesce(new.alert_thresholds ->> 'maxTempC', 'tắt'),
             coalesce(old.alert_thresholds ->> 'maxLoadKw', 'tắt'),
             coalesce(new.alert_thresholds ->> 'maxLoadKw', 'tắt')),
      new.station_id, null,
      jsonb_build_object('from', old.alert_thresholds, 'to', new.alert_thresholds),
      'config'
    );
  end if;

  if new.module_visibility is distinct from old.module_visibility then
    perform public.log_event(
      new.owner_id, 'info', 'modules_changed',
      'Đã bật/tắt module hiển thị trên dashboard của trạm',
      new.station_id, null,
      jsonb_build_object('from', old.module_visibility, 'to', new.module_visibility),
      'config'
    );
  end if;

  return null;
end;
$$;

-- Kẹp maxCurrent của các trạm đang có vào dải 3–8 A (mặc định cũ 35/25/15 A
-- là của pack 48 V).
update public.station_settings ss
set battery_modes = (
  select jsonb_object_agg(
    m.key,
    case
      when (m.value ->> 'maxCurrent')::numeric > 8 then m.value || jsonb_build_object('maxCurrent', 8)
      when (m.value ->> 'maxCurrent')::numeric < 3 then m.value || jsonb_build_object('maxCurrent', 3)
      else m.value
    end
  )
  from jsonb_each(ss.battery_modes) m
)
where exists (
  select 1 from jsonb_each(ss.battery_modes) m
  where (m.value ->> 'maxCurrent')::numeric not between 3 and 8
);
