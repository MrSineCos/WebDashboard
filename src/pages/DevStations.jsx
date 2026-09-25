import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import DevShell from '../components/DevShell.jsx';
import { useIsMobile } from '../lib/useIsMobile.js';
import { DEV_STATION_STATUS_META, useStations } from '../lib/stations.js';
import { useDevices } from '../lib/telemetry.js';
import { useAuth } from '../lib/AuthContext.jsx';

const ACCENT = 'oklch(75% 0.13 200)';
const DEVICE_TYPE_LABEL = { esp32: 'Bộ điều khiển ESP32', inverter: 'Inverter', bms: 'BMS Pin lưu trữ', sensor: 'Cảm biến' };

const darkInputStyle = { width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: '8px', border: '1px solid oklch(34% 0.02 250)', background: 'oklch(15% 0.02 250)', color: 'white', fontSize: '13px', fontFamily: "'Manrope',sans-serif" };
const darkLabelStyle = { display: 'block', fontSize: '12px', fontWeight: 600, color: 'oklch(70% 0.02 250)', marginBottom: '7px' };

// Một trạm trong "Quản lý trạm": UUID để copy dùng khi cần đăng ký thủ công
// (docs/IOT.md), danh sách thiết bị đã gắn, form đăng ký thiết bị mới (gọi
// RPC register_device — devices không cho INSERT trực tiếp từ client), và
// nút xóa trạm (xác nhận 2 bước, điều khiển bởi state ở component cha vì chỉ
// 1 trạm được xác nhận xóa cùng lúc).
function StationRow({ station, devices, registerDevice, confirming, onDeleteClick, onBlurDelete }) {
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState('esp32');
  const [awsThingName, setAwsThingName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const stationDevices = devices.filter((d) => d.station_id === station.id);
  const m = DEV_STATION_STATUS_META[station.status];

  function copyId() {
    navigator.clipboard?.writeText(station.id);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!name.trim() || !awsThingName.trim()) return;
    setSaving(true);
    setError('');
    const { error: err } = await registerDevice({ stationId: station.id, name: name.trim(), type, awsThingName: awsThingName.trim() });
    setSaving(false);
    if (err) {
      const msg = err.message || '';
      setError(msg.includes('duplicate') || msg.includes('unique') ? 'aws_thing_name này đã được dùng cho thiết bị khác.' : 'Không thể đăng ký thiết bị, vui lòng thử lại.');
      return;
    }
    setName('');
    setAwsThingName('');
    setFormOpen(false);
  }

  return (
    <div style={{ padding: '14px 2px', borderBottom: '1px solid oklch(26% 0.02 250)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
          <span style={{ width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0, background: m.color }} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: '13.5px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{station.name} · {station.location}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontFamily: "'IBM Plex Mono',monospace", fontSize: '11px', color: 'oklch(62% 0.015 250)' }}>
              <span>{station.id}</span>
              <button type="button" onClick={copyId} style={{ background: 'none', border: 'none', color: ACCENT, cursor: 'pointer', padding: 0, fontSize: '11px', fontFamily: "'IBM Plex Mono',monospace" }}>{copied ? 'Đã copy' : 'Copy'}</button>
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
          <button
            type="button"
            onClick={() => setFormOpen((v) => !v)}
            style={{ padding: '7px 14px', borderRadius: '8px', border: '1px solid oklch(38% 0.03 250)', background: 'oklch(22% 0.025 250)', fontSize: '12px', fontWeight: 600, color: 'oklch(85% 0.01 250)', cursor: 'pointer', whiteSpace: 'nowrap' }}
          >
            {formOpen ? 'Đóng' : '+ Thêm thiết bị'}
          </button>
          <button
            onClick={() => onDeleteClick(station.id)}
            onBlur={() => onBlurDelete(station.id)}
            style={{ padding: '7px 14px', borderRadius: '8px', border: confirming ? '1px solid oklch(70% 0.16 25)' : '1px solid oklch(38% 0.03 250)', background: confirming ? 'oklch(28% 0.06 25)' : 'oklch(22% 0.025 250)', fontSize: '12px', fontWeight: 600, color: confirming ? 'oklch(80% 0.14 25)' : 'oklch(85% 0.01 250)', cursor: 'pointer', whiteSpace: 'nowrap' }}
          >
            {confirming ? 'Xác nhận xóa?' : 'Xóa'}
          </button>
        </div>
      </div>

      {confirming && (
        <div style={{ fontSize: '11.5px', color: 'oklch(80% 0.14 25)', marginTop: '8px' }}>
          {stationDevices.length > 0
            ? `Trạm này có ${stationDevices.length} thiết bị — toàn bộ lịch sử dữ liệu sẽ bị xóa vĩnh viễn.`
            : 'Bấm "Xác nhận xóa?" lần nữa để xóa trạm này.'}
        </div>
      )}

      {stationDevices.length > 0 && (
        <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {stationDevices.map((d) => (
            <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'oklch(80% 0.01 250)' }}>
              <span style={{ width: '6px', height: '6px', borderRadius: '50%', flexShrink: 0, background: d.status === 'connected' ? 'oklch(70% 0.15 150)' : 'oklch(62% 0.19 25)' }} />
              <span>{d.name}</span>
              <span style={{ color: 'oklch(62% 0.015 250)' }}>{DEVICE_TYPE_LABEL[d.type] ?? d.type}</span>
              <span style={{ fontFamily: "'IBM Plex Mono',monospace", color: 'oklch(62% 0.015 250)' }}>{d.aws_thing_name}</span>
            </div>
          ))}
        </div>
      )}

      {formOpen && (
        <form onSubmit={handleSubmit} style={{ marginTop: '12px', display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'end', background: 'oklch(15% 0.02 250)', borderRadius: '8px', padding: '12px' }}>
          <div style={{ flex: '1 1 140px' }}>
            <label style={darkLabelStyle}>Tên thiết bị</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="ESP32 Trạm 01" style={darkInputStyle} />
          </div>
          <div style={{ flex: '1 1 130px' }}>
            <label style={darkLabelStyle}>Loại thiết bị</label>
            <select value={type} onChange={(e) => setType(e.target.value)} style={darkInputStyle}>
              <option value="esp32">ESP32</option>
              <option value="inverter">Inverter</option>
              <option value="bms">BMS</option>
              <option value="sensor">Cảm biến</option>
            </select>
          </div>
          <div style={{ flex: '1 1 180px' }}>
            <label style={darkLabelStyle}>AWS thing name / MQTT client id</label>
            <input type="text" value={awsThingName} onChange={(e) => setAwsThingName(e.target.value)} placeholder="solgrid-esp32-01" style={darkInputStyle} />
          </div>
          <button type="submit" disabled={saving || !name.trim() || !awsThingName.trim()} style={{ padding: '10px 18px', borderRadius: '8px', border: 'none', background: ACCENT, color: 'oklch(12% 0.02 250)', fontSize: '13px', fontWeight: 700, cursor: 'pointer', opacity: saving || !name.trim() || !awsThingName.trim() ? 0.6 : 1, whiteSpace: 'nowrap' }}>
            {saving ? 'Đang đăng ký…' : 'Đăng ký thiết bị'}
          </button>
        </form>
      )}
      {error && <div style={{ fontSize: '12px', color: 'oklch(80% 0.14 25)', marginTop: '8px' }}>{error}</div>}
    </div>
  );
}

