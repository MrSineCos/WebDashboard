import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from './supabaseClient.js';
import { useAuth } from './AuthContext.jsx';

// Nhãn tiếng Việt + thứ tự ưu tiên của từng loại cảnh báo (cột `alerts.kind`,
// migration 0023). `message` trong DB đã là câu hoàn chỉnh để hiển thị; nhãn ở
// đây dùng cho huy hiệu phân loại và bộ lọc, nơi cần một từ ngắn.
// `resolvedLabel` là câu mô tả lúc đợt ĐÓNG lại, dùng cho mục hồi phục trên
// chuông thông báo (xem alertNotifEvents). Viết ở thể chủ động và nói rõ thứ đã
// trở lại bình thường: "đã kết nối lại" trả lời đúng câu hỏi mà người đang lo
// lắng đặt ra, còn "cảnh báo đã đóng" thì không.
// `durationLabel` là từ đứng trước độ dài đợt ("gián đoạn 15 phút").
//
// `severity` chép lại mức mà database gán CỐ ĐỊNH cho từng loại — mỗi lời gọi
// raise_alert trong evaluate_station_alerts (0023 mục 5) và mark_stale_offline
// (mục 7) truyền đúng một hằng số, không có loại nào đổi mức theo hoàn cảnh.
// Chỉ dùng để dựng bảng chú giải phân loại ở trang Thông báo, KHÔNG dùng để tô
// màu một dòng cụ thể: dòng đó phải đọc `alerts.severity` của chính nó, vì một
// đợt cũ trong lịch sử giữ nguyên mức lúc nó được mở kể cả khi luật đổi sau này.
export const ALERT_KIND_META = {
  offline: { label: 'Mất kết nối', severity: 'danger', resolvedLabel: 'đã kết nối lại', durationLabel: 'gián đoạn' },
  undervoltage: { label: 'Điện áp thấp', severity: 'danger', resolvedLabel: 'điện áp đã trở lại bình thường' },
  overtemp: { label: 'Quá nhiệt', severity: 'danger', resolvedLabel: 'nhiệt độ đã trở lại bình thường' },
  overload: { label: 'Quá tải', severity: 'warning', resolvedLabel: 'tải đã trở lại bình thường' },
  low_battery: { label: 'Pin yếu', severity: 'warning', resolvedLabel: 'pin đã hồi lên trên ngưỡng' },
  charge_blocked: { label: 'Ngắt sạc', severity: 'warning', resolvedLabel: 'đã cho phép sạc trở lại' },
  discharge_blocked: { label: 'Ngắt xả', severity: 'danger', resolvedLabel: 'đã cho phép xả trở lại' },
};

// Các loại thuộc từng mức, suy ra từ bảng trên. Bảng chú giải ở trang Thông báo
// đọc hàm này thay vì chép sẵn danh sách, nên thêm một loại cảnh báo mới chỉ
// phải khai báo đúng một lần ở ALERT_KIND_META.
export function alertKindsOfSeverity(severity) {
  return Object.entries(ALERT_KIND_META)
    .filter(([, meta]) => meta.severity === severity)
    .map(([, meta]) => meta.label);
}

// Hai mức phân loại của hệ thống, ứng với cột `alerts.severity` (0023):
//
//   * NGHIÊM TRỌNG (`danger`) — sự cố có thể làm hỏng thiết bị hoặc cắt điện
//     của tải: mất kết nối, điện áp pin dưới ngưỡng, quá nhiệt, ngắt xả.
//     Cần xử lý ngay.
//   * BẤT THƯỜNG (`warning`) — hệ thống vẫn chạy nhưng đang lệch khỏi dải bình
//     thường: quá tải, pin yếu, ngắt sạc. Cần để mắt, chưa cần can thiệp.
//
// Trước đây mức `warning` mang nhãn "Cảnh báo" — trùng đúng tên của cả mục
// chứa nó, nên "Cảnh báo: Cảnh báo" không nói thêm được gì. "Bất thường" mô tả
// đúng ý nghĩa (lệch khỏi bình thường, chưa nguy hiểm) và tách bạch với mức
// nghiêm trọng khi nhìn lướt.
//
// `info` KHÔNG phải một mức phân loại thứ ba: ràng buộc check của 0023 cho
// phép giá trị đó tồn tại nhưng không có luật nào trong evaluate_station_alerts
// sinh ra nó. Giữ lại đây làm nhánh dự phòng cho `?? ALERT_SEVERITY_META.info`
// (dữ liệu cũ / mức lạ) chứ không dựng ô lọc — xem ALERT_CLASS_ORDER.
export const ALERT_SEVERITY_META = {
  danger: {
    label: 'Nghiêm trọng',
    desc: 'Hệ thống đang mất an toàn hoặc mất khả năng cấp điện. Cần kiểm tra ngay.',
    color: 'oklch(58% 0.19 25)', bg: 'oklch(93% 0.06 25)', textColor: 'oklch(52% 0.17 25)', rank: 0,
  },
  warning: {
    label: 'Bất thường',
    desc: 'Hệ thống vẫn chạy nhưng đang lệch khỏi dải bình thường. Nên theo dõi thêm.',
    color: 'oklch(75% 0.14 70)', bg: 'oklch(95% 0.06 70)', textColor: 'oklch(52% 0.13 70)', rank: 1,
  },
  info: {
    label: 'Thông tin',
    desc: 'Thông báo không đi kèm sự cố.',
    color: 'oklch(54% 0.15 240)', bg: 'oklch(94% 0.03 240)', textColor: 'oklch(46% 0.14 240)', rank: 2,
  },
};

