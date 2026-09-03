-- Đếm chu kỳ sạc thật của pack pin (Equivalent Full Cycles).
--
-- Bối cảnh: trang Dashboard và Pin lưu trữ đang hiện "Chu kỳ sạc 214" và "Sức
-- khỏe pin 96%" — hai con số viết chết trong JSX, không có cột nào đứng sau.
-- Migration này bỏ chỗ dựa cho con số đầu tiên bằng một bộ đếm thật; "sức khỏe
-- pin" thì KHÔNG dựng lại, vì suy ra SOH cần dung lượng đo được qua một lần xả
-- đầy có kiểm soát — thiết bị hiện tại không làm việc đó, và đoán mò một con số
-- 96% còn tệ hơn là không hiện gì.
--
-- Vì sao là bộ tích luỹ trên `stations` chứ không phải một RPC tính từ
-- `telemetry`: 0019 xoá telemetry cũ hơn `telemetry_retention_days` (mặc định
-- 30 ngày). Một hàm tính từ dữ liệu thô chỉ đếm được chu kỳ trong cửa sổ còn
-- giữ lại, nghĩa là con số sẽ TỤT XUỐNG sau mỗi lượt dọn — đúng thứ mà một bộ
-- đếm tuổi thọ không được phép làm. Cộng dồn ngay lúc bản tin tới thì lượt dọn
-- không chạm được vào nó.
--
-- Định nghĩa dùng ở đây (chuẩn EFC):
--
--     chu kỳ = cycle_offset + (năng lượng nạp + năng lượng xả) / (2 × dung lượng)
--
-- Một lần nạp đầy RỒI xả cạn = 1 chu kỳ, nên phải chia 2. Cách này cộng dồn cả
-- những lần nạp/xả một phần (thực tế của hệ mặt trời: ngày nạp, đêm xả, hiếm
-- khi chạm hai đầu) thay vì chỉ đếm số lần chạm 100%.

-- ---------------------------------------------------------------------
-- 1. Năng lượng pin của một bản tin, tính theo hình thang
--
-- Trả về kWh CÓ DẤU giữa hai mẫu liên tiếp: dương = nạp vào pin, âm = xả ra.
-- Tách thành hàm riêng vì đúng công thức này được dùng ở ba chỗ (trigger, backfill,
-- và để đối chiếu với `station_daily_energy` của 0005) — chép tay ba lần thì
-- chỉ cần sửa lệch một chỗ là số liệu hai trang không khớp nhau nữa.
--
-- Bỏ qua khoảng trống > 1 giờ: thiết bị mất kết nối nửa ngày rồi gửi lại thì
-- nội suy tuyến tính qua quãng đó là bịa ra năng lượng chưa từng đo được. Cùng
-- ngưỡng với Battery.jsx và station_daily_energy (0005) để ba nơi ra cùng số.
--
-- `p_ts <= p_prev_ts` → 0: bản tin tới trễ/trùng (MQTT không bảo đảm thứ tự)
-- không được trừ ngược vào bộ đếm.
-- ---------------------------------------------------------------------
create or replace function public.cycle_energy_kwh(
  p_prev_ts timestamptz,
  p_prev_kw numeric,
  p_ts timestamptz,
  p_kw numeric
)
returns numeric
language sql
immutable
as $$
  select case
    when p_prev_ts is null or p_prev_kw is null or p_ts is null or p_kw is null then 0
    when p_ts <= p_prev_ts then 0
    when p_ts - p_prev_ts > interval '1 hour' then 0
    else (p_kw + p_prev_kw) / 2 * extract(epoch from (p_ts - p_prev_ts)) / 3600.0
  end;
$$;

