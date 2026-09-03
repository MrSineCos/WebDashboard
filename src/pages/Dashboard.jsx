import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import AppShell from '../components/AppShell.jsx';
import Avatar from '../components/Avatar.jsx';
import { useIsMobile } from '../lib/useIsMobile.js';
import { userAvatarUrl, ownAvatarStoragePath, AVATAR_MAX_BYTES, AVATAR_MIME_TYPES } from '../lib/avatar.js';
import { useStationSelector, STATION_STATUS_META, fmtCycles, fmtEnergy, fmtWatt, fmtPower } from '../lib/stations.js';
import {
  useAlerts, ALERT_KIND_META, ALERT_SEVERITY_META, ALERT_RESOLVED_META, ALERT_CLASS_ORDER,
  ALERT_FILTER_META, ALERT_FILTER_ORDER, ALERT_STAT_RANGES, ALERT_FETCH_LIMIT,
  NOTIF_DOT_COLOR, alertNotifEvents, alertSeverityCounts,
} from '../lib/alerts.js';
import { useTelemetry, useTelemetryWindow, useDevices, useDailyEnergy } from '../lib/telemetry.js';
import { toCsv, downloadCsv, slugify } from '../lib/csv.js';
import { useUserSettings } from '../lib/userSettings.js';
import { usePush } from '../lib/push.js';
import { useLoads } from '../lib/loads.js';
import { useAuth } from '../lib/AuthContext.jsx';
import { supabase } from '../lib/supabaseClient.js';

const BLUE = 'oklch(54% 0.15 240)';

// Một bản tin telemetry cũ hơn ngưỡng này được coi là "cũ" → hiện dòng ghi chú
// thời điểm cập nhật gần nhất trong mỗi ô thông số.
const STALE_MS = 60000;
// Số điểm tối thiểu còn lại trên biểu đồ khi zoom hết cỡ (lăn chuột).
const MIN_ZOOM_POINTS = 5;

// Các mục nav hiển thị như 1 view riêng của Dashboard (thay toàn bộ nội dung),
// khác với các mục còn lại vốn là section cuộn trong view 'dashboard'.
const STANDALONE_VIEWS = ['settings', 'load', 'alerts', 'chart'];

// Độ dài khung thời gian hiển thị của biểu đồ thời gian thực.
const CHART_WINDOWS = [
  { id: '15m', label: '15 phút', ms: 15 * 60 * 1000 },
  { id: '30m', label: '30 phút', ms: 30 * 60 * 1000 },
  { id: '1h', label: '1 giờ', ms: 60 * 60 * 1000 },
  { id: '3h', label: '3 giờ', ms: 3 * 60 * 60 * 1000 },
  { id: '6h', label: '6 giờ', ms: 6 * 60 * 60 * 1000 },
  { id: '24h', label: '24 giờ', ms: 24 * 60 * 60 * 1000 },
];

// Các chuỗi vẽ được trên biểu đồ. `value` đọc ra số từ một bản tin telemetry;
// trả về null khi bản tin không có đại lượng đó (vd trạm không gắn cảm biến
// nhiệt) để phân biệt với giá trị 0 thật.
const CHART_SERIES = [
  {
    id: 'power', label: 'Công suất', unit: 'W', digits: 0,
    color: BLUE, textColor: 'oklch(46% 0.14 240)',
    value: (r) => (r.solarKw == null ? null : Math.round(r.solarKw * 1000)),
  },
  {
    id: 'voltage', label: 'Điện áp', unit: 'V', digits: 1,
    color: 'oklch(75% 0.14 70)', textColor: 'oklch(52% 0.13 70)',
    value: (r) => (r.batteryVoltage == null ? null : +r.batteryVoltage.toFixed(1)),
  },
  {
    id: 'current', label: 'Dòng điện', unit: 'A', digits: 1,
    color: 'oklch(60% 0.13 180)', textColor: 'oklch(46% 0.12 180)',
    // Dòng qua bộ lưu trữ, suy ra từ chênh lệch phát/tiêu thụ chia điện áp
    // pack — cùng công thức với ô "Dòng DC bus" ở trang Giám sát.
    value: (r, fallbackV) => {
      const v = r.batteryVoltage || fallbackV;
      if (!v || r.solarKw == null) return null;
      return +(((r.solarKw * 1000) - (r.loadW ?? 0)) / v).toFixed(1);
    },
  },
  {
    id: 'temp', label: 'Nhiệt độ pin', unit: '°C', digits: 1,
    color: 'oklch(62% 0.17 25)', textColor: 'oklch(50% 0.17 25)',
    value: (r) => (r.tempC == null ? null : +Number(r.tempC).toFixed(1)),
  },
];

const DEVICE_TYPE_LABEL ={ esp32: 'Bộ điều khiển ESP32', inverter: 'Inverter', bms: 'BMS Pin lưu trữ', sensor: 'Cảm biến' };

// Các lựa chọn múi giờ cho thẻ "Thông tin trạm" (Cài đặt → Hệ thống). Giá trị
// là id IANA thật (đi thẳng vào Intl/toLocaleString), nhãn giữ nguyên các
// thành phố mẫu quen thuộc với người dùng Việt Nam.
const TIMEZONE_OPTIONS = [
  { id: 'Asia/Ho_Chi_Minh', label: '(GMT+7) Bangkok, Hà Nội, Jakarta' },
  { id: 'Asia/Singapore', label: '(GMT+8) Singapore, Bắc Kinh, Kuala Lumpur' },
  { id: 'Asia/Tokyo', label: '(GMT+9) Tokyo, Seoul' },
  { id: 'Asia/Kolkata', label: '(GMT+5:30) New Delhi' },
  { id: 'Asia/Dubai', label: '(GMT+4) Dubai' },
  { id: 'UTC', label: '(GMT+0) UTC' },
];

// Định dạng thời điểm bản tin (giờ:phút, ngày/tháng) cho dòng ghi chú. `tz` =
// múi giờ của trạm (station.timezone, migration 0021); bỏ trống thì
// toLocaleString tự dùng múi giờ trình duyệt, hành vi cũ không đổi.
function fmtClock(ts, tz) {
  return new Date(ts).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', timeZone: tz });
}

// Như fmtClock nhưng kèm giây — dùng cho nhãn "tại ..." khi hover biểu đồ,
// nơi độ chính xác tới giây thực sự hữu ích (chu kỳ gửi telemetry là ~10s).
function fmtClockSec(ts, tz) {
  return new Date(ts).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit', day: '2-digit', month: '2-digit', timeZone: tz });
}

// Trả về giá trị đã định dạng, hoặc "--" khi chưa có dữ liệu telemetry.
function fmtNum(v, digits = 0) {
  return v == null || Number.isNaN(Number(v)) ? '--' : Number(v).toFixed(digits);
}

// Số đo kèm theo mỗi đợt cảnh báo (`alerts.metric_value` / `threshold_value`).
// `overload` là loại DUY NHẤT database ghi bằng kW: cột đó giữ nguyên thang cũ
// để lịch sử cảnh báo không đứt gãy ở giữa (xem 0032), trong khi mọi con số
// công suất trên giao diện — kể cả câu mô tả ngay phía trên dòng này — đã là W.
function fmtAlertMetric(kind, v) {
  if (kind !== 'overload') return fmtNum(v, 1);
  return v == null || Number.isNaN(Number(v)) ? '--' : fmtNum(Number(v) * 1000, 0);
}

