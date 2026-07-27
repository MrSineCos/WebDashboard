-- SolGrid core config schema: profiles, stations, user_settings.
-- Time-series/telemetry (charts, logs, alerts, firmware history, sensor
-- calibration) intentionally stays simulated client-side and has no tables
-- here.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null default '',
  phone text not null default '',
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles_select_own" on public.profiles
  for select using (id = auth.uid());
create policy "profiles_insert_own" on public.profiles
  for insert with check (id = auth.uid());
create policy "profiles_update_own" on public.profiles
  for update using (id = auth.uid());

-- ---------------------------------------------------------------------
-- stations
-- ---------------------------------------------------------------------
create table public.stations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  location text not null,
  status text not null check (status in ('online', 'warning', 'offline')),
  solar_kw numeric not null default 0,
  battery_pct integer not null default 0,
  battery_voltage numeric not null default 0,
  created_at timestamptz not null default now()
);

create index stations_owner_id_idx on public.stations (owner_id);

alter table public.stations enable row level security;

create policy "stations_select_own" on public.stations
  for select using (owner_id = auth.uid());
create policy "stations_insert_own" on public.stations
  for insert with check (owner_id = auth.uid());
create policy "stations_update_own" on public.stations
  for update using (owner_id = auth.uid());
create policy "stations_delete_own" on public.stations
  for delete using (owner_id = auth.uid());

-- ---------------------------------------------------------------------
-- user_settings (one row per user)
-- ---------------------------------------------------------------------
create table public.user_settings (
  owner_id uuid primary key references auth.users (id) on delete cascade,
  selected_station_id uuid references public.stations (id) on delete set null,
  active_battery_mode text not null default 'balanced'
    check (active_battery_mode in ('low', 'balanced', 'max')),
  battery_modes jsonb not null,
  module_visibility jsonb not null,
  loads jsonb not null,
  notif_prefs jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.user_settings enable row level security;

create policy "user_settings_select_own" on public.user_settings
  for select using (owner_id = auth.uid());
create policy "user_settings_insert_own" on public.user_settings
  for insert with check (owner_id = auth.uid());
create policy "user_settings_update_own" on public.user_settings
  for update using (owner_id = auth.uid());

-- ---------------------------------------------------------------------
-- Seed a new user with the same demo data the frontend used to hardcode:
-- profile row, 4 demo stations, and default battery/module/load/notif
-- settings (mirrors DevConsole.jsx's BATTERY_MODE_DEFAULTS and
-- Dashboard.jsx's INITIAL_LOADS / INITIAL_NOTIF_PREFS).
-- ---------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_station1 uuid;
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', ''));

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

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
