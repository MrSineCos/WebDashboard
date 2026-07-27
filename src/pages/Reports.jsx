import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import AppShell from '../components/AppShell.jsx';
import { useIsMobile } from '../lib/useIsMobile.js';
import { useStationSelector } from '../lib/stations.js';
import { useDailyEnergy, useHourlyEnergy } from '../lib/telemetry.js';
import { useUserSettings } from '../lib/userSettings.js';

const BLUE = 'oklch(54% 0.15 240)';

const DAYS_WINDOW = 14;
const VN_DOW = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
const TICK_HOURS = [0, 3, 6, 9, 12, 15, 18, 21];

// Khung 14 ngày gần nhất (kể cả hôm nay), dùng làm khung trục cho biểu đồ
// ngay cả khi station_daily_energy chưa có dữ liệu cho một số ngày.
function buildDayWindow(n) {
  const days = [];
  const today = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    days.push({
      iso,
      year: d.getFullYear(),
      date: `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`,
      day: VN_DOW[d.getDay()],
    });
  }
  return days;
}

function buildPath(values, w, h, padTop, padBottom, xOffset = 0) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = w / (values.length - 1);
  const pts = values.map((v, i) => {
    const x = xOffset + i * stepX;
    const y = padTop + (1 - (v - min) / range) * (h - padTop - padBottom);
    return { x, y, value: v };
  });
  const line = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' ');
  const area = line + ` L${pts[pts.length - 1].x.toFixed(1)},${h - padBottom} L${pts[0].x.toFixed(1)},${h - padBottom} Z`;
  return { line, area, points: pts };
}

