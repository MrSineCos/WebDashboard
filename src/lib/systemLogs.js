import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from './supabaseClient.js';
import { useAuth } from './AuthContext.jsx';
import { downloadCsv, slugify, toCsv } from './csv.js';

// Nhật ký hệ thống thật (bảng `system_logs`, migration 0018 + 0030) — thay cho
// mảng hằng số `LOGS` mà DevConsole render trước đây.
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

// Nhóm nguồn sinh sự kiện (cột `source`, xem 0030 mục 1). Sau khi nối đủ các
// nguồn, một trạm đang chạy sinh ra vài chục loại sự kiện khác hẳn nhau — và
// "cái này do đâu ra" chính là cách người đọc thu hẹp nhật ký về đúng thứ đang
// tìm, nhanh hơn nhiều so với lọc theo mức info/warn/error.
//
// `db` giữ lại cho các dòng ghi trước 0030 mà migration không nắn được về nhóm
// mới (nếu có) — không hiện thành chip lọc, nhưng vẫn có nhãn để render.
export const SOURCE_META = {
  alert: { label: 'Cảnh báo', color: 'oklch(70% 0.16 25)' },
  device: { label: 'Thiết bị', color: 'oklch(75% 0.13 200)' },
  control: { label: 'Điều khiển', color: 'oklch(72% 0.15 150)' },
  config: { label: 'Cấu hình', color: 'oklch(74% 0.12 300)' },
  ingest: { label: 'Nhận dữ liệu', color: 'oklch(75% 0.12 240)' },
  ota: { label: 'Firmware', color: 'oklch(78% 0.14 70)' },
  archive: { label: 'Lưu trữ', color: 'oklch(68% 0.06 250)' },
  db: { label: 'Hệ thống', color: 'oklch(68% 0.02 250)' },
};

// Thứ tự chip lọc trên DevConsole: xếp theo mức độ thường được tìm tới, không
// theo bảng chữ cái — sự cố trước, cấu hình sau, hạ tầng cuối.
export const SOURCE_FILTERS = ['alert', 'device', 'control', 'config', 'ota', 'ingest', 'archive'];

// Số dòng mỗi lần tải. Khung hiển thị cao 420px nên ~50 dòng đã dài hơn hai
// màn cuộn; phần còn lại lấy tiếp qua nút "Tải thêm" thay vì kéo sẵn hàng
// nghìn dòng mà gần như không ai cuộn tới.
const PAGE_SIZE = 50;

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

// Xuất đúng những dòng đang hiển thị (đã áp bộ lọc) ra CSV. Nhật ký được dọn
// tự động theo `log_retention_days`, nên khi cần giữ lại bằng chứng của một sự
// cố quá hạn giữ thì đây là đường duy nhất.
export function exportLogsCsv(logs, stationName) {
  const rows = [
    ['Thời điểm', 'Mức', 'Nhóm', 'Mã sự kiện', 'Nội dung', 'Chi tiết'],
    ...logs.map((l) => [
      new Date(l.createdAt).toLocaleString('vi-VN', { hour12: false }),
      LEVEL_META[l.level]?.label ?? l.level,
      SOURCE_META[l.source]?.label ?? l.source,
      l.event,
      l.message,
      Object.keys(l.meta).length > 0 ? JSON.stringify(l.meta) : '',
    ]),
  ];
  const stamp = new Date().toISOString().slice(0, 10);
  downloadCsv(`nhat-ky-${slugify(stationName || 'tram')}-${stamp}.csv`, toCsv(rows));
}