function fmtRelative(ts) {
  if (!ts) return 'chưa có dữ liệu';
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'vừa xong';
  if (mins < 60) return `${mins} phút trước`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} giờ trước`;
  return `${Math.floor(hours / 24)} ngày trước`;
}

// Độ dài một đợt sự cố, cho dòng "gián đoạn 15 phút" ở mục hồi phục trên
// chuông. Làm tròn xuống phút và cắt hẳn phần giây: đợt ngắn hơn một phút thì
// con số chính xác không giúp được gì, mà "gián đoạn 0 phút" lại đọc như một
// lỗi hiển thị.
function fmtDuration(ms) {
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'dưới 1 phút';
  if (mins < 60) return `${mins} phút`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return mins % 60 ? `${hours} giờ ${mins % 60} phút` : `${hours} giờ`;
  return `${Math.floor(hours / 24)} ngày`;
}

// Dòng ghi chú nhỏ hiện thời điểm cập nhật gần nhất khi dữ liệu đã cũ (>1 phút).
function StaleNote({ show, label }) {
  if (!show) return null;
  return (
    <div style={{ fontSize: '11px', fontWeight: 600, color: 'oklch(60% 0.13 70)', marginTop: '4px' }}>
      Cập nhật lúc {label}
    </div>
  );
}

// Đoạn nối giữa hai khối trong sơ đồ "Dòng năng lượng". `flowing` = có dòng
// thật đang chạy (chấm động); `blocked` = thiết bị đã chủ động ngắt đường này
// (bảo vệ sạc/xả — mục 8 docs/IOT.md), vẽ dấu ✕ đỏ tĩnh thay vì chấm chạy dù
// solar/tải vẫn > 0. Không flowing và không blocked (vd ban đêm không có
// nắng) chỉ hiện đường tĩnh, không có ✕ vì đó không phải sự cố.
function FlowConnector({ flowing, blocked, color, delayOffset = 0 }) {
  return (
    <div style={{ flex: '0 0 60px', height: '2px', background: blocked ? 'oklch(58% 0.19 25 / 0.35)' : 'oklch(91% 0.01 240)', position: 'relative', overflow: 'visible' }}>
      {flowing && [0, 0.6, 1.2].map((delay) => (
        <span key={delay} className="flow-dot" style={{ position: 'absolute', top: '-3px', left: 0, width: '8px', height: '8px', borderRadius: '50%', background: color, animationDelay: `${delay + delayOffset}s` }} />
      ))}
      {blocked && (
        <span title="Đã ngắt bởi bảo vệ pin" style={{ position: 'absolute', top: '-8px', left: '50%', transform: 'translateX(-50%)', fontSize: '13px', fontWeight: 700, color: 'oklch(58% 0.19 25)', lineHeight: 1 }}>✕</span>
      )}
    </div>
  );
}

// Hai công tắc, cả hai đều có tác dụng thật.
//
// `emailAlerts` và `weeklyReport` đã bị BỎ (migration 0024 mục 1 xoá luôn khoá
// khỏi `notif_prefs`): dự án không nối dịch vụ gửi email nào, và một công tắc
// vĩnh viễn mang nhãn "Chưa khả dụng" chỉ làm màn hình cài đặt dài ra chứ không
// cho người dùng thêm lựa chọn nào.
//
// `push` không nằm trong danh sách này vì nó không phải một boolean đơn thuần:
// trạng thái thật của nó là quyền của trình duyệt + đăng ký trong
// `push_subscriptions`, nên nó có khối riêng bên dưới (xem PushRow).
const NOTIF_DEFS = [
  // Tắt đi thì database ngừng mở cảnh báo pin yếu và đóng đợt đang mở
  // (evaluate_station_alerts, migration 0023).
  { id: 'lowBattery', label: 'Cảnh báo pin yếu', note: 'Dùng ngưỡng SOC tối thiểu của chế độ bảo vệ pin đang chọn.' },
];

const BATTERY_FLOW_META = {
  charging: { label: 'Đang sạc', arrow: '↑', color: 'oklch(50% 0.14 150)', bg: 'oklch(93% 0.06 150)' },
  discharging: { label: 'Đang xả', arrow: '↓', color: 'oklch(52% 0.13 70)', bg: 'oklch(95% 0.06 70)' },
  full: { label: 'Đầy · chờ', arrow: '●', color: 'oklch(45% 0.02 240)', bg: 'oklch(93% 0.01 240)' },
  idle: { label: 'Cân bằng', arrow: '–', color: 'oklch(45% 0.02 240)', bg: 'oklch(93% 0.01 240)' },
  unknown: { label: 'Không rõ', arrow: '?', color: 'oklch(45% 0.02 240)', bg: 'oklch(93% 0.01 240)' },
};

function GoogleIcon({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" style={{ flexShrink: 0 }}>
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84c-.21 1.12-.85 2.08-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.95v2.33C2.43 15.98 5.48 18 9 18z" />
      <path fill="#FBBC05" d="M3.97 10.72c-.18-.54-.28-1.11-.28-1.72s.1-1.18.28-1.72V4.95H.95C.35 6.17 0 7.55 0 9s.35 2.83.95 4.05l3.02-2.33z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0 5.48 0 2.43 2.02.95 4.95l3.02 2.33C4.68 5.16 6.66 3.58 9 3.58z" />
    </svg>
  );
}

// Lỗi hay gặp nhất khi tải ảnh đại diện là bucket `avatars` chưa tồn tại —
// migration 0016 chưa chạy trên project Supabase đang dùng. Nói thẳng ra thay
// vì để nguyên "Bucket not found".
function avatarErrorText(error) {
  const raw = error?.message ?? '';
  if (/bucket not found/i.test(raw)) {
    return 'Chưa có kho lưu ảnh trên máy chủ. Chạy migration 0016_avatars.sql cho project Supabase rồi thử lại.';
  }
  if (/row-level security|not authorized|violates/i.test(raw)) {
    return 'Không có quyền tải ảnh lên. Kiểm tra lại policy của bucket `avatars` trong Supabase.';
  }
  if (/payload too large|exceeded the maximum|file size/i.test(raw)) {
    return 'Ảnh vượt quá dung lượng cho phép của máy chủ.';
  }
  if (/mime type/i.test(raw)) {
    return 'Định dạng ảnh không được máy chủ chấp nhận.';
  }
  return raw || 'Không tải được ảnh lên, vui lòng thử lại.';
}

const DEVICE_STATUS_COLOR = { connected: 'oklch(64% 0.15 150)', disconnected: 'oklch(58% 0.19 25)' };

// Dựng đường cho một chuỗi thời gian, chuẩn hoá theo min/max của chính chuỗi.
// Chịu được giá trị null (bản tin thiếu đại lượng đó): điểm null không được vẽ
// và làm đứt nét thay vì bị coi là 0 — nối thẳng qua chỗ mất dữ liệu sẽ vẽ ra
// một đoạn dốc không có thật.
// Trả về points[i] = null tại các vị trí không có dữ liệu.
function buildSeriesPath(values, w, h, padTop, padBottom) {
  const present = values.filter((v) => v != null);
  if (present.length === 0) return null;
  const min = Math.min(...present);
  const max = Math.max(...present);
  const range = max - min || 1;
  const stepX = values.length > 1 ? w / (values.length - 1) : w;
  const points = values.map((v, i) =>
    v == null ? null : { x: i * stepX, y: padTop + (1 - (v - min) / range) * (h - padTop - padBottom), value: v },
  );

  let line = '';
  let penDown = false;
  for (const p of points) {
    if (!p) {
      penDown = false;
      continue;
    }
    line += `${penDown ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)} `;
    penDown = true;
  }
  return { line: line.trim(), points, min, max };
}

function switchStyle(on) {
  return {
    track: {
      width: '42px', height: '24px', borderRadius: '12px', border: 'none', cursor: 'pointer',
      background: on ? BLUE : 'oklch(90% 0.01 240)', position: 'relative', padding: 0, flexShrink: 0,
    },
    thumb: {
      position: 'absolute', top: '3px', left: on ? '21px' : '3px',
      width: '18px', height: '18px', borderRadius: '50%', background: 'white',
      boxShadow: '0 1px 2px oklch(0% 0 0 / 0.2)', transition: 'left 0.15s',
    },
  };
}

// `compact` cho các hàng nút nằm trong cột phụ hẹp (khung thống kê ở trang
// Thông báo): bốn nút với padding 18px không lọt nổi 300px, mà tách ra một hàm
// style riêng thì hai hàng nút cạnh nhau sẽ trôi dạt khỏi nhau về sau.
function segmentTabStyle(active, compact = false) {
  return {
    border: 'none',
    background: active ? 'white' : 'none',
    color: active ? 'oklch(24% 0.05 240)' : 'oklch(52% 0.02 240)',
    boxShadow: active ? '0 1px 3px oklch(0% 0 0 / 0.08)' : 'none',
    padding: compact ? '6px 11px' : '9px 18px',
    borderRadius: compact ? '7px' : '9px',
    fontSize: compact ? '12px' : '13.5px',
    fontWeight: 700,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    flexShrink: 0,
    fontFamily: "'Manrope',sans-serif",
  };
}

function Switch({ on, onClick, disabled }) {
  const s = switchStyle(on);
  return (
    <button onClick={onClick} disabled={disabled} style={{ ...s.track, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.45 : 1 }}>
      <span style={s.thumb} />
    </button>
  );
}

// Hàng "Thông báo đẩy" trong Cài đặt → Thông báo.
//
// Tách riêng khỏi NOTIF_DEFS vì nó không phải một boolean lưu trong database:
// bật được hay không còn phụ thuộc trình duyệt có hỗ trợ Push API không, người
// dùng đã cấp quyền chưa, và máy này đã đăng ký chưa (lib/push.js). Ghi chú bên
// dưới nhãn phải nói đúng cái đang chặn — "Chưa khả dụng" chung chung thì người
// dùng không biết phải làm gì tiếp.
function PushRow({ push, onEnable, onDisable }) {
  let note;
  if (!push.supported) {
    note = 'Trình duyệt này không hỗ trợ thông báo đẩy. Hãy dùng Chrome, Edge hoặc Firefox bản mới.';
  } else if (!push.configured) {
    note = push.configProblem;
  } else if (push.permission === 'denied') {
    note = 'Trình duyệt đang chặn thông báo cho trang này. Bấm biểu tượng ổ khoá cạnh thanh địa chỉ để bỏ chặn, rồi bật lại.';
  } else if (push.subscribed) {
    note = push.deviceCount > 1
      ? `Đang bật trên máy này và ${push.deviceCount - 1} thiết bị khác.`
      : 'Đang bật trên máy này.';
  } else {
    note = 'Nhận cảnh báo ngay cả khi không mở trang. Chỉ áp dụng cho máy này.';
  }

  const canToggle = push.configured && !push.busy && !push.loading && push.permission !== 'denied';

  return (
    <div style={{ padding: '14px 4px', borderBottom: '1px solid oklch(95% 0.006 240)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '14px', fontWeight: 600 }}>Thông báo đẩy trên thiết bị này</div>
          <div style={{ fontSize: '12px', color: 'oklch(58% 0.02 240)', marginTop: '2px' }}>{note}</div>
        </div>
        <Switch
          on={push.subscribed}
          disabled={!canToggle}
          onClick={() => (push.subscribed ? onDisable() : onEnable())}
        />
      </div>

      {/* Nút gửi thử là cách duy nhất để biết chuỗi trình duyệt → máy chủ →
          thiết bị có thông hay không TRƯỚC khi có sự cố thật. */}
      {push.subscribed && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '10px', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={push.sendTest}
            disabled={push.busy}
            style={{ padding: '7px 14px', borderRadius: '8px', border: '1px solid oklch(88% 0.01 240)', background: 'white', fontSize: '12.5px', fontWeight: 600, color: 'oklch(30% 0.03 240)', cursor: push.busy ? 'not-allowed' : 'pointer', fontFamily: "'Manrope',sans-serif" }}
          >
            {push.busy ? 'Đang gửi…' : 'Gửi thông báo thử'}
          </button>
          {push.testResult && (
            <span style={{ fontSize: '12px', color: 'oklch(50% 0.14 150)' }}>{push.testResult}</span>
          )}
        </div>
      )}

      {push.error && (
        <div style={{ fontSize: '12px', color: 'oklch(52% 0.17 25)', marginTop: '8px', lineHeight: 1.5 }}>{push.error}</div>
      )}
    </div>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile(900);
  // Ngưỡng RIÊNG cho cột phụ của trang Thông báo, cao hơn hẳn 900 của giao diện
  // chung. Ở đúng 900px thì thanh nav đã chiếm 240px, còn lại ~580px cho vùng
  // nội dung — trừ tiếp 306px cột phụ và khoảng cách thì danh sách thông báo
  // chỉ còn ~250px và mỗi dòng vỡ thành năm dòng chữ. Dưới ngưỡng này cột phụ
  // xuống nằm trên danh sách (xem `order` bên dưới) thay vì ép chung một hàng.
  const alertsSideBySide = !useIsMobile(1200);
  const { station, statusMeta, stationColor, stationOptions, stationMenuOpen, toggleStationMenu, closeStationMenu, stations, createStation, updateStation, deleteStation, loading: stationLoading } = useStationSelector();
  // Chỉ còn dùng bản tin mới nhất cho các ô thông số — chuỗi thời gian của
  // biểu đồ nay do useTelemetryWindow bên dưới cung cấp.
  const { latest } = useTelemetry(station?.id);
  // Sản lượng mặt trời của riêng hôm nay, gộp sẵn ở server (RPC của 0005 —
  // cùng nguồn với trang Báo cáo, nên hai trang không bao giờ lệch số). Một
  // lượt gọi cho mỗi lần đổi trạm, rẻ hơn nhiều so với kéo telemetry cả ngày
  // về chỉ để cộng lại ở trình duyệt. "Hôm nay" là hôm nay theo múi giờ của
  // trạm (0021/0022), khớp với mốc thời gian hiển thị ở các ô bên cạnh.
  const { rows: todayEnergyRows } = useDailyEnergy(station?.id, 1, station?.timezone);
  // `devicesLoading` để ô chọn thiết bị của mỗi tải không hiện rỗng trong lúc
  // danh sách thiết bị chưa về — xem chú thích ở ô select đó.
  const { devices, loading: devicesLoading } = useDevices();
  // Cảnh báo thật từ bảng `alerts` (migration 0023), realtime. Cố ý KHÔNG
  // truyền station?.id: hook này theo dõi mọi trạm của tài khoản để chuông
  // thông báo còn kêu được khi sự cố xảy ra ở trạm không mở trên màn hình.
  const {
    alerts: allAlerts,
    markRead: markAlertRead,
    markAllRead: markAllAlertsRead,
    dismiss: dismissAlert,
  } = useAlerts();
  const settings = useUserSettings(station?.id);
  const push = usePush();
  const { loads: stationLoads, addLoad, removeLoad, setLoadDevice, setLoadState } = useLoads(station?.id);
  const { user, signOut } = useAuth();

  // Form "+ Thêm tải" trong Điều khiển tải.
  const [loadFormOpen, setLoadFormOpen] = useState(false);
  const [newLoadName, setNewLoadName] = useState('');
  const [newLoadWatt, setNewLoadWatt] = useState('');
  const [newLoadDeviceId, setNewLoadDeviceId] = useState('');
  const [loadFormSaving, setLoadFormSaving] = useState(false);
  const [loadFormError, setLoadFormError] = useState('');
  const [loadCommandError, setLoadCommandError] = useState('');
  // Id của tải đang đổi thiết bị điều khiển (khoá riêng ô đó, không khoá cả
  // danh sách — các tải khác vẫn bấm được bình thường).
  const [loadDeviceSavingId, setLoadDeviceSavingId] = useState(null);
  const [loadDeviceError, setLoadDeviceError] = useState('');

  // Form "Thêm trạm mới" + xác nhận xóa trạm, dùng trong Cài đặt → Hệ thống.
  const [newStationName, setNewStationName] = useState('');
  const [newStationLocation, setNewStationLocation] = useState('');
  const [stationFormSaving, setStationFormSaving] = useState(false);
  const [stationFormError, setStationFormError] = useState('');
  const [confirmDeleteStationId, setConfirmDeleteStationId] = useState(null);

  // Form "Thông tin trạm" (tên/địa điểm/múi giờ của trạm ĐANG chọn) — cũng
  // trong Cài đặt → Hệ thống. Input tên/địa điểm/múi giờ để uncontrolled (đọc
  // qua ref lúc submit, reset theo `key={station.id+...}` khi đổi trạm — cùng
  // cách trang này đang làm), chỉ trạng thái lưu/kết quả là state.
  const stationNameRef = useRef(null);
  const stationLocationRef = useRef(null);
  const stationTimezoneRef = useRef(null);
  const [stationInfoSaving, setStationInfoSaving] = useState(false);
  const [stationInfoError, setStationInfoError] = useState('');
  const [stationInfoSuccess, setStationInfoSuccess] = useState('');

  // Form "Ngưỡng cảnh báo" — cùng khuôn uncontrolled-ref với form ngay trên.
  const minVoltageRef = useRef(null);
  const maxTempRef = useRef(null);
  const maxLoadRef = useRef(null);
  const [thresholdSaving, setThresholdSaving] = useState(false);
  const [thresholdError, setThresholdError] = useState('');
  const [thresholdSuccess, setThresholdSuccess] = useState('');

  // Nhịp cập nhật để tính lại độ "cũ" của telemetry theo thời gian thực.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 20000);
    return () => clearInterval(id);
  }, []);
  const avatarUrl = userAvatarUrl(user);

  // Mục cần mở khi vào trang: điều hướng từ trang Báo cáo/Pin lưu trữ (các
  // trang này nằm ở route riêng nên phải gửi kèm mục đã bấm).
  const initialNav = location.state?.view || 'overview';
  const [activeNav, setActiveNav] = useState(initialNav);
  const [currentView, setCurrentView] = useState(() => (STANDALONE_VIEWS.includes(initialNav) ? initialNav : 'dashboard'));
  // Các mục là section trong trang Dashboard cần cuộn tới sau khi nội dung
  // render xong (lúc mount vẫn còn màn hình "Đang tải…" nên chưa có element).
  const pendingScrollRef = useRef(
    !STANDALONE_VIEWS.includes(initialNav) && initialNav !== 'overview' ? initialNav : null,
  );
  useEffect(() => {
    const id = pendingScrollRef.current;
    if (!id) return;
    const el = document.getElementById('sec-' + id);
    if (!el) return;
    pendingScrollRef.current = null;
    window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 20 });
  });
  const [settingsTab, setSettingsTab] = useState('account');
  // Module "Điều khiển tải"/"Thông báo"/"Biểu đồ" có thể bị ẩn riêng cho từng
  // trạm — nếu đang xem một trong các view đó rồi chuyển sang trạm đã ẩn module
  // tương ứng, quay lại view Dashboard thay vì hiển thị view đáng lẽ đã ẩn.
  useEffect(() => {
    if (settings.loading) return;
    if (currentView === 'load' && settings.moduleVisibility.load === false) setCurrentView('dashboard');
    if (currentView === 'alerts' && settings.moduleVisibility.alerts === false) setCurrentView('dashboard');
    if (currentView === 'chart' && settings.moduleVisibility.chart === false) setCurrentView('dashboard');
  }, [currentView, settings.loading, settings.moduleVisibility.load, settings.moduleVisibility.alerts, settings.moduleVisibility.chart]);

  // Đổi trạm thì thông báo lưu/lỗi của form "Thông tin trạm" thuộc về trạm cũ
  // không còn ý nghĩa — dọn đi để không hiện nhầm cho trạm mới đang xem.
  useEffect(() => {
    setStationInfoError('');
    setStationInfoSuccess('');
  }, [station?.id]);

  // --- Tuỳ chọn của trang "Biểu đồ thời gian thực" ---
  const [chartWindowId, setChartWindowId] = useState('30m');
  const [chartSeriesOn, setChartSeriesOn] = useState({ power: true, voltage: true, current: true, temp: false });
  const [chartExportError, setChartExportError] = useState('');
  const chartWindowMs = (CHART_WINDOWS.find((w) => w.id === chartWindowId) ?? CHART_WINDOWS[1]).ms;
  // Chỉ tải khi thực sự đang mở tab biểu đồ: khung 24 giờ có thể là vài nghìn
  // dòng, không đáng kéo về khi người dùng đang ở trang khác. Trang Giám sát
  // vẫn dùng useTelemetry (60 điểm gần nhất, không lọc theo thời gian) để ô
  // "cập nhật lúc" còn hiện được kể cả khi trạm đã mất kết nối nhiều ngày.
  const {
    readings: chartReadings,
    loading: chartLoading,
    truncated: chartTruncated,
  } = useTelemetryWindow(currentView === 'chart' ? station?.id : null, chartWindowMs);
  // Đơn vị hiển thị năng lượng (kWh/Wh) — cài đặt của người dùng, lưu ở
  // user_settings.energy_unit (migration 0021), xem lib/userSettings.js.
  const energyUnit = settings.energyUnit;
  // Ví dụ minh hoạ trong thẻ "Đơn vị đo lường" (Cài đặt → Hệ thống). Số 12,3
  // kWh là sản lượng một ngày nắng của hệ 3 kWp — đủ lớn để thấy rõ khác biệt
  // giữa hai đơn vị. Đi qua fmtEnergy() nên ví dụ luôn khớp cách hiển thị thật.
  const unitExample = fmtEnergy(12.3, energyUnit);
  const [hoverIdx, setHoverIdx] = useState(null);
  // Số điểm hiển thị trên biểu đồ khi đã zoom (null = hiện hết `chartReadings`).
  // Lăn chuột lên biểu đồ thu hẹp/mở rộng cửa sổ này (xem onChartWheel).
  const [zoomCount, setZoomCount] = useState(null);
  // Lăn chuột trên biểu đồ để zoom: lăn lên (deltaY < 0) = phóng to (thu hẹp
  // dải thời gian, ít điểm hơn), lăn xuống = thu nhỏ về lại toàn bộ khung.
  // Dùng callback ref (thay vì useRef+useEffect) để gắn listener "native"
  // đúng lúc div biểu đồ mount — cần native vì React coi wheel event là
  // passive theo mặc định, preventDefault() qua prop onWheel sẽ không chặn
  // được cuộn trang, khiến vừa zoom biểu đồ vừa cuộn cả trang.
  // Bám theo chuỗi ĐANG VẼ (chartReadings), không phải `readings` của trang
  // Giám sát — nếu lấy nhầm, mức zoom sẽ bị kẹp theo một tổng số điểm khác.
  const readingsLenRef = useRef(chartReadings.length);
  readingsLenRef.current = chartReadings.length;
  const chartWheelNodeRef = useRef(null);
  const handleChartWheel = useCallback((e) => {
    const total = readingsLenRef.current;
    if (total <= MIN_ZOOM_POINTS) return;
    e.preventDefault();
    setZoomCount((prev) => {
      const current = prev == null ? total : prev;
      const factor = e.deltaY < 0 ? 0.85 : 1 / 0.85;
      const next = Math.round(current * factor);
      const clamped = Math.min(total, Math.max(MIN_ZOOM_POINTS, next));
      return clamped >= total ? null : clamped;
    });
  }, []);
  const chartWheelRef = useCallback((node) => {
    if (chartWheelNodeRef.current) {
      chartWheelNodeRef.current.removeEventListener('wheel', handleChartWheel);
    }
    chartWheelNodeRef.current = node;
    if (node) node.addEventListener('wheel', handleChartWheel, { passive: false });
  }, [handleChartWheel]);
  const [notifOpen, setNotifOpen] = useState(false);
  // Bộ lọc của trang "Thông báo":
  //   'all'    — toàn bộ lịch sử thông báo (mặc định)
  //   'open'   — chỉ những sự cố còn đang diễn ra
  //   'danger' | 'warning' — lọc theo phân loại (ALERT_CLASS_ORDER)
  //
  // Mặc định là 'all' chứ không còn 'open': mục này giờ mang tên "Thông báo" và
  // lời hứa của nó là giữ đủ lịch sử — mở ra mà thấy trống trơn (đúng lúc hệ
  // thống đang bình thường, tức phần lớn thời gian) thì trông như mất dữ liệu.
  // Câu hỏi "ngay lúc này còn gì đang sai" vẫn trả lời được bằng một cú bấm, và
  // trạng thái trạm ở đầu trang Giám sát đã nói sẵn điều đó.
  const [alertFilter, setAlertFilter] = useState('all');
  // Cửa sổ thời gian của khung thống kê (ALERT_STAT_RANGES). Độc lập hoàn toàn
  // với `alertFilter`: khung thống kê luôn nói về CẢ hai mức để so sánh được
  // tỉ lệ giữa chúng, nên lọc danh sách xuống một mức không được phép làm biểu
  // đồ mất đi thanh còn lại — đó chính là con số dùng để đối chiếu.
  //
  // Mặc định 'week': cửa sổ 24 giờ của một hệ thống chạy ổn định thường rỗng,
  // mà một khung thống kê mở ra toàn số 0 thì không ai bấm tiếp để tìm hiểu.
  const [alertStatRange, setAlertStatRange] = useState('week');

  const [profile, setProfile] = useState(null);
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [profileSaving, setProfileSaving] = useState(false);

  const avatarInputRef = useRef(null);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarError, setAvatarError] = useState('');

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    supabase
      .from('profiles')
      .select('full_name, phone')
      .eq('id', user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        setProfile(data);
        setFullName(data?.full_name ?? '');
        setPhone(data?.phone ?? '');
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  async function saveProfile() {
    setProfileSaving(true);
    await supabase.from('profiles').update({ full_name: fullName, phone }).eq('id', user.id);
    // Đồng bộ tên sang user_metadata. Bắt buộc, không phải cho gọn: sidebar
    // (components/AppShell.jsx) chỉ có object `user` trong tay và đọc tên từ
    // đó — thiếu dòng này thì đổi tên xong sidebar vẫn hiện tên Google gắn vào
    // lúc đăng nhập cho tới khi đăng nhập lại. Cùng lý do đã đặt ảnh đại diện
    // vào user_metadata (xem handleAvatarFile bên dưới).
    //
    // `data` được GoTrue GỘP vào user_metadata chứ không ghi đè cả object, nên
    // custom_avatar_url và các khoá khác vẫn nguyên. updateUser phát
    // USER_UPDATED → AuthContext nạp lại session → tên mới hiện ngay mọi nơi.
    await supabase.auth.updateUser({ data: { full_name: fullName } });
    setProfileSaving(false);
  }

  // --- Đổi ảnh đại diện ---
  //
  // Ảnh lên bucket public `avatars` theo đường dẫn `<user_id>/<timestamp>.<ext>`
  // (xem migration 0016): segment đầu là uuid để RLS của storage.objects chặn
  // được người khác ghi vào thư mục của mình, còn timestamp để mỗi lần đổi ảnh
  // là một URL mới — ghi đè cùng một tên file sẽ vướng cache CDN và người dùng
  // vẫn thấy ảnh cũ.
  //
  // URL cuối cùng lưu vào `user_metadata.custom_avatar_url` chứ không phải
  // `avatar_url`: Google ghi đè `avatar_url` mỗi lần đăng nhập lại. Chỉ lưu ở
  // user_metadata, KHÔNG thêm cột vào bảng profiles — sidebar chỉ có object
  // `user` trong tay (không truy vấn profiles), và auth.updateUser phát sự kiện
  // USER_UPDATED nên AuthContext nạp lại session, mọi nơi hiện ảnh mới ngay.
  async function handleAvatarFile(e) {
    const file = e.target.files?.[0];
    // Cho phép chọn lại đúng file vừa chọn (input không phát change nếu value
    // không đổi) — reset ngay, không đợi tới cuối hàm vì có nhánh return sớm.
    e.target.value = '';
    if (!file) return;

    setAvatarError('');
    if (!AVATAR_MIME_TYPES.includes(file.type)) {
      setAvatarError('Chỉ hỗ trợ ảnh PNG, JPG, WEBP hoặc GIF.');
      return;
    }
    if (file.size > AVATAR_MAX_BYTES) {
      setAvatarError(`Ảnh tối đa ${Math.round(AVATAR_MAX_BYTES / 1024 / 1024)}MB — ảnh bạn chọn nặng ${(file.size / 1024 / 1024).toFixed(1)}MB.`);
      return;
    }

    setAvatarUploading(true);
    const ext = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
    const path = `${user.id}/${Date.now()}.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from('avatars')
      .upload(path, file, { contentType: file.type, upsert: false });
    if (uploadError) {
      setAvatarUploading(false);
      setAvatarError(avatarErrorText(uploadError));
      return;
    }

    const { data: publicData } = supabase.storage.from('avatars').getPublicUrl(path);
    const publicUrl = publicData.publicUrl;

    const { error: metaError } = await supabase.auth.updateUser({ data: { custom_avatar_url: publicUrl } });
    if (metaError) {
      // Dọn object vừa tải lên để không thành mồ côi khi không ai trỏ tới nó.
      await supabase.storage.from('avatars').remove([path]);
      setAvatarUploading(false);
      setAvatarError(avatarErrorText(metaError));
      return;
    }

    // Xoá ảnh cũ (nếu ảnh cũ cũng là ảnh tự tải lên) — mỗi lần đổi sinh một
    // object mới nên không dọn thì dung lượng bucket phình theo số lần đổi.
    // `user` ở đây là snapshot của lần render này, chưa dính updateUser ở trên,
    // nên vẫn đang giữ URL cũ — đúng thứ cần xoá.
    const previousPath = ownAvatarStoragePath(user.user_metadata?.custom_avatar_url, user.id);
    if (previousPath && previousPath !== path) {
      await supabase.storage.from('avatars').remove([previousPath]);
    }

    setAvatarUploading(false);
  }

  async function handleSignOut() {
    await signOut();
    navigate('/login');
  }

  async function handleCreateStation(e) {
    e.preventDefault();
    if (!newStationName.trim() || !newStationLocation.trim()) return;
    setStationFormSaving(true);
    setStationFormError('');
    const { error } = await createStation({ name: newStationName.trim(), location: newStationLocation.trim() });
    setStationFormSaving(false);
    if (error) {
      setStationFormError('Không thể tạo trạm, vui lòng thử lại.');
      return;
    }
    setNewStationName('');
    setNewStationLocation('');
  }

  async function handleDeleteStation(id) {
    if (confirmDeleteStationId !== id) {
      setConfirmDeleteStationId(id);
      return;
    }
    setConfirmDeleteStationId(null);
    await deleteStation(id);
  }

  async function handleSaveStationInfo(e) {
    e.preventDefault();
    const name = stationNameRef.current?.value.trim();
    const location = stationLocationRef.current?.value.trim();
    const timezone = stationTimezoneRef.current?.value;
    setStationInfoSuccess('');
    if (!name || !location) {
      setStationInfoError('Tên trạm và địa điểm không được để trống.');
      return;
    }
    setStationInfoSaving(true);
    setStationInfoError('');
    const { error } = await updateStation(station.id, { name, location, timezone });
    setStationInfoSaving(false);
    if (error) {
      setStationInfoError('Không thể lưu thay đổi, vui lòng thử lại.');
      return;
    }
    setStationInfoSuccess('Đã lưu thông tin trạm.');
  }

  // Ô để TRỐNG = tắt kiểm tra đó (lưu null), khác với số 0 vốn là một ngưỡng
  // hợp lệ. Vì vậy phải phân biệt chuỗi rỗng với '0' trước khi parse, chứ
  // không dùng `parseFloat(v) || null` — biểu thức đó biến 0 thành null.
  function readThreshold(ref) {
    const raw = ref.current?.value?.trim() ?? '';
    if (raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined; // undefined = nhập sai
  }

  async function handleSaveThresholds(e) {
    e.preventDefault();
    setThresholdSuccess('');
    const minVoltage = readThreshold(minVoltageRef);
    const maxTempC = readThreshold(maxTempRef);
    // Ô nhập theo W (đơn vị hiển thị của mọi công suất trên giao diện) nhưng
    // ngưỡng vẫn được LƯU bằng kW: khoá `maxLoadKw` này là thứ hàm SQL
    // evaluate_station_alerts (0023) đọc, đổi đơn vị ở đây sẽ làm mọi ngưỡng
    // người dùng đã lưu lệch đi 1000 lần. Chỉ quy đổi ở biên vào/ra.
    const maxLoadW = readThreshold(maxLoadRef);

    if ([minVoltage, maxTempC, maxLoadW].includes(undefined)) {
      setThresholdError('Ngưỡng phải là một số, hoặc để trống để tắt kiểm tra.');
      return;
    }
    if ([minVoltage, maxTempC, maxLoadW].some((v) => v != null && v < 0)) {
      setThresholdError('Ngưỡng không thể là số âm.');
      return;
    }

    setThresholdSaving(true);
    setThresholdError('');
    await settings.updateAlertThresholds({
      minVoltage,
      maxTempC,
      maxLoadKw: maxLoadW == null ? null : maxLoadW / 1000,
    });
    setThresholdSaving(false);
    setThresholdSuccess('Đã lưu ngưỡng cảnh báo cho trạm này.');
  }

  if (stationLoading || !station || settings.loading || !profile) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'oklch(97% 0.005 240)', color: 'oklch(52% 0.02 240)', fontFamily: "'Manrope',sans-serif" }}>
        Đang tải…
      </div>
    );
  }

  // `on` ưu tiên trạng thái ESP32 thực sự xác nhận (reportedState); khi chưa
  // có xác nhận nào (thiết bị chưa từng ack, hoặc tải chưa gắn thiết bị) thì
  // hiển thị tạm theo desiredState (ý muốn gần nhất của người dùng).
  const loads = stationLoads.map((l) => ({ ...l, on: l.reportedState ?? l.desiredState }));
  const notifPrefs = NOTIF_DEFS.map((n) => ({ ...n, on: settings.notifPrefs[n.id] ?? true }));
  const moduleOn = (id) => settings.moduleVisibility[id] ?? true;
  const stationDevices = devices.filter((d) => d.station_id === station.id);
  const stationEsp32Devices = stationDevices.filter((d) => d.type === 'esp32');

  function navigateTo(id) {
    setNotifOpen(false);
    if (STANDALONE_VIEWS.includes(id)) {
      setActiveNav(id);
      setCurrentView(id);
      window.scrollTo({ top: 0 });
      return;
    }
    if (id === 'reports') {
      navigate('/reports');
      return;
    }
    if (id === 'battery') {
      navigate('/battery');
      return;
    }
    setActiveNav(id);
    setCurrentView('dashboard');
    requestAnimationFrame(() => {
      const el = document.getElementById('sec-' + id);
      if (el) {
        const top = el.getBoundingClientRect().top + window.scrollY - 20;
        window.scrollTo({ top, behavior: 'smooth' });
      }
    });
  }

  async function toggleLoad(load) {
    setLoadCommandError('');
    const { error } = await setLoadState(load.id, !load.on);
    if (error) {
      setLoadCommandError(
        load.deviceId
          ? `Không gửi được lệnh tới ${load.name}, kiểm tra kết nối thiết bị.`
          : `${load.name} chưa gắn thiết bị điều khiển — chọn một ESP32 ở ô ngay cạnh công tắc.`,
      );
    }
  }

  // Gán/đổi/gỡ thiết bị điều khiển của một tải đã tạo.
  //
  // Không hỏi xác nhận, nhưng có cảnh báo tĩnh dưới danh sách: đổi thiết bị
  // KHÔNG tự tắt relay trên thiết bị cũ (nó có thể đã bị xoá hoặc đang mất
  // mạng), nên relay cũ giữ nguyên trạng thái vật lý cho tới khi có người tắt.
  //
  // Trạng thái cũ (đang bật/tắt) bị database xoá theo — xem migration 0031.
  async function handleAssignDevice(load, deviceId) {
    if ((deviceId || null) === (load.deviceId ?? null)) return;
    setLoadDeviceError('');
    setLoadCommandError('');
    setLoadDeviceSavingId(load.id);
    const { error } = await setLoadDevice(load.id, deviceId);
    setLoadDeviceSavingId(null);
    if (error) {
      setLoadDeviceError(`Không đổi được thiết bị điều khiển cho ${load.name}, vui lòng thử lại.`);
    }
  }

  async function handleAddLoad(e) {
    e.preventDefault();
    if (!newLoadName.trim()) return;
    setLoadFormSaving(true);
    setLoadFormError('');
    const { error } = await addLoad({
      name: newLoadName.trim(),
      watt: parseFloat(newLoadWatt) || 0,
      deviceId: newLoadDeviceId || null,
    });
    setLoadFormSaving(false);
    if (error) {
      setLoadFormError('Không thể thêm tải, vui lòng thử lại.');
      return;
    }
    setNewLoadName('');
    setNewLoadWatt('');
    setNewLoadDeviceId('');
    setLoadFormOpen(false);
  }

  async function handleRemoveLoad(id) {
    await removeLoad(id);
  }
  function toggleNotifPref(id) {
    settings.toggleNotifPref(id);
  }

  // Đăng ký/huỷ đăng ký trình duyệt trước, ghi công tắc tổng sau — và chỉ ghi
  // khi bước trước thực sự thành công. Ghi trước rồi mới xin quyền thì lần
  // người dùng bấm "Chặn" sẽ để lại `notif_prefs.push = true` cho một tài khoản
  // không có thiết bị nào nhận được.
  async function enablePush() {
    const res = await push.enable();
    if (res?.ok) await settings.setNotifPref('push', true);
  }

  async function disablePush() {
    const res = await push.disable();
    // Chỉ tắt công tắc tổng khi không còn thiết bị nào của tài khoản đăng ký.
    if (res?.ok && res.remaining === 0) await settings.setNotifPref('push', false);
  }

  // --- Telemetry thật cho các ô thông số ---
  // Giá trị lấy trực tiếp từ bản tin gần nhất; khi chưa có → null → hiển thị "--".
  const solarKw = latest?.solarKw;
  const batteryPct = latest?.batteryPct;
  const batteryVoltage = latest?.batteryVoltage;
  const tempC = latest?.tempC;
  const hasT = !!latest;
  const latestMs = latest ? new Date(latest.ts).getTime() : null;
  const isStale = latestMs != null && now - latestMs > STALE_MS;
  const updatedLabel = latest ? fmtClock(latest.ts, station.timezone) : null;

  // Dòng phụ của ô "Công suất mặt trời". Trước đây là chuỗi cố định "↑ 12% so
  // với giờ trước" — một con số không tính từ đâu cả. Thay bằng sản lượng thực
  // của hôm nay: RPC chỉ trả về hàng cho ngày CÓ dữ liệu, nên mảng rỗng nghĩa
  // là hôm nay chưa đo được gì (kể cả khi bản tin gần nhất là của hôm qua).
  const solarTodayKwh = todayEnergyRows[0]?.solarKwh ?? null;
  const solarTodayEnergy = fmtEnergy(solarTodayKwh, energyUnit);
  const solarTodayLabel = solarTodayKwh == null
    ? (hasT ? 'Chưa có sản lượng hôm nay' : 'Chưa có dữ liệu')
    : `Sản lượng hôm nay ${solarTodayEnergy.value} ${solarTodayEnergy.unit}`;

  const W = 640, H = 220, PAD_TOP = 14, PAD_BOTTOM = 28;

  // Zoom bằng lăn chuột: zoomCount là số điểm gần nhất còn hiển thị (null =
  // hiện hết). Kẹp trong [MIN_ZOOM_POINTS, chartReadings.length] mỗi lần render
  // vì chuỗi co giãn theo thời gian (dữ liệu mới append qua realtime).
  const zoomedReadingCount = zoomCount == null ? chartReadings.length : Math.min(zoomCount, chartReadings.length);
  const visibleReadings = chartReadings.slice(-zoomedReadingCount);
  const isZoomed = zoomedReadingCount < chartReadings.length;

  // Biểu đồ dựng từ chuỗi telemetry thật (cũ → mới). Cần >= 2 điểm để vẽ.
  const chartLabels = visibleReadings.map((r) => fmtClock(r.ts, station.timezone));
  const hasChart = visibleReadings.length >= 2;
  const fallbackVoltage = station?.batteryVoltage || 0;

  // Mỗi chuỗi được chuẩn hoá độc lập theo min/max của chính nó (4 đại lượng
  // khác đơn vị, dùng chung một trục Y là vô nghĩa) — vì vậy trục Y không có
  // nhãn, giá trị thật đọc ở hàng số phía trên biểu đồ.
  const chartSeries = CHART_SERIES.map((s) => {
    const values = visibleReadings.map((r) => s.value(r, fallbackVoltage));
    const available = values.some((v) => v != null);
    return {
      ...s,
      values,
      available,
      on: !!chartSeriesOn[s.id] && available,
      path: hasChart && chartSeriesOn[s.id] && available ? buildSeriesPath(values, W, H, PAD_TOP, PAD_BOTTOM) : null,
    };
  });
  const activeSeries = chartSeries.filter((s) => s.path);

  const lastIdx = Math.max(0, chartLabels.length - 1);
  const xStep = chartLabels.length > 1 ? W / (chartLabels.length - 1) : W;
  // Chỉ vẽ tối đa MAX_TICKS nhãn trên trục — vẽ hết mỗi điểm (vd 29 điểm/10s)
  // làm chữ chồng lên nhau không đọc được.
  const MAX_TICKS = 6;
  const tickIndices = lastIdx < MAX_TICKS
    ? chartLabels.map((_, i) => i)
    : [...new Set(Array.from({ length: MAX_TICKS }, (_, k) => Math.round((k * lastIdx) / (MAX_TICKS - 1))))];
  const axisXTicks = tickIndices.map((i) => ({
    label: chartLabels[i],
    leftPct: lastIdx > 0 ? (i / lastIdx) * 100 : 50,
  }));

  const hoverActive = hasChart && activeSeries.length > 0 && hoverIdx != null && hoverIdx <= lastIdx;
  const activeIdx = hoverActive ? hoverIdx : lastIdx;
  // Vạch dọc bám theo trục X nên lấy toạ độ từ chuỗi bật đầu tiên là đủ; điểm
  // tại vị trí đó có thể null (mất dữ liệu) → lùi về x tính theo chỉ số.
  const hoverX = hoverActive ? (activeSeries[0].path.points[hoverIdx]?.x ?? hoverIdx * xStep) : 0;

  function onChartMouseMove(e) {
    const svg = e.currentTarget.ownerSVGElement;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const scaleX = W / rect.width;
    const localX = (e.clientX - rect.left) * scaleX;
    let idx = Math.round(localX / xStep);
    idx = Math.max(0, Math.min(lastIdx, idx));
    if (idx !== hoverIdx) setHoverIdx(idx);
  }
  function onChartMouseLeave() {
    setHoverIdx(null);
  }

  function resetZoom() {
    setZoomCount(null);
  }

  function toggleChartSeries(id) {
    setChartSeriesOn((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  // Xuất toàn bộ lịch sử telemetry đang nạp trong khung thời gian — không phụ
  // thuộc zoom hay các chuỗi đang bật/tắt, vì file dùng để lưu trữ và phân tích
  // ngoài, cắt bớt theo trạng thái xem trên màn hình sẽ gây hiểu nhầm.
  function onExportTelemetryCsv() {
    setChartExportError('');
    if (chartReadings.length === 0) {
      setChartExportError('Chưa có dữ liệu telemetry trong khung thời gian này để xuất.');
      return;
    }
    const windowLabel = (CHART_WINDOWS.find((w) => w.id === chartWindowId) ?? CHART_WINDOWS[1]).label;
    const rows = [
      ['Lịch sử telemetry'],
      ['Trạm', station.name],
      ['Vị trí', station.location],
      ['Khung thời gian', windowLabel],
      ['Số bản ghi', chartReadings.length],
      ['Xuất lúc', new Date().toLocaleString('vi-VN', { timeZone: station.timezone })],
    ];
    if (chartTruncated) rows.push(['Ghi chú', 'Đã chạm giới hạn số dòng — file chỉ chứa phần mới nhất của khung.']);
    rows.push(
      [],
      ['Thời điểm', 'Công suất PV (W)', 'Tải tiêu thụ (W)', 'Điện áp pin (V)', 'Dòng điện (A)', 'Dung lượng pin (%)', 'Nhiệt độ pin (°C)', 'RSSI (dBm)'],
      ...chartReadings.map((r) => [
        new Date(r.ts).toLocaleString('vi-VN', { timeZone: station.timezone }),
        r.solarKw == null ? '' : Math.round(r.solarKw * 1000),
        r.loadW ?? '',
        r.batteryVoltage ?? '',
        CHART_SERIES.find((s) => s.id === 'current').value(r, fallbackVoltage) ?? '',
        r.batteryPct ?? '',
        r.tempC ?? '',
        r.rssi ?? '',
      ]),
    );
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    downloadCsv(`telemetry-${slugify(station.name)}-${stamp}.csv`, toCsv(rows));
  }


  const activeLoadCount = loads.filter((l) => l.on).length;
  // Tổng công suất KHAI BÁO của các tải đang bật — thuộc về màn hình "Điều
  // khiển tải" (nó tóm tắt đúng những công tắc ngay bên dưới nó).
  const switchedLoadW = loads.filter((l) => l.on).reduce((a, l) => a + l.watt, 0);
  const switchedLoadPower = fmtWatt(switchedLoadW);

  // Tải tiêu thụ của TRẠM là số đo thiết bị gửi lên (`telemetry.load_w`) — cùng
  // đại lượng mà trang Pin lưu trữ, chuỗi "Dòng điện" của biểu đồ và bộ đếm chu
  // kỳ sạc (migration 0020) đang dùng, nên các trang không nói lệch nhau. Tổng
  // công suất công tắc KHÔNG thay thế được: nó bỏ sót mọi tải không đi qua relay
  // và bằng 0 khi người dùng chưa khai tải nào, khiến ô này hiện 0 W dù thiết
  // bị đang báo về hàng trăm W. Chỉ dùng nó khi chưa có số đo nào.
  const measuredLoadW = hasT && latest.loadW != null ? Number(latest.loadW) : null;
  const siteLoadW = measuredLoadW ?? switchedLoadW;
  const siteLoadPower = fmtWatt(siteLoadW);
  const solarPower = fmtPower(solarKw);

  const solarW = (solarKw ?? 0) * 1000;
  const netBusW = solarW - siteLoadW;
  const busVoltage = batteryVoltage || station.batteryVoltage || 1;
  // Mất kết nối KHÔNG xoá số đo. Mọi ô khác (mặt trời, tải, pin, điện áp, dòng
  // pin) vẫn hiện bản tin CUỐI CÙNG kèm nhãn cam "Cập nhật lúc ...", nên hai
  // giá trị suy ra từ chính bản tin đó cũng phải vậy — trước đây chúng về "--"
  // và "Không rõ" khiến cùng một màn hình vừa nói "đo lúc 18:08" vừa nói không
  // có số. Trạng thái kết nối đã có ô "Trạng thái hệ thống" và nhãn cam nói hộ;
  // ở đây chỉ còn "chưa từng nhận được bản tin nào" (!hasT) là thật sự không rõ.
  const dcBusCurrent = !hasT ? null : netBusW / busVoltage;
  let batteryFlowState = 'idle';
  if (!hasT) batteryFlowState = 'unknown';
  else if ((batteryPct ?? 0) >= 99) batteryFlowState = 'full';
  else if (dcBusCurrent > 0.3) batteryFlowState = 'charging';
  else if (dcBusCurrent < -0.3) batteryFlowState = 'discharging';
  const flowMeta = BATTERY_FLOW_META[batteryFlowState];

  // Sơ đồ "Dòng năng lượng": mỗi đoạn nối chỉ chạy chấm khi có dòng thật, và
  // hiện dấu ✕ khi thiết bị đã báo ngắt tường minh (chargeEnabled/dischargeEnabled
  // === false — mục 8 docs/IOT.md). null/undefined = trạm chưa có firmware báo
  // trạng thái này → không khẳng định ngắt, chỉ dựa vào công suất đo được.
  const chargeBlocked = station.chargeEnabled === false;
  const dischargeBlocked = station.dischargeEnabled === false;
  // Khác với các CON SỐ ở trên, chấm chạy là một khẳng định "dòng đang chảy
  // NGAY BÂY GIỜ" — số đo cũ không đủ để nói điều đó. Nên số thì giữ lại, hoạt
  // ảnh thì dừng ngay khi dữ liệu quá hạn (nhãn cam xuất hiện), không đợi tới
  // lúc database đánh trạm là offline.
  const flowLive = hasT && !isStale && station.status !== 'offline';
  // 50 W là ngưỡng nhiễu của cảm biến, không phải ngưỡng hiển thị (giữ nguyên
  // giá trị cũ 0.05 kW, chỉ viết lại theo đơn vị đang dùng).
  const solarFlowing = flowLive && !chargeBlocked && solarW > 50;
  // So theo đúng con số đang hiện trên thẻ (W, đã làm tròn) để hoạt ảnh và giá
  // trị không nói ngược nhau: hiện "0 W" mà chấm vẫn chạy thì khó hiểu.
  const loadFlowing = flowLive && !dischargeBlocked && Math.round(siteLoadW) > 0;
  const statusLabelText = station.status === 'online' ? 'Ổn định' : station.status === 'warning' ? 'Cảnh báo' : 'Mất kết nối';
  const statusFontSize = statusLabelText.length > 9 ? '22px' : statusLabelText.length > 7 ? '26px' : '30px';

  // Cảnh báo đến từ bảng `alerts` (0023): database mở/đóng từng đợt dựa trên
  // số đo thật so với ngưỡng của trạm, thay vì suy ra ở client từ mỗi
  // `station.status`. Ở đây chỉ còn phần trình bày.
  //
  // Gắn thêm tên trạm vì danh sách gộp cảnh báo của MỌI trạm — một dòng không
  // nói rõ sự cố ở đâu thì người có nhiều trạm không dùng được. Trạm đã bị xoá
  // không còn trong `stations` nhưng cảnh báo của nó cũng đã bị FK cascade dọn,
  // nên nhánh đó chỉ là lưới an toàn cho khoảnh khắc giữa hai lượt tải.
  const stationNameById = new Map(stations.map((s) => [s.id, s.name]));
  // `stationName` là thứ alertNotifEvents cần để dựng câu hồi phục ("Trạm 01:
  // đã kết nối lại") — cột `message` trong DB chỉ có sẵn câu lúc MỞ đợt.
  const alerts = allAlerts.map((a) => ({
    ...a,
    stationName: stationNameById.get(a.stationId) ?? 'Trạm đã xoá',
  }));
  // Ngưỡng SOC đang có hiệu lực — cùng giá trị mà evaluate_station_alerts đọc
  // để mở cảnh báo pin yếu (0023), nên thẻ "Ngưỡng cảnh báo" nói đúng con số
  // đang chạy thay vì một hằng số riêng.
  const activeMinSoc = settings.batteryModes?.[settings.activeBatteryMode]?.minSoc ?? null;
  const openAlerts = alerts.filter((a) => a.resolvedAt == null);
  const unreadAlerts = alerts.filter((a) => !a.readAt);
  // Chuông hiển thị SỰ KIỆN, không phải đợt (xem alertNotifEvents): một đợt đã
  // khắc phục sinh thêm một mục "đã kết nối lại" màu xanh, để tin hệ thống trở
  // lại bình thường cũng được báo chứ không chỉ có tin xấu. Badge số chưa đọc
  // vẫn đếm theo ĐỢT — mục hồi phục không phải một việc mới cần người dùng để
  // mắt tới, nên nó không được phép làm con số đó nhảy lên.
  const latestUnread = alertNotifEvents(unreadAlerts).slice(0, 5).map((e) => ({
    key: e.key,
    id: e.id,
    severity: e.severity,
    msg: e.message,
    time: e.resolved
      ? `${fmtRelative(e.at)} · ${e.durationLabel} ${fmtDuration(e.durationMs)}`
      : `${fmtRelative(e.at)} · ${e.ongoing ? 'đang diễn ra' : 'đã kết thúc'}`,
  }));
  // Trang Thông báo dựng danh sách từ CÙNG hàm bung sự kiện với chuông. Trước
  // đây tab lịch sử liệt kê thẳng từng ĐỢT, nên mục "đã kết nối lại" chỉ tồn
  // tại đúng lúc đợt còn chưa đọc trên chuông: bấm "đánh dấu đã đọc" là nó
  // biến mất hẳn khỏi giao diện, mở lại lịch sử chỉ còn toàn tin mất kết nối
  // dù hệ thống đã hồi phục xong từ lâu. Tab "Đang diễn ra" không đổi hình
  // dạng — đợt còn mở chỉ sinh đúng một sự kiện.
  const alertHistoryEvents = alertNotifEvents(alerts);
  const openAlertEvents = alertNotifEvents(openAlerts);
  // Đếm theo phân loại trên CẢ lịch sử, không chỉ phần đang diễn ra: con số
  // trên ô lọc phải khớp đúng số dòng bấm vào sẽ thấy. Lọc theo `baseSeverity`
  // (mức của đợt gốc) nên mục hồi phục đi cùng mục mở của nó — xem
  // alertNotifEvents.
  const alertClassCounts = Object.fromEntries(
    ALERT_CLASS_ORDER.map((sev) => [sev, alertHistoryEvents.filter((e) => e.baseSeverity === sev).length]),
  );
  const visibleAlertEvents =
    alertFilter === 'open' ? openAlertEvents
      : alertFilter === 'all' ? alertHistoryEvents
        : alertHistoryEvents.filter((e) => e.baseSeverity === alertFilter);
  // Số đếm cho hàng nút lọc, tra theo id để hàng nút dựng được bằng một vòng
  // map duy nhất trên ALERT_FILTER_ORDER.
  const alertFilterCounts = { all: alertHistoryEvents.length, open: openAlertEvents.length, ...alertClassCounts };

  // Khung thống kê: đếm theo ĐỢT (mảng `alerts`), không theo sự kiện đã bung —
  // xem alertSeverityCounts. `statRange` luôn tìm thấy vì `alertStatRange` chỉ
  // đổi qua chính hàng nút dựng từ mảng này.
  const statRange = ALERT_STAT_RANGES.find((r) => r.id === alertStatRange) ?? ALERT_STAT_RANGES[0];
  const alertStats = alertSeverityCounts(alerts, statRange.ms);
  // Thang chung cho hai thanh, lấy theo giá trị lớn nhất đang hiện chứ không
  // theo tổng: hai mức cần so được với NHAU, mà chia theo tổng thì cặp 27/0 vẽ
  // ra một thanh đầy và một thanh vô hình, còn cặp 14/13 thì cả hai đều lửng
  // lơ nửa chừng và trông như đang thiếu mất phần còn lại.
  const alertStatMax = Math.max(1, ...ALERT_CLASS_ORDER.map((sev) => alertStats.counts[sev]));
  // Đã chạm trần tải về: mọi con số dưới đây là cận dưới, không phải tổng thật.
  const alertsTruncated = alerts.length >= ALERT_FETCH_LIMIT;

  const batteryDashOffset = (364.4 * (1 - (batteryPct ?? 0) / 100)).toFixed(1);

  const cardStyle = { background: 'white', border: '1px solid oklch(91% 0.01 240)', borderRadius: '14px', padding: '20px', boxShadow: '0 1px 2px oklch(0% 0 0 / 0.04)' };
  const sectionCardStyle = { background: 'white', border: '1px solid oklch(91% 0.01 240)', borderRadius: '16px', padding: '24px', boxShadow: '0 1px 2px oklch(0% 0 0 / 0.04)' };

  function place(col, row) {
    return isMobile ? {} : { gridColumn: col, gridRow: row };
  }

  const isDashboardView = currentView === 'dashboard';
  const isSettingsView = currentView === 'settings';
  const isLoadView = currentView === 'load';
  const isAlertsView = currentView === 'alerts';
  const isChartView = currentView === 'chart';
  const pageTitle = isSettingsView ? 'Cài đặt' : isLoadView ? 'Điều khiển tải' : isAlertsView ? 'Thông báo' : isChartView ? 'Biểu đồ thời gian thực' : 'Giám sát hệ thống';

  return (
    <AppShell
      activeNav={activeNav}
      onNavigate={navigateTo}
      isMobile={isMobile}
      station={station}
      stationColor={stationColor}
      stationOptions={stationOptions}
      stationMenuOpen={stationMenuOpen}
      onToggleStationMenu={toggleStationMenu}
      onCloseStationMenu={closeStationMenu}
      moduleVisibility={settings.moduleVisibility}
      notifOpen={notifOpen}
      onToggleNotif={() => setNotifOpen((v) => !v)}
      onCloseNotif={() => setNotifOpen(false)}
      unreadCount={unreadAlerts.length}
      notifItems={latestUnread}
      onMarkNotifRead={(id) => { markAlertRead(id); navigateTo('alerts'); }}
      onMarkAllNotifsRead={markAllAlertsRead}
      onViewAllNotifs={() => navigateTo('alerts')}
    >
      {!isMobile && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '28px', flexWrap: 'wrap', gap: '16px' }}>
          <div>
            <h1 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '26px', fontWeight: 700, margin: '0 0 4px', color: 'oklch(20% 0.03 240)' }}>{pageTitle}</h1>
            {isDashboardView && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13.5px', color: 'oklch(50% 0.02 240)', flexWrap: 'wrap' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: '8px', whiteSpace: 'nowrap' }}><span style={{ width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0, background: stationColor }} />{statusLabelText}</span>
                {/* Mốc thời gian THẬT của bản tin gần nhất (trước đây là một
                    chuỗi cứng còn sót lại từ bản dựng giao diện — một dashboard
                    giám sát ghi sẵn "cập nhật lúc" bịa ra thì tệ hơn hẳn là
                    không ghi gì). Dùng chung `updatedLabel` với ghi chú "cũ"
                    trong từng ô, nên hai chỗ không thể nói khác nhau. */}
                <span style={{ whiteSpace: 'nowrap' }}>· {updatedLabel ? `Cập nhật lúc ${updatedLabel}` : 'Chưa có dữ liệu'}</span>
              </div>
            )}
            {isSettingsView && (
              <div style={{ fontSize: '13.5px', color: 'oklch(50% 0.02 240)' }}>Quản lý tài khoản và cấu hình hệ thống</div>
            )}
            {isLoadView && (
              <div style={{ fontSize: '13.5px', color: 'oklch(50% 0.02 240)' }}>Bật/tắt và giám sát các thiết bị tiêu thụ điện</div>
            )}
            {isAlertsView && (
              <div style={{ fontSize: '13.5px', color: 'oklch(50% 0.02 240)' }}>Lịch sử toàn bộ thông báo hệ thống đã gửi tới bạn</div>
            )}
            {isChartView && (
              <div style={{ fontSize: '13.5px', color: 'oklch(50% 0.02 240)' }}>Diễn biến các thông số theo thời gian · {station.name}</div>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
            <div style={{ position: 'relative' }}>
              <button onClick={() => setNotifOpen((v) => !v)} title="Thông báo" aria-label="Thông báo" style={{ position: 'relative', width: '38px', height: '38px', borderRadius: '10px', background: notifOpen ? 'oklch(96% 0.01 240)' : 'white', border: '1px solid oklch(90% 0.01 240)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0 }}>
                <svg width="18" height="18" viewBox="0 0 24 24"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z" fill="oklch(30% 0.03 240)" /></svg>
                {unreadAlerts.length > 0 && (
                  <span style={{ position: 'absolute', top: '-4px', right: '-4px', fontSize: '10px', fontWeight: 700, color: 'white', background: 'oklch(58% 0.19 25)', borderRadius: '8px', padding: '1px 5px', minWidth: '14px', textAlign: 'center' }}>{unreadAlerts.length}</span>
                )}
              </button>
              {notifOpen && (
                <>
                  <div onClick={() => setNotifOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
                  <div style={{ position: 'absolute', top: 'calc(100% + 8px)', right: 0, width: '340px', background: 'white', border: '1px solid oklch(90% 0.01 240)', borderRadius: '14px', boxShadow: '0 12px 32px oklch(0% 0 0 / 0.12)', zIndex: 41, overflow: 'hidden' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: '1px solid oklch(94% 0.008 240)' }}>
                      <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '14px', fontWeight: 700 }}>Thông báo mới nhất</span>
                      {unreadAlerts.length > 0 && (
                        <button onClick={markAllAlertsRead} style={{ background: 'none', border: 'none', fontSize: '12px', fontWeight: 600, color: BLUE, cursor: 'pointer', padding: 0, fontFamily: "'Manrope',sans-serif" }}>Đánh dấu đã đọc</button>
                      )}
                    </div>
                    {latestUnread.length === 0 ? (
                      <div style={{ padding: '28px 16px', textAlign: 'center', fontSize: '13px', color: 'oklch(55% 0.02 240)' }}>Không có thông báo chưa đọc</div>
                    ) : (
                      <div>
                        {latestUnread.map((item) => (
                          <button
                            key={item.key}
                            onClick={() => { markAlertRead(item.id); navigateTo('alerts'); }}
                            style={{ display: 'flex', gap: '10px', width: '100%', textAlign: 'left', padding: '13px 16px', background: 'none', border: 'none', borderBottom: '1px solid oklch(95% 0.006 240)', cursor: 'pointer', fontFamily: "'Manrope',sans-serif" }}
                          >
                            <span style={{ width: '8px', height: '8px', borderRadius: '50%', marginTop: '5px', flexShrink: 0, background: NOTIF_DOT_COLOR[item.severity] }} />
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontSize: '13px', color: 'oklch(26% 0.03 240)', lineHeight: 1.45 }}>{item.msg}</div>
                              <div style={{ fontSize: '11.5px', color: 'oklch(58% 0.02 240)', marginTop: '2px' }}>{item.time}</div>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                    <button onClick={() => navigateTo('alerts')} style={{ display: 'block', width: '100%', textAlign: 'center', padding: '12px', background: 'oklch(98% 0.004 240)', border: 'none', borderTop: '1px solid oklch(94% 0.008 240)', fontSize: '12.5px', fontWeight: 700, color: BLUE, cursor: 'pointer', fontFamily: "'Manrope',sans-serif" }}>Xem tất cả thông báo →</button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {isDashboardView && (
        <>
          {/* KPI ROW */}
          <div id="sec-overview" style={{ scrollMarginTop: '24px', display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr 1.15fr', gap: '16px', marginBottom: '20px', alignItems: 'stretch' }}>
            <div style={{ ...cardStyle, ...place(1, 1) }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
                <span style={{ fontSize: '13px', color: 'oklch(52% 0.02 240)', fontWeight: 600 }}>Công suất mặt trời</span>
                <div style={{ width: '30px', height: '30px', borderRadius: '8px', background: 'oklch(95% 0.04 70)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <svg width="15" height="15" viewBox="0 0 20 20"><circle cx="10" cy="10" r="3.6" fill="oklch(75% 0.14 70)" /><g stroke="oklch(75% 0.14 70)" strokeWidth="1.6" strokeLinecap="round"><line x1="10" y1="2" x2="10" y2="4.2" /><line x1="10" y1="15.8" x2="10" y2="18" /><line x1="2" y1="10" x2="4.2" y2="10" /><line x1="15.8" y1="10" x2="18" y2="10" /></g></svg>
                </div>
              </div>
              <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '28px', fontWeight: 500, color: 'oklch(20% 0.03 240)' }}>{solarPower.value} <span style={{ fontSize: '15px', color: 'oklch(55% 0.02 240)' }}>{solarPower.unit}</span></div>
              <div style={{ fontSize: '12.5px', marginTop: '6px', color: 'oklch(52% 0.02 240)' }}>{solarTodayLabel}</div>
              <StaleNote show={isStale} label={updatedLabel} />
            </div>

            <div style={{ ...cardStyle, ...place(2, 1) }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
                <span style={{ fontSize: '13px', color: 'oklch(52% 0.02 240)', fontWeight: 600 }}>Tải tiêu thụ</span>
                <div style={{ width: '30px', height: '30px', borderRadius: '8px', background: 'oklch(93% 0.03 240)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <svg width="15" height="15" viewBox="0 0 20 20"><circle cx="10" cy="10" r="7.5" fill="none" stroke={BLUE} strokeWidth="1.6" /><line x1="10" y1="5.2" x2="10" y2="10" stroke={BLUE} strokeWidth="1.6" strokeLinecap="round" /></svg>
                </div>
              </div>
              <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '28px', fontWeight: 500, color: 'oklch(20% 0.03 240)' }}>{siteLoadPower.value} <span style={{ fontSize: '15px', color: 'oklch(55% 0.02 240)' }}>{siteLoadPower.unit}</span></div>
              <div style={{ fontSize: '12.5px', color: 'oklch(52% 0.02 240)', marginTop: '6px' }}>
                {measuredLoadW == null ? `${activeLoadCount} thiết bị đang bật` : `Đo tại trạm · ${activeLoadCount} tải đang bật`}
              </div>
              {measuredLoadW != null && <StaleNote show={isStale} label={updatedLabel} />}
            </div>

            <div style={{ ...cardStyle, ...place(2, 2) }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
                <span style={{ fontSize: '13px', color: 'oklch(52% 0.02 240)', fontWeight: 600 }}>Dòng DC bus</span>
                <div style={{ width: '30px', height: '30px', borderRadius: '8px', background: flowMeta.bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <span style={{ fontSize: '16px', fontWeight: 700, color: flowMeta.color, lineHeight: 1 }}>{flowMeta.arrow}</span>
                </div>
              </div>
              <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '28px', fontWeight: 500, color: 'oklch(20% 0.03 240)' }}>{dcBusCurrent == null ? '--' : (dcBusCurrent >= 0 ? '+' : '') + dcBusCurrent.toFixed(1)} <span style={{ fontSize: '15px', color: 'oklch(55% 0.02 240)' }}>A</span></div>
              <div style={{ fontSize: '12.5px', color: 'oklch(52% 0.02 240)', marginTop: '6px' }}>Nút liên kết BMS-Panel</div>
              <StaleNote show={isStale} label={updatedLabel} />
            </div>

            <div style={{ ...cardStyle, ...place(1, 2) }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
                <span style={{ fontSize: '13px', color: 'oklch(52% 0.02 240)', fontWeight: 600 }}>Trạng thái hệ thống</span>
                <div style={{ width: '32px', height: '32px', borderRadius: '9px', background: statusMeta.bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <svg width="15" height="15" viewBox="0 0 20 20"><path d="M4 10l4 4 8-8" fill="none" stroke={statusMeta.textColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </div>
              </div>
              {/* Manrope chứ không phải Space Grotesk như các tiêu đề khác:
                  Space Grotesk vẽ dấu HỎI thành một nét chéo mảnh gần thẳng,
                  nằm chồng lên dấu mũ, nên "Ổn định" đọc ra thành "Ốn định".
                  Chỗ này là nơi lỗi đó hại nhất — chữ to nhất màn hình và là
                  câu trả lời cho câu hỏi "hệ thống có đang bình thường không".
                  Manrope vẽ dấu hỏi thành nét móc cong, phân biệt rõ với dấu
                  sắc. Weight 800 để giữ độ đậm tương đương Space Grotesk 700. */}
              <div style={{ fontFamily: "'Manrope',sans-serif", fontSize: statusFontSize, fontWeight: 800, letterSpacing: '-0.01em', color: statusMeta.textColor, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{statusLabelText}</div>
              <div style={{ fontSize: '12.5px', color: 'oklch(52% 0.02 240)', marginTop: '6px' }}>{station.status === 'online' ? 'Không có sự cố đang diễn ra' : station.status === 'warning' ? 'Đang theo dõi cảnh báo hiệu suất' : 'Kiểm tra kết nối thiết bị tại trạm'}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginTop: '10px', fontSize: '12.5px', fontWeight: 700, color: flowMeta.color, background: flowMeta.bg, padding: '4px 10px', borderRadius: '20px', width: 'fit-content' }}>
                <span>{flowMeta.arrow}</span>
                <span>{flowMeta.label}</span>
              </div>
            </div>

            {moduleOn('battery') && (
            <div onClick={() => navigateTo('battery')} style={{ ...cardStyle, ...place(3, '1 / span 2'), display: 'flex', flexDirection: 'column', cursor: 'pointer' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                <span style={{ fontSize: '13px', color: 'oklch(52% 0.02 240)', fontWeight: 600 }}>Pin lưu trữ</span>
                <div style={{ width: '30px', height: '30px', borderRadius: '8px', background: 'oklch(93% 0.03 240)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <svg width="15" height="15" viewBox="0 0 20 20"><rect x="2" y="6" width="14" height="8" rx="1.5" fill="none" stroke={BLUE} strokeWidth="1.6" /><rect x="17" y="8.5" width="2" height="3" fill={BLUE} /><rect x="4" y="8" width="9" height="4" fill={BLUE} /></svg>
                </div>
              </div>
              <div style={{ position: 'relative', display: 'flex', justifyContent: 'center', margin: '2px 0 10px' }}>
                <svg width="150" height="150" viewBox="0 0 150 150">
                  <circle cx="75" cy="75" r="58" fill="none" stroke="oklch(94% 0.008 240)" strokeWidth="14" />
                  <circle cx="75" cy="75" r="58" fill="none" stroke={BLUE} strokeWidth="14" strokeLinecap="round" strokeDasharray="364.4" strokeDashoffset={batteryDashOffset} transform="rotate(-90 75 75)" />
                </svg>
                <div style={{ position: 'absolute', top: 0, left: '50%', transform: 'translateX(-50%)', width: '150px', height: '150px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '4px', pointerEvents: 'none' }}>
                  <div style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '30px', fontWeight: 700, color: 'oklch(20% 0.03 240)', lineHeight: 1 }}>{hasT && batteryPct != null ? batteryPct + '%' : '--'}</div>
                  <div style={{ fontFamily: "'Manrope',sans-serif", fontSize: '12px', color: 'oklch(55% 0.02 240)' }}>{flowMeta.label}</div>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <div style={{ textAlign: 'center', padding: '10px', background: 'oklch(97% 0.005 240)', borderRadius: '10px' }}>
                  <div style={{ fontSize: '11.5px', color: 'oklch(52% 0.02 240)' }}>Điện áp</div>
                  <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '15px', fontWeight: 600 }}>{batteryVoltage == null ? '--' : batteryVoltage.toFixed(1) + 'V'}</div>
                </div>
                <div style={{ textAlign: 'center', padding: '10px', background: 'oklch(97% 0.005 240)', borderRadius: '10px' }}>
                  <div style={{ fontSize: '11.5px', color: 'oklch(52% 0.02 240)' }}>Dòng pin</div>
                  <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '15px', fontWeight: 600 }}>{station.batteryCurrent == null ? '--' : station.batteryCurrent.toFixed(1) + 'A'}</div>
                </div>
                <div style={{ textAlign: 'center', padding: '10px', background: 'oklch(97% 0.005 240)', borderRadius: '10px' }}>
                  <div style={{ fontSize: '11.5px', color: 'oklch(52% 0.02 240)' }}>Nhiệt độ</div>
                  <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '15px', fontWeight: 600 }}>{tempC == null ? '--' : Math.round(tempC) + '°C'}</div>
                </div>
                <div style={{ textAlign: 'center', padding: '10px', background: 'oklch(97% 0.005 240)', borderRadius: '10px' }}>
                  <div style={{ fontSize: '11.5px', color: 'oklch(52% 0.02 240)' }}>Chu kỳ sạc</div>
                  <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '15px', fontWeight: 600 }}>{fmtCycles(station.batteryCycles)}</div>
                </div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <StaleNote show={isStale} label={updatedLabel} />
              </div>
              <div style={{ flex: 1 }} />
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '5px', marginTop: '14px', fontSize: '12.5px', fontWeight: 700, color: BLUE }}>
                <span>Xem chi tiết</span><span>→</span>
              </div>
            </div>
            )}
          </div>

          {/* ENERGY FLOW */}
          {moduleOn('flow') && (
          <div id="sec-flow" style={{ scrollMarginTop: '24px', ...sectionCardStyle, marginBottom: '20px' }}>
            <h2 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '17px', fontWeight: 700, margin: '0 0 4px' }}>Dòng năng lượng</h2>
            <p style={{ fontSize: '13px', color: 'oklch(52% 0.02 240)', margin: '0 0 24px' }}>Mặt trời → Bộ lưu trữ/Inverter → Tải tiêu thụ</p>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: '140px', textAlign: 'center' }}>
                <div style={{ width: '64px', height: '64px', borderRadius: '16px', background: 'oklch(95% 0.04 70)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 10px' }}>
                  <svg width="30" height="30" viewBox="0 0 20 20"><circle cx="10" cy="10" r="3.6" fill="oklch(75% 0.14 70)" /><g stroke="oklch(75% 0.14 70)" strokeWidth="1.6" strokeLinecap="round"><line x1="10" y1="2" x2="10" y2="4.2" /><line x1="10" y1="15.8" x2="10" y2="18" /><line x1="2" y1="10" x2="4.2" y2="10" /><line x1="15.8" y1="10" x2="18" y2="10" /><line x1="4.6" y1="4.6" x2="6.1" y2="6.1" /><line x1="13.9" y1="13.9" x2="15.4" y2="15.4" /><line x1="4.6" y1="15.4" x2="6.1" y2="13.9" /><line x1="13.9" y1="6.1" x2="15.4" y2="4.6" /></g></svg>
                </div>
                <div style={{ fontSize: '13px', fontWeight: 700 }}>Tấm pin mặt trời</div>
                <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '15px', color: 'oklch(75% 0.14 70)', fontWeight: 600, marginTop: '2px' }}>{solarPower.value}{solarKw == null ? '' : ' ' + solarPower.unit}</div>
              </div>

              <FlowConnector flowing={solarFlowing} blocked={chargeBlocked} color="oklch(75% 0.14 70)" />

              <div style={{ flex: 1, minWidth: '140px', textAlign: 'center' }}>
                <div style={{ width: '64px', height: '64px', borderRadius: '16px', background: 'oklch(93% 0.03 240)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 10px' }}>
                  <svg width="30" height="30" viewBox="0 0 20 20"><rect x="2" y="6" width="14" height="8" rx="1.5" fill="none" stroke={BLUE} strokeWidth="1.6" /><rect x="17" y="8.5" width="2" height="3" fill={BLUE} /><rect x="4" y="8" width="9" height="4" fill={BLUE} /></svg>
                </div>
                <div style={{ fontSize: '13px', fontWeight: 700 }}>Pin lưu trữ</div>
                <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '15px', color: BLUE, fontWeight: 600, marginTop: '2px' }}>{batteryPct == null ? '--' : batteryPct + '%'}</div>
              </div>

              <FlowConnector flowing={loadFlowing} blocked={dischargeBlocked} color={BLUE} delayOffset={0.3} />

              <div style={{ flex: 1, minWidth: '140px', textAlign: 'center' }}>
                <div style={{ width: '64px', height: '64px', borderRadius: '16px', background: 'oklch(93% 0.03 240)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 10px' }}>
                  <svg width="30" height="30" viewBox="0 0 20 20"><path d="M10 3l7 3.5v4c0 4.2-2.9 7.2-7 8-4.1-.8-7-3.8-7-8v-4L10 3z" fill="none" stroke="oklch(30% 0.03 240)" strokeWidth="1.6" strokeLinejoin="round" /></svg>
                </div>
                <div style={{ fontSize: '13px', fontWeight: 700 }}>Tải tiêu thụ</div>
                <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '15px', color: 'oklch(30% 0.03 240)', fontWeight: 600, marginTop: '2px' }}>{siteLoadPower.value} {siteLoadPower.unit}</div>
              </div>
            </div>
          </div>
          )}

        </>
      )}

      {isChartView && (
        <>
          {/* TUỲ CHỌN BIỂU ĐỒ */}
          <div style={{ ...sectionCardStyle, marginBottom: '20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', marginBottom: '18px' }}>
              <h2 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '17px', fontWeight: 700, margin: 0 }}>Tuỳ chọn hiển thị</h2>
              <button
                onClick={onExportTelemetryCsv}
                style={{ padding: '9px 16px', borderRadius: '9px', border: '1px solid oklch(88% 0.01 240)', background: 'white', fontSize: '12.5px', fontWeight: 600, color: 'oklch(30% 0.03 240)', cursor: 'pointer', whiteSpace: 'nowrap', fontFamily: "'Manrope',sans-serif" }}
              >
                Xuất CSV lịch sử telemetry
              </button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '240px 1fr', gap: '22px', alignItems: 'start' }}>
              <div>
                <label htmlFor="chart-window" style={{ display: 'block', fontSize: '12.5px', fontWeight: 600, color: 'oklch(45% 0.02 240)', marginBottom: '7px' }}>
                  Độ dài khung thời gian tối đa
                </label>
                <select
                  id="chart-window"
                  value={chartWindowId}
                  onChange={(e) => { setChartWindowId(e.target.value); setZoomCount(null); setHoverIdx(null); }}
                  style={{ width: '100%', boxSizing: 'border-box', padding: '9px 11px', borderRadius: '8px', border: '1px solid oklch(88% 0.01 240)', fontSize: '13px', fontFamily: "'Manrope',sans-serif", background: 'white', color: 'oklch(24% 0.03 240)' }}
                >
                  {CHART_WINDOWS.map((w) => (
                    <option key={w.id} value={w.id}>{w.label}</option>
                  ))}
                </select>
                <p style={{ fontSize: '11.5px', color: 'oklch(55% 0.02 240)', margin: '7px 0 0', lineHeight: 1.55 }}>
                  Biểu đồ chỉ vẽ dữ liệu trong khoảng này tính tới hiện tại. Lăn chuột trên biểu đồ để phóng to vào phần gần nhất.
                </p>
              </div>

              <div>
                <span style={{ display: 'block', fontSize: '12.5px', fontWeight: 600, color: 'oklch(45% 0.02 240)', marginBottom: '7px' }}>Thông số hiển thị</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                  {chartSeries.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => toggleChartSeries(s.id)}
                      disabled={!s.available}
                      title={s.available ? undefined : 'Không có dữ liệu cho thông số này trong khung thời gian đang chọn'}
                      style={{
                        display: 'flex', alignItems: 'center', gap: '7px',
                        padding: '8px 13px', borderRadius: '20px',
                        border: '1px solid ' + (s.on ? s.color : 'oklch(88% 0.01 240)'),
                        background: s.on ? 'oklch(97% 0.01 240)' : 'white',
                        fontSize: '12.5px', fontWeight: 600, fontFamily: "'Manrope',sans-serif",
                        color: s.available ? (s.on ? s.textColor : 'oklch(52% 0.02 240)') : 'oklch(72% 0.01 240)',
                        cursor: s.available ? 'pointer' : 'not-allowed',
                      }}
                    >
                      <span style={{ width: '9px', height: '9px', borderRadius: '2px', flexShrink: 0, background: s.on ? s.color : 'oklch(88% 0.01 240)' }} />
                      {s.label} ({s.unit})
                    </button>
                  ))}
                </div>
                <p style={{ fontSize: '11.5px', color: 'oklch(55% 0.02 240)', margin: '9px 0 0', lineHeight: 1.55 }}>
                  Mỗi thông số được chuẩn hoá riêng theo giá trị nhỏ nhất/lớn nhất của nó, nên các đường chỉ so sánh được về hình dạng — giá trị thật đọc ở hàng số phía trên biểu đồ.
                </p>
              </div>
            </div>

            {chartExportError && (
              <div style={{ fontSize: '12px', color: 'oklch(52% 0.17 25)', marginTop: '14px' }}>{chartExportError}</div>
            )}
          </div>

          {/* BIỂU ĐỒ */}
          <div style={{ ...sectionCardStyle, marginBottom: '20px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '14px' }}>
              <p style={{ fontSize: '12.5px', color: 'oklch(52% 0.02 240)', margin: 0, display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
                {chartLoading ? 'Đang tải dữ liệu…' : hasChart ? (
                  <>
                    <span>
                      {isZoomed ? visibleReadings.length + '/' + chartReadings.length + ' điểm (đã zoom)' : chartReadings.length + ' điểm'} · {hoverActive ? 'tại' : 'mới nhất ·'}{' '}
                      <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontWeight: 600, color: 'oklch(30% 0.02 240)' }}>
                        {hoverActive ? fmtClockSec(visibleReadings[activeIdx]?.ts, station.timezone) : chartLabels[activeIdx]}
                      </span>
                    </span>
                    {isZoomed && (
                      <button onClick={resetZoom} style={{ font: 'inherit', fontWeight: 600, color: BLUE, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>Đặt lại zoom</button>
                    )}
                  </>
                ) : 'Chưa có dữ liệu telemetry'}
              </p>
              {hasChart && activeSeries.length > 0 && (
                <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', fontFamily: "'IBM Plex Mono',monospace", fontSize: '12.5px' }}>
                  {activeSeries.map((s) => (
                    <span key={s.id} style={{ display: 'flex', alignItems: 'center', gap: '5px', color: s.textColor, fontWeight: 600 }}>
                      <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: s.color, display: 'inline-block' }} />
                      {s.values[activeIdx] == null ? '--' : s.values[activeIdx].toFixed(s.digits)} {s.unit}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {chartTruncated && (
              <div style={{ fontSize: '11.5px', color: 'oklch(52% 0.13 70)', marginBottom: '12px' }}>
                Khung thời gian này có quá nhiều bản ghi — biểu đồ đang hiển thị phần mới nhất.
              </div>
            )}

            {hasChart && activeSeries.length > 0 ? (
              <div ref={chartWheelRef} title="Lăn chuột để phóng to/thu nhỏ" style={{ position: 'relative', width: '100%' }}>
                <svg viewBox="0 0 640 220" width="100%" height="220" preserveAspectRatio="none" style={{ display: 'block', overflow: 'visible', cursor: 'crosshair' }}>
                  <line x1="0" y1="14" x2="640" y2="14" stroke="oklch(94% 0.008 240)" strokeWidth="1" />
                  <line x1="0" y1="97" x2="640" y2="97" stroke="oklch(94% 0.008 240)" strokeWidth="1" />
                  <line x1="0" y1="180" x2="640" y2="180" stroke="oklch(94% 0.008 240)" strokeWidth="1" />

                  {activeSeries.map((s) => (
                    <path key={s.id} d={s.path.line} fill="none" stroke={s.color} strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
                  ))}

                  <g pointerEvents="none">
                    {hoverActive && (
                      <line x1={hoverX} y1="6" x2={hoverX} y2="192" stroke="oklch(55% 0.03 240)" strokeWidth="1" strokeDasharray="3,3" />
                    )}
                  </g>

                  <rect x="0" y="0" width="640" height="192" fill="transparent" onMouseMove={onChartMouseMove} onMouseLeave={onChartMouseLeave} />
                </svg>

                {hoverActive && activeSeries.map((s) => {
                  const pt = s.path.points[activeIdx];
                  if (!pt) return null;
                  return (
                    <span
                      key={s.id}
                      style={{ position: 'absolute', left: (pt.x / 640) * 100 + '%', top: pt.y + 'px', width: '10px', height: '10px', borderRadius: '50%', background: 'white', border: '2.2px solid ' + s.color, boxSizing: 'border-box', transform: 'translate(-50%, -50%)', pointerEvents: 'none' }}
                    />
                  );
                })}

                {axisXTicks.map((tick, i) => (
                  <span key={tick.label + '-' + i} style={{ position: 'absolute', left: tick.leftPct + '%', top: '200px', transform: 'translateX(-50%)', whiteSpace: 'nowrap', fontFamily: "'IBM Plex Mono',monospace", fontSize: '11px', color: 'oklch(58% 0.02 240)', pointerEvents: 'none' }}>{tick.label}</span>
                ))}
              </div>
            ) : (
              <div style={{ height: '220px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '6px', color: 'oklch(58% 0.02 240)', background: 'oklch(98% 0.004 240)', borderRadius: '12px', border: '1px dashed oklch(88% 0.01 240)' }}>
                <div style={{ fontSize: '14px', fontWeight: 600 }}>
                  {chartLoading ? 'Đang tải dữ liệu…' : activeSeries.length === 0 && hasChart ? 'Chưa chọn thông số nào để hiển thị' : 'Chưa có dữ liệu telemetry để vẽ biểu đồ'}
                </div>
                <div style={{ fontSize: '12px' }}>
                  {activeSeries.length === 0 && hasChart
                    ? 'Bật ít nhất một thông số ở phần "Thông số hiển thị" phía trên.'
                    : 'Thử chọn khung thời gian dài hơn, hoặc chờ thiết bị gửi dữ liệu về (cần tối thiểu 2 điểm).'}
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {isLoadView && (
        <div style={{ maxWidth: '760px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '16px', marginBottom: '20px' }}>
            <div style={cardStyle}>
              <div style={{ fontSize: '13px', color: 'oklch(52% 0.02 240)', fontWeight: 600, marginBottom: '10px' }}>Thiết bị đang bật</div>
              <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '28px', fontWeight: 500, color: 'oklch(20% 0.03 240)' }}>{activeLoadCount}<span style={{ fontSize: '15px', color: 'oklch(55% 0.02 240)' }}>/{loads.length}</span></div>
            </div>
            <div style={cardStyle}>
              <div style={{ fontSize: '13px', color: 'oklch(52% 0.02 240)', fontWeight: 600, marginBottom: '10px' }}>Tổng công suất tải</div>
              {/* Ở màn hình này là tổng công suất khai báo của các công tắc đang
                  bật, KHÔNG phải số đo của trạm — nó tóm tắt đúng danh sách tải
                  ngay bên dưới. Số đo thật nằm ở thẻ "Tải tiêu thụ" màn Giám sát. */}
              <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '28px', fontWeight: 500, color: 'oklch(20% 0.03 240)' }}>{switchedLoadPower.value} <span style={{ fontSize: '15px', color: 'oklch(55% 0.02 240)' }}>{switchedLoadPower.unit}</span></div>
            </div>
          </div>

          <div style={sectionCardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', gap: '10px', flexWrap: 'wrap' }}>
              <h2 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '17px', fontWeight: 700, margin: 0 }}>Điều khiển tải</h2>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span style={{ fontSize: '12.5px', color: 'oklch(52% 0.02 240)' }}>{activeLoadCount}/{loads.length} đang bật</span>
                <button onClick={() => setLoadFormOpen((v) => !v)} style={{ padding: '7px 14px', borderRadius: '8px', border: '1px solid oklch(88% 0.01 240)', background: 'white', fontSize: '12.5px', fontWeight: 600, color: 'oklch(30% 0.03 240)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                  {loadFormOpen ? 'Đóng' : '+ Thêm tải'}
                </button>
              </div>
            </div>

            {loadFormOpen && (
              <form onSubmit={handleAddLoad} style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'end', background: 'oklch(97% 0.005 240)', borderRadius: '10px', padding: '14px', marginBottom: '16px' }}>
                <div style={{ flex: '1 1 160px' }}>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'oklch(45% 0.02 240)', marginBottom: '6px' }}>Tên tải</label>
                  <input type="text" value={newLoadName} onChange={(e) => setNewLoadName(e.target.value)} placeholder="Đèn chiếu sáng" style={{ width: '100%', boxSizing: 'border-box', padding: '9px 11px', borderRadius: '8px', border: '1px solid oklch(88% 0.01 240)', fontSize: '13px', fontFamily: "'Manrope',sans-serif" }} />
                </div>
                <div style={{ flex: '0 1 100px' }}>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'oklch(45% 0.02 240)', marginBottom: '6px' }}>Công suất (W)</label>
                  <input type="number" min="0" value={newLoadWatt} onChange={(e) => setNewLoadWatt(e.target.value)} placeholder="45" style={{ width: '100%', boxSizing: 'border-box', padding: '9px 11px', borderRadius: '8px', border: '1px solid oklch(88% 0.01 240)', fontSize: '13px', fontFamily: "'Manrope',sans-serif" }} />
                </div>
                <div style={{ flex: '1 1 180px' }}>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'oklch(45% 0.02 240)', marginBottom: '6px' }}>Thiết bị điều khiển (ESP32)</label>
                  <select value={newLoadDeviceId} onChange={(e) => setNewLoadDeviceId(e.target.value)} style={{ width: '100%', boxSizing: 'border-box', padding: '9px 11px', borderRadius: '8px', border: '1px solid oklch(88% 0.01 240)', fontSize: '13px', fontFamily: "'Manrope',sans-serif", background: 'white' }}>
                    <option value="">Chưa gắn (chỉ theo dõi)</option>
                    {stationEsp32Devices.map((d) => (
                      <option key={d.id} value={d.id}>{d.name}</option>
                    ))}
                  </select>
                </div>
                <button type="submit" disabled={loadFormSaving || !newLoadName.trim()} style={{ padding: '10px 18px', borderRadius: '8px', border: 'none', background: BLUE, color: 'white', fontSize: '13px', fontWeight: 700, cursor: 'pointer', opacity: loadFormSaving || !newLoadName.trim() ? 0.6 : 1, whiteSpace: 'nowrap' }}>
                  {loadFormSaving ? 'Đang thêm…' : 'Thêm tải'}
                </button>
              </form>
            )}
            {loadFormError && <div style={{ fontSize: '12px', color: 'oklch(52% 0.17 25)', marginBottom: '12px' }}>{loadFormError}</div>}
            {loadCommandError && <div style={{ fontSize: '12px', color: 'oklch(52% 0.17 25)', marginBottom: '12px' }}>{loadCommandError}</div>}
            {loadDeviceError && <div style={{ fontSize: '12px', color: 'oklch(52% 0.17 25)', marginBottom: '12px' }}>{loadDeviceError}</div>}

            {loads.length === 0 ? (
              <div style={{ padding: '18px 4px', fontSize: '13px', color: 'oklch(55% 0.02 240)' }}>Chưa có tải nào — bấm "+ Thêm tải" để thêm.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {loads.map((item) => (
                  <div key={item.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', padding: '14px 4px', borderBottom: '1px solid oklch(95% 0.006 240)', flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
                      <div style={{ width: '32px', height: '32px', borderRadius: '8px', background: item.on ? 'oklch(93% 0.03 240)' : 'oklch(95% 0.006 240)', color: item.on ? BLUE : 'oklch(65% 0.01 240)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <svg width="16" height="16" viewBox="0 0 20 20"><circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.6" /><line x1="10" y1="5.2" x2="10" y2="10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: '14px', fontWeight: 600 }}>{item.name}</div>
                        {/* Không lặp lại "chưa gắn thiết bị" ở đây nữa — ô chọn
                            thiết bị bên phải đã nói đúng điều đó và còn sửa được. */}
                        <div style={{ fontSize: '12px', color: 'oklch(52% 0.02 240)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {item.watt}W · {item.on ? 'Đang bật' : 'Đã tắt'}
                        </div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexShrink: 0 }}>
                      {/* Đường DUY NHẤT để đổi thiết bị điều khiển sau khi tải
                          đã tạo. Không có ô này thì xoá một ESP32 (khoá ngoại
                          đặt device_id về null) là mất khả năng điều khiển các
                          tải của nó vĩnh viễn — chỉ còn cách xoá tải làm lại. */}
                      <select
                        value={item.deviceId ?? ''}
                        disabled={loadDeviceSavingId === item.id}
                        onChange={(e) => handleAssignDevice(item, e.target.value)}
                        aria-label={`Thiết bị điều khiển ${item.name}`}
                        title="Thiết bị điều khiển tải này"
                        style={{ maxWidth: '170px', padding: '7px 9px', borderRadius: '8px', border: '1px solid oklch(88% 0.01 240)', fontSize: '12.5px', fontFamily: "'Manrope',sans-serif", background: 'white', color: item.deviceId ? 'oklch(30% 0.03 240)' : 'oklch(58% 0.02 240)', cursor: loadDeviceSavingId === item.id ? 'wait' : 'pointer' }}
                      >
                        <option value="">Chưa gắn (chỉ theo dõi)</option>
                        {/* Tải đã gắn một thiết bị chưa có trong danh sách:
                            useDevices còn đang tải. Không có option khớp thì
                            select hiện RỖNG, trông y như "chưa gắn" — người
                            dùng sẽ tưởng thiết bị vừa bị gỡ mất. */}
                        {item.deviceId && !stationEsp32Devices.some((d) => d.id === item.deviceId) && (
                          <option value={item.deviceId}>{devicesLoading ? 'Đang nạp thiết bị…' : 'Thiết bị đã gắn'}</option>
                        )}
                        {stationEsp32Devices.map((d) => (
                          <option key={d.id} value={d.id}>{d.name}</option>
                        ))}
                      </select>
                      <Switch on={item.on} onClick={() => toggleLoad(item)} />
                      <button onClick={() => handleRemoveLoad(item.id)} title="Xóa tải" aria-label={`Xóa ${item.name}`} style={{ background: 'none', border: 'none', color: 'oklch(58% 0.19 25)', cursor: 'pointer', padding: '4px', fontSize: '12.5px', fontWeight: 600, fontFamily: "'Manrope',sans-serif" }}>Xóa</button>
                    </div>
                  </div>
                ))}
                {/* Hai điều người dùng không đoán được từ giao diện, và cái thứ
                    hai là an toàn điện chứ không phải chi tiết kỹ thuật: đổi
                    thiết bị chỉ đổi chỗ NHẬN lệnh, relay của thiết bị cũ vẫn
                    giữ nguyên trạng thái vật lý vì không có gì đảm bảo gửi được
                    lệnh tắt tới nó (có thể vừa bị xoá hoặc đang mất mạng). */}
                <p style={{ fontSize: '12px', color: 'oklch(55% 0.02 240)', lineHeight: 1.6, margin: '14px 0 0' }}>
                  Đổi thiết bị điều khiển sẽ đặt tải về trạng thái tắt, vì thiết bị mới chưa nhận lệnh nào.
                  Thao tác này <strong style={{ fontWeight: 700 }}>không tắt hộ relay trên thiết bị cũ</strong> — hãy tắt tải trước khi đổi nếu nó đang bật.
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {isAlertsView && (
        // Khi phải xếp dọc, cột phụ đứng TRƯỚC trong DOM (order 1) dù nằm bên
        // phải lúc đủ rộng: xếp sau danh sách thì nó nằm dưới hàng chục dòng
        // thông báo và trên máy điện thoại sẽ không bao giờ được cuộn tới.
        <div style={{ display: 'flex', flexDirection: alertsSideBySide ? 'row' : 'column', gap: '20px', alignItems: 'flex-start' }}>
          <div style={{ ...sectionCardStyle, order: alertsSideBySide ? 1 : 2, flex: '1 1 auto', minWidth: 0, maxWidth: '760px', width: '100%' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', gap: '12px', flexWrap: 'wrap' }}>
              <h2 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '17px', fontWeight: 700, margin: 0 }}>Thông báo</h2>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span style={{ fontSize: '12.5px', color: 'oklch(52% 0.02 240)' }}>{openAlerts.length} đang diễn ra · {unreadAlerts.length} chưa đọc</span>
                {unreadAlerts.length > 0 && (
                  <button onClick={markAllAlertsRead} style={{ background: 'none', border: 'none', fontSize: '12.5px', fontWeight: 600, color: BLUE, cursor: 'pointer', padding: 0, fontFamily: "'Manrope',sans-serif" }}>Đánh dấu tất cả đã đọc</button>
                )}
              </div>
            </div>

            {/* Bốn ô lọc, dựng từ ALERT_FILTER_ORDER nên thêm một mức phân loại
                mới ở lib/alerts.js là có ngay cả ô lọc lẫn câu mô tả tương ứng
                — không phải nhớ sửa ba chỗ. Mặc định "Tất cả": xem chú thích ở
                alertFilter. */}
            <div style={{ display: 'inline-flex', flexWrap: 'wrap', background: 'oklch(96% 0.006 240)', borderRadius: '10px', padding: '4px', gap: '2px', marginBottom: '4px' }}>
              {ALERT_FILTER_ORDER.map((id) => (
                <button key={id} type="button" style={segmentTabStyle(alertFilter === id)} onClick={() => setAlertFilter(id)}>
                  {/* Chấm màu lặp lại đúng màu của chấm đứng đầu mỗi dòng, để ô
                      lọc và danh sách bên dưới đọc được như một hệ thống. */}
                  {ALERT_FILTER_META[id].color && (
                    <span style={{ display: 'inline-block', width: '7px', height: '7px', borderRadius: '50%', background: ALERT_FILTER_META[id].color, marginRight: '6px', verticalAlign: 'middle' }} />
                  )}
                  {ALERT_FILTER_META[id].label} ({alertFilterCounts[id]})
                </button>
              ))}
            </div>

            {visibleAlertEvents.length === 0 ? (
              <div style={{ padding: '36px 16px', textAlign: 'center' }}>
                <div style={{ fontSize: '14px', fontWeight: 600, color: 'oklch(40% 0.02 240)' }}>
                  {alertFilter === 'open' ? 'Không có sự cố nào đang diễn ra'
                    : alertFilter === 'all' ? 'Chưa có thông báo nào'
                      : `Chưa có thông báo mức "${ALERT_SEVERITY_META[alertFilter]?.label ?? alertFilter}"`}
                </div>
                <div style={{ fontSize: '13px', color: 'oklch(58% 0.02 240)', marginTop: '4px' }}>
                  {alertFilter === 'open' ? 'Toàn bộ trạm đang hoạt động trong ngưỡng cho phép.'
                    : alertFilter === 'all' ? 'Hệ thống chưa ghi nhận sự cố nào.'
                      : 'Chọn "Tất cả" để xem những thông báo thuộc mức khác.'}
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {visibleAlertEvents.map((item) => {
                  const unread = !item.readAt;
                  // Đợt đã đóng: đúng với CẢ mục mở lẫn mục hồi phục của nó,
                  // nên cả hai dòng cùng mờ đi và cùng xoá được.
                  const closed = !item.ongoing;
                  // `baseSeverity` (mức của ĐỢT gốc) chứ không phải `severity`:
                  // mục hồi phục mang mức giả 'resolved' để lấy màu xanh, tra
                  // bảng bằng nó sẽ rơi vào nhánh dự phòng `info` và tô cả chấm
                  // lẫn viền thành màu xanh dương của mức không hề tồn tại.
                  const sev = ALERT_SEVERITY_META[item.baseSeverity] ?? ALERT_SEVERITY_META.info;
                  return (
                    <div
                      key={item.key}
                      onClick={() => unread && markAlertRead(item.id)}
                      style={{ display: 'flex', gap: '12px', padding: '14px 4px', borderBottom: '1px solid oklch(95% 0.006 240)', cursor: unread ? 'pointer' : 'default', opacity: closed ? 0.6 : 1 }}
                    >
                      {/* Chấm đặc = chuyện đang xảy ra hoặc tin hồi phục (xanh
                          lá, cùng màu với chuông); vòng tròn rỗng = lúc sự cố
                          MỞ ra và nay đã qua. Nhìn lướt phải phân biệt được ba
                          loại này trước cả khi đọc tới chữ. */}
                      <span style={{ width: '9px', height: '9px', borderRadius: '50%', marginTop: '5px', flexShrink: 0, background: item.resolved ? ALERT_RESOLVED_META.color : closed ? 'transparent' : sev.color, border: `2px solid ${item.resolved ? ALERT_RESOLVED_META.color : sev.color}`, boxSizing: 'border-box' }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap', marginBottom: '3px' }}>
                          {/* Hai huy hiệu trả lời hai câu khác nhau và cố ý
                              trông khác nhau: mức PHÂN LOẠI ("Nghiêm trọng" /
                              "Bất thường") tô màu vì nó quyết định có phải xử
                              lý ngay hay không; LOẠI sự cố ("Quá nhiệt") để
                              xám vì nó chỉ nói chuyện gì đã xảy ra. Trước đây
                              chỉ có huy hiệu loại và nó mượn màu của mức, nên
                              phân loại chỉ tồn tại dưới dạng một sắc độ — đọc
                              được nếu đã biết quy ước, còn không thì không.

                              Mục hồi phục không mang huy hiệu phân loại: nó là
                              tin tốt, dán "Nghiêm trọng" màu đỏ lên một dòng
                              báo mọi thứ đã trở lại bình thường thì nói ngược
                              hẳn nội dung. Phân loại của đợt vẫn còn nguyên ở
                              dòng MỞ ngay bên dưới, và bộ lọc theo mức vẫn giữ
                              cả hai dòng cạnh nhau (xem `baseSeverity`). */}
                          {item.resolved ? (
                            <span style={{ fontSize: '10.5px', fontWeight: 700, padding: '2px 7px', borderRadius: '10px', color: 'oklch(50% 0.14 150)', background: 'oklch(93% 0.06 150)' }}>{ALERT_RESOLVED_META.label}</span>
                          ) : (
                            <span style={{ fontSize: '10.5px', fontWeight: 700, padding: '2px 7px', borderRadius: '10px', color: sev.textColor, background: sev.bg }}>
                              {sev.label}
                            </span>
                          )}
                          <span style={{ fontSize: '10.5px', fontWeight: 700, padding: '2px 7px', borderRadius: '10px', color: 'oklch(45% 0.02 240)', background: 'oklch(95% 0.006 240)' }}>
                            {ALERT_KIND_META[item.kind]?.label ?? item.kind}
                          </span>
                        </div>
                        <div style={{ fontSize: '13.5px', color: 'oklch(26% 0.03 240)', lineHeight: 1.5 }}>{item.message}</div>
                        <div style={{ fontSize: '11.5px', color: 'oklch(58% 0.02 240)', marginTop: '3px' }}>
                          {item.resolved
                            ? `${fmtRelative(item.at)} · ${item.durationLabel} ${fmtDuration(item.durationMs)}`
                            : `${fmtRelative(item.at)} · ${item.ongoing ? 'đang diễn ra' : 'đã kết thúc'}`}
                          {/* Số đo lúc mở đợt — thứ duy nhất ở đây không tìm lại
                              được chỗ khác sau khi sự cố đã qua. */}
                          {item.value != null && item.threshold != null && (
                            <span style={{ fontFamily: "'IBM Plex Mono',monospace" }}>
                              {' · '}{fmtAlertMetric(item.kind, item.value)} / ngưỡng {fmtAlertMetric(item.kind, item.threshold)}
                            </span>
                          )}
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', flexShrink: 0 }}>
                        {unread && <span title="Chưa đọc" style={{ width: '7px', height: '7px', borderRadius: '50%', background: BLUE, marginTop: '6px' }} />}
                        {/* Chỉ đợt đã đóng mới xoá được — policy của 0023 từ chối
                            phần còn lại, và xoá một sự cố còn nguyên đó chỉ làm
                            mất dấu chứ không sửa được gì. Xoá là xoá cả ĐỢT, nên
                            mục mở và mục hồi phục cùng đi; nói rõ điều đó trong
                            tooltip để không ai tưởng mình chỉ bỏ một dòng. */}
                        {closed && (
                          <button
                            onClick={(e) => { e.stopPropagation(); dismissAlert(item.id); }}
                            title="Xoá cả đợt này khỏi lịch sử"
                            style={{ background: 'none', border: 'none', color: 'oklch(62% 0.02 240)', fontSize: '15px', lineHeight: 1, cursor: 'pointer', padding: '2px 4px' }}
                          >
                            ×
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <aside style={{ order: alertsSideBySide ? 2 : 1, flex: '0 0 auto', width: alertsSideBySide ? '306px' : '100%', maxWidth: '760px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {/* --- Mô tả bộ lọc đang chọn ---------------------------------
                Thay cho bảng chú giải liệt kê cả hai mức một lúc ở cuối trang:
                bảng đó bắt người dùng tự dò xem dòng nào ứng với thứ mình vừa
                bấm, còn khung này chỉ nói về đúng ô đang mở và đứng ngay cạnh
                nó. Đổi ô lọc là đổi cả nội dung khung — nên nó cũng là phản hồi
                cho thao tác vừa rồi, không chỉ là chữ giải nghĩa.

                Danh sách loại suy ra từ ALERT_KIND_META (qua ALERT_FILTER_META),
                không chép tay: thêm một loại cảnh báo mới không để lại khung
                này nói thiếu. */}
            <div style={{ ...sectionCardStyle, padding: '18px 20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                {ALERT_FILTER_META[alertFilter].color && (
                  <span style={{ width: '9px', height: '9px', borderRadius: '50%', flexShrink: 0, background: ALERT_FILTER_META[alertFilter].color }} />
                )}
                <h2 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '14.5px', fontWeight: 700, margin: 0 }}>
                  {ALERT_FILTER_META[alertFilter].label}
                </h2>
              </div>
              <p style={{ fontSize: '12.5px', color: 'oklch(38% 0.02 240)', margin: 0, lineHeight: 1.6 }}>
                {ALERT_FILTER_META[alertFilter].desc}
              </p>
              {ALERT_FILTER_META[alertFilter].kinds && (
                <p style={{ fontSize: '11.5px', color: 'oklch(58% 0.02 240)', margin: '7px 0 0', lineHeight: 1.55 }}>
                  Gồm: {ALERT_FILTER_META[alertFilter].kinds.join(', ')}.
                </p>
              )}
            </div>

            {/* --- Thống kê theo mức --------------------------------------
                Hai con số, không phải một biểu đồ: hai hạng mục cố định thì
                thanh ngang cạnh số đã đủ để so tỉ lệ, thêm trục và lưới vào
                chỉ tốn chỗ mà không nói thêm gì.

                Luôn vẽ CẢ hai mức kể cả khi bằng 0 — một mức biến mất khỏi
                khung sẽ đọc thành "mức này không tồn tại" thay vì "kỳ này
                không có". Chữ số dùng màu mực thường, chấm màu mới là thứ
                mang danh tính của mức; tô đỏ luôn con số sẽ khiến nó tranh chỗ
                với chính các cảnh báo trong danh sách bên cạnh. */}
            <div style={{ ...sectionCardStyle, padding: '18px 20px' }}>
              <h2 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '14.5px', fontWeight: 700, margin: '0 0 12px' }}>Thống kê</h2>

              <div style={{ display: 'flex', flexWrap: 'wrap', background: 'oklch(96% 0.006 240)', borderRadius: '9px', padding: '3px', gap: '2px', marginBottom: '18px' }}>
                {ALERT_STAT_RANGES.map((r) => (
                  <button key={r.id} type="button" style={{ ...segmentTabStyle(alertStatRange === r.id, true), flex: '1 1 auto' }} onClick={() => setAlertStatRange(r.id)}>
                    {r.label}
                  </button>
                ))}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                {ALERT_CLASS_ORDER.map((sev) => {
                  const meta = ALERT_SEVERITY_META[sev];
                  const n = alertStats.counts[sev];
                  return (
                    <div key={sev}>
                      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '10px', marginBottom: '7px' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '7px', fontSize: '12.5px', fontWeight: 600, color: 'oklch(38% 0.02 240)' }}>
                          <span style={{ width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0, background: meta.color }} />
                          {meta.label}
                        </span>
                        <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '20px', fontWeight: 500, lineHeight: 1, color: n === 0 ? 'oklch(66% 0.02 240)' : 'oklch(20% 0.03 240)' }}>{n}</span>
                      </div>
                      {/* Thanh rỗng vẫn giữ nguyên rãnh nền, nên hàng có số 0
                          không sụt chiều cao và hai hàng luôn thẳng nhau. */}
                      <div style={{ height: '7px', borderRadius: '4px', background: 'oklch(95% 0.006 240)', overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${(n / alertStatMax) * 100}%`, borderRadius: '4px', background: meta.color }} />
                      </div>
                    </div>
                  );
                })}
              </div>

              <div style={{ borderTop: '1px solid oklch(94% 0.008 240)', marginTop: '16px', paddingTop: '12px', fontSize: '11.5px', color: 'oklch(56% 0.02 240)', lineHeight: 1.6 }}>
                {/* "Phát sinh trong" chứ không phải "có trong": đếm theo mốc mở
                    đợt, nên một sự cố mở từ tuần trước và còn đang chạy không
                    nằm trong cửa sổ 24 giờ. Con số "đang diễn ra" ở đầu thẻ
                    danh sách mới trả lời câu đó — xem alertSeverityCounts. */}
                {alertStats.total} đợt cảnh báo phát sinh trong {statRange.windowLabel}.
                {alertsTruncated && ' Lịch sử đã đạt giới hạn tải về nên số thực tế có thể cao hơn.'}
              </div>
            </div>
          </aside>
        </div>
      )}

      {isSettingsView && (
        <div style={{ maxWidth: '760px' }}>
          <div style={{ display: 'flex', background: 'white', border: '1px solid oklch(91% 0.01 240)', borderRadius: '12px', padding: '4px', marginBottom: '24px', width: 'fit-content', gap: '2px' }}>
            <button style={segmentTabStyle(settingsTab === 'account')} onClick={() => setSettingsTab('account')}>Tài khoản</button>
            <button style={segmentTabStyle(settingsTab === 'system')} onClick={() => setSettingsTab('system')}>Hệ thống</button>
            <button style={segmentTabStyle(settingsTab === 'notifications')} onClick={() => setSettingsTab('notifications')}>Thông báo</button>
          </div>

          {settingsTab === 'account' && (
            <div>
              <div style={{ ...sectionCardStyle, marginBottom: '20px' }}>
                <h2 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '16px', fontWeight: 700, margin: '0 0 18px' }}>Thông tin cá nhân</h2>
                <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: avatarError ? '12px' : '22px' }}>
                  <Avatar
                    url={avatarUrl}
                    name={fullName || user?.user_metadata?.full_name}
                    email={user?.email}
                    size={56}
                    background="oklch(93% 0.01 240)"
                    color="oklch(45% 0.03 240)"
                    border="1px solid oklch(88% 0.01 240)"
                  />
                  <input
                    ref={avatarInputRef}
                    type="file"
                    accept={AVATAR_MIME_TYPES.join(',')}
                    onChange={handleAvatarFile}
                    style={{ display: 'none' }}
                  />
                  <button
                    onClick={() => avatarInputRef.current?.click()}
                    disabled={avatarUploading}
                    style={{ padding: '9px 16px', borderRadius: '9px', border: '1px solid oklch(88% 0.01 240)', background: 'white', fontSize: '13px', fontWeight: 600, color: 'oklch(30% 0.03 240)', cursor: avatarUploading ? 'default' : 'pointer', fontFamily: "'Manrope',sans-serif", opacity: avatarUploading ? 0.6 : 1 }}
                  >
                    {avatarUploading ? 'Đang tải lên…' : 'Đổi ảnh đại diện'}
                  </button>
                </div>
                {avatarError && (
                  <p style={{ fontSize: '13px', color: 'oklch(50% 0.18 25)', background: 'oklch(93% 0.06 25)', borderRadius: '8px', padding: '10px 12px', margin: '0 0 22px' }}>{avatarError}</p>
                )}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: 'oklch(32% 0.03 240)', marginBottom: '7px' }}>Họ và tên</label>
                    <input type="text" value={fullName} onChange={(e) => setFullName(e.target.value)} style={{ width: '100%', boxSizing: 'border-box', padding: '11px 13px', borderRadius: '9px', border: '1px solid oklch(88% 0.01 240)', fontSize: '14px', fontFamily: "'Manrope',sans-serif" }} />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: 'oklch(32% 0.03 240)', marginBottom: '7px' }}>Số điện thoại</label>
                    <input type="text" value={phone} onChange={(e) => setPhone(e.target.value)} style={{ width: '100%', boxSizing: 'border-box', padding: '11px 13px', borderRadius: '9px', border: '1px solid oklch(88% 0.01 240)', fontSize: '14px', fontFamily: "'Manrope',sans-serif" }} />
                  </div>
                </div>
                <div style={{ marginBottom: '20px' }}>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: 'oklch(32% 0.03 240)', marginBottom: '7px' }}>Email</label>
                  <input type="email" value={user.email} readOnly style={{ width: '100%', boxSizing: 'border-box', padding: '11px 13px', borderRadius: '9px', border: '1px solid oklch(88% 0.01 240)', fontSize: '14px', fontFamily: "'Manrope',sans-serif", background: 'oklch(97% 0.005 240)', color: 'oklch(52% 0.02 240)' }} />
                </div>
                <button onClick={saveProfile} disabled={profileSaving} style={{ padding: '11px 20px', borderRadius: '9px', border: 'none', background: BLUE, color: 'white', fontSize: '14px', fontWeight: 700, cursor: 'pointer', fontFamily: "'Manrope',sans-serif", opacity: profileSaving ? 0.7 : 1 }}>{profileSaving ? 'Đang lưu…' : 'Lưu thay đổi'}</button>
              </div>

              <div style={{ ...sectionCardStyle, marginBottom: '20px' }}>
                <h2 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '16px', fontWeight: 700, margin: '0 0 6px' }}>Phương thức đăng nhập</h2>
                <p style={{ fontSize: '13px', color: 'oklch(52% 0.02 240)', margin: '0 0 16px' }}>Hệ thống chỉ đăng nhập bằng Google — mật khẩu do Google quản lý, không lưu ở đây.</p>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
                  <GoogleIcon />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: '14px', fontWeight: 600 }}>Google</div>
                    <div style={{ fontSize: '12.5px', color: 'oklch(52% 0.02 240)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{user.email}</div>
                  </div>
                  <span style={{ fontSize: '11.5px', fontWeight: 700, color: 'oklch(50% 0.14 150)', background: 'oklch(93% 0.06 150)', padding: '3px 9px', borderRadius: '20px', flexShrink: 0 }}>Đang dùng</span>
                </div>
              </div>

              <div style={{ background: 'white', border: '1px solid oklch(85% 0.05 25)', borderRadius: '16px', padding: '24px', boxShadow: '0 1px 2px oklch(0% 0 0 / 0.04)' }}>
                <h2 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '16px', fontWeight: 700, margin: '0 0 6px', color: 'oklch(45% 0.15 25)' }}>Vùng nguy hiểm</h2>
                <p style={{ fontSize: '13px', color: 'oklch(52% 0.02 240)', margin: '0 0 16px' }}>Đăng xuất khỏi tất cả các thiết bị đang đăng nhập vào tài khoản này.</p>
                <button onClick={handleSignOut} style={{ padding: '10px 18px', borderRadius: '9px', border: '1px solid oklch(80% 0.15 25 / 0.4)', background: 'white', fontSize: '13.5px', fontWeight: 700, color: 'oklch(50% 0.18 25)', cursor: 'pointer' }}>Đăng xuất khỏi tất cả thiết bị</button>
              </div>
            </div>
          )}

          {settingsTab === 'system' && (
            <div>
              <div style={{ ...sectionCardStyle, marginBottom: '20px' }}>
                <h2 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '16px', fontWeight: 700, margin: '0 0 6px' }}>Danh sách trạm của bạn</h2>
                <p style={{ fontSize: '13px', color: 'oklch(52% 0.02 240)', margin: '0 0 16px' }}>Thêm hoặc xóa trạm giám sát trong tài khoản.</p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '20px' }}>
                  {stations.map((s) => {
                    const deviceCount = devices.filter((d) => d.station_id === s.id).length;
                    const confirming = confirmDeleteStationId === s.id;
                    return (
                      <div key={s.id} style={{ padding: '12px 4px', borderBottom: '1px solid oklch(95% 0.006 240)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                            <span style={{ width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0, background: STATION_STATUS_META[s.status]?.color ?? 'oklch(58% 0.02 240)' }} />
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontSize: '14px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</div>
                              <div style={{ fontSize: '12px', color: 'oklch(52% 0.02 240)' }}>{s.location}</div>
                            </div>
                          </div>
                          <button
                            onClick={() => handleDeleteStation(s.id)}
                            onBlur={() => setConfirmDeleteStationId((cur) => (cur === s.id ? null : cur))}
                            style={{ padding: '7px 14px', borderRadius: '8px', border: confirming ? '1px solid oklch(58% 0.19 25)' : '1px solid oklch(88% 0.01 240)', background: confirming ? 'oklch(93% 0.06 25)' : 'white', fontSize: '12.5px', fontWeight: 600, color: confirming ? 'oklch(50% 0.18 25)' : 'oklch(45% 0.02 240)', cursor: 'pointer', flexShrink: 0, whiteSpace: 'nowrap' }}
                          >
                            {confirming ? 'Xác nhận xóa?' : 'Xóa'}
                          </button>
                        </div>
                        {confirming && (
                          <div style={{ fontSize: '12px', color: 'oklch(50% 0.18 25)', marginTop: '8px' }}>
                            {deviceCount > 0
                              ? `Trạm này có ${deviceCount} thiết bị — toàn bộ lịch sử dữ liệu sẽ bị xóa vĩnh viễn.`
                              : 'Bấm "Xác nhận xóa?" lần nữa để xóa trạm này.'}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <form onSubmit={handleCreateStation} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: '12px', alignItems: 'end' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: 'oklch(32% 0.03 240)', marginBottom: '7px' }}>Tên trạm mới</label>
                    <input type="text" value={newStationName} onChange={(e) => setNewStationName(e.target.value)} placeholder="Trạm 05" style={{ width: '100%', boxSizing: 'border-box', padding: '11px 13px', borderRadius: '9px', border: '1px solid oklch(88% 0.01 240)', fontSize: '14px', fontFamily: "'Manrope',sans-serif" }} />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: 'oklch(32% 0.03 240)', marginBottom: '7px' }}>Địa điểm</label>
                    <input type="text" value={newStationLocation} onChange={(e) => setNewStationLocation(e.target.value)} placeholder="Cần Thơ" style={{ width: '100%', boxSizing: 'border-box', padding: '11px 13px', borderRadius: '9px', border: '1px solid oklch(88% 0.01 240)', fontSize: '14px', fontFamily: "'Manrope',sans-serif" }} />
                  </div>
                  <button type="submit" disabled={stationFormSaving || !newStationName.trim() || !newStationLocation.trim()} style={{ padding: '11px 20px', borderRadius: '9px', border: 'none', background: BLUE, color: 'white', fontSize: '14px', fontWeight: 700, cursor: 'pointer', fontFamily: "'Manrope',sans-serif", opacity: stationFormSaving || !newStationName.trim() || !newStationLocation.trim() ? 0.6 : 1, whiteSpace: 'nowrap' }}>
                    {stationFormSaving ? 'Đang thêm…' : '+ Thêm trạm'}
                  </button>
                </form>
                {stationFormError && <div style={{ fontSize: '12.5px', color: 'oklch(52% 0.17 25)', marginTop: '10px' }}>{stationFormError}</div>}
              </div>

              <form onSubmit={handleSaveStationInfo} style={{ ...sectionCardStyle, marginBottom: '20px' }}>
                <h2 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '16px', fontWeight: 700, margin: '0 0 18px' }}>Thông tin trạm</h2>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: 'oklch(32% 0.03 240)', marginBottom: '7px' }}>Tên trạm</label>
                    <input ref={stationNameRef} key={station.id + '-name'} type="text" defaultValue={station.name} style={{ width: '100%', boxSizing: 'border-box', padding: '11px 13px', borderRadius: '9px', border: '1px solid oklch(88% 0.01 240)', fontSize: '14px', fontFamily: "'Manrope',sans-serif" }} />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: 'oklch(32% 0.03 240)', marginBottom: '7px' }}>Địa điểm</label>
                    <input ref={stationLocationRef} key={station.id + '-loc'} type="text" defaultValue={station.location} style={{ width: '100%', boxSizing: 'border-box', padding: '11px 13px', borderRadius: '9px', border: '1px solid oklch(88% 0.01 240)', fontSize: '14px', fontFamily: "'Manrope',sans-serif" }} />
                  </div>
                </div>
                <div style={{ marginBottom: '20px', maxWidth: '280px' }}>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: 'oklch(32% 0.03 240)', marginBottom: '7px' }}>Múi giờ</label>
                  <select ref={stationTimezoneRef} key={station.id + '-tz'} defaultValue={station.timezone} style={{ width: '100%', boxSizing: 'border-box', padding: '11px 13px', borderRadius: '9px', border: '1px solid oklch(88% 0.01 240)', fontSize: '14px', fontFamily: "'Manrope',sans-serif", background: 'white' }}>
                    {TIMEZONE_OPTIONS.map((tz) => <option key={tz.id} value={tz.id}>{tz.label}</option>)}
                  </select>
                </div>
                <button type="submit" disabled={stationInfoSaving} style={{ padding: '11px 20px', borderRadius: '9px', border: 'none', background: BLUE, color: 'white', fontSize: '14px', fontWeight: 700, cursor: 'pointer', fontFamily: "'Manrope',sans-serif", opacity: stationInfoSaving ? 0.7 : 1 }}>{stationInfoSaving ? 'Đang lưu…' : 'Lưu thay đổi'}</button>
                {stationInfoError && <div style={{ fontSize: '12.5px', color: 'oklch(52% 0.17 25)', marginTop: '10px' }}>{stationInfoError}</div>}
                {stationInfoSuccess && <div style={{ fontSize: '12.5px', color: 'oklch(50% 0.14 150)', marginTop: '10px' }}>{stationInfoSuccess}</div>}
              </form>

              <div style={{ ...sectionCardStyle, marginBottom: '20px' }}>
                <h2 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '16px', fontWeight: 700, margin: '0 0 16px' }}>Thiết bị kết nối</h2>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  {stationDevices.length === 0 ? (
                    <div style={{ padding: '20px 4px', fontSize: '13px', color: 'oklch(55% 0.02 240)' }}>Chưa có thiết bị nào được đăng ký cho trạm này.</div>
                  ) : stationDevices.map((item) => {
                    const detail = `${DEVICE_TYPE_LABEL[item.type] ?? item.type} · ${item.status === 'connected' ? 'Đã kết nối' : `Mất kết nối · ${fmtRelative(item.last_seen_at)}`}`;
                    return (
                      <div key={item.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 4px', borderBottom: '1px solid oklch(95% 0.006 240)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                          <span style={{ width: '9px', height: '9px', borderRadius: '50%', flexShrink: 0, background: DEVICE_STATUS_COLOR[item.status] }} />
                          <div>
                            <div style={{ fontSize: '14px', fontWeight: 600 }}>{item.name}</div>
                            <div style={{ fontSize: '12px', color: 'oklch(52% 0.02 240)' }}>{detail}</div>
                          </div>
                        </div>
                        <button style={{ padding: '7px 14px', borderRadius: '8px', border: '1px solid oklch(88% 0.01 240)', background: 'white', fontSize: '12.5px', fontWeight: 600, color: 'oklch(30% 0.03 240)', cursor: 'pointer' }}>Cấu hình</button>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* `key={station.id}` để đổi trạm là nạp lại ngưỡng của trạm đó
                  vào các ô uncontrolled — cùng cách form "Thông tin trạm" ở
                  trên đang làm. Thiếu nó thì chuyển trạm sẽ giữ nguyên số của
                  trạm cũ trên màn hình và người dùng lưu đè nhầm. */}
              <form key={station.id + '-thresholds'} onSubmit={handleSaveThresholds} style={{ ...sectionCardStyle, marginBottom: '20px' }}>
                <h2 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '16px', fontWeight: 700, margin: '0 0 6px' }}>Ngưỡng cảnh báo</h2>
                <p style={{ fontSize: '13px', color: 'oklch(52% 0.02 240)', margin: '0 0 6px' }}>
                  Mức để coi trạm đang chọn là bất thường: điện áp pin xuống dưới mức tối thiểu, nhiệt độ vượt mức tối đa, hoặc tải vượt công suất cho phép. Vượt ngưỡng sẽ mở một cảnh báo ở mục <strong style={{ fontWeight: 700 }}>Thông báo</strong> và đổi trạng thái trạm sang "Cảnh báo".
                </p>
                <p style={{ fontSize: '13px', color: 'oklch(52% 0.02 240)', margin: '0 0 18px' }}>
                  Để trống một ô để tắt hẳn kiểm tra đó — ví dụ trạm không gắn cảm biến nhiệt. Ngưỡng phần trăm pin không nằm ở đây: nó đã là mức <strong style={{ fontWeight: 700 }}>SOC tối thiểu</strong> của chế độ bảo vệ pin đang chọn{activeMinSoc == null ? '' : ` (hiện là ${activeMinSoc}%)`}, chỉnh ở trang Pin lưu trữ.
                </p>
                <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr 1fr', gap: '16px', marginBottom: '20px' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: 'oklch(32% 0.03 240)', marginBottom: '7px' }}>Điện áp pin tối thiểu (V)</label>
                    <input ref={minVoltageRef} type="number" step="0.1" min="0" placeholder="Tắt" defaultValue={settings.alertThresholds.minVoltage ?? ''} style={{ width: '100%', boxSizing: 'border-box', padding: '11px 13px', borderRadius: '9px', border: '1px solid oklch(88% 0.01 240)', fontSize: '14px', fontFamily: "'IBM Plex Mono',monospace" }} />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: 'oklch(32% 0.03 240)', marginBottom: '7px' }}>Nhiệt độ tối đa (°C)</label>
                    <input ref={maxTempRef} type="number" step="0.5" min="0" placeholder="Tắt" defaultValue={settings.alertThresholds.maxTempC ?? ''} style={{ width: '100%', boxSizing: 'border-box', padding: '11px 13px', borderRadius: '9px', border: '1px solid oklch(88% 0.01 240)', fontSize: '14px', fontFamily: "'IBM Plex Mono',monospace" }} />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: 'oklch(32% 0.03 240)', marginBottom: '7px' }}>Tải tối đa (W)</label>
                    <input ref={maxLoadRef} type="number" step="10" min="0" placeholder="Tắt" defaultValue={settings.alertThresholds.maxLoadKw == null ? '' : Math.round(settings.alertThresholds.maxLoadKw * 1000)} style={{ width: '100%', boxSizing: 'border-box', padding: '11px 13px', borderRadius: '9px', border: '1px solid oklch(88% 0.01 240)', fontSize: '14px', fontFamily: "'IBM Plex Mono',monospace" }} />
                  </div>
                </div>
                <button type="submit" disabled={thresholdSaving} style={{ padding: '11px 20px', borderRadius: '9px', border: 'none', background: BLUE, color: 'white', fontSize: '14px', fontWeight: 700, cursor: 'pointer', fontFamily: "'Manrope',sans-serif", opacity: thresholdSaving ? 0.7 : 1 }}>{thresholdSaving ? 'Đang lưu…' : 'Lưu ngưỡng'}</button>
                {thresholdError && <div style={{ fontSize: '12.5px', color: 'oklch(52% 0.17 25)', marginTop: '10px' }}>{thresholdError}</div>}
                {thresholdSuccess && <div style={{ fontSize: '12.5px', color: 'oklch(50% 0.14 150)', marginTop: '10px' }}>{thresholdSuccess}</div>}
              </form>

              <div style={sectionCardStyle}>
                <h2 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '16px', fontWeight: 700, margin: '0 0 6px' }}>Đơn vị đo lường</h2>
                <p style={{ fontSize: '13px', color: 'oklch(52% 0.02 240)', margin: '0 0 4px' }}>
                  Đơn vị hiển thị cho các con số <strong style={{ fontWeight: 700 }}>năng lượng</strong> — sản lượng trong ngày, tổng nạp/xả của pin, bảng sản lượng ở trang Báo cáo và file CSV xuất ra.
                </p>
                <p style={{ fontSize: '13px', color: 'oklch(52% 0.02 240)', margin: '0 0 16px' }}>
                  Chỉ đổi cách hiển thị: dữ liệu luôn được lưu bằng kWh nên chuyển qua lại không làm sai lệch số liệu hay ảnh hưởng tới thiết bị. Các đại lượng khác giữ nguyên đơn vị (công suất luôn tính bằng W, điện áp V, dòng điện A). Thiết lập theo tài khoản, áp dụng cho mọi trạm của bạn.
                </p>
                <div style={{ display: 'inline-flex', background: 'oklch(96% 0.006 240)', borderRadius: '10px', padding: '4px', gap: '2px' }}>
                  <button type="button" style={segmentTabStyle(energyUnit === 'kWh')} onClick={() => settings.setEnergyUnit('kWh')}>kWh</button>
                  <button type="button" style={segmentTabStyle(energyUnit === 'Wh')} onClick={() => settings.setEnergyUnit('Wh')}>Wh</button>
                </div>
                {/* Ví dụ dựng bằng chính fmtEnergy() đang dùng để vẽ các trang
                    khác, nên không thể lệch với những gì người dùng sẽ thấy. */}
                <div style={{ fontSize: '12.5px', color: 'oklch(58% 0.02 240)', marginTop: '12px' }}>
                  Ví dụ: sản lượng một ngày nắng đẹp hiện là{' '}
                  <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontWeight: 600, color: 'oklch(30% 0.03 240)' }}>
                    {unitExample.value} {unitExample.unit}
                  </span>
                </div>
              </div>
            </div>
          )}

          {settingsTab === 'notifications' && (
            <div style={sectionCardStyle}>
              {/* Tiêu đề thẻ phải đọc ra ngay là MỘT BẬC TRÊN các hàng tuỳ chọn
                  bên dưới. Trước đây nó là 16px/700 còn nhãn từng tuỳ chọn là
                  14px/600 — cách nhau quá ít nên cả khối trông như một danh
                  sách phẳng gồm năm dòng ngang hàng nhau. Ba thay đổi cùng
                  hướng: cỡ chữ lớn hơn hẳn (19px), chữ hoa nhỏ làm nhãn phân
                  loại, và một đường kẻ ngang đóng lại phần đầu thẻ. */}
              <div style={{ borderBottom: '1px solid oklch(91% 0.01 240)', paddingBottom: '14px', marginBottom: '4px' }}>
                <div style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.09em', textTransform: 'uppercase', color: BLUE, marginBottom: '7px' }}>Thông báo</div>
                <h2 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '19px', fontWeight: 700, margin: '0 0 5px', color: 'oklch(20% 0.03 240)' }}>Tùy chọn thông báo</h2>
                <p style={{ fontSize: '13px', color: 'oklch(52% 0.02 240)', margin: 0, lineHeight: 1.55 }}>Chọn cách bạn muốn nhận cập nhật từ hệ thống.</p>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <PushRow push={push} onEnable={enablePush} onDisable={disablePush} />
                {notifPrefs.map((item) => (
                  <div key={item.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', padding: '14px 4px', borderBottom: '1px solid oklch(95% 0.006 240)' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: '14px', fontWeight: 600 }}>{item.label}</div>
                      {item.note && <div style={{ fontSize: '12px', color: 'oklch(58% 0.02 240)', marginTop: '2px' }}>{item.note}</div>}
                    </div>
                    <Switch on={item.on} onClick={() => toggleNotifPref(item.id)} />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </AppShell>
  );
}
