-- Mở rộng nguồn sinh nhật ký hệ thống (bảng `system_logs`, 0018).
--
-- Bối cảnh: 0018 dựng đường ống nhật ký nhưng chỉ nối vào ĐÚNG HAI nguồn
-- (thiết bị đổi trạng thái MQTT, pin dưới ngưỡng); các Edge Function thêm được
-- OTA và lưu trữ. Kết quả là mục "Nhật ký hệ thống" của DevConsole gần như
-- trống trong vận hành thật, trong khi hệ thống liên tục làm những việc đáng
-- ghi lại mà không để lại dấu vết nào:
--
--   * TOÀN BỘ hệ cảnh báo của 0023 (quá nhiệt, quá tải, sụt áp, ngắt sạc/xả,
--     mất kết nối trạm) mở ra rồi đóng lại mà nhật ký không có một dòng nào —
--     đây là khoảng trống lớn nhất: 7 loại sự cố × 2 thời điểm;
--   * mọi THAO TÁC của người vận hành (bật/tắt tải, đổi ngưỡng cảnh báo, đổi
--     chế độ pin, đổi số ngày giữ dữ liệu, thêm/xoá thiết bị, tải firmware
--     lên) không được ghi lại — khi một trạm hành xử lạ, không có cách nào
--     biết được ai vừa đổi cái gì, và "đổi số ngày giữ dữ liệu" là thao tác
--     XOÁ dữ liệu vĩnh viễn;
--   * thiết bị khởi động lại (`boot_count` tăng — dữ liệu đã có từ 0017) hay
--     đổi phiên bản firmware đang chạy không sinh sự kiện nào, dù đó chính là
--     thứ đầu tiên cần nhìn khi một trạm chập chờn;
--   * tải được bật nhưng relay không đóng (thiết bị báo `reported_state` khác
--     `desired_state`) — một hỏng hóc thật, im lặng hoàn toàn.
--
-- Migration này nối các nguồn đó vào, giữ nguyên nguyên tắc gốc của 0018:
-- **chỉ ghi khi trạng thái thực sự đổi**, không bao giờ ghi mỗi bản tin.
--
-- Chi phí: mọi trigger bên dưới hoặc gắn vào bảng KHÔNG bị apply_telemetry ghi
-- mỗi 10 giây (loads, station_settings, user_settings, stations.name,
-- firmware_releases, alerts), hoặc thoát ra ở dòng đầu khi giá trị không đổi
-- (devices). Một hệ thống chạy ổn định vẫn sinh 0 dòng.

-- ---------------------------------------------------------------------
-- 1. Phân loại `source` — bộ lọc "sự kiện này do đâu ra" trên DevConsole
--
-- 0018 để `source` mặc định 'db' cho mọi trigger, đủ dùng khi chỉ có 2 loại
-- sự kiện. Với ~35 loại thì "do đâu ra" không còn trả lời được bằng một giá
-- trị duy nhất, mà nó chính là cách người đọc thu hẹp nhật ký về đúng thứ
-- đang tìm. Bảy nhóm dưới đây tách theo CÂU HỎI người đọc đang có, không theo
-- vị trí code:
--
--   alert   — sự cố vận hành (bắc cầu từ bảng `alerts`, 0023)
--   device  — vòng đời & sức khoẻ thiết bị (kết nối, khởi động lại, firmware)
--   control — điều khiển tải từ xa
--   config  — người vận hành đổi cấu hình (dấu vết kiểm toán)
--   ingest  — Edge Function nhận telemetry
--   ota     — quản lý & đẩy firmware
--   archive — lưu trữ / dọn dữ liệu
--
-- Cột không có CHECK constraint (0018 mục 1) nên không cần ALTER; chỉ nắn lại
-- dữ liệu cũ để bộ lọc mới không bỏ sót nhật ký đã ghi trước migration này.
-- ---------------------------------------------------------------------
update public.system_logs
set source = 'device'
where source = 'db' and event in ('device_online', 'device_offline');

update public.system_logs
set source = 'alert'
where source = 'db' and event in ('battery_below_threshold', 'battery_recovered');

-- ---------------------------------------------------------------------
-- 2. log_event_throttled — cho những nguồn KHÔNG tự giới hạn được tần suất
--
-- Phần lớn trigger bên dưới chỉ chạy khi một giá trị thực sự đổi, nên tự nó
-- đã hiếm. Nhưng vài nguồn thì không: firmware hỏng gửi sai định dạng mỗi 10
-- giây, hay relay kẹt khiến trạng thái báo về lệch mãi mãi. Ghi thẳng thì một
-- thiết bị hỏng sinh 8.640 dòng/ngày và đẩy mọi sự kiện khác ra khỏi tầm nhìn
-- — đúng thứ 0018 đã tránh cho `device_online`.
--
-- Cửa sổ chặn tính theo (owner, event, station, device) chứ không theo cả nội
-- dung message: hai lỗi khác nhau của cùng một loại trên cùng một thiết bị,
-- cách nhau 3 giây, vẫn là MỘT chuyện cần biết.
--
-- Trả về NULL khi bị chặn để nơi gọi phân biệt được (dùng cho ingest).
-- ---------------------------------------------------------------------
create or replace function public.log_event_throttled(
  p_owner_id uuid,
  p_level text,
  p_event text,
  p_message text,
  p_station_id uuid default null,
  p_device_id uuid default null,
  p_meta jsonb default '{}'::jsonb,
  p_source text default 'db',
  p_window interval default interval '30 minutes'
)
returns bigint
language plpgsql
security definer set search_path = public
as $$
begin
  if exists (
    select 1 from public.system_logs l
    where l.owner_id = p_owner_id
      and l.event = p_event
      and l.station_id is not distinct from p_station_id
      and l.device_id is not distinct from p_device_id
      and l.created_at > now() - p_window
  ) then
    return null;
  end if;

  return public.log_event(
    p_owner_id, p_level, p_event, p_message,
    p_station_id, p_device_id, p_meta, p_source
  );
