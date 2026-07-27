-- Real load control: replaces the old hardcoded LOAD_DEFS + per-user
-- `user_settings.loads` on/off jsonb map (Dashboard.jsx) with an actual
-- per-station table so users can add/remove loads and (optionally) assign
-- which device (ESP32) switches each one.
--
-- `user_settings.loads` is left in place (unread/unwritten by the client
-- going forward) rather than dropped, same lower-risk convention as
-- `battery_modes`/`module_visibility` in 0009_station_settings.sql.

create table public.loads (
  id uuid primary key default gen_random_uuid(),
  station_id uuid not null references public.stations (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  device_id uuid references public.devices (id) on delete set null,
  name text not null,
  watt numeric not null default 0,
  -- Người dùng muốn tải ở trạng thái nào (ghi qua UI/RLS trực tiếp).
  desired_state boolean not null default false,
  -- Trạng thái thiết bị thực sự báo về — chỉ service role (ingest-telemetry)
  -- được ghi, xem trigger loads_protect_reported bên dưới.
  reported_state boolean,
  reported_at timestamptz,
  created_at timestamptz not null default now()
);

create index loads_station_id_idx on public.loads (station_id);
create index loads_owner_id_idx on public.loads (owner_id);
create index loads_device_id_idx on public.loads (device_id);

alter table public.loads enable row level security;

create policy "loads_select_own" on public.loads
  for select using (owner_id = auth.uid());
create policy "loads_insert_own" on public.loads
  for insert with check (owner_id = auth.uid());
create policy "loads_update_own" on public.loads
  for update using (owner_id = auth.uid());
create policy "loads_delete_own" on public.loads
  for delete using (owner_id = auth.uid());

-- A client (browser) may only change name/watt/device_id/desired_state.
-- reported_state/reported_at reflect what the physical device actually
-- confirmed, so only the service role (ingest-telemetry, via the AWS ack
-- payload) may set them — otherwise a user could just claim their load is
-- on without the ESP32 ever switching the relay.
create or replace function public.loads_protect_reported_columns()
returns trigger
language plpgsql
as $$
begin
  if auth.role() <> 'service_role' then
    new.reported_state := old.reported_state;
    new.reported_at := old.reported_at;
  end if;
  return new;
end;
$$;

create trigger loads_protect_reported
  before update on public.loads
  for each row execute function public.loads_protect_reported_columns();
