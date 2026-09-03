-- Hệ thống cảnh báo thật cho người dùng cuối.
--
-- Bối cảnh: mục "Cảnh báo" trên Dashboard đang tự dựng danh sách ở client từ
-- mỗi `stations.status` (Dashboard.jsx), nghĩa là:
--   * chỉ có đúng hai loại, và loại 'warning' KHÔNG BAO GIỜ xảy ra — không có
--     gì trong database từng đặt `status = 'warning'` (0001 chỉ cho phép giá
--     trị đó tồn tại, 0007 đã bỏ seed demo);
--   * thẻ "Ngưỡng cảnh báo" trong Cài đặt là ba ô input `defaultValue` và một
--     nút không có onClick — không có cột nào đứng sau chúng;
--   * `protect_reason` (0012) — dữ liệu sự cố THẬT do firmware báo về — chỉ
--     được hiển thị ở trang Pin lưu trữ, không sinh ra cảnh báo nào;
--   * không có lịch sử: cảnh báo biến mất ngay khi trạng thái hồi phục;
--   * trạng thái "đã đọc" là useState, mất khi tải lại trang.
--
-- Migration này dựng đường ống thật: ngưỡng có chỗ lưu, một bảng `alerts`
-- append-only do database sinh ra, và ba nguồn kích hoạt (telemetry vượt
-- ngưỡng, thiết bị ngắt bảo vệ, trạm mất kết nối).
--
-- Vì sao là bảng riêng chứ không dùng `system_logs` (0018): hai thứ khác đối
-- tượng và khác vòng đời. `system_logs` là nhật ký kỹ thuật append-only cho
-- DevConsole (admin), một dòng = một sự kiện đã xảy ra, không có khái niệm
-- "đang diễn ra" hay "đã đọc". Cảnh báo thì có TRẠNG THÁI: nó mở ra, kéo dài,
-- rồi đóng lại khi hệ thống hồi phục — và người dùng cuối cần biết "ngay lúc
-- này còn gì đang sai" chứ không phải đọc lại nhật ký. Nhồi cả hai vào một
-- bảng thì mỗi truy vấn "cảnh báo đang mở" phải quét toàn bộ nhật ký kỹ thuật.
-- Hai bảng vẫn bổ sung cho nhau: 0018 mục 4/5 tiếp tục ghi log của nó.

-- ---------------------------------------------------------------------
-- 1. Ngưỡng cảnh báo — chỗ lưu cho thẻ "Ngưỡng cảnh báo" ở Cài đặt → Hệ thống
--
-- Đặt trên `station_settings` (0009) chứ không phải `user_settings`: ngưỡng
-- phụ thuộc phần cứng cụ thể của từng trạm (pack 48V và pack 24V có ngưỡng
-- điện áp thấp khác hẳn nhau), nên hai trạm cùng chủ phải đặt được khác nhau —
-- đúng lý do 0009 tách battery_modes ra khỏi user_settings.
--
-- Một jsonb thay vì ba cột: đây là tập ngưỡng còn sẽ dài ra (dòng điện tối đa,
-- tần suất mất kết nối...) và mỗi lần thêm một ngưỡng mà phải chạy migration
-- ALTER TABLE thì không tương xứng; cùng khuôn với `battery_modes` sẵn có.
--
-- Giá trị null cho một khoá = TẮT kiểm tra đó, khác với "chưa cấu hình". Nhờ
-- vậy người dùng bỏ trống ô "Nhiệt độ tối đa" (trạm không gắn cảm biến nhiệt)
-- mà không cần một cột boolean bật/tắt riêng cho từng ngưỡng.
--
-- Mặc định khớp đúng ba con số đang hiển thị cứng trong Dashboard.jsx hiện tại
-- (46 V / 45 °C / 2.0 kW) nên giao diện không đổi giá trị sau khi migration chạy.
--
-- KHÔNG có ngưỡng phần trăm pin ở đây: ngưỡng đó đã tồn tại và đang được dùng
-- thật ở `battery_modes -> <mode đang chọn> ->> 'minSoc'` (0009), và 0018 mục 5
-- đã ghi log theo đúng nguồn đó. Thêm một con số thứ hai cho cùng một khái niệm
-- là tạo ra hai nguồn sự thật lệch nhau — cảnh báo pin yếu bên dưới đọc lại
-- chính minSoc.
-- ---------------------------------------------------------------------
alter table public.station_settings
  add column if not exists alert_thresholds jsonb not null
    default jsonb_build_object('minVoltage', 46, 'maxTempC', 45, 'maxLoadKw', 2.0);

