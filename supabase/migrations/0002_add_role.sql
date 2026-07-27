-- Add role-based access control (user/admin) to profiles.
-- Admin accounts land on the Dev Console (/dev); regular users land on
-- the standard Dashboard (/).

alter table public.profiles
  add column role text not null default 'user' check (role in ('user', 'admin'));

-- Promote the designated admin account if it has already signed up.
update public.profiles
set role = 'admin'
where id = (select id from auth.users where email = 'vu.nguyencong@hcmut.edu.vn');

-- Ensure the same admin email is created with the admin role on future signups.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_station1 uuid;
  v_role text;
begin
  v_role := case when new.email = 'vu.nguyencong@hcmut.edu.vn' then 'admin' else 'user' end;

  insert into public.profiles (id, full_name, role)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', ''), v_role);

  insert into public.stations (owner_id, name, location, status, solar_kw, battery_pct, battery_voltage)
  values
    (new.id, 'Trạm 01', 'Cà Mau', 'online', 2.4, 78, 48.3),
    (new.id, 'Trạm 02', 'Bến Tre', 'online', 1.8, 62, 47.1),
    (new.id, 'Trạm 03', 'Sóc Trăng', 'warning', 0.9, 41, 45.6),
    (new.id, 'Trạm 04', 'An Giang', 'offline', 0, 15, 43.8);

  select id into v_station1 from public.stations
    where owner_id = new.id and name = 'Trạm 01' limit 1;

  insert into public.user_settings (
    owner_id, selected_station_id, active_battery_mode,
    battery_modes, module_visibility, loads, notif_prefs
  )
  values (
    new.id,
    v_station1,
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
