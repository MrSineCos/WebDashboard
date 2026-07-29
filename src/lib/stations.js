import { useEffect, useState } from 'react';
import { supabase } from './supabaseClient.js';
import { useAuth } from './AuthContext.jsx';

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
  };
}

// Raw station data + selection, backed by Supabase (`stations` +
// `user_settings.selected_station_id`). Theme-agnostic — pages build their
// own presentation (colors/styles) from `station.status`.
export function useStations() {
  const { user } = useAuth();
  const [stations, setStations] = useState([]);
  const [stationId, setStationIdState] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      const [{ data: stationRows }, { data: settingsRow }] = await Promise.all([
        supabase.from('stations').select('*').order('created_at'),
        supabase.from('user_settings').select('selected_station_id').eq('owner_id', user.id).maybeSingle(),
      ]);
      if (cancelled) return;
      const mapped = (stationRows || []).map(mapRow);
      setStations(mapped);
      const savedId = settingsRow?.selected_station_id;
      setStationIdState(savedId && mapped.some((s) => s.id === savedId) ? savedId : (mapped[0]?.id ?? null));
      setLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [user]);

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

  const station = stations.find((s) => s.id === stationId) || stations[0] || null;

  return { stations, station, stationId, selectStation, createStation, deleteStation, loading };
}

// Light-theme presentation wrapper for AppShell-based pages (Dashboard,
// Battery, Reports): adds the dropdown row styles + a local open/close menu
// state on top of the raw `useStations()` data.
export function useStationSelector() {
  const { stations, station, selectStation, createStation, deleteStation, loading } = useStations();
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
    deleteStation,
    loading,
  };
}
