-- Auto-offline detection.
--
-- `apply_telemetry` (0003) only ever sets status = 'online' on insert; nothing
-- ever moves a station/device back to 'offline' when a device stops sending
-- data. This adds a `last_seen_at` on stations (mirroring `devices`) and a
-- scheduled job that flips stale rows to 'offline'.
--
-- Stations with no registered `devices` row are left untouched — those are
-- the demo/manual stations (Trạm 02-04) seeded by handle_new_user() and have
-- no real hardware, so they must keep whatever status the UI/demo data set.

alter table public.stations add column last_seen_at timestamptz;

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
    status = 'online',
    last_seen_at = new.ts
  where s.id = new.station_id;

  if new.device_id is not null then
    update public.devices d
    set status = 'connected', last_seen_at = new.ts
    where d.id = new.device_id;
  end if;

  return new;
end;
$$;

-- Threshold: firmware publishes every 10s (see firmware/esp32-solgrid), so 90s
-- of silence means at least ~9 missed cycles — comfortably past normal jitter.
create or replace function public.mark_stale_offline()
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  update public.devices
  set status = 'disconnected'
  where status = 'connected'
    and last_seen_at < now() - interval '90 seconds';

  update public.stations s
  set status = 'offline'
  where s.status <> 'offline'
    and s.last_seen_at < now() - interval '90 seconds'
    and exists (select 1 from public.devices d where d.station_id = s.id);
end;
$$;

-- Requires the pg_cron extension. On hosted Supabase this is usually enabled
-- from Dashboard → Database → Extensions if the CREATE EXTENSION below fails
-- for lack of privilege; re-run this migration's `select cron.schedule(...)`
-- afterwards.
create extension if not exists pg_cron;

select cron.schedule(
  'mark-stale-offline',
  '* * * * *',
  $$select public.mark_stale_offline()$$
);
