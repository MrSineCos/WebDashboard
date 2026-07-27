-- Energy rollups for the Reports page.
--
-- `telemetry` is raw time-series (one row per publish, every ~10s). Report.jsx
-- needs per-day/per-hour kWh, which means integrating power over time rather
-- than averaging — computed here in SQL so the client never has to pull
-- thousands of raw rows just to draw a 14-day chart.
--
-- Both functions run `security invoker` (the default) so the existing
-- `telemetry_select_own` RLS policy (owner_id = auth.uid()) applies exactly
-- as it would to a direct SELECT — a caller can only ever aggregate their own
-- stations' data.

create or replace function public.station_daily_energy(p_station_id uuid, p_days int default 14)
returns table (day date, solar_kwh numeric, load_kwh numeric)
language sql
security invoker
stable
as $$
  with raw as (
    select
      (ts at time zone 'Asia/Ho_Chi_Minh')::date as day,
      ts,
      coalesce(solar_kw, 0) as solar_kw,
      coalesce(load_w, 0) / 1000.0 as load_kw
    from public.telemetry
    where station_id = p_station_id
      and ts >= ((((now() at time zone 'Asia/Ho_Chi_Minh')::date - (p_days - 1))::timestamp) at time zone 'Asia/Ho_Chi_Minh')
  ),
  lagged as (
    select
      day,
      ts,
      solar_kw,
      load_kw,
      lag(ts) over w as prev_ts,
      lag(solar_kw) over w as prev_solar_kw,
      lag(load_kw) over w as prev_load_kw
    from raw
    window w as (partition by day order by ts)
  )
  select
    day,
    coalesce(sum(
      case when prev_ts is null or extract(epoch from (ts - prev_ts)) / 3600.0 > 1 then 0
        else (solar_kw + prev_solar_kw) / 2 * extract(epoch from (ts - prev_ts)) / 3600.0
      end
    ), 0) as solar_kwh,
    coalesce(sum(
      case when prev_ts is null or extract(epoch from (ts - prev_ts)) / 3600.0 > 1 then 0
        else (load_kw + prev_load_kw) / 2 * extract(epoch from (ts - prev_ts)) / 3600.0
      end
    ), 0) as load_kwh
  from lagged
  group by day
  order by day;
$$;

create or replace function public.station_hourly_energy(p_station_id uuid, p_day date)
returns table (hour int, avg_solar_w numeric, avg_load_w numeric, avg_battery_voltage numeric)
language sql
security invoker
stable
as $$
  select
    extract(hour from (ts at time zone 'Asia/Ho_Chi_Minh'))::int as hour,
    avg(coalesce(solar_kw, 0)) * 1000 as avg_solar_w,
    avg(load_w) as avg_load_w,
    avg(battery_voltage) as avg_battery_voltage
  from public.telemetry
  where station_id = p_station_id
    and (ts at time zone 'Asia/Ho_Chi_Minh')::date = p_day
  group by hour
  order by hour;
$$;

revoke all on function public.station_daily_energy(uuid, int) from public;
grant execute on function public.station_daily_energy(uuid, int) to authenticated;

revoke all on function public.station_hourly_energy(uuid, date) from public;
grant execute on function public.station_hourly_energy(uuid, date) to authenticated;
