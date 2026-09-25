import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { supabase } from './supabaseClient.js';
import { useAuth } from './AuthContext.jsx';
import { localSnapshotToReading, useLocalConnection } from './LocalConnectionContext.jsx';
import { tzStartOfDay } from './time.js';

function mapRow(row) {
  return {
    id: row.id,
    ts: row.ts,
    solarKw: row.solar_kw,
    batteryPct: row.battery_pct,
    batteryVoltage: row.battery_voltage,
    batteryCurrent: row.battery_current,
    loadW: row.load_w,
    // Nhiệt độ pack pin — KHÔNG phải nhiệt độ lõi MCU. Đại lượng đó từng có
    // (`mcu_temp_c`, migration 0017) nhưng đã bỏ hẳn ở 0029: cột không còn,
    // firmware/simulator không còn gửi.
    tempC: row.temp_c,
    rssi: row.rssi,
    // Chẩn đoán phần cứng (0017). DevConsole đọc snapshot mới nhất trên
    // `devices` chứ không qua đây; giữ trong map để chuỗi thời gian dùng được
    // ngay khi cần (boot_count đổi = vừa reboot).
    uptimeS: row.uptime_s,
    bootCount: row.boot_count,
    extra: row.extra || {},
  };
}

// Recent telemetry for one station, oldest-first (chart-ready), plus a live
// subscription so new device readings append without a refresh. RLS scopes
// rows to the signed-in owner; devices never write through this client.
export function useTelemetry(stationId, { limit = 60 } = {}) {
  // Bám vào user.id chứ không phải object `user`: object đó đổi identity mỗi
  // lần supabase làm mới token, và nếu effect chạy lại theo nó thì màn hình sẽ
  // nháy về trạng thái "Đang tải…" giữa lúc đang theo dõi. Áp dụng cho mọi
  // hook trong file này.
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const local = useLocalConnection();
  const [readings, setReadings] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userId || !stationId) {
      setReadings([]);
      setLoading(false);
      return;
    }
    let cancelled = false;

    async function load() {
      setLoading(true);
      const { data } = await supabase
        .from('telemetry')
        .select('*')
        .eq('station_id', stationId)
        .order('ts', { ascending: false })
        .limit(limit);
      if (cancelled) return;
      // Reverse to oldest-first for time-series rendering.
      setReadings((data || []).map(mapRow).reverse());
      setLoading(false);
    }

    load();

    // Realtime: append inserts for this station, keeping the window bounded.
    const channel = supabase
      .channel(`telemetry:${stationId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'telemetry', filter: `station_id=eq.${stationId}` },
        (payload) => {
          setReadings((prev) => [...prev, mapRow(payload.new)].slice(-limit));
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [userId, stationId, limit]);

  const displayReadings = useMemo(() => {
    if (!local.connected || local.localStationId !== stationId) return readings;
    const localRows = local.history.map(localSnapshotToReading).filter(Boolean);
    return [...readings, ...localRows]
      .sort((a, b) => new Date(a.ts) - new Date(b.ts))
      .slice(-limit);
  }, [readings, limit, stationId, local.connected, local.localStationId, local.history]);

  const latest = displayReadings.length ? displayReadings[displayReadings.length - 1] : null;

  return { readings: displayReadings, latest, loading: loading && !local.connected };
}

// Telemetry trong một khung thời gian trượt (windowMs tính ngược từ bây giờ),
// oldest-first, kèm subscription realtime — dùng cho trang "Biểu đồ thời gian
// thực" nơi người dùng tự chọn độ dài khung.
//
// Khác useTelemetry ở chỗ cửa sổ tính theo THỜI GIAN chứ không theo số điểm:
// chu kỳ gửi của thiết bị không cố định nên "60 điểm gần nhất" không tương ứng
// một khoảng thời gian xác định. `maxRows` là chốt chặn để một khung dài (24h)
// trên trạm gửi dày không kéo về hàng chục nghìn dòng; khi chạm trần ta giữ
// phần MỚI NHẤT và bật cờ `truncated` để UI nói rõ biểu đồ đang bị cắt bớt.
//
// Truyền stationId = null để hook nằm im (không query, không subscribe) — trang
// Dashboard dùng cách này để chỉ tải dữ liệu khi thực sự mở tab biểu đồ.
export function useTelemetryWindow(stationId, windowMs, { maxRows = 3000 } = {}) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const local = useLocalConnection();
  const [readings, setReadings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    if (!userId || !stationId || !windowMs) {
      setReadings([]);
      setTruncated(false);
      setLoading(false);
      return;
    }
    let cancelled = false;

    async function load() {
      setLoading(true);
      const since = new Date(Date.now() - windowMs).toISOString();
      const { data } = await supabase
        .from('telemetry')
        .select('*')
        .eq('station_id', stationId)
        .gte('ts', since)
        .order('ts', { ascending: false })
        .limit(maxRows);
      if (cancelled) return;
      setTruncated((data || []).length >= maxRows);
      setReadings((data || []).map(mapRow).reverse());
      setLoading(false);
    }

    load();

    const channel = supabase
      .channel(`telemetry-window:${stationId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'telemetry', filter: `station_id=eq.${stationId}` },
        (payload) => {
          // Khung trượt: mỗi bản tin mới cũng là dịp loại các điểm đã rơi ra
          // khỏi khung, nếu không biểu đồ sẽ phình ra mãi.
          const cutoff = Date.now() - windowMs;
          setReadings((prev) =>
            [...prev, mapRow(payload.new)]
              .filter((r) => new Date(r.ts).getTime() >= cutoff)
              .slice(-maxRows),
          );
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [userId, stationId, windowMs, maxRows]);

  const displayReadings = useMemo(() => {
    if (!local.connected || local.localStationId !== stationId || !windowMs) return readings;
    const cutoff = Date.now() - windowMs;
    const localRows = local.history
      .map(localSnapshotToReading)
      .filter((row) => row && new Date(row.ts).getTime() >= cutoff);
    return [...readings, ...localRows]
      .sort((a, b) => new Date(a.ts) - new Date(b.ts))
      .slice(-maxRows);
  }, [readings, stationId, windowMs, maxRows, local.connected, local.localStationId, local.history]);

  return { readings: displayReadings, loading: loading && !local.connected, truncated };
}

