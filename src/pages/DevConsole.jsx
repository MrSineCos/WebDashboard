import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useStations } from '../lib/stations.js';
import { useDevices } from '../lib/telemetry.js';
import { useUserSettings } from '../lib/userSettings.js';
import { useLoads } from '../lib/loads.js';
import {
  DEFAULT_BOARD,
  FIRMWARE_MAX_BYTES,
  FW_IN_FLIGHT,
  FW_STATUS_META,
  formatBytes,
  fwStatusDetailText,
  useFirmwareReleases,
} from '../lib/firmware.js';
import { LEVEL_META, formatLogTime, useSystemLogs } from '../lib/systemLogs.js';
import {
  DB_LIMIT_BYTES,
  RETENTION_MAX_DAYS,
  RETENTION_MIN_DAYS,
  STORAGE_LIMIT_BYTES,
  formatArchiveMonth,
  useRetention,
} from '../lib/retention.js';
import { useAuth } from '../lib/AuthContext.jsx';
import { useIsMobile } from '../lib/useIsMobile.js';
import { userAvatarUrl } from '../lib/avatar.js';
import Avatar from '../components/Avatar.jsx';
import DevShell from '../components/DevShell.jsx';

const ACCENT = 'oklch(75% 0.13 200)';

const DEVICE_TYPE_LABEL = { esp32: 'Bộ điều khiển ESP32', inverter: 'Inverter', bms: 'BMS Pin lưu trữ', sensor: 'Cảm biến' };

function devRelative(ts) {
  if (!ts) return 'chưa nhận dữ liệu';
  const mins = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
  if (mins < 1) return 'vừa xong';
  if (mins < 60) return `${mins} phút trước`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} giờ trước`;
  return `${Math.floor(hours / 24)} ngày trước`;
}

const SENSORS = [
  { name: 'Cảm biến điện áp pin', raw: '612 ADC', scale: '0.0812', offset: '-0.4', calibrated: '48.3 V' },
  { name: 'Cảm biến dòng điện tải', raw: '298 ADC', scale: '0.0431', offset: '0.0', calibrated: '12.8 A' },
  { name: 'Cảm biến công suất mặt trời', raw: '—', scale: '1.000', offset: '0.0', calibrated: '2.4 kW' },
  { name: 'Cảm biến nhiệt độ pin', raw: '822 ADC', scale: '0.0512', offset: '-2.1', calibrated: '31°C' },
];

const BATTERY_MODE_DEFAULTS = {
  low: { desc: 'Sử dụng tối đa dung lượng pin, sạc nhanh và xả sâu hơn để khai thác tối đa năng lượng. Có thể làm giảm tuổi thọ pin theo thời gian.', minSoc: 10, maxSoc: 95, maxCurrent: 35, maxVoltage: 55.2, deepDischargeProtect: false },
  balanced: { desc: 'Cân bằng giữa hiệu suất sử dụng và tuổi thọ pin, phù hợp cho vận hành hàng ngày.', minSoc: 20, maxSoc: 90, maxCurrent: 25, maxVoltage: 54.6, deepDischargeProtect: true },
  max: { desc: 'Ưu tiên bảo vệ tuổi thọ pin ở mức cao nhất, vận hành trong dải an toàn hẹp hơn. Dung lượng khả dụng thấp hơn nhưng pin bền hơn lâu dài.', minSoc: 30, maxSoc: 80, maxCurrent: 15, maxVoltage: 53.8, deepDischargeProtect: true },
};

const MODE_LABELS = { low: 'Thấp', balanced: 'Cân bằng', max: 'Tối đa' };

const MODULE_DEFS = [
  { id: 'flow', label: 'Dòng năng lượng', desc: 'Sơ đồ Mặt trời → Lưu trữ → Tải trên Tổng quan' },
  { id: 'chart', label: 'Biểu đồ thời gian thực', desc: 'Biểu đồ điện áp / dòng điện / công suất' },
  { id: 'battery', label: 'Pin lưu trữ', desc: 'Gauge % sạc và thông số pin' },
  { id: 'load', label: 'Điều khiển tải', desc: 'Danh sách bật/tắt thiết bị từ xa' },
  { id: 'alerts', label: 'Cảnh báo', desc: 'Danh sách cảnh báo gần đây' },
  { id: 'reports', label: 'Báo cáo', desc: 'Biểu đồ sản lượng 7 ngày qua' },
];

const STATUS_COLOR = { online: 'oklch(70% 0.15 150)', offline: 'oklch(62% 0.19 25)' };

// Giây → "14n 6h 32p". Cắt hẳn phần giây: chu kỳ telemetry ~10s nên chữ số
// giây chỉ nhấp nháy chứ không thêm thông tin gì. null = không đọc được.
function formatUptime(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) return null;
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}n ${hours}h ${mins}p`;
  if (hours > 0) return `${hours}h ${mins}p`;
  return `${mins}p`;
}

// Thanh "đang dùng bao nhiêu trên hạn mức". Đổi màu theo mức đầy chứ không chỉ
// theo tỉ lệ: cái người dùng cần biết là "còn kịp xử lý không", và mốc đó không
// tuyến tính — 80% đầy là lúc phải hành động, 95% là lúc sắp mất dữ liệu MỚI
// (ingest-telemetry bắt đầu lỗi khi database đầy).
function UsageBar({ label, used, limit, hint }) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const color =
    pct >= 95 ? 'oklch(70% 0.18 25)' : pct >= 80 ? 'oklch(78% 0.14 70)' : 'oklch(70% 0.15 150)';
  return (
    <div style={{ marginBottom: '14px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '10px', marginBottom: '6px' }}>
        <span style={{ fontSize: '12.5px', color: 'oklch(70% 0.015 250)' }}>{label}</span>
        <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '12.5px', color }}>
          {formatBytes(used)} / {formatBytes(limit)}
        </span>
      </div>
      <div style={{ height: '7px', borderRadius: '4px', background: 'oklch(24% 0.02 250)', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, transition: 'width 0.3s' }} />
      </div>
      {hint && <div style={{ fontSize: '11.5px', color: 'oklch(55% 0.015 250)', marginTop: '6px' }}>{hint}</div>}
    </div>
  );
}

function switchStyle(on, activeColor) {
  const color = activeColor || ACCENT;
  return {
    track: {
      width: '40px', height: '22px', borderRadius: '11px', border: 'none', cursor: 'pointer',
      background: on ? color : 'oklch(30% 0.02 250)', position: 'relative', padding: 0, flexShrink: 0,
    },
    thumb: {
      position: 'absolute', top: '3px', left: on ? '20px' : '3px',
      width: '16px', height: '16px', borderRadius: '50%',
      background: on ? 'oklch(12% 0.02 250)' : 'oklch(70% 0.01 250)',
      transition: 'left 0.15s',
    },
  };
}

function chipStyle(active) {
  return {
    padding: '7px 14px',
    borderRadius: '8px',
    border: active ? '1px solid oklch(75% 0.13 200 / 0.6)' : '1px solid oklch(34% 0.02 250)',
    background: active ? 'oklch(24% 0.04 200)' : 'oklch(19% 0.022 250)',
    color: active ? 'oklch(80% 0.13 200)' : 'oklch(70% 0.02 250)',
    fontSize: '12.5px',
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: "'Manrope',sans-serif",
  };
}

// Ô nhập trên nền tối của DevConsole (khối tải firmware lên). Tách ra hằng số
// vì dùng lại cho input lẫn textarea, và để textarea chỉ phải ghi đè đúng hai
// thuộc tính khác biệt.
const darkFieldStyle = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '9px 11px',
  borderRadius: '8px',
  border: '1px solid oklch(34% 0.02 250)',
  background: 'oklch(15% 0.02 250)',
  color: 'white',
  fontSize: '13px',
  fontFamily: "'IBM Plex Mono',monospace",
};

// Một ô chỉ số chẩn đoán. `value === null` nghĩa là thiết bị chưa báo trường
// đó (firmware cũ hơn migration 0017) — hiện "—" kèm chú thích, cố tình không
// hiện 0: "chưa biết" và "bằng 0" là hai chuyện khác nhau, và cả bảng điều
// khiển này sinh ra để phân biệt đúng những chuyện như vậy.
function DiagCard({ label, value }) {
  const unknown = value === null || value === undefined;
  return (
    <div style={{ background: 'oklch(19% 0.022 250)', border: '1px solid oklch(30% 0.02 250)', borderRadius: '12px', padding: '16px' }}>
      <div style={{ fontSize: '11.5px', color: 'oklch(62% 0.015 250)', marginBottom: '8px' }}>{label}</div>
      <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '19px', fontWeight: 600, color: unknown ? 'oklch(50% 0.015 250)' : undefined }}>
        {unknown ? '—' : value}
      </div>
      {unknown && (
        <div style={{ fontSize: '11px', color: 'oklch(52% 0.015 250)', marginTop: '6px' }}>Thiết bị chưa báo</div>
      )}
    </div>
  );
}

function Switch({ on, onClick, activeColor }) {
  const s = switchStyle(on, activeColor);
  return (
    <button onClick={onClick} style={s.track}>
      <span style={s.thumb} />
    </button>
  );
}

// Mục này chỉ là giao diện demo — input/nút chưa nối vào bất kỳ nơi lưu
// trữ nào, sửa xong tải lại trang sẽ mất. Gắn nhãn này để tránh nhầm tưởng
// đã lưu (không phân biệt được giữa các trạm vì không có gì được lưu cả).
function DemoBadge() {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', fontFamily: "'IBM Plex Mono',monospace", fontSize: '10.5px', fontWeight: 600, letterSpacing: '0.04em', color: 'oklch(75% 0.14 70)', background: 'oklch(28% 0.05 70)', padding: '3px 8px', borderRadius: '5px', marginLeft: '10px', verticalAlign: 'middle' }}>
      DEMO — CHƯA LƯU DỮ LIỆU
    </span>
  );
}

// Khoá tương tác (mờ đi + chặn click) cho các khối đọc/ghi station_settings
// trong lúc đang tải cấu hình của trạm vừa chọn — trang không còn unmount
// toàn bộ khi đổi trạm nên cần khoá riêng từng khối để tránh sửa/lưu nhầm
// dữ liệu trạm cũ vào trạm mới trong khoảng chờ fetch.
function lockedWhileLoading(loading) {
  return loading ? { opacity: 0.5, pointerEvents: 'none' } : undefined;
}

function ApplyAllButton({ label, confirming, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{ padding: '9px 16px', borderRadius: '8px', border: confirming ? '1px solid oklch(75% 0.13 200 / 0.6)' : '1px solid oklch(38% 0.03 250)', background: confirming ? 'oklch(24% 0.04 200)' : 'oklch(22% 0.025 250)', fontSize: '12.5px', fontWeight: 600, color: confirming ? 'oklch(80% 0.13 200)' : 'oklch(85% 0.01 250)', cursor: 'pointer', whiteSpace: 'nowrap' }}
    >
      {confirming ? 'Xác nhận áp dụng cho mọi trạm?' : label}
    </button>
  );
}

