-- RPC to let an authenticated user register a device (ESP32/inverter/BMS/
-- sensor) under one of their own stations, from the DevConsole UI.
--
-- `devices` intentionally has no insert policy for authenticated clients
-- (see 0003_devices_telemetry.sql — writes only happen via the service role,
-- to stop a leaked anon/user key from spoofing device identities). This
-- function runs `security definer` to perform the insert, but re-implements
-- the same ownership check `stations_insert_own` would enforce on a direct
-- insert: the caller must own the target station. It does not bypass the
-- AWS IoT provisioning steps in docs/IOT.md (cert/policy/thing) — it only
-- creates the Supabase-side mapping row that `ingest-telemetry` looks up by
-- `aws_thing_name`.

create or replace function public.register_device(
  p_station_id uuid,
  p_name text,
  p_type text,
  p_aws_thing_name text
)
returns public.devices
language plpgsql
security definer set search_path = public
as $$
declare
  v_owner uuid;
  v_row public.devices;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  select owner_id into v_owner from public.stations where id = p_station_id;
  if v_owner is null then
    raise exception 'station_not_found';
  end if;
  if v_owner <> auth.uid() then
    raise exception 'not_owner';
  end if;

  insert into public.devices (station_id, owner_id, name, type, aws_thing_name)
  values (p_station_id, v_owner, trim(p_name), p_type, trim(p_aws_thing_name))
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.register_device(uuid, text, text, text) from public;
grant execute on function public.register_device(uuid, text, text, text) to authenticated;
