-- Track the result of a battery/BMS configuration push per ESP32.
--
-- `station_settings` remains the desired configuration source. These columns
-- are a device snapshot: the cloud requested a version, then the device must
-- report that same version/hash after ESP32 -> STM32 has accepted it.
-- `pending` is deliberately not shown as success.

alter table public.devices
  add column if not exists config_id_desired uuid,
  add column if not exists config_version_desired bigint,
  add column if not exists config_version_applied bigint,
  add column if not exists config_hash_desired text,
  add column if not exists config_hash_applied text,
  add column if not exists config_sync_status text not null default 'idle'
    check (config_sync_status in (
      'idle', 'pending', 'received', 'applying', 'applied',
      'already_applied', 'rejected', 'timeout', 'publish_failed'
    )),
  add column if not exists config_sync_error text,
  add column if not exists config_sync_requested_at timestamptz,
  add column if not exists config_sync_ack_at timestamptz;

comment on column public.devices.config_sync_status is
  'Latest BMS config delivery state; applied means the device confirmed the STM32 accepted it.';

comment on column public.devices.config_version_desired is
  'Latest configuration version published by the cloud to this device.';

comment on column public.devices.config_version_applied is
  'Latest configuration version acknowledged by the device after STM32 application.';