// Thứ tự hiển thị của các ô lọc theo phân loại, nặng trước nhẹ. Chỉ liệt kê
// những mức mà database thực sự sinh ra, nên không có ô lọc nào không bao giờ
// khớp hàng nào (cùng lý do ALERT_RESOLVED_META nằm ngoài bảng trên).
export const ALERT_CLASS_ORDER = ['danger', 'warning'];

// Mức độ GIẢ, chỉ tồn tại ở tầng hiển thị của chuông thông báo: một đợt vừa
// đóng là tin TỐT nên không thể mượn màu của bất kỳ mức nghiêm trọng nào. Cố ý
// không thêm vào ALERT_SEVERITY_META — bảng đó phản ánh cột `alerts.severity`
// thật và còn dùng để dựng bộ lọc ở trang Thông báo, thêm một mức không tồn tại
// trong database vào đó sẽ sinh ra một ô lọc không bao giờ khớp hàng nào.
export const ALERT_RESOLVED_META = { label: 'Đã khắc phục', color: 'oklch(64% 0.15 150)' };

// Bốn ô lọc của trang Thông báo, theo đúng thứ tự hiển thị. Hai ô đầu lọc theo
// TRẠNG THÁI (còn mở hay không), hai ô sau theo PHÂN LOẠI — trộn hai trục vào
// một hàng nút là có chủ đích: người dùng chỉ hỏi một câu mỗi lần ("còn gì đang
// sai?" HOẶC "có bao nhiêu chuyện nghiêm trọng?"), nên hai hàng nút riêng bắt
// họ đọc qua một trục không dùng tới.
//
// `desc` là câu hiện ở khung mô tả cạnh danh sách; `kinds` chỉ có ở ô phân loại
// vì "Tất cả"/"Đang diễn ra" cắt ngang mọi loại nên liệt kê ra không nói thêm
// được gì.
export const ALERT_FILTER_META = {
  all: {
    label: 'Tất cả',
    desc: 'Toàn bộ lịch sử thông báo, gồm cả tin báo sự cố lẫn tin báo hệ thống đã trở lại bình thường.',
    color: null,
    kinds: null,
  },
  open: {
    label: 'Đang diễn ra',
    desc: 'Những sự cố chưa được khắc phục. Đây là phần cần xử lý ngay lúc này.',
    color: null,
    kinds: null,
  },
  ...Object.fromEntries(ALERT_CLASS_ORDER.map((sev) => [sev, {
    label: ALERT_SEVERITY_META[sev].label,
    desc: ALERT_SEVERITY_META[sev].desc,
    color: ALERT_SEVERITY_META[sev].color,
    kinds: alertKindsOfSeverity(sev),
  }])),
};

export const ALERT_FILTER_ORDER = Object.keys(ALERT_FILTER_META);

