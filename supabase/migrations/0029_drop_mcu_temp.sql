-- 0029 — Gỡ hẳn `mcu_temp_c` khỏi hệ thống
--
-- Ô "Nhiệt độ MCU" đã được gỡ khỏi DevConsole; migration này gỡ nốt tầng dưới
-- để không còn cột nào được ghi mỗi 10 giây mà không ai đọc. Đi kèm: firmware
-- (`esp32s3.ino`) và simulator bỏ trường khỏi payload, `ingest-telemetry` bỏ
-- khỏi NUMERIC_FIELDS, `archive-telemetry` bỏ khỏi COLUMN_ORDER,
-- `lib/telemetry.js` bỏ `mcuTempC` khỏi mapRow.
--
-- ⚠ MẤT DỮ LIỆU, KHÔNG HOÀN TÁC ĐƯỢC: toàn bộ lịch sử nhiệt độ MCU đã thu
-- trong `telemetry` biến mất cùng cột. Các gói CSV đã lưu trữ trong bucket
-- `telemetry-archive` thì KHÔNG bị ảnh hưởng — chúng là file tĩnh, vẫn còn cột
-- `mcu_temp_c` bên trong. Nếu về sau cần nạp lại một gói cũ thì phải bỏ cột đó
-- ra trước, vì bảng đích không còn nhận nữa.
--
-- Thứ tự trong file này quan trọng: định nghĩa lại `apply_telemetry` TRƯỚC rồi
-- mới drop cột. Thân hàm plpgsql chỉ được phân giải lúc chạy, nên drop trước
-- sẽ để lại một trigger tham chiếu `new.mcu_temp_c` không còn tồn tại — và vì
-- trigger này chạy trên MỌI insert vào `telemetry`, mọi bản tin từ mọi thiết bị
-- sẽ lỗi cho tới khi hàm được sửa. Đảo thứ tự = ngừng thu dữ liệu toàn hệ thống.

-- ---------------------------------------------------------------------
-- 1. apply_telemetry — bản của 0023, bỏ đúng một dòng gán mcu_temp_c.
--
-- Chép lại nguyên văn phần còn lại (đánh giá cảnh báo → snapshot `stations` +
-- bộ đếm chu kỳ → snapshot `devices`) thay vì tìm cách vá cục bộ: `create or
-- replace function` luôn thay cả thân hàm, nên bản mới nhất phải tự chứa đủ
-- mọi thứ mà 0012/0017/0018/0020/0023 đã cộng dồn vào đây.
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
        boot_count = coalesce(new.boot_count, d.boot_count)
    where d.id = new.device_id;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. Bỏ cột ở cả hai nơi 0017 đã thêm.
--
-- `if exists` để migration chạy lại được trên database đã áp rồi (và trên
-- những bản dựng lại từ đầu, nơi thứ tự file đảm bảo cột chắc chắn tồn tại).
--
-- Không cần `cascade`: không có view, index hay ràng buộc nào dựa trên cột này
-- — nó chỉ từng được đọc bởi `apply_telemetry` (vừa sửa ở trên) và bởi giao
-- diện. Nếu `drop column` báo lỗi phụ thuộc thì nghĩa là có thứ gì đó phát
-- sinh sau 0017 mà migration này chưa biết: đọc thông báo lỗi rồi xử lý thứ đó
-- tường minh, đừng thêm `cascade` để nó im lặng biến mất.
-- ---------------------------------------------------------------------
alter table public.telemetry drop column if exists mcu_temp_c;
alter table public.devices   drop column if exists mcu_temp_c;
