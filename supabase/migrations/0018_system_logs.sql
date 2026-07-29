-- Nhật ký hệ thống thật cho mục "Nhật ký hệ thống" trong DevConsole.
--
-- Bối cảnh: mục đó đang render hằng số `LOGS` viết cứng trong DevConsole.jsx
-- (8 dòng, timestamp là chuỗi cố định) và tự gắn nhãn <DemoBadge />. Migration
-- này dựng đường ống thật: một bảng append-only + các nguồn sinh sự kiện.
--
-- Vì sao là bảng chứ không phải file log trên server: dashboard này đa người
-- dùng, mọi bảng đều lọc theo `owner_id` qua RLS. Một file phẳng không có khái
-- niệm đó — đọc log của trạm mình sẽ phải tự lọc bằng tay ở tầng ứng dụng, và
-- một lỗi lọc là rò dữ liệu của người dùng khác. Ngoài ra SPA này không có
-- backend nào để ghi file: sự kiện sinh ra ở Edge Function (hạ tầng Supabase)
-- và trong chính Postgres, không đi qua máy nào của người vận hành.
--
-- Chi phí lưu trữ: log là **sự kiện rời rạc** (mất kết nối, vượt ngưỡng, OTA),
-- không phải chuỗi thời gian như `telemetry` — vài trăm dòng/ngày cho toàn hệ
-- thống, khoảng 250 byte/dòng kể cả index. Dọn định kỳ nằm ở migration 0019
-- cùng chỗ với retention của telemetry.