end;
$$;

revoke all on function public.log_event_throttled(uuid, text, text, text, uuid, uuid, jsonb, text, interval) from public;
revoke all on function public.log_event_throttled(uuid, text, text, text, uuid, uuid, jsonb, text, interval) from anon;
revoke all on function public.log_event_throttled(uuid, text, text, text, uuid, uuid, jsonb, text, interval) from authenticated;
grant execute on function public.log_event_throttled(uuid, text, text, text, uuid, uuid, jsonb, text, interval) to service_role;

-- log_target_alive — chốt an toàn BẮT BUỘC cho mọi trigger AFTER DELETE bên
-- dưới.
--
-- `system_logs` có khoá ngoại tới `auth.users` (owner_id) và `stations`
-- (station_id, on delete cascade). Trong một lượt xoá dây chuyền — xoá trạm
-- kéo theo thiết bị/tải, xoá tài khoản kéo theo tất cả — hàng cha đã biến mất
-- trong CÙNG transaction khi trigger của hàng con chạy. Ghi một dòng nhật ký
-- trỏ tới nó lúc đó không chỉ ghi hỏng: nó ném lỗi khoá ngoại và làm HỎNG CẢ
-- LƯỢT XOÁ. Người dùng bấm "Xoá trạm" và nhận về một lỗi khó hiểu, chỉ vì hệ
-- thống cố ghi nhật ký về chính việc đang làm.
--
-- Bỏ qua ở đây cũng đúng về nội dung: lượt xoá dây chuyền đã có đúng một dòng
-- tổng kết (`station_deleted`), còn liệt kê từng tải/thiết bị bị cuốn theo chỉ
-- lặp lại cùng một chuyện.
--
-- Chỉ gọi trong nhánh DELETE và nhánh khoá ngoại bị gỡ (device_id → null), tức
-- những đường hiếm — không nằm trên luồng telemetry 10 giây/lần.
create or replace function public.log_target_alive(p_owner_id uuid, p_station_id uuid)
returns boolean
language sql
stable
security definer set search_path = public, auth
as $$
  select exists (select 1 from auth.users u where u.id = p_owner_id)
     and (p_station_id is null
          or exists (select 1 from public.stations s where s.id = p_station_id));
$$;

-- Khoảng thời gian đọc được bằng tiếng Việt, cho câu "đã kéo dài bao lâu".
-- Cắt ở phút: một đợt quá nhiệt kéo dài "2 giờ 14 phút" là thông tin, còn
-- thêm số giây thì chỉ làm dòng log dài ra.
create or replace function public.fmt_duration_vi(p interval)
returns text
language sql
immutable
as $$
  select case
    when p is null then 'không rõ'
    when extract(epoch from p) < 60 then 'dưới 1 phút'
    when extract(epoch from p) < 3600
      then format('%s phút', floor(extract(epoch from p) / 60))
    when extract(epoch from p) < 86400
      then format('%s giờ %s phút',
                  floor(extract(epoch from p) / 3600),
                  floor((extract(epoch from p)::bigint % 3600) / 60))
    else format('%s ngày %s giờ',
                floor(extract(epoch from p) / 86400),
                floor((extract(epoch from p)::bigint % 86400) / 3600))
  end;
$$;

-- ---------------------------------------------------------------------
-- 3. NGUỒN LỚN NHẤT — bắc cầu `alerts` (0023) sang nhật ký
--
-- 0023 cố ý tách hai bảng: `alerts` là "ngay lúc này còn gì đang sai" cho
-- người dùng cuối, `system_logs` là nhật ký kỹ thuật append-only cho
-- DevConsole. Việc tách đó vẫn đúng — nhưng nó bị hiểu thành "nhật ký không
-- cần biết gì về cảnh báo", và đó là lý do mục nhật ký gần như trống: bảy
-- loại sự cố vận hành THẬT đi qua `alerts` mà không để lại dòng nào.
--
-- Bắc cầu bằng trigger trên `alerts` chứ không sửa raise_alert/resolve_alert:
--   * hai hàm đó có nhiều đường vào (apply_telemetry, mark_stale_offline, câu
--     INSERT backfill ở 0023 mục 9) — trigger bao trọn cả ba mà không phải
--     nhớ sửa từng chỗ, đúng lý do 0018 mục 4 chọn trigger thay vì sửa hàm;
--   * `raise_alert` dùng ON CONFLICT DO NOTHING, nên trigger AFTER INSERT chỉ
--     chạy khi một đợt THẬT SỰ được mở — bản tin thứ hai trở đi của cùng một
--     đợt không chèn được hàng nào nên cũng không sinh log. Chống rung có
--     sẵn, không phải thêm gì.
--
-- Mức log suy từ `severity` của đợt cảnh báo, không đặt lại một bảng quy đổi
-- thứ hai: danger → error, warning → warn. Đóng đợt luôn là 'info' bất kể đợt
-- đó nặng đến đâu — "đã hết quá nhiệt" là tin tốt.
-- ---------------------------------------------------------------------
create or replace function public.log_alert_opened()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  -- Hàng backfill của 0023 mục 9 mô tả chuyện đã xảy ra TRƯỚC khi có nhật ký;
  -- ghi nó với dấu thời gian của hôm nay sẽ báo một sự cố vừa xảy ra trong khi
  -- thực ra nó có từ tuần trước.
  if coalesce((new.meta ->> 'backfilled')::boolean, false) then
    return null;
  end if;

  perform public.log_event(
    new.owner_id,
    case new.severity when 'danger' then 'error' when 'warning' then 'warn' else 'info' end,
    'alert_' || new.kind,
    new.message,
    new.station_id, null,
    jsonb_build_object(
      'alert_id', new.id, 'kind', new.kind, 'severity', new.severity,
      'value', new.value, 'threshold', new.threshold
    ) || coalesce(new.meta, '{}'::jsonb),
    'alert'
  );
  return null;
