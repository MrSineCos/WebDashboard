-- Câu chữ của cảnh báo quá tải đổi sang W, theo đúng đơn vị giao diện.
--
-- Toàn bộ dashboard đã bỏ kW: thẻ "Công suất mặt trời", "Tải tiêu thụ", sơ đồ
-- dòng năng lượng, trang Pin lưu trữ và ô "Tải tối đa" ở Cài đặt đều hiện W —
-- hệ này chạy tầm vài trăm W nên "0.50 kW" luôn phải nhân nhẩm mới so được với
-- nhãn ghi trên thiết bị. Chuỗi cảnh báo quá tải là chỗ CUỐI CÙNG còn nói kW,
-- và nó là chuỗi do database sinh (0023 mục 5) nên client không sửa được: người
-- dùng sẽ thấy thẻ báo "tải 800 W" ngay cạnh cảnh báo "tải đang tiêu thụ 0.8 kW,
-- vượt mức cho phép 0.75 kW" — cùng một sự việc, hai đơn vị.
--
-- KHÔNG đổi cách lưu ngưỡng: khoá `alert_thresholds -> 'maxLoadKw'` vẫn là kW.
-- Đó là dữ liệu đã nằm trong database của mọi trạm đang chạy; đổi đơn vị ở đây
-- đồng nghĩa phải migrate từng hàng và mọi bản client cũ còn mở trên máy người
-- dùng sẽ ghi đè lại bằng kW, lệch 1000 lần theo cả hai chiều. Thay vào đó
-- Dashboard.jsx quy đổi ngay tại ô nhập (hiện ×1000, lưu ÷1000) — biên duy nhất
-- có phép đổi đơn vị, và không có bước migrate dữ liệu nào cả.
--
-- Vì vậy migration này chỉ tạo lại hàm với đúng một thay đổi: hai con số trong
-- chuỗi `format()` của nhánh quá tải in ra W. Ngưỡng so sánh, vùng chết 5%,
-- `p_metric_value`/`p_threshold_value` ghi vào bảng `alerts` — tất cả giữ
-- nguyên bằng kW như 0023, để lịch sử cảnh báo cũ và mới vẫn cùng thang đo.
-- Phần thân còn lại sao y 0023 mục 5.
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
  -- Vùng chết 5% của chính ngưỡng (không phải một hằng số cố định): ngưỡng
  -- 2000 W và ngưỡng 20000 W cần biên độ khác nhau về độ lớn.
  --
  -- So sánh vẫn chạy bằng kW vì ngưỡng được lưu bằng kW; chỉ CÂU CHỮ in ra W,
  -- để khớp thẻ "Tải tiêu thụ" và ô "Tải tối đa (W)" mà người dùng nhìn thấy.
  if v_max_load_kw is not null and p_load_w is not null then
    v_load_kw := p_load_w / 1000.0;
    if v_load_kw > v_max_load_kw then
      perform public.raise_alert(
        p_station_id, p_owner_id, 'overload', 'warning',
        format('%s: tải đang tiêu thụ %s W, vượt mức cho phép %s W',
               v_name, round(p_load_w), round(v_max_load_kw * 1000)),
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

-- create or replace giữ nguyên quyền đã cấp, nhưng lặp lại cho khớp 0023 để
-- một lần chạy lại migration này trên database mới không bỏ sót gì.
revoke all on function public.evaluate_station_alerts(uuid, uuid, timestamptz, numeric, numeric, numeric, numeric, boolean, boolean, text) from public;
revoke all on function public.evaluate_station_alerts(uuid, uuid, timestamptz, numeric, numeric, numeric, numeric, boolean, boolean, text) from anon;
revoke all on function public.evaluate_station_alerts(uuid, uuid, timestamptz, numeric, numeric, numeric, numeric, boolean, boolean, text) from authenticated;
