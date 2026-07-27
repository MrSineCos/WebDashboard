-- Stop auto-seeding 4 demo stations on signup. New users now start with
-- zero stations and create their first one through the app UI (Cài đặt →
-- Hệ thống, or DevConsole → Quản lý trạm) — see src/lib/stations.js
-- createStation() and src/components/RequireStation.jsx.
--
-- Only affects signups after this migration runs; existing seeded stations
-- for current users are left as-is (removed manually via the new "Xóa trạm"
-- UI, not by a data migration).

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_role text;
begin
  v_role := case when new.email = 'vu.nguyencong@hcmut.edu.vn' then 'admin' else 'user' end;

  insert into public.profiles (id, full_name, role)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', ''), v_role);

  insert into public.user_settings (
    owner_id, selected_station_id, active_battery_mode,
    battery_modes, module_visibility, loads, notif_prefs
  )
  values (
    new.id,
    null,
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
    jsonb_build_object('1', true, '2', false, '3', true, '4', true),
    jsonb_build_object('emailAlerts', true, 'push', true, 'weeklyReport', false, 'lowBattery', true)
  );

  return new;
end;
$$;
