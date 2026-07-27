-- RPC to let an authenticated user delete one of their own devices from
-- DevConsole ("Tổng quan thiết bị" / "Kết nối & API").
--
-- Same reasoning as `register_device` (migration 0008): `devices` has no
-- direct write policies for authenticated clients — reads are select-own,
-- everything else goes through a security-definer RPC that re-implements the
-- ownership check itself. Deleting a device does not touch AWS (the thing/
-- cert stay provisioned there; the device would just start getting
-- `unknown_device` from ingest-telemetry once its `devices` row is gone).
-- Past telemetry rows keep their data with `device_id` set to null (FK
-- `on delete set null`, migration 0003); any `loads` this device was
-- assigned to switch also fall back to unassigned (FK `on delete set null`,
-- migration 0010) rather than being deleted.

create or replace function public.delete_device(p_device_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_owner uuid;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  select owner_id into v_owner from public.devices where id = p_device_id;
  if v_owner is null then
    raise exception 'device_not_found';
  end if;
  if v_owner <> auth.uid() then
    raise exception 'not_owner';
  end if;

  delete from public.devices where id = p_device_id;
end;
$$;

revoke all on function public.delete_device(uuid) from public;
grant execute on function public.delete_device(uuid) to authenticated;