-- ---------------------------------------------------------------------
-- 1. Bảng
--
-- `event` là mã máy đọc ('device_offline', 'ota_pushed'...) còn `message` là
-- câu tiếng Việt hiển thị thẳng lên UI. Tách hai thứ vì chúng đổi vì lý do
-- khác nhau: sửa lại câu chữ cho dễ hiểu không được phép làm hỏng bộ lọc/
-- thống kê đang đếm theo loại sự kiện.
--
-- `station_id`/`device_id` nullable: có sự kiện ở mức tài khoản (dọn dữ liệu,
-- lưu trữ) không thuộc trạm nào. `device_id` dùng `on delete set null` để xoá
-- một thiết bị không xoá mất lịch sử sự cố của nó — cùng quy ước với
-- `telemetry.device_id` (0003).
-- ---------------------------------------------------------------------
create table public.system_logs (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  station_id uuid references public.stations (id) on delete cascade,
  device_id uuid references public.devices (id) on delete set null,
  level text not null check (level in ('info', 'warn', 'error')),
  -- Nơi sinh ra sự kiện: 'db' (trigger), 'ingest' / 'ota' / 'archive'
  -- (Edge Function). Giúp trả lời "cái này do đâu ghi ra" khi soát lỗi.
  source text not null default 'db',
  event text not null,
  message text not null,
  meta jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- Truy vấn chính của UI: log của một trạm, mới nhất trước.
create index system_logs_station_created_idx
  on public.system_logs (station_id, created_at desc);
-- Sự kiện mức tài khoản (station_id null) + job dọn theo owner (0019).
create index system_logs_owner_created_idx
  on public.system_logs (owner_id, created_at desc);

alter table public.system_logs enable row level security;

create policy "system_logs_select_own" on public.system_logs
  for select using (owner_id = auth.uid());

-- Cố tình KHÔNG có policy insert/update/delete cho client. Nhật ký chỉ có giá
-- trị khi nó là bản ghi khách quan về những gì hệ thống đã làm: nếu trình
-- duyệt ghi được vào đây thì một người dùng có thể tự thêm "thiết bị đã online"
-- hoặc xoá bằng chứng một lần OTA hỏng. Mọi lượt ghi đi qua log_event() (trigger)
-- hoặc service role (Edge Function) — cùng quy ước với `devices`/`telemetry`.

-- Realtime: UI subscribe INSERT để log mới hiện ra không cần tải lại trang.
-- Bọc trong DO vì publication `supabase_realtime` có thể chưa tồn tại khi chạy
-- migration trên môi trường local mới dựng, và thêm lại bảng đã có sẽ báo lỗi.
do $$
begin
  alter publication supabase_realtime add table public.system_logs;
exception
  when undefined_object then null;   -- chưa có publication
  when duplicate_object then null;   -- đã thêm rồi
end;
$$;

-- ---------------------------------------------------------------------
-- 2. log_event() — lối ghi duy nhất từ phía SQL.
--
-- security definer để trigger và job nền ghi được vào bảng không có policy
-- insert. Thu hồi quyền của client: `authenticated` gọi được nghĩa là trình
-- duyệt lại forge được log, đúng thứ mục 1 vừa chặn.
-- ---------------------------------------------------------------------
create or replace function public.log_event(
  p_owner_id uuid,
  p_level text,
  p_event text,
  p_message text,
  p_station_id uuid default null,
  p_device_id uuid default null,
  p_meta jsonb default '{}'::jsonb,
  p_source text default 'db'
)
returns bigint
language plpgsql
security definer set search_path = public
as $$
declare
  v_id bigint;
begin
  insert into public.system_logs (
    owner_id, station_id, device_id, level, source, event, message, meta
  )
  values (
    p_owner_id, p_station_id, p_device_id, p_level, p_source, p_event, p_message,
    coalesce(p_meta, '{}'::jsonb)
  )
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.log_event(uuid, text, text, text, uuid, uuid, jsonb, text) from public;
revoke all on function public.log_event(uuid, text, text, text, uuid, uuid, jsonb, text) from anon;
revoke all on function public.log_event(uuid, text, text, text, uuid, uuid, jsonb, text) from authenticated;
grant execute on function public.log_event(uuid, text, text, text, uuid, uuid, jsonb, text) to service_role;

-- ---------------------------------------------------------------------
-- 3. SỬA LỖI KÈM THEO: apply_telemetry không còn cập nhật stations.last_seen_at
--
-- 0004 thêm `last_seen_at = new.ts` vào nhánh UPDATE stations, nhưng 0012 viết
-- lại hàm này và làm rơi mất dòng đó; 0017 chép lại bản của 0012 nên lỗi còn
-- tới giờ. Hậu quả: `stations.last_seen_at` luôn null → mark_stale_offline
-- (0006, nhánh `last_seen_at is null`) gạt trạm về 'offline' mỗi phút, rồi bản
-- tin telemetry kế tiếp lại đặt 'online' — trạm đang chạy bình thường vẫn nhấp
-- nháy trạng thái mỗi phút.
--
-- Phải sửa ở đây chứ không để lại sau: mục 4 bên dưới ghi log mỗi lần trạng
-- thái đổi, nên nếu không sửa thì bảng nhật ký sẽ ngập sự kiện online/offline
-- giả cứ 60 giây một lần — tính năng này không dùng được.
--
-- Ngoài dòng đó, hàm giữ nguyên hoàn toàn hành vi của 0017.
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
    battery_current = coalesce(new.battery_current, s.battery_current),
    charge_enabled = coalesce(new.charge_enabled, s.charge_enabled),
    discharge_enabled = coalesce(new.discharge_enabled, s.discharge_enabled),
    protect_reason = coalesce(new.protect_reason, s.protect_reason),
    status = 'online',
    last_seen_at = new.ts
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

-- Vá dữ liệu đang lệch: trạm đã từng nhận telemetry nhưng last_seen_at còn
-- null thì lấy mốc mới nhất của thiết bị thuộc trạm đó, để mark_stale_offline
-- không đánh nhầm ngay ở phút đầu tiên sau khi migration chạy.
update public.stations s
set last_seen_at = d.max_seen
from (
  select station_id, max(last_seen_at) as max_seen
  from public.devices
  where last_seen_at is not null
  group by station_id
) d
where d.station_id = s.id and s.last_seen_at is null;

-- ---------------------------------------------------------------------
-- 4. Nguồn log #1 — thiết bị mất/lập lại kết nối MQTT.
--
-- Đặt ở trigger trên `devices` chứ không nhét vào apply_telemetry: trạng thái
-- thiết bị được đổi từ HAI nơi (apply_telemetry đặt 'connected',
-- mark_stale_offline đặt 'disconnected'), và một trigger bắt đúng khoảnh khắc
-- cột đổi giá trị thì bao trọn cả hai mà không phải sửa hàm nào.
--
-- Quan trọng: chỉ ghi khi giá trị THỰC SỰ đổi. apply_telemetry chạy mỗi bản
-- tin (~10 giây/lần) và luôn set status='connected'; nếu ghi log mỗi lần chạy
-- thì mỗi thiết bị sinh 8.640 dòng/ngày — đúng thứ khiến người ta phải lo về
-- dung lượng. Với guard này, một thiết bị chạy ổn định sinh 0 dòng.
-- ---------------------------------------------------------------------
create or replace function public.log_device_status_change()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_station_name text;
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  select name into v_station_name from public.stations where id = new.station_id;

  if new.status = 'connected' then
    perform public.log_event(
      new.owner_id, 'info', 'device_online',
      format('%s kết nối MQTT thành công (%s)', new.name, coalesce(v_station_name, 'không rõ trạm')),
      new.station_id, new.id,
      jsonb_build_object('from', old.status, 'to', new.status)
    );
  else
    perform public.log_event(
      new.owner_id, 'error', 'device_offline',
      format('Mất kết nối MQTT với %s (%s) — không nhận được dữ liệu quá 90 giây',
             new.name, coalesce(v_station_name, 'không rõ trạm')),
      new.station_id, new.id,
      jsonb_build_object('from', old.status, 'to', new.status, 'last_seen_at', new.last_seen_at)
    );
  end if;

  return new;
end;
$$;

create trigger devices_log_status_change
  after update of status on public.devices
  for each row execute function public.log_device_status_change();

-- ---------------------------------------------------------------------
-- 5. Nguồn log #2 — pin tụt dưới ngưỡng của chế độ đang chọn.
--
-- Ngưỡng lấy từ `station_settings.battery_modes -> active_battery_mode ->>
-- 'minSoc'` (0009) chứ không phải một hằng số mới: đó chính là con số người
-- dùng chỉnh ở mục "Ngưỡng pin" của DevConsole, nên cảnh báo luôn khớp với
-- những gì họ đã cấu hình.
--
-- Chống rung (hysteresis): pin dao động quanh đúng ngưỡng sẽ sinh log mỗi bản
-- tin nếu chỉ so sánh thuần. `battery_alert_active` nhớ trạng thái cảnh báo,
-- và chỉ báo "đã hồi phục" khi vượt lại ngưỡng + 5%. Một chu kỳ tụt-rồi-hồi
-- sinh đúng 2 dòng.
--
-- BEFORE UPDATE để sửa `new.battery_alert_active` ngay trong lượt ghi đang có,
-- không phát sinh thêm UPDATE nào lên `stations`.
-- ---------------------------------------------------------------------
alter table public.stations
  add column if not exists battery_alert_active boolean not null default false;

create or replace function public.log_station_battery_alert()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_min_soc numeric;
  v_mode text;
begin
  if new.battery_pct is null then
    return new;
  end if;

  select ss.active_battery_mode,
         (ss.battery_modes -> ss.active_battery_mode ->> 'minSoc')::numeric
    into v_mode, v_min_soc
  from public.station_settings ss
  where ss.station_id = new.id;

  -- Trạm chưa có cấu hình ngưỡng (hoặc JSON thiếu minSoc) thì không có gì để
  -- so sánh — im lặng còn hơn cảnh báo dựa trên số bịa ra.
  if v_min_soc is null then
    return new;
  end if;

  if new.battery_pct < v_min_soc and not coalesce(new.battery_alert_active, false) then
    new.battery_alert_active := true;
    perform public.log_event(
      new.owner_id, 'warn', 'battery_below_threshold',
      format('%s: pin còn %s%%, dưới ngưỡng %s%% của chế độ "%s"',
             new.name, new.battery_pct, v_min_soc, v_mode),
      new.id, null,
      jsonb_build_object('battery_pct', new.battery_pct, 'min_soc', v_min_soc, 'mode', v_mode)
    );
  elsif new.battery_pct >= v_min_soc + 5 and coalesce(new.battery_alert_active, false) then
    new.battery_alert_active := false;
    perform public.log_event(
      new.owner_id, 'info', 'battery_recovered',
      format('%s: pin đã hồi lên %s%%, trên ngưỡng %s%%', new.name, new.battery_pct, v_min_soc),
      new.id, null,
      jsonb_build_object('battery_pct', new.battery_pct, 'min_soc', v_min_soc, 'mode', v_mode)
    );
  end if;

  return new;
end;
$$;

create trigger stations_log_battery_alert
  before update of battery_pct on public.stations
  for each row execute function public.log_station_battery_alert();

-- ---------------------------------------------------------------------
-- 6. RPC cho UI: xoá toàn bộ log của một trạm ("Xoá nhật ký").
--
-- Bảng cố tình không có policy delete (mục 1), nên thao tác này đi qua một hàm
-- security definer tự kiểm tra quyền sở hữu — cùng khuôn với delete_device
-- (0011). Trả về số dòng đã xoá để UI báo lại cho người dùng.
-- ---------------------------------------------------------------------
create or replace function public.clear_station_logs(p_station_id uuid)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_deleted integer;
begin
  if not exists (
    select 1 from public.stations
    where id = p_station_id and owner_id = auth.uid()
  ) then
    raise exception 'not_owner';
  end if;

  delete from public.system_logs
  where station_id = p_station_id and owner_id = auth.uid();

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.clear_station_logs(uuid) from public;
grant execute on function public.clear_station_logs(uuid) to authenticated;