// `secret` → che giá trị bằng dấu chấm cho tới khi bấm "Hiện" (dùng cho mật
// khẩu AP). Nút Copy vẫn copy giá trị thật kể cả khi đang che, để không bắt
// người dùng phải bóc mật khẩu ra màn hình chỉ để lấy nó.
// `compact` → cỡ chữ/đệm nhỏ hơn, dùng khi xếp nhiều ô trong một dòng thiết bị
// (khối AP) thay vì đứng riêng một mình trong modal.
function CopyField({ label, value, secret = false, compact = false }) {
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(false);
  function copy() {
    navigator.clipboard?.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  const shown = secret && !revealed ? '•'.repeat(String(value ?? '').length) : value;
  return (
    <div style={{ marginBottom: compact ? 0 : '18px' }}>
      <div style={{ fontSize: compact ? '11.5px' : '13px', color: 'oklch(62% 0.015 250)', marginBottom: compact ? '5px' : '7px' }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: compact ? '10px' : '12px', background: 'oklch(13% 0.02 250)', border: '1px solid oklch(30% 0.02 250)', borderRadius: compact ? '8px' : '9px', padding: compact ? '9px 12px' : '13px 16px' }}>
        <code style={{ flex: 1, minWidth: 0, fontFamily: "'IBM Plex Mono',monospace", fontSize: compact ? '13px' : '15px', color: 'oklch(88% 0.01 250)', overflowX: 'auto', whiteSpace: 'nowrap' }}>{shown}</code>
        {secret && (
          <button onClick={() => setRevealed((v) => !v)} style={{ flexShrink: 0, background: 'none', border: 'none', color: 'oklch(70% 0.02 250)', cursor: 'pointer', fontSize: compact ? '12px' : '13.5px', fontWeight: 700, padding: 0, fontFamily: "'Manrope',sans-serif" }}>
            {revealed ? 'Ẩn' : 'Hiện'}
          </button>
        )}
        <button onClick={copy} style={{ flexShrink: 0, background: 'none', border: 'none', color: copied ? 'oklch(70% 0.15 150)' : ACCENT, cursor: 'pointer', fontSize: compact ? '12px' : '13.5px', fontWeight: 700, padding: 0, fontFamily: "'Manrope',sans-serif" }}>
          {copied ? 'Đã copy' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

// Ô copy nhiều dòng (cho khối PEM / secrets.h) — khác CopyField (một dòng,
// cuộn ngang). Dùng <textarea> readOnly để người dùng vẫn chọn/cuộn được nội
// dung dài mà không phá layout modal.
function CopyBlock({ label, value, rows = 6, mono = true }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard?.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <div style={{ marginBottom: '16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginBottom: '7px' }}>
        <div style={{ fontSize: '13px', color: 'oklch(62% 0.015 250)' }}>{label}</div>
        <button onClick={copy} style={{ flexShrink: 0, background: 'none', border: 'none', color: copied ? 'oklch(70% 0.15 150)' : ACCENT, cursor: 'pointer', fontSize: '13px', fontWeight: 700, padding: 0, fontFamily: "'Manrope',sans-serif" }}>
          {copied ? 'Đã copy' : 'Copy'}
        </button>
      </div>
      <textarea
        readOnly
        rows={rows}
        value={value}
        onFocus={(e) => e.target.select()}
        style={{ width: '100%', boxSizing: 'border-box', background: 'oklch(13% 0.02 250)', border: '1px solid oklch(30% 0.02 250)', borderRadius: '9px', padding: '12px 14px', color: 'oklch(88% 0.01 250)', fontFamily: mono ? "'IBM Plex Mono',monospace" : "'Manrope',sans-serif", fontSize: '12px', lineHeight: 1.5, resize: 'vertical', whiteSpace: 'pre' }}
      />
    </div>
  );
}

// STATION_SLUG_CFG chỉ mang tính hiển thị/định tuyến: IoT Rule khớp
// solgrid/+/telemetry (wildcard) và ingest-telemetry tra theo client id
// (=thing name), nên slug lấy từ tên trạm là đủ, người dùng sửa lại tuỳ ý.
function slugifyStation(name) {
  const s = (name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'd')
    .toLowerCase().replace(/[^a-z0-9]+/g, '');
  return s || 'tram01';
}

// Dựng nguyên nội dung secrets.h sẵn sàng dán — khớp
// firmware/*/secrets.example.h (WIFI_* để trống cho người dùng điền).
function buildSecretsH({ thingName, stationSlug, endpoint, rootCa, cert, key }) {
  return `#pragma once

// --- WiFi ---
#define WIFI_SSID       "your-wifi-ssid"
#define WIFI_PASSWORD   "your-wifi-password"

// --- Định danh thiết bị ---
#define AWS_THING_NAME     "${thingName}"
#define STATION_SLUG_CFG   "${stationSlug}"

// --- AWS IoT Core endpoint ---
#define AWS_IOT_ENDPOINT   "${endpoint}"

// --- Amazon Root CA 1 ---
static const char AWS_ROOT_CA[] = R"EOF(
${rootCa.trim()}
)EOF";

// --- Device certificate (cert.pem) ---
static const char DEVICE_CERT[] = R"EOF(
${cert.trim()}
)EOF";

// --- Device private key (priv.key) ---
static const char DEVICE_PRIVATE_KEY[] = R"EOF(
${key.trim()}
)EOF";
`;
}

// Modal thông tin thiết bị — mở khi bấm vào 1 dòng thiết bị (Tổng quan thiết
// bị / Kết nối & API). Hiển thị dữ liệu Supabase có sẵn (aws_thing_name,
// trạng thái...) và cho phép CẤP chứng chỉ X.509 ngay tại đây qua Edge
// Function provision-device: bấm "Tạo chứng chỉ mới" → AWS sinh cert/key mới,
// trả về 3 khối + secrets.h sẵn dán. Private key chỉ hiện đúng 1 lần và KHÔNG
// được lưu ở server (AWS cũng chỉ cho tải 1 lần) — copy ngay khi thấy.
function DeviceInfoModal({ device, station, dependentLoadsCount = 0, onProvision, onListCertificates, onDelete, onClose }) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [provisioning, setProvisioning] = useState(false);
  const [provisionError, setProvisionError] = useState('');
  const [cert, setCert] = useState(null);
  const [confirmingRegen, setConfirmingRegen] = useState(false);
  // null = đang kiểm tra trên AWS, [] = đã kiểm tra xong và không có cert nào.
  const [existingCerts, setExistingCerts] = useState(null);
  const [existingCertsError, setExistingCertsError] = useState('');

  // Modal được remount mỗi khi đổi thiết bị (key={selectedDevice?.id} ở nơi
  // gọi), nên effect này chỉ chạy đúng 1 lần lúc mở modal cho thiết bị hiện
  // tại — hỏi AWS xem thiết bị đã có cert nào gắn sẵn chưa, để không bắt
  // người dùng luôn phải "Tạo chứng chỉ mới" mù mờ không biết đã cấp trước
  // đó hay chưa.
  useEffect(() => {
    // Modal luôn nằm trong cây (device=null khi chưa mở) — không có thiết bị
    // thì không hỏi AWS, tránh đọc device.id trên null làm crash cả app.
    if (!device) return;
    let cancelled = false;
    setExistingCerts(null);
    setExistingCertsError('');
    onListCertificates(device.id).then(({ data, error }) => {
      if (cancelled) return;
      if (error || !data) {
        setExistingCertsError(`Không kiểm tra được chứng chỉ đã cấp trên AWS${error?.message ? ` — ${error.message}` : ''}`);
        setExistingCerts([]);
        return;
      }
      setExistingCerts(data.certificates || []);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chỉ chạy 1 lần lúc mount, xem giải thích ở trên
  }, []);

  if (!device) return null;
  const typeLabel = DEVICE_TYPE_LABEL[device.type] ?? device.type;
  const online = station?.status !== 'offline' && device.status === 'connected';
  const provisionCmd = `python provision_device.py --thing-name ${device.aws_thing_name} --write-config`;

  const hasAnyCert = cert || (existingCerts && existingCerts.length > 0);

  async function handleGenerate() {
    // Đã có cert (vừa tạo trong phiên này, hoặc AWS báo đã có sẵn từ trước)
    // → mỗi lần bấm tạo THÊM một cert mới trên AWS (cert cũ vẫn còn), nên yêu
    // cầu xác nhận một nhịp trước khi tạo thêm.
    if (hasAnyCert && !confirmingRegen) {
      setConfirmingRegen(true);
      return;
    }
    setConfirmingRegen(false);
    setProvisioning(true);
    setProvisionError('');
    const { data, error } = await onProvision(device.id);
    setProvisioning(false);
    if (error || !data) {
      setProvisionError(`Không tạo được chứng chỉ${error?.message ? ` — ${error.message}` : ''}. Kiểm tra AWS secrets đã set chưa (docs/IOT.md mục 4.4).`);
      return;
    }
    setCert(data);
    // Cập nhật danh sách ngay mà không cần gọi lại AWS — cert vừa tạo cũng là
    // một cert "đã cấp" từ giờ trở đi.
    setExistingCerts((prev) => [
      { certificate_id: data.certificate_id, status: 'ACTIVE', created_at: new Date().toISOString(), certificate_pem: data.certificate_pem },
      ...(prev || []),
    ]);
  }

  const secretsH = cert && buildSecretsH({
    thingName: cert.thing_name,
    stationSlug: slugifyStation(station?.name),
    endpoint: cert.endpoint,
    rootCa: cert.root_ca,
    cert: cert.certificate_pem,
    key: cert.private_key,
  });

  async function handleDeleteClick() {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setDeleting(true);
    setDeleteError('');
    const { error } = await onDelete(device.id);
    setDeleting(false);
    if (error) {
      setDeleteError('Không thể xóa thiết bị, vui lòng thử lại.');
      return;
    }
    onClose();
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'oklch(0% 0 0 / 0.55)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: 'oklch(17% 0.02 250)', border: '1px solid oklch(32% 0.02 250)', borderRadius: '16px', padding: '36px', maxWidth: '760px', width: '100%', maxHeight: '88vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '14px', marginBottom: '8px' }}>
          <div>
            <div style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '23px', fontWeight: 700 }}>{device.name}</div>
            <div style={{ fontSize: '14.5px', color: 'oklch(62% 0.015 250)', marginTop: '5px' }}>{typeLabel} · {station?.name}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexShrink: 0 }}>
            <span style={{ fontSize: '12.5px', fontWeight: 700, padding: '5px 12px', borderRadius: '20px', color: online ? 'oklch(70% 0.15 150)' : 'oklch(70% 0.16 25)', background: online ? 'oklch(28% 0.05 150)' : 'oklch(28% 0.06 25)' }}>{online ? 'Online' : 'Offline'}</span>
            <button onClick={onClose} aria-label="Đóng" style={{ background: 'none', border: 'none', color: 'oklch(62% 0.015 250)', cursor: 'pointer', fontSize: '24px', lineHeight: 1, padding: '2px' }}>×</button>
          </div>
        </div>
        <div style={{ fontSize: '13.5px', color: 'oklch(62% 0.015 250)', marginBottom: '26px' }}>
          Nhận dữ liệu {devRelative(device.last_seen_at)} · đăng ký {new Date(device.created_at).toLocaleDateString('vi-VN')}
        </div>

        <CopyField label="AWS thing name / MQTT client id (THING_NAME)" value={device.aws_thing_name} />

        <div style={{ borderTop: '1px solid oklch(28% 0.02 250)', paddingTop: '20px', marginTop: '4px' }}>
          <div style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '16px', fontWeight: 700, marginBottom: '10px' }}>Chứng chỉ thiết bị (X.509)</div>

          <div style={{ marginBottom: '18px' }}>
            <div style={{ fontSize: '12.5px', color: 'oklch(62% 0.015 250)', marginBottom: '8px' }}>Đã cấp trên AWS cho thiết bị này</div>
            {existingCerts === null ? (
              <div style={{ fontSize: '13px', color: 'oklch(60% 0.015 250)' }}>Đang kiểm tra trên AWS…</div>
            ) : existingCertsError ? (
              <div style={{ fontSize: '13px', color: 'oklch(78% 0.14 70)' }}>{existingCertsError}</div>
            ) : existingCerts.length === 0 ? (
              <div style={{ fontSize: '13px', color: 'oklch(60% 0.015 250)' }}>Chưa có chứng chỉ nào được cấp cho thiết bị này trên AWS.</div>
            ) : (
              <div style={{ background: 'oklch(15% 0.02 250)', border: '1px solid oklch(30% 0.02 250)', borderRadius: '9px' }}>
                {existingCerts.map((c, i) => {
                  const active = c.status === 'ACTIVE';
                  return (
                    <details key={c.certificate_id || i} style={{ borderBottom: i < existingCerts.length - 1 ? '1px solid oklch(26% 0.02 250)' : 'none' }}>
                      <summary style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '11px 14px', cursor: 'pointer', listStyle: 'none' }}>
                        <span style={{ width: '7px', height: '7px', borderRadius: '50%', flexShrink: 0, background: active ? 'oklch(70% 0.15 150)' : 'oklch(60% 0.02 250)' }} />
                        <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '11.5px', color: 'oklch(80% 0.01 250)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.certificate_id}</span>
                        <span style={{ fontSize: '11px', fontWeight: 700, color: active ? 'oklch(70% 0.15 150)' : 'oklch(65% 0.02 250)', flexShrink: 0 }}>{active ? 'Active' : c.status || 'Inactive'}</span>
                        <span style={{ fontSize: '11.5px', color: 'oklch(55% 0.015 250)', flexShrink: 0 }}>{c.created_at ? new Date(c.created_at).toLocaleDateString('vi-VN') : ''}</span>
                      </summary>
                      <div style={{ padding: '0 14px 14px' }}>
                        <div style={{ fontSize: '11.5px', color: 'oklch(55% 0.015 250)', marginBottom: '8px' }}>Certificate (public) — không phải private key, xem lại được bất cứ lúc nào.</div>
                        <CopyBlock label="cert.pem" value={c.certificate_pem} rows={5} />
                      </div>
                    </details>
                  );
                })}
              </div>
            )}
          </div>

          {!cert && (
            <div style={{ fontSize: '13.5px', color: 'oklch(70% 0.015 250)', lineHeight: 1.65, marginBottom: '16px' }}>
              Bấm để AWS IoT sinh một cặp <strong>cert + private key mới</strong> cho thiết bị này (gắn sẵn policy). Ba khối bên dưới dán thẳng vào firmware. Private key <strong>chỉ hiện đúng 1 lần</strong> ngay tại đây và không được lưu lại — copy ngay khi có.
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', marginBottom: cert ? '20px' : '0' }}>
            <button
              onClick={handleGenerate}
              disabled={provisioning}
              style={{ padding: '11px 20px', borderRadius: '9px', border: 'none', background: confirmingRegen ? 'oklch(28% 0.06 70)' : ACCENT, color: confirmingRegen ? 'oklch(85% 0.14 70)' : 'oklch(12% 0.02 250)', fontSize: '13.5px', fontWeight: 700, cursor: 'pointer', opacity: provisioning ? 0.6 : 1 }}
            >
              {provisioning ? 'Đang tạo…' : confirmingRegen ? 'Tạo thêm cert mới? (cert cũ vẫn còn trên AWS)' : hasAnyCert ? 'Tạo thêm chứng chỉ mới' : 'Tạo chứng chỉ mới'}
            </button>
            {confirmingRegen && (
              <button onClick={() => setConfirmingRegen(false)} style={{ padding: '11px 16px', borderRadius: '9px', border: '1px solid oklch(38% 0.03 250)', background: 'oklch(22% 0.025 250)', fontSize: '13px', fontWeight: 600, color: 'oklch(80% 0.01 250)', cursor: 'pointer' }}>Huỷ</button>
            )}
          </div>

          {provisionError && (
            <div style={{ fontSize: '13px', color: 'oklch(80% 0.14 25)', lineHeight: 1.6, margin: '14px 0 0' }}>{provisionError}</div>
          )}

          {cert && (
            <>
              <div style={{ fontSize: '13px', color: 'oklch(78% 0.14 70)', lineHeight: 1.6, marginBottom: '16px', background: 'oklch(22% 0.03 70 / 0.3)', border: '1px solid oklch(40% 0.06 70 / 0.4)', borderRadius: '9px', padding: '12px 14px' }}>
                ⚠ Private key bên dưới chỉ hiện lần này — copy hoặc lưu ngay. Tải lại trang / mở lại modal sẽ không xem lại được (phải tạo cert mới).
              </div>

              <CopyField label="AWS IoT endpoint (AWS_IOT_ENDPOINT)" value={cert.endpoint} />
              <CopyBlock label="Amazon Root CA 1 (AWS_ROOT_CA)" value={cert.root_ca} rows={5} />
              <CopyBlock label="Device certificate — cert.pem (DEVICE_CERT)" value={cert.certificate_pem} rows={6} />
              <CopyBlock label="Device private key — priv.key (DEVICE_PRIVATE_KEY)" value={cert.private_key} rows={6} />

              <div style={{ borderTop: '1px dashed oklch(30% 0.02 250)', paddingTop: '16px', marginTop: '4px' }}>
                <CopyBlock label="secrets.h — sẵn sàng dán (chỉ còn điền WiFi)" value={secretsH} rows={10} mono />
                <div style={{ fontSize: '12.5px', color: 'oklch(55% 0.015 250)', lineHeight: 1.6 }}>
                  Chép vào <code style={{ fontFamily: "'IBM Plex Mono',monospace" }}>firmware/&lt;board&gt;/secrets.h</code> rồi điền WIFI_SSID / WIFI_PASSWORD. Mỗi lần "Tạo lại chứng chỉ" tạo thêm một cert mới trên AWS — cert cũ vẫn hoạt động cho tới khi bạn tự vô hiệu/ xoá trong AWS Console.
                </div>
              </div>
            </>
          )}

          <details style={{ marginTop: '18px' }}>
            <summary style={{ fontSize: '12.5px', color: 'oklch(60% 0.015 250)', cursor: 'pointer' }}>Hoặc cấp bằng CLI (script Python)</summary>
            <div style={{ marginTop: '12px' }}>
              <CopyField label="Chạy trong tools/mqtt-simulator/" value={provisionCmd} />
              <div style={{ fontSize: '12.5px', color: 'oklch(55% 0.015 250)' }}>Xem docs/IOT.md mục 4.2 (provisioning) và 7.1 (mô phỏng ESP32 bằng Python).</div>
            </div>
          </details>
        </div>

        <div style={{ borderTop: '1px solid oklch(28% 0.02 250)', paddingTop: '20px', marginTop: '20px' }}>
          {confirmingDelete && (
            <div style={{ fontSize: '13.5px', color: 'oklch(80% 0.14 25)', marginBottom: '14px', lineHeight: 1.65 }}>
              Xóa thiết bị chỉ gỡ khỏi Supabase — thing/cert trên AWS vẫn còn,
              thiết bị sẽ nhận lỗi <code style={{ fontFamily: "'IBM Plex Mono',monospace" }}>unknown_device</code> khi publish.
              Dữ liệu telemetry cũ vẫn giữ nguyên.
              {dependentLoadsCount > 0 && (
                <> {dependentLoadsCount} tải đang gắn thiết bị này sẽ chuyển về "chưa gắn thiết bị" và không điều khiển được cho tới khi gán lại.</>
              )}
            </div>
          )}
          {deleteError && <div style={{ fontSize: '13.5px', color: 'oklch(80% 0.14 25)', marginBottom: '14px' }}>{deleteError}</div>}
          <button
            onClick={handleDeleteClick}
            disabled={deleting}
            style={{ padding: '12px 22px', borderRadius: '9px', border: confirmingDelete ? '1px solid oklch(70% 0.16 25)' : '1px solid oklch(38% 0.03 250)', background: confirmingDelete ? 'oklch(28% 0.06 25)' : 'oklch(22% 0.025 250)', fontSize: '14px', fontWeight: 600, color: confirmingDelete ? 'oklch(80% 0.14 25)' : 'oklch(85% 0.01 250)', cursor: 'pointer', opacity: deleting ? 0.6 : 1 }}
          >
            {deleting ? 'Đang xóa…' : confirmingDelete ? 'Xác nhận xóa thiết bị?' : 'Xóa thiết bị'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function DevConsole() {
  const isMobile = useIsMobile(900);
  const [activeNav, setActiveNav] = useState('overview');
  const [stationMenuOpen, setStationMenuOpen] = useState(false);
  const [logFilter, setLogFilter] = useState('all');
  const [simMode, setSimMode] = useState(false);
  const [simSolar, setSimSolar] = useState(2.4);
  const [simBattery, setSimBattery] = useState(78);
  const [simLoad, setSimLoad] = useState(0.23);
  const [editingMode, setEditingMode] = useState('balanced');
  const [batteryModesSaved, setBatteryModesSaved] = useState(false);
  const [draftBatteryModes, setDraftBatteryModes] = useState(null);
  const [confirmApplyModules, setConfirmApplyModules] = useState(false);
  const [confirmApplyBattery, setConfirmApplyBattery] = useState(false);
  const [selectedDevice, setSelectedDevice] = useState(null);
  // Thiết bị đang xem chỉ số chẩn đoán ("Tổng quan thiết bị"). Không đặt lại
  // khi đổi trạm: id không khớp trạm mới sẽ tự rơi về mặc định — xem diagDevice.
  const [diagDeviceId, setDiagDeviceId] = useState('');

  // --- Quản lý Firmware MCU (mục 10 docs/IOT.md) ---
  // `selectedReleaseId` là bản sẽ được đẩy khi bấm "Cập nhật"/"Đẩy OTA đến tất
  // cả" — luôn phải chọn tường minh, không tự lấy bản mới nhất: đẩy nhầm ảnh
  // firmware là hỏng phần cứng thật, không hoàn tác từ xa được.
  const [selectedReleaseId, setSelectedReleaseId] = useState('');
  const [fwFile, setFwFile] = useState(null);
  const [fwBoard, setFwBoard] = useState(DEFAULT_BOARD);
  const [fwVersion, setFwVersion] = useState('');
  const [fwNotes, setFwNotes] = useState('');
  const [fwUploading, setFwUploading] = useState(false);
  const [fwUploadError, setFwUploadError] = useState('');
  const [fwUploadOk, setFwUploadOk] = useState('');
  const [fwDragging, setFwDragging] = useState(false);
  // id thiết bị đang đẩy, hoặc 'all' khi đẩy cả trạm — dùng để khoá đúng nút
  // đang chạy thay vì khoá toàn khối.
  const [pushingTarget, setPushingTarget] = useState(null);
  const [fwPushError, setFwPushError] = useState('');
  const [fwPushOk, setFwPushOk] = useState('');
  const [confirmDeleteReleaseId, setConfirmDeleteReleaseId] = useState(null);

  // --- Lưu trữ & dọn dữ liệu (migration 0019) ---
  // Số ngày giữ lại được sửa qua nháp + nút Lưu thay vì ghi ngay mỗi phím: gõ
  // "30" mà ghi từng ký tự nghĩa là có một khoảnh khắc giá trị bằng 3 — và job
  // đêm chạy đúng lúc đó sẽ xoá gần hết dữ liệu. Giống khối "Ngưỡng pin".
  const [retentionDraft, setRetentionDraft] = useState(null);
  const [retentionSaved, setRetentionSaved] = useState(false);
  const [retentionError, setRetentionError] = useState('');
  const [archiveRunning, setArchiveRunning] = useState(false);
  const [archiveMsg, setArchiveMsg] = useState('');
  const [archiveError, setArchiveError] = useState('');
  const [confirmDeleteArchiveId, setConfirmDeleteArchiveId] = useState(null);
  const [confirmClearLogs, setConfirmClearLogs] = useState(false);
  // Mở lại cửa sổ theo dõi tiến trình nạp sau mỗi lần đẩy — xem effect poll.
  const [otaWatchKey, setOtaWatchKey] = useState(0);
  const fwFileInputRef = useRef(null);

  const { stations, station: currentStation, selectStation, loading: stationsLoading } = useStations();
  const { devices, removeDevice, provisionDevice, listDeviceCertificates, refreshDevices } = useDevices();
  const { releases, loading: releasesLoading, uploadRelease, deleteRelease, pushOta } = useFirmwareReleases();
  const { loads: stationLoads } = useLoads(currentStation?.id);
  const settings = useUserSettings(currentStation?.id);
  // Lọc mức log ở phía server (hook nhận `logFilter`) thay vì kéo hết về rồi
  // lọc trong trình duyệt — sau vài tuần chạy thật, nhật ký dài hơn nhiều so
  // với 200 dòng mà khung hiển thị dùng tới.
  const { logs, loading: logsLoading, error: logsError, clearStationLogs } =
    useSystemLogs(currentStation?.id, { level: logFilter });
  const retention = useRetention();
  const { user, signOut } = useAuth();
  const routerNavigate = useNavigate();
  const location = useLocation();
  const [signingOut, setSigningOut] = useState(false);

  // Chỉ hiện màn "Đang tải…" (thay toàn bộ DevShell bằng placeholder ngắn)
  // ở lần tải đầu tiên. Nếu dùng thẳng settings.loading, mỗi lần đổi trạm
  // useUserSettings sẽ set loading=true trở lại, unmount toàn bộ trang dài
  // xuống còn một placeholder 100vh rồi mount lại — khiến trình duyệt co
  // scroll về đầu trang và không khôi phục lại được.
  const [everLoaded, setEverLoaded] = useState(false);
  useEffect(() => {
    if (!stationsLoading && currentStation && !settings.loading) setEverLoaded(true);
  }, [stationsLoading, currentStation, settings.loading]);

  async function handleSignOut() {
    setSigningOut(true);
    await signOut();
    routerNavigate('/login', { replace: true });
  }

  const authProvider = user?.app_metadata?.provider ?? 'email';
  const avatarUrl = userAvatarUrl(user);
  const displayName = user?.user_metadata?.full_name || user?.user_metadata?.name || 'Quản trị viên';

  // Khi điều hướng chéo trang từ /dev/stations (bấm 1 mục như "Firmware MCU"
  // trong khi đang ở trang Quản lý trạm) sẽ quay về /dev kèm state.scrollTo —
  // tự cuộn tới đúng mục đó khi trang này mount.
  useEffect(() => {
    const target = location.state?.scrollTo;
    if (target) navigate(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chỉ chạy 1 lần lúc mount để tiêu thụ state điều hướng
  }, []);

  // Reseed mỗi khi đổi trạm (không chỉ lần đầu) — battery_modes giờ là dữ
  // liệu theo từng trạm (station_settings), nên đổi trạm phải nạp lại draft
  // đúng của trạm đó, nếu không "Lưu cấu hình ngưỡng pin" sẽ ghi đè nhầm
  // dữ liệu của trạm cũ lên trạm đang chọn.
  useEffect(() => {
    if (!currentStation) return;
    setDraftBatteryModes(settings.batteryModes ?? null);
    setBatteryModesSaved(false);
  }, [currentStation, settings.batteryModes]);

  const batteryModes = draftBatteryModes || settings.batteryModes || BATTERY_MODE_DEFAULTS;

  // Nháp cài đặt lưu trữ, nạp lại mỗi khi server trả về giá trị mới (kể cả sau
  // một lượt lưu thành công — lúc đó nháp và giá trị thật trùng nhau, nút Lưu
  // tự tắt).
  useEffect(() => {
    if (retention.settings) setRetentionDraft(retention.settings);
  }, [retention.settings]);

  const retentionDirty =
    !!retentionDraft && !!retention.settings &&
    (Number(retentionDraft.retentionDays) !== retention.settings.retentionDays ||
      retentionDraft.archiveEnabled !== retention.settings.archiveEnabled ||
      Number(retentionDraft.logRetentionDays) !== retention.settings.logRetentionDays);

  function navigate(id) {
    setActiveNav(id);
    requestAnimationFrame(() => {
      const el = document.getElementById('dsec-' + id);
      if (el) {
        const top = el.getBoundingClientRect().top + window.scrollY - 20;
        window.scrollTo({ top, behavior: 'smooth' });
      }
    });
  }

  const moduleVisibility = MODULE_DEFS.map((m) => ({ ...m, on: settings.moduleVisibility[m.id] ?? true }));

  // Trang không còn unmount toàn bộ khi settings.loading = true (xem
  // `everLoaded` ở trên — giữ nguyên vị trí cuộn khi đổi trạm), nên các thao
  // tác ghi dữ liệu bên dưới phải tự chặn trong lúc đang tải cấu hình của
  // trạm mới, nếu không sẽ ghi đè dữ liệu trạm cũ (còn cache trong state)
  // lên station_settings của trạm vừa chọn.
  function toggleModule(id) {
    if (settings.loading) return;
    settings.toggleModule(id);
  }

  async function handleApplyModulesToAll() {
    if (settings.loading) return;
    if (!confirmApplyModules) {
      setConfirmApplyModules(true);
      return;
    }
    setConfirmApplyModules(false);
    await settings.applyModuleVisibilityToAll(settings.moduleVisibility);
  }

  function updateEditing(patch) {
    setDraftBatteryModes((prev) => ({ ...prev, [editingMode]: { ...prev[editingMode], ...patch } }));
    setBatteryModesSaved(false);
  }

  async function saveBatteryModes() {
    if (settings.loading) return;
    await settings.updateBatteryModes(draftBatteryModes);
    setBatteryModesSaved(true);
  }

  async function resetBatteryModes() {
    if (settings.loading) return;
    const clone = JSON.parse(JSON.stringify(BATTERY_MODE_DEFAULTS));
    setDraftBatteryModes(clone);
    setBatteryModesSaved(false);
    await settings.updateBatteryModes(clone);
  }

  async function handleApplyBatteryToAll() {
    if (settings.loading) return;
    if (!confirmApplyBattery) {
      setConfirmApplyBattery(true);
      return;
    }
    setConfirmApplyBattery(false);
    await settings.applyBatteryModesToAll(draftBatteryModes);
    setBatteryModesSaved(true);
  }

  // Trong lúc một thiết bị đang nạp, trạng thái đổi ở phía server chứ không do
  // thao tác nào trên trang này: thiết bị báo fw_status qua telemetry →
  // ingest-telemetry ghi vào `devices`. Bảng `devices` không có realtime nên
  // poll nhẹ, và CHỈ khi thật sự có việc đang chạy.
  //
  // Có hạn 5 phút vì "đang chạy" không đảm bảo sẽ kết thúc: thiết bị offline
  // lúc publish sẽ kẹt ở 'pending' vô hạn (QoS 1 không giao lại cho thiết bị
  // đang offline), và hỏi lại server 5 giây một lần mãi mãi là vô nghĩa. Mỗi
  // lần đẩy mới tăng `otaWatchKey` → mở lại một cửa sổ theo dõi mới.
  const otaInFlight = devices.some((d) => FW_IN_FLIGHT.has(d.fw_status));
  useEffect(() => {
    if (!otaInFlight) return;
    const deadline = Date.now() + 5 * 60 * 1000;
    const timer = setInterval(() => {
      if (Date.now() >= deadline) {
        clearInterval(timer);
        return;
      }
      refreshDevices();
    }, 5000);
    return () => clearInterval(timer);
  }, [otaInFlight, otaWatchKey, refreshDevices]);

  function pickFwFile(file) {
    if (!file) return;
    setFwFile(file);
    setFwUploadError('');
    setFwUploadOk('');
    // Gợi ý phiên bản từ tên file ("v2.3.1.bin" → "v2.3.1"), chỉ khi ô còn
    // trống và tên file dùng được làm tên thư mục. Người dùng vẫn phải soát
    // lại: chuỗi này phải TRÙNG FW_VERSION trong .ino thì cloud mới suy ra
    // được "đã nạp xong" (docs/IOT.md mục 10.6).
    if (!fwVersion) {
      const base = file.name.replace(/\.bin$/i, '').trim();
      if (/^[A-Za-z0-9._-]+$/.test(base)) setFwVersion(base);
    }
  }

  async function handleUploadRelease() {
    setFwUploading(true);
    setFwUploadError('');
    setFwUploadOk('');
    const { data, error } = await uploadRelease({
      file: fwFile,
      board: fwBoard,
      version: fwVersion,
      releaseNotes: fwNotes,
    });
    setFwUploading(false);
    if (error) {
      setFwUploadError(error.message);
      return;
    }
    setFwUploadOk(`Đã tải lên ${data.version} · ${formatBytes(data.sizeBytes)}.`);
    setFwFile(null);
    setFwVersion('');
    setFwNotes('');
    if (fwFileInputRef.current) fwFileInputRef.current.value = '';
    // Bản vừa tải lên gần như luôn là bản sắp đẩy — chọn sẵn để bớt một bước.
    setSelectedReleaseId(data.id);
  }

  // `target` = id thiết bị, hoặc 'all' cho cả trạm. Edge Function nhận đúng một
  // trong device_id/station_id nên hai nhánh không gộp được.
  async function handlePushOta(target) {
    setFwPushError('');
    setFwPushOk('');
    setPushingTarget(target);
    const { data, error } = await pushOta(
      target === 'all'
        ? { releaseId: selectedReleaseId, stationId: currentStation.id }
        : { releaseId: selectedReleaseId, deviceId: target },
    );
    setPushingTarget(null);
    if (error) {
      setFwPushError(error.message);
      return;
    }
    // "Đã gửi lệnh" chứ không phải "đã nạp xong": chỉ thiết bị mới xác nhận
    // được, qua fw_version/fw_status ở bảng devices (docs/IOT.md mục 10.6).
    const parts = [`Đã gửi lệnh nạp ${data.version} tới ${data.published} thiết bị.`];
    if (data.failed > 0) {
      parts.push(`${data.failed} thiết bị không gửi được: ${(data.failed_devices || []).join(', ')}.`);
    }
    if (data.status_write_failed) {
      parts.push('Lệnh đã đi nhưng không ghi được cột trạng thái theo dõi.');
    }
    setFwPushOk(parts.join(' '));
    setOtaWatchKey((k) => k + 1);
    refreshDevices();
  }

  async function handleDeleteRelease(id) {
    if (confirmDeleteReleaseId !== id) {
      setConfirmDeleteReleaseId(id);
      return;
    }
    setConfirmDeleteReleaseId(null);
    setFwPushError('');
    const { error } = await deleteRelease(id);
    if (error) {
      setFwPushError(error.message);
      return;
    }
    if (selectedReleaseId === id) setSelectedReleaseId('');
    // Thiết bị đang nạp dở bản vừa xoá được trigger devices_clear_fw_target
    // đánh 'failed' — đọc lại để hiện đúng thay vì kẹt ở "Đang tải".
    refreshDevices();
  }

  async function handleSaveRetention() {
    if (!retentionDraft) return;
    setRetentionError('');
    setRetentionSaved(false);
    const days = Number(retentionDraft.retentionDays);
    const logDays = Number(retentionDraft.logRetentionDays);
    const inRange = (n) =>
      Number.isInteger(n) && n >= RETENTION_MIN_DAYS && n <= RETENTION_MAX_DAYS;
    // Cùng dải với CHECK constraint ở DB (0019). Kiểm ở đây chỉ để báo lỗi
    // bằng tiếng người thay vì để PostgREST trả về thông báo vi phạm ràng buộc.
    if (!inRange(days) || !inRange(logDays)) {
      setRetentionError(`Số ngày giữ lại phải là số nguyên trong khoảng ${RETENTION_MIN_DAYS}–${RETENTION_MAX_DAYS}.`);
      return;
    }
    const { error } = await retention.saveSettings({
      retentionDays: days,
      archiveEnabled: retentionDraft.archiveEnabled,
      logRetentionDays: logDays,
    });
    if (error) {
      setRetentionError(`Không lưu được cài đặt — ${error.message}`);
      return;
    }
    setRetentionSaved(true);
  }

  async function handleRunArchive() {
    setArchiveRunning(true);
    setArchiveMsg('');
    setArchiveError('');
    const { data, error } = await retention.runArchiveNow();
    setArchiveRunning(false);
    if (error) {
      setArchiveError(`${error.message}. Kiểm tra Edge Function archive-telemetry đã deploy chưa (docs/IOT.md mục 11).`);
      return;
    }
    if (!data || (data.archived_rows === 0 && data.deleted_rows === 0)) {
      setArchiveMsg('Không có bản ghi nào quá hạn — chưa cần dọn.');
      return;
    }
    const parts = [];
    if (data.archived_rows > 0) {
      parts.push(`Đã nén ${data.archived_rows.toLocaleString('vi-VN')} bản ghi thành ${data.files} gói (${formatBytes(data.bytes)}).`);
    }
    if (data.deleted_rows > 0) {
      parts.push(`Đã giải phóng ${data.deleted_rows.toLocaleString('vi-VN')} bản ghi khỏi database.`);
    }
    setArchiveMsg(parts.join(' '));
  }

  async function handleDownloadArchive(archive) {
    setArchiveError('');
    const { url, error } = await retention.downloadUrl(archive.storagePath);
    if (error) {
      setArchiveError(`Không tạo được liên kết tải — ${error.message}`);
      return;
    }
    window.open(url, '_blank', 'noopener');
  }

  async function handleDeleteArchive(archive) {
    if (confirmDeleteArchiveId !== archive.id) {
      setConfirmDeleteArchiveId(archive.id);
      return;
    }
    setConfirmDeleteArchiveId(null);
    setArchiveError('');
    const { error } = await retention.deleteArchive(archive);
    if (error) setArchiveError(`Không xoá được gói lưu trữ — ${error.message}`);
  }

  async function handleClearLogs() {
    if (!confirmClearLogs) {
      setConfirmClearLogs(true);
      return;
    }
    setConfirmClearLogs(false);
    await clearStationLogs();
  }

  if (!everLoaded && (stationsLoading || !currentStation || settings.loading)) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'oklch(15% 0.02 250)', color: 'oklch(70% 0.015 250)', fontFamily: "'Manrope',sans-serif" }}>
        Đang tải…
      </div>
    );
  }

  const stationOffline = currentStation.status === 'offline';
  const stationDevices = devices.filter((d) => d.station_id === currentStation.id);
  const editing = batteryModes[editingMode];

  // Chỉ ESP32 chạy firmware của hệ thống này — inverter/BMS/cảm biến là thiết
  // bị hãng khác, không nhận OTA và cũng không báo chỉ số chẩn đoán.
  // `send-ota-command` lọc đúng `type='esp32'`, nên lọc y hệt ở đây để danh
  // sách trên màn hình khớp với thứ thực sự nhận được lệnh.
  const esp32Devices = stationDevices.filter((d) => d.type === 'esp32');

  // Chỉ số chẩn đoán là của MỘT thiết bị, không phải của trạm: một trạm có thể
  // có nhiều ESP32, mỗi con uptime/nhiệt độ/số lần reboot riêng. Mặc định lấy
  // con báo dữ liệu gần đây nhất; đổi trạm thì id đang chọn không còn khớp nên
  // tự rơi về mặc định của trạm mới mà không cần effect dọn state.
  const diagDevice =
    esp32Devices.find((d) => d.id === diagDeviceId) ??
    [...esp32Devices].sort(
      (a, b) => new Date(b.last_seen_at ?? 0) - new Date(a.last_seen_at ?? 0),
    )[0] ??
    null;

  const diagUptime = diagDevice ? formatUptime(diagDevice.uptime_s) : null;
  const diagMcuTemp = diagDevice?.mcu_temp_c != null ? `${Math.round(Number(diagDevice.mcu_temp_c))}°C` : null;
  const diagBootCount = diagDevice?.boot_count != null ? String(diagDevice.boot_count) : null;
  // Trạng thái MQTT không cần cột riêng: trigger apply_telemetry đặt
  // `devices.status='connected'` mỗi bản tin, `mark_stale_offline` (0006) gạt
  // về 'disconnected' sau 90 giây im lặng. Kết hợp với `stationOffline` để ô
  // này không mâu thuẫn với danh sách thiết bị ngay bên dưới.
  const diagMqttOnline = !!diagDevice && !stationOffline && diagDevice.status === 'connected';
  // "Đang chạy" xác định bằng phiên bản THIẾT BỊ báo về, không phải bằng bản
  // cloud đã đẩy — đúng nguyên tắc thiết bị là nguồn sự thật (docs/IOT.md 10.6).
  const runningVersions = new Set(devices.map((d) => d.fw_version).filter(Boolean));

  return (
    <>
    <DevShell
      activeNav={activeNav}
      onNavigate={navigate}
      isMobile={isMobile}
      stations={stations}
      currentStation={currentStation}
      onSelectStation={selectStation}
      stationMenuOpen={stationMenuOpen}
      onToggleStationMenu={() => setStationMenuOpen((v) => !v)}
      onCloseStationMenu={() => setStationMenuOpen(false)}
    >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: 'oklch(28% 0.06 70 / 0.35)', border: '1px solid oklch(45% 0.1 70 / 0.5)', borderRadius: '10px', padding: '12px 16px', marginBottom: '24px' }}>
          <svg width="16" height="16" viewBox="0 0 20 20" style={{ flexShrink: 0 }}><path d="M10 3l8 14H2z" fill="none" stroke="oklch(78% 0.14 70)" strokeWidth="1.6" strokeLinejoin="round" /><line x1="10" y1="8" x2="10" y2="12" stroke="oklch(78% 0.14 70)" strokeWidth="1.6" strokeLinecap="round" /><circle cx="10" cy="14.7" r="0.9" fill="oklch(78% 0.14 70)" /></svg>
          <span style={{ fontSize: '12.5px', color: 'oklch(85% 0.03 70)', fontFamily: "'IBM Plex Mono',monospace" }}>Chế độ Nhà phát triển — thay đổi ở đây ảnh hưởng trực tiếp đến phần cứng và giao diện người dùng.</span>
        </div>

        {/* OVERVIEW */}
        <div id="dsec-overview" style={{ scrollMarginTop: '24px', marginBottom: '32px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '14px', flexWrap: 'wrap', marginBottom: '16px' }}>
            <div>
              <h1 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '22px', fontWeight: 700, margin: '0 0 4px' }}>Tổng quan thiết bị</h1>
              <p style={{ fontSize: '13px', color: 'oklch(62% 0.015 250)', margin: 0 }}>Chỉ số chẩn đoán thiết bị báo về cùng mỗi bản tin telemetry</p>
            </div>
            {/* Chỉ hiện bộ chọn khi thật sự có nhiều hơn một ESP32 — với trạm
                một thiết bị thì dòng định danh bên dưới đã đủ rõ. */}
            {esp32Devices.length > 1 && (
              <select
                value={diagDevice?.id ?? ''}
                onChange={(e) => setDiagDeviceId(e.target.value)}
                style={{ padding: '9px 11px', borderRadius: '8px', border: '1px solid oklch(34% 0.02 250)', background: 'oklch(15% 0.02 250)', color: 'white', fontSize: '12.5px', fontFamily: "'IBM Plex Mono',monospace", maxWidth: '260px' }}
              >
                {esp32Devices.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            )}
          </div>

          {esp32Devices.length === 0 ? (
            <div style={{ background: 'oklch(19% 0.022 250)', border: '1px solid oklch(30% 0.02 250)', borderRadius: '12px', padding: '20px', marginBottom: '16px', fontSize: '12.5px', color: 'oklch(62% 0.015 250)' }}>
              Trạm này chưa có thiết bị ESP32 nào — chưa có gì báo chỉ số chẩn đoán về.
            </div>
          ) : (
            <>
              <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '11.5px', color: 'oklch(58% 0.015 250)', marginBottom: '10px' }}>
                {diagDevice.aws_thing_name} · {devRelative(diagDevice.last_seen_at)}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px,1fr))', gap: '14px', marginBottom: '16px' }}>
                <DiagCard label="Thời gian hoạt động" value={diagUptime} />
                <DiagCard label="Nhiệt độ MCU" value={diagMcuTemp} />
                <DiagCard label="Số lần khởi động lại" value={diagBootCount} />
                <div style={{ background: 'oklch(19% 0.022 250)', border: '1px solid oklch(30% 0.02 250)', borderRadius: '12px', padding: '16px' }}>
                  <div style={{ fontSize: '11.5px', color: 'oklch(62% 0.015 250)', marginBottom: '8px' }}>Kết nối MQTT Broker</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '2px' }}>
                    <span style={{ width: '7px', height: '7px', borderRadius: '50%', display: 'inline-block', background: STATUS_COLOR[diagMqttOnline ? 'online' : 'offline'] }} />
                    <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '15px', fontWeight: 700, color: STATUS_COLOR[diagMqttOnline ? 'online' : 'offline'] }}>
                      {diagMqttOnline ? 'Connected' : 'Disconnected'}
                    </span>
                  </div>
                </div>
              </div>
            </>
          )}

          <div style={{ background: 'oklch(19% 0.022 250)', border: '1px solid oklch(30% 0.02 250)', borderRadius: '12px', padding: '20px' }}>
            <h2 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '15px', fontWeight: 700, margin: '0 0 14px' }}>Thiết bị đang hoạt động</h2>
            {stationDevices.length === 0 ? (
              <div style={{ padding: '18px 2px', fontSize: '12.5px', color: 'oklch(62% 0.015 250)' }}>Chưa có thiết bị nào được đăng ký cho trạm này.</div>
            ) : stationDevices.map((d) => {
              const status = stationOffline ? 'offline' : d.status === 'connected' ? 'online' : 'offline';
              const online = status === 'online';
              const typeLabel = DEVICE_TYPE_LABEL[d.type] ?? d.type;
              return (
                <div
                  key={d.id}
                  onClick={() => setSelectedDevice(d)}
                  title="Xem thông tin thiết bị"
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 2px', borderBottom: '1px solid oklch(26% 0.02 250)', cursor: 'pointer' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span style={{ width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0, background: STATUS_COLOR[status] }} />
                    <div>
                      <div style={{ fontSize: '13.5px', fontWeight: 600 }}>{d.name} · {typeLabel}</div>
                      <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '11.5px', color: 'oklch(62% 0.015 250)', marginTop: '2px' }}>{d.aws_thing_name} · {devRelative(d.last_seen_at)}</div>
                    </div>
                  </div>
                  <span style={{ fontSize: '11px', fontWeight: 700, padding: '3px 9px', borderRadius: '20px', color: online ? 'oklch(70% 0.15 150)' : 'oklch(70% 0.16 25)', background: online ? 'oklch(28% 0.05 150)' : 'oklch(28% 0.06 25)' }}>{online ? 'Online' : 'Offline'}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* FIRMWARE */}
        <div id="dsec-firmware" style={{ scrollMarginTop: '24px', marginBottom: '32px' }}>
          <h1 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '22px', fontWeight: 700, margin: '0 0 4px' }}>Quản lý Firmware MCU</h1>
          <p style={{ fontSize: '13px', color: 'oklch(62% 0.015 250)', margin: '0 0 20px' }}>Tải bản .bin lên, đẩy OTA qua AWS IoT và theo dõi phiên bản thiết bị báo về</p>

          {/* Thiết bị + đích đẩy. Bản firmware phải chọn tường minh ở đây: đẩy
              nhầm ảnh là hỏng phần cứng thật, không sửa từ xa được. */}
          <div style={{ background: 'oklch(19% 0.022 250)', border: '1px solid oklch(30% 0.02 250)', borderRadius: '12px', padding: '20px', marginBottom: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '14px', flexWrap: 'wrap', marginBottom: '14px' }}>
              <div>
                <h2 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '15px', fontWeight: 700, margin: '0 0 4px' }}>Thiết bị</h2>
                <p style={{ fontSize: '12px', color: 'oklch(62% 0.015 250)', margin: 0 }}>Phiên bản do thiết bị tự báo về — chênh với bản đã đẩy nghĩa là nạp chưa xong</p>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                <select
                  value={selectedReleaseId}
                  onChange={(e) => setSelectedReleaseId(e.target.value)}
                  disabled={releases.length === 0}
                  style={{ padding: '9px 11px', borderRadius: '8px', border: '1px solid oklch(34% 0.02 250)', background: 'oklch(15% 0.02 250)', color: 'white', fontSize: '12.5px', fontFamily: "'IBM Plex Mono',monospace", maxWidth: '260px' }}
                >
                  <option value="">{releasesLoading ? 'Đang tải…' : releases.length === 0 ? 'Chưa có bản nào' : 'Chọn bản để đẩy…'}</option>
                  {releases.map((r) => (
                    <option key={r.id} value={r.id}>{r.version} · {r.board}</option>
                  ))}
                </select>
                <button
                  onClick={() => handlePushOta('all')}
                  disabled={!selectedReleaseId || esp32Devices.length === 0 || pushingTarget !== null}
                  style={{ padding: '10px 18px', borderRadius: '8px', border: 'none', background: ACCENT, color: 'oklch(12% 0.02 250)', fontSize: '13px', fontWeight: 700, cursor: (!selectedReleaseId || esp32Devices.length === 0 || pushingTarget !== null) ? 'not-allowed' : 'pointer', opacity: (!selectedReleaseId || esp32Devices.length === 0 || pushingTarget !== null) ? 0.5 : 1, whiteSpace: 'nowrap' }}
                >
                  {pushingTarget === 'all' ? 'Đang gửi…' : 'Đẩy OTA đến tất cả thiết bị'}
                </button>
              </div>
            </div>

            {esp32Devices.length === 0 ? (
              <div style={{ padding: '18px 2px', fontSize: '12.5px', color: 'oklch(62% 0.015 250)' }}>
                Trạm này chưa có thiết bị ESP32 nào. Chỉ ESP32 nhận được OTA — inverter/BMS/cảm biến là thiết bị hãng khác.
              </div>
            ) : esp32Devices.map((d) => {
              const online = !stationOffline && d.status === 'connected';
              const statusMeta = FW_STATUS_META[d.fw_status] ?? FW_STATUS_META.idle;
              const detailText = fwStatusDetailText(d.fw_status_detail);
              // Bản cloud đã ra lệnh nạp. Hàng có thể đã bị xoá khỏi catalog —
              // khi đó chỉ còn biết là "đã đẩy một bản không còn tồn tại".
              const target = d.fw_target_id ? releases.find((r) => r.id === d.fw_target_id) : null;
              const targetPending = d.fw_target_id && (!target || target.version !== d.fw_version);
              const busy = pushingTarget === d.id;
              return (
                <div key={d.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 2px', borderBottom: '1px solid oklch(26% 0.02 250)', flexWrap: 'wrap', gap: '10px' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', minWidth: 0 }}>
                    <span style={{ width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0, marginTop: '5px', background: STATUS_COLOR[online ? 'online' : 'offline'] }} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: '13.5px', fontWeight: 600 }}>{d.name}</div>
                      <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '11.5px', color: 'oklch(62% 0.015 250)', marginTop: '3px' }}>
                        {d.fw_version || 'chưa báo phiên bản'}
                        {d.fw_reported_at ? ` · từ ${devRelative(d.fw_reported_at)}` : ''}
                      </div>
                      {targetPending && (
                        <div style={{ fontSize: '11.5px', color: 'oklch(78% 0.14 70)', marginTop: '3px' }}>
                          Đã đẩy {target ? target.version : 'một bản đã bị xoá'} — thiết bị chưa xác nhận
                        </div>
                      )}
                      {detailText && (
                        <div style={{ fontSize: '11.5px', color: d.fw_status === 'failed' ? 'oklch(75% 0.14 25)' : 'oklch(58% 0.015 250)', marginTop: '3px' }}>{detailText}</div>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 }}>
                    <span style={{ fontSize: '11px', fontWeight: 700, padding: '3px 9px', borderRadius: '20px', color: statusMeta.color, background: statusMeta.bg, whiteSpace: 'nowrap' }}>{statusMeta.label}</span>
                    <button
                      onClick={() => handlePushOta(d.id)}
                      disabled={!selectedReleaseId || pushingTarget !== null}
                      title={selectedReleaseId ? undefined : 'Chọn một bản firmware trước'}
                      style={{ padding: '7px 14px', borderRadius: '8px', border: '1px solid oklch(38% 0.03 250)', background: 'oklch(22% 0.025 250)', fontSize: '12px', fontWeight: 600, color: 'oklch(85% 0.01 250)', cursor: (!selectedReleaseId || pushingTarget !== null) ? 'not-allowed' : 'pointer', opacity: (!selectedReleaseId || pushingTarget !== null) ? 0.5 : 1, fontFamily: "'IBM Plex Mono',monospace", whiteSpace: 'nowrap' }}
                    >
                      {busy ? 'Đang gửi…' : 'Cập nhật'}
                    </button>
                  </div>
                </div>
              );
            })}

            {fwPushError && (
              <div style={{ fontSize: '12.5px', color: 'oklch(80% 0.14 25)', lineHeight: 1.6, marginTop: '14px' }}>{fwPushError}</div>
            )}
            {fwPushOk && (
              <div style={{ fontSize: '12.5px', color: 'oklch(75% 0.13 150)', lineHeight: 1.6, marginTop: '14px' }}>
                {fwPushOk} Thiết bị sẽ báo lại tiến trình qua telemetry.
              </div>
            )}
          </div>

          {/* Tải lên: file vào bucket `firmware` (private) + một hàng
              firmware_releases. Hash tính ngay tại trình duyệt từ đúng bytes
              sắp gửi đi — firmware kiểm lại chuỗi này trước khi nạp. */}
          <div style={{ background: 'oklch(19% 0.022 250)', border: '1px solid oklch(30% 0.02 250)', borderRadius: '12px', padding: '20px', marginBottom: '16px' }}>
            <h2 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '15px', fontWeight: 700, margin: '0 0 4px' }}>Tải bản firmware mới lên</h2>
            <p style={{ fontSize: '12.5px', color: 'oklch(62% 0.015 250)', margin: '0 0 14px' }}>Định dạng .bin, biên dịch từ PlatformIO/Arduino IDE · tối đa {formatBytes(FIRMWARE_MAX_BYTES)}</p>

            <input
              ref={fwFileInputRef}
              type="file"
              accept=".bin,application/octet-stream"
              onChange={(e) => pickFwFile(e.target.files?.[0])}
              style={{ display: 'none' }}
            />
            <div
              onDragOver={(e) => { e.preventDefault(); setFwDragging(true); }}
              onDragLeave={() => setFwDragging(false)}
              onDrop={(e) => { e.preventDefault(); setFwDragging(false); pickFwFile(e.dataTransfer.files?.[0]); }}
              style={{ border: `1.5px dashed ${fwDragging ? ACCENT : 'oklch(38% 0.03 250)'}`, background: fwDragging ? 'oklch(24% 0.04 200)' : 'transparent', borderRadius: '10px', padding: '24px', textAlign: 'center', marginBottom: '16px', transition: 'background 0.15s' }}
            >
              {fwFile ? (
                <div>
                  <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '13px', color: 'oklch(88% 0.01 250)', wordBreak: 'break-all' }}>{fwFile.name}</div>
                  <div style={{ fontSize: '12px', color: fwFile.size > FIRMWARE_MAX_BYTES ? 'oklch(75% 0.14 25)' : 'oklch(62% 0.015 250)', marginTop: '5px' }}>
                    {formatBytes(fwFile.size)}{fwFile.size > FIRMWARE_MAX_BYTES ? ` — vượt giới hạn ${formatBytes(FIRMWARE_MAX_BYTES)}` : ''}
                  </div>
                  <button onClick={() => { setFwFile(null); if (fwFileInputRef.current) fwFileInputRef.current.value = ''; }} style={{ marginTop: '10px', background: 'none', border: 'none', color: ACCENT, fontSize: '12.5px', fontWeight: 700, cursor: 'pointer', fontFamily: "'Manrope',sans-serif", padding: 0 }}>Chọn file khác</button>
                </div>
              ) : (
                <>
                  <div style={{ fontSize: '13px', color: 'oklch(70% 0.02 250)', marginBottom: '10px' }}>Kéo thả file .bin vào đây</div>
                  <button onClick={() => fwFileInputRef.current?.click()} style={{ padding: '9px 18px', borderRadius: '8px', border: '1px solid oklch(38% 0.03 250)', background: 'oklch(22% 0.025 250)', fontSize: '13px', fontWeight: 600, color: 'oklch(85% 0.01 250)', cursor: 'pointer' }}>Chọn file</button>
                </>
              )}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '11.5px', color: 'oklch(62% 0.015 250)', marginBottom: '6px' }}>Board</label>
                <input type="text" value={fwBoard} onChange={(e) => setFwBoard(e.target.value)} placeholder={DEFAULT_BOARD} style={darkFieldStyle} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '11.5px', color: 'oklch(62% 0.015 250)', marginBottom: '6px' }}>Phiên bản</label>
                <input type="text" value={fwVersion} onChange={(e) => setFwVersion(e.target.value)} placeholder="v2.3.1" style={darkFieldStyle} />
              </div>
            </div>
            <div style={{ marginBottom: '14px' }}>
              <label style={{ display: 'block', fontSize: '11.5px', color: 'oklch(62% 0.015 250)', marginBottom: '6px' }}>Ghi chú phát hành</label>
              <textarea value={fwNotes} onChange={(e) => setFwNotes(e.target.value)} rows={2} placeholder="Sửa lỗi đọc cảm biến dòng điện khi tải cao" style={{ ...darkFieldStyle, fontFamily: "'Manrope',sans-serif", resize: 'vertical' }} />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
              <button
                onClick={handleUploadRelease}
                disabled={fwUploading || !fwFile || !fwBoard.trim() || !fwVersion.trim()}
                style={{ padding: '10px 20px', borderRadius: '8px', border: 'none', background: ACCENT, color: 'oklch(12% 0.02 250)', fontSize: '13px', fontWeight: 700, cursor: (fwUploading || !fwFile || !fwBoard.trim() || !fwVersion.trim()) ? 'not-allowed' : 'pointer', opacity: (fwUploading || !fwFile || !fwBoard.trim() || !fwVersion.trim()) ? 0.5 : 1 }}
              >
                {fwUploading ? 'Đang tải lên…' : 'Tải lên'}
              </button>
              {fwUploadOk && <span style={{ fontSize: '12.5px', fontWeight: 600, color: 'oklch(75% 0.13 150)' }}>{fwUploadOk}</span>}
            </div>
            {fwUploadError && (
              <div style={{ fontSize: '12.5px', color: 'oklch(80% 0.14 25)', lineHeight: 1.6, marginTop: '12px' }}>{fwUploadError}</div>
            )}
            <p style={{ fontSize: '11.5px', color: 'oklch(55% 0.015 250)', margin: '14px 0 0', lineHeight: 1.6 }}>
              <strong>Phiên bản</strong> phải trùng <span style={{ fontFamily: "'IBM Plex Mono',monospace", color: 'oklch(72% 0.01 250)' }}>FW_VERSION</span> và <strong>Board</strong> phải trùng <span style={{ fontFamily: "'IBM Plex Mono',monospace", color: 'oklch(72% 0.01 250)' }}>FW_BOARD</span> trong <span style={{ fontFamily: "'IBM Plex Mono',monospace", color: 'oklch(72% 0.01 250)' }}>.ino</span> của bản build này — thiết bị dùng hai chuỗi đó để từ chối ảnh sai board và để cloud biết đã nạp xong. Một bản đã tải lên là bất biến: sửa = tải lên phiên bản mới.
            </p>
          </div>

          {/* Catalog. Rollback = chọn một bản cũ ở đây rồi bấm "Cập nhật" ở khối
              Thiết bị — không có đường nào khác, và cũng không cần. */}
          <div style={{ background: 'oklch(19% 0.022 250)', border: '1px solid oklch(30% 0.02 250)', borderRadius: '12px', padding: '20px' }}>
            <h2 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '15px', fontWeight: 700, margin: '0 0 4px' }}>Bản phát hành</h2>
            <p style={{ fontSize: '12px', color: 'oklch(62% 0.015 250)', margin: '0 0 14px' }}>Bấm để chọn bản sẽ đẩy — chọn một bản cũ hơn chính là rollback</p>

            {releasesLoading ? (
              <div style={{ padding: '14px 2px', fontSize: '12.5px', color: 'oklch(62% 0.015 250)' }}>Đang tải…</div>
            ) : releases.length === 0 ? (
              <div style={{ padding: '14px 2px', fontSize: '12.5px', color: 'oklch(62% 0.015 250)' }}>Chưa có bản firmware nào — tải lên ở khối bên trên.</div>
            ) : releases.map((r) => {
              const selected = r.id === selectedReleaseId;
              const running = runningVersions.has(r.version);
              const confirming = confirmDeleteReleaseId === r.id;
              return (
                <div
                  key={r.id}
                  onClick={() => setSelectedReleaseId(r.id)}
                  title="Chọn bản này để đẩy"
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', padding: '12px 10px', marginBottom: '6px', borderRadius: '9px', cursor: 'pointer', border: `1px solid ${selected ? 'oklch(75% 0.13 200 / 0.6)' : 'transparent'}`, background: selected ? 'oklch(24% 0.04 200)' : 'transparent' }}
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', minWidth: 0 }}>
                    <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '13px', fontWeight: 600, color: ACCENT, flexShrink: 0 }}>{r.version}</span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: '13px' }}>{r.releaseNotes || <span style={{ color: 'oklch(55% 0.015 250)' }}>Không có ghi chú</span>}</div>
                      <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '11px', color: 'oklch(58% 0.015 250)', marginTop: '3px', wordBreak: 'break-all' }}>
                        {r.board} · {formatBytes(r.sizeBytes)} · {new Date(r.createdAt).toLocaleDateString('vi-VN')} · sha256 {r.sha256.slice(0, 12)}…
                      </div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 }}>
                    {running && (
                      <span style={{ fontSize: '11px', fontWeight: 700, padding: '4px 10px', borderRadius: '20px', color: 'oklch(70% 0.15 150)', background: 'oklch(28% 0.05 150)', whiteSpace: 'nowrap' }}>Đang chạy</span>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDeleteRelease(r.id); }}
                      onBlur={() => confirming && setConfirmDeleteReleaseId(null)}
                      style={{ padding: '6px 12px', borderRadius: '7px', border: `1px solid ${confirming ? 'oklch(70% 0.16 25)' : 'oklch(38% 0.03 250)'}`, background: confirming ? 'oklch(28% 0.06 25)' : 'oklch(22% 0.025 250)', fontSize: '11.5px', fontWeight: 600, color: confirming ? 'oklch(80% 0.14 25)' : 'oklch(80% 0.01 250)', cursor: 'pointer', whiteSpace: 'nowrap' }}
                    >
                      {confirming ? 'Xác nhận xoá?' : 'Xoá'}
                    </button>
                  </div>
                </div>
              );
            })}

            {releases.length > 0 && (
              <p style={{ fontSize: '11.5px', color: 'oklch(55% 0.015 250)', margin: '10px 0 0', lineHeight: 1.6 }}>
                "Đang chạy" là phiên bản thiết bị tự báo về, không phải bản cloud đã gửi lệnh. Xoá một bản sẽ xoá cả file .bin trong bucket — thiết bị đang nạp dở bản đó sẽ chuyển sang "Thất bại".
              </p>
            )}
          </div>
        </div>

        {/* MODULE VISIBILITY */}
        <div id="dsec-modules" style={{ scrollMarginTop: '24px', marginBottom: '32px' }}>
          <h1 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '22px', fontWeight: 700, margin: '0 0 4px' }}>Hiển thị module trên giao diện người dùng</h1>
          <p style={{ fontSize: '13px', color: 'oklch(62% 0.015 250)', margin: '0 0 20px' }}>Bật/tắt các khối hiển thị trên trang Tổng quan của người dùng cuối — riêng cho trạm <strong>{currentStation.name}</strong></p>

          <div style={lockedWhileLoading(settings.loading)}>
            <div style={{ background: 'oklch(19% 0.022 250)', border: '1px solid oklch(30% 0.02 250)', borderRadius: '12px', padding: '8px 20px', marginBottom: '16px' }}>
              {moduleVisibility.map((item) => (
                <div key={item.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 2px', borderBottom: '1px solid oklch(26% 0.02 250)' }}>
                  <div>
                    <div style={{ fontSize: '14px', fontWeight: 600 }}>{item.label}</div>
                    <div style={{ fontSize: '12px', color: 'oklch(62% 0.015 250)', marginTop: '3px' }}>{item.desc}</div>
                  </div>
                  <Switch on={item.on} onClick={() => toggleModule(item.id)} />
                </div>
              ))}
            </div>
            <ApplyAllButton label="Áp dụng cho tất cả trạm" confirming={confirmApplyModules} onClick={handleApplyModulesToAll} />
          </div>
        </div>

        {/* BATTERY PROTECTION THRESHOLDS */}
        <div id="dsec-battery" style={{ scrollMarginTop: '24px', marginBottom: '32px' }}>
          <h1 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '22px', fontWeight: 700, margin: '0 0 4px' }}>Ngưỡng sạc / xả pin</h1>
          <p style={{ fontSize: '13px', color: 'oklch(62% 0.015 250)', margin: '0 0 20px' }}>Cấu hình ngưỡng kỹ thuật cho từng mức Chế độ bảo vệ pin — riêng cho trạm <strong>{currentStation.name}</strong></p>

          <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
            <button style={chipStyle(editingMode === 'low')} onClick={() => setEditingMode('low')}>Thấp</button>
            <button style={chipStyle(editingMode === 'balanced')} onClick={() => setEditingMode('balanced')}>Cân bằng</button>
            <button style={chipStyle(editingMode === 'max')} onClick={() => setEditingMode('max')}>Tối đa</button>
          </div>

          <div style={lockedWhileLoading(settings.loading)}>
          <div style={{ background: 'oklch(19% 0.022 250)', border: '1px solid oklch(30% 0.02 250)', borderRadius: '12px', padding: '20px', marginBottom: '16px' }}>
            <h2 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '15px', fontWeight: 700, margin: '0 0 4px' }}>Mô tả hiển thị cho người dùng</h2>
            <p style={{ fontSize: '12px', color: 'oklch(62% 0.015 250)', margin: '0 0 12px' }}>Nội dung xuất hiện trên thẻ chọn chế độ ở giao diện người dùng cuối, cho mức đang chỉnh: <strong>{MODE_LABELS[editingMode]}</strong></p>
            <textarea
              value={editing.desc}
              onChange={(e) => updateEditing({ desc: e.target.value })}
              rows={3}
              style={{ width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: '8px', border: '1px solid oklch(34% 0.02 250)', background: 'oklch(15% 0.02 250)', color: 'white', fontSize: '13px', fontFamily: "'Manrope',sans-serif", resize: 'vertical' }}
            />
          </div>

          <div style={{ background: 'oklch(19% 0.022 250)', border: '1px solid oklch(30% 0.02 250)', borderRadius: '12px', padding: '24px', marginBottom: '16px' }}>
            <h2 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '15px', fontWeight: 700, margin: '0 0 18px' }}>Ngưỡng kỹ thuật</h2>

            <div style={{ marginBottom: '22px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                <label style={{ fontSize: '13px', fontWeight: 600 }}>Ngưỡng dừng sạc (SOC tối đa)</label>
                <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '13px', color: ACCENT }}>{editing.maxSoc}%</span>
              </div>
              <input type="range" min="60" max="100" step="1" value={editing.maxSoc} onChange={(e) => updateEditing({ maxSoc: Math.max(+e.target.value, editing.minSoc + 5) })} style={{ width: '100%', accentColor: ACCENT }} />
            </div>

            <div style={{ marginBottom: '22px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                <label style={{ fontSize: '13px', fontWeight: 600 }}>Ngưỡng cắt xả (SOC tối thiểu)</label>
                <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '13px', color: ACCENT }}>{editing.minSoc}%</span>
              </div>
              <input type="range" min="5" max="55" step="1" value={editing.minSoc} onChange={(e) => updateEditing({ minSoc: Math.min(+e.target.value, editing.maxSoc - 5) })} style={{ width: '100%', accentColor: ACCENT }} />
            </div>

            <div style={{ marginBottom: '22px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                <label style={{ fontSize: '13px', fontWeight: 600 }}>Dòng sạc tối đa</label>
                <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '13px', color: ACCENT }}>{editing.maxCurrent} A</span>
              </div>
              <input type="range" min="5" max="50" step="1" value={editing.maxCurrent} onChange={(e) => updateEditing({ maxCurrent: +e.target.value })} style={{ width: '100%', accentColor: ACCENT }} />
            </div>

            <div style={{ marginBottom: '8px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                <label style={{ fontSize: '13px', fontWeight: 600 }}>Điện áp sạc tối đa</label>
                <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '13px', color: ACCENT }}>{editing.maxVoltage.toFixed(1)} V</span>
              </div>
              <input type="range" min="48" max="58" step="0.1" value={editing.maxVoltage} onChange={(e) => updateEditing({ maxVoltage: +e.target.value })} style={{ width: '100%', accentColor: ACCENT }} />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: '16px', marginTop: '14px', borderTop: '1px solid oklch(26% 0.02 250)' }}>
              <div>
                <div style={{ fontSize: '13.5px', fontWeight: 600 }}>Bảo vệ xả sâu</div>
                <div style={{ fontSize: '12px', color: 'oklch(62% 0.015 250)', marginTop: '2px' }}>Tự động ngắt tải khi pin chạm SOC tối thiểu ở mức này</div>
              </div>
              <Switch on={editing.deepDischargeProtect} onClick={() => updateEditing({ deepDischargeProtect: !editing.deepDischargeProtect })} />
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
            <button onClick={saveBatteryModes} style={{ padding: '11px 22px', borderRadius: '8px', border: 'none', background: ACCENT, color: 'oklch(12% 0.02 250)', fontSize: '13.5px', fontWeight: 700, cursor: 'pointer' }}>Lưu cấu hình ngưỡng pin</button>
            <button onClick={resetBatteryModes} style={{ padding: '11px 18px', borderRadius: '8px', border: '1px solid oklch(38% 0.03 250)', background: 'oklch(22% 0.025 250)', fontSize: '13px', fontWeight: 600, color: 'oklch(85% 0.01 250)', cursor: 'pointer' }}>Khôi phục mặc định</button>
            <ApplyAllButton label="Áp dụng cho tất cả trạm" confirming={confirmApplyBattery} onClick={handleApplyBatteryToAll} />
            {batteryModesSaved && (
              <span style={{ fontSize: '13px', fontWeight: 600, color: 'oklch(70% 0.15 150)' }}>Đã lưu cấu hình</span>
            )}
          </div>
          </div>
        </div>

        {/* CALIBRATION */}
        <div id="dsec-calibration" style={{ scrollMarginTop: '24px', marginBottom: '32px' }}>
          <h1 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '22px', fontWeight: 700, margin: '0 0 4px' }}>Hiệu chỉnh cảm biến<DemoBadge /></h1>
          <p style={{ fontSize: '13px', color: 'oklch(62% 0.015 250)', margin: '0 0 20px' }}>Điều chỉnh hệ số nhân &amp; độ lệch để bù sai số ADC phần cứng</p>

          <div style={{ background: 'oklch(19% 0.022 250)', border: '1px solid oklch(30% 0.02 250)', borderRadius: '12px', padding: '20px' }}>
            {SENSORS.map((item) => (
              <div key={item.name} style={{ padding: '16px 2px', borderBottom: '1px solid oklch(26% 0.02 250)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px', flexWrap: 'wrap', gap: '8px' }}>
                  <span style={{ fontSize: '13.5px', fontWeight: 600 }}>{item.name}</span>
                  <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '12px', color: 'oklch(62% 0.015 250)' }}>thô: {item.raw} → <span style={{ color: ACCENT, fontWeight: 600 }}>{item.calibrated}</span></span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: '12px', alignItems: 'end' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '11.5px', color: 'oklch(62% 0.015 250)', marginBottom: '6px' }}>Hệ số nhân</label>
                    <input type="text" defaultValue={item.scale} style={{ width: '100%', boxSizing: 'border-box', padding: '9px 11px', borderRadius: '7px', border: '1px solid oklch(34% 0.02 250)', background: 'oklch(15% 0.02 250)', color: 'white', fontSize: '13px', fontFamily: "'IBM Plex Mono',monospace" }} />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '11.5px', color: 'oklch(62% 0.015 250)', marginBottom: '6px' }}>Độ lệch (offset)</label>
                    <input type="text" defaultValue={item.offset} style={{ width: '100%', boxSizing: 'border-box', padding: '9px 11px', borderRadius: '7px', border: '1px solid oklch(34% 0.02 250)', background: 'oklch(15% 0.02 250)', color: 'white', fontSize: '13px', fontFamily: "'IBM Plex Mono',monospace" }} />
                  </div>
                  <button style={{ padding: '9px 14px', borderRadius: '7px', border: '1px solid oklch(38% 0.03 250)', background: 'oklch(22% 0.025 250)', fontSize: '12px', fontWeight: 600, color: 'oklch(85% 0.01 250)', cursor: 'pointer', whiteSpace: 'nowrap' }}>Zero lại</button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* NETWORK */}
        <div id="dsec-network" style={{ scrollMarginTop: '24px', marginBottom: '32px' }}>
          <h1 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '22px', fontWeight: 700, margin: '0 0 4px' }}>Cấu hình mạng</h1>
          <p style={{ fontSize: '13px', color: 'oklch(62% 0.015 250)', margin: '0 0 20px' }}>Điểm phát WiFi cục bộ và xác thực thiết bị</p>

          <div style={{ background: 'oklch(19% 0.022 250)', border: '1px solid oklch(30% 0.02 250)', borderRadius: '12px', padding: '20px', marginBottom: '16px' }}>
            <h2 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '15px', fontWeight: 700, margin: '0 0 6px' }}>Điểm phát WiFi (Access Point)</h2>
            <p style={{ fontSize: '12px', color: 'oklch(62% 0.015 250)', margin: '0 0 16px', lineHeight: 1.55 }}>
              Mỗi ESP32-S3 tự phát một mạng WiFi riêng để truy cập tại chỗ khi trạm mất internet — kết nối vào mạng của thiết bị rồi mở <span style={{ fontFamily: "'IBM Plex Mono',monospace", color: 'oklch(80% 0.01 250)' }}>http://192.168.4.1</span>.
            </p>

            {stationDevices.length === 0 ? (
              <div style={{ padding: '14px 2px', fontSize: '12.5px', color: 'oklch(62% 0.015 250)' }}>Chưa có thiết bị nào được đăng ký cho trạm này.</div>
            ) : stationDevices.map((d) => (
              <div key={d.id} style={{ padding: '13px 2px', borderBottom: '1px solid oklch(26% 0.02 250)' }}>
                {/* Dòng tiêu đề thiết bị — cùng bố cục với khối X.509 bên dưới:
                    định danh bên trái, huy hiệu trạng thái bên phải. */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '13px', fontWeight: 600 }}>{d.aws_thing_name}</div>
                    <div style={{ fontSize: '11.5px', color: 'oklch(62% 0.015 250)', marginTop: '2px' }}>
                      {d.name}{d.ap_reported_at ? ` · báo lúc ${devRelative(d.ap_reported_at)}` : ''}
                    </div>
                  </div>
                  <span style={{ fontSize: '11px', fontWeight: 700, padding: '3px 9px', borderRadius: '20px', color: d.ap_ssid ? 'oklch(70% 0.15 150)' : 'oklch(68% 0.015 250)', background: d.ap_ssid ? 'oklch(28% 0.05 150)' : 'oklch(26% 0.02 250)' }}>
                    {d.ap_ssid ? 'Đang phát' : 'Chưa báo'}
                  </span>
                </div>

                {d.ap_ssid && (
                  <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '12px', marginTop: '12px' }}>
                    <CopyField label="Tên mạng (SSID)" value={d.ap_ssid} compact />
                    <CopyField label="Mật khẩu" value={d.ap_password ?? '—'} secret compact />
                  </div>
                )}
              </div>
            ))}

            {/* Ghi chú chung, đặt MỘT lần dưới danh sách. Trước đây phần giải
                thích "chưa báo" lặp nguyên văn ở từng thiết bị, chiếm gần hết
                khối và làm chìm mất chính SSID/mật khẩu cần đọc. */}
            <p style={{ fontSize: '11.5px', color: 'oklch(55% 0.015 250)', margin: '14px 0 0', lineHeight: 1.6 }}>
              Giá trị do thiết bị tự báo lên — đây là mạng nó đang thực sự phát. Đổi bằng cách sửa <span style={{ fontFamily: "'IBM Plex Mono',monospace", color: 'oklch(72% 0.01 250)' }}>AP_SSID</span>/<span style={{ fontFamily: "'IBM Plex Mono',monospace", color: 'oklch(72% 0.01 250)' }}>AP_PASSWORD</span> trong <span style={{ fontFamily: "'IBM Plex Mono',monospace", color: 'oklch(72% 0.01 250)' }}>secrets.h</span> rồi nạp lại firmware.
              {stationDevices.some((d) => !d.ap_ssid) && ' Thiết bị "Chưa báo" cần bản firmware có SoftAP, sau đó chờ nó kết nối lại.'}
            </p>
          </div>

          <div style={{ background: 'oklch(19% 0.022 250)', border: '1px solid oklch(30% 0.02 250)', borderRadius: '12px', padding: '20px' }}>
            <h2 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '15px', fontWeight: 700, margin: '0 0 6px' }}>Xác thực thiết bị (AWS IoT X.509)</h2>
            <p style={{ fontSize: '12px', color: 'oklch(62% 0.015 250)', margin: '0 0 14px', lineHeight: 1.55 }}>
              Mỗi thiết bị xác thực với AWS IoT Core bằng chứng chỉ X.509 riêng (quản lý trong AWS, không hiển thị ở đây). Dữ liệu đẩy về server qua Edge Function <span style={{ fontFamily: "'IBM Plex Mono',monospace", color: 'oklch(80% 0.01 250)' }}>ingest-telemetry</span>. Khoá bí mật của rule nằm phía server. Hướng dẫn cấp chứng chỉ: <span style={{ fontFamily: "'IBM Plex Mono',monospace", color: 'oklch(80% 0.01 250)' }}>docs/IOT.md</span>.
            </p>
            {stationDevices.length === 0 ? (
              <div style={{ padding: '14px 2px', fontSize: '12.5px', color: 'oklch(62% 0.015 250)' }}>Chưa có thiết bị nào được đăng ký cho trạm này.</div>
            ) : stationDevices.map((d) => {
              const online = !stationOffline && d.status === 'connected';
              return (
                <div
                  key={d.id}
                  onClick={() => setSelectedDevice(d)}
                  title="Xem thông tin thiết bị"
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', padding: '11px 2px', borderBottom: '1px solid oklch(26% 0.02 250)', flexWrap: 'wrap', cursor: 'pointer' }}
                >
                  <div>
                    <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '13px', fontWeight: 600 }}>{d.aws_thing_name}</div>
                    <div style={{ fontSize: '11.5px', color: 'oklch(62% 0.015 250)', marginTop: '2px' }}>{d.name} · {devRelative(d.last_seen_at)}</div>
                  </div>
                  <span style={{ fontSize: '11px', fontWeight: 700, padding: '3px 9px', borderRadius: '20px', color: online ? 'oklch(70% 0.15 150)' : 'oklch(70% 0.16 25)', background: online ? 'oklch(28% 0.05 150)' : 'oklch(28% 0.06 25)' }}>{online ? 'Đã xác thực' : 'Ngoại tuyến'}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* LOGS */}
        <div id="dsec-logs" style={{ scrollMarginTop: '24px', marginBottom: '32px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '14px', flexWrap: 'wrap', marginBottom: '16px' }}>
            <div>
              <h1 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '22px', fontWeight: 700, margin: '0 0 4px' }}>Nhật ký hệ thống</h1>
              <p style={{ fontSize: '13px', color: 'oklch(62% 0.015 250)', margin: 0 }}>
                Sự kiện thật do thiết bị và server ghi lại — mất kết nối, vượt ngưỡng pin, cập nhật firmware, dọn dữ liệu
              </p>
            </div>
            <button
              onClick={handleClearLogs}
              disabled={logs.length === 0}
              style={{ padding: '9px 16px', borderRadius: '8px', border: confirmClearLogs ? '1px solid oklch(70% 0.16 25)' : '1px solid oklch(38% 0.03 250)', background: confirmClearLogs ? 'oklch(28% 0.06 25)' : 'oklch(22% 0.025 250)', fontSize: '12.5px', fontWeight: 600, color: confirmClearLogs ? 'oklch(80% 0.14 25)' : 'oklch(85% 0.01 250)', cursor: logs.length === 0 ? 'default' : 'pointer', opacity: logs.length === 0 ? 0.45 : 1, whiteSpace: 'nowrap' }}
            >
              {confirmClearLogs ? 'Xác nhận xoá nhật ký trạm này?' : 'Xoá nhật ký'}
            </button>
          </div>

          <div style={{ display: 'flex', gap: '8px', marginBottom: '14px', flexWrap: 'wrap' }}>
            <button style={chipStyle(logFilter === 'all')} onClick={() => setLogFilter('all')}>Tất cả</button>
            <button style={chipStyle(logFilter === 'info')} onClick={() => setLogFilter('info')}>Info</button>
            <button style={chipStyle(logFilter === 'warn')} onClick={() => setLogFilter('warn')}>Warning</button>
            <button style={chipStyle(logFilter === 'error')} onClick={() => setLogFilter('error')}>Error</button>
          </div>

          <div style={{ background: 'oklch(9% 0.015 250)', border: '1px solid oklch(30% 0.02 250)', borderRadius: '12px', padding: '16px 18px', fontFamily: "'IBM Plex Mono',monospace", fontSize: '12.5px', maxHeight: '420px', overflowY: 'auto' }}>
            {logsLoading ? (
              <div style={{ color: 'oklch(55% 0.015 250)', padding: '6px 0' }}>Đang tải nhật ký…</div>
            ) : logsError ? (
              <div style={{ color: 'oklch(78% 0.14 25)', padding: '6px 0' }}>{logsError}</div>
            ) : logs.length === 0 ? (
              // Nhật ký rỗng là trạng thái TỐT (không có sự cố nào), không phải
              // lỗi — nói rõ để không ai tưởng tính năng chưa chạy, đúng thứ
              // nhầm lẫn mà mảng dữ liệu giả trước đây gây ra.
              <div style={{ color: 'oklch(55% 0.015 250)', padding: '6px 0', lineHeight: 1.7 }}>
                {logFilter === 'all'
                  ? 'Chưa có sự kiện nào được ghi lại cho trạm này. Nhật ký chỉ ghi sự kiện rời rạc (mất/lập lại kết nối, pin dưới ngưỡng, cập nhật firmware, dọn dữ liệu) — thiết bị chạy bình thường thì mục này trống.'
                  : `Không có sự kiện mức ${logFilter.toUpperCase()} nào.`}
              </div>
            ) : (
              logs.map((item) => {
                const meta = LEVEL_META[item.level] ?? LEVEL_META.info;
                return (
                  <div key={item.id} style={{ display: 'flex', gap: '10px', padding: '7px 0', borderBottom: '1px solid oklch(22% 0.015 250)' }}>
                    <span style={{ color: 'oklch(52% 0.015 250)', flexShrink: 0, whiteSpace: 'nowrap' }}>{formatLogTime(item.createdAt)}</span>
                    <span style={{ color: meta.color, fontWeight: 600, flexShrink: 0, width: '54px' }}>{meta.label}</span>
                    <span style={{ color: 'oklch(85% 0.01 250)', minWidth: 0, wordBreak: 'break-word' }}>{item.message}</span>
                  </div>
                );
              })
            )}
          </div>
          {logs.length > 0 && (
            <div style={{ fontSize: '11.5px', color: 'oklch(52% 0.015 250)', marginTop: '8px' }}>
              Hiển thị {logs.length} sự kiện gần nhất
              {retention.settings ? ` · tự động xoá sau ${retention.settings.logRetentionDays} ngày` : ''}
            </div>
          )}
        </div>

        {/* RETENTION / ARCHIVE */}
        <div id="dsec-retention" style={{ scrollMarginTop: '24px', marginBottom: '32px' }}>
          <h1 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '22px', fontWeight: 700, margin: '0 0 4px' }}>Lưu trữ &amp; dọn dữ liệu</h1>
          <p style={{ fontSize: '13px', color: 'oklch(62% 0.015 250)', margin: '0 0 20px' }}>
            Giữ database trong hạn mức bằng cách nén dữ liệu cũ theo tháng và chuyển sang Storage
          </p>

          {/* --- Dung lượng đang dùng --- */}
          <div style={{ background: 'oklch(19% 0.022 250)', border: '1px solid oklch(30% 0.02 250)', borderRadius: '12px', padding: '20px', marginBottom: '16px' }}>
            <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '16px' }}>Dung lượng đang dùng</div>
            {retention.loading || !retention.usage ? (
              <div style={{ fontSize: '12.5px', color: 'oklch(55% 0.015 250)' }}>Đang đo…</div>
            ) : (
              <>
                <UsageBar
                  label="Database (hạn mức free plan)"
                  used={Number(retention.usage.database_bytes) || 0}
                  limit={DB_LIMIT_BYTES}
                  hint={`Trong đó bảng telemetry chiếm ${formatBytes(Number(retention.usage.telemetry_bytes) || 0)} · ${(Number(retention.usage.telemetry_rows) || 0).toLocaleString('vi-VN')} bản ghi của bạn`}
                />
                <UsageBar
                  label="Storage — gói lưu trữ đã nén"
                  used={Number(retention.usage.archive_bytes) || 0}
                  limit={STORAGE_LIMIT_BYTES}
                  hint={`${retention.usage.archive_files || 0} gói · ${(Number(retention.usage.archive_rows) || 0).toLocaleString('vi-VN')} bản ghi đã chuyển khỏi database`}
                />
                <div style={{ fontSize: '11.5px', color: 'oklch(52% 0.015 250)', lineHeight: 1.7, marginTop: '12px', paddingTop: '12px', borderTop: '1px solid oklch(26% 0.02 250)' }}>
                  Đây là hai hạn mức tách biệt của Supabase free plan — chuyển dữ liệu cũ sang Storage
                  giải phóng chỗ trong database mà không mất dữ liệu.
                  {retention.usage.telemetry_oldest && (
                    <> Bản ghi cũ nhất còn trong database: {new Date(retention.usage.telemetry_oldest).toLocaleDateString('vi-VN')}.</>
                  )}
                </div>
              </>
            )}
          </div>

          {/* --- Cài đặt --- */}
          <div style={{ background: 'oklch(19% 0.022 250)', border: '1px solid oklch(30% 0.02 250)', borderRadius: '12px', padding: '24px', marginBottom: '16px', ...lockedWhileLoading(retention.loading) }}>
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '20px', marginBottom: '22px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, marginBottom: '6px' }}>Giữ telemetry trong (ngày)</label>
                <input
                  type="number"
                  min={RETENTION_MIN_DAYS}
                  max={RETENTION_MAX_DAYS}
                  value={retentionDraft?.retentionDays ?? ''}
                  onChange={(e) => {
                    setRetentionDraft((d) => ({ ...d, retentionDays: e.target.value }));
                    setRetentionSaved(false);
                  }}
                  style={darkFieldStyle}
                />
                <div style={{ fontSize: '11.5px', color: 'oklch(55% 0.015 250)', marginTop: '7px', lineHeight: 1.6 }}>
                  Dữ liệu cũ hơn mốc này sẽ được lưu trữ rồi xoá khỏi database. Tối thiểu {RETENTION_MIN_DAYS} ngày
                  để trang Báo cáo (biểu đồ 7 ngày) còn dữ liệu.
                </div>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, marginBottom: '6px' }}>Giữ nhật ký hệ thống trong (ngày)</label>
                <input
                  type="number"
                  min={RETENTION_MIN_DAYS}
                  max={RETENTION_MAX_DAYS}
                  value={retentionDraft?.logRetentionDays ?? ''}
                  onChange={(e) => {
                    setRetentionDraft((d) => ({ ...d, logRetentionDays: e.target.value }));
                    setRetentionSaved(false);
                  }}
                  style={darkFieldStyle}
                />
                <div style={{ fontSize: '11.5px', color: 'oklch(55% 0.015 250)', marginTop: '7px', lineHeight: 1.6 }}>
                  Nhật ký là sự kiện rời rạc nên rất nhẹ — xoá thẳng, không lưu trữ.
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap', paddingTop: '20px', borderTop: '1px solid oklch(28% 0.02 250)' }}>
              <div style={{ flex: 1, minWidth: '260px' }}>
                <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '4px' }}>Nén và lưu lên Storage trước khi xoá</div>
                <div style={{ fontSize: '12.5px', color: 'oklch(62% 0.015 250)', lineHeight: 1.6 }}>
                  Bật: dữ liệu cũ được gom theo tháng, nén gzip, đẩy lên Storage rồi mới xoá — tải về lại được bất cứ lúc nào.
                  Tắt: <strong>xoá thẳng, không khôi phục được</strong>.
                </div>
              </div>
              <Switch
                on={!!retentionDraft?.archiveEnabled}
                onClick={() => {
                  setRetentionDraft((d) => ({ ...d, archiveEnabled: !d.archiveEnabled }));
                  setRetentionSaved(false);
                }}
              />
            </div>

            {retentionDraft && !retentionDraft.archiveEnabled && (
              <div style={{ fontSize: '12.5px', color: 'oklch(80% 0.14 25)', lineHeight: 1.65, marginTop: '16px', background: 'oklch(24% 0.05 25 / 0.35)', border: '1px solid oklch(40% 0.08 25 / 0.4)', borderRadius: '9px', padding: '12px 14px' }}>
                Đang tắt lưu trữ — telemetry cũ hơn {retentionDraft.retentionDays} ngày sẽ bị xoá vĩnh viễn, không có bản sao nào.
              </div>
            )}

            {retentionError && (
              <div style={{ fontSize: '13px', color: 'oklch(80% 0.14 25)', marginTop: '16px' }}>{retentionError}</div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', marginTop: '20px' }}>
              <button
                onClick={handleSaveRetention}
                disabled={!retentionDirty}
                style={{ padding: '11px 22px', borderRadius: '9px', border: 'none', background: retentionDirty ? ACCENT : 'oklch(28% 0.02 250)', color: retentionDirty ? 'oklch(12% 0.02 250)' : 'oklch(55% 0.015 250)', fontSize: '13.5px', fontWeight: 700, cursor: retentionDirty ? 'pointer' : 'default' }}
              >
                Lưu cài đặt
              </button>
              {retentionSaved && !retentionDirty && (
                <span style={{ fontSize: '12.5px', color: 'oklch(70% 0.15 150)', fontWeight: 600 }}>Đã lưu</span>
              )}
              <span style={{ fontSize: '11.5px', color: 'oklch(52% 0.015 250)' }}>
                {retention.settings?.lastRunAt
                  ? `Lượt dọn gần nhất: ${new Date(retention.settings.lastRunAt).toLocaleString('vi-VN')}`
                  : 'Chưa chạy lượt dọn nào'}
              </span>
            </div>
          </div>

          {/* --- Chạy thủ công --- */}
          <div style={{ background: 'oklch(19% 0.022 250)', border: '1px solid oklch(30% 0.02 250)', borderRadius: '12px', padding: '20px', marginBottom: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: '260px' }}>
                <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '4px' }}>Chạy dọn ngay</div>
                <div style={{ fontSize: '12.5px', color: 'oklch(62% 0.015 250)', lineHeight: 1.6 }}>
                  Job tự chạy hằng ngày lúc 02:00 (giờ Việt Nam). Nút này chạy đúng lượt đó ngay lập tức
                  cho tài khoản của bạn — dùng khi database sắp đầy hoặc để kiểm tra cấu hình.
                </div>
              </div>
              <button
                onClick={handleRunArchive}
                disabled={archiveRunning}
                style={{ padding: '11px 20px', borderRadius: '9px', border: '1px solid oklch(38% 0.03 250)', background: 'oklch(22% 0.025 250)', fontSize: '13px', fontWeight: 600, color: 'oklch(85% 0.01 250)', cursor: 'pointer', opacity: archiveRunning ? 0.6 : 1, whiteSpace: 'nowrap' }}
              >
                {archiveRunning ? 'Đang dọn…' : 'Chạy dọn ngay'}
              </button>
            </div>
            {archiveMsg && (
              <div style={{ fontSize: '13px', color: 'oklch(75% 0.15 150)', lineHeight: 1.6, marginTop: '14px' }}>{archiveMsg}</div>
            )}
            {archiveError && (
              <div style={{ fontSize: '13px', color: 'oklch(80% 0.14 25)', lineHeight: 1.6, marginTop: '14px' }}>{archiveError}</div>
            )}
          </div>

          {/* --- Danh sách gói lưu trữ --- */}
          <div style={{ background: 'oklch(19% 0.022 250)', border: '1px solid oklch(30% 0.02 250)', borderRadius: '12px', padding: '20px' }}>
            <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '4px' }}>Gói đã lưu trữ</div>
            <div style={{ fontSize: '12.5px', color: 'oklch(62% 0.015 250)', marginBottom: '16px' }}>
              Mỗi gói là một file CSV nén gzip, gom theo tháng và theo trạm. Một tháng có thể gồm nhiều gói
              nếu lượng dữ liệu phải chia thành nhiều lượt xử lý.
            </div>

            {retention.loading ? (
              <div style={{ fontSize: '12.5px', color: 'oklch(55% 0.015 250)' }}>Đang tải…</div>
            ) : retention.archives.length === 0 ? (
              <div style={{ fontSize: '12.5px', color: 'oklch(55% 0.015 250)', lineHeight: 1.7 }}>
                Chưa có gói lưu trữ nào — chưa có dữ liệu nào cũ hơn hạn giữ lại.
              </div>
            ) : (
              <div style={{ background: 'oklch(15% 0.02 250)', border: '1px solid oklch(28% 0.02 250)', borderRadius: '9px' }}>
                {retention.archives.map((a, i) => (
                  <div
                    key={a.id}
                    style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 14px', flexWrap: 'wrap', borderBottom: i < retention.archives.length - 1 ? '1px solid oklch(24% 0.02 250)' : 'none' }}
                  >
                    <div style={{ flex: 1, minWidth: '180px' }}>
                      <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '3px' }}>
                        {formatArchiveMonth(a.month)} · {a.stationName || 'Trạm đã xoá'}
                      </div>
                      <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '11.5px', color: 'oklch(55% 0.015 250)' }}>
                        {a.rowCount.toLocaleString('vi-VN')} bản ghi · {formatBytes(a.bytesGzip)} ·{' '}
                        {new Date(a.fromTs).toLocaleDateString('vi-VN')}–{new Date(a.toTs).toLocaleDateString('vi-VN')}
                      </div>
                    </div>
                    <button
                      onClick={() => handleDownloadArchive(a)}
                      style={{ background: 'none', border: 'none', color: ACCENT, cursor: 'pointer', fontSize: '12.5px', fontWeight: 700, padding: 0, fontFamily: "'Manrope',sans-serif", flexShrink: 0 }}
                    >
                      Tải về
                    </button>
                    <button
                      onClick={() => handleDeleteArchive(a)}
                      style={{ background: 'none', border: 'none', color: confirmDeleteArchiveId === a.id ? 'oklch(78% 0.16 25)' : 'oklch(60% 0.02 250)', cursor: 'pointer', fontSize: '12.5px', fontWeight: 700, padding: 0, fontFamily: "'Manrope',sans-serif", flexShrink: 0 }}
                    >
                      {confirmDeleteArchiveId === a.id ? 'Xác nhận xoá vĩnh viễn?' : 'Xoá'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* SIMULATION */}
        <div id="dsec-simulation" style={{ scrollMarginTop: '24px', marginBottom: '40px' }}>
          <h1 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '22px', fontWeight: 700, margin: '0 0 4px' }}>Chế độ mô phỏng dữ liệu<DemoBadge /></h1>
          <p style={{ fontSize: '13px', color: 'oklch(62% 0.015 250)', margin: '0 0 20px' }}>Giả lập dữ liệu cảm biến để phát triển UI khi chưa có phần cứng</p>

          <div style={{ background: 'oklch(19% 0.022 250)', border: '1px solid oklch(30% 0.02 250)', borderRadius: '12px', padding: '20px', marginBottom: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '4px' }}>Bật chế độ mô phỏng</div>
                <div style={{ fontSize: '12.5px', color: 'oklch(62% 0.015 250)', maxWidth: '440px' }}>Khi bật, giao diện người dùng hiển thị dữ liệu giả lập bên dưới thay vì đọc từ cảm biến thật.</div>
              </div>
              <Switch on={simMode} onClick={() => setSimMode((v) => !v)} />
            </div>
          </div>

          <div style={{ background: 'oklch(19% 0.022 250)', border: '1px solid oklch(30% 0.02 250)', borderRadius: '12px', padding: '24px' }}>
            <div style={{ marginBottom: '22px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                <label style={{ fontSize: '13px', fontWeight: 600 }}>Công suất mặt trời</label>
                <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '13px', color: ACCENT }}>{simSolar.toFixed(1)} kW</span>
              </div>
              <input type="range" min="0" max="5" step="0.1" value={simSolar} onChange={(e) => setSimSolar(parseFloat(e.target.value))} style={{ width: '100%', accentColor: ACCENT }} />
            </div>
            <div style={{ marginBottom: '22px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                <label style={{ fontSize: '13px', fontWeight: 600 }}>Pin lưu trữ</label>
                <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '13px', color: ACCENT }}>{Math.round(simBattery)} %</span>
              </div>
              <input type="range" min="0" max="100" step="1" value={simBattery} onChange={(e) => setSimBattery(parseFloat(e.target.value))} style={{ width: '100%', accentColor: ACCENT }} />
            </div>
            <div style={{ marginBottom: '24px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                <label style={{ fontSize: '13px', fontWeight: 600 }}>Tải tiêu thụ</label>
                <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '13px', color: ACCENT }}>{simLoad.toFixed(2)} kW</span>
              </div>
              <input type="range" min="0" max="3" step="0.1" value={simLoad} onChange={(e) => setSimLoad(parseFloat(e.target.value))} style={{ width: '100%', accentColor: ACCENT }} />
            </div>
            <button style={{ padding: '11px 22px', borderRadius: '8px', border: 'none', background: ACCENT, color: 'oklch(12% 0.02 250)', fontSize: '13.5px', fontWeight: 700, cursor: 'pointer' }}>Áp dụng mô phỏng</button>
          </div>
        </div>

        {/* ACCOUNT */}
        <div id="dsec-account" style={{ scrollMarginTop: '24px', marginBottom: '40px' }}>
          <h1 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '22px', fontWeight: 700, margin: '0 0 4px' }}>Tài khoản</h1>
          <p style={{ fontSize: '13px', color: 'oklch(62% 0.015 250)', margin: '0 0 20px' }}>Quản lý phiên đăng nhập của quản trị viên</p>

          <div style={{ background: 'oklch(19% 0.022 250)', border: '1px solid oklch(30% 0.02 250)', borderRadius: '12px', padding: '20px', marginBottom: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
              <Avatar url={avatarUrl} name={displayName} email={user?.email} size={48} background="oklch(28% 0.05 200)" color={ACCENT} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '15px', fontWeight: 700 }}>{displayName}</span>
                  <span style={{ fontSize: '10.5px', fontFamily: "'IBM Plex Mono',monospace", fontWeight: 700, letterSpacing: '0.06em', color: 'oklch(75% 0.14 70)', background: 'oklch(28% 0.05 70)', padding: '2px 7px', borderRadius: '5px' }}>ADMIN</span>
                </div>
                <div style={{ fontSize: '12.5px', color: 'oklch(62% 0.015 250)', marginTop: '3px', overflow: 'hidden', textOverflow: 'ellipsis' }}>{user?.email}</div>
                <div style={{ fontSize: '11.5px', color: 'oklch(55% 0.015 250)', marginTop: '2px' }}>Đăng nhập qua {authProvider === 'google' ? 'Google' : 'Email / Mật khẩu'}</div>
              </div>
            </div>
          </div>

          <div style={{ background: 'oklch(19% 0.022 250)', border: '1px solid oklch(30% 0.02 250)', borderRadius: '12px', padding: '20px' }}>
            <h2 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '15px', fontWeight: 700, margin: '0 0 6px' }}>Phiên đăng nhập</h2>
            <p style={{ fontSize: '12.5px', color: 'oklch(62% 0.015 250)', margin: '0 0 16px' }}>Đăng xuất khỏi phiên hiện tại hoặc chuyển sang tài khoản khác.</p>
            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
              <button onClick={handleSignOut} disabled={signingOut} style={{ padding: '11px 20px', borderRadius: '8px', border: 'none', background: 'oklch(45% 0.16 25)', color: 'white', fontSize: '13.5px', fontWeight: 700, cursor: 'pointer', opacity: signingOut ? 0.7 : 1 }}>{signingOut ? 'Đang đăng xuất…' : 'Đăng xuất'}</button>
              <button onClick={handleSignOut} disabled={signingOut} style={{ padding: '11px 20px', borderRadius: '8px', border: '1px solid oklch(38% 0.03 250)', background: 'oklch(22% 0.025 250)', fontSize: '13.5px', fontWeight: 600, color: 'oklch(85% 0.01 250)', cursor: 'pointer', opacity: signingOut ? 0.7 : 1 }}>Chuyển đổi tài khoản</button>
            </div>
          </div>
        </div>
    </DevShell>
    <DeviceInfoModal
      key={selectedDevice?.id}
      device={selectedDevice}
      station={currentStation}
      dependentLoadsCount={selectedDevice ? stationLoads.filter((l) => l.deviceId === selectedDevice.id).length : 0}
      onProvision={provisionDevice}
      onListCertificates={listDeviceCertificates}
      onDelete={removeDevice}
      onClose={() => setSelectedDevice(null)}
    />
    </>
  );
}
