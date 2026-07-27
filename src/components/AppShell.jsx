import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext.jsx';

const NAV_ITEMS = [
  {
    id: 'overview',
    label: 'Giám sát',
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20"><rect x="2" y="2" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.7" /><rect x="11" y="2" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.7" /><rect x="2" y="11" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.7" /><rect x="11" y="11" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.7" /></svg>
    ),
  },
  {
    id: 'flow',
    label: 'Dòng năng lượng',
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20"><circle cx="3.5" cy="10" r="2.2" fill="currentColor" /><circle cx="16.5" cy="10" r="2.2" fill="currentColor" /><line x1="6" y1="10" x2="14" y2="10" stroke="currentColor" strokeWidth="1.7" /><path d="M10.5 7l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
    ),
  },
  {
    id: 'chart',
    label: 'Biểu đồ thời gian thực',
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20"><line x1="4" y1="16" x2="4" y2="10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /><line x1="10" y1="16" x2="10" y2="5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /><line x1="16" y1="16" x2="16" y2="8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
    ),
  },
  {
    id: 'battery',
    label: 'Pin lưu trữ',
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20"><rect x="2" y="6" width="14" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.7" /><rect x="17" y="8.5" width="2" height="3" fill="currentColor" /><rect x="4" y="8" width="7" height="4" fill="currentColor" /></svg>
    ),
  },
  {
    id: 'load',
    label: 'Điều khiển tải',
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20"><circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.7" /><line x1="10" y1="5.2" x2="10" y2="10" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
    ),
  },
  {
    id: 'alerts',
    label: 'Cảnh báo',
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20"><path d="M10 3c-2.2 0-3.6 1.7-3.6 4v2.3c0 .6-.2 1.2-.6 1.7l-1 1.3h10.4l-1-1.3c-.4-.5-.6-1.1-.6-1.7V7c0-2.3-1.4-4-3.6-4z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="M8.3 15a1.7 1.7 0 003.4 0" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>
    ),
  },
  {
    id: 'reports',
    label: 'Báo cáo',
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20"><rect x="3" y="2.5" width="14" height="15" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.6" /><line x1="6" y1="7" x2="14" y2="7" stroke="currentColor" strokeWidth="1.4" /><line x1="6" y1="10.2" x2="14" y2="10.2" stroke="currentColor" strokeWidth="1.4" /><line x1="6" y1="13.4" x2="11" y2="13.4" stroke="currentColor" strokeWidth="1.4" /></svg>
    ),
  },
  {
    id: 'settings',
    label: 'Cài đặt',
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20">
        <path d="M11.4 2.5h-2.8l-.4 2.1a5.9 5.9 0 0 0-1.5.87l-2.02-.78-1.4 2.42 1.68 1.38a5.9 5.9 0 0 0 0 1.72l-1.68 1.38 1.4 2.42 2.02-.78c.44.36.95.65 1.5.87l.4 2.1h2.8l.4-2.1a5.9 5.9 0 0 0 1.5-.87l2.02.78 1.4-2.42-1.68-1.38a5.9 5.9 0 0 0 0-1.72l1.68-1.38-1.4-2.42-2.02.78a5.9 5.9 0 0 0-1.5-.87z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <circle cx="10" cy="10" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    ),
  },
];

const SEVERITY_COLOR = { warning: 'oklch(75% 0.14 70)', danger: 'oklch(58% 0.19 25)', info: 'oklch(54% 0.15 240)' };
const BLUE = 'oklch(54% 0.15 240)';