end;
$$;

drop trigger if exists alerts_log_opened on public.alerts;
create trigger alerts_log_opened
  after insert on public.alerts
  for each row execute function public.log_alert_opened();

-- Đóng đợt. Bám vào chuyển tiếp null → not null của `resolved_at` chứ không
-- chỉ `update of resolved_at`: mỗi lần người dùng bấm "đã đọc" cũng là một
-- UPDATE lên hàng này (0023 mục 3), và "đã đọc" không phải một sự kiện hệ
-- thống.
--
-- Thời lượng đợt là thứ duy nhất ở đây không tìm lại được chỗ khác sau khi
-- hàng `alerts` bị dọn (0023 mục 8) — nên nó nằm trong chính câu message.
create or replace function public.log_alert_resolved()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if old.resolved_at is not null or new.resolved_at is null then
    return null;
  end if;

  perform public.log_event(
    new.owner_id, 'info',
    'alert_' || new.kind || '_cleared',
    format('Đã hết: %s (kéo dài %s)',
           new.message,
           public.fmt_duration_vi(new.resolved_at - new.started_at)),
    new.station_id, null,
    jsonb_build_object(
      'alert_id', new.id, 'kind', new.kind,
      'started_at', new.started_at, 'resolved_at', new.resolved_at
    ),
    'alert'
  );
  return null;
end;
$$;

drop trigger if exists alerts_log_resolved on public.alerts;
create trigger alerts_log_resolved
  after update of resolved_at on public.alerts
  for each row execute function public.log_alert_resolved();

-- Gỡ trigger pin của 0018 mục 5: từ giờ nó ghi TRÙNG với `alert_low_battery`
-- ở trên. Hai dòng nói cùng một chuyện, đọc từ cùng một ngưỡng
-- (`battery_modes -> chế độ đang chọn ->> 'minSoc'`), cùng biên độ chống rung
-- 5% — 0023 mục 5 chép lại đúng logic đó khi dựng hệ cảnh báo. Giữ cả hai chỉ
-- làm mỗi lần pin yếu chiếm hai dòng nhật ký.
--
-- Khác biệt duy nhất còn lại: đường qua `alerts` tôn trọng công tắc "Cảnh báo
-- pin yếu" ở Cài đặt → Thông báo (0023 mục 5). Tắt công tắc đó thì không còn
-- dòng pin yếu nào trong nhật ký nữa — đúng ý người dùng vừa bấm, và các loại
-- sự cố an toàn khác không tắt được nên nhật ký không mất gì quan trọng.
--
-- Cột `stations.battery_alert_active` giữ nguyên (không drop): cùng quy ước ít
-- rủi ro với `user_settings.battery_modes` ở 0009.
drop trigger if exists stations_log_battery_alert on public.stations;

-- ---------------------------------------------------------------------
-- 4. Vòng đời & sức khoẻ thiết bị
--
-- 4a. Thêm / gỡ thiết bị. `register_device` (0008) và `delete_device` (0011)
-- là hai RPC riêng, nhưng cả hai cuối cùng đều INSERT/DELETE trên bảng này —
-- trigger bắt được cả hai lẫn mọi đường vào sau này.
--
-- Lưu ý FK: `system_logs.device_id` trỏ tới `devices` (0018 mục 1), nên trong
-- trigger AFTER DELETE hàng thiết bị đã biến mất và không tham chiếu tới được
-- nữa. Ghi `device_id = null` và cất id vào `meta` — nhật ký về việc xoá vẫn
-- còn nguyên, chỉ là không còn khoá ngoại để nối.
-- ---------------------------------------------------------------------
create or replace function public.log_device_registered()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_station_name text;
begin
  select name into v_station_name from public.stations where id = new.station_id;

  perform public.log_event(
    new.owner_id, 'info', 'device_registered',
    format('Đã đăng ký thiết bị %s (%s) vào trạm %s — AWS thing: %s',
           new.name, new.type, coalesce(v_station_name, 'không rõ'), new.aws_thing_name),
    new.station_id, new.id,
    jsonb_build_object('type', new.type, 'aws_thing_name', new.aws_thing_name),
    'device'
  );
  return null;
end;
$$;

drop trigger if exists devices_log_registered on public.devices;
create trigger devices_log_registered
  after insert on public.devices
  for each row execute function public.log_device_registered();

create or replace function public.log_device_removed()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if not public.log_target_alive(old.owner_id, old.station_id) then
    return null;
  end if;

  perform public.log_event(
    old.owner_id, 'warn', 'device_removed',
    format('Đã xoá thiết bị %s khỏi hệ thống — thing/chứng chỉ trên AWS vẫn còn, '
           || 'thiết bị sẽ nhận lỗi unknown_device khi publish',
           old.name),
    old.station_id, null,
    jsonb_build_object('device_id', old.id, 'name', old.name, 'type', old.type,
                       'aws_thing_name', old.aws_thing_name),
    'device'
  );
  return null;
