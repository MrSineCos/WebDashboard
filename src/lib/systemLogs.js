import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabaseClient.js';
import { useAuth } from './AuthContext.jsx';

// Nhật ký hệ thống thật (bảng `system_logs`, migration 0018) — thay cho mảng
// hằng số `LOGS` mà DevConsole render trước đây.
//
// Nguồn sinh log nằm hoàn toàn ở phía server (trigger Postgres + Edge
// Function); ở đây chỉ đọc. Bảng cố tình không có policy insert cho client, nên
// hook này không có hàm ghi — chỉ `clearStationLogs` đi qua RPC tự kiểm tra
// quyền sở hữu.

export const LEVEL_META = {
  info: { label: 'INFO', color: 'oklch(75% 0.13 200)' },
  warn: { label: 'WARN', color: 'oklch(78% 0.14 70)' },
  error: { label: 'ERROR', color: 'oklch(70% 0.18 25)' },
};

function mapRow(row) {
  return {
    id: row.id,
    stationId: row.station_id,
    deviceId: row.device_id,
    level: row.level,
    source: row.source,
    event: row.event,
    message: row.message,
    meta: row.meta || {},
    createdAt: row.created_at,
  };
}

// Nhãn thời gian cho dòng log. Hôm nay → chỉ giờ:phút:giây (nhật ký chủ yếu
// được đọc để soi việc vừa xảy ra); hôm qua và cũ hơn → kèm ngày, vì lúc đó
// mỗi giờ:phút xuất hiện lại mỗi ngày và không còn phân biệt được.
export function formatLogTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString('vi-VN', { hour12: false });
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return time;

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `Hôm qua ${time.slice(0, 5)}`;

  return `${d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' })} ${time.slice(0, 5)}`;
}

// Log của một trạm, mới nhất trước, kèm subscription realtime.
//
// `level` lọc ở phía server để không kéo về những dòng sẽ bị vứt đi ngay.
// `limit` chặn trên số dòng giữ trong bộ nhớ — nhật ký có thể dài hàng nghìn
// dòng sau vài tuần, và khung hiển thị chỉ cao 420px.
export function useSystemLogs(stationId, { level = 'all', limit = 200 } = {}) {
  const { user } = useAuth();
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    if (!user || !stationId) {
      setLogs([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError('');

    async function load() {
      // Lấy cả sự kiện mức tài khoản (`station_id` null — dọn dữ liệu, lưu
      // trữ): chúng không thuộc trạm nào nhưng lại đúng là thứ người dùng cần
      // thấy khi đang xem nhật ký.
      let query = supabase
        .from('system_logs')
        .select('*')
        .or(`station_id.eq.${stationId},station_id.is.null`)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (level !== 'all') query = query.eq('level', level);

      const { data, error: err } = await query;
      if (cancelled) return;
      if (err) {
        setError('Không đọc được nhật ký hệ thống.');
        setLogs([]);
      } else {
        setLogs((data || []).map(mapRow));
      }
      setLoading(false);
    }

    load();

    // Không đặt `filter` cho channel: realtime chỉ nhận một điều kiện bằng
    // nhau, không diễn đạt được "của trạm này HOẶC mức tài khoản". Đăng ký toàn
    // bộ rồi lọc tại client — RLS vẫn chỉ đẩy về hàng thuộc người dùng này.
    const channel = supabase
      .channel(`system-logs:${stationId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'system_logs' },
        (payload) => {
          const row = mapRow(payload.new);
          if (row.stationId && row.stationId !== stationId) return;
          if (level !== 'all' && row.level !== level) return;
          setLogs((prev) => [row, ...prev].slice(0, limit));
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [user, stationId, level, limit, reloadKey]);

  // Xoá toàn bộ nhật ký của trạm. Đi qua RPC vì bảng không có policy delete —
  // xem migration 0018 mục 6.
  async function clearStationLogs() {
    if (!stationId) return { error: new Error('no_station') };
    const { data, error: err } = await supabase.rpc('clear_station_logs', {
      p_station_id: stationId,
    });
    if (err) return { error: err };
    setLogs([]);
    return { deleted: data ?? 0 };
  }

  return { logs, loading, error, refresh, clearStationLogs };
}