// Khoảng thời gian của khung thống kê. Cửa sổ TRƯỢT (24 giờ qua) chứ không phải
// mốc lịch (từ 0h hôm nay): trạm có múi giờ riêng (0021) và một khung "hôm nay"
// sẽ phải chọn đọc theo múi giờ nào — của trạm đang xem, hay của người đang
// ngồi ở nơi khác? Cửa sổ trượt không đặt ra câu hỏi đó và trả lời đúng thứ
// người dùng muốn biết ("gần đây có nhiều sự cố không").
//
// `windowLabel` viết thường vì luôn đứng giữa câu ở dòng chú thích bên dưới.
export const ALERT_STAT_RANGES = [
  { id: 'day', label: 'Ngày', windowLabel: '24 giờ qua', ms: 24 * 60 * 60 * 1000 },
  { id: 'week', label: 'Tuần', windowLabel: '7 ngày qua', ms: 7 * 24 * 60 * 60 * 1000 },
  { id: 'month', label: 'Tháng', windowLabel: '30 ngày qua', ms: 30 * 24 * 60 * 60 * 1000 },
  { id: 'all', label: 'Tất cả', windowLabel: 'toàn bộ lịch sử còn lưu', ms: null },
];

// Đếm số ĐỢT cảnh báo theo từng mức, trong cửa sổ `windowMs` tính từ bây giờ.
//
// Đếm đợt chứ không đếm sự kiện: một đợt đã khắc phục sinh hai dòng trên danh
// sách (mở + hồi phục, xem alertNotifEvents), gộp cả hai vào thống kê thì mỗi
// sự cố đã qua tự nhân đôi và con số nói quá gấp đôi thực tế.
//
// Mốc so sánh là `startedAt` — "phát sinh trong khoảng này". Một đợt mở từ ba
// hôm trước và còn đang chạy KHÔNG được tính vào cửa sổ 24 giờ; nó vẫn đang là
// vấn đề, nhưng con số "đang diễn ra" ở đầu thẻ danh sách mới là chỗ trả lời
// câu đó, còn khung này trả lời "gần đây hệ thống hỏng nhiều tới mức nào".
// Nhãn ở giao diện phải nói "phát sinh trong ..." để hai con số không đọc như
// một.
export function alertSeverityCounts(alerts, windowMs) {
  const since = windowMs == null ? null : Date.now() - windowMs;
  const counts = Object.fromEntries(ALERT_CLASS_ORDER.map((sev) => [sev, 0]));
  let total = 0;
  for (const a of alerts) {
    if (since != null && new Date(a.startedAt).getTime() < since) continue;
    total += 1;
    // Mức lạ (dữ liệu cũ, hoặc `info` mà không luật nào sinh ra) vẫn được cộng
    // vào `total` nhưng không có dòng riêng — thà tổng lớn hơn tổng hai dòng
    // còn hơn giấu mất một sự cố đã thực sự xảy ra.
    if (a.severity in counts) counts[a.severity] += 1;
  }
  return { counts, total };
}

// Màu chấm cho từng mục trên chuông. Suy ra từ hai bảng trên thay vì chép lại
// bộ mã màu: Dashboard và AppShell đều đọc bảng này nên cùng một loại mục luôn
// hiện cùng một màu ở cả chuông desktop lẫn chuông mobile.
export const NOTIF_DOT_COLOR = {
  ...Object.fromEntries(Object.entries(ALERT_SEVERITY_META).map(([k, v]) => [k, v.color])),
  resolved: ALERT_RESOLVED_META.color,
};

// Câu hiển thị khi một đợt đã được khắc phục.
export function alertResolvedMessage(kind, stationName) {
  const label = ALERT_KIND_META[kind]?.resolvedLabel ?? 'sự cố đã được khắc phục';
  return `${stationName}: ${label}`;
}