// Nút chuông + dropdown thông báo cho topbar mobile. Chỉ hiển thị khi trang
// gọi AppShell truyền `onToggleNotif` (hiện chỉ Dashboard.jsx có dữ liệu cảnh
// báo) — các trang khác không truyền thì không có nút chuông, giống hành vi
// header desktop hiện tại.
function MobileNotifBell({ notifOpen, onToggleNotif, onCloseNotif, unreadCount, notifItems, onMarkNotifRead, onMarkAllNotifsRead, onViewAllNotifs }) {
  return (
    <div style={{ position: 'relative' }}>
      <button onClick={onToggleNotif} title="Thông báo" aria-label="Thông báo" style={{ position: 'relative', width: '34px', height: '34px', borderRadius: '9px', background: notifOpen ? 'oklch(30% 0.05 240)' : 'oklch(26% 0.045 240)', border: '1px solid oklch(34% 0.04 240)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0, flexShrink: 0 }}>
        <svg width="15" height="15" viewBox="0 0 20 20"><path d="M10 3c-2.2 0-3.6 1.7-3.6 4v2.3c0 .6-.2 1.2-.6 1.7l-1 1.3h10.4l-1-1.3c-.4-.5-.6-1.1-.6-1.7V7c0-2.3-1.4-4-3.6-4z" fill="none" stroke="white" strokeWidth="1.5" strokeLinejoin="round" /></svg>
        {unreadCount > 0 && (
          <span style={{ position: 'absolute', top: '-4px', right: '-4px', fontSize: '9.5px', fontWeight: 700, color: 'white', background: 'oklch(58% 0.19 25)', borderRadius: '8px', padding: '1px 5px', minWidth: '14px', textAlign: 'center' }}>{unreadCount}</span>
        )}
      </button>
      {notifOpen && (
        <>
          <div onClick={onCloseNotif} style={{ position: 'fixed', inset: 0, zIndex: 24 }} />
          <div style={{ position: 'absolute', top: 'calc(100% + 8px)', right: 0, width: '300px', maxWidth: 'calc(100vw - 32px)', background: 'white', border: '1px solid oklch(90% 0.01 240)', borderRadius: '14px', boxShadow: '0 12px 32px oklch(0% 0 0 / 0.35)', zIndex: 25, overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: '1px solid oklch(94% 0.008 240)' }}>
              <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '14px', fontWeight: 700, color: 'oklch(24% 0.03 240)' }}>Thông báo mới nhất</span>
              {unreadCount > 0 && (
                <button onClick={onMarkAllNotifsRead} style={{ background: 'none', border: 'none', fontSize: '12px', fontWeight: 600, color: BLUE, cursor: 'pointer', padding: 0, fontFamily: "'Manrope',sans-serif" }}>Đánh dấu đã đọc</button>
              )}
            </div>
            {notifItems.length === 0 ? (
              <div style={{ padding: '28px 16px', textAlign: 'center', fontSize: '13px', color: 'oklch(55% 0.02 240)' }}>Không có thông báo chưa đọc</div>
            ) : (
              <div>
                {notifItems.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => onMarkNotifRead(item.id)}
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
            <button onClick={onViewAllNotifs} style={{ display: 'block', width: '100%', textAlign: 'center', padding: '12px', background: 'oklch(98% 0.004 240)', border: 'none', borderTop: '1px solid oklch(94% 0.008 240)', fontSize: '12.5px', fontWeight: 700, color: BLUE, cursor: 'pointer', fontFamily: "'Manrope',sans-serif" }}>Xem tất cả cảnh báo →</button>
          </div>
        </>
      )}
    </div>
  );
}

function navItemStyle(active) {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '10px 12px',
    borderRadius: '9px',
    cursor: 'pointer',
    fontSize: '13.5px',
    fontWeight: active ? 700 : 500,
    color: active ? 'white' : 'oklch(68% 0.03 240)',
    background: active ? 'oklch(54% 0.15 240)' : 'transparent',
  };
}

function Logo({ size = 30 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100">
      <circle cx="50" cy="50" r="34" fill="none" stroke="oklch(80% 0.06 240)" strokeWidth="6" />
      <polygon points="56,22 38,54 49,54 44,80 66,46 54,46" fill="oklch(78% 0.13 70)" />
    </svg>
  );
}

export default function AppShell({
  activeNav, onNavigate, isMobile, station, stationColor, stationOptions, stationMenuOpen, onToggleStationMenu, onCloseStationMenu, moduleVisibility = {}, children,
  notifOpen, onToggleNotif, onCloseNotif, unreadCount = 0, notifItems = [], onMarkNotifRead, onMarkAllNotifsRead, onViewAllNotifs,
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { user, isAdmin } = useAuth();
  // 'overview' và 'settings' luôn hiển thị; các mục còn lại do DevConsole bật/tắt.
  const visibleNavItems = NAV_ITEMS.filter(
    (item) => item.id === 'overview' || item.id === 'settings' || (moduleVisibility[item.id] ?? true),
  );
  const avatarUrl = user?.app_metadata?.provider === 'google' ? (user?.user_metadata?.avatar_url ?? user?.user_metadata?.picture ?? null) : null;

  const currentStationDotStyle = { width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0, background: stationColor };

  const stationMenu = (
    <div style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0, background: 'oklch(20% 0.04 240)', border: '1px solid oklch(34% 0.04 240)', borderRadius: '10px', padding: '6px', zIndex: 15, boxShadow: '0 8px 24px oklch(0% 0 0 / 0.35)' }}>
      {stationOptions.map((st) => (
        <div key={st.id} onClick={st.select} style={st.rowStyle}>
          <span style={st.dotStyle} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '12.5px', fontWeight: 600, color: 'white' }}>{st.name}</div>
            <div style={{ fontSize: '11px', color: 'oklch(65% 0.03 240)' }}>{st.location}</div>
          </div>
          <span style={st.statusLabelStyle}>{st.statusLabel}</span>
        </div>
      ))}
    </div>
  );

  function navigateAndCloseDrawer(id) {
    setDrawerOpen(false);
    onNavigate(id);
  }

  const contentStyle = {
    marginLeft: isMobile ? '0' : '240px',
    padding: isMobile ? '20px 16px 40px' : '32px 40px 40px',
    boxSizing: 'border-box',
  };

  return (
    <div style={{ fontFamily: "'Manrope',sans-serif", color: 'oklch(24% 0.03 240)', background: 'oklch(97% 0.005 240)', minHeight: '100vh' }}>
      {!isMobile && (
        <div style={{ position: 'fixed', left: 0, top: 0, width: '240px', height: '100vh', background: 'oklch(22% 0.045 240)', boxSizing: 'border-box', padding: '24px 16px', display: 'flex', flexDirection: 'column', gap: '8px', zIndex: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '9px', padding: '8px 8px 14px' }}>
            <Logo />
            <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '18px', fontWeight: 700, color: 'white' }}>SolGrid</span>
          </div>

          <div style={{ position: 'relative', margin: '0 8px 18px' }}>
            <button onClick={onToggleStationMenu} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '8px', padding: '9px 10px', borderRadius: '9px', border: '1px solid oklch(32% 0.04 240 / 0.6)', background: 'oklch(26% 0.045 240)', cursor: 'pointer', textAlign: 'left' }}>
              <span style={currentStationDotStyle} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '12.5px', fontWeight: 700, color: 'white', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{station.name}</div>
                <div style={{ fontSize: '11px', color: 'oklch(65% 0.03 240)' }}>{station.location}</div>
              </div>
              <svg width="12" height="12" viewBox="0 0 20 20"><path d="M5 8l5 5 5-5" fill="none" stroke="oklch(65% 0.03 240)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
            {stationMenuOpen && (
              <>
                <div onClick={onCloseStationMenu} style={{ position: 'fixed', inset: 0, zIndex: 14 }} />
                {stationMenu}
              </>
            )}
          </div>

          {visibleNavItems.map((item) => (
            <div key={item.id} style={navItemStyle(activeNav === item.id)} onClick={() => onNavigate(item.id)}>
              {item.icon}
              <span style={{ whiteSpace: 'nowrap' }}>{item.label}</span>
            </div>
          ))}

          <div style={{ flex: 1 }} />

          {isAdmin && (
            <Link to="/dev" style={{ display: 'flex', alignItems: 'center', gap: '9px', padding: '10px 12px', borderRadius: '9px', background: 'oklch(28% 0.05 70 / 0.55)', border: '1px solid oklch(45% 0.1 70 / 0.5)', textDecoration: 'none', marginBottom: '4px' }}>
              <svg width="16" height="16" viewBox="0 0 20 20" style={{ flexShrink: 0 }}><path d="M7 6l-4 4 4 4M13 6l4 4-4 4" fill="none" stroke="oklch(80% 0.14 70)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
              <span style={{ fontSize: '12.5px', fontWeight: 700, color: 'oklch(85% 0.12 70)', whiteSpace: 'nowrap' }}>Chế độ nhà phát triển</span>
            </Link>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 8px', borderTop: '1px solid oklch(32% 0.04 240 / 0.5)' }}>
            {avatarUrl ? (
              <img src={avatarUrl} alt="Ảnh đại diện" style={{ width: '34px', height: '34px', borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
            ) : (
              <div style={{ width: '34px', height: '34px', borderRadius: '50%', background: 'oklch(32% 0.04 240)', border: '1px solid oklch(40% 0.04 240)', flexShrink: 0 }} />
            )}
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: '13px', fontWeight: 700, color: 'white', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Hộ gia đình</div>
              <div style={{ fontSize: '11.5px', color: 'oklch(65% 0.03 240)' }}>Tài khoản chủ hộ</div>
            </div>
          </div>
        </div>
      )}

      {isMobile && (
        <>
          <div style={{ position: 'sticky', top: 0, zIndex: 20, background: 'oklch(22% 0.045 240)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', boxSizing: 'border-box' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '9px' }}>
              <button onClick={() => setDrawerOpen(true)} style={{ background: 'none', border: 'none', padding: '6px', margin: '-6px', cursor: 'pointer' }}>
                <svg width="20" height="20" viewBox="0 0 20 20"><line x1="2.5" y1="5" x2="17.5" y2="5" stroke="white" strokeWidth="1.8" strokeLinecap="round" /><line x1="2.5" y1="10" x2="17.5" y2="10" stroke="white" strokeWidth="1.8" strokeLinecap="round" /><line x1="2.5" y1="15" x2="17.5" y2="15" stroke="white" strokeWidth="1.8" strokeLinecap="round" /></svg>
              </button>
              <Logo size={24} />
              <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '16px', fontWeight: 700, color: 'white' }}>SolGrid</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {onToggleNotif && (
                <MobileNotifBell
                  notifOpen={notifOpen}
                  onToggleNotif={onToggleNotif}
                  onCloseNotif={onCloseNotif}
                  unreadCount={unreadCount}
                  notifItems={notifItems}
                  onMarkNotifRead={onMarkNotifRead}
                  onMarkAllNotifsRead={onMarkAllNotifsRead}
                  onViewAllNotifs={onViewAllNotifs}
                />
              )}
              <div style={{ position: 'relative' }}>
                <button onClick={onToggleStationMenu} style={{ display: 'flex', alignItems: 'center', gap: '5px', background: 'oklch(26% 0.045 240)', border: '1px solid oklch(34% 0.04 240)', borderRadius: '20px', padding: '5px 10px', cursor: 'pointer' }}>
                  <span style={currentStationDotStyle} />
                  <span style={{ fontSize: '11.5px', fontWeight: 600, color: 'white', whiteSpace: 'nowrap' }}>{station.name}</span>
                </button>
                {stationMenuOpen && (
                  <>
                    <div onClick={onCloseStationMenu} style={{ position: 'fixed', inset: 0, zIndex: 24 }} />
                    <div style={{ position: 'absolute', top: 'calc(100% + 8px)', right: 0, width: '220px', background: 'oklch(20% 0.04 240)', border: '1px solid oklch(34% 0.04 240)', borderRadius: '10px', padding: '6px', zIndex: 25, boxShadow: '0 8px 24px oklch(0% 0 0 / 0.35)' }}>
                      {stationOptions.map((st) => (
                        <div key={st.id} onClick={st.select} style={st.rowStyle}>
                          <span style={st.dotStyle} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: '12.5px', fontWeight: 600, color: 'white' }}>{st.name}</div>
                            <div style={{ fontSize: '11px', color: 'oklch(65% 0.03 240)' }}>{st.location}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>

          {drawerOpen && (
            <>
              <div onClick={() => setDrawerOpen(false)} style={{ position: 'fixed', inset: 0, background: 'oklch(0% 0 0 / 0.4)', zIndex: 29 }} />
              <div style={{ position: 'fixed', left: 0, top: 0, height: '100vh', width: '250px', background: 'oklch(22% 0.045 240)', zIndex: 30, padding: '20px 16px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 8px 20px' }}>
                  <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '17px', fontWeight: 700, color: 'white' }}>Menu</span>
                  <button onClick={() => setDrawerOpen(false)} style={{ background: 'none', border: 'none', color: 'white', fontSize: '20px', cursor: 'pointer', lineHeight: 1 }}>×</button>
                </div>
                {visibleNavItems.map((item) => (
                  <div key={item.id} style={navItemStyle(activeNav === item.id)} onClick={() => navigateAndCloseDrawer(item.id)}>
                    <span>{item.label}</span>
                  </div>
                ))}
                {isAdmin && (
                  <Link to="/dev" onClick={() => setDrawerOpen(false)} style={{ display: 'flex', alignItems: 'center', gap: '9px', padding: '10px 12px', borderRadius: '9px', background: 'oklch(28% 0.05 70 / 0.55)', border: '1px solid oklch(45% 0.1 70 / 0.5)', textDecoration: 'none', marginTop: '8px' }}>
                    <svg width="16" height="16" viewBox="0 0 20 20" style={{ flexShrink: 0 }}><path d="M7 6l-4 4 4 4M13 6l4 4-4 4" fill="none" stroke="oklch(80% 0.14 70)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    <span style={{ fontSize: '13px', fontWeight: 700, color: 'oklch(85% 0.12 70)' }}>Chế độ nhà phát triển</span>
                  </Link>
                )}
              </div>
            </>
          )}
        </>
      )}

      <div style={contentStyle}>{children}</div>
    </div>
  );
}
