import { useEffect, useId, useMemo, useState } from 'react';
import { supabase } from './supabaseClient.js';
import { useAuth } from './AuthContext.jsx';
import { useLocalConnection } from './LocalConnectionContext.jsx';

// Bảng màu trạng thái trạm cho các trang nền sáng (AppShell: Dashboard, Pin
// lưu trữ, Báo cáo) — kèm `bg`/`textColor` để vẽ huy hiệu trên nền trắng.
export const STATION_STATUS_META = {
  online: { label: 'Trực tuyến', color: 'oklch(64% 0.15 150)', bg: 'oklch(93% 0.06 150)', textColor: 'oklch(50% 0.14 150)' },
  warning: { label: 'Cảnh báo', color: 'oklch(75% 0.14 70)', bg: 'oklch(95% 0.06 70)', textColor: 'oklch(52% 0.13 70)' },
  offline: { label: 'Mất kết nối', color: 'oklch(58% 0.19 25)', bg: 'oklch(93% 0.06 25)', textColor: 'oklch(52% 0.17 25)' },
};

// Bản tương đương cho khu vực DevConsole nền tối (/dev, /dev/stations). Chỉ
// cần `label` + `color` vì ở đó trạng thái luôn hiện dưới dạng chấm tròn +
// chữ, không có huy hiệu nền.
//
// Trước đây hằng này nằm trong DevShell.jsx và trùng đúng tên
// STATION_STATUS_META với bảng nền sáng ở trên — hai giá trị khác hình dạng,
// cùng một tên, rất dễ import nhầm file. Đặt cạnh nhau ở đây, tên phân biệt
// rõ, và DevShell.jsx trở lại chỉ export mỗi component (Fast Refresh của Vite
// mới hot-swap được file đó thay vì tải lại cả trang).
export const DEV_STATION_STATUS_META = {
  online: { label: 'Trực tuyến', color: 'oklch(70% 0.15 150)' },
  warning: { label: 'Cảnh báo', color: 'oklch(75% 0.14 70)' },
  offline: { label: 'Mất kết nối', color: 'oklch(62% 0.19 25)' },
};

function mapRow(row) {
  return {
    id: row.id,
    name: row.name,
    location: row.location,
    // Múi giờ hiển thị của trạm (migration 0021) — dùng để định dạng mọi mốc
    // thời gian của trạm này (biểu đồ, "cập nhật lúc", CSV), thay vì luôn theo
    // múi giờ trình duyệt của người xem.
    timezone: row.timezone || 'Asia/Ho_Chi_Minh',
    status: row.status,
    solarKw: row.solar_kw,
    batteryPct: row.battery_pct,
    batteryVoltage: row.battery_voltage,
    batteryCurrent: row.battery_current,
    // Trạng thái bảo vệ sạc/xả do thiết bị báo về (migration 0012). null =
    // chưa có thiết bị nào báo (trạm demo/chưa nối firmware hỗ trợ) → UI coi
    // như "không rõ", không khẳng định đang cho phép hay đã ngắt.
    chargeEnabled: row.charge_enabled,
    dischargeEnabled: row.discharge_enabled,
    protectReason: row.protect_reason,
    lastSeenAt: row.last_seen_at,
    // Bộ đếm chu kỳ sạc (migration 0020). `batteryCycles` là cột SINH trong
    // Postgres — công thức EFC nằm ở database, không chép lại ở client, để web
    // và các client khác (app Android) không thể lệch nhau. Ba cột còn lại là
    // nguyên liệu của nó, hiển thị được khi cần giải thích con số.
    batteryCycles: row.battery_cycles == null ? null : Number(row.battery_cycles),
    batteryCapacityKwh: row.battery_capacity_kwh == null ? null : Number(row.battery_capacity_kwh),
    chargeEnergyKwh: row.charge_energy_kwh == null ? null : Number(row.charge_energy_kwh),
    dischargeEnergyKwh: row.discharge_energy_kwh == null ? null : Number(row.discharge_energy_kwh),
  };
}

