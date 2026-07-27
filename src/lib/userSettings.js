import { useEffect, useState } from 'react';
import { supabase } from './supabaseClient.js';
import { useAuth } from './AuthContext.jsx';

// Đẩy ngưỡng bảo vệ pin của trạm xuống các ESP32 của nó (Edge Function
// send-battery-config publish qua AWS IoT). `mode` bỏ trống → dùng mode đang
// chọn của trạm. Lỗi được nuốt (chỉ log) vì đây là bước "tốt-nếu-thành-công":
// cấu hình đã lưu ở station_settings, thiết bị không nhận ngay vẫn giữ ngưỡng
// cũ an toàn và sẽ đồng bộ ở lần đổi mode kế tiếp.
async function pushBatteryConfig(stationId, mode) {
  if (!stationId) return;
  try {
    const body = mode ? { station_id: stationId, mode } : { station_id: stationId };
    const { error } = await supabase.functions.invoke('send-battery-config', { body });
    if (error) console.warn('send-battery-config failed:', error.message);
  } catch (e) {
    console.warn('send-battery-config error:', e);
  }
}

// Two data sources combined into one settings object:
// - `user_settings` (per-user, one row per owner): notifPrefs. (`loads` used
//   to live here too — a per-user on/off jsonb map — but load control is now
//   the real, per-station `loads` table; see lib/loads.js useLoads(). The
//   column stays in the DB unused, same lower-risk convention as 0009's
//   battery_modes/module_visibility.)
// - `station_settings` (per-station, one row per station — migration 0009):
//   batteryModes, activeBatteryMode, moduleVisibility. These used to live on
//   `user_settings` too, which meant every station shared the same values;
//   they're per-station now so DevConsole can configure them independently.
//   (SoftAP credentials briefly lived here too — migration 0013 — but the
//   device is their source of truth, so 0014 moved them to `devices`, read
//   via useDevices().)
export function useUserSettings(stationId) {
  const { user } = useAuth();
  const [userSettings, setUserSettings] = useState(null);
  const [userLoading, setUserLoading] = useState(true);
  const [stationSettings, setStationSettings] = useState(null);
  const [stationLoading, setStationLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    supabase
      .from('user_settings')
      .select('notif_prefs')
      .eq('owner_id', user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        setUserSettings(data);
        setUserLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  useEffect(() => {
    if (!user || !stationId) {
      setStationSettings(null);
      setStationLoading(true);
      return;
    }
    let cancelled = false;
    setStationLoading(true);
    supabase
      .from('station_settings')
      .select('battery_modes, active_battery_mode, module_visibility')
      .eq('station_id', stationId)
      .eq('owner_id', user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        setStationSettings(data);
        setStationLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user, stationId]);

  async function patch(fields) {
    setUserSettings((prev) => (prev ? { ...prev, ...fields } : prev));
    if (!user) return;
    await supabase.from('user_settings').update(fields).eq('owner_id', user.id);
  }

  async function stationPatch(fields) {
    setStationSettings((prev) => (prev ? { ...prev, ...fields } : prev));
    if (!user || !stationId) return;
    await supabase.from('station_settings').update(fields).eq('station_id', stationId).eq('owner_id', user.id);
  }

  const moduleVisibility = stationSettings?.module_visibility ?? {};
  const notifPrefs = userSettings?.notif_prefs ?? {};

  return {
    loading: userLoading || stationLoading,
    batteryModes: stationSettings?.battery_modes ?? null,
    activeBatteryMode: stationSettings?.active_battery_mode ?? 'balanced',
    moduleVisibility,
    notifPrefs,
    async updateBatteryModes(nextBatteryModes) {
      await stationPatch({ battery_modes: nextBatteryModes });
      // Ngưỡng của mode đang chọn có thể vừa đổi → đẩy lại xuống thiết bị.
      await pushBatteryConfig(stationId);
    },
    async setActiveBatteryMode(mode) {
      await stationPatch({ active_battery_mode: mode });
      // Đẩy ngưỡng của mode mới xuống các ESP32 của trạm để thực sự áp dụng
      // (không chỉ lưu DB). Không chặn UI nếu đẩy lỗi — cấu hình đã lưu, thiết
      // bị sẽ nhận ở lần đồng bộ sau; xem pushBatteryConfig().
      await pushBatteryConfig(stationId, mode);
    },
    async toggleModule(id) {
      await stationPatch({ module_visibility: { ...moduleVisibility, [id]: !moduleVisibility[id] } });
    },
    async toggleNotifPref(id) {
      await patch({ notif_prefs: { ...notifPrefs, [id]: !notifPrefs[id] } });
    },
    // Ghi đè battery_modes/module_visibility của TẤT CẢ trạm thuộc user này
    // trong 1 round-trip — nhận giá trị hiện tại làm tham số (không đọc lại
    // từ state) để tránh áp dụng nhầm dữ liệu chưa lưu/đã cũ.
    async applyBatteryModesToAll(nextBatteryModes) {
      if (!user) return;
      await supabase.from('station_settings').update({ battery_modes: nextBatteryModes }).eq('owner_id', user.id);
      setStationSettings((prev) => (prev ? { ...prev, battery_modes: nextBatteryModes } : prev));
    },
    async applyModuleVisibilityToAll(nextModuleVisibility) {
      if (!user) return;
      await supabase.from('station_settings').update({ module_visibility: nextModuleVisibility }).eq('owner_id', user.id);
      setStationSettings((prev) => (prev ? { ...prev, module_visibility: nextModuleVisibility } : prev));
    },
  };
}