// Bung danh sách ĐỢT thành danh sách SỰ KIỆN cho chuông thông báo.
//
// Vì sao cần: bảng `alerts` cố tình giữ một hàng cho cả một đợt (0023) — mất
// kết nối mở đợt, bản tin telemetry quay lại đóng chính hàng đó. Mô hình ấy
// đúng cho tab "Đang diễn ra" (nơi câu hỏi là "đang có sự cố nào?") nhưng ở chuông
// thì nó nuốt mất nửa câu chuyện: người dùng thấy "mất kết nối" rồi không bao
// giờ thấy tin hệ thống đã trở lại, trong khi Nhật ký hệ thống ở DevConsole
// hiện đủ cả hai chiều (`system_logs` ghi theo sự kiện, không theo đợt).
//
// Nên ở đây một đợt ĐÃ ĐÓNG sinh ra HAI mục: lúc mở và lúc khắc phục. Cả hai
// mang cùng `id` của đợt gốc, nên bấm vào mục nào cũng đánh dấu đã đọc đúng
// hàng đó — đổi lại, cả hai cùng biến mất khỏi danh sách "chưa đọc". Sắp xếp
// theo thời điểm xảy ra (mới nhất trước), đúng nghĩa "Thông báo mới nhất";
// mục còn đang diễn ra được đánh dấu riêng bằng cờ `ongoing` để nó không lẫn
// vào những chuyện đã qua khi bị đẩy xuống dưới.
//
// `kind`/`readAt` đi kèm mỗi mục vì trang Thông báo cũng dựng danh sách từ hàm
// này (không chỉ chuông): nó cần huy hiệu phân loại và chấm "chưa đọc" mà
// không phải tra ngược về đợt gốc. `value`/`threshold` chỉ gắn vào mục MỞ —
// đó là số đo lúc mở đợt, đặt lên mục hồi phục sẽ đọc như số đo lúc hồi phục.
//
// `baseSeverity` là mức phân loại THẬT của đợt gốc, đi kèm cả hai mục. Cần
// tách khỏi `severity` vì mục hồi phục mượn mức giả 'resolved' để lấy màu
// xanh: lọc theo `severity` thì ô "Nghiêm trọng" đánh rơi đúng dòng nói sự cố
// nghiêm trọng đó đã được khắc phục — nửa còn lại của cùng một câu chuyện.
export function alertNotifEvents(alerts) {
  const events = [];
  for (const a of alerts) {
    events.push({
      key: `${a.id}:opened`,
      id: a.id,
      kind: a.kind,
      severity: a.severity,
      baseSeverity: a.severity,
      message: a.message,
      at: a.startedAt,
      ongoing: a.resolvedAt == null,
      resolved: false,
      durationMs: null,
      readAt: a.readAt,
      value: a.value,
      threshold: a.threshold,
    });
    if (a.resolvedAt) {
      events.push({
        key: `${a.id}:resolved`,
        id: a.id,
        kind: a.kind,
        severity: 'resolved',
        baseSeverity: a.severity,
        message: alertResolvedMessage(a.kind, a.stationName),
        at: a.resolvedAt,
        ongoing: false,
        resolved: true,
        durationMs: new Date(a.resolvedAt).getTime() - new Date(a.startedAt).getTime(),
        durationLabel: ALERT_KIND_META[a.kind]?.durationLabel ?? 'kéo dài',
        readAt: a.readAt,
        value: null,
        threshold: null,
      });
    }
  }
  return events.sort((x, y) => new Date(y.at) - new Date(x.at));
}

function mapRow(row) {
  return {
    id: row.id,
    stationId: row.station_id,
    kind: row.kind,
    severity: row.severity,
    message: row.message,
    // Số đo và ngưỡng tại thời điểm MỞ đợt cảnh báo — cố ý không cập nhật theo
    // từng bản tin sau đó (xem raise_alert trong 0023). Giá trị hiện tại nằm ở
    // các ô thông số realtime của Dashboard.
    value: row.value == null ? null : Number(row.value),
    threshold: row.threshold == null ? null : Number(row.threshold),
    meta: row.meta ?? {},
    startedAt: row.started_at,
    // null = đợt đang diễn ra. Đây là thứ phân biệt "hệ thống đang có sự cố"
    // với "đã từng có sự cố", nên mọi chỗ hiển thị đều phải đọc trường này chứ
    // không suy ra từ độ mới của startedAt.
    resolvedAt: row.resolved_at,
    readAt: row.read_at,
  };
}

// Sắp xếp: đang diễn ra lên trước (một sự cố còn nguyên đó quan trọng hơn mọi
// sự cố đã qua), rồi tới mức nghiêm trọng, rồi mới nhất trước.
function compareAlerts(a, b) {
  const aOpen = a.resolvedAt == null;
  const bOpen = b.resolvedAt == null;
  if (aOpen !== bOpen) return aOpen ? -1 : 1;
  const aRank = ALERT_SEVERITY_META[a.severity]?.rank ?? 9;
  const bRank = ALERT_SEVERITY_META[b.severity]?.rank ?? 9;
  if (aRank !== bRank) return aRank - bRank;
  return new Date(b.startedAt) - new Date(a.startedAt);
}

