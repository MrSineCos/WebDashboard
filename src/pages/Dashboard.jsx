import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import AppShell from '../components/AppShell.jsx';
import Avatar from '../components/Avatar.jsx';
import { useIsMobile } from '../lib/useIsMobile.js';
import { userAvatarUrl, ownAvatarStoragePath, AVATAR_MAX_BYTES, AVATAR_MIME_TYPES } from '../lib/avatar.js';
import { useStationSelector, STATION_STATUS_META } from '../lib/stations.js';
import { useTelemetry, useDevices } from '../lib/telemetry.js';
import { useUserSettings } from '../lib/userSettings.js';
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
const STANDALONE_VIEWS = ['settings', 'load', 'alerts'];

const DEVICE_TYPE_LABEL ={ esp32: 'Bộ điều khiển ESP32', inverter: 'Inverter', bms: 'BMS Pin lưu trữ', sensor: 'Cảm biến' };

// Định dạng thời điểm bản tin (giờ:phút, ngày/tháng) cho dòng ghi chú.
function fmtClock(ts) {
  return new Date(ts).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
}

// Như fmtClock nhưng kèm giây — dùng cho nhãn "tại ..." khi hover biểu đồ,
// nơi độ chính xác tới giây thực sự hữu ích (chu kỳ gửi telemetry là ~10s).
function fmtClockSec(ts) {
  return new Date(ts).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit', day: '2-digit', month: '2-digit' });
}

