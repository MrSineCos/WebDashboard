import { useEffect, useState } from 'react';
import { supabase } from './supabaseClient.js';
import { useAuth } from './AuthContext.jsx';

function mapRow(row) {
  return {
    id: row.id,
    stationId: row.station_id,
    deviceId: row.device_id,
    name: row.name,
    watt: Number(row.watt) || 0,
    desiredState: row.desired_state,
    reportedState: row.reported_state,
    reportedAt: row.reported_at,
  };
}

// Real, per-station loads (replaces the old hardcoded LOAD_DEFS + per-user
// on/off jsonb map). `desiredState` is what the user asked for (written
// directly, RLS-scoped); `reportedState` is what the assigned ESP32 actually
// confirmed back through telemetry — see supabase/functions/send-load-command
// and ingest-telemetry's `loads` ack handling. A load with no `deviceId`
// (no ESP32 assigned to switch it) can be tracked but not turned on/off.
export function useLoads(stationId) {
  const { user } = useAuth();
  // Xem chú thích ở useTelemetry (lib/telemetry.js): effect bám vào user.id để
  // không mở lại kênh realtime mỗi lần object `user` đổi identity.
  const userId = user?.id ?? null;
  const [loads, setLoads] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userId || !stationId) {
      setLoads([]);
      setLoading(false);
      return;
    }
    let cancelled = false;

    async function load() {
      setLoading(true);
      const { data } = await supabase
        .from('loads')
        .select('*')
        .eq('station_id', stationId)
        .order('created_at');
      if (cancelled) return;
      setLoads((data || []).map(mapRow));
      setLoading(false);
    }

    load();

    // Realtime: reported_state updates (device ack) and add/remove from other
    // tabs/sessions all land here without a manual refresh.
    const channel = supabase
      .channel(`loads:${stationId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'loads', filter: `station_id=eq.${stationId}` },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            setLoads((prev) => prev.filter((l) => l.id !== payload.old.id));
            return;
          }
          const mapped = mapRow(payload.new);
          setLoads((prev) => {
            const exists = prev.some((l) => l.id === mapped.id);
            return exists ? prev.map((l) => (l.id === mapped.id ? mapped : l)) : [...prev, mapped];
          });
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [userId, stationId]);

  async function addLoad({ name, watt, deviceId }) {
    if (!user || !stationId) return { error: new Error('not_ready') };
    const { data, error } = await supabase
      .from('loads')
      .insert({
        station_id: stationId,
        owner_id: user.id,
        name,
        watt: watt || 0,
        device_id: deviceId || null,
      })
      .select()
      .single();
    if (error) return { error };
    const mapped = mapRow(data);
    setLoads((prev) => [...prev, mapped]);
    return { data: mapped };
  }

  async function removeLoad(id) {
    const { error } = await supabase.from('loads').delete().eq('id', id);
    if (error) return { error };
    setLoads((prev) => prev.filter((l) => l.id !== id));
    return {};
  }

  // Gán/gỡ thiết bị điều khiển cho một tải đã tạo. `deviceId` rỗng = gỡ về
  // "chỉ theo dõi".
  //
  // Ghi thẳng qua RLS (policy `loads_update_own`, migration 0010) chứ không qua
  // Edge Function: đây chỉ là đổi một liên kết trong database, không có lệnh
  // nào phải publish ra AWS IoT.
  //
  // Cố ý KHÔNG tự xoá reported_state/desired_state ở đây — trigger
  // `loads_protect_reported_columns` (migration 0031) làm việc đó khi thấy
  // device_id đổi. Hai lý do: client không có quyền ghi reported_* (cùng
  // trigger đó chặn), và bất biến "đổi thiết bị thì trạng thái cũ hết hiệu lực"
  // phải đúng với mọi đường ghi, kể cả khoá ngoại tự đặt null lúc xoá thiết bị.
  async function setLoadDevice(id, deviceId) {
    const { data, error } = await supabase
      .from('loads')
      .update({ device_id: deviceId || null })
      .eq('id', id)
      .select()
      .single();
    if (error) return { error };
    const mapped = mapRow(data);
    setLoads((prev) => prev.map((l) => (l.id === mapped.id ? mapped : l)));
    return { data: mapped };
  }

  // Sends the command through AWS IoT (send-load-command); does not flip
  // desiredState locally on call — the row update comes back via the
  // function's response / the realtime subscription above.
  async function setLoadState(id, on) {
    const { data, error } = await supabase.functions.invoke('send-load-command', {
      body: { load_id: id, action: on ? 'on' : 'off' },
    });
    if (error) return { error };
    if (data?.error) return { error: new Error(data.error) };
    const mapped = mapRow(data.data);
    setLoads((prev) => prev.map((l) => (l.id === mapped.id ? mapped : l)));
    return { data: mapped };
  }

  return { loads, loading, addLoad, removeLoad, setLoadDevice, setLoadState };
}
