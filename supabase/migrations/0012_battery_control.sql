-- Battery charge/discharge protection control.
--
-- Bối cảnh: các ngưỡng SOC/điện áp của "Chế độ bảo vệ pin" đã tồn tại trong
-- `station_settings.battery_modes` (migration 0009) nhưng CHƯA có gì thực thi
-- chúng — đổi mode chỉ lưu DB, không tác động phần cứng. Migration này bổ sung
-- phần "trạng thái báo cáo" của cơ chế điều khiển: thiết bị (firmware) là nơi
-- thực sự đóng/cắt relay sạc/xả theo ngưỡng (edge control, an toàn khi mất
-- mạng), rồi báo trạng thái đó về đây để dashboard hiển thị.
--
-- Chiều ngược lại (đẩy ngưỡng cloud → thiết bị) đi qua Edge Function
-- `send-battery-config`, không cần bảng riêng — nó đọc thẳng
-- `station_settings.battery_modes`/`active_battery_mode`.

-- ---------------------------------------------------------------------
-- telemetry: thiết bị báo thêm dòng điện pin + trạng thái relay bảo vệ.
-- Cùng quy ước với các cột telemetry sẵn có (0003): cột "rộng" phản chiếu
-- snapshot mà dashboard render; giá trị null = thiết bị không báo trường đó.
-- ---------------------------------------------------------------------
alter table public.telemetry
  add column if not exists battery_current numeric,
  add column if not exists charge_enabled boolean,
  add column if not exists discharge_enabled boolean,
  -- Lý do trạng thái sạc/xả hiện tại: 'ok' | 'full' | 'overvoltage' |
  -- 'deep_discharge' | 'undervoltage' | 'overtemp' | 'manual' ... (chuỗi tự
  -- do do firmware đặt; UI ánh xạ sang nhãn tiếng Việt, giá trị lạ hiển thị thô).
  add column if not exists protect_reason text;

-- ---------------------------------------------------------------------
-- stations: snapshot trạng thái bảo vệ mới nhất (giống battery_pct...).
-- ---------------------------------------------------------------------
alter table public.stations
  add column if not exists battery_current numeric,
  add column if not exists charge_enabled boolean,
  add column if not exists discharge_enabled boolean,
  add column if not exists protect_reason text;

-- ---------------------------------------------------------------------
-- Đưa các trường mới vào snapshot khi có telemetry. Giữ nguyên hành vi cũ
-- (coalesce số) và bổ sung 4 cột bảo vệ. Với boolean/text cũng coalesce để
-- một bản tin thiếu trường không xoá trạng thái đã biết trước đó.
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
    status = 'online'
  where s.id = new.station_id;

  if new.device_id is not null then
    update public.devices d
    set status = 'connected', last_seen_at = new.ts
    where d.id = new.device_id;
  end if;

  return new;
end;
$$;