-- ---------------------------------------------------------------------
-- 2. Cột trên `stations`
--
-- `battery_capacity_kwh` thay hằng PACK_CAPACITY_KWH = 4.8 vốn viết chết trong
-- Battery.jsx: nó vừa là mẫu số của công thức chu kỳ, vừa là thứ trang Pin lưu
-- trữ dùng để ước tính "còn mấy giờ đến đầy". Mặc định 4.8 = 100Ah × 48V, đúng
-- pack đang mô tả trên giao diện, nên trạm đang chạy không đổi hành vi.
--
-- `cycle_offset` cho trường hợp lắp pack đã qua sử dụng: số chu kỳ pack đã đi
-- được TRƯỚC khi nối vào hệ thống này. Tách khỏi hai cột năng lượng để lượt
-- backfill/tính lại không xoá mất con số người dùng nhập tay.
--
-- `cycle_anchor_*` là mẫu liền trước — cạnh trái của hình thang. Phải lưu lại
-- vì trigger chỉ nhìn thấy bản tin hiện tại, còn đọc ngược `telemetry` để tìm
-- mẫu trước thì thành một truy vấn nữa mỗi 10 giây trên đúng bảng lớn nhất.
-- ---------------------------------------------------------------------
alter table public.stations
  add column if not exists battery_capacity_kwh numeric not null default 4.8
    check (battery_capacity_kwh > 0),
  add column if not exists charge_energy_kwh numeric not null default 0
    check (charge_energy_kwh >= 0),
  add column if not exists discharge_energy_kwh numeric not null default 0
    check (discharge_energy_kwh >= 0),
  add column if not exists cycle_offset numeric not null default 0
    check (cycle_offset >= 0),
  add column if not exists cycle_anchor_ts timestamptz,
  add column if not exists cycle_anchor_kw numeric;

-- Cột sinh: mọi client (web hôm nay, app Android sau này) đọc thẳng một con số
-- đã tính sẵn, không phải chép lại công thức. Đổi `battery_capacity_kwh` thì
-- giá trị này tự tính lại — cố ý: sửa sai dung lượng khai báo phải sửa luôn số
-- chu kỳ đã quy đổi theo nó, chứ giữ nguyên mới là sai.
alter table public.stations
  add column if not exists battery_cycles numeric
    generated always as (
      cycle_offset + (charge_energy_kwh + discharge_energy_kwh) / (2 * battery_capacity_kwh)
    ) stored;

-- ---------------------------------------------------------------------
-- 3. Chặn client ghi vào bộ đếm
--
-- `stations_update_own` (0001) cho chủ trạm update cả hàng, nên nếu không chặn
-- thì trình duyệt đặt lại charge_energy_kwh = 0 được — một bộ đếm tuổi thọ mà
-- người dùng tự ghi đè được thì không dùng làm bằng chứng bảo hành hay lịch
-- thay pack được nữa. Cùng khuôn với loads_protect_reported (0010).
--
-- `battery_capacity_kwh` và `cycle_offset` KHÔNG nằm trong danh sách chặn: đó
-- là thông số người dùng khai báo về pack của mình, không phải số đo tích luỹ.
-- ---------------------------------------------------------------------
create or replace function public.stations_protect_cycle_columns()
returns trigger
language plpgsql
as $$
begin
  if auth.role() <> 'service_role' then
    new.charge_energy_kwh := old.charge_energy_kwh;
    new.discharge_energy_kwh := old.discharge_energy_kwh;
    new.cycle_anchor_ts := old.cycle_anchor_ts;
    new.cycle_anchor_kw := old.cycle_anchor_kw;
  end if;
  return new;
end;
$$;

-- Trigger được GẮN ở mục 6, sau lượt backfill. Migration chạy bằng kết nối
-- không có JWT, nên `auth.role()` ở đây không phải 'service_role' — gắn trigger
-- ngay bây giờ thì chính câu UPDATE nạp lại số liệu bên dưới sẽ bị nó hoàn tác,
-- âm thầm, không báo lỗi.