end;
$$;

drop trigger if exists devices_log_removed on public.devices;
create trigger devices_log_removed
  after delete on public.devices
  for each row execute function public.log_device_removed();

-- 4b. Thiết bị khởi động lại + đổi firmware đang chạy.
--
-- `boot_count` (0017) do firmware đếm và gửi kèm mỗi bản tin; apply_telemetry
-- ghi thẳng vào `devices`. Số đó tăng nghĩa là MCU vừa reset — và một trạm
-- "chập chờn không rõ lý do" gần như luôn là chuyện này, nhưng cho tới giờ nó
-- chỉ hiện dưới dạng một con số trong ô chẩn đoán, không có mốc thời gian nào.
--
-- Hàm chạy mỗi bản tin (~10 giây/thiết bị) vì apply_telemetry luôn liệt kê hai
-- cột này trong câu UPDATE, nên nó phải thoát ra TRƯỚC mọi truy vấn khi không
-- có gì đổi — cùng khuôn với log_device_status_change (0018 mục 4).
--
-- `boot_count` GIẢM = thiết bị được nạp lại firmware/xoá NVS, không phải khởi
-- động lại; không ghi để tránh một dòng sai ngay sau mỗi lần OTA.
create or replace function public.log_device_health()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if new.boot_count is not distinct from old.boot_count
     and new.fw_version is not distinct from old.fw_version then
    return null;
  end if;

  if old.boot_count is not null and new.boot_count is not null
     and new.boot_count > old.boot_count then
    perform public.log_event(
      new.owner_id, 'warn', 'device_rebooted',
      format('%s vừa khởi động lại (lần thứ %s kể từ khi nạp firmware)',
             new.name, new.boot_count),
      new.station_id, new.id,
      jsonb_build_object('from', old.boot_count, 'to', new.boot_count,
                         'uptime_s', new.uptime_s),
      'device'
    );
  end if;

  if new.fw_version is distinct from old.fw_version and new.fw_version is not null then
    perform public.log_event(
      new.owner_id, 'info', 'device_firmware_changed',
      format('%s báo đang chạy firmware %s (trước đó: %s)',
             new.name, new.fw_version, coalesce(old.fw_version, 'chưa rõ')),
      new.station_id, new.id,
      jsonb_build_object('from', old.fw_version, 'to', new.fw_version),
      'device'
    );
  end if;

  return null;
end;
$$;

drop trigger if exists devices_log_health on public.devices;
create trigger devices_log_health
  after update of boot_count, fw_version on public.devices
  for each row execute function public.log_device_health();

-- 4c. Điểm phát WiFi (SoftAP) của thiết bị đổi. Firmware báo SSID/mật khẩu
-- thật nó đang phát (0014) và ingest-telemetry chỉ ghi khi KHÁC giá trị đang
-- lưu, nên trigger này hiếm khi chạy. Đáng ghi vì đây là thông tin người dùng
-- mang ra hiện trường để kết nối trực tiếp vào thiết bị: đổi mà không biết thì
-- lần sau ra tận nơi mới phát hiện.
--
-- Mật khẩu KHÔNG vào nhật ký (kể cả `meta`): nhật ký đọc được ở DevConsole và
-- xuất được ra CSV, còn mật khẩu AP đã có chỗ hiển thị riêng có che/hiện trong
-- mục "Cấu hình điểm phát WiFi".
create or replace function public.log_device_ap_changed()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if new.ap_ssid is not distinct from old.ap_ssid then
    return null;
  end if;

  perform public.log_event(
    new.owner_id, 'info', 'device_ap_changed',
    format('%s đang phát WiFi cấu hình với tên mạng "%s" (trước đó: "%s")',
           new.name, coalesce(new.ap_ssid, '—'), coalesce(old.ap_ssid, 'chưa báo')),
    new.station_id, new.id,
    jsonb_build_object('from', old.ap_ssid, 'to', new.ap_ssid),
    'device'
  );
  return null;
end;
$$;

drop trigger if exists devices_log_ap_changed on public.devices;
create trigger devices_log_ap_changed
  after update of ap_ssid on public.devices
  for each row execute function public.log_device_ap_changed();

