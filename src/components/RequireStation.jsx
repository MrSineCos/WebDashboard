import { useState } from 'react';
import { useStations } from '../lib/stations.js';

const pageStyle = {
  minHeight: '100vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: "'Manrope',sans-serif",
  background: 'oklch(97% 0.005 240)',
  padding: '24px',
};

const cardStyle = {
  maxWidth: '440px',
  width: '100%',
  textAlign: 'left',
  background: 'white',
  border: '1px solid oklch(91% 0.01 240)',
  borderRadius: '16px',
  padding: '32px',
  boxShadow: '0 1px 2px oklch(0% 0 0 / 0.04)',
};

const inputStyle = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '11px 13px',
  borderRadius: '9px',
  border: '1px solid oklch(88% 0.01 240)',
  fontSize: '14px',
  fontFamily: "'Manrope',sans-serif",
};

const labelStyle = { display: 'block', fontSize: '13px', fontWeight: 600, color: 'oklch(32% 0.03 240)', marginBottom: '7px' };

function CreateFirstStation({ createStation }) {
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    if (!name.trim() || !location.trim()) return;
    setSaving(true);
    setError('');
    const { error: err } = await createStation({ name: name.trim(), location: location.trim() });
    if (err) {
      setError('Không thể tạo trạm, vui lòng thử lại.');
      setSaving(false);
      return;
    }
    window.location.reload();
  }

  return (
    <div style={pageStyle}>
      <div style={cardStyle}>
        <h1 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '19px', fontWeight: 700, margin: '0 0 8px', color: 'oklch(24% 0.04 240)' }}>Tạo trạm đầu tiên</h1>
        <p style={{ fontSize: '13.5px', color: 'oklch(52% 0.02 240)', margin: '0 0 22px', lineHeight: 1.6 }}>
          Bạn chưa có trạm nào. Tạo một trạm để bắt đầu sử dụng SolGrid — bạn có thể thêm/xóa trạm sau này trong Cài đặt.
        </p>
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: '16px' }}>
            <label style={labelStyle}>Tên trạm</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Trạm 01" style={inputStyle} autoFocus />
          </div>
          <div style={{ marginBottom: '20px' }}>
            <label style={labelStyle}>Địa điểm</label>
            <input type="text" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Cà Mau" style={inputStyle} />
          </div>
          {error && <div style={{ fontSize: '12.5px', color: 'oklch(52% 0.17 25)', marginBottom: '14px' }}>{error}</div>}
          <button
            type="submit"
            disabled={saving || !name.trim() || !location.trim()}
            style={{ width: '100%', padding: '12px 20px', borderRadius: '9px', border: 'none', background: 'oklch(54% 0.15 240)', color: 'white', fontSize: '14px', fontWeight: 700, cursor: 'pointer', fontFamily: "'Manrope',sans-serif", opacity: saving || !name.trim() || !location.trim() ? 0.6 : 1 }}
          >
            {saving ? 'Đang tạo…' : 'Tạo trạm'}
          </button>
        </form>
      </div>
    </div>
  );
}

// Gate cho các trang cần ít nhất 1 trạm (Dashboard/Battery/Reports/DevConsole
// đều gọi station.name/.status không có null-guard). User đăng ký từ sau
// migration 0007 bắt đầu với 0 trạm — hiện onboarding thay vì để các trang
// đó treo vĩnh viễn ở "Đang tải…" (điều kiện !station không bao giờ hết true).
export default function RequireStation({ children }) {
  const { stations, createStation, loading } = useStations();

  if (loading) return null;
  if (stations.length === 0) return <CreateFirstStation createStation={createStation} />;
  return children;
}
