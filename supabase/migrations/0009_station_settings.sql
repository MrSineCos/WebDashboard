-- Per-station battery threshold + module visibility settings.
--
-- Previously `battery_modes`/`module_visibility`/`active_battery_mode` lived
-- on `user_settings` (one row per user), so every station owned by a user
-- shared the exact same values — there was no way to configure them
-- differently per station. `loads`/`notif_prefs` stay on `user_settings`
-- (intentionally still per-user, not per-station).
--
-- `user_settings.battery_modes`/`module_visibility`/`active_battery_mode`
-- are left in place (unread/unwritten by the client going forward) rather
-- than dropped — lower risk, and `handle_new_user()` still needs to satisfy
-- their NOT NULL constraints at signup.

create table public.station_settings (
  station_id uuid primary key references public.stations (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  active_battery_mode text not null default 'balanced'
    check (active_battery_mode in ('low', 'balanced', 'max')),
  battery_modes jsonb not null,
  module_visibility jsonb not null,
  updated_at timestamptz not null default now()
);

create index station_settings_owner_id_idx on public.station_settings (owner_id);

alter table public.station_settings enable row level security;

create policy "station_settings_select_own" on public.station_settings
  for select using (owner_id = auth.uid());
create policy "station_settings_insert_own" on public.station_settings
  for insert with check (owner_id = auth.uid());
create policy "station_settings_update_own" on public.station_settings
  for update using (owner_id = auth.uid());
-- No delete policy — rows are removed only via the `stations` FK cascade,
-- same convention as `devices`/`telemetry`.

-- ---------------------------------------------------------------------
-- Auto-create default settings whenever a new station is inserted, so
-- station_settings always has exactly one row per station regardless of
-- what inserts the station (stations.js createStation(), future admin
-- tooling, SQL console) — atomic with the stations insert, so no window
-- where a station exists without settings.
-- ---------------------------------------------------------------------
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

create trigger on_station_created
  after insert on public.stations
  for each row execute function public.handle_new_station();

-- ---------------------------------------------------------------------
-- Backfill: every existing station gets a row copied from its owner's
-- current user_settings (preserving whatever they'd already configured).
-- Idempotent via ON CONFLICT so this migration is safe to re-run.
-- ---------------------------------------------------------------------
insert into public.station_settings (station_id, owner_id, active_battery_mode, battery_modes, module_visibility)
select s.id, s.owner_id, us.active_battery_mode, us.battery_modes, us.module_visibility
from public.stations s
join public.user_settings us on us.owner_id = s.owner_id
on conflict (station_id) do nothing;
