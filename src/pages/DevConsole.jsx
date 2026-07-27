import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useStations } from '../lib/stations.js';
import { useDevices } from '../lib/telemetry.js';
import { useUserSettings } from '../lib/userSettings.js';
import { useLoads } from '../lib/loads.js';
import { useAuth } from '../lib/AuthContext.jsx';
import { useIsMobile } from '../lib/useIsMobile.js';
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

const FIRMWARE_DEVICES = [
  { name: 'ESP32-01 · Bộ điều khiển nguồn', version: 'v2.3.1', updated: '28/06/2026', status: 'online' },
  { name: 'ESP32-02 · Node cảm biến tải', version: 'v2.2.4', updated: '12/05/2026', status: 'offline' },
];

const FIRMWARE_HISTORY = [
  { version: 'v2.3.1', date: '28/06/2026', notes: 'Sửa lỗi đọc cảm biến dòng điện khi tải cao', current: true },
  { version: 'v2.3.0', date: '02/06/2026', notes: 'Thêm hỗ trợ MQTT reconnect tự động', current: false },
  { version: 'v2.2.4', date: '12/05/2026', notes: 'Tối ưu vòng lặp đọc ADC, giảm nhiễu', current: false },
  { version: 'v2.2.0', date: '20/04/2026', notes: 'Bản phát hành đầu tiên cho mô hình thử nghiệm', current: false },
];

const SENSORS = [
  { name: 'Cảm biến điện áp pin', raw: '612 ADC', scale: '0.0812', offset: '-0.4', calibrated: '48.3 V' },
  { name: 'Cảm biến dòng điện tải', raw: '298 ADC', scale: '0.0431', offset: '0.0', calibrated: '12.8 A' },
  { name: 'Cảm biến công suất mặt trời', raw: '—', scale: '1.000', offset: '0.0', calibrated: '2.4 kW' },
  { name: 'Cảm biến nhiệt độ pin', raw: '822 ADC', scale: '0.0512', offset: '-2.1', calibrated: '31°C' },
];