-- `handle_new_station()` (0009) không liệt kê cột này trong INSERT nên trạm mới
-- nhận thẳng DEFAULT ở trên — không phải sửa lại hàm đó.

-- ---------------------------------------------------------------------
-- 2. Bảng alerts
--
-- Mô hình "một hàng = một ĐỢT cảnh báo", không phải một hàng mỗi lần đo vượt
-- ngưỡng. Firmware publish 10 giây/lần (docs/IOT.md), nên nếu mỗi bản tin quá
-- nhiệt sinh một hàng thì một giờ quá nhiệt = 360 hàng nói đúng một việc. Ở đây
-- đợt cảnh báo mở ra một lần (`started_at`), sống suốt thời gian điều kiện còn
-- đúng, rồi đóng lại (`resolved_at`) khi hồi phục.
--
-- `resolved_at is null` = ĐANG diễn ra. Chỉ số unique một phần bên dưới biến
-- bất biến "mỗi trạm chỉ có tối đa một đợt đang mở cho mỗi loại" thành ràng
-- buộc của database, thay vì một quy ước mà mọi nơi ghi vào bảng phải tự nhớ.
--
-- `kind` là mã máy đọc, `message` là câu tiếng Việt hiển thị thẳng lên UI —
-- cùng lý do tách như `system_logs.event`/`message` (0018): sửa câu chữ không
-- được phép làm hỏng bộ lọc đang đếm theo loại.
--
-- `value`/`threshold` là số đo và ngưỡng TẠI THỜI ĐIỂM MỞ đợt, cố ý không cập
-- nhật theo từng bản tin sau đó (xem raise_alert mục 4). Giá trị hiện tại thì
-- Dashboard đã hiển thị realtime ở các ô thông số rồi; thứ chỉ có ở đây mà
-- không tìm lại được chỗ khác là "lúc bắt đầu hỏng thì nó bao nhiêu".
-- ---------------------------------------------------------------------
create table public.alerts (
  id uuid primary key default gen_random_uuid(),
  station_id uuid not null references public.stations (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  -- 'offline' | 'undervoltage' | 'overtemp' | 'overload' | 'low_battery' |
  -- 'charge_blocked' | 'discharge_blocked'
  kind text not null,
  severity text not null check (severity in ('info', 'warning', 'danger')),
  message text not null,
  value numeric,
  threshold numeric,
  meta jsonb not null default '{}',
  started_at timestamptz not null default now(),
  resolved_at timestamptz,
  read_at timestamptz,
  constraint alerts_resolved_after_started
    check (resolved_at is null or resolved_at >= started_at)
);

-- Bất biến "một đợt đang mở cho mỗi (trạm, loại)". Cũng chính là chỉ số mà
-- raise_alert dùng cho ON CONFLICT, nên hai bản tin đến cùng lúc không thể tạo
-- hai đợt trùng nhau.
create unique index alerts_open_per_kind_idx
  on public.alerts (station_id, kind)
  where resolved_at is null;

-- Truy vấn chính của Dashboard: cảnh báo của TẤT CẢ trạm thuộc tài khoản, mới
-- nhất trước (chuông thông báo phải thấy được trạm không mở trên màn hình).
create index alerts_owner_started_idx on public.alerts (owner_id, started_at desc);
create index alerts_station_started_idx on public.alerts (station_id, started_at desc);

alter table public.alerts enable row level security;

create policy "alerts_select_own" on public.alerts
  for select using (owner_id = auth.uid());

-- Update: chỉ để đánh dấu đã đọc. Cột nào được phép đổi thì trigger ở mục 3
-- quyết định — policy chỉ chặn được "hàng nào", không chặn được "cột nào".
create policy "alerts_update_own" on public.alerts
  for update using (owner_id = auth.uid());

-- Xoá: chỉ những đợt ĐÃ ĐÓNG. Người dùng phải dọn được lịch sử cũ, nhưng xoá
-- một cảnh báo đang diễn ra thì chỉ làm mất dấu sự cố còn nguyên đó — lần
-- telemetry kế tiếp cũng sẽ mở lại đúng đợt đó thôi.
create policy "alerts_delete_resolved_own" on public.alerts
  for delete using (owner_id = auth.uid() and resolved_at is not null);

-- Cố tình KHÔNG có policy insert: cảnh báo do database sinh ra từ số đo thật.
-- Trình duyệt tự thêm được thì danh sách cảnh báo không còn là bằng chứng về
-- những gì đã thực sự xảy ra — cùng quy ước với `system_logs`/`telemetry`.

-- ---------------------------------------------------------------------
-- 3. Chặn client sửa nội dung cảnh báo
--
-- Cùng khuôn với loads_protect_reported (0010) và stations_protect_cycle
-- (0020): policy cho update cả hàng, trigger trả lại mọi cột trừ `read_at`.
-- Không có bước này thì một người dùng đặt được `resolved_at = now()` để tự
-- "tắt" cảnh báo quá nhiệt mà không sửa gì ở thực tế.
--
-- Trigger này KHÔNG chặn resolve_alert (mục 4) dù đó cũng là một UPDATE, vì cả
-- hai đường gọi hợp lệ đều không phải phiên của người dùng cuối:
--   * qua apply_telemetry — do Edge Function `ingest-telemetry` chèn telemetry
--     bằng service role → auth.role() = 'service_role', nhánh IF bỏ qua;
--   * qua mark_stale_offline — chạy từ pg_cron, không có JWT nào cả, nên
--     auth.role() trả NULL và `NULL <> 'service_role'` là NULL (không phải
--     true) → nhánh IF cũng bỏ qua.
-- Trình duyệt thì không gọi được hai hàm đó (đã revoke ở mục 4), và nếu ghi
-- thẳng vào bảng thì rơi đúng vào nhánh IF này.
-- ---------------------------------------------------------------------
create or replace function public.alerts_protect_columns()
returns trigger
language plpgsql
as $$
begin
  if auth.role() <> 'service_role' then
    new.station_id := old.station_id;
    new.owner_id := old.owner_id;
    new.kind := old.kind;
    new.severity := old.severity;
    new.message := old.message;
    new.value := old.value;
    new.threshold := old.threshold;
    new.meta := old.meta;
    new.started_at := old.started_at;
    new.resolved_at := old.resolved_at;
  end if;
  return new;
end;
$$;

create trigger alerts_protect
  before update on public.alerts
  for each row execute function public.alerts_protect_columns();

-- Realtime: cảnh báo mới phải hiện ra ngay, không đợi tải lại trang — đó là
-- toàn bộ giá trị của một hệ thống cảnh báo. Bọc trong DO vì publication có
-- thể chưa tồn tại trên môi trường local mới dựng (cùng cách làm với 0018).
do $$
begin
  alter publication supabase_realtime add table public.alerts;
exception
  when undefined_object then null;   -- chưa có publication
  when duplicate_object then null;   -- đã thêm rồi
end;
$$;

-- ---------------------------------------------------------------------
-- 4. raise_alert / resolve_alert — hai lối ghi duy nhất
--
-- security definer vì bảng không có policy insert (mục 2); thu hồi quyền của
-- client để trình duyệt không gọi thẳng được, cùng khuôn với log_event (0018).
--
-- ON CONFLICT ... DO NOTHING chứ không DO UPDATE, có chủ đích: đợt đã mở thì
-- bản tin thứ hai trở đi không ghi gì cả. Nếu cập nhật `value` theo từng bản
-- tin thì mỗi đợt cảnh báo sinh 6 UPDATE/phút lên bảng này, mỗi UPDATE là một
-- sự kiện realtime bắn xuống mọi trình duyệt đang mở — biến một cảnh báo tĩnh
-- thành một dòng dữ liệu chạy liên tục. Một đợt kéo dài cả ngày vẫn chỉ tốn
-- đúng hai lượt ghi: mở và đóng.
-- ---------------------------------------------------------------------
create or replace function public.raise_alert(
  p_station_id uuid,
  p_owner_id uuid,
  p_kind text,
  p_severity text,
  p_message text,
  p_value numeric default null,
  p_threshold numeric default null,
  p_meta jsonb default '{}'::jsonb,
  p_at timestamptz default now()
)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.alerts (
    station_id, owner_id, kind, severity, message, value, threshold, meta, started_at
  )
  values (
    p_station_id, p_owner_id, p_kind, p_severity, p_message, p_value, p_threshold,
    coalesce(p_meta, '{}'::jsonb), p_at
  )
  on conflict (station_id, kind) where resolved_at is null
  do nothing;
end;
$$;

create or replace function public.resolve_alert(
  p_station_id uuid,
  p_kind text,
  p_at timestamptz default now()
)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  update public.alerts
  set resolved_at = greatest(p_at, started_at)
  where station_id = p_station_id
    and kind = p_kind
    and resolved_at is null;
end;
$$;

revoke all on function public.raise_alert(uuid, uuid, text, text, text, numeric, numeric, jsonb, timestamptz) from public;
revoke all on function public.raise_alert(uuid, uuid, text, text, text, numeric, numeric, jsonb, timestamptz) from anon;
revoke all on function public.raise_alert(uuid, uuid, text, text, text, numeric, numeric, jsonb, timestamptz) from authenticated;
revoke all on function public.resolve_alert(uuid, text, timestamptz) from public;
revoke all on function public.resolve_alert(uuid, text, timestamptz) from anon;
revoke all on function public.resolve_alert(uuid, text, timestamptz) from authenticated;

-- ---------------------------------------------------------------------
-- 5. evaluate_station_alerts — bộ luật, chạy mỗi bản tin telemetry
--
-- Chống rung (hysteresis) ở mọi ngưỡng. Điện áp pin dao động quanh đúng 46 V
-- sẽ mở/đóng cảnh báo mỗi 10 giây nếu chỉ so sánh thuần — vùng chết giữa
-- "ngưỡng mở" và "ngưỡng đóng" khiến một chu kỳ hỏng-rồi-hồi sinh đúng một
-- đợt. Cùng nguyên tắc (và cùng biên độ 5% cho pin) với 0018 mục 5.
--
-- Nằm trong vùng chết = không mở cũng không đóng, giữ nguyên trạng thái hiện
-- tại. Đó là ý nghĩa của hysteresis, không phải trường hợp bị bỏ sót.
--
-- Số đo null (trạm không gắn cảm biến nhiệt, bản tin thiếu trường) → bỏ qua
-- kiểm tra đó hoàn toàn: không mở cảnh báo mới, và cũng KHÔNG đóng đợt đang
-- mở. Mất cảm biến không phải bằng chứng đã hết quá nhiệt.
-- ---------------------------------------------------------------------
create or replace function public.evaluate_station_alerts(
  p_station_id uuid,
  p_owner_id uuid,
  p_ts timestamptz,
  p_battery_voltage numeric,
  p_temp_c numeric,
  p_load_w numeric,
  p_battery_pct numeric,
  p_charge_enabled boolean,
  p_discharge_enabled boolean,
  p_protect_reason text
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_name text;
  v_thresholds jsonb;
  v_min_voltage numeric;
  v_max_temp numeric;
  v_max_load_kw numeric;
  v_min_soc numeric;
  v_mode text;
  v_low_battery_on boolean;
  v_load_kw numeric;
  v_reason text;
begin
  select s.name into v_name from public.stations s where s.id = p_station_id;

  select ss.alert_thresholds,
         ss.active_battery_mode,
         (ss.battery_modes -> ss.active_battery_mode ->> 'minSoc')::numeric
    into v_thresholds, v_mode, v_min_soc
  from public.station_settings ss
  where ss.station_id = p_station_id;

  -- Trạm chưa có hàng station_settings (chỉ xảy ra nếu ai đó chèn stations
  -- vòng qua trigger 0009) — không có ngưỡng nào để so sánh, im lặng còn hơn
  -- cảnh báo dựa trên số bịa ra.
  if v_thresholds is null then
    return;
  end if;

  v_min_voltage := (v_thresholds ->> 'minVoltage')::numeric;
  v_max_temp := (v_thresholds ->> 'maxTempC')::numeric;
  v_max_load_kw := (v_thresholds ->> 'maxLoadKw')::numeric;

  -- Bản tin đã tới nghĩa là trạm đang nói chuyện được → đóng đợt mất kết nối.
  perform public.resolve_alert(p_station_id, 'offline', p_ts);

  -- --- Điện áp pin thấp -------------------------------------------------
  -- Vùng chết 1 V: pack 48V sụt áp tức thời khi tải nặng khởi động rồi hồi
  -- ngay, biên độ đó đủ để một cú sụt thoáng qua không mở cảnh báo giả.
  if v_min_voltage is not null and p_battery_voltage is not null then
    if p_battery_voltage < v_min_voltage then
      perform public.raise_alert(
        p_station_id, p_owner_id, 'undervoltage', 'danger',
        format('%s: điện áp pin còn %s V, dưới ngưỡng %s V',
               v_name, round(p_battery_voltage, 1), round(v_min_voltage, 1)),
        p_battery_voltage, v_min_voltage, '{}'::jsonb, p_ts
      );
    elsif p_battery_voltage >= v_min_voltage + 1 then
      perform public.resolve_alert(p_station_id, 'undervoltage', p_ts);
    end if;
  end if;

  -- --- Nhiệt độ pin cao -------------------------------------------------
  -- Vùng chết 2 °C: pin nguội chậm, quá nhiệt hồi phục thật thì thừa sức
  -- vượt biên độ này; dao động đo đạc ±0.5 °C thì không.
  if v_max_temp is not null and p_temp_c is not null then
    if p_temp_c > v_max_temp then
      perform public.raise_alert(
        p_station_id, p_owner_id, 'overtemp', 'danger',
        format('%s: nhiệt độ pin %s°C, vượt ngưỡng %s°C',
               v_name, round(p_temp_c, 1), round(v_max_temp, 1)),
        p_temp_c, v_max_temp, '{}'::jsonb, p_ts
      );
    elsif p_temp_c <= v_max_temp - 2 then
      perform public.resolve_alert(p_station_id, 'overtemp', p_ts);
    end if;
  end if;

  -- --- Tải vượt công suất cho phép --------------------------------------
  -- Vùng chết 5% của chính ngưỡng (không phải một hằng số kW cố định): ngưỡng
  -- 2 kW và ngưỡng 20 kW cần biên độ khác nhau về độ lớn.
  if v_max_load_kw is not null and p_load_w is not null then
    v_load_kw := p_load_w / 1000.0;
    if v_load_kw > v_max_load_kw then
      perform public.raise_alert(
        p_station_id, p_owner_id, 'overload', 'warning',
        format('%s: tải đang tiêu thụ %s kW, vượt mức cho phép %s kW',
               v_name, round(v_load_kw, 2), round(v_max_load_kw, 2)),
        v_load_kw, v_max_load_kw, '{}'::jsonb, p_ts
      );
    elsif v_load_kw <= v_max_load_kw * 0.95 then
      perform public.resolve_alert(p_station_id, 'overload', p_ts);
    end if;
  end if;

  -- --- Pin yếu ----------------------------------------------------------
  -- Ngưỡng lấy từ minSoc của chế độ bảo vệ đang chọn (0009) — chính con số
  -- người dùng chỉnh ở "Chế độ bảo vệ pin", nên cảnh báo luôn khớp cấu hình
  -- thay vì một hằng 20% riêng. Mặc định chế độ 'balanced' là 20, đúng bằng
  -- con số ghi trên nhãn "Cảnh báo pin yếu (dưới 20%)" ở Cài đặt → Thông báo.
  --
  -- Đây là loại cảnh báo DUY NHẤT bị tuỳ chọn thông báo chi phối: nhãn của nó
  -- ở phần Thông báo là một công tắc bật/tắt tường minh cho đúng loại này, nên
  -- tắt đi thì không sinh đợt mới (và đóng đợt đang mở). Các loại còn lại là
  -- sự cố an toàn — người dùng không "tắt" được việc pin đang quá nhiệt.
  select coalesce((us.notif_prefs ->> 'lowBattery')::boolean, true)
    into v_low_battery_on
  from public.user_settings us
  where us.owner_id = p_owner_id;

  if coalesce(v_low_battery_on, true) = false then
    perform public.resolve_alert(p_station_id, 'low_battery', p_ts);
  elsif v_min_soc is not null and p_battery_pct is not null then
    if p_battery_pct < v_min_soc then
      perform public.raise_alert(
        p_station_id, p_owner_id, 'low_battery', 'warning',
        format('%s: pin còn %s%%, dưới ngưỡng %s%% của chế độ "%s"',
               v_name, round(p_battery_pct), round(v_min_soc), v_mode),
        p_battery_pct, v_min_soc,
        jsonb_build_object('mode', v_mode), p_ts
      );
    elsif p_battery_pct >= v_min_soc + 5 then
      perform public.resolve_alert(p_station_id, 'low_battery', p_ts);
    end if;
  end if;

  -- --- Thiết bị đã ngắt sạc/xả theo bảo vệ -------------------------------
  -- Đây là sự cố do CHÍNH THIẾT BỊ báo (0012), không phải suy ra từ ngưỡng ở
  -- cloud, nên không có gì để chống rung: firmware đã tự trễ trước khi đóng
  -- cắt relay. 'full' không phải sự cố — pin sạc đầy thì ngắt sạc là đúng
  -- chức năng, cảnh báo lúc đó chỉ dạy người dùng bỏ qua chuông báo.
  v_reason := nullif(trim(coalesce(p_protect_reason, '')), '');

  if p_charge_enabled = false and v_reason is distinct from 'full' then
    perform public.raise_alert(
      p_station_id, p_owner_id, 'charge_blocked', 'warning',
      format('%s: đã ngắt sạc pin (%s)', v_name, coalesce(v_reason, 'không rõ lý do')),
      null, null, jsonb_build_object('protect_reason', v_reason), p_ts
    );
  elsif p_charge_enabled = true or v_reason = 'full' then
    perform public.resolve_alert(p_station_id, 'charge_blocked', p_ts);
  end if;

  if p_discharge_enabled = false then
    perform public.raise_alert(
      p_station_id, p_owner_id, 'discharge_blocked', 'danger',
      format('%s: đã ngắt xả pin (%s) — tải đang không được cấp điện từ pin',
             v_name, coalesce(v_reason, 'không rõ lý do')),
      null, null, jsonb_build_object('protect_reason', v_reason), p_ts
    );
  elsif p_discharge_enabled = true then
    perform public.resolve_alert(p_station_id, 'discharge_blocked', p_ts);
  end if;
end;
$$;

revoke all on function public.evaluate_station_alerts(uuid, uuid, timestamptz, numeric, numeric, numeric, numeric, boolean, boolean, text) from public;
revoke all on function public.evaluate_station_alerts(uuid, uuid, timestamptz, numeric, numeric, numeric, numeric, boolean, boolean, text) from anon;
revoke all on function public.evaluate_station_alerts(uuid, uuid, timestamptz, numeric, numeric, numeric, numeric, boolean, boolean, text) from authenticated;

-- ---------------------------------------------------------------------
-- 6. Nối bộ luật vào apply_telemetry + hồi sinh `status = 'warning'`
--
-- Giữ NGUYÊN toàn bộ phần snapshot + bộ đếm chu kỳ của 0020 (kể cả
-- `last_seen_at = new.ts` mà 0012/0017 từng làm rơi, xem 0018 mục 3). Hai thay
-- đổi duy nhất:
--
--   a) gọi evaluate_station_alerts TRƯỚC câu UPDATE, để câu UPDATE đó biết
--      được kết quả và đặt `status` trong cùng một lượt ghi. Đánh giá sau rồi
--      update lần hai sẽ thành hai lượt ghi lên `stations` mỗi 10 giây, và
--      lượt thứ hai lại kích hoạt cả chuỗi trigger của 0018/0020 thêm lần nữa.
--
--   b) `status` không còn cứng là 'online'. Trạm đang có cảnh báo mở mức
--      warning/danger thì đọc là 'warning' — đúng giá trị mà 0001 đã cho phép
--      tồn tại, STATION_STATUS_META đã có sẵn màu, và cho tới giờ chưa có gì
--      từng đặt. Không còn nhánh chết trong giao diện.
--
-- Thứ tự này cũng đúng về mặt ngữ nghĩa: cảnh báo được đánh giá trên SỐ ĐO VỪA
-- TỚI (tham số của hàm là các cột của `new`), không phải trên snapshot cũ.
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

  perform public.evaluate_station_alerts(
    new.station_id, new.owner_id, new.ts,
    new.battery_voltage, new.temp_c, new.load_w, new.battery_pct,
    new.charge_enabled, new.discharge_enabled, new.protect_reason
  );

  update public.stations s
  set
    solar_kw = coalesce(new.solar_kw, s.solar_kw),
    battery_pct = coalesce(new.battery_pct, s.battery_pct),
    battery_voltage = coalesce(new.battery_voltage, s.battery_voltage),
    battery_current = coalesce(new.battery_current, s.battery_current),
    charge_enabled = coalesce(new.charge_enabled, s.charge_enabled),
    discharge_enabled = coalesce(new.discharge_enabled, s.discharge_enabled),
    protect_reason = coalesce(new.protect_reason, s.protect_reason),
    status = case
      when exists (
        select 1 from public.alerts a
        where a.station_id = new.station_id
          and a.resolved_at is null
          and a.severity in ('warning', 'danger')
      ) then 'warning'
      else 'online'
    end,
    last_seen_at = new.ts,

    charge_energy_kwh = s.charge_energy_kwh
      + greatest(public.cycle_energy_kwh(s.cycle_anchor_ts, s.cycle_anchor_kw, new.ts, v_net_kw), 0),
    discharge_energy_kwh = s.discharge_energy_kwh
      + greatest(-public.cycle_energy_kwh(s.cycle_anchor_ts, s.cycle_anchor_kw, new.ts, v_net_kw), 0),
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
-- 7. Cảnh báo mất kết nối — nguồn thứ ba
--
-- Phải nằm ở mark_stale_offline (0004/0006) chứ không ở apply_telemetry: theo
-- đúng định nghĩa, mất kết nối là lúc KHÔNG có bản tin nào tới, nên không có
-- trigger telemetry nào chạy để phát hiện. Đây là điều kiện duy nhất chỉ quan
-- sát được từ một job chạy theo lịch.
--
-- Đợt được mở cho từng trạm vừa chuyển sang 'offline' trong chính lượt chạy
-- này (RETURNING của câu UPDATE), nên trạm đã offline từ hôm qua không bị mở
-- lại đợt mới mỗi phút. Chỉ số unique một phần ở mục 2 là lưới an toàn thứ hai
-- cho việc đó.
--
-- Đóng đợt thì không làm ở đây mà ở apply_telemetry (mục 5): bản tin telemetry
-- quay lại chính là bằng chứng đã có kết nối, và nó tới sớm hơn lượt cron kế
-- tiếp tới 60 giây.
-- ---------------------------------------------------------------------
create or replace function public.mark_stale_offline()
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  r record;
begin
  update public.devices
  set status = 'disconnected'
  where status = 'connected'
    and (last_seen_at is null or last_seen_at < now() - interval '90 seconds');

  -- CTE ghi dữ liệu rồi SELECT lại: `FOR ... IN UPDATE ... RETURNING` trực
  -- tiếp không phải dạng truy vấn mà plpgsql nhận cho vòng lặp.
  for r in
    with moved as (
      update public.stations s
      set status = 'offline'
      where s.status <> 'offline'
        and (s.last_seen_at is null or s.last_seen_at < now() - interval '90 seconds')
        and exists (select 1 from public.devices d where d.station_id = s.id)
      returning s.id, s.owner_id, s.name, s.last_seen_at
    )
    select * from moved
  loop
    perform public.raise_alert(
      r.id, r.owner_id, 'offline', 'danger',
      format('%s mất kết nối với server giám sát', r.name),
      null, null,
      jsonb_build_object('last_seen_at', r.last_seen_at)
    );
  end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- 8. Dọn cảnh báo đã đóng