-- ---------------------------------------------------------------------
-- 4. Cộng dồn ngay trong apply_telemetry
--
-- Giữ nguyên toàn bộ phần snapshot của 0018 (kể cả `last_seen_at = new.ts` mà
-- 0012/0017 từng làm rơi mất), chỉ thêm bốn cột chu kỳ vào cùng một câu UPDATE.
-- Một câu chứ không tách ra: vế phải của UPDATE đọc giá trị CŨ của hàng, nên
-- mốc neo cũ và mốc neo mới nằm gọn trong một lượt ghi, không có khe hở cho hai
-- bản tin đến sát nhau cùng đọc một mốc rồi cộng trùng.
--
-- Công suất pin ròng = solar − tải, cùng công thức với Battery.jsx và ô "Dòng
-- DC bus" của Dashboard. Cố ý KHÔNG dùng `battery_current` dù 0012 đã có cột đó:
-- firmware chưa chốt quy ước dấu (docs/IOT.md mục 5 nêu trường này là tuỳ chọn
-- và không nói dương là nạp hay xả), mà đoán sai dấu thì bộ đếm chạy ngược.
-- Khi firmware chốt quy ước, đổi v_net_kw sang battery_voltage × battery_current
-- là đủ — phần còn lại của cơ chế không phải sửa gì.
-- ---------------------------------------------------------------------
create or replace function public.apply_telemetry()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_net_kw numeric;
begin
  v_net_kw := coalesce(new.solar_kw, 0) - coalesce(new.load_w, 0) / 1000.0;

  update public.stations s
  set
    solar_kw = coalesce(new.solar_kw, s.solar_kw),
    battery_pct = coalesce(new.battery_pct, s.battery_pct),
    battery_voltage = coalesce(new.battery_voltage, s.battery_voltage),
    battery_current = coalesce(new.battery_current, s.battery_current),
    charge_enabled = coalesce(new.charge_enabled, s.charge_enabled),
    discharge_enabled = coalesce(new.discharge_enabled, s.discharge_enabled),
    protect_reason = coalesce(new.protect_reason, s.protect_reason),
    status = 'online',
    last_seen_at = new.ts,

    charge_energy_kwh = s.charge_energy_kwh
      + greatest(public.cycle_energy_kwh(s.cycle_anchor_ts, s.cycle_anchor_kw, new.ts, v_net_kw), 0),
    discharge_energy_kwh = s.discharge_energy_kwh
      + greatest(-public.cycle_energy_kwh(s.cycle_anchor_ts, s.cycle_anchor_kw, new.ts, v_net_kw), 0),
    -- Chỉ dời mốc neo khi bản tin thực sự mới hơn. Bản tin đến trễ đã bị hàm
    -- trên bỏ qua (cộng 0); nếu vẫn dời mốc về sau thì mẫu kế tiếp sẽ tính
    -- hình thang trên một quãng thời gian âm/chồng lấn.
    cycle_anchor_ts = case
      when s.cycle_anchor_ts is null or new.ts > s.cycle_anchor_ts then new.ts
      else s.cycle_anchor_ts
    end,
    cycle_anchor_kw = case
      when s.cycle_anchor_ts is null or new.ts > s.cycle_anchor_ts then v_net_kw
      else s.cycle_anchor_kw
    end
  where s.id = new.station_id;

  if new.device_id is not null then
    update public.devices d
    set status = 'connected',
        last_seen_at = new.ts,
        uptime_s = coalesce(new.uptime_s, d.uptime_s),
        mcu_temp_c = coalesce(new.mcu_temp_c, d.mcu_temp_c),
        boot_count = coalesce(new.boot_count, d.boot_count)
    where d.id = new.device_id;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 5. Nạp lại từ telemetry đang còn trong bảng