const LOGS = [
  { level: 'info', time: '15:42:03', msg: 'Đã nhận dữ liệu từ ESP32-01: V=48.3V, I=12.8A' },
  { level: 'warn', time: '14:32:11', msg: 'Điện áp pin giảm dưới ngưỡng 46V' },
  { level: 'error', time: '10:15:47', msg: 'Mất kết nối MQTT với ESP32-02, đang thử kết nối lại' },
  { level: 'info', time: '09:58:20', msg: 'Khởi động lại hệ thống hoàn tất' },
  { level: 'info', time: '09:58:02', msg: 'ESP32-01 kết nối WiFi thành công' },
  { level: 'warn', time: 'Hôm qua 22:14', msg: 'Nhiệt độ MCU đạt 44°C, gần ngưỡng cảnh báo' },
  { level: 'error', time: 'Hôm qua 18:03', msg: 'Firmware update thất bại trên ESP32-02, đã rollback' },
  { level: 'info', time: 'Hôm qua 08:00', msg: 'Cập nhật firmware v2.3.1 thành công trên ESP32-01' },
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

const DIAG_BY_STATUS = {
  online: { uptime: '14n 6h 32p', heapUsed: 142, rssi: '-58', rssiLabel: 'Tốt', rssiColor: 'oklch(70% 0.15 150)', temp: '42°C', reboots: '3', mqtt: 'Connected', mqttColor: 'oklch(70% 0.15 150)' },
  warning: { uptime: '2n 4h 10p', heapUsed: 88, rssi: '-74', rssiLabel: 'Yếu', rssiColor: 'oklch(75% 0.14 70)', temp: '51°C', reboots: '7', mqtt: 'Connected', mqttColor: 'oklch(70% 0.15 150)' },
  offline: { uptime: '—', heapUsed: 0, rssi: '—', rssiLabel: 'Không có tín hiệu', rssiColor: 'oklch(62% 0.19 25)', temp: '—', reboots: '—', mqtt: 'Disconnected', mqttColor: 'oklch(62% 0.19 25)' },
};

const STATUS_COLOR = { online: 'oklch(70% 0.15 150)', offline: 'oklch(62% 0.19 25)' };

const LEVEL_META = {
  info: { label: 'INFO', color: 'oklch(75% 0.13 200)' },
  warn: { label: 'WARN', color: 'oklch(78% 0.14 70)' },
  error: { label: 'ERROR', color: 'oklch(70% 0.18 25)' },
};

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
  const [autoUpdate, setAutoUpdate] = useState(true);
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

  const { stations, station: currentStation, selectStation, loading: stationsLoading } = useStations();
  const { devices, removeDevice, provisionDevice, listDeviceCertificates } = useDevices();
  const { loads: stationLoads } = useLoads(currentStation?.id);
  const settings = useUserSettings(currentStation?.id);
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
  const avatarUrl = authProvider === 'google' ? (user?.user_metadata?.avatar_url ?? user?.user_metadata?.picture ?? null) : null;
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

  if (!everLoaded && (stationsLoading || !currentStation || settings.loading)) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'oklch(15% 0.02 250)', color: 'oklch(70% 0.015 250)', fontFamily: "'Manrope',sans-serif" }}>
        Đang tải…
      </div>
    );
  }

  const stationOffline = currentStation.status === 'offline';
  const diag = DIAG_BY_STATUS[currentStation.status];
  const stationDevices = devices.filter((d) => d.station_id === currentStation.id);
  const editing = batteryModes[editingMode];

  const filteredLogs = LOGS.filter((l) => logFilter === 'all' || l.level === logFilter);

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
          <h1 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '22px', fontWeight: 700, margin: '0 0 4px' }}>Tổng quan thiết bị</h1>
          <p style={{ fontSize: '13px', color: 'oklch(62% 0.015 250)', margin: '0 0 20px' }}>Chỉ số chẩn đoán phần cứng thời gian thực</p>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px,1fr))', gap: '14px', marginBottom: '16px' }}>
            <div style={{ background: 'oklch(19% 0.022 250)', border: '1px solid oklch(30% 0.02 250)', borderRadius: '12px', padding: '16px' }}>
              <div style={{ fontSize: '11.5px', color: 'oklch(62% 0.015 250)', marginBottom: '8px' }}>Thời gian hoạt động</div>
              <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '19px', fontWeight: 600 }}>{diag.uptime}</div>
            </div>
            <div style={{ background: 'oklch(19% 0.022 250)', border: '1px solid oklch(30% 0.02 250)', borderRadius: '12px', padding: '16px' }}>
              <div style={{ fontSize: '11.5px', color: 'oklch(62% 0.015 250)', marginBottom: '8px' }}>Bộ nhớ heap trống</div>
              <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '19px', fontWeight: 600 }}>{diag.heapUsed} <span style={{ fontSize: '12px', color: 'oklch(62% 0.015 250)' }}>/ 320 KB</span></div>
              <div style={{ height: '4px', background: 'oklch(28% 0.02 250)', borderRadius: '2px', marginTop: '8px' }}>
                <div style={{ width: Math.round((diag.heapUsed / 320) * 100) + '%', height: '100%', background: ACCENT, borderRadius: '2px' }} />
              </div>
            </div>
            <div style={{ background: 'oklch(19% 0.022 250)', border: '1px solid oklch(30% 0.02 250)', borderRadius: '12px', padding: '16px' }}>
              <div style={{ fontSize: '11.5px', color: 'oklch(62% 0.015 250)', marginBottom: '8px' }}>Tín hiệu WiFi (RSSI)</div>
              <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '19px', fontWeight: 600 }}>{diag.rssi} <span style={{ fontSize: '12px', color: 'oklch(62% 0.015 250)' }}>dBm</span></div>
              <div style={{ fontSize: '11.5px', color: diag.rssiColor, marginTop: '8px', fontWeight: 600 }}>{diag.rssiLabel}</div>
            </div>
            <div style={{ background: 'oklch(19% 0.022 250)', border: '1px solid oklch(30% 0.02 250)', borderRadius: '12px', padding: '16px' }}>
              <div style={{ fontSize: '11.5px', color: 'oklch(62% 0.015 250)', marginBottom: '8px' }}>Nhiệt độ MCU</div>
              <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '19px', fontWeight: 600 }}>{diag.temp}</div>
            </div>
            <div style={{ background: 'oklch(19% 0.022 250)', border: '1px solid oklch(30% 0.02 250)', borderRadius: '12px', padding: '16px' }}>
              <div style={{ fontSize: '11.5px', color: 'oklch(62% 0.015 250)', marginBottom: '8px' }}>Số lần khởi động lại</div>
              <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '19px', fontWeight: 600 }}>{diag.reboots}</div>
            </div>
            <div style={{ background: 'oklch(19% 0.022 250)', border: '1px solid oklch(30% 0.02 250)', borderRadius: '12px', padding: '16px' }}>
              <div style={{ fontSize: '11.5px', color: 'oklch(62% 0.015 250)', marginBottom: '8px' }}>Kết nối MQTT Broker</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '2px' }}>
                <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: diag.mqttColor, display: 'inline-block' }} />
                <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '15px', fontWeight: 700, color: diag.mqttColor }}>{diag.mqtt}</span>
              </div>
            </div>
          </div>

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
          <h1 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '22px', fontWeight: 700, margin: '0 0 4px' }}>Quản lý Firmware MCU<DemoBadge /></h1>
          <p style={{ fontSize: '13px', color: 'oklch(62% 0.015 250)', margin: '0 0 20px' }}>Theo dõi phiên bản, đẩy bản cập nhật OTA và rollback khi cần</p>

          <div style={{ background: 'oklch(19% 0.022 250)', border: '1px solid oklch(30% 0.02 250)', borderRadius: '12px', padding: '20px', marginBottom: '16px' }}>
            <h2 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '15px', fontWeight: 700, margin: '0 0 14px' }}>Thiết bị</h2>
            {FIRMWARE_DEVICES.map((d) => {
              const status = stationOffline ? 'offline' : d.status;
              return (
                <div key={d.name} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 2px', borderBottom: '1px solid oklch(26% 0.02 250)', flexWrap: 'wrap', gap: '8px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span style={{ width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0, background: STATUS_COLOR[status] }} />
                    <div>
                      <div style={{ fontSize: '13.5px', fontWeight: 600 }}>{d.name}</div>
                      <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '11.5px', color: 'oklch(62% 0.015 250)', marginTop: '2px' }}>{d.version} · cập nhật {d.updated}</div>
                    </div>
                  </div>
                  <button style={{ padding: '7px 14px', borderRadius: '8px', border: '1px solid oklch(38% 0.03 250)', background: 'oklch(22% 0.025 250)', fontSize: '12px', fontWeight: 600, color: 'oklch(85% 0.01 250)', cursor: 'pointer', fontFamily: "'IBM Plex Mono',monospace" }}>Cập nhật</button>
                </div>
              );
            })}
          </div>

          <div style={{ background: 'oklch(19% 0.022 250)', border: '1px solid oklch(30% 0.02 250)', borderRadius: '12px', padding: '20px', marginBottom: '16px' }}>
            <h2 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '15px', fontWeight: 700, margin: '0 0 4px' }}>Đẩy bản firmware mới</h2>
            <p style={{ fontSize: '12.5px', color: 'oklch(62% 0.015 250)', margin: '0 0 14px' }}>Định dạng .bin, biên dịch từ PlatformIO/Arduino IDE</p>
            <div style={{ border: '1.5px dashed oklch(38% 0.03 250)', borderRadius: '10px', padding: '28px', textAlign: 'center', marginBottom: '16px' }}>
              <div style={{ fontSize: '13px', color: 'oklch(70% 0.02 250)', marginBottom: '10px' }}>Kéo thả file .bin vào đây</div>
              <button style={{ padding: '9px 18px', borderRadius: '8px', border: '1px solid oklch(38% 0.03 250)', background: 'oklch(22% 0.025 250)', fontSize: '13px', fontWeight: 600, color: 'oklch(85% 0.01 250)', cursor: 'pointer' }}>Chọn file</button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
                <Switch on={autoUpdate} onClick={() => setAutoUpdate((v) => !v)} />
                <span style={{ fontSize: '13px' }}>Tự động cập nhật OTA khi có bản mới</span>
              </label>
              <button style={{ padding: '10px 18px', borderRadius: '8px', border: 'none', background: ACCENT, color: 'oklch(12% 0.02 250)', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }}>Đẩy OTA đến tất cả thiết bị</button>
            </div>
          </div>

          <div style={{ background: 'oklch(19% 0.022 250)', border: '1px solid oklch(30% 0.02 250)', borderRadius: '12px', padding: '20px' }}>
            <h2 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '15px', fontWeight: 700, margin: '0 0 14px' }}>Lịch sử phiên bản</h2>
            {FIRMWARE_HISTORY.map((f) => (
              <div key={f.version} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 2px', borderBottom: '1px solid oklch(26% 0.02 250)', gap: '10px', flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
                  <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '13px', fontWeight: 600, color: ACCENT, flexShrink: 0 }}>{f.version}</span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: '13px' }}>{f.notes}</div>
                    <div style={{ fontSize: '11.5px', color: 'oklch(62% 0.015 250)', marginTop: '2px' }}>{f.date}</div>
                  </div>
                </div>
                <span style={{ fontSize: '11.5px', fontWeight: 700, padding: '6px 12px', borderRadius: '7px', flexShrink: 0, color: f.current ? 'oklch(70% 0.15 150)' : 'oklch(85% 0.01 250)', background: f.current ? 'oklch(28% 0.05 150)' : 'oklch(28% 0.02 250)', border: f.current ? 'none' : '1px solid oklch(38% 0.03 250)', cursor: f.current ? 'default' : 'pointer' }}>{f.current ? 'Đang dùng' : 'Rollback'}</span>
              </div>
            ))}
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
          <h1 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '22px', fontWeight: 700, margin: '0 0 4px' }}>Nhật ký hệ thống<DemoBadge /></h1>
          <p style={{ fontSize: '13px', color: 'oklch(62% 0.015 250)', margin: '0 0 16px' }}>Log thời gian thực từ thiết bị và server</p>

          <div style={{ display: 'flex', gap: '8px', marginBottom: '14px', flexWrap: 'wrap' }}>
            <button style={chipStyle(logFilter === 'all')} onClick={() => setLogFilter('all')}>Tất cả</button>
            <button style={chipStyle(logFilter === 'info')} onClick={() => setLogFilter('info')}>Info</button>
            <button style={chipStyle(logFilter === 'warn')} onClick={() => setLogFilter('warn')}>Warning</button>
            <button style={chipStyle(logFilter === 'error')} onClick={() => setLogFilter('error')}>Error</button>
          </div>

          <div style={{ background: 'oklch(9% 0.015 250)', border: '1px solid oklch(30% 0.02 250)', borderRadius: '12px', padding: '16px 18px', fontFamily: "'IBM Plex Mono',monospace", fontSize: '12.5px', maxHeight: '420px', overflowY: 'auto' }}>
            {filteredLogs.map((item, i) => {
              const meta = LEVEL_META[item.level];
              return (
                <div key={i} style={{ display: 'flex', gap: '10px', padding: '7px 0', borderBottom: '1px solid oklch(22% 0.015 250)' }}>
                  <span style={{ color: 'oklch(52% 0.015 250)', flexShrink: 0 }}>{item.time}</span>
                  <span style={{ color: meta.color, fontWeight: 600, flexShrink: 0, width: '54px' }}>{meta.label}</span>
                  <span style={{ color: 'oklch(85% 0.01 250)' }}>{item.msg}</span>
                </div>
              );
            })}
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
              {avatarUrl ? (
                <img src={avatarUrl} alt="Ảnh đại diện" style={{ width: '48px', height: '48px', borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
              ) : (
                <div style={{ width: '48px', height: '48px', borderRadius: '50%', background: 'oklch(28% 0.05 200)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '17px', fontWeight: 700, color: ACCENT, flexShrink: 0 }}>
                  {(displayName[0] || 'A').toUpperCase()}
                </div>
              )}
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