-- 4d. Đưa hai sự kiện của 0018 mục 4 về nhóm 'device'. Nội dung câu chữ và
-- điều kiện ghi giữ nguyên hoàn toàn — chỉ đổi `source` để bộ lọc mới ở mục 1
-- gom đúng chúng cùng các sự kiện thiết bị vừa thêm.
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
      jsonb_build_object('from', old.status, 'to', new.status),
      'device'
    );
  else
    perform public.log_event(
      new.owner_id, 'error', 'device_offline',
      format('Mất kết nối MQTT với %s (%s) — không nhận được dữ liệu quá 90 giây',
             new.name, coalesce(v_station_name, 'không rõ trạm')),
      new.station_id, new.id,
      jsonb_build_object('from', old.status, 'to', new.status, 'last_seen_at', new.last_seen_at),
      'device'
    );
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 5. Vòng đời trạm
--
-- Bẫy khoá ngoại: `system_logs.station_id` dùng `on delete cascade` (0018 mục
-- 1), nên ghi log việc XOÁ trạm kèm `station_id = old.id` sẽ tự xoá chính dòng
-- log đó trong cùng câu lệnh. Ghi ở mức tài khoản (`station_id = null`) — cũng
-- đúng về ngữ nghĩa: sau khi xoá thì trạm đó không còn để mà thuộc về.
-- useSystemLogs đã lấy kèm sự kiện `station_id is null` (xem lib/systemLogs.js).
--
-- Đổi tên trạm KHÔNG dùng `after update` chung: apply_telemetry ghi vào
-- `stations` mỗi 10 giây; `after update of name` chỉ chạy khi cột `name` nằm
-- trong câu UPDATE, mà câu UPDATE của apply_telemetry (0023 mục 6) không đụng
-- tới nó. Đây là lý do phải chỉ rõ cột, không phải tối ưu sớm.
-- ---------------------------------------------------------------------
create or replace function public.log_station_lifecycle()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.log_event(
      new.owner_id, 'info', 'station_created',
      format('Đã tạo trạm "%s"', new.name),
      new.id, null, jsonb_build_object('station_name', new.name), 'config'
    );
  elsif tg_op = 'DELETE' then
    -- Xoá cả tài khoản thì `owner_id` cũng không còn để tham chiếu tới.
    if not public.log_target_alive(old.owner_id, null) then
      return null;
    end if;
    perform public.log_event(
      old.owner_id, 'warn', 'station_deleted',
      format('Đã xoá trạm "%s" — toàn bộ thiết bị, tải, telemetry và cảnh báo của trạm '
             || 'này đã bị xoá theo', old.name),
      null, null,
      jsonb_build_object('station_id', old.id, 'station_name', old.name), 'config'
    );
  else
    if new.name is distinct from old.name then
      perform public.log_event(
        new.owner_id, 'info', 'station_renamed',
        format('Đã đổi tên trạm "%s" thành "%s"', old.name, new.name),
        new.id, null,
        jsonb_build_object('from', old.name, 'to', new.name), 'config'
      );
    end if;

    -- Múi giờ không phải tuỳ chọn hiển thị suông: `station_daily_energy`
    -- (0022) cắt ngày theo đúng cột này, nên đổi nó là đổi ranh giới của mọi
    -- cột trong báo cáo sản lượng. Sản lượng "hôm qua" đột nhiên khác đi mà
    -- không có dòng nhật ký nào thì trông y hệt một lỗi tính toán.
    if new.timezone is distinct from old.timezone then
      perform public.log_event(
        new.owner_id, 'info', 'station_timezone_changed',
        format('Đã đổi múi giờ của trạm "%s": %s → %s — ranh giới ngày trong báo cáo '
               || 'sản lượng thay đổi theo', new.name, old.timezone, new.timezone),
        new.id, null,
        jsonb_build_object('from', old.timezone, 'to', new.timezone), 'config'
      );
    end if;
  end if;
  return null;
end;
$$;

drop trigger if exists stations_log_lifecycle on public.stations;
create trigger stations_log_lifecycle
  after insert or delete on public.stations
  for each row execute function public.log_station_lifecycle();

-- Chỉ rõ hai cột: apply_telemetry ghi vào `stations` mỗi 10 giây nhưng không
-- đụng tới `name`/`timezone`, nên trigger này không chạy trong luồng telemetry.
drop trigger if exists stations_log_renamed on public.stations;
create trigger stations_log_renamed
  after update of name, timezone on public.stations
  for each row execute function public.log_station_lifecycle();

-- ---------------------------------------------------------------------
-- 6. Điều khiển tải
--
-- `loads` (0010) có hai cột trạng thái với ý nghĩa khác hẳn nhau, và chính
-- khoảng cách giữa chúng là thứ đáng ghi nhất ở đây:
--   * `desired_state` — người dùng bấm công tắc trên dashboard;
--   * `reported_state` — thiết bị báo relay đã đóng/mở thật (chỉ service role
--     ghi được, qua ingest-telemetry).
--
-- Lệnh đi mà relay không đóng là một hỏng hóc thật (relay kẹt, dây tín hiệu
-- đứt, firmware không xử lý lệnh) và hiện tại nó im lặng tuyệt đối.
--
-- Hai cái bẫy khi phát hiện lệch, và cách né:
--
--   * NGAY SAU khi bấm công tắc thì lệch là BÌNH THƯỜNG — lệnh còn đang trên
--     đường xuống thiết bị. Cảnh báo lúc đó sai, và sai đều đặn sau mỗi lần
--     bấm thì người dùng học được cách bỏ qua nó. Cần biết "lệnh đã đi bao
--     lâu rồi", mà bảng không có mốc đó → thêm cột `desired_at` bên dưới.
--   * relay hỏng hẳn thì MỌI bản tin sau đó đều lệch; ghi thẳng là 8.640
--     dòng/ngày → đi qua log_event_throttled (mục 2), cửa sổ một giờ.
--
-- Hai phút ân hạn: chu kỳ telemetry ~10 giây, nên một thiết bị đang chạy có
-- thừa 12 lượt để xác nhận. Còn lệch sau hai phút thì không phải độ trễ nữa.
-- ---------------------------------------------------------------------
alter table public.loads
  add column if not exists desired_at timestamptz not null default now();

-- Đóng dấu thời điểm người dùng đổi ý. BEFORE trigger vì phải sửa `new` ngay
-- trong lượt ghi đang có; nhánh `else` cũng là chốt chặn client tự đặt giá trị
-- này (cùng khuôn với loads_protect_reported, 0010) — nếu không, trình duyệt
-- lùi `desired_at` về quá khứ là bỏ qua được cả phần ân hạn.
create or replace function public.loads_stamp_desired_at()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' or new.desired_state is distinct from old.desired_state then
    new.desired_at := now();
  else
    new.desired_at := old.desired_at;
  end if;
  return new;
end;
$$;