export default function DevStations() {
  const isMobile = useIsMobile(900);
  const [stationMenuOpen, setStationMenuOpen] = useState(false);
  const { stations, station: currentStation, selectStation, createStation, deleteStation, loading: stationsLoading } = useStations();
  const { devices, registerDevice } = useDevices();
  const { user } = useAuth();
  const routerNavigate = useNavigate();

  const [newStationName, setNewStationName] = useState('');
  const [newStationLocation, setNewStationLocation] = useState('');
  const [stationFormSaving, setStationFormSaving] = useState(false);
  const [stationFormError, setStationFormError] = useState('');
  const [confirmDeleteStationId, setConfirmDeleteStationId] = useState(null);

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

  // Các mục điều hướng thuộc trang /dev (Tổng quan, Firmware...) — bấm từ
  // đây sẽ quay về /dev kèm mục cần cuộn tới (DevConsole.jsx tự đọc và cuộn
  // khi mount).
  function goToDevSection(id) {
    routerNavigate('/dev', { state: { scrollTo: id } });
  }

  if (stationsLoading || !currentStation) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'oklch(15% 0.02 250)', color: 'oklch(70% 0.015 250)', fontFamily: "'Manrope',sans-serif" }}>
        Đang tải…
      </div>
    );
  }

  return (
    <DevShell
      activeNav={null}
      onNavigate={goToDevSection}
      isMobile={isMobile}
      stations={stations}
      currentStation={currentStation}
      onSelectStation={selectStation}
      stationMenuOpen={stationMenuOpen}
      onToggleStationMenu={() => setStationMenuOpen((v) => !v)}
      onCloseStationMenu={() => setStationMenuOpen(false)}
    >
      <h1 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '26px', fontWeight: 700, margin: '0 0 4px' }}>Quản lý trạm</h1>
      <p style={{ fontSize: '13px', color: 'oklch(62% 0.015 250)', margin: '0 0 8px' }}>Thêm/xóa trạm, đăng ký thiết bị ESP32 gắn vào từng trạm để chúng kết nối đúng nơi</p>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontFamily: "'IBM Plex Mono',monospace", fontSize: '11.5px', color: 'oklch(62% 0.015 250)', marginBottom: '20px' }}>
        <span>Owner UUID (dùng khi đăng ký thủ công theo docs/IOT.md): {user.id}</span>
        <button type="button" onClick={() => navigator.clipboard?.writeText(user.id)} style={{ background: 'none', border: 'none', color: ACCENT, cursor: 'pointer', padding: 0, fontSize: '11.5px', fontFamily: "'IBM Plex Mono',monospace" }}>Copy</button>
      </div>

      <div style={{ background: 'oklch(19% 0.022 250)', border: '1px solid oklch(30% 0.02 250)', borderRadius: '12px', padding: '20px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '18px' }}>
          {stations.map((s) => (
            <StationRow
              key={s.id}
              station={s}
              devices={devices}
              registerDevice={registerDevice}
              confirming={confirmDeleteStationId === s.id}
              onDeleteClick={handleDeleteStation}
              onBlurDelete={(id) => setConfirmDeleteStationId((cur) => (cur === id ? null : cur))}
            />
          ))}
        </div>
        <form onSubmit={handleCreateStation} style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'end' }}>
          <div style={{ flex: '1 1 160px' }}>
            <label style={darkLabelStyle}>Tên trạm mới</label>
            <input type="text" value={newStationName} onChange={(e) => setNewStationName(e.target.value)} placeholder="Trạm 05" style={darkInputStyle} />
          </div>
          <div style={{ flex: '1 1 160px' }}>
            <label style={darkLabelStyle}>Địa điểm</label>
            <input type="text" value={newStationLocation} onChange={(e) => setNewStationLocation(e.target.value)} placeholder="Cần Thơ" style={darkInputStyle} />
          </div>
          <button type="submit" disabled={stationFormSaving || !newStationName.trim() || !newStationLocation.trim()} style={{ padding: '10px 18px', borderRadius: '8px', border: 'none', background: ACCENT, color: 'oklch(12% 0.02 250)', fontSize: '13px', fontWeight: 700, cursor: 'pointer', opacity: stationFormSaving || !newStationName.trim() || !newStationLocation.trim() ? 0.6 : 1, whiteSpace: 'nowrap' }}>
            {stationFormSaving ? 'Đang thêm…' : '+ Thêm trạm'}
          </button>
        </form>
        {stationFormError && <div style={{ fontSize: '12px', color: 'oklch(80% 0.14 25)', marginTop: '10px' }}>{stationFormError}</div>}
      </div>
    </DevShell>
  );
}