// Gộp một hàng `stations` đến từ realtime vào hàng đang có trên màn hình.
//
// Không dùng thẳng mapRow(payload.new) vì `battery_cycles` là cột SINH
// (GENERATED ... STORED, xem 0020) và cột sinh KHÔNG chắc chắn đi qua đường
// replication — tuỳ phiên bản Postgres mà nó bị lược khỏi bản tin. Nếu nó
// vắng mặt, mapRow sẽ đọc ra null và ô "Chu kỳ sạc" đang hiện 0.2 bỗng nhảy về
// "--" ngay khi có bản tin telemetry đầu tiên. Vắng thì giữ giá trị cũ; có thì
// dùng giá trị mới. Đúng trong cả hai trường hợp nên không phải phỏng đoán
// hành vi của replication.
function mergeRealtimeRow(previous, raw) {
  const mapped = mapRow(raw);
  if (!('battery_cycles' in raw)) mapped.batteryCycles = previous.batteryCycles;
  return mapped;
}

function applyLocalSnapshot(station, snapshot) {
  const protectionWarning = snapshot.protect_reason && snapshot.protect_reason !== 'ok';
  return {
    ...station,
    status: protectionWarning || snapshot.stm32_link === false ? 'warning' : 'online',
    solarKw: Number(snapshot.solar_kw),
    batteryPct: Number(snapshot.battery_pct),
    batteryVoltage: Number(snapshot.battery_voltage),
    batteryCurrent: Number(snapshot.battery_current),
    chargeEnabled: Boolean(snapshot.charge_enabled),
    dischargeEnabled: Boolean(snapshot.discharge_enabled),
    protectReason: snapshot.protect_reason || 'ok',
    lastSeenAt: snapshot.receivedAt,
    dataSource: 'local',
  };
}

// Dung lượng pack mặc định (kWh) khi trạm chưa khai báo — khớp default của cột
// `battery_capacity_kwh` (0020) và pack 100Ah/48V mô tả trên trang Pin lưu trữ.
export const DEFAULT_PACK_CAPACITY_KWH = 4.8;

// Chu kỳ sạc quy đổi (EFC) là số thực, không phải số nguyên như bộ đếm của
// BMS. Hiện một chữ số thập phân khi còn nhỏ — hệ mới chạy vài ngày mới đi được
// chưa tới một chu kỳ, làm tròn về "0" trông như tính năng chưa chạy; qua mốc
// 10 chu kỳ thì phần thập phân hết ý nghĩa nên bỏ.
export function fmtCycles(cycles) {
  if (cycles == null || Number.isNaN(Number(cycles))) return '--';
  const n = Number(cycles);
  return n < 10 ? n.toFixed(1) : String(Math.round(n));
}

// Định dạng một giá trị năng lượng (luôn tính bằng kWh ở nguồn — RPC/cột DB)
// theo đơn vị hiển thị người dùng chọn ở Cài đặt → Đơn vị đo lường
// (`useUserSettings().energyUnit`, migration 0021). Đổi CÁCH HIỂN THỊ, không
// đổi đơn vị tính ở đâu khác — mọi công thức (chu kỳ sạc, RPC năng lượng...)
// vẫn luôn làm việc với kWh.
export function fmtEnergy(kwh, unit = 'kWh') {
  if (kwh == null || Number.isNaN(Number(kwh))) return { value: '--', unit };
  const n = Number(kwh);
  if (unit === 'Wh') return { value: Math.round(n * 1000).toLocaleString('vi-VN'), unit: 'Wh' };
  return { value: n.toFixed(1), unit: 'kWh' };
}

// Công suất hiển thị bằng W trên toàn bộ giao diện. Hệ mà dashboard này theo
// dõi chạy ở tầm vài trăm W, nên "0.50 kW" luôn phải nhân nhẩm trong đầu mới
// so được với con số ghi trên nhãn thiết bị (tải khai báo, cảm biến, chuỗi
// "Công suất" của biểu đồ đều đã tính bằng W). Khác `fmtEnergy`, đây KHÔNG
// phải tuỳ chọn của người dùng — không có công tắc W/kW.
//
// Trả về {value, unit} vì các thẻ số vẽ phần số và phần đơn vị bằng hai cỡ
// chữ khác nhau. Làm tròn về số nguyên: dưới 1 W không có ý nghĩa đo đạc ở đây.
export function fmtWatt(w) {
  if (w == null || Number.isNaN(Number(w))) return { value: '--', unit: 'W' };
  return { value: Math.round(Number(w)).toLocaleString('vi-VN'), unit: 'W' };
}

// Cùng thứ, cho những nguồn số vẫn tính bằng kW (cột `solar_kw`, công suất pin
// ròng ở trang Pin lưu trữ). Đổi cách hiển thị, không đổi đơn vị tính ở nguồn.
export function fmtPower(kw) {
  if (kw == null || Number.isNaN(Number(kw))) return { value: '--', unit: 'W' };
  return fmtWatt(Number(kw) * 1000);
}