drop trigger if exists loads_stamp_desired on public.loads;
create trigger loads_stamp_desired
  before insert or update on public.loads
  for each row execute function public.loads_stamp_desired_at();

create or replace function public.log_load_activity()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.log_event(
      new.owner_id, 'info', 'load_created',
      format('Đã thêm tải "%s" (%s W)', new.name, new.watt),
      new.station_id, new.device_id,
      jsonb_build_object('load_id', new.id, 'watt', new.watt), 'control'
    );
    return null;
  end if;

  if tg_op = 'DELETE' then
    -- Xem log_target_alive (mục 2): xoá trạm/tài khoản cuốn theo bảng này, và
    -- lúc đó ghi log sẽ ném lỗi khoá ngoại làm hỏng cả lượt xoá.
    if not public.log_target_alive(old.owner_id, old.station_id) then
      return null;
    end if;
    -- `device_id` để null: thiết bị của tải này có thể vừa bị xoá trong cùng
    -- lượt (khoá ngoại `system_logs.device_id` sẽ không tham chiếu được nữa).
    perform public.log_event(
      old.owner_id, 'warn', 'load_removed',
      format('Đã xoá tải "%s"', old.name),
      old.station_id, null,
      jsonb_build_object('load_id', old.id, 'name', old.name,
                         'device_id', old.device_id), 'control'
    );
    return null;
  end if;

  -- Người dùng bấm công tắc.
  if new.desired_state is distinct from old.desired_state then
    perform public.log_event(
      new.owner_id, 'info',
      case when new.desired_state then 'load_switched_on' else 'load_switched_off' end,
      format('Đã gửi lệnh %s tải "%s"',
             case when new.desired_state then 'BẬT' else 'TẮT' end, new.name),
      new.station_id, new.device_id,
      jsonb_build_object('load_id', new.id, 'desired_state', new.desired_state), 'control'
    );
  end if;

  -- Thiết bị xác nhận relay đã chuyển. Chỉ ghi khi giá trị đổi, nên một tải
  -- đứng yên không sinh dòng nào dù bản tin vẫn về đều.
  if new.reported_state is distinct from old.reported_state
     and new.reported_state is not null then
    perform public.log_event(
      new.owner_id, 'info', 'load_state_confirmed',
      format('Thiết bị xác nhận tải "%s" đã %s',
             new.name, case when new.reported_state then 'BẬT' else 'TẮT' end),
      new.station_id, new.device_id,
      jsonb_build_object('load_id', new.id, 'reported_state', new.reported_state), 'control'
    );
  end if;

  -- Lệnh và thực tế không khớp, và đã quá thời gian ân hạn (xem đầu mục 6).
  -- Điều kiện này được xét mỗi lần thiết bị báo trạng thái về, nhưng khi mọi
  -- thứ bình thường nó chỉ là vài phép so sánh cột — không truy vấn gì thêm.
  if new.reported_state is not null
     and new.reported_state is distinct from new.desired_state
     and now() - new.desired_at > interval '2 minutes' then
    perform public.log_event_throttled(
      new.owner_id, 'warn', 'load_state_mismatch',
      format('Tải "%s" được yêu cầu %s từ %s trước nhưng thiết bị vẫn báo đang %s '
             || '— kiểm tra relay và đường tín hiệu',
             new.name,
             case when new.desired_state then 'BẬT' else 'TẮT' end,
             public.fmt_duration_vi(now() - new.desired_at),
             case when new.reported_state then 'BẬT' else 'TẮT' end),
      new.station_id, new.device_id,
      jsonb_build_object('load_id', new.id, 'desired_state', new.desired_state,
                         'reported_state', new.reported_state,
                         'desired_at', new.desired_at,
                         'reported_at', new.reported_at),
      'control', interval '1 hour'
    );
  end if;

  -- Sửa thông số tải. Gộp một dòng chứ không tách ba: người dùng sửa tên, công
  -- suất và thiết bị gắn kèm trong cùng một lần mở form.
  --
  -- Chốt an toàn: gỡ thiết bị khỏi tải cũng xảy ra TỰ ĐỘNG khi thiết bị bị xoá
  -- (`loads.device_id` là on delete set null, 0010) — kể cả trong lượt xoá cả
  -- trạm. Lúc đó việc này không phải một thao tác của người dùng, và ghi log
  -- sẽ ném lỗi khoá ngoại (xem log_target_alive, mục 2).
  if new.name is distinct from old.name
     or new.watt is distinct from old.watt
     or new.device_id is distinct from old.device_id then
    if new.device_id is distinct from old.device_id
       and not public.log_target_alive(new.owner_id, new.station_id) then
      return null;
    end if;
    perform public.log_event(
      new.owner_id, 'info', 'load_updated',
      format('Đã sửa tải "%s"%s%s',
             new.name,
             case when new.name is distinct from old.name
                  then format(' (trước là "%s")', old.name) else '' end,
             case when new.watt is distinct from old.watt
                  then format(', công suất %s W → %s W', old.watt, new.watt) else '' end),
      new.station_id, new.device_id,
      jsonb_build_object('load_id', new.id,
                         'device_changed', new.device_id is distinct from old.device_id),
      'control'
    );
  end if;

  return null;
end;
$$;

drop trigger if exists loads_log_activity on public.loads;
create trigger loads_log_activity
  after insert or update or delete on public.loads
  for each row execute function public.log_load_activity();