export default function Reports() {
  const navigate = useNavigate();
  const isMobile = useIsMobile(900);
  const { station, stationColor, stationOptions, stationMenuOpen, toggleStationMenu, closeStationMenu, loading: stationLoading } = useStationSelector();
  const { rows: dailyRows } = useDailyEnergy(station?.id, DAYS_WINDOW);
  const settings = useUserSettings(station?.id);

  const [selectedIndex, setSelectedIndex] = useState(DAYS_WINDOW - 1);
  const [hoverIdx, setHoverIdx] = useState(null);

  // Derived from dailyRows/selectedIndex only (not `station`), so these can
  // run before the loading guard below — needed because useHourlyEnergy must
  // be called unconditionally on every render (rules-of-hooks).
  const dayWindow = buildDayWindow(DAYS_WINDOW);
  const dailyMap = new Map(dailyRows.map((r) => [r.day, r]));
  const scaledDaily = dayWindow.map((d) => {
    const row = dailyMap.get(d.iso);
    return { ...d, kwh: +(row?.solarKwh ?? 0).toFixed(1), loadKwh: +(row?.loadKwh ?? 0).toFixed(1) };
  });
  const selIdx = Math.min(selectedIndex, scaledDaily.length - 1);
  const selectedDay = scaledDaily[selIdx];
  const { rows: hourlyRows } = useHourlyEnergy(station?.id, selectedDay.iso);

  function onNavigate(id) {
    if (id === 'reports') return;
    navigate('/');
  }

  // Module "Báo cáo" có thể bị ẩn riêng cho từng trạm — nếu đang ở trang này
  // rồi chuyển sang trạm đã ẩn module, tự điều hướng về Dashboard.
  const reportsModuleHidden = !settings.loading && settings.moduleVisibility.reports === false;
  useEffect(() => {
    // Xem giải thích ở Battery.jsx: thiếu state.fromDev sẽ khiến
    // ProtectedRoute bật lại quy tắc đưa admin về DevConsole thay vì Dashboard.
    if (reportsModuleHidden) navigate('/', { replace: true, state: { fromDev: true } });
  }, [reportsModuleHidden, navigate]);

  if (stationLoading || !station || settings.loading || reportsModuleHidden) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'oklch(97% 0.005 240)', color: 'oklch(52% 0.02 240)', fontFamily: "'Manrope',sans-serif" }}>
        Đang tải…
      </div>
    );
  }

  const kwhValues = scaledDaily.map((d) => d.kwh);
  const maxKwh = Math.max(...kwhValues);
  const minKwh = Math.min(...kwhValues);
  const totalKwh = kwhValues.reduce((a, b) => a + b, 0);
  const avgKwh = totalKwh / kwhValues.length;
  const maxDay = scaledDaily.find((d) => d.kwh === maxKwh);
  const minDay = scaledDaily.find((d) => d.kwh === minKwh);
  const maxKwhSafe = maxKwh || 1;

  const prevDay = selIdx > 0 ? scaledDaily[selIdx - 1] : null;
  const deltaPct = prevDay && prevDay.kwh > 0 ? Math.round(((selectedDay.kwh - prevDay.kwh) / prevDay.kwh) * 100) : null;

  const dailyBars = scaledDaily.map((d, i) => ({
    ...d,
    barStyle: {
      width: '100%', maxWidth: '26px', borderRadius: '5px 5px 2px 2px',
      height: Math.max(6, (d.kwh / maxKwhSafe) * 108) + 'px',
      background: i === selIdx ? BLUE : 'oklch(54% 0.15 240 / 0.35)',
    },
    labelStyle: { fontFamily: "'IBM Plex Mono',monospace", fontSize: '10.5px', color: i === selIdx ? 'oklch(24% 0.03 240)' : 'oklch(58% 0.02 240)', fontWeight: i === selIdx ? 700 : 400 },
    dayLabelStyle: { fontSize: '11px', color: i === selIdx ? 'oklch(24% 0.03 240)' : 'oklch(58% 0.02 240)', fontWeight: i === selIdx ? 700 : 500 },
  }));

  const hourlyMap = new Map(hourlyRows.map((r) => [r.hour, r]));
  const hasHourly = hourlyRows.length > 0;
  const hourValues = Array.from({ length: 24 }, (_, h) => Math.round(hourlyMap.get(h)?.avgSolarW ?? 0));
  const PLOT_X0 = 44, PLOT_W = 640, PLOT_H = 200, PAD_TOP = 14, PAD_BOTTOM = 38;
  const { line, area, points } = buildPath(hourValues, PLOT_W, PLOT_H, PAD_TOP, PAD_BOTTOM, PLOT_X0);
  const peakIdx = hourValues.indexOf(Math.max(...hourValues));
  const peakHourLabel = hasHourly ? `${String(peakIdx).padStart(2, '0')}:00` : '--';

  const voltageValues = hourlyRows.map((r) => r.avgBatteryVoltage).filter((v) => v != null);
  const avgVoltage = voltageValues.length ? voltageValues.reduce((a, b) => a + b, 0) / voltageValues.length : null;

  const yMax = Math.max(...hourValues, 0), yMin = Math.min(...hourValues, 0);
  const yMid = Math.round((yMax + yMin) / 2);
  const yLabelStyleBase = { position: 'absolute', left: '2px', width: '34px', textAlign: 'right', fontFamily: "'IBM Plex Mono',monospace", fontSize: '10.5px', color: 'oklch(52% 0.02 240)', pointerEvents: 'none', transform: 'translateY(-50%)' };
  const axisYTicks = [
    { y: 14, label: String(yMax), labelStyle: { ...yLabelStyleBase, top: '14px' } },
    { y: 88, label: String(yMid), labelStyle: { ...yLabelStyleBase, top: '88px' } },
    { y: 162, label: String(yMin), labelStyle: { ...yLabelStyleBase, top: '162px' } },
  ];
  const xStep = PLOT_W / (hourValues.length - 1);
  const axisXTicks = TICK_HOURS.map((h) => {
    const x = +(PLOT_X0 + h * xStep).toFixed(1);
    const leftPct = (x / 684) * 100;
    return {
      x, label: `${String(h).padStart(2, '0')}:00`,
      labelStyle: { position: 'absolute', left: leftPct + '%', top: '170px', transform: 'translateX(-50%)', whiteSpace: 'nowrap', fontFamily: "'IBM Plex Mono',monospace", fontSize: '10.5px', color: 'oklch(52% 0.02 240)', pointerEvents: 'none' },
    };
  });

  const hoverPoint = hasHourly && hoverIdx != null ? points[hoverIdx] : null;
  const hoverActive = !!hoverPoint;
  let hoverX = 0, hoverY = 0, hoverValueText = '', hoverTimeText = '', hoverTooltipStyle = null;
  if (hoverPoint) {
    hoverX = hoverPoint.x;
    hoverY = hoverPoint.y;
    hoverValueText = `${hoverPoint.value} W`;
    hoverTimeText = `${String(hoverIdx).padStart(2, '0')}:00`;
    const leftPct = Math.max(8, Math.min(92, (hoverX / 684) * 100));
    const showAbove = hoverY > 46;
    hoverTooltipStyle = {
      position: 'absolute',
      left: leftPct + '%',
      top: hoverY + 'px',
      transform: showAbove ? 'translate(-50%, calc(-100% - 10px))' : 'translate(-50%, 10px)',
      background: 'oklch(22% 0.045 240)',
      borderRadius: '6px',
      padding: '6px 10px',
      pointerEvents: 'none',
      boxShadow: '0 4px 12px oklch(0% 0 0 / 0.25)',
    };
  }

  function onChartMouseMove(e) {
    if (!hasHourly) return;
    const svg = e.currentTarget.ownerSVGElement;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const scaleX = 684 / rect.width;
    const localX = (e.clientX - rect.left) * scaleX;
    let idx = Math.round((localX - PLOT_X0) / xStep);
    idx = Math.max(0, Math.min(hourValues.length - 1, idx));
    if (idx !== hoverIdx) setHoverIdx(idx);
  }
  function onChartMouseLeave() {
    setHoverIdx(null);
  }

  function onDateInputChange(e) {
    const idx = dayWindow.findIndex((d) => d.iso === e.target.value);
    if (idx >= 0) setSelectedIndex(idx);
  }

  const deltaLabel = deltaPct === null ? '' : deltaPct >= 0 ? `↑ ${deltaPct}% so với ngày trước` : `↓ ${Math.abs(deltaPct)}% so với ngày trước`;
  const deltaStyle = { fontSize: '12.5px', fontWeight: 600, whiteSpace: 'nowrap', color: deltaPct === null ? 'oklch(52% 0.02 240)' : deltaPct >= 0 ? 'oklch(64% 0.15 150)' : 'oklch(58% 0.19 25)' };

  const cardStyle = { background: 'white', border: '1px solid oklch(91% 0.01 240)', borderRadius: '16px', padding: '24px', boxShadow: '0 1px 2px oklch(0% 0 0 / 0.04)' };

  return (
    <AppShell
      activeNav="reports"
      onNavigate={onNavigate}
      isMobile={isMobile}
      station={station}
      stationColor={stationColor}
      stationOptions={stationOptions}
      stationMenuOpen={stationMenuOpen}
      onToggleStationMenu={toggleStationMenu}
      onCloseStationMenu={closeStationMenu}
      moduleVisibility={settings.moduleVisibility}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h1 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '26px', fontWeight: 700, margin: '0 0 4px', color: 'oklch(20% 0.03 240)' }}>Báo cáo hiệu suất</h1>
          <div style={{ fontSize: '13.5px', color: 'oklch(50% 0.02 240)' }}>{station.name} · {station.location}</div>
        </div>
        <button style={{ padding: '10px 18px', borderRadius: '9px', border: '1px solid oklch(88% 0.01 240)', background: 'white', fontSize: '13px', fontWeight: 600, color: 'oklch(30% 0.03 240)', cursor: 'pointer' }}>Xuất báo cáo CSV</button>
      </div>

      {/* PERIOD SUMMARY */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px,1fr))', gap: '16px', marginBottom: '20px' }}>
        <div style={{ background: 'white', border: '1px solid oklch(91% 0.01 240)', borderRadius: '14px', padding: '20px', boxShadow: '0 1px 2px oklch(0% 0 0 / 0.04)' }}>
          <div style={{ fontSize: '13px', color: 'oklch(52% 0.02 240)', fontWeight: 600, marginBottom: '12px' }}>Tổng sản lượng (14 ngày)</div>
          <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '24px', fontWeight: 500 }}>{totalKwh.toFixed(1)} <span style={{ fontSize: '14px', color: 'oklch(55% 0.02 240)' }}>kWh</span></div>
        </div>
        <div style={{ background: 'white', border: '1px solid oklch(91% 0.01 240)', borderRadius: '14px', padding: '20px', boxShadow: '0 1px 2px oklch(0% 0 0 / 0.04)' }}>
          <div style={{ fontSize: '13px', color: 'oklch(52% 0.02 240)', fontWeight: 600, marginBottom: '12px' }}>Trung bình / ngày</div>
          <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '24px', fontWeight: 500 }}>{avgKwh.toFixed(1)} <span style={{ fontSize: '14px', color: 'oklch(55% 0.02 240)' }}>kWh</span></div>
        </div>
        <div style={{ background: 'white', border: '1px solid oklch(91% 0.01 240)', borderRadius: '14px', padding: '20px', boxShadow: '0 1px 2px oklch(0% 0 0 / 0.04)' }}>
          <div style={{ fontSize: '13px', color: 'oklch(52% 0.02 240)', fontWeight: 600, marginBottom: '12px' }}>Ngày cao nhất</div>
          <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '24px', fontWeight: 500, color: 'oklch(64% 0.15 150)' }}>{maxKwh.toFixed(1)} <span style={{ fontSize: '14px', color: 'oklch(55% 0.02 240)' }}>kWh</span></div>
          <div style={{ fontSize: '12px', color: 'oklch(52% 0.02 240)', marginTop: '4px' }}>{maxDay.date}</div>
        </div>
        <div style={{ background: 'white', border: '1px solid oklch(91% 0.01 240)', borderRadius: '14px', padding: '20px', boxShadow: '0 1px 2px oklch(0% 0 0 / 0.04)' }}>
          <div style={{ fontSize: '13px', color: 'oklch(52% 0.02 240)', fontWeight: 600, marginBottom: '12px' }}>Ngày thấp nhất</div>
          <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '24px', fontWeight: 500, color: 'oklch(58% 0.19 25)' }}>{minKwh.toFixed(1)} <span style={{ fontSize: '14px', color: 'oklch(55% 0.02 240)' }}>kWh</span></div>
          <div style={{ fontSize: '12px', color: 'oklch(52% 0.02 240)', marginTop: '4px' }}>{minDay.date}</div>
        </div>
      </div>

      {/* 14-DAY CHART + DATE FILTER */}
      <div style={{ ...cardStyle, marginBottom: '20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '18px', flexWrap: 'wrap', gap: '12px' }}>
          <h2 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '17px', fontWeight: 700, margin: 0 }}>Sản lượng theo ngày</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '12.5px', color: 'oklch(52% 0.02 240)' }}>Chọn ngày:</span>
            <input type="date" value={selectedDay.iso} min={dayWindow[0].iso} max={dayWindow[dayWindow.length - 1].iso} onChange={onDateInputChange} style={{ padding: '8px 10px', borderRadius: '8px', border: '1px solid oklch(88% 0.01 240)', fontSize: '13px', fontFamily: "'Manrope',sans-serif", color: 'oklch(24% 0.03 240)' }} />
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '6px', height: '184px', overflowX: 'auto', overflowY: 'visible', padding: '14px 4px 6px', boxSizing: 'border-box' }}>
          {dailyBars.map((item, i) => (
            <div key={item.iso} onClick={() => setSelectedIndex(i)} style={{ flex: 1, minWidth: '30px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px', height: '100%', justifyContent: 'flex-end', cursor: 'pointer', paddingRight: '2px', boxSizing: 'border-box' }}>
              <span style={item.labelStyle}>{item.kwh}</span>
              <div style={item.barStyle} />
              <span style={item.dayLabelStyle}>{item.day}</span>
            </div>
          ))}
        </div>
      </div>

      {/* SELECTED DAY DETAIL */}
      <div style={{ ...cardStyle, marginBottom: '40px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px', flexWrap: 'wrap', gap: '10px' }}>
          <div>
            <h2 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '17px', fontWeight: 700, margin: '0 0 4px' }}>Ngày {selectedDay.date}/{selectedDay.year}</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: 'oklch(52% 0.02 240)', flexWrap: 'wrap' }}>
              <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontWeight: 600, color: 'oklch(24% 0.03 240)', whiteSpace: 'nowrap' }}>{selectedDay.kwh.toFixed(1)} kWh</span>
              <span style={deltaStyle}>{deltaLabel}</span>
            </div>
          </div>
        </div>
        <p style={{ fontSize: '12.5px', color: 'oklch(52% 0.02 240)', margin: '14px 0 8px' }}>Sản lượng theo giờ (00:00 – 24:00) · công suất (W)</p>
        {hasHourly ? (
        <div style={{ position: 'relative', width: '100%', marginBottom: '20px' }}>
          <svg viewBox="0 0 684 200" width="100%" height="200" preserveAspectRatio="none" style={{ display: 'block', overflow: 'visible', cursor: 'crosshair' }}>
            <line x1="44" y1="14" x2="684" y2="14" stroke="oklch(94% 0.008 240)" strokeWidth="1" />
            <line x1="44" y1="88" x2="684" y2="88" stroke="oklch(94% 0.008 240)" strokeWidth="1" />
            <line x1="44" y1="162" x2="684" y2="162" stroke="oklch(80% 0.012 240)" strokeWidth="1.2" />
            <line x1="44" y1="14" x2="44" y2="162" stroke="oklch(80% 0.012 240)" strokeWidth="1.2" />

            {axisYTicks.map((tick) => (
              <line key={tick.label + tick.y} x1="39" y1={tick.y} x2="44" y2={tick.y} stroke="oklch(68% 0.02 240)" strokeWidth="1" />
            ))}
            {axisXTicks.map((tick) => (
              <line key={tick.label} x1={tick.x} y1="162" x2={tick.x} y2="167" stroke="oklch(68% 0.02 240)" strokeWidth="1" />
            ))}

            <path d={area} fill="oklch(54% 0.15 240 / 0.12)" stroke="none" />
            <path d={line} fill="none" stroke={BLUE} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />

            <g pointerEvents="none">
              {hoverActive && (
                <line x1={hoverX} y1="14" x2={hoverX} y2="162" stroke="oklch(55% 0.03 240)" strokeWidth="1" strokeDasharray="3,3" />
              )}
            </g>

            <rect x="44" y="0" width="640" height="200" fill="transparent" onMouseMove={onChartMouseMove} onMouseLeave={onChartMouseLeave} />
          </svg>

          {hoverActive && (
            <div style={{ position: 'absolute', left: (hoverX / 684) * 100 + '%', top: hoverY + 'px', width: '11px', height: '11px', borderRadius: '50%', background: 'white', border: `2.5px solid ${BLUE}`, boxSizing: 'border-box', transform: 'translate(-50%, -50%)', pointerEvents: 'none' }} />
          )}

          {axisYTicks.map((tick) => (
            <span key={tick.label + '-lbl'} style={tick.labelStyle}>{tick.label}</span>
          ))}
          {axisXTicks.map((tick) => (
            <span key={tick.label + '-lbl'} style={tick.labelStyle}>{tick.label}</span>
          ))}

          {hoverActive && (
            <div style={hoverTooltipStyle}>
              <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '11.5px', fontWeight: 600, color: 'white', whiteSpace: 'nowrap' }}>{hoverValueText}</div>
              <div style={{ fontFamily: "'Manrope',sans-serif", fontSize: '10px', color: 'oklch(70% 0.03 240)', marginTop: '2px', whiteSpace: 'nowrap' }}>{hoverTimeText}</div>
            </div>
          )}
        </div>
        ) : (
          <div style={{ height: '200px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '6px', color: 'oklch(58% 0.02 240)', background: 'oklch(98% 0.004 240)', borderRadius: '12px', border: '1px dashed oklch(88% 0.01 240)', marginBottom: '20px' }}>
            <div style={{ fontSize: '14px', fontWeight: 600 }}>Chưa có dữ liệu telemetry cho ngày này</div>
            <div style={{ fontSize: '12px' }}>Chọn một ngày khác hoặc chờ trạm gửi dữ liệu.</div>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px,1fr))', gap: '12px' }}>
          <div style={{ textAlign: 'center', padding: '12px', background: 'oklch(97% 0.005 240)', borderRadius: '10px' }}>
            <div style={{ fontSize: '11.5px', color: 'oklch(52% 0.02 240)' }}>Giờ sản lượng cao nhất</div>
            <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '16px', fontWeight: 600, marginTop: '4px' }}>{peakHourLabel}</div>
          </div>
          <div style={{ textAlign: 'center', padding: '12px', background: 'oklch(97% 0.005 240)', borderRadius: '10px' }}>
            <div style={{ fontSize: '11.5px', color: 'oklch(52% 0.02 240)' }}>Điện áp trung bình</div>
            <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '16px', fontWeight: 600, marginTop: '4px' }}>{avgVoltage == null ? '--' : avgVoltage.toFixed(1) + 'V'}</div>
          </div>
          <div style={{ textAlign: 'center', padding: '12px', background: 'oklch(97% 0.005 240)', borderRadius: '10px' }}>
            <div style={{ fontSize: '11.5px', color: 'oklch(52% 0.02 240)' }}>Tải tiêu thụ</div>
            <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '16px', fontWeight: 600, marginTop: '4px' }}>{selectedDay.loadKwh.toFixed(1)} kWh</div>
          </div>
          <div style={{ textAlign: 'center', padding: '12px', background: 'oklch(97% 0.005 240)', borderRadius: '10px' }}>
            <div style={{ fontSize: '11.5px', color: 'oklch(52% 0.02 240)' }}>Chu kỳ sạc pin (ước tính)</div>
            <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '16px', fontWeight: 600, marginTop: '4px' }}>{Math.max(1, Math.round(selectedDay.kwh / 1.8))}</div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