// All telemetry since midnight for one station, oldest-first, with a live
// subscription — used for "today" charge/discharge charts where a fixed-count
// window (useTelemetry's `limit`) wouldn't cover a full day.
//
// "Nửa đêm" tính theo múi giờ của TRẠM (`tz`, xem lib/time.js), không phải của
// trình duyệt: trạm đặt ở múi giờ khác người xem thì "hôm nay" của trạm bắt
// đầu ở một mốc khác, lấy nhầm sẽ thiếu/thừa vài giờ đầu ngày. Bỏ trống `tz`
// = múi giờ trình duyệt, đúng hành vi cũ.
export function useTelemetryToday(stationId, tz) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [readings, setReadings] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userId || !stationId) {
      setReadings([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const startOfDay = tzStartOfDay(Date.now(), tz);

    async function load() {
      setLoading(true);
      const { data } = await supabase
        .from('telemetry')
        .select('*')
        .eq('station_id', stationId)
        .gte('ts', startOfDay.toISOString())
        .order('ts', { ascending: true })
        .limit(10000);
      if (cancelled) return;
      setReadings((data || []).map(mapRow));
      setLoading(false);
    }

    load();

    const channel = supabase
      .channel(`telemetry-today:${stationId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'telemetry', filter: `station_id=eq.${stationId}` },
        (payload) => {
          const row = mapRow(payload.new);
          if (new Date(row.ts) >= startOfDay) {
            setReadings((prev) => [...prev, row]);
          }
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [userId, stationId, tz]);

  return { readings, loading };
}

function mapDailyRow(row) {
  return {
    day: row.day,
    solarKwh: Number(row.solar_kwh) || 0,
    loadKwh: Number(row.load_kwh) || 0,
    // Năng lượng vào/ra pin trong ngày (migration 0020) — cùng công thức với
    // bộ đếm chu kỳ tuổi thọ trên `stations`, để số chu kỳ của một ngày và số
    // chu kỳ tích luỹ không tính theo hai kiểu khác nhau.
    chargeKwh: Number(row.charge_kwh) || 0,
    dischargeKwh: Number(row.discharge_kwh) || 0,
  };
}

// Per-day kWh for the last `days` calendar days, computed server-side by the
// `station_daily_energy` RPC (migration 0005/0020) so the client never has to
// pull raw telemetry to build the Reports chart.
//
// Ranh giới ngày cắt theo múi giờ của trạm — `tz` đi thẳng vào tham số p_tz
// của RPC (migration 0022).
//
// Lưu ý triển khai: `stations.timezone` luôn có giá trị (mapRow đặt mặc định),
// nên thực tế p_tz LUÔN được gửi và database bắt buộc phải đã chạy 0022 —
// PostgREST tìm hàm theo đúng bộ tham số, gọi bản cũ 2 tham số kèm p_tz sẽ
// trả lỗi "Could not find the function" chứ không âm thầm bỏ qua. Nhánh
// `if (tz)` chỉ để hook còn gọi được khi cố ý truyền tz rỗng.
export function useDailyEnergy(stationId, days = 14, tz) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userId || !stationId) {
      setRows([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const params = { p_station_id: stationId, p_days: days };
    if (tz) params.p_tz = tz;
    supabase
      .rpc('station_daily_energy', params)
      .then(({ data }) => {
        if (cancelled) return;
        setRows((data || []).map(mapDailyRow));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, stationId, days, tz]);

  return { rows, loading };
}

function mapHourlyRow(row) {
  return {
    hour: row.hour,
    avgSolarW: row.avg_solar_w == null ? null : Number(row.avg_solar_w),
    avgLoadW: row.avg_load_w == null ? null : Number(row.avg_load_w),
    avgBatteryVoltage: row.avg_battery_voltage == null ? null : Number(row.avg_battery_voltage),
  };
}

// Hourly averages (solar/load power, battery voltage) for one calendar day,
// via the `station_hourly_energy` RPC — backs the "selected day" chart.
//
// `day` phải là ngày theo lịch của trạm ('YYYY-MM-DD', dựng bằng tzIsoDate /
// tzDayWindow) và `tz` phải là chính múi giờ đã dùng để dựng nó — RPC vừa lọc
// theo ngày vừa chia giờ bằng p_tz, hai bên lệch nhau sẽ trả về đúng 0 dòng
// hoặc dữ liệu của ngày kề. Xem chú thích của useDailyEnergy về p_tz.
export function useHourlyEnergy(stationId, day, tz) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userId || !stationId || !day) {
      setRows([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const params = { p_station_id: stationId, p_day: day };
    if (tz) params.p_tz = tz;
    supabase
      .rpc('station_hourly_energy', params)
      .then(({ data }) => {
        if (cancelled) return;
        setRows((data || []).map(mapHourlyRow));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, stationId, day, tz]);

  return { rows, loading };
}

// Số bản tin telemetry đã nhận trong một giờ qua, cho dải trạng thái ở mục
// "Nhật ký hệ thống" (DevConsole).
//
// Vì sao là một truy vấn đếm chứ không phải một loại log mới: nhật ký hệ thống
// cố ý chỉ ghi SỰ KIỆN RỜI RẠC (0018), nên "đã nhận một bản tin" không có chỗ
// ở đó — ~8.640 dòng/ngày/thiết bị sẽ lấp mất đúng những dòng cần đọc, và tốn
// thêm 2,2 MB/ngày/thiết bị trong hạn mức 500 MB mà `system_logs` lại KHÔNG có
// đường nén sang Storage như `telemetry` (0019). Bảng `telemetry` vốn đã là
// nhật ký của việc nhận dữ liệu; ở đây chỉ đếm lại nó.
//
// Rẻ: `telemetry_station_ts_idx` (station_id, ts desc) của 0003 phủ đúng điều
// kiện này, và `head: true` nên không kéo hàng nào về.
export function useIngestRate(stationId, { refreshMs = 60000 } = {}) {
  const [count, setCount] = useState(null);

  useEffect(() => {
    if (!stationId) {
      setCount(null);
      return;
    }
    let cancelled = false;

    async function measure() {
      const since = new Date(Date.now() - 3600000).toISOString();
      const { count: n, error } = await supabase
        .from('telemetry')
        .select('id', { count: 'exact', head: true })
        .eq('station_id', stationId)
        .gte('ts', since);
      if (cancelled) return;
      // Lỗi → null ("chưa đo được"), cố ý không phải 0: "không đếm được" và
      // "không có bản tin nào" là hai chuyện khác nhau, và cả dải trạng thái
      // này sinh ra để phân biệt đúng những chuyện như vậy.
      setCount(error ? null : (n ?? 0));
    }

    measure();
    // Đếm lại theo nhịp riêng thay vì bám vào realtime: một bản tin mỗi 10
    // giây nghĩa là con số này đổi 360 lần/giờ, mà nó chỉ được đọc như một
    // ước lượng độ lớn — cập nhật mỗi phút là đủ và không thêm truy vấn nào
    // vào đường telemetry.
    const timer = setInterval(measure, refreshMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [stationId, refreshMs]);

  return count;
}

// Devices registered under the signed-in owner. Reads are direct (RLS:
// select-own); telemetry writes still only ever happen server-side via the
// service role. `registerDevice`/`removeDevice` are the two client-writable
// paths — both go through security-definer RPCs (migrations 0008 and 0011)
// that re-check ownership themselves, since `devices` has no client
// insert/delete policy.
//
// Kèm subscription realtime vì hàng `devices` là SNAPSHOT do server ghi: mỗi
// bản tin telemetry, trigger apply_telemetry đặt lại status/last_seen_at và ba
// cột chẩn đoán (0017), pg_cron gạt về 'disconnected' sau 90 giây im lặng
// (0006), OTA đổi fw_status/fw_version. Không nghe thì "Tổng quan thiết bị"
// trong DevConsole đứng ở giá trị lúc mở trang trong khi đèn trạm (stations,
// đã có realtime từ 0027) vẫn chuyển xanh — hai ô cạnh nhau nói hai chuyện
// trái ngược. Cần migration 0028 để Postgres thực sự đẩy sự kiện.
export function useDevices() {
  const { user } = useAuth();
  const local = useLocalConnection();
  const { rememberDevices } = local;
  const userId = user?.id ?? null;
  // Hậu tố kênh riêng cho từng bản của hook — cùng lý do đã giải thích kỹ ở
  // useStations (lib/stations.js): supabase.channel(topic) trả về kênh ĐANG CÓ
  // nếu trùng tên, và .on() sau subscribe() ném lỗi ngay lúc render.
  const channelSuffix = useId().replace(/:/g, '');
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    async function load() {
      const { data } = await supabase
        .from('devices')
        .select('*')
        .order('created_at');
      if (cancelled) return;
      setDevices(data || []);
      setLoading(false);
    }

    load();

    // Chỉ nghe INSERT/UPDATE. DELETE cố ý bỏ qua: với replica identity mặc
    // định, bản ghi cũ của một DELETE chỉ mang khoá chính nên không có
    // `owner_id` để khớp filter, sự kiện sẽ bị loại bỏ trước khi tới nơi —
    // và removeDevice() vốn đã tự sửa state ở phiên thực hiện thao tác.
    const channel = supabase
      .channel(`devices:${userId}:${channelSuffix}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'devices', filter: `owner_id=eq.${userId}` },
        (payload) => {
          // registerDevice() đã chèn hàng vào state bằng kết quả RPC — bỏ qua
          // nếu id đã có, nếu không thiết bị vừa đăng ký sẽ hiện hai lần.
          setDevices((prev) => (prev.some((d) => d.id === payload.new.id) ? prev : [...prev, payload.new]));
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'devices', filter: `owner_id=eq.${userId}` },
        (payload) => {
          // Trộn thay vì thay hẳn: nếu về sau `devices` có cột sinh (như
          // stations.battery_cycles ở 0020) thì cột đó có thể vắng mặt trong
          // bản tin replication, thay hẳn sẽ làm nó rơi về null.
          setDevices((prev) =>
            prev.map((d) => (d.id === payload.new.id ? { ...d, ...payload.new } : d)),
          );
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [userId, channelSuffix, reloadKey]);

  useEffect(() => {
    rememberDevices(devices);
  }, [devices, rememberDevices]);

  // Đọc lại `devices` mà KHÔNG bật lại `loading` — các cột do thiết bị báo về
  // (fw_version/fw_status, ap_ssid) đổi ngoài luồng thao tác của người dùng,
  // nên UI cần một cách nạp lại im lặng để danh sách không nháy mỗi nhịp poll
  // trong lúc một thiết bị đang nạp OTA. Ổn định qua các lần render để dùng
  // được thẳng trong mảng phụ thuộc của useEffect bên phía trang.
  const refreshDevices = useCallback(() => setReloadKey((k) => k + 1), []);

  async function registerDevice({ stationId, name, type, awsThingName }) {
    const { data, error } = await supabase.rpc('register_device', {
      p_station_id: stationId,
      p_name: name,
      p_type: type,
      p_aws_thing_name: awsThingName,
    });
    if (error) return { error };
    setDevices((prev) => [...prev, data]);
    return { data };
  }

  async function removeDevice(id) {
    const { error } = await supabase.rpc('delete_device', { p_device_id: id });
    if (error) return { error };
    setDevices((prev) => prev.filter((d) => d.id !== id));
    return {};
  }

  // Mints a fresh AWS IoT X.509 cert for one device and returns the blocks to
  // paste into firmware (Amazon Root CA, device cert, private key + endpoint).
  // The private key is generated server-side and returned ONCE — it is never
  // stored (see supabase/functions/provision-device). Each call creates a NEW
  // cert on AWS; earlier certs stay attached to the thing until pruned there.
  // On a non-2xx response, supabase.functions.invoke returns a FunctionsHttpError
  // and leaves `data` null — the JSON body (our { error, detail }) lives on
  // error.context (a Response). Pull the detail out so callers see the real AWS
  // error ("AccessDenied", "Region is missing"...) instead of a generic failure.
  async function invokeProvision(body) {
    const { data, error } = await supabase.functions.invoke('provision-device', { body });
    if (error) {
      let detail = error.message;
      try {
        const parsed = await error.context?.json?.();
        if (parsed?.detail || parsed?.error) detail = parsed.detail || parsed.error;
      } catch { /* body not JSON — keep error.message */ }
      return { error: new Error(detail) };
    }
    if (data?.error) return { error: new Error(data.detail || data.error) };
    return { data };
  }

  async function provisionDevice(id) {
    return invokeProvision({ device_id: id });
  }

  // Read-only: which certs are already attached to this device's thing on AWS
  // (id/status/created at + the certificate PEM itself — public info, safe to
  // re-show). Never returns a private key; AWS only hands that back once, at
  // creation time (see provisionDevice above).
  async function listDeviceCertificates(id) {
    return invokeProvision({ device_id: id, action: 'list' });
  }

  const displayDevices = useMemo(() => {
    if (!local.connected || !local.snapshot || !local.localStationId) return devices;
    const index = devices.findIndex((device) => device.aws_thing_name === local.snapshot.device);
    const patch = {
      status: 'connected',
      station_id: local.localStationId,
      last_seen_at: local.snapshot.receivedAt,
      uptime_s: Number(local.snapshot.uptime_s),
      boot_count: Number(local.snapshot.boot_count),
      fw_version: local.snapshot.fw_version,
      fw_reported_at: local.snapshot.receivedAt,
      ap_ssid: local.snapshot.ap_ssid,
      ap_reported_at: local.snapshot.receivedAt,
      local_connection: true,
      local_mqtt_connected: Boolean(local.snapshot.mqtt_connected),
      stm32_link: Boolean(local.snapshot.stm32_link),
    };
    if (index >= 0) {
      return devices.map((device, i) => (i === index ? { ...device, ...patch } : device));
    }
    return [
      ...devices,
      {
        id: `local:${local.snapshot.device}`,
        owner_id: userId,
        name: local.snapshot.device,
        type: 'esp32',
        aws_thing_name: local.snapshot.device,
        created_at: local.snapshot.receivedAt,
        ...patch,
      },
    ];
  }, [devices, userId, local.connected, local.snapshot, local.localStationId]);

  return { devices: displayDevices, registerDevice, removeDevice, provisionDevice, listDeviceCertificates, refreshDevices, loading: loading && !local.connected };
}