// Raw station data + selection, backed by Supabase (`stations` +
// `user_settings.selected_station_id`). Theme-agnostic — pages build their
// own presentation (colors/styles) from `station.status`.
export function useStations() {
  const { user } = useAuth();
  const local = useLocalConnection();
  const { rememberStations } = local;
  // Xem chú thích ở useTelemetry (lib/telemetry.js): effect bám vào user.id để
  // không tải lại mỗi lần object `user` đổi identity.
  const userId = user?.id ?? null;
  // Tên kênh realtime phải DUY NHẤT cho từng lần dùng hook, không được chỉ dựa
  // vào userId. `supabase.channel(topic)` trả về kênh ĐANG CÓ nếu trùng tên
  // (RealtimeClient.channel), mà hook này luôn chạy hai bản song song:
  // RequireStation bọc ngoài, rồi chính trang bên trong gọi lại qua
  // useStationSelector. Bản thứ hai sẽ nhận đúng kênh bản thứ nhất đã
  // subscribe() xong và `.on()` ném "cannot add postgres_changes callbacks
  // after subscribe()" — lỗi lúc render, React gỡ cả cây, người dùng thấy một
  // cửa sổ trắng không thông báo gì. useId() cho mỗi bản một hậu tố riêng.
  const channelSuffix = useId().replace(/:/g, '');
  const [stations, setStations] = useState([]);
  const [stationId, setStationIdState] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      const [{ data: stationRows }, { data: settingsRow }] = await Promise.all([
        supabase.from('stations').select('*').order('created_at'),
        supabase.from('user_settings').select('selected_station_id').eq('owner_id', userId).maybeSingle(),
      ]);
      if (cancelled) return;
      const mapped = (stationRows || []).map(mapRow);
      setStations(mapped);
      const savedId = settingsRow?.selected_station_id;
      setStationIdState(savedId && mapped.some((s) => s.id === savedId) ? savedId : (mapped[0]?.id ?? null));
      setLoading(false);
    }

    load();

    // Realtime trên chính bảng `stations`.
    //
    // Thiếu phần này thì ô "Trạng thái hệ thống", chấm màu cạnh tên trạm và sơ
    // đồ Dòng năng lượng đứng yên ở giá trị lúc mở trang: mọi thứ đổi
    // `stations.status` đều chạy ở phía server (apply_telemetry đặt 'online'
    // khi có bản tin; mark_stale_offline của pg_cron đặt 'offline' sau 90 giây
    // im lặng — 0004/0006), nên trình duyệt không có cách nào tự biết. Trước
    // đây trạng thái chỉ đúng trở lại khi rời trang rồi quay lại, vì lúc đó
    // hook mới chạy lại truy vấn.
    //
    // Chỉ nghe INSERT/UPDATE. DELETE cố ý bỏ qua: với replica identity mặc
    // định, bản ghi cũ của một DELETE chỉ mang khoá chính nên không có
    // `owner_id` để khớp filter — sự kiện sẽ bị loại bỏ chứ không tới nơi. Xoá
    // trạm vẫn cập nhật ngay ở phiên thực hiện thao tác (deleteStation tự sửa
    // state, và còn phải chọn lại trạm đang xem — việc realtime không làm thay
    // được).
    const channel = supabase
      .channel(`stations:${userId}:${channelSuffix}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'stations', filter: `owner_id=eq.${userId}` },
        (payload) => {
          const mapped = mapRow(payload.new);
          setStations((prev) => (prev.some((s) => s.id === mapped.id) ? prev : [...prev, mapped]));
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'stations', filter: `owner_id=eq.${userId}` },
        (payload) => {
          setStations((prev) =>
            prev.map((s) => (s.id === payload.new.id ? mergeRealtimeRow(s, payload.new) : s)),
          );
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [userId, channelSuffix]);

  useEffect(() => {
    rememberStations(stations);
  }, [stations, rememberStations]);

  // Khi app bắt được ESP32, chọn đúng trạm gắn với thing name. Nếu đây là lần
  // mở app hoàn toàn ngoại tuyến và chưa có catalog cloud, localStationId là
  // một id tổng hợp để RequireStation/Dashboard vẫn dựng được giao diện.
  useEffect(() => {
    if (local.connected && local.localStationId) setStationIdState(local.localStationId);
  }, [local.connected, local.localStationId]);

  async function selectStation(id) {
    setStationIdState(id);
    if (!user) return;
    await supabase.from('user_settings').update({ selected_station_id: id }).eq('owner_id', user.id);
  }

  // Trạm mới chưa gắn thiết bị thật nên mặc định 'offline' — không có
  // `devices` row nên mark_stale_offline() cũng sẽ bỏ qua nó (xem 0004).
  async function createStation({ name, location }) {
    if (!user) return { error: new Error('not_authenticated') };
    const { data, error } = await supabase
      .from('stations')
      .insert({ owner_id: user.id, name, location, status: 'offline' })
      .select()
      .single();
    if (error) return { error };
    const mapped = mapRow(data);
    setStations((prev) => [...prev, mapped]);
    await selectStation(mapped.id);
    return { data: mapped };
  }

  // Sửa thông tin trạm (tên/địa điểm/múi giờ — thẻ "Thông tin trạm" trong Cài
  // đặt → Hệ thống). `.select().single()` để đọc lại đúng hàng vừa ghi thay vì
  // tự suy đoán state mới từ input — cùng khuôn với createStation().
  async function updateStation(id, fields) {
    const { data, error } = await supabase.from('stations').update(fields).eq('id', id).select().single();
    if (error) return { error };
    const mapped = mapRow(data);
    setStations((prev) => prev.map((s) => (s.id === id ? mapped : s)));
    return { data: mapped };
  }

  // Xóa trạm cascade xóa luôn devices/telemetry của trạm đó (FK on delete
  // cascade) — không hoàn tác được, UI gọi hàm này phải xác nhận trước.
  async function deleteStation(id) {
    const { error } = await supabase.from('stations').delete().eq('id', id);
    if (error) return { error };
    const remaining = stations.filter((s) => s.id !== id);
    setStations(remaining);
    if (stationId === id) {
      if (remaining.length === 0) {
        window.location.reload();
        return {};
      }
      await selectStation(remaining[0].id);
    }
    return {};
  }

  const displayStations = useMemo(() => {
    if (!local.connected || !local.snapshot || !local.localStationId) return stations;
    const index = stations.findIndex((station) => station.id === local.localStationId);
    if (index >= 0) {
      return stations.map((station, i) => (i === index ? applyLocalSnapshot(station, local.snapshot) : station));
    }
    return [
      ...stations,
      applyLocalSnapshot({
        id: local.localStationId,
        name: local.snapshot.station || local.snapshot.device,
        location: 'Kết nối trực tiếp với ESP32',
        timezone: 'Asia/Ho_Chi_Minh',
        batteryCycles: null,
        batteryCapacityKwh: null,
        chargeEnergyKwh: null,
        dischargeEnergyKwh: null,
      }, local.snapshot),
    ];
  }, [stations, local.connected, local.snapshot, local.localStationId]);

  const station = displayStations.find((s) => s.id === stationId) || displayStations[0] || null;

  return { stations: displayStations, station, stationId, selectStation, createStation, updateStation, deleteStation, loading: loading && !local.connected };
}

// Light-theme presentation wrapper for AppShell-based pages (Dashboard,
// Battery, Reports): adds the dropdown row styles + a local open/close menu
// state on top of the raw `useStations()` data.
export function useStationSelector() {
  const { stations, station, selectStation, createStation, updateStation, deleteStation, loading } = useStations();
  const [stationMenuOpen, setStationMenuOpen] = useState(false);

  const statusMeta = STATION_STATUS_META[station?.status ?? 'offline'];

  const stationOptions = stations.map((s) => {
    const m = STATION_STATUS_META[s.status];
    const isSel = station && s.id === station.id;
    return {
      ...s,
      select: () => {
        selectStation(s.id);
        setStationMenuOpen(false);
      },
      dotStyle: { width: '7px', height: '7px', borderRadius: '50%', flexShrink: 0, background: m.color },
      rowStyle: { display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 8px', borderRadius: '8px', cursor: 'pointer', background: isSel ? 'oklch(30% 0.05 240)' : 'transparent' },
      statusLabel: m.label,
      statusLabelStyle: { fontSize: '10px', fontWeight: 700, padding: '2px 7px', borderRadius: '10px', color: m.color, background: 'oklch(28% 0.03 240)', flexShrink: 0 },
    };
  });

  return {
    stations,
    station,
    statusMeta,
    stationColor: statusMeta.color,
    stationOptions,
    stationMenuOpen,
    toggleStationMenu: () => setStationMenuOpen((v) => !v),
    closeStationMenu: () => setStationMenuOpen(false),
    createStation,
    updateStation,
    deleteStation,
    loading,
  };
}
