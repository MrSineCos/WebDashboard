import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabaseClient.js';
import { useAuth } from './AuthContext.jsx';

// Lưu trữ & dọn dữ liệu (migration 0019).
//
// Bảng `telemetry` là thứ duy nhất trong database này tăng tuyến tính theo
// thời gian: firmware publish ~10 giây/lần → khoảng 2,2 MB/ngày cho mỗi thiết
// bị kể cả index. Hook này là mặt trước của cơ chế giữ nó trong hạn mức: đặt
// số ngày giữ lại, và (tuỳ chọn) nén phần cũ hơn thành gói .csv.gz theo tháng
// đẩy lên Storage trước khi xoá.

// Hạn mức Supabase free plan — dùng để vẽ thanh tiến trình, không phải để chặn
// (chính Supabase mới chặn). Storage và database là hai hạn mức TÁCH BIỆT: đó
// là toàn bộ lý do việc chuyển dữ liệu cũ sang Storage có tác dụng.
export const DB_LIMIT_BYTES = 500 * 1024 * 1024;
export const STORAGE_LIMIT_BYTES = 1024 * 1024 * 1024;

export const RETENTION_MIN_DAYS = 7;
export const RETENTION_MAX_DAYS = 365;

const ARCHIVE_BUCKET = 'telemetry-archive';

function mapArchive(row) {
  return {
    id: row.id,
    stationId: row.station_id,
    stationName: row.station_name,
    month: row.month,
    storagePath: row.storage_path,
    rowCount: row.row_count,
    bytesGzip: Number(row.bytes_gzip) || 0,
    fromTs: row.from_ts,
    toTs: row.to_ts,
    createdAt: row.created_at,
  };
}

// "2026-07-01" → "Tháng 7/2026". Cắt chuỗi thay vì new Date() để tránh lệch
// một tháng: chuỗi date thuần được parse là UTC, và ở múi giờ âm nó lùi về
// ngày cuối của tháng trước.
export function formatArchiveMonth(month) {
  const [y, m] = String(month).split('-');
  return `Tháng ${Number(m)}/${y}`;
}

export function useRetention() {
  const { user } = useAuth();
  // Xem chú thích ở useTelemetry (lib/telemetry.js): effect bám vào user.id để
  // không tải lại mỗi lần object `user` đổi identity.
  const userId = user?.id ?? null;
  const [settings, setSettings] = useState(null);
  const [archives, setArchives] = useState([]);
  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    if (!userId) {
      setSettings(null);
      setArchives([]);
      setUsage(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);

    async function load() {
      const [settingsRes, archivesRes, usageRes] = await Promise.all([
        supabase
          .from('user_settings')
          .select('telemetry_retention_days, telemetry_archive_enabled, log_retention_days, archive_last_run_at')
          .eq('owner_id', userId)
          .maybeSingle(),
        supabase
          .from('telemetry_archives')
          .select('*')
          .order('month', { ascending: false })
          .order('created_at', { ascending: false }),
        supabase.rpc('storage_usage'),
      ]);
      if (cancelled) return;

      setSettings(
        settingsRes.data
          ? {
              retentionDays: settingsRes.data.telemetry_retention_days,
              archiveEnabled: settingsRes.data.telemetry_archive_enabled,
              logRetentionDays: settingsRes.data.log_retention_days,
              lastRunAt: settingsRes.data.archive_last_run_at,
            }
          : null,
      );
      setArchives((archivesRes.data || []).map(mapArchive));
      setUsage(usageRes.data ?? null);
      setLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [userId, reloadKey]);

  // Ghi cài đặt. Cập nhật state lạc quan trước để ô nhập không nhảy về giá trị
  // cũ trong lúc chờ round-trip; CHECK constraint ở DB (7..365) là chốt chặn
  // cuối, nên giá trị ngoài dải trả về lỗi và ta nạp lại từ server.
  async function saveSettings({ retentionDays, archiveEnabled, logRetentionDays }) {
    if (!user) return { error: new Error('no_user') };
    const patch = {};
    if (retentionDays !== undefined) patch.telemetry_retention_days = retentionDays;
    if (archiveEnabled !== undefined) patch.telemetry_archive_enabled = archiveEnabled;
    if (logRetentionDays !== undefined) patch.log_retention_days = logRetentionDays;
    if (Object.keys(patch).length === 0) return {};

    const prev = settings;
    setSettings((s) => {
      if (!s) return s;
      const next = { ...s };
      if (retentionDays !== undefined) next.retentionDays = retentionDays;
      if (archiveEnabled !== undefined) next.archiveEnabled = archiveEnabled;
      if (logRetentionDays !== undefined) next.logRetentionDays = logRetentionDays;
      return next;
    });

    const { error } = await supabase.from('user_settings').update(patch).eq('owner_id', user.id);
    if (error) {
      setSettings(prev);
      return { error };
    }
    return {};
  }

  // Chạy lượt lưu trữ + dọn ngay, không chờ cron đêm. Cùng Edge Function mà
  // pg_cron gọi, chỉ khác là đi kèm JWT nên nó chỉ xử lý tài khoản này.
  async function runArchiveNow() {
    const { data, error } = await supabase.functions.invoke('archive-telemetry', { body: {} });
    if (error) {
      let detail = error.message;
      try {
        const parsed = await error.context?.json?.();
        if (parsed?.detail || parsed?.error) detail = parsed.detail || parsed.error;
      } catch { /* body không phải JSON — giữ error.message */ }
      return { error: new Error(detail) };
    }
    refresh();
    return { data };
  }

  // Bucket ở chế độ private (0019) nên không có URL công khai — cấp signed URL
  // ngắn hạn, cùng cách firmware .bin được phát cho thiết bị.
  async function downloadUrl(storagePath) {
    const { data, error } = await supabase.storage
      .from(ARCHIVE_BUCKET)
      .createSignedUrl(storagePath, 300, { download: true });
    if (error) return { error };
    return { url: data.signedUrl };
  }

  // Xoá object TRƯỚC rồi mới xoá hàng trong sổ. Ngược lại thì file vẫn nằm
  // trên Storage chiếm chỗ mà không còn gì trỏ tới để tìm ra nó.
  async function deleteArchive(archive) {
    const { error: storageErr } = await supabase.storage
      .from(ARCHIVE_BUCKET)
      .remove([archive.storagePath]);
    if (storageErr) return { error: storageErr };

    const { error } = await supabase.from('telemetry_archives').delete().eq('id', archive.id);
    if (error) return { error };

    setArchives((prev) => prev.filter((a) => a.id !== archive.id));
    return {};
  }

  return {
    settings,
    archives,
    usage,
    loading,
    refresh,
    saveSettings,
    runArchiveNow,
    downloadUrl,
    deleteArchive,
  };
}