-- ---------------------------------------------------------------------
-- 7. Dấu vết kiểm toán cấu hình theo trạm (`station_settings`)
--
-- Vì sao cấu hình cũng là "cảnh báo": mọi ngưỡng ở mục 3 đều đọc từ bảng này.
-- Một trạm đột nhiên hết cảnh báo quá nhiệt có thể vì nó đã nguội, hoặc vì ai
-- đó vừa nâng ngưỡng lên 80 °C — nhật ký không ghi thì hai chuyện đó trông
-- giống hệt nhau. Đây chính là dữ kiện đắt nhất khi soát lại một sự cố.
--
-- Ghi giá trị CŨ và MỚI vào câu message chứ không chỉ "đã đổi cấu hình": bảng
-- này chỉ giữ giá trị hiện tại, giá trị cũ không tìm lại được ở đâu khác sau
-- lượt ghi đè.
-- ---------------------------------------------------------------------
create or replace function public.log_station_settings_changed()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_old jsonb;
  v_new jsonb;
begin
  if new.active_battery_mode is distinct from old.active_battery_mode then
    perform public.log_event(
      new.owner_id, 'info', 'battery_mode_changed',
      format('Đã chuyển chế độ bảo vệ pin: %s → %s (ngưỡng pin yếu nay là %s%%)',
             old.active_battery_mode, new.active_battery_mode,
             coalesce(new.battery_modes -> new.active_battery_mode ->> 'minSoc', '?')),
      new.station_id, null,
      jsonb_build_object('from', old.active_battery_mode, 'to', new.active_battery_mode),
      'config'
    );
  end if;

  if new.battery_modes is distinct from old.battery_modes then
    v_old := old.battery_modes -> new.active_battery_mode;
    v_new := new.battery_modes -> new.active_battery_mode;
    perform public.log_event(
      new.owner_id, 'info', 'battery_thresholds_changed',
      format('Đã sửa ngưỡng pin của chế độ "%s": pin tối thiểu %s%% → %s%%, '
             || 'dòng sạc tối đa %s A → %s A',
             new.active_battery_mode,
             coalesce(v_old ->> 'minSoc', '?'), coalesce(v_new ->> 'minSoc', '?'),
             coalesce(v_old ->> 'maxCurrent', '?'), coalesce(v_new ->> 'maxCurrent', '?')),
      new.station_id, null,
      jsonb_build_object('mode', new.active_battery_mode, 'from', v_old, 'to', v_new),
      'config'
    );
  end if;

  if new.alert_thresholds is distinct from old.alert_thresholds then
    perform public.log_event(
      new.owner_id, 'warn', 'alert_thresholds_changed',
      format('Đã sửa ngưỡng cảnh báo: điện áp tối thiểu %s → %s V, nhiệt độ tối đa '
             || '%s → %s °C, tải tối đa %s → %s kW',
             coalesce(old.alert_thresholds ->> 'minVoltage', 'tắt'),
             coalesce(new.alert_thresholds ->> 'minVoltage', 'tắt'),
             coalesce(old.alert_thresholds ->> 'maxTempC', 'tắt'),
             coalesce(new.alert_thresholds ->> 'maxTempC', 'tắt'),
             coalesce(old.alert_thresholds ->> 'maxLoadKw', 'tắt'),
             coalesce(new.alert_thresholds ->> 'maxLoadKw', 'tắt')),
      new.station_id, null,
      jsonb_build_object('from', old.alert_thresholds, 'to', new.alert_thresholds),
      'config'
    );
  end if;

  if new.ap_config is distinct from old.ap_config then
    perform public.log_event(
      new.owner_id, 'info', 'ap_config_changed',
      'Đã sửa cấu hình điểm phát WiFi (SoftAP) của trạm',
      new.station_id, null,
      -- Cùng lý do với mục 4c: chỉ ghi những khoá đã đổi, không ghi giá trị —
      -- ap_config chứa mật khẩu AP.
      jsonb_build_object('changed_keys', (
        select coalesce(jsonb_agg(k), '[]'::jsonb)
        from jsonb_object_keys(coalesce(new.ap_config, '{}'::jsonb)) k
        where new.ap_config -> k is distinct from old.ap_config -> k
      )),
      'config'
    );
  end if;

  if new.module_visibility is distinct from old.module_visibility then
    perform public.log_event(
      new.owner_id, 'info', 'modules_changed',
      'Đã bật/tắt module hiển thị trên dashboard của trạm',
      new.station_id, null,
      jsonb_build_object('from', old.module_visibility, 'to', new.module_visibility),
      'config'
    );
  end if;

  return null;
end;
$$;

drop trigger if exists station_settings_log_changed on public.station_settings;
create trigger station_settings_log_changed
  after update on public.station_settings
  for each row execute function public.log_station_settings_changed();