// Trả về giá trị đã định dạng, hoặc "--" khi chưa có dữ liệu telemetry.
function fmtNum(v, digits = 0) {
  return v == null || Number.isNaN(Number(v)) ? '--' : Number(v).toFixed(digits);
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

const ALERTS_DATA = [
  { severity: 'warning', msg: 'Điện áp pin giảm dưới 46V lúc 14:32', time: '2 giờ trước' },
  { severity: 'danger', msg: 'Mất kết nối cảm biến ESP32-02', time: '5 giờ trước' },
  { severity: 'info', msg: 'Cập nhật firmware inverter thành công', time: 'Hôm qua' },
];

const NOTIF_DEFS = [
  { id: 'emailAlerts', label: 'Cảnh báo email khi có sự cố' },
  { id: 'push', label: 'Thông báo đẩy trên điện thoại' },
  { id: 'weeklyReport', label: 'Báo cáo tổng kết hàng tuần' },
  { id: 'lowBattery', label: 'Cảnh báo pin yếu (dưới 20%)' },
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

// Nhãn hiển thị cho từng phương thức đăng nhập (provider của Supabase Auth).
const PROVIDER_META = {
  email: { label: 'Email & mật khẩu' },
  google: { label: 'Google' },
};

// GoTrue trả lỗi tiếng Anh; dịch các trường hợp hay gặp sang tiếng Việt và
// nói rõ việc cần làm, thay vì hiện nguyên văn kỹ thuật cho người dùng cuối.
function identityErrorText(error) {
  const raw = error?.message ?? '';
  if (/manual linking is disabled/i.test(raw)) {
    return 'Tính năng liên kết đang tắt ở phía máy chủ. Bật "Enable Manual Linking" trong Supabase → Authentication → Providers rồi thử lại.';
  }
  if (/at least.*identit|single identity|last identity/i.test(raw)) {
    return 'Không thể gỡ phương thức đăng nhập cuối cùng — hãy liên kết thêm một phương thức khác trước.';
  }
  if (/already.*linked|identity.*already.*exists/i.test(raw)) {
    return 'Tài khoản Google này đã được liên kết với một tài khoản khác.';
  }
  return raw || 'Không thực hiện được, vui lòng thử lại.';
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

const SEVERITY_COLOR = { warning: 'oklch(75% 0.14 70)', danger: 'oklch(58% 0.19 25)', info: 'oklch(54% 0.15 240)' };

const DEVICE_STATUS_COLOR = { connected: 'oklch(64% 0.15 150)', disconnected: 'oklch(58% 0.19 25)' };

function buildPath(values, w, h, padTop, padBottom) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = w / (values.length - 1);
  const pts = values.map((v, i) => {
    const x = i * stepX;
    const y = padTop + (1 - (v - min) / range) * (h - padTop - padBottom);
    return { x, y, value: v };
  });
  const line = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' ');
  const area = line + ` L${pts[pts.length - 1].x.toFixed(1)},${h - padBottom} L${pts[0].x.toFixed(1)},${h - padBottom} Z`;
  return { line, area, points: pts };
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

function segmentTabStyle(active) {
  return {
    border: 'none',
    background: active ? 'white' : 'none',
    color: active ? 'oklch(24% 0.05 240)' : 'oklch(52% 0.02 240)',
    boxShadow: active ? '0 1px 3px oklch(0% 0 0 / 0.08)' : 'none',
    padding: '9px 18px',
    borderRadius: '9px',
    fontSize: '13.5px',
    fontWeight: 700,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    flexShrink: 0,
    fontFamily: "'Manrope',sans-serif",
  };
}

function Switch({ on, onClick }) {
  const s = switchStyle(on);
  return (
    <button onClick={onClick} style={s.track}>
      <span style={s.thumb} />
    </button>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile(900);
  const { station, statusMeta, stationColor, stationOptions, stationMenuOpen, toggleStationMenu, closeStationMenu, stations, createStation, deleteStation, loading: stationLoading } = useStationSelector();
  const { latest, readings } = useTelemetry(station?.id);
  const { devices } = useDevices();
  const settings = useUserSettings(station?.id);
  const { loads: stationLoads, addLoad, removeLoad, setLoadState } = useLoads(station?.id);
  const { user, signOut, listIdentities, linkGoogle, unlinkIdentity } = useAuth();

  // Form "+ Thêm tải" trong Điều khiển tải.
  const [loadFormOpen, setLoadFormOpen] = useState(false);
  const [newLoadName, setNewLoadName] = useState('');
  const [newLoadWatt, setNewLoadWatt] = useState('');
  const [newLoadDeviceId, setNewLoadDeviceId] = useState('');
  const [loadFormSaving, setLoadFormSaving] = useState(false);
  const [loadFormError, setLoadFormError] = useState('');
  const [loadCommandError, setLoadCommandError] = useState('');

  // Form "Thêm trạm mới" + xác nhận xóa trạm, dùng trong Cài đặt → Hệ thống.
  const [newStationName, setNewStationName] = useState('');
  const [newStationLocation, setNewStationLocation] = useState('');
  const [stationFormSaving, setStationFormSaving] = useState(false);
  const [stationFormError, setStationFormError] = useState('');
  const [confirmDeleteStationId, setConfirmDeleteStationId] = useState(null);

  // Nhịp cập nhật để tính lại độ "cũ" của telemetry theo thời gian thực.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 20000);
    return () => clearInterval(id);
  }, []);
  const avatarUrl = userAvatarUrl(user);

  // Mục cần mở khi vào trang, theo 2 nguồn:
  //  - `state.view`: điều hướng từ trang Báo cáo/Pin lưu trữ (các trang này
  //    nằm ở route riêng nên phải gửi kèm mục đã bấm);
  //  - `?view=settings`: quay lại thẳng tab Cài đặt sau khi OAuth redirect về
  //    (luồng liên kết Google) — đọc 1 lần lúc mount rồi xóa param khỏi URL
  //    để refresh sau đó không kẹt lại ở view này.
  const initialNav = location.state?.view
    || (new URLSearchParams(window.location.search).get('view') === 'settings' ? 'settings' : 'overview');
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
  // Module "Điều khiển tải"/"Cảnh báo" có thể bị ẩn riêng cho từng trạm —
  // nếu đang xem 1 trong 2 view đó rồi chuyển sang trạm đã ẩn module tương
  // ứng, quay lại view Dashboard thay vì tiếp tục hiển thị view đáng lẽ đã ẩn.
  useEffect(() => {
    if (settings.loading) return;
    if (currentView === 'load' && settings.moduleVisibility.load === false) setCurrentView('dashboard');
    if (currentView === 'alerts' && settings.moduleVisibility.alerts === false) setCurrentView('dashboard');
  }, [currentView, settings.loading, settings.moduleVisibility.load, settings.moduleVisibility.alerts]);
  const [energyUnit, setEnergyUnit] = useState('kWh');
  const [hoverIdx, setHoverIdx] = useState(null);
  // Số điểm hiển thị trên biểu đồ khi đã zoom (null = hiện hết `readings`).
  // Lăn chuột lên biểu đồ thu hẹp/mở rộng cửa sổ này (xem onChartWheel).
  const [zoomCount, setZoomCount] = useState(null);
  // Lăn chuột trên biểu đồ để zoom: lăn lên (deltaY < 0) = phóng to (thu hẹp
  // dải thời gian, ít điểm hơn), lăn xuống = thu nhỏ về lại toàn bộ readings.
  // Dùng callback ref (thay vì useRef+useEffect) để gắn listener "native"
  // đúng lúc div biểu đồ mount — cần native vì React coi wheel event là
  // passive theo mặc định, preventDefault() qua prop onWheel sẽ không chặn
  // được cuộn trang, khiến vừa zoom biểu đồ vừa cuộn cả trang.
  const readingsLenRef = useRef(readings.length);
  readingsLenRef.current = readings.length;
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
  const [readAlertIds, setReadAlertIds] = useState(() => new Set());

  const [profile, setProfile] = useState(null);
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [profileSaving, setProfileSaving] = useState(false);

  const avatarInputRef = useRef(null);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarError, setAvatarError] = useState('');

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [passwordSuccess, setPasswordSuccess] = useState('');

  // Danh sách phương thức đăng nhập đã liên kết với tài khoản. null = chưa
  // tải xong / tải hỏng — cả hai đều KHÔNG được suy ra là "chưa có mật khẩu",
  // vì nhánh đặt mật khẩu bỏ qua bước xác thực mật khẩu cũ. Tải hỏng thì khóa
  // cả hai thẻ lại thay vì đoán sai theo hướng lỏng hơn.
  const [identities, setIdentities] = useState(null);
  const [identitiesFailed, setIdentitiesFailed] = useState(false);
  const [identityBusy, setIdentityBusy] = useState('');
  const [identityError, setIdentityError] = useState('');
  const [identitySuccess, setIdentitySuccess] = useState('');
  const [confirmUnlinkId, setConfirmUnlinkId] = useState(null);

  const refreshIdentities = useCallback(async () => {
    const { data, error } = await listIdentities();
    if (error) {
      setIdentities(null);
      setIdentitiesFailed(true);
      return;
    }
    setIdentitiesFailed(false);
    setIdentities(data?.identities ?? []);
  }, [listIdentities]);

  useEffect(() => {
    if (!user) return;
    refreshIdentities();
  }, [user, refreshIdentities]);

  // Xử lý kết quả quay về từ OAuth liên kết Google. Supabase gắn lỗi vào
  // query string (luồng PKCE) hoặc hash fragment (luồng implicit) nên phải
  // đọc cả hai. Xong thì dọn URL để F5 sau đó không lặp lại thông báo.
  useEffect(() => {
    const search = new URLSearchParams(window.location.search);
    if (!search.has('view')) return;
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const oauthError = search.get('error_description') || search.get('error') || hash.get('error_description') || hash.get('error');
    if (oauthError) {
      setIdentityError(identityErrorText({ message: decodeURIComponent(oauthError) }));
    }
    window.history.replaceState({}, '', window.location.pathname);
  }, []);

  const identitiesLoading = identities === null && !identitiesFailed;
  const hasEmailIdentity = !!identities?.some((i) => i.provider === 'email');
  const hasGoogleIdentity = !!identities?.some((i) => i.provider === 'google');
  // Supabase chặn gỡ identity cuối cùng (sẽ không còn cách nào đăng nhập).
  const canUnlink = (identities?.length ?? 0) >= 2;

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

  // Hai chế độ dùng chung 1 form:
  //  - Đã có đăng nhập email/mật khẩu → đổi mật khẩu, bắt xác thực lại bằng
  //    mật khẩu hiện tại (signInWithPassword vừa kiểm tra mật khẩu cũ đúng
  //    không, vừa cấp session mới hợp lệ — cùng user nên không đá phiên hiện tại).
  //  - Tài khoản chỉ có Google → đặt mật khẩu lần đầu để mở thêm cách đăng
  //    nhập bằng email; không có mật khẩu cũ nên bỏ qua bước xác thực lại.
  async function handleChangePassword() {
    setPasswordError('');
    setPasswordSuccess('');
    if (newPassword.length < 6) {
      setPasswordError('Mật khẩu mới phải có ít nhất 6 ký tự.');
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setPasswordError('Xác nhận mật khẩu mới không khớp.');
      return;
    }
    setPasswordSaving(true);
    if (hasEmailIdentity) {
      const { error: reauthError } = await supabase.auth.signInWithPassword({ email: user.email, password: currentPassword });
      if (reauthError) {
        setPasswordSaving(false);
        setPasswordError('Mật khẩu hiện tại không đúng.');
        return;
      }
    }
    const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
    setPasswordSaving(false);
    if (updateError) {
      setPasswordError(updateError.message);
      return;
    }
    setPasswordSuccess(hasEmailIdentity ? 'Đã cập nhật mật khẩu.' : 'Đã đặt mật khẩu — từ giờ bạn có thể đăng nhập bằng email và mật khẩu này.');
    setCurrentPassword('');
    setNewPassword('');
    setConfirmNewPassword('');
    // Đặt mật khẩu lần đầu có thể sinh thêm identity `email` — tải lại danh
    // sách để thẻ "Phương thức đăng nhập" phản ánh đúng.
    refreshIdentities();
  }

  // linkIdentity chuyển hướng sang Google rồi quay lại `?view=settings`, nên
  // chỉ cần xử lý nhánh lỗi ở đây — thành công thì trang đã rời đi.
  async function handleLinkGoogle() {
    setIdentityError('');
    setIdentitySuccess('');
    setIdentityBusy('link');
    const { error } = await linkGoogle();
    if (error) {
      setIdentityBusy('');
      setIdentityError(identityErrorText(error));
    }
  }

  async function handleUnlinkIdentity(identity) {
    if (confirmUnlinkId !== identity.identity_id) {
      setConfirmUnlinkId(identity.identity_id);
      return;
    }
    setConfirmUnlinkId(null);
    setIdentityError('');
    setIdentitySuccess('');
    setIdentityBusy(identity.identity_id);
    const { error } = await unlinkIdentity(identity);
    setIdentityBusy('');
    if (error) {
      setIdentityError(identityErrorText(error));
      return;
    }
    setIdentitySuccess(`Đã gỡ liên kết ${PROVIDER_META[identity.provider]?.label ?? identity.provider}.`);
    refreshIdentities();
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
          : `${load.name} chưa gắn thiết bị điều khiển — vào Quản lý trạm để gắn ESP32.`,
      );
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

  // --- Telemetry thật cho các ô thông số ---
  // Giá trị lấy trực tiếp từ bản tin gần nhất; khi chưa có → null → hiển thị "--".
  const solarKw = latest?.solarKw;
  const batteryPct = latest?.batteryPct;
  const batteryVoltage = latest?.batteryVoltage;
  const tempC = latest?.tempC;
  const hasT = !!latest;
  const latestMs = latest ? new Date(latest.ts).getTime() : null;
  const isStale = latestMs != null && now - latestMs > STALE_MS;
  const updatedLabel = latest ? fmtClock(latest.ts) : null;

  const W = 640, H = 220, PAD_TOP = 14, PAD_BOTTOM = 28;

  // Zoom bằng lăn chuột: zoomCount là số điểm gần nhất còn hiển thị (null =
  // hiện hết). Kẹp trong [MIN_ZOOM_POINTS, readings.length] mỗi lần render vì
  // readings có thể co giãn theo thời gian (dữ liệu mới append qua realtime).
  const zoomedReadingCount = zoomCount == null ? readings.length : Math.min(zoomCount, readings.length);
  const visibleReadings = readings.slice(-zoomedReadingCount);
  const isZoomed = zoomedReadingCount < readings.length;

  // Biểu đồ dựng từ chuỗi telemetry thật (cũ → mới). Cần >= 2 điểm để vẽ.
  const chartLabels = visibleReadings.map((r) => fmtClock(r.ts));
  const scaledPower = visibleReadings.map((r) => Math.round((r.solarKw ?? 0) * 1000));
  const scaledVoltage = visibleReadings.map((r) => +(r.batteryVoltage ?? 0).toFixed(1));
  const scaledCurrent = visibleReadings.map((r) => {
    const v = r.batteryVoltage || station.batteryVoltage || 1;
    return +(((r.solarKw ?? 0) * 1000 - (r.loadW ?? 0)) / v).toFixed(1);
  });
  const hasChart = visibleReadings.length >= 2;

  const power = hasChart ? buildPath(scaledPower, W, H, PAD_TOP, PAD_BOTTOM) : null;
  const voltage = hasChart ? buildPath(scaledVoltage, W, H, PAD_TOP, PAD_BOTTOM) : null;
  const current = hasChart ? buildPath(scaledCurrent, W, H, PAD_TOP, PAD_BOTTOM) : null;

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

  const hoverActive = hasChart && hoverIdx != null && hoverIdx <= lastIdx;
  const activeIdx = hoverActive ? hoverIdx : lastIdx;
  const hoverX = hoverActive ? power.points[hoverIdx].x : 0;
  const hoverPowerY = hoverActive ? power.points[hoverIdx].y : 0;
  const hoverVoltageY = hoverActive ? voltage.points[hoverIdx].y : 0;
  const hoverCurrentY = hoverActive ? current.points[hoverIdx].y : 0;

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


  const activeLoadCount = loads.filter((l) => l.on).length;
  const totalLoadW = loads.filter((l) => l.on).reduce((a, l) => a + l.watt, 0);
  const totalLoadKw = (totalLoadW / 1000).toFixed(2);

  const solarW = (solarKw ?? 0) * 1000;
  const netBusW = solarW - totalLoadW;
  const busVoltage = batteryVoltage || station.batteryVoltage || 1;
  // Không có telemetry hoặc trạm offline → không xác định được dòng DC bus.
  const dcBusCurrent = !hasT || station.status === 'offline' ? null : netBusW / busVoltage;
  let batteryFlowState = 'idle';
  if (!hasT || station.status === 'offline') batteryFlowState = 'unknown';
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
  const solarFlowing = hasT && station.status !== 'offline' && !chargeBlocked && (solarKw ?? 0) > 0.05;
  const loadFlowing = hasT && station.status !== 'offline' && !dischargeBlocked && Number(totalLoadKw) > 0;
  const statusLabelText = station.status === 'online' ? 'Ổn định' : station.status === 'warning' ? 'Cảnh báo' : 'Mất kết nối';
  const statusFontSize = statusLabelText.length > 9 ? '22px' : statusLabelText.length > 7 ? '26px' : '30px';

  const stationAlerts = [];
  if (station.status === 'offline') {
    stationAlerts.push({ id: `station-${station.id}-offline`, severity: 'danger', msg: `Trạm ${station.name} mất kết nối với server giám sát`, time: 'Vừa cập nhật' });
  } else if (station.status === 'warning') {
    stationAlerts.push({ id: `station-${station.id}-warning`, severity: 'warning', msg: `Trạm ${station.name} đang có cảnh báo hiệu suất thấp`, time: 'Vừa cập nhật' });
  }
  const alerts = [...stationAlerts, ...ALERTS_DATA.map((a, i) => ({ ...a, id: `alert-${i}` }))];
  const unreadAlerts = alerts.filter((a) => !readAlertIds.has(a.id));
  const latestUnread = unreadAlerts.slice(0, 5);

  function markAlertRead(id) {
    setReadAlertIds((prev) => new Set(prev).add(id));
  }
  function markAllAlertsRead() {
    setReadAlertIds(new Set(alerts.map((a) => a.id)));
  }

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
  const pageTitle = isSettingsView ? 'Cài đặt' : isLoadView ? 'Điều khiển tải' : isAlertsView ? 'Cảnh báo' : 'Giám sát hệ thống';

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
                <span style={{ whiteSpace: 'nowrap' }}>· Cập nhật lúc 15:42, 01/07/2026</span>
              </div>
            )}
            {isSettingsView && (
              <div style={{ fontSize: '13.5px', color: 'oklch(50% 0.02 240)' }}>Quản lý tài khoản và cấu hình hệ thống</div>
            )}
            {isLoadView && (
              <div style={{ fontSize: '13.5px', color: 'oklch(50% 0.02 240)' }}>Bật/tắt và giám sát các thiết bị tiêu thụ điện</div>
            )}
            {isAlertsView && (
              <div style={{ fontSize: '13.5px', color: 'oklch(50% 0.02 240)' }}>Toàn bộ cảnh báo và sự cố của hệ thống</div>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
            <div style={{ position: 'relative' }}>
              <button onClick={() => setNotifOpen((v) => !v)} title="Thông báo" aria-label="Thông báo" style={{ position: 'relative', width: '38px', height: '38px', borderRadius: '10px', background: notifOpen ? 'oklch(96% 0.01 240)' : 'white', border: '1px solid oklch(90% 0.01 240)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0 }}>
                <svg width="17" height="17" viewBox="0 0 20 20"><path d="M10 3c-2.2 0-3.6 1.7-3.6 4v2.3c0 .6-.2 1.2-.6 1.7l-1 1.3h10.4l-1-1.3c-.4-.5-.6-1.1-.6-1.7V7c0-2.3-1.4-4-3.6-4z" fill="none" stroke="oklch(30% 0.03 240)" strokeWidth="1.5" strokeLinejoin="round" /></svg>
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
                            key={item.id}
                            onClick={() => { markAlertRead(item.id); navigateTo('alerts'); }}
                            style={{ display: 'flex', gap: '10px', width: '100%', textAlign: 'left', padding: '13px 16px', background: 'none', border: 'none', borderBottom: '1px solid oklch(95% 0.006 240)', cursor: 'pointer', fontFamily: "'Manrope',sans-serif" }}
                          >
                            <span style={{ width: '8px', height: '8px', borderRadius: '50%', marginTop: '5px', flexShrink: 0, background: SEVERITY_COLOR[item.severity] }} />
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontSize: '13px', color: 'oklch(26% 0.03 240)', lineHeight: 1.45 }}>{item.msg}</div>
                              <div style={{ fontSize: '11.5px', color: 'oklch(58% 0.02 240)', marginTop: '2px' }}>{item.time}</div>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                    <button onClick={() => navigateTo('alerts')} style={{ display: 'block', width: '100%', textAlign: 'center', padding: '12px', background: 'oklch(98% 0.004 240)', border: 'none', borderTop: '1px solid oklch(94% 0.008 240)', fontSize: '12.5px', fontWeight: 700, color: BLUE, cursor: 'pointer', fontFamily: "'Manrope',sans-serif" }}>Xem tất cả cảnh báo →</button>
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
              <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '28px', fontWeight: 500, color: 'oklch(20% 0.03 240)' }}>{fmtNum(solarKw, 1)} <span style={{ fontSize: '15px', color: 'oklch(55% 0.02 240)' }}>kW</span></div>
              <div style={{ fontSize: '12.5px', marginTop: '6px', fontWeight: 600, color: !hasT ? 'oklch(58% 0.02 240)' : 'oklch(64% 0.15 150)' }}>{!hasT ? 'Chưa có dữ liệu' : '↑ 12% so với giờ trước'}</div>
              <StaleNote show={isStale} label={updatedLabel} />
            </div>

            <div style={{ ...cardStyle, ...place(2, 1) }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
                <span style={{ fontSize: '13px', color: 'oklch(52% 0.02 240)', fontWeight: 600 }}>Tải tiêu thụ</span>
                <div style={{ width: '30px', height: '30px', borderRadius: '8px', background: 'oklch(93% 0.03 240)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <svg width="15" height="15" viewBox="0 0 20 20"><circle cx="10" cy="10" r="7.5" fill="none" stroke={BLUE} strokeWidth="1.6" /><line x1="10" y1="5.2" x2="10" y2="10" stroke={BLUE} strokeWidth="1.6" strokeLinecap="round" /></svg>
                </div>
              </div>
              <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '28px', fontWeight: 500, color: 'oklch(20% 0.03 240)' }}>{totalLoadKw} <span style={{ fontSize: '15px', color: 'oklch(55% 0.02 240)' }}>kW</span></div>
              <div style={{ fontSize: '12.5px', color: 'oklch(52% 0.02 240)', marginTop: '6px' }}>{activeLoadCount} thiết bị đang bật</div>
            </div>

            <div style={{ ...cardStyle, ...place(2, 2) }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
                <span style={{ fontSize: '13px', color: 'oklch(52% 0.02 240)', fontWeight: 600 }}>Dòng DC bus</span>
                <div style={{ width: '30px', height: '30px', borderRadius: '8px', background: flowMeta.bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <span style={{ fontSize: '16px', fontWeight: 700, color: flowMeta.color, lineHeight: 1 }}>{flowMeta.arrow}</span>
                </div>
              </div>
              <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '28px', fontWeight: 500, color: 'oklch(20% 0.03 240)' }}>{dcBusCurrent == null ? '--' : (dcBusCurrent >= 0 ? '+' : '') + dcBusCurrent.toFixed(1)} <span style={{ fontSize: '15px', color: 'oklch(55% 0.02 240)' }}>A</span></div>
              <div style={{ fontSize: '12.5px', color: 'oklch(52% 0.02 240)', marginTop: '6px' }}>Nút liên kết BMS/inverter</div>
              <StaleNote show={isStale} label={updatedLabel} />
            </div>

            <div style={{ ...cardStyle, ...place(1, 2) }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
                <span style={{ fontSize: '13px', color: 'oklch(52% 0.02 240)', fontWeight: 600 }}>Trạng thái hệ thống</span>
                <div style={{ width: '32px', height: '32px', borderRadius: '9px', background: statusMeta.bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <svg width="15" height="15" viewBox="0 0 20 20"><path d="M4 10l4 4 8-8" fill="none" stroke={statusMeta.textColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </div>
              </div>
              <div style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: statusFontSize, fontWeight: 700, color: statusMeta.textColor, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{statusLabelText}</div>
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
                  <div style={{ fontSize: '11.5px', color: 'oklch(52% 0.02 240)' }}>Sức khỏe pin</div>
                  <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '15px', fontWeight: 600, color: 'oklch(64% 0.15 150)' }}>96%</div>
                </div>
                <div style={{ textAlign: 'center', padding: '10px', background: 'oklch(97% 0.005 240)', borderRadius: '10px' }}>
                  <div style={{ fontSize: '11.5px', color: 'oklch(52% 0.02 240)' }}>Nhiệt độ</div>
                  <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '15px', fontWeight: 600 }}>{tempC == null ? '--' : Math.round(tempC) + '°C'}</div>
                </div>
                <div style={{ textAlign: 'center', padding: '10px', background: 'oklch(97% 0.005 240)', borderRadius: '10px' }}>
                  <div style={{ fontSize: '11.5px', color: 'oklch(52% 0.02 240)' }}>Chu kỳ sạc</div>
                  <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '15px', fontWeight: 600 }}>214</div>
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
                <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '15px', color: 'oklch(75% 0.14 70)', fontWeight: 600, marginTop: '2px' }}>{solarKw == null ? '--' : solarKw.toFixed(1) + ' kW'}</div>
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
                <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '15px', color: 'oklch(30% 0.03 240)', fontWeight: 600, marginTop: '2px' }}>{totalLoadKw} kW</div>
              </div>
            </div>
          </div>
          )}

          {/* CHART */}
          {moduleOn('chart') && (
          <div style={{ marginBottom: '20px' }}>
            <div id="sec-chart" style={{ scrollMarginTop: '24px', ...sectionCardStyle }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px', flexWrap: 'wrap', gap: '10px' }}>
                <h2 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '17px', fontWeight: 700, margin: 0 }}>Biểu đồ thời gian thực</h2>
                <div style={{ display: 'flex', gap: '14px', fontSize: '12px' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}><span style={{ width: '8px', height: '8px', borderRadius: '2px', background: BLUE, display: 'inline-block' }} />Công suất (W)</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}><span style={{ width: '8px', height: '8px', borderRadius: '2px', background: 'oklch(75% 0.14 70)', display: 'inline-block' }} />Điện áp (V)</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}><span style={{ width: '8px', height: '8px', borderRadius: '2px', background: 'oklch(60% 0.13 180)', display: 'inline-block' }} />Dòng điện (A)</span>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '14px' }}>
                <p style={{ fontSize: '12.5px', color: 'oklch(52% 0.02 240)', margin: 0, display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
                  {hasChart ? (
                    <>
                      <span>{isZoomed ? `${visibleReadings.length}/${readings.length} điểm (đã zoom)` : `${readings.length} điểm gần nhất`} · {hoverActive ? 'tại' : 'mới nhất ·'} <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontWeight: 600, color: 'oklch(30% 0.02 240)' }}>{hoverActive ? fmtClockSec(visibleReadings[activeIdx]?.ts) : chartLabels[activeIdx]}</span></span>
                      {isZoomed && (
                        <button onClick={resetZoom} style={{ font: 'inherit', fontWeight: 600, color: BLUE, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>Đặt lại zoom</button>
                      )}
                    </>
                  ) : 'Chưa có dữ liệu telemetry'}
                </p>
                {hasChart && (
                <div style={{ display: 'flex', gap: '16px', fontFamily: "'IBM Plex Mono',monospace", fontSize: '12.5px' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '5px', color: 'oklch(46% 0.14 240)', fontWeight: 600 }}><span style={{ width: '7px', height: '7px', borderRadius: '50%', background: BLUE, display: 'inline-block' }} />{scaledPower[activeIdx]} W</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '5px', color: 'oklch(52% 0.13 70)', fontWeight: 600 }}><span style={{ width: '7px', height: '7px', borderRadius: '50%', background: 'oklch(75% 0.14 70)', display: 'inline-block' }} />{scaledVoltage[activeIdx].toFixed(1)} V</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '5px', color: 'oklch(46% 0.12 180)', fontWeight: 600 }}><span style={{ width: '7px', height: '7px', borderRadius: '50%', background: 'oklch(60% 0.13 180)', display: 'inline-block' }} />{scaledCurrent[activeIdx].toFixed(1)} A</span>
                </div>
                )}
              </div>

              {hasChart ? (
              <div ref={chartWheelRef} title="Lăn chuột để phóng to/thu nhỏ" style={{ position: 'relative', width: '100%' }}>
                <svg viewBox="0 0 640 220" width="100%" height="220" preserveAspectRatio="none" style={{ display: 'block', overflow: 'visible', cursor: 'crosshair' }}>
                  <line x1="0" y1="14" x2="640" y2="14" stroke="oklch(94% 0.008 240)" strokeWidth="1" />
                  <line x1="0" y1="97" x2="640" y2="97" stroke="oklch(94% 0.008 240)" strokeWidth="1" />
                  <line x1="0" y1="180" x2="640" y2="180" stroke="oklch(94% 0.008 240)" strokeWidth="1" />
                  <path d={power.area} fill="oklch(54% 0.15 240 / 0.12)" stroke="none" />
                  <path d={power.line} fill="none" stroke={BLUE} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
                  <path d={voltage.line} fill="none" stroke="oklch(75% 0.14 70)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
                  <path d={current.line} fill="none" stroke="oklch(60% 0.13 180)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

                  <g pointerEvents="none">
                    {hoverActive && (
                      <line x1={hoverX} y1="6" x2={hoverX} y2="192" stroke="oklch(55% 0.03 240)" strokeWidth="1" strokeDasharray="3,3" />
                    )}
                  </g>

                  <rect x="0" y="0" width="640" height="192" fill="transparent" onMouseMove={onChartMouseMove} onMouseLeave={onChartMouseLeave} />
                </svg>

                {hoverActive && (
                  <>
                    <span style={{ position: 'absolute', left: (hoverX / 640) * 100 + '%', top: hoverPowerY + 'px', width: '11px', height: '11px', borderRadius: '50%', background: 'white', border: `2.5px solid ${BLUE}`, boxSizing: 'border-box', transform: 'translate(-50%, -50%)', pointerEvents: 'none' }} />
                    <span style={{ position: 'absolute', left: (hoverX / 640) * 100 + '%', top: hoverVoltageY + 'px', width: '10px', height: '10px', borderRadius: '50%', background: 'white', border: '2.2px solid oklch(75% 0.14 70)', boxSizing: 'border-box', transform: 'translate(-50%, -50%)', pointerEvents: 'none' }} />
                    <span style={{ position: 'absolute', left: (hoverX / 640) * 100 + '%', top: hoverCurrentY + 'px', width: '10px', height: '10px', borderRadius: '50%', background: 'white', border: '2.2px solid oklch(60% 0.13 180)', boxSizing: 'border-box', transform: 'translate(-50%, -50%)', pointerEvents: 'none' }} />
                  </>
                )}

                {axisXTicks.map((tick, i) => (
                  <span key={`${tick.label}-${i}`} style={{ position: 'absolute', left: tick.leftPct + '%', top: '200px', transform: 'translateX(-50%)', whiteSpace: 'nowrap', fontFamily: "'IBM Plex Mono',monospace", fontSize: '11px', color: 'oklch(58% 0.02 240)', pointerEvents: 'none' }}>{tick.label}</span>
                ))}
              </div>
              ) : (
                <div style={{ height: '220px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '6px', color: 'oklch(58% 0.02 240)', background: 'oklch(98% 0.004 240)', borderRadius: '12px', border: '1px dashed oklch(88% 0.01 240)' }}>
                  <div style={{ fontSize: '14px', fontWeight: 600 }}>Chưa có dữ liệu telemetry để vẽ biểu đồ</div>
                  <div style={{ fontSize: '12px' }}>Biểu đồ sẽ hiển thị khi thiết bị gửi dữ liệu về (cần tối thiểu 2 điểm).</div>
                </div>
              )}
            </div>
          </div>
          )}

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
              <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '28px', fontWeight: 500, color: 'oklch(20% 0.03 240)' }}>{totalLoadKw} <span style={{ fontSize: '15px', color: 'oklch(55% 0.02 240)' }}>kW</span></div>
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
                        <div style={{ fontSize: '12px', color: 'oklch(52% 0.02 240)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {item.watt}W · {item.on ? 'Đang bật' : 'Đã tắt'}
                          {!item.deviceId && ' · chưa gắn thiết bị'}
                        </div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexShrink: 0 }}>
                      <Switch on={item.on} onClick={() => toggleLoad(item)} />
                      <button onClick={() => handleRemoveLoad(item.id)} title="Xóa tải" aria-label={`Xóa ${item.name}`} style={{ background: 'none', border: 'none', color: 'oklch(58% 0.19 25)', cursor: 'pointer', padding: '4px', fontSize: '12.5px', fontWeight: 600, fontFamily: "'Manrope',sans-serif" }}>Xóa</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {isAlertsView && (
        <div style={{ maxWidth: '760px' }}>
          <div style={sectionCardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', gap: '12px', flexWrap: 'wrap' }}>
              <h2 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '17px', fontWeight: 700, margin: 0 }}>Tất cả cảnh báo</h2>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span style={{ fontSize: '12.5px', color: 'oklch(52% 0.02 240)' }}>{unreadAlerts.length} chưa đọc · {alerts.length} tổng</span>
                {unreadAlerts.length > 0 && (
                  <button onClick={markAllAlertsRead} style={{ background: 'none', border: 'none', fontSize: '12.5px', fontWeight: 600, color: BLUE, cursor: 'pointer', padding: 0, fontFamily: "'Manrope',sans-serif" }}>Đánh dấu tất cả đã đọc</button>
                )}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {alerts.map((item) => {
                const unread = !readAlertIds.has(item.id);
                return (
                  <div key={item.id} onClick={() => markAlertRead(item.id)} style={{ display: 'flex', gap: '12px', padding: '14px 4px', borderBottom: '1px solid oklch(95% 0.006 240)', cursor: unread ? 'pointer' : 'default', opacity: unread ? 1 : 0.55 }}>
                    <span style={{ width: '9px', height: '9px', borderRadius: '50%', marginTop: '5px', flexShrink: 0, background: SEVERITY_COLOR[item.severity] }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '13.5px', color: 'oklch(26% 0.03 240)', lineHeight: 1.5 }}>{item.msg}</div>
                      <div style={{ fontSize: '11.5px', color: 'oklch(58% 0.02 240)', marginTop: '2px' }}>{item.time}</div>
                    </div>
                    {unread && <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: BLUE, marginTop: '6px', flexShrink: 0 }} />}
                  </div>
                );
              })}
            </div>
          </div>
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
                <h2 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '16px', fontWeight: 700, margin: '0 0 6px' }}>{hasEmailIdentity ? 'Đổi mật khẩu' : 'Đặt mật khẩu'}</h2>
                <p style={{ fontSize: '13px', color: 'oklch(52% 0.02 240)', margin: '0 0 18px' }}>
                  {hasEmailIdentity
                    ? 'Nhập mật khẩu hiện tại để xác thực trước khi đổi.'
                    : `Tài khoản đang đăng nhập bằng Google. Đặt một mật khẩu để đăng nhập thêm được bằng email ${user.email}.`}
                </p>
                {identitiesLoading ? (
                  <p style={{ fontSize: '13px', color: 'oklch(52% 0.02 240)', margin: 0 }}>Đang tải…</p>
                ) : identitiesFailed ? (
                  <p style={{ fontSize: '13px', color: 'oklch(50% 0.18 25)', background: 'oklch(93% 0.06 25)', borderRadius: '8px', padding: '10px 12px', margin: 0 }}>Không tải được thông tin tài khoản nên tạm khóa thao tác mật khẩu. Tải lại trang để thử lại.</p>
                ) : (
                  <>
                    {hasEmailIdentity && (
                      <div style={{ marginBottom: '16px' }}>
                        <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: 'oklch(32% 0.03 240)', marginBottom: '7px' }}>Mật khẩu hiện tại</label>
                        <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} placeholder="••••••••" style={{ width: '100%', boxSizing: 'border-box', padding: '11px 13px', borderRadius: '9px', border: '1px solid oklch(88% 0.01 240)', fontSize: '14px', fontFamily: "'Manrope',sans-serif" }} />
                      </div>
                    )}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '20px' }}>
                      <div>
                        <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: 'oklch(32% 0.03 240)', marginBottom: '7px' }}>{hasEmailIdentity ? 'Mật khẩu mới' : 'Mật khẩu'}</label>
                        <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} minLength={6} placeholder="••••••••" style={{ width: '100%', boxSizing: 'border-box', padding: '11px 13px', borderRadius: '9px', border: '1px solid oklch(88% 0.01 240)', fontSize: '14px', fontFamily: "'Manrope',sans-serif" }} />
                      </div>
                      <div>
                        <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: 'oklch(32% 0.03 240)', marginBottom: '7px' }}>{hasEmailIdentity ? 'Xác nhận mật khẩu mới' : 'Xác nhận mật khẩu'}</label>
                        <input type="password" value={confirmNewPassword} onChange={(e) => setConfirmNewPassword(e.target.value)} minLength={6} placeholder="••••••••" style={{ width: '100%', boxSizing: 'border-box', padding: '11px 13px', borderRadius: '9px', border: '1px solid oklch(88% 0.01 240)', fontSize: '14px', fontFamily: "'Manrope',sans-serif" }} />
                      </div>
                    </div>
                    {passwordError && (
                      <p style={{ fontSize: '13px', color: 'oklch(50% 0.18 25)', background: 'oklch(93% 0.06 25)', borderRadius: '8px', padding: '10px 12px', margin: '0 0 16px' }}>{passwordError}</p>
                    )}
                    {passwordSuccess && (
                      <p style={{ fontSize: '13px', color: 'oklch(50% 0.14 150)', background: 'oklch(93% 0.06 150)', borderRadius: '8px', padding: '10px 12px', margin: '0 0 16px' }}>{passwordSuccess}</p>
                    )}
                    {(() => {
                      const incomplete = !newPassword || !confirmNewPassword || (hasEmailIdentity && !currentPassword);
                      return (
                        <button onClick={handleChangePassword} disabled={passwordSaving || incomplete} style={{ padding: '11px 20px', borderRadius: '9px', border: 'none', background: BLUE, color: 'white', fontSize: '14px', fontWeight: 700, cursor: 'pointer', fontFamily: "'Manrope',sans-serif", opacity: (passwordSaving || incomplete) ? 0.7 : 1 }}>
                          {passwordSaving ? 'Đang lưu…' : hasEmailIdentity ? 'Cập nhật mật khẩu' : 'Đặt mật khẩu'}
                        </button>
                      );
                    })()}
                  </>
                )}
              </div>

              <div style={{ ...sectionCardStyle, marginBottom: '20px' }}>
                <h2 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '16px', fontWeight: 700, margin: '0 0 6px' }}>Phương thức đăng nhập</h2>
                <p style={{ fontSize: '13px', color: 'oklch(52% 0.02 240)', margin: '0 0 16px' }}>Liên kết nhiều cách đăng nhập vào cùng một tài khoản. Phải giữ lại ít nhất một phương thức.</p>

                {identitiesLoading ? (
                  <p style={{ fontSize: '13px', color: 'oklch(52% 0.02 240)', margin: 0 }}>Đang tải…</p>
                ) : identitiesFailed ? (
                  <p style={{ fontSize: '13px', color: 'oklch(50% 0.18 25)', background: 'oklch(93% 0.06 25)', borderRadius: '8px', padding: '10px 12px', margin: 0 }}>Không tải được danh sách phương thức đăng nhập. Tải lại trang để thử lại.</p>
                ) : (
                  <>
                    <div style={{ display: 'flex', flexDirection: 'column', marginBottom: '16px' }}>
                      {identities.map((identity) => {
                        const meta = PROVIDER_META[identity.provider];
                        const confirming = confirmUnlinkId === identity.identity_id;
                        const busy = identityBusy === identity.identity_id;
                        return (
                          <div key={identity.identity_id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', padding: '12px 0', borderBottom: '1px solid oklch(95% 0.006 240)' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
                              {identity.provider === 'google' ? (
                                <GoogleIcon />
                              ) : (
                                <div style={{ width: '22px', height: '22px', borderRadius: '50%', background: BLUE, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: 700, color: 'white', flexShrink: 0 }}>@</div>
                              )}
                              <div style={{ minWidth: 0 }}>
                                <div style={{ fontSize: '14px', fontWeight: 600 }}>{meta?.label ?? identity.provider}</div>
                                <div style={{ fontSize: '12.5px', color: 'oklch(52% 0.02 240)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{identity.identity_data?.email ?? user.email}</div>
                              </div>
                              <span style={{ fontSize: '11.5px', fontWeight: 700, color: 'oklch(50% 0.14 150)', background: 'oklch(93% 0.06 150)', padding: '3px 9px', borderRadius: '20px', flexShrink: 0 }}>Đã liên kết</span>
                            </div>
                            <button
                              onClick={() => handleUnlinkIdentity(identity)}
                              onBlur={() => setConfirmUnlinkId((cur) => (cur === identity.identity_id ? null : cur))}
                              disabled={!canUnlink || busy}
                              title={canUnlink ? undefined : 'Không thể gỡ phương thức đăng nhập cuối cùng'}
                              style={{ padding: '7px 14px', borderRadius: '8px', border: confirming ? '1px solid oklch(58% 0.19 25)' : '1px solid oklch(88% 0.01 240)', background: confirming ? 'oklch(93% 0.06 25)' : 'white', fontSize: '12.5px', fontWeight: 600, color: confirming ? 'oklch(50% 0.18 25)' : 'oklch(45% 0.02 240)', cursor: canUnlink && !busy ? 'pointer' : 'not-allowed', opacity: canUnlink && !busy ? 1 : 0.5, flexShrink: 0, whiteSpace: 'nowrap', fontFamily: "'Manrope',sans-serif" }}
                            >
                              {busy ? 'Đang gỡ…' : confirming ? 'Xác nhận gỡ?' : 'Gỡ liên kết'}
                            </button>
                          </div>
                        );
                      })}
                    </div>

                    {identityError && (
                      <p style={{ fontSize: '13px', color: 'oklch(50% 0.18 25)', background: 'oklch(93% 0.06 25)', borderRadius: '8px', padding: '10px 12px', margin: '0 0 16px' }}>{identityError}</p>
                    )}
                    {identitySuccess && (
                      <p style={{ fontSize: '13px', color: 'oklch(50% 0.14 150)', background: 'oklch(93% 0.06 150)', borderRadius: '8px', padding: '10px 12px', margin: '0 0 16px' }}>{identitySuccess}</p>
                    )}

                    {hasGoogleIdentity ? (
                      <p style={{ fontSize: '12.5px', color: 'oklch(58% 0.02 240)', margin: 0 }}>Tất cả phương thức đăng nhập khả dụng đã được liên kết.</p>
                    ) : (
                      <button onClick={handleLinkGoogle} disabled={identityBusy === 'link'} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '11px 18px', borderRadius: '9px', border: '1px solid oklch(88% 0.01 240)', background: 'white', fontSize: '13.5px', fontWeight: 600, color: 'oklch(30% 0.03 240)', cursor: identityBusy === 'link' ? 'wait' : 'pointer', fontFamily: "'Manrope',sans-serif", opacity: identityBusy === 'link' ? 0.7 : 1 }}>
                        <GoogleIcon size={18} />
                        {identityBusy === 'link' ? 'Đang chuyển tới Google…' : 'Liên kết tài khoản Google'}
                      </button>
                    )}
                  </>
                )}
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

              <div style={{ ...sectionCardStyle, marginBottom: '20px' }}>
                <h2 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '16px', fontWeight: 700, margin: '0 0 18px' }}>Thông tin trạm</h2>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: 'oklch(32% 0.03 240)', marginBottom: '7px' }}>Tên trạm</label>
                    <input key={station.id + '-name'} type="text" defaultValue={station.name} style={{ width: '100%', boxSizing: 'border-box', padding: '11px 13px', borderRadius: '9px', border: '1px solid oklch(88% 0.01 240)', fontSize: '14px', fontFamily: "'Manrope',sans-serif" }} />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: 'oklch(32% 0.03 240)', marginBottom: '7px' }}>Địa điểm</label>
                    <input key={station.id + '-loc'} type="text" defaultValue={station.location} style={{ width: '100%', boxSizing: 'border-box', padding: '11px 13px', borderRadius: '9px', border: '1px solid oklch(88% 0.01 240)', fontSize: '14px', fontFamily: "'Manrope',sans-serif" }} />
                  </div>
                </div>
                <div style={{ marginBottom: '20px', maxWidth: '280px' }}>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: 'oklch(32% 0.03 240)', marginBottom: '7px' }}>Múi giờ</label>
                  <select style={{ width: '100%', boxSizing: 'border-box', padding: '11px 13px', borderRadius: '9px', border: '1px solid oklch(88% 0.01 240)', fontSize: '14px', fontFamily: "'Manrope',sans-serif", background: 'white' }}>
                    <option>(GMT+7) Bangkok, Hà Nội, Jakarta</option>
                  </select>
                </div>
                <button style={{ padding: '11px 20px', borderRadius: '9px', border: 'none', background: BLUE, color: 'white', fontSize: '14px', fontWeight: 700, cursor: 'pointer', fontFamily: "'Manrope',sans-serif" }}>Lưu thay đổi</button>
              </div>

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

              <div style={{ ...sectionCardStyle, marginBottom: '20px' }}>
                <h2 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '16px', fontWeight: 700, margin: '0 0 18px' }}>Ngưỡng cảnh báo</h2>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '16px', marginBottom: '20px' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: 'oklch(32% 0.03 240)', marginBottom: '7px' }}>Điện áp pin tối thiểu (V)</label>
                    <input type="number" defaultValue="46" style={{ width: '100%', boxSizing: 'border-box', padding: '11px 13px', borderRadius: '9px', border: '1px solid oklch(88% 0.01 240)', fontSize: '14px', fontFamily: "'IBM Plex Mono',monospace" }} />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: 'oklch(32% 0.03 240)', marginBottom: '7px' }}>Nhiệt độ tối đa (°C)</label>
                    <input type="number" defaultValue="45" style={{ width: '100%', boxSizing: 'border-box', padding: '11px 13px', borderRadius: '9px', border: '1px solid oklch(88% 0.01 240)', fontSize: '14px', fontFamily: "'IBM Plex Mono',monospace" }} />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: 'oklch(32% 0.03 240)', marginBottom: '7px' }}>Tải tối đa (kW)</label>
                    <input type="number" defaultValue="2.0" step="0.1" style={{ width: '100%', boxSizing: 'border-box', padding: '11px 13px', borderRadius: '9px', border: '1px solid oklch(88% 0.01 240)', fontSize: '14px', fontFamily: "'IBM Plex Mono',monospace" }} />
                  </div>
                </div>
                <button style={{ padding: '11px 20px', borderRadius: '9px', border: 'none', background: BLUE, color: 'white', fontSize: '14px', fontWeight: 700, cursor: 'pointer', fontFamily: "'Manrope',sans-serif" }}>Lưu ngưỡng</button>
              </div>

              <div style={sectionCardStyle}>
                <h2 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '16px', fontWeight: 700, margin: '0 0 16px' }}>Đơn vị đo lường</h2>
                <div style={{ display: 'inline-flex', background: 'oklch(96% 0.006 240)', borderRadius: '10px', padding: '4px', gap: '2px' }}>
                  <button style={segmentTabStyle(energyUnit === 'kWh')} onClick={() => setEnergyUnit('kWh')}>kWh</button>
                  <button style={segmentTabStyle(energyUnit === 'Wh')} onClick={() => setEnergyUnit('Wh')}>Wh</button>
                </div>
              </div>
            </div>
          )}

          {settingsTab === 'notifications' && (
            <div style={sectionCardStyle}>
              <h2 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '16px', fontWeight: 700, margin: '0 0 6px' }}>Tùy chọn thông báo</h2>
              <p style={{ fontSize: '13px', color: 'oklch(52% 0.02 240)', margin: '0 0 12px' }}>Chọn cách bạn muốn nhận cập nhật từ hệ thống.</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {notifPrefs.map((item) => (
                  <div key={item.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 4px', borderBottom: '1px solid oklch(95% 0.006 240)' }}>
                    <span style={{ fontSize: '14px', fontWeight: 600 }}>{item.label}</span>
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
