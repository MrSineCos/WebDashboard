import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { DEV_STATION_STATUS_META } from '../lib/stations.js';

const ACCENT = 'oklch(75% 0.13 200)';

// Bản dark-theme tương đương AppShell.jsx (dùng cho Dashboard/Battery/Reports)
// — sidebar/topbar/drawer dùng chung cho các trang trong khu vực DevConsole
// (/dev, /dev/stations). Bảng màu trạng thái trạm nằm ở lib/stations.js cạnh
// bản nền sáng, không xuất từ file này: file component chỉ export component
// thì Vite mới hot-swap được nó khi sửa, thay vì tải lại cả trang.

const NAV_ITEMS = [
  {
    id: 'overview',
    label: 'Tổng quan thiết bị',
    icon: (
      <svg width="17" height="17" viewBox="0 0 20 20"><path d="M2 10h3l2-5 3 10 2-5h6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
    ),
  },
  {
    id: 'firmware',
    label: 'Firmware MCU',
    icon: (
      <svg width="17" height="17" viewBox="0 0 20 20">
        <rect x="6" y="6" width="8" height="8" rx="1" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <g stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
          <line x1="8" y1="2" x2="8" y2="6" /><line x1="12" y1="2" x2="12" y2="6" />
          <line x1="8" y1="14" x2="8" y2="18" /><line x1="12" y1="14" x2="12" y2="18" />
          <line x1="2" y1="8" x2="6" y2="8" /><line x1="2" y1="12" x2="6" y2="12" />
          <line x1="14" y1="8" x2="18" y2="8" /><line x1="14" y1="12" x2="18" y2="12" />
        </g>
      </svg>
    ),
  },
  {
    id: 'modules',
    label: 'Hiển thị module',
    icon: (
      <svg width="17" height="17" viewBox="0 0 20 20">
        <rect x="3" y="4" width="14" height="4" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <rect x="3" y="12" width="14" height="4" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="14" cy="6" r="1.3" fill="currentColor" />
        <circle cx="6" cy="14" r="1.3" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: 'battery',
    label: 'Ngưỡng pin',
    icon: (
      <svg width="17" height="17" viewBox="0 0 20 20"><rect x="2" y="6" width="14" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.6" /><rect x="17" y="8.5" width="2" height="3" fill="currentColor" /><rect x="4" y="8" width="7" height="4" fill="currentColor" /></svg>
    ),
  },
  {
    id: 'calibration',
    label: 'Hiệu chỉnh cảm biến',
    icon: (
      <svg width="17" height="17" viewBox="0 0 20 20">
        <g stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><line x1="4" y1="3" x2="4" y2="17" /><line x1="10" y1="3" x2="10" y2="17" /><line x1="16" y1="3" x2="16" y2="17" /></g>
        <circle cx="4" cy="7" r="1.8" fill="currentColor" /><circle cx="10" cy="13" r="1.8" fill="currentColor" /><circle cx="16" cy="9" r="1.8" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: 'network',
    label: 'Cấu hình mạng',
    icon: (
      <svg width="17" height="17" viewBox="0 0 20 20">
        <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M3 8c3.9-3.9 10.1-3.9 14 0" /><path d="M6 11.2c2.2-2.2 5.8-2.2 8 0" /></g>
        <circle cx="10" cy="15" r="1.4" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: 'logs',
    label: 'Nhật ký hệ thống',
    icon: (
      <svg width="17" height="17" viewBox="0 0 20 20">
        <rect x="2.5" y="3" width="15" height="14" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M5.5 7.5l3 2.5-3 2.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        <line x1="10.5" y1="12.5" x2="14.5" y2="12.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'retention',
    label: 'Lưu trữ & dọn dữ liệu',
    icon: (
      <svg width="17" height="17" viewBox="0 0 20 20">
        <ellipse cx="10" cy="5" rx="6.5" ry="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M3.5 5v5c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5V5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M3.5 10v5c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5v-5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    ),
  },
  {
    id: 'simulation',
    label: 'Chế độ mô phỏng',
    icon: (
      <svg width="17" height="17" viewBox="0 0 20 20">
        <path d="M8 2.5h4M8.5 2.5v4.8L4.8 14a1.8 1.8 0 001.6 2.7h7.2a1.8 1.8 0 001.6-2.7L11.5 7.3V2.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <line x1="6.5" y1="12" x2="13.5" y2="12" stroke="currentColor" strokeWidth="1.3" />
      </svg>
    ),
  },
  {
    id: 'account',
    label: 'Tài khoản',
    icon: (
      <svg width="17" height="17" viewBox="0 0 20 20">
        <circle cx="10" cy="6.5" r="3.3" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M3.5 17c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    ),
  },
];

const STATIONS_LINK = {
  label: 'Quản lý trạm',
  icon: (
    <svg width="17" height="17" viewBox="0 0 20 20">
      <path d="M10 2l7 3.5v4c0 4.2-2.9 7.2-7 8-4.1-.8-7-3.8-7-8v-4L10 2z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M10 6v4l2.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
};

function navItemStyle(active) {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '9px 12px',
    borderRadius: '8px',
    cursor: 'pointer',
    fontSize: '13px',
    fontWeight: active ? 700 : 500,
    color: active ? 'oklch(78% 0.14 200)' : 'oklch(62% 0.015 250)',
    background: active ? 'oklch(24% 0.04 200)' : 'transparent',
    borderLeft: active ? `2px solid ${ACCENT}` : '2px solid transparent',
    textDecoration: 'none',
  };
}

function Logo() {
  return (
    <svg width="26" height="26" viewBox="0 0 100 100">
      <circle cx="50" cy="50" r="34" fill="none" stroke="oklch(45% 0.02 250)" strokeWidth="6" />
      <polygon points="56,22 38,54 49,54 44,80 66,46 54,46" fill={ACCENT} />
    </svg>
  );
}

export default function DevShell({
  activeNav, onNavigate, isMobile,
  stations, currentStation, onSelectStation,
  stationMenuOpen, onToggleStationMenu, onCloseStationMenu,
  children,
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();
  const stationsPageActive = location.pathname === '/dev/stations';

  const curMeta = DEV_STATION_STATUS_META[currentStation.status];
  const currentStationDotStyle = { width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0, background: curMeta.color };

  function navigateAndCloseDrawer(id) {
    setDrawerOpen(false);
    onNavigate(id);
  }

  function selectStationAndClose(id) {
    onSelectStation(id);
    onCloseStationMenu();
  }

  const stationMenuRows = (showStatus) =>
    stations.map((s) => {
      const m = DEV_STATION_STATUS_META[s.status];
      const isSel = s.id === currentStation.id;
      return (
        <div
          key={s.id}
          onClick={() => selectStationAndClose(s.id)}
          style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 8px', borderRadius: '8px', cursor: 'pointer', background: isSel ? 'oklch(24% 0.03 250)' : 'transparent' }}
        >
          <span style={{ width: '7px', height: '7px', borderRadius: '50%', flexShrink: 0, background: m.color }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '12.5px', fontWeight: 600, color: 'white' }}>{s.name}</div>
            <div style={{ fontSize: '11px', color: 'oklch(62% 0.015 250)' }}>{s.location}</div>
          </div>
          {showStatus && (
            <span style={{ fontSize: '10px', fontWeight: 700, padding: '2px 7px', borderRadius: '10px', color: m.color, background: 'oklch(24% 0.02 250)', flexShrink: 0 }}>{m.label}</span>
          )}
        </div>
      );
    });

  const contentStyle = {
    marginLeft: isMobile ? '0' : '240px',
    padding: isMobile ? '20px 16px 40px' : '32px 40px 40px',
    boxSizing: 'border-box',
    maxWidth: '980px',
  };

  return (
    <div className="dev-console" style={{ fontFamily: "'Manrope',sans-serif", color: 'oklch(93% 0.005 250)', background: 'oklch(15% 0.02 250)', minHeight: '100vh' }}>
      {/* ===== SIDEBAR (desktop) ===== */}
      {!isMobile && (
        <div style={{ position: 'fixed', left: 0, top: 0, width: '240px', height: '100vh', background: 'oklch(11% 0.018 250)', boxSizing: 'border-box', padding: '24px 14px', display: 'flex', flexDirection: 'column', gap: '6px', zIndex: 10, borderRight: '1px solid oklch(26% 0.02 250)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px 6px' }}>
            <Logo />
            <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '16px', fontWeight: 700, color: 'white' }}>SolGrid</span>
          </div>
          <div style={{ display: 'inline-flex', alignSelf: 'flex-start', margin: '0 8px 14px', fontFamily: "'IBM Plex Mono',monospace", fontSize: '10.5px', fontWeight: 600, letterSpacing: '0.06em', color: 'oklch(75% 0.14 70)', background: 'oklch(28% 0.05 70)', padding: '3px 8px', borderRadius: '5px' }}>DEV CONSOLE</div>

          <Link to="/dev/stations" style={navItemStyle(stationsPageActive)}>
            {STATIONS_LINK.icon}
            <span style={{ whiteSpace: 'nowrap' }}>{STATIONS_LINK.label}</span>
          </Link>

          <div style={{ position: 'relative', margin: '8px 8px 20px' }}>
            <button onClick={onToggleStationMenu} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '8px', padding: '9px 10px', borderRadius: '9px', border: '1px solid oklch(30% 0.02 250)', background: 'oklch(17% 0.02 250)', cursor: 'pointer', textAlign: 'left' }}>
              <span style={currentStationDotStyle} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '12.5px', fontWeight: 700, color: 'white', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentStation.name}</div>
                <div style={{ fontSize: '11px', color: 'oklch(62% 0.015 250)' }}>{currentStation.location}</div>
              </div>
              <svg width="12" height="12" viewBox="0 0 20 20"><path d="M5 8l5 5 5-5" fill="none" stroke="oklch(62% 0.015 250)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
            {stationMenuOpen && (
              <>
                <div onClick={onCloseStationMenu} style={{ position: 'fixed', inset: 0, zIndex: 14 }} />
                <div style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0, background: 'oklch(13% 0.018 250)', border: '1px solid oklch(32% 0.02 250)', borderRadius: '10px', padding: '6px', zIndex: 15, boxShadow: '0 8px 24px oklch(0% 0 0 / 0.5)' }}>
                  {stationMenuRows(true)}
                </div>
              </>
            )}
          </div>

          {NAV_ITEMS.map((item) => (
            <div key={item.id} style={navItemStyle(!stationsPageActive && activeNav === item.id)} onClick={() => onNavigate(item.id)}>
              {item.icon}
              <span style={{ whiteSpace: 'nowrap' }}>{item.label}</span>
            </div>
          ))}

          <div style={{ flex: 1 }} />

          <Link to="/" state={{ fromDev: true }} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px', borderRadius: '9px', fontSize: '12.5px', color: 'oklch(62% 0.015 250)', textDecoration: 'none', borderTop: '1px solid oklch(26% 0.02 250)', marginTop: '8px', paddingTop: '16px' }}>
            <svg width="14" height="14" viewBox="0 0 20 20"><path d="M12 4l-6 6 6 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
            Về giao diện người dùng
          </Link>
        </div>
      )}

      {/* ===== TOPBAR + DRAWER (mobile) ===== */}
      {isMobile && (
        <>
          <div style={{ position: 'sticky', top: 0, zIndex: 20, background: 'oklch(11% 0.018 250)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', boxSizing: 'border-box', borderBottom: '1px solid oklch(26% 0.02 250)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <button onClick={() => setDrawerOpen(true)} style={{ background: 'none', border: 'none', padding: '6px', margin: '-6px', cursor: 'pointer' }}>
                <svg width="20" height="20" viewBox="0 0 20 20"><line x1="2.5" y1="5" x2="17.5" y2="5" stroke="white" strokeWidth="1.8" strokeLinecap="round" /><line x1="2.5" y1="10" x2="17.5" y2="10" stroke="white" strokeWidth="1.8" strokeLinecap="round" /><line x1="2.5" y1="15" x2="17.5" y2="15" stroke="white" strokeWidth="1.8" strokeLinecap="round" /></svg>
              </button>
              <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '15px', fontWeight: 700, color: 'white' }}>SolGrid</span>
              <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '9.5px', fontWeight: 600, color: 'oklch(75% 0.14 70)', background: 'oklch(28% 0.05 70)', padding: '2px 6px', borderRadius: '4px' }}>DEV</span>
            </div>
            <div style={{ position: 'relative' }}>
              <button onClick={onToggleStationMenu} style={{ display: 'flex', alignItems: 'center', gap: '5px', background: 'oklch(17% 0.02 250)', border: '1px solid oklch(30% 0.02 250)', borderRadius: '20px', padding: '5px 10px', cursor: 'pointer' }}>
                <span style={currentStationDotStyle} />
                <span style={{ fontSize: '11px', fontWeight: 600, color: 'white', whiteSpace: 'nowrap' }}>{currentStation.name}</span>
              </button>
              {stationMenuOpen && (
                <>
                  <div onClick={onCloseStationMenu} style={{ position: 'fixed', inset: 0, zIndex: 24 }} />
                  <div style={{ position: 'absolute', top: 'calc(100% + 8px)', right: 0, width: '210px', background: 'oklch(13% 0.018 250)', border: '1px solid oklch(32% 0.02 250)', borderRadius: '10px', padding: '6px', zIndex: 25, boxShadow: '0 8px 24px oklch(0% 0 0 / 0.5)' }}>
                    {stationMenuRows(false)}
                  </div>
                </>
              )}
            </div>
          </div>

          {drawerOpen && (
            <>
              <div onClick={() => setDrawerOpen(false)} style={{ position: 'fixed', inset: 0, background: 'oklch(0% 0 0 / 0.5)', zIndex: 29 }} />
              <div style={{ position: 'fixed', left: 0, top: 0, height: '100vh', width: '250px', background: 'oklch(11% 0.018 250)', zIndex: 30, padding: '20px 14px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 8px 20px' }}>
                  <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '16px', fontWeight: 700, color: 'white' }}>Menu</span>
                  <button onClick={() => setDrawerOpen(false)} style={{ background: 'none', border: 'none', color: 'white', fontSize: '20px', cursor: 'pointer', lineHeight: 1 }}>×</button>
                </div>
                <Link to="/dev/stations" onClick={() => setDrawerOpen(false)} style={navItemStyle(stationsPageActive)}>
                  <span>{STATIONS_LINK.label}</span>
                </Link>
                {NAV_ITEMS.map((item) => (
                  <div key={item.id} style={navItemStyle(!stationsPageActive && activeNav === item.id)} onClick={() => navigateAndCloseDrawer(item.id)}>
                    <span>{item.label}</span>
                  </div>
                ))}
                <Link to="/" state={{ fromDev: true }} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px', borderRadius: '9px', fontSize: '12.5px', color: 'oklch(62% 0.015 250)', textDecoration: 'none', borderTop: '1px solid oklch(26% 0.02 250)', marginTop: '8px', paddingTop: '16px' }}>
                  ← Về giao diện người dùng
                </Link>
              </div>
            </>
          )}
        </>
      )}

      {/* ===== MAIN CONTENT ===== */}
      <div style={contentStyle}>{children}</div>
    </div>
  );
}