-- ---------------------------------------------------------------------
-- 8. Dấu vết kiểm toán cấu hình theo tài khoản (`user_settings`)
--
-- Số ngày giữ dữ liệu là thao tác XOÁ dữ liệu vĩnh viễn, chỉ trông như một ô
-- nhập số: hạ từ 90 xuống 7 nghĩa là job đêm hôm đó xoá 83 ngày telemetry —
-- và nếu chế độ lưu trữ đang tắt thì xoá hẳn, không có bản sao trên Storage.
-- Vì vậy ghi mức 'warn', không phải 'info'.
--
-- Sự kiện mức tài khoản: `station_id = null` (0018 mục 1) — nó không thuộc
-- trạm nào và ảnh hưởng tới tất cả các trạm.
-- ---------------------------------------------------------------------
create or replace function public.log_user_settings_changed()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if new.telemetry_retention_days is distinct from old.telemetry_retention_days
     or new.log_retention_days is distinct from old.log_retention_days
     or new.telemetry_archive_enabled is distinct from old.telemetry_archive_enabled then
    perform public.log_event(
      new.owner_id, 'warn', 'retention_changed',
      format('Đã đổi chính sách lưu dữ liệu: telemetry %s → %s ngày, nhật ký %s → %s ngày, '
             || 'lưu trữ lên Storage %s. Job dọn đêm nay sẽ áp dụng mức mới.',
             old.telemetry_retention_days, new.telemetry_retention_days,
             old.log_retention_days, new.log_retention_days,
             case when new.telemetry_archive_enabled then 'BẬT' else 'TẮT (dữ liệu quá hạn bị xoá hẳn)' end),
      null, null,
      jsonb_build_object(
        'telemetry_retention_days', new.telemetry_retention_days,
        'log_retention_days', new.log_retention_days,
        'archive_enabled', new.telemetry_archive_enabled
      ),
      'config'
    );
  end if;

  if new.notif_prefs is distinct from old.notif_prefs then
    perform public.log_event(
      new.owner_id, 'info', 'notif_prefs_changed',
      -- Nhắc riêng lowBattery vì nó không chỉ đổi việc gửi thông báo: 0023 mục
      -- 5 dùng chính công tắc đó để quyết định có mở đợt cảnh báo pin yếu hay
      -- không, nên tắt nó là tắt luôn dòng nhật ký pin yếu (xem mục 3).
      format('Đã đổi tuỳ chọn thông báo%s',
             case
               when (new.notif_prefs -> 'lowBattery') is distinct from (old.notif_prefs -> 'lowBattery')
                 then format(' — cảnh báo pin yếu: %s',
                             case when coalesce((new.notif_prefs ->> 'lowBattery')::boolean, true)
                                  then 'BẬT' else 'TẮT (không còn ghi nhật ký pin yếu)' end)
               else '' end),
      null, null,
      jsonb_build_object('from', old.notif_prefs, 'to', new.notif_prefs),
      'config'
    );
  end if;

  if new.energy_unit is distinct from old.energy_unit then
    perform public.log_event(
      new.owner_id, 'info', 'energy_unit_changed',
      format('Đã đổi đơn vị hiển thị sản lượng: %s → %s', old.energy_unit, new.energy_unit),
      null, null,
      jsonb_build_object('from', old.energy_unit, 'to', new.energy_unit),
      'config'
    );
  end if;

  return null;
end;
$$;

drop trigger if exists user_settings_log_changed on public.user_settings;
create trigger user_settings_log_changed
  after update on public.user_settings
  for each row execute function public.log_user_settings_changed();

-- ---------------------------------------------------------------------
-- 9. Quản lý firmware
--
-- `send-ota-command` đã ghi `ota_pushed` và ingest-telemetry ghi
-- `ota_success`/`ota_failed`, nhưng bản thân kho firmware thì không: một ảnh
-- được tải lên hay bị xoá không để lại dấu vết nào. Xoá một bản phát hành là
-- việc đáng cảnh báo — thiết bị đang nạp dở bản đó sẽ mất nguồn tải file
-- (0015 để `fw_target_id` thành null qua devices_clear_fw_target).
--
-- Sự kiện mức tài khoản: kho firmware dùng chung cho mọi trạm.
-- ---------------------------------------------------------------------
create or replace function public.log_firmware_release_activity()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.log_event(
      new.owner_id, 'info', 'firmware_uploaded',
      format('Đã tải lên firmware %s cho board %s', new.version, new.board),
      null, null,
      jsonb_build_object('release_id', new.id, 'version', new.version, 'board', new.board),
      'ota'
    );
  else
    -- Xoá cả tài khoản cũng cuốn theo kho firmware (xem log_target_alive, mục 2).
    if not public.log_target_alive(old.owner_id, null) then
      return null;
    end if;
    perform public.log_event(
      old.owner_id, 'warn', 'firmware_deleted',
      format('Đã xoá firmware %s (board %s) khỏi kho — thiết bị đang nạp dở bản này '
             || 'sẽ không tải được file', old.version, old.board),
      null, null,
      jsonb_build_object('release_id', old.id, 'version', old.version, 'board', old.board),
      'ota'
    );
  end if;
  return null;
end;
$$;

drop trigger if exists firmware_releases_log_activity on public.firmware_releases;
create trigger firmware_releases_log_activity
  after insert or delete on public.firmware_releases
  for each row execute function public.log_firmware_release_activity();

-- ---------------------------------------------------------------------
-- 10. Chỉ số cho bộ lọc mới của DevConsole
--
-- Truy vấn của UI sau migration này là: (trạm này HOẶC mức tài khoản) + lọc
-- theo `level`/`source` + tìm trong `message`, sắp xếp theo `id desc`. Chỉ số
-- của 0018 đánh theo `created_at`, nên phần sắp xếp không dùng lại được —
-- Postgres phải sort toàn bộ nhật ký của trạm mỗi lần mở trang.
--
-- Đánh theo `id desc` chứ không `created_at desc`: `id` là identity tăng dần
-- nên hai thứ tự trùng nhau (mọi lượt ghi đều lấy `created_at` mặc định là
-- now()), nhưng `id` không có giá trị trùng — đó cũng là điều kiện để nút
-- "Tải thêm" phân trang bằng `id < <dòng cuối>` không bỏ sót hay lặp dòng khi
-- nhiều sự kiện rơi vào cùng một mili giây.
-- ---------------------------------------------------------------------
create index if not exists system_logs_station_id_desc_idx
  on public.system_logs (station_id, id desc);
create index if not exists system_logs_owner_id_desc_idx
  on public.system_logs (owner_id, id desc);