// Số cảnh báo tải về tối đa. Lịch sử dài hơn đã bị job dọn theo
// `log_retention_days` cắt (0023 mục 8), và không giao diện nào cuộn hết 200
// dòng cảnh báo — kéo về nhiều hơn chỉ tốn băng thông.
//
// Export vì khung thống kê đếm trên chính mảng đã tải: chạm trần nghĩa là con
// số "Tất cả" chỉ là một CẬN DƯỚI chứ không phải tổng thật, và giao diện phải
// nói ra điều đó thay vì trình bày một con số thiếu như thể nó đầy đủ.
export const ALERT_FETCH_LIMIT = 200;

// Cảnh báo của TẤT CẢ trạm thuộc tài khoản, không lọc theo trạm đang xem.
//
// Có chủ đích: chuông thông báo phải kêu khi trạm KHÁC gặp sự cố. Lọc theo
// trạm đang mở thì một người có ba trạm sẽ chỉ thấy sự cố của trạm họ tình cờ
// đang nhìn — đúng lúc cần cảnh báo nhất thì nó im lặng. Trang "Thông báo" tự
// lọc lại theo trạm khi người dùng muốn.
export function useAlerts() {
  const { user } = useAuth();
  // Xem chú thích ở useTelemetry (lib/telemetry.js): effect bám vào user.id để
  // không mở lại kênh realtime mỗi lần object `user` đổi identity.
  const userId = user?.id ?? null;
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userId) {
      setAlerts([]);
      setLoading(false);
      return;
    }
    let cancelled = false;

    async function load() {
      setLoading(true);
      const { data } = await supabase
        .from('alerts')
        .select('*')
        .order('started_at', { ascending: false })
        .limit(ALERT_FETCH_LIMIT);
      if (cancelled) return;
      setAlerts((data || []).map(mapRow).sort(compareAlerts));
      setLoading(false);
    }

    load();

    // Realtime là toàn bộ giá trị của một hệ thống cảnh báo: sự cố phải hiện
    // ra ngay, không đợi người dùng tải lại trang. Lọc theo owner_id (không
    // phải station_id) vì hook này cố ý theo dõi mọi trạm — xem chú thích trên.
    const channel = supabase
      .channel(`alerts:${userId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'alerts', filter: `owner_id=eq.${userId}` },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            setAlerts((prev) => prev.filter((a) => a.id !== payload.old.id));
            return;
          }
          const mapped = mapRow(payload.new);
          setAlerts((prev) => {
            const exists = prev.some((a) => a.id === mapped.id);
            const next = exists ? prev.map((a) => (a.id === mapped.id ? mapped : a)) : [...prev, mapped];
            return next.sort(compareAlerts);
          });
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [userId]);

  // Cập nhật lạc quan rồi mới ghi DB: đánh dấu đã đọc phải phản hồi tức thì.
  // Realtime sẽ gửi lại đúng hàng đó ngay sau, nên state hội tụ về giá trị
  // thật kể cả khi lượt ghi hỏng.
  const markRead = useCallback(async (id) => {
    const at = new Date().toISOString();
    setAlerts((prev) => prev.map((a) => (a.id === id && !a.readAt ? { ...a, readAt: at } : a)));
    await supabase.from('alerts').update({ read_at: at }).eq('id', id).is('read_at', null);
  }, []);

  const markAllRead = useCallback(async () => {
    if (!userId) return;
    const at = new Date().toISOString();
    setAlerts((prev) => prev.map((a) => (a.readAt ? a : { ...a, readAt: at })));
    await supabase.from('alerts').update({ read_at: at }).eq('owner_id', userId).is('read_at', null);
  }, [userId]);

  // Chỉ xoá được đợt ĐÃ ĐÓNG — policy `alerts_delete_resolved_own` (0023) từ
  // chối phần còn lại. Chặn luôn ở đây để không gửi đi một lượt ghi chắc chắn
  // bị từ chối, và để lời gọi nói rõ ý định.
  const dismiss = useCallback(async (id) => {
    const target = alerts.find((a) => a.id === id);
    if (!target || target.resolvedAt == null) return { error: new Error('alert_still_open') };
    setAlerts((prev) => prev.filter((a) => a.id !== id));
    const { error } = await supabase.from('alerts').delete().eq('id', id);
    return error ? { error } : {};
  }, [alerts]);

  const open = useMemo(() => alerts.filter((a) => a.resolvedAt == null), [alerts]);
  const unread = useMemo(() => alerts.filter((a) => !a.readAt), [alerts]);

  return { alerts, open, unread, unreadCount: unread.length, loading, markRead, markAllRead, dismiss };
}