// Log của một trạm, mới nhất trước, kèm subscription realtime.
//
// `level`/`source`/`search` lọc ở phía server để không kéo về những dòng sẽ bị
// vứt đi ngay — sau vài tuần chạy thật, nhật ký dài hơn nhiều lần so với một
// trang hiển thị.
//
// Sắp xếp theo `id desc` chứ không `created_at desc` (0030 mục 10): hai thứ tự
// trùng nhau vì `id` là identity tăng dần, nhưng `id` không có giá trị trùng —
// điều kiện để nút "Tải thêm" phân trang bằng `id < <dòng cuối>` không bỏ sót
// hay lặp dòng khi nhiều sự kiện rơi vào cùng một mili giây. Phân trang bằng
// offset thì sai hẳn ở đây: log mới chèn vào ĐẦU danh sách liên tục qua
// realtime, nên offset 50 trỏ tới một chỗ khác sau mỗi sự kiện mới.
export function useSystemLogs(stationId, { level = 'all', source = 'all', search = '' } = {}) {
  const { user } = useAuth();
  // Xem chú thích ở useTelemetry (lib/telemetry.js): effect bám vào user.id để
  // không tải lại mỗi lần object `user` đổi identity.
  const userId = user?.id ?? null;
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  // Ô tìm kiếm gõ tới đâu truy vấn tới đó sẽ bắn một request mỗi phím. Chờ
  // 300ms sau phím cuối: đủ ngắn để cảm giác tức thì, đủ dài để gõ xong một từ
  // chỉ tốn một lượt gọi.
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  // Bộ lọc hiện hành cho subscription realtime. Giữ trong ref thay vì đóng gói
  // vào closure của effect để việc đổi bộ lọc không phải huỷ và đăng ký lại
  // channel — mỗi lần như vậy là một vòng WebSocket mới, và người dùng gõ tìm
  // kiếm thì đổi bộ lọc hàng chục lần liên tiếp.
  const filterRef = useRef({ level, source, search: debouncedSearch });
  filterRef.current = { level, source, search: debouncedSearch };

  // Lấy cả sự kiện mức tài khoản (`station_id` null — dọn dữ liệu, lưu trữ,
  // đổi chính sách giữ dữ liệu, quản lý firmware): chúng không thuộc trạm nào
  // nhưng lại đúng là thứ người dùng cần thấy khi đang xem nhật ký.
  const buildQuery = useCallback(() => {
    let q = supabase
      .from('system_logs')
      .select('*')
      .or(`station_id.eq.${stationId},station_id.is.null`)
      .order('id', { ascending: false })
      .limit(PAGE_SIZE);
    if (level !== 'all') q = q.eq('level', level);
    if (source !== 'all') q = q.eq('source', source);
    // Tìm trong cả `message` (câu tiếng Việt) lẫn `event` (mã sự kiện): người
    // vận hành gõ "quá nhiệt", còn người đọc code gõ "overtemp" — cả hai đều
    // phải ra cùng một kết quả.
    if (debouncedSearch) {
      const safe = debouncedSearch.replace(/[%,()]/g, ' ');
      q = q.or(`message.ilike.%${safe}%,event.ilike.%${safe}%`);
    }
    return q;
  }, [stationId, level, source, debouncedSearch]);

  // Tải trang đầu. Chạy lại mỗi khi đổi bộ lọc — kể cả khi người dùng đang gõ
  // tìm kiếm, nên phải TÁCH khỏi effect đăng ký realtime bên dưới.
  useEffect(() => {
    if (!userId || !stationId) {
      setLogs([]);
      setHasMore(false);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError('');

    (async () => {
      const { data, error: err } = await buildQuery();
      if (cancelled) return;
      if (err) {
        setError('Không đọc được nhật ký hệ thống.');
        setLogs([]);
        setHasMore(false);
      } else {
        setLogs((data || []).map(mapRow));
        setHasMore((data || []).length === PAGE_SIZE);
      }
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [userId, stationId, buildQuery, reloadKey]);

  // Đăng ký realtime, phụ thuộc DUY NHẤT vào trạm đang xem. Nếu effect này bám
  // vào bộ lọc thì mỗi phím gõ trong ô tìm kiếm là một lượt huỷ + mở lại
  // WebSocket — bộ lọc hiện hành đọc qua `filterRef` thay vì qua closure.
  //
  // Không đặt `filter` cho channel: realtime chỉ nhận một điều kiện bằng nhau,
  // không diễn đạt được "của trạm này HOẶC mức tài khoản". Đăng ký toàn bộ rồi
  // lọc tại client — RLS vẫn chỉ đẩy về hàng thuộc người dùng này.
  useEffect(() => {
    if (!userId || !stationId) return;

    const channel = supabase
      .channel(`system-logs:${stationId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'system_logs' },
        (payload) => {
          const row = mapRow(payload.new);
          const f = filterRef.current;
          if (row.stationId && row.stationId !== stationId) return;
          if (f.level !== 'all' && row.level !== f.level) return;
          if (f.source !== 'all' && row.source !== f.source) return;
          if (f.search) {
            const q = f.search.toLowerCase();
            const hit =
              row.message.toLowerCase().includes(q) || row.event.toLowerCase().includes(q);
            if (!hit) return;
          }
          // Không cắt đuôi danh sách ở đây: cắt sẽ xoá mất những trang người
          // dùng vừa bấm "Tải thêm" để đọc, và làm `hasMore` nói dối.
          setLogs((prev) => (prev.some((l) => l.id === row.id) ? prev : [row, ...prev]));
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId, stationId]);

  // Trang kế tiếp, tính từ dòng CŨ NHẤT đang giữ (id nhỏ nhất) chứ không từ
  // `logs.length`: realtime chèn thêm ở đầu danh sách giữa hai lần bấm.
  async function loadMore() {
    if (loadingMore || logs.length === 0) return;
    setLoadingMore(true);
    const oldestId = logs[logs.length - 1].id;
    const { data, error: err } = await buildQuery().lt('id', oldestId);
    setLoadingMore(false);
    if (err) {
      setError('Không tải thêm được nhật ký.');
      return;
    }
    const page = (data || []).map(mapRow);
    setLogs((prev) => {
      const seen = new Set(prev.map((l) => l.id));
      return [...prev, ...page.filter((l) => !seen.has(l.id))];
    });
    setHasMore(page.length === PAGE_SIZE);
  }

  // Xoá toàn bộ nhật ký của trạm. Đi qua RPC vì bảng không có policy delete —
  // xem migration 0018 mục 6.
  //
  // Chỉ xoá dòng THUỘC TRẠM: sự kiện mức tài khoản (`station_id` null — dọn dữ
  // liệu, quản lý firmware, đổi chính sách lưu trữ) không thuộc trạm nào nên
  // RPC không đụng tới, và chúng vẫn hiện lại sau khi tải lại danh sách.
  async function clearStationLogs() {
    if (!stationId) return { error: new Error('no_station') };
    const { data, error: err } = await supabase.rpc('clear_station_logs', {
      p_station_id: stationId,
    });
    if (err) return { error: err };
    refresh();
    return { deleted: data ?? 0 };
  }

  return {
    logs,
    loading,
    loadingMore,
    hasMore,
    error,
    refresh,
    loadMore,
    clearStationLogs,
  };
}