--
-- Dùng chung `log_retention_days` (0019) chứ không thêm một cài đặt nữa: cả
-- hai đều là "lịch sử sự kiện giữ bao lâu", và bắt người dùng chỉnh hai con số
-- cho cùng một câu hỏi thì con số thứ hai sẽ luôn bị bỏ quên ở giá trị mặc định.
--
-- Cảnh báo ĐANG MỞ không bao giờ bị dọn, dù đã kéo dài bao lâu: một trạm hỏng
-- và bị bỏ quên sáu tháng thì cảnh báo của nó phải còn đó, đúng lúc đó mới cần.
-- ---------------------------------------------------------------------
create or replace function public.purge_resolved_alerts()
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_deleted integer;
begin
  delete from public.alerts a
  using public.user_settings us
  where us.owner_id = a.owner_id
    and a.resolved_at is not null
    and a.resolved_at < now() - make_interval(days => us.log_retention_days);

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- 19:30 UTC = 02:30 giờ Việt Nam, xen giữa các job của 0019 (19:00/19:20/19:40)
-- để không có hai lượt dọn chạy chồng nhau trên instance free.
select cron.schedule(
  'purge-resolved-alerts',
  '30 19 * * *',
  $$select public.purge_resolved_alerts()$$
);

-- ---------------------------------------------------------------------
-- 9. Nạp trạng thái hiện tại
--
-- Trạm ĐANG offline sẵn trước khi migration chạy sẽ không bao giờ được mục 7
-- phát hiện: câu UPDATE ở đó chỉ khớp `status <> 'offline'`, nên một trạm đã
-- offline từ trước không đổi trạng thái và không sinh đợt nào. Không có bước
-- này thì mục "Cảnh báo" hiện trống trơn cho đúng những trạm đang hỏng nặng
-- nhất, cho tới khi chúng online lại rồi hỏng lần nữa.
-- ---------------------------------------------------------------------
insert into public.alerts (station_id, owner_id, kind, severity, message, meta, started_at)
select
  s.id, s.owner_id, 'offline', 'danger',
  format('%s mất kết nối với server giám sát', s.name),
  jsonb_build_object('last_seen_at', s.last_seen_at, 'backfilled', true),
  coalesce(s.last_seen_at, now())
from public.stations s
where s.status = 'offline'
  and exists (select 1 from public.devices d where d.station_id = s.id)
on conflict (station_id, kind) where resolved_at is null
do nothing;
