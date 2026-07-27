-- Real IoT ingestion: devices + telemetry.
-- Devices (ESP32...) authenticate at AWS IoT Core (X.509). An IoT Rule POSTs
-- each message to the `ingest-telemetry` Edge Function, which writes here using
-- the service role (bypassing RLS). Browser clients can only SELECT their own
-- rows; there is intentionally NO anon insert/update path, so a leaked anon key
-- cannot spoof telemetry.

-- ---------------------------------------------------------------------
-- devices — one row per physical device, mapped to an AWS IoT "thing".
-- ---------------------------------------------------------------------
create table public.devices (
  id uuid primary key default gen_random_uuid(),
  station_id uuid not null references public.stations (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  type text not null check (type in ('esp32', 'inverter', 'bms', 'sensor')),
  aws_thing_name text not null unique,
  status text not null default 'disconnected'
    check (status in ('connected', 'disconnected')),
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);

create index devices_station_id_idx on public.devices (station_id);
create index devices_owner_id_idx on public.devices (owner_id);

alter table public.devices enable row level security;

-- Read-only for the owner. Writes happen only via the service role.
create policy "devices_select_own" on public.devices
  for select using (owner_id = auth.uid());

-- ---------------------------------------------------------------------
-- telemetry — time-series readings. Wide columns mirror the station
-- snapshot fields the dashboard already renders; `extra` holds anything
-- else a device wants to send.
-- ---------------------------------------------------------------------
create table public.telemetry (
  id bigint generated always as identity primary key,
  device_id uuid references public.devices (id) on delete set null,
  station_id uuid not null references public.stations (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  ts timestamptz not null default now(),
  solar_kw numeric,
  battery_pct integer,
  battery_voltage numeric,
  load_w numeric,
  temp_c numeric,
  rssi integer,
  extra jsonb not null default '{}'
);

create index telemetry_station_ts_idx on public.telemetry (station_id, ts desc);
create index telemetry_device_ts_idx on public.telemetry (device_id, ts desc);

alter table public.telemetry enable row level security;

create policy "telemetry_select_own" on public.telemetry
  for select using (owner_id = auth.uid());

-- ---------------------------------------------------------------------
-- Keep the station snapshot and device liveness in sync with the latest
-- reading, so the existing dashboard (which reads `stations`) shows real
-- data without any frontend change. Runs as the inserting role; the
-- Edge Function inserts with the service role, so these writes succeed.
-- ---------------------------------------------------------------------
create or replace function public.apply_telemetry()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  update public.stations s
  set
    solar_kw = coalesce(new.solar_kw, s.solar_kw),
    battery_pct = coalesce(new.battery_pct, s.battery_pct),
    battery_voltage = coalesce(new.battery_voltage, s.battery_voltage),
    status = 'online'
  where s.id = new.station_id;

  if new.device_id is not null then
    update public.devices d
    set status = 'connected', last_seen_at = new.ts
    where d.id = new.device_id;
  end if;

  return new;
end;
$$;

create trigger telemetry_apply
  after insert on public.telemetry
  for each row execute function public.apply_telemetry();
