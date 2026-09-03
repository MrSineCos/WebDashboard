-- Hai RPC năng lượng gom nhóm theo múi giờ của TRẠM, không còn cứng GMT+7.
--
-- 0005 (và 0020 khi định nghĩa lại station_daily_energy) viết thẳng
-- 'Asia/Ho_Chi_Minh' vào cả mệnh đề chia ngày/giờ lẫn mốc bắt đầu khung. Từ
-- 0021 mỗi trạm đã có `stations.timezone` riêng và giao diện hiển thị mọi mốc
-- thời gian theo đó — nhưng RANH GIỚI ngày/giờ mà biểu đồ dựa vào thì vẫn nằm
-- ở GMT+7. Trạm đặt tại Tokyo vì thế có nhãn trục ghi giờ Tokyo trong khi số
-- liệu lại được cắt theo nửa đêm giờ Việt Nam: cột "00:00" thật ra gộp dữ liệu
-- từ 02:00 giờ địa phương, và sản lượng của hai giờ đầu ngày bị tính sang ngày
-- hôm trước.
--
-- Thêm tham số `p_tz`. Mặc định vẫn là 'Asia/Ho_Chi_Minh' nên bản dựng client
-- cũ (chưa truyền tham số) giữ nguyên hành vi, không cần deploy đồng thời.
--
-- Phải DROP bản cũ chứ không create-or-replace được: thêm một tham số CÓ giá
-- trị mặc định sẽ khiến lời gọi thiếu tham số khớp cả hai overload và Postgres
-- báo "function station_daily_energy(uuid, int) is not unique".
--
-- `p_tz` đi vào `at time zone` chứ không nối chuỗi, nên không có bề mặt SQL
-- injection; tên múi giờ sai sẽ làm Postgres báo lỗi "time zone not
-- recognized" thay vì âm thầm trả số sai. Danh sách chọn được ở giao diện là
-- TIMEZONE_OPTIONS trong Dashboard.jsx, đều là id IANA hợp lệ.

-- ---------------------------------------------------------------------
-- 1. station_daily_energy — giữ nguyên công thức hình thang của 0020
--    (cycle_energy_kwh), chỉ đổi nguồn múi giờ.
-- ---------------------------------------------------------------------
-- Bỏ cả chữ ký cũ lẫn chữ ký mới để chạy lại migration này không báo
-- "function already exists".
drop function if exists public.station_daily_energy(uuid, int);
drop function if exists public.station_daily_energy(uuid, int, text);

create function public.station_daily_energy(
  p_station_id uuid,
  p_days int default 14,
  p_tz text default 'Asia/Ho_Chi_Minh'
)
returns table (day date, solar_kwh numeric, load_kwh numeric, charge_kwh numeric, discharge_kwh numeric)
language sql
security invoker
stable
as $$
  with raw as (
    select
      (ts at time zone p_tz)::date as day,
      ts,
      coalesce(solar_kw, 0) as solar_kw,
      coalesce(load_w, 0) / 1000.0 as load_kw
    from public.telemetry
    where station_id = p_station_id
      and ts >= ((((now() at time zone p_tz)::date - (p_days - 1))::timestamp) at time zone p_tz)
  ),
  lagged as (
    select
      day,
      ts,
      solar_kw,
      load_kw,
      solar_kw - load_kw as net_kw,
      lag(ts) over w as prev_ts,
      lag(solar_kw) over w as prev_solar_kw,
      lag(load_kw) over w as prev_load_kw,
      lag(solar_kw - load_kw) over w as prev_net_kw
    from raw
    window w as (partition by day order by ts)
  )
  select
    day,
    coalesce(sum(public.cycle_energy_kwh(prev_ts, prev_solar_kw, ts, solar_kw)), 0) as solar_kwh,
    coalesce(sum(public.cycle_energy_kwh(prev_ts, prev_load_kw, ts, load_kw)), 0) as load_kwh,
    coalesce(sum(greatest(public.cycle_energy_kwh(prev_ts, prev_net_kw, ts, net_kw), 0)), 0) as charge_kwh,
    coalesce(sum(greatest(-public.cycle_energy_kwh(prev_ts, prev_net_kw, ts, net_kw), 0)), 0) as discharge_kwh
  from lagged
  group by day
  order by day;
$$;

revoke all on function public.station_daily_energy(uuid, int, text) from public;
grant execute on function public.station_daily_energy(uuid, int, text) to authenticated;

-- ---------------------------------------------------------------------
-- 2. station_hourly_energy — bản 0005, chỉ đổi nguồn múi giờ.
-- ---------------------------------------------------------------------
drop function if exists public.station_hourly_energy(uuid, date);
drop function if exists public.station_hourly_energy(uuid, date, text);

create function public.station_hourly_energy(
  p_station_id uuid,
  p_day date,
  p_tz text default 'Asia/Ho_Chi_Minh'
)
returns table (hour int, avg_solar_w numeric, avg_load_w numeric, avg_battery_voltage numeric)
language sql
security invoker
stable
as $$
  select
    extract(hour from (ts at time zone p_tz))::int as hour,
    avg(coalesce(solar_kw, 0)) * 1000 as avg_solar_w,
    avg(load_w) as avg_load_w,
    avg(battery_voltage) as avg_battery_voltage
  from public.telemetry
  where station_id = p_station_id
    and (ts at time zone p_tz)::date = p_day
  group by hour
  order by hour;
$$;

revoke all on function public.station_hourly_energy(uuid, date, text) from public;
grant execute on function public.station_hourly_energy(uuid, date, text) to authenticated;