--
-- Chạy một lần lúc migration để trạm đang hoạt động không bắt đầu lại từ 0.
-- Chỉ phủ được phần telemetry chưa bị 0019 dọn (mặc định 30 ngày gần nhất) —
-- đó là toàn bộ những gì còn đo được, và cũng là lý do bộ đếm phải chuyển sang
-- cộng dồn từ đây trở đi.
--
-- Đặt cả `cycle_anchor_*` theo bản tin mới nhất để bản tin kế tiếp nối tiếp
-- đúng hình thang, thay vì bỏ phí quãng giữa lúc migration chạy và lần gửi sau.
-- ---------------------------------------------------------------------
with samples as (
  select
    station_id,
    ts,
    coalesce(solar_kw, 0) - coalesce(load_w, 0) / 1000.0 as net_kw,
    lag(ts) over w as prev_ts,
    lag(coalesce(solar_kw, 0) - coalesce(load_w, 0) / 1000.0) over w as prev_kw,
    row_number() over (partition by station_id order by ts desc) as rn_desc
  from public.telemetry
  window w as (partition by station_id order by ts)
),
agg as (
  select
    station_id,
    sum(greatest(public.cycle_energy_kwh(prev_ts, prev_kw, ts, net_kw), 0)) as charge_kwh,
    sum(greatest(-public.cycle_energy_kwh(prev_ts, prev_kw, ts, net_kw), 0)) as discharge_kwh,
    max(ts) as last_ts,
    max(net_kw) filter (where rn_desc = 1) as last_kw
  from samples
  group by station_id
)
update public.stations s
set
  charge_energy_kwh = agg.charge_kwh,
  discharge_energy_kwh = agg.discharge_kwh,
  cycle_anchor_ts = agg.last_ts,
  cycle_anchor_kw = agg.last_kw
from agg
where agg.station_id = s.id;

-- ---------------------------------------------------------------------
-- 6. Khoá bộ đếm lại (hàm đã định nghĩa ở mục 3)
--
-- Từ đây trở đi chỉ đường ingest (service_role) mới ghi được bốn cột tích luỹ;
-- mọi update từ trình duyệt đều bị trả về giá trị cũ.
-- ---------------------------------------------------------------------
drop trigger if exists stations_protect_cycle on public.stations;
create trigger stations_protect_cycle
  before update on public.stations
  for each row execute function public.stations_protect_cycle_columns();

-- ---------------------------------------------------------------------
-- 7. station_daily_energy trả thêm năng lượng nạp/xả pin theo ngày
--
-- Trang Báo cáo đang hiện "Chu kỳ sạc pin (ước tính)" = sản lượng mặt trời
-- chia 1.8, kẹp sàn ở 1. Hai vấn đề: 1.8 không đến từ đâu cả, và cái sàn khiến
-- một ngày trạm nằm im vẫn báo "1 chu kỳ". Có sẵn năng lượng nạp/xả theo ngày
-- thì trang đó dùng đúng công thức EFC như bộ đếm tuổi thọ, hai con số cùng
-- tên trong cùng ứng dụng mới nhất quán với nhau.
--
-- Phải DROP trước: `returns table` đổi danh sách cột là đổi kiểu trả về, mà
-- create or replace không làm được việc đó.
--
-- Nhân tiện thay hai khối CASE lặp của bản 0005 bằng cycle_energy_kwh — vẫn
-- đúng công thức hình thang và cùng ngưỡng bỏ khoảng trống 1 giờ, nhưng từ giờ
-- chỉ còn một chỗ định nghĩa. Hàm còn chặn thêm mẫu đến trễ (ts <= prev_ts),
-- thứ bản cũ không xét.
-- ---------------------------------------------------------------------
drop function if exists public.station_daily_energy(uuid, int);

create function public.station_daily_energy(p_station_id uuid, p_days int default 14)
returns table (day date, solar_kwh numeric, load_kwh numeric, charge_kwh numeric, discharge_kwh numeric)
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

revoke all on function public.station_daily_energy(uuid, int) from public;
grant execute on function public.station_daily_energy(uuid, int) to authenticated;
