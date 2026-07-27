-- Fix: `stations.last_seen_at` is NULL for any station whose last telemetry
-- row was inserted before migration 0004 added the column (the trigger that
-- ran at insert time was the pre-0004 version, which never touched it).
-- `mark_stale_offline` compared `last_seen_at < now() - interval '90 seconds'`,
-- and NULL < anything is NULL (not true) in SQL, so those stations' WHERE
-- clause never matched — they stayed 'online' forever regardless of silence.
--
-- Treat NULL last_seen_at the same as "stale": a station with a registered
-- device that has never (or not recently) reported data should read offline.

create or replace function public.mark_stale_offline()
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  update public.devices
  set status = 'disconnected'
  where status = 'connected'
    and (last_seen_at is null or last_seen_at < now() - interval '90 seconds');

  update public.stations s
  set status = 'offline'
  where s.status <> 'offline'
    and (s.last_seen_at is null or s.last_seen_at < now() - interval '90 seconds')
    and exists (select 1 from public.devices d where d.station_id = s.id);
end;
$$;
