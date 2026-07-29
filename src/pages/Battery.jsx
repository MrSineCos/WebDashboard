import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import AppShell from '../components/AppShell.jsx';
import { useIsMobile } from '../lib/useIsMobile.js';
import { useStationSelector } from '../lib/stations.js';
import { useTelemetryToday } from '../lib/telemetry.js';
import { useUserSettings } from '../lib/userSettings.js';

const BLUE = 'oklch(54% 0.15 240)';

const MODE_LABELS = { low: 'Thấp', balanced: 'Cân bằng', max: 'Tối đa' };

// Lý do thiết bị đang ngắt sạc/xả (khớp chuỗi protect_reason firmware gửi về).
const PROTECT_REASON_LABELS = {
  ok: 'Bình thường',
  full: 'Pin đã đầy — ngắt sạc',
  overvoltage: 'Quá áp — ngắt sạc',
  deep_discharge: 'Chống xả sâu — ngắt xả',
  undervoltage: 'Điện áp thấp — ngắt xả',
  overtemp: 'Quá nhiệt',
  manual: 'Ngắt thủ công',
};

const OK_GREEN = 'oklch(64% 0.15 150)';
const CUT_RED = 'oklch(58% 0.19 25)';

// Nhãn mốc giờ bắt đầu của mỗi khung 2 giờ trong ngày (00-02, 02-04, ..., 22-24).
const HOUR_LABELS = ['00', '02', '04', '06', '08', '10', '12', '14', '16', '18', '20', '22'];

// Dung lượng pack BMS 100Ah / 48V (nhãn hiển thị trong trang) → dùng để ước tính
// thời gian sạc đầy / thời gian dự phòng từ công suất nạp/xả hiện tại.
const PACK_CAPACITY_KWH = 4.8;

const CHARGE_GREEN = 'oklch(64% 0.15 150)';
const DISCH_AMBER = 'oklch(75% 0.14 70)';

export default function Battery() {
  const navigate = useNavigate();
  const isMobile = useIsMobile(900);
  const { station, stationColor, stationOptions, stationMenuOpen, toggleStationMenu, closeStationMenu, loading: stationLoading } = useStationSelector();
  const { readings: todayReadings } = useTelemetryToday(station?.id);
  const settings = useUserSettings(station?.id);

  function onNavigate(id) {
    if (id === 'battery') return;
    if (id === 'reports') {
      navigate('/reports');
      return;
    }
    // `state.fromDev` giữ admin ở lại giao diện người dùng — thiếu cờ này,
    // ProtectedRoute coi đây là lần vào "/" thông thường và đá admin về
    // DevConsole. `state.view` để Dashboard mở đúng mục vừa bấm.
    navigate('/', { state: { fromDev: true, view: id } });
  }

  // Module "Pin lưu trữ" có thể bị ẩn riêng cho từng trạm — nếu người dùng
  // đang ở trang này rồi chuyển sang 1 trạm đã ẩn module này (module_visibility
  // đọc lại theo station?.id mỗi khi đổi trạm), tự điều hướng về Dashboard
  // thay vì tiếp tục hiển thị nội dung đáng lẽ đã ẩn.
  const batteryModuleHidden = !settings.loading && settings.moduleVisibility.battery === false;
  useEffect(() => {
    // `state: { fromDev: true }` giữ nguyên ý định "đang ở giao diện người
    // dùng" cho admin — thiếu cờ này, ProtectedRoute sẽ coi đây là điều
    // hướng "/" thông thường và tự bật lại quy tắc mặc định đưa admin về
    // DevConsole thay vì Dashboard.
    if (batteryModuleHidden) navigate('/', { replace: true, state: { fromDev: true } });
  }, [batteryModuleHidden, navigate]);

  if (stationLoading || !station || settings.loading || batteryModuleHidden) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'oklch(97% 0.005 240)', color: 'oklch(52% 0.02 240)', fontFamily: "'Manrope',sans-serif" }}>
        Đang tải…
      </div>
    );
  }

  const protectionMode = settings.activeBatteryMode;
  const batteryModes = settings.batteryModes;

  function selectMode(id) {
    settings.setActiveBatteryMode(id);
  }

  // Công suất pin ròng (kW) từ mỗi bản tin telemetry hôm nay: dương = đang
  // sạc (mặt trời dư so với tải), âm = đang xả (tải vượt công suất mặt trời).
  const netSeries = todayReadings.map((r) => ({
    ts: new Date(r.ts).getTime(),
    netKw: (r.solarKw ?? 0) - (r.loadW ?? 0) / 1000,
  }));
  const hasToday = netSeries.length > 0;

  // Gộp trung bình theo khung 2 giờ để vẽ biểu đồ cột.
  const buckets = HOUR_LABELS.map(() => ({ sum: 0, count: 0 }));
  for (const { ts, netKw } of netSeries) {
    const idx = Math.min(buckets.length - 1, Math.floor(new Date(ts).getHours() / 2));
    buckets[idx].sum += netKw;
    buckets[idx].count += 1;
  }
  const net = buckets.map((b) => (b.count ? +(b.sum / b.count).toFixed(2) : 0));
  const maxAbs = Math.max(...net.map((v) => Math.abs(v)), 0.1);
  const flowBars = net.map((v, i) => {
    const h = (Math.abs(v) / maxAbs) * 88;
    const isCharge = v >= 0;
    return {
      label: HOUR_LABELS[i],
      chargeBarStyle: {
        width: '100%', maxWidth: '22px', borderRadius: '4px 4px 0 0',
        height: (isCharge ? Math.max(2, h) : 0) + 'px',
        background: CHARGE_GREEN, opacity: isCharge ? 1 : 0,
      },
      dischargeBarStyle: {
        width: '100%', maxWidth: '22px', borderRadius: '0 0 4px 4px',
        height: (!isCharge ? Math.max(2, h) : 0) + 'px',
        background: DISCH_AMBER, opacity: !isCharge ? 1 : 0,
      },
    };
  });

  // Tổng năng lượng nạp/xả hôm nay = tích phân hình thang của công suất ròng
  // theo thời gian thực giữa các bản tin liên tiếp (bỏ qua khoảng trống >1h
  // để tránh sai lệch khi thiết bị mất kết nối giữa chừng).
  let totalCharge = 0, totalDischarge = 0;
  for (let i = 1; i < netSeries.length; i++) {
    const dtHours = (netSeries[i].ts - netSeries[i - 1].ts) / 3600000;
    if (dtHours <= 0 || dtHours > 1) continue;
    const avgNet = (netSeries[i].netKw + netSeries[i - 1].netKw) / 2;
    if (avgNet > 0) totalCharge += avgNet * dtHours;
    else totalDischarge += Math.abs(avgNet) * dtHours;
  }
  const peakCharge = Math.max(0, ...netSeries.map((s) => s.netKw));
  const peakDischarge = Math.abs(Math.min(0, ...netSeries.map((s) => s.netKw)));

  const nowNet = hasToday ? netSeries[netSeries.length - 1].netKw : null;
  const hasNow = nowNet != null;
  const charging = hasNow && station.status !== 'offline' && station.batteryPct < 99 && nowNet > 0;
  const flowDirWord = !hasNow ? '—' : charging ? 'nạp' : 'xả';
  const flowPowerLabel = hasNow ? Math.abs(nowNet).toFixed(2) : '--';
  let etaLabel;
  if (station.status === 'offline' || !hasNow) etaLabel = '—';
  else if (charging) etaLabel = `~${Math.max(0.3, (100 - station.batteryPct) / 100 * PACK_CAPACITY_KWH / nowNet).toFixed(1)} giờ đến đầy`;
  else etaLabel = `~${Math.max(0.3, station.batteryPct / 100 * PACK_CAPACITY_KWH / Math.max(0.05, Math.abs(nowNet))).toFixed(1)} giờ dự phòng`;

  const tempC = hasToday ? todayReadings[todayReadings.length - 1].tempC : null;

  const batteryDashOffset = (364.4 * (1 - station.batteryPct / 100)).toFixed(1);
  const batteryChargingLabel = charging ? 'Đang sạc' : (station.status === 'offline' || !hasNow) ? 'Không rõ' : 'Đang xả';

  // Trạng thái relay bảo vệ do thiết bị báo về (station.chargeEnabled/... —
  // migration 0012). undefined/null = trạm chưa có firmware hỗ trợ báo về →
  // hiển thị "Không rõ" thay vì khẳng định sai.
  const reasonLabel = PROTECT_REASON_LABELS[station.protectReason] ?? (station.protectReason || 'Bình thường');
  const protectRows = [
    { key: 'charge', label: 'Đường sạc', enabled: station.chargeEnabled },
    { key: 'discharge', label: 'Đường xả', enabled: station.dischargeEnabled },
  ].map((r) => {
    const known = r.enabled === true || r.enabled === false;
    return {
      ...r,
      known,
      stateLabel: !known ? 'Không rõ' : r.enabled ? 'Đang cho phép' : 'Đã ngắt',
      color: !known ? 'oklch(55% 0.02 240)' : r.enabled ? OK_GREEN : CUT_RED,
    };
  });
  const anyKnown = protectRows.some((r) => r.known);
  const anyCut = protectRows.some((r) => r.enabled === false);

  const cardStyle = { background: 'white', border: '1px solid oklch(91% 0.01 240)', borderRadius: '16px', padding: '24px', boxShadow: '0 1px 2px oklch(0% 0 0 / 0.04)' };

  const protectionModes = ['low', 'balanced', 'max'].map((id) => {
    const cfg = batteryModes[id];
    const isActive = protectionMode === id;
    return {
      id,
      label: MODE_LABELS[id],
      desc: cfg.desc,
      isActive,
      rangeLabel: cfg.minSoc + '% – ' + cfg.maxSoc + '%',
      cardStyle: {
        textAlign: 'left', cursor: 'pointer', borderRadius: '12px', padding: '16px',
        border: isActive ? '2px solid ' + BLUE : '1px solid oklch(91% 0.01 240)',
        background: isActive ? 'oklch(97% 0.02 240)' : 'white',
        display: 'flex', flexDirection: 'column', gap: '8px',
      },
      titleStyle: { fontSize: '14.5px', fontWeight: 700, color: isActive ? BLUE : 'oklch(24% 0.03 240)' },
    };
  });

  return (
    <AppShell
      activeNav="battery"
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
          <h1 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '26px', fontWeight: 700, margin: '0 0 4px', color: 'oklch(20% 0.03 240)' }}>Pin lưu trữ</h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13.5px', color: 'oklch(50% 0.02 240)', flexWrap: 'wrap' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: '8px', whiteSpace: 'nowrap' }}><span style={{ width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0, background: stationColor }} />{station.name} · {station.location}</span>
            <span style={{ whiteSpace: 'nowrap' }}>· BMS 100Ah / 48V</span>
          </div>
        </div>
      </div>

      {/* STATUS SUMMARY */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(340px,1.3fr) minmax(280px,1fr)', gap: '16px', marginBottom: '20px', alignItems: 'stretch' }}>
        <div style={{ background: 'white', border: '1px solid oklch(91% 0.01 240)', borderRadius: '16px', padding: '24px', boxShadow: '0 1px 2px oklch(0% 0 0 / 0.04)', display: 'flex', alignItems: 'center', gap: '24px', flexWrap: 'wrap' }}>
          <div style={{ position: 'relative', flexShrink: 0, width: '150px', height: '150px' }}>
            <svg width="150" height="150" viewBox="0 0 150 150">
              <circle cx="75" cy="75" r="58" fill="none" stroke="oklch(94% 0.008 240)" strokeWidth="14" />
              <circle cx="75" cy="75" r="58" fill="none" stroke={BLUE} strokeWidth="14" strokeLinecap="round" strokeDasharray="364.4" strokeDashoffset={batteryDashOffset} transform="rotate(-90 75 75)" />
            </svg>
            <div style={{ position: 'absolute', top: 0, left: 0, width: '150px', height: '150px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '4px', pointerEvents: 'none' }}>
              <div style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '30px', fontWeight: 700, color: 'oklch(20% 0.03 240)', lineHeight: 1 }}>{station.batteryPct}%</div>
              <div style={{ fontFamily: "'Manrope',sans-serif", fontSize: '12px', color: 'oklch(55% 0.02 240)' }}>{batteryChargingLabel}</div>
            </div>
          </div>
          <div style={{ flex: 1, minWidth: '180px' }}>
            <div style={{ fontSize: '13px', color: 'oklch(52% 0.02 240)', fontWeight: 600, marginBottom: '6px' }}>Trạng thái hiện tại</div>
            <div style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '24px', fontWeight: 700, color: charging ? 'oklch(50% 0.14 150)' : 'oklch(52% 0.13 70)' }}>{batteryChargingLabel}</div>
            <div style={{ fontSize: '13px', color: 'oklch(52% 0.02 240)', marginTop: '8px', lineHeight: 1.6 }}>
              Công suất {flowDirWord}: <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontWeight: 600, color: 'oklch(24% 0.03 240)' }}>{flowPowerLabel} kW</span><br />
              Thời gian còn lại (ước tính): <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontWeight: 600, color: 'oklch(24% 0.03 240)' }}>{etaLabel}</span>
            </div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
          <div style={{ background: 'white', border: '1px solid oklch(91% 0.01 240)', borderRadius: '14px', padding: '18px', boxShadow: '0 1px 2px oklch(0% 0 0 / 0.04)' }}>
            <div style={{ fontSize: '12.5px', color: 'oklch(52% 0.02 240)', fontWeight: 600, marginBottom: '10px' }}>Điện áp</div>
            <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '22px', fontWeight: 500 }}>{station.batteryVoltage.toFixed(1)}<span style={{ fontSize: '13px', color: 'oklch(55% 0.02 240)' }}>V</span></div>
          </div>
          <div style={{ background: 'white', border: '1px solid oklch(91% 0.01 240)', borderRadius: '14px', padding: '18px', boxShadow: '0 1px 2px oklch(0% 0 0 / 0.04)' }}>
            <div style={{ fontSize: '12.5px', color: 'oklch(52% 0.02 240)', fontWeight: 600, marginBottom: '10px' }}>Sức khỏe pin</div>
            <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '22px', fontWeight: 500, color: 'oklch(64% 0.15 150)' }}>96<span style={{ fontSize: '13px', color: 'oklch(55% 0.02 240)' }}>%</span></div>
          </div>
          <div style={{ background: 'white', border: '1px solid oklch(91% 0.01 240)', borderRadius: '14px', padding: '18px', boxShadow: '0 1px 2px oklch(0% 0 0 / 0.04)' }}>
            <div style={{ fontSize: '12.5px', color: 'oklch(52% 0.02 240)', fontWeight: 600, marginBottom: '10px' }}>Nhiệt độ</div>
            <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '22px', fontWeight: 500 }}>{tempC == null ? '--' : Math.round(tempC)}<span style={{ fontSize: '13px', color: 'oklch(55% 0.02 240)' }}>°C</span></div>
          </div>
          <div style={{ background: 'white', border: '1px solid oklch(91% 0.01 240)', borderRadius: '14px', padding: '18px', boxShadow: '0 1px 2px oklch(0% 0 0 / 0.04)' }}>
            <div style={{ fontSize: '12.5px', color: 'oklch(52% 0.02 240)', fontWeight: 600, marginBottom: '10px' }}>Chu kỳ sạc</div>
            <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '22px', fontWeight: 500 }}>214</div>
          </div>
        </div>
      </div>

      {/* CHARGE / DISCHARGE CHART */}
      <div style={{ ...cardStyle, marginBottom: '20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px', flexWrap: 'wrap', gap: '10px' }}>
          <h2 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '17px', fontWeight: 700, margin: 0 }}>Biểu đồ sạc / xả</h2>
          <div style={{ display: 'flex', gap: '16px', fontSize: '12px' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><span style={{ width: '10px', height: '10px', borderRadius: '3px', background: CHARGE_GREEN, display: 'inline-block' }} />Sạc (nạp vào pin)</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><span style={{ width: '10px', height: '10px', borderRadius: '3px', background: DISCH_AMBER, display: 'inline-block' }} />Xả (cấp cho tải)</span>
          </div>
        </div>
        <p style={{ fontSize: '12.5px', color: 'oklch(52% 0.02 240)', margin: '0 0 20px' }}>Công suất pin theo giờ hôm nay (kW) · trên trục = sạc, dưới trục = xả</p>

        {hasToday ? (
        <div style={{ display: 'flex', gap: '12px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', alignItems: 'flex-end', height: '210px', paddingBottom: '22px', fontFamily: "'IBM Plex Mono',monospace", fontSize: '10.5px', color: 'oklch(58% 0.02 240)' }}>
            <span>+{maxAbs.toFixed(1)}</span>
            <span>0</span>
            <span>−{maxAbs.toFixed(1)}</span>
          </div>
          <div style={{ flex: 1, position: 'relative' }}>
            <div style={{ position: 'absolute', left: 0, right: 0, top: '94px', height: '1px', background: 'oklch(80% 0.012 240)', zIndex: 1 }} />
            <div style={{ display: 'flex', alignItems: 'stretch', gap: '4px', height: '210px' }}>
              {flowBars.map((item, i) => (
                <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <div style={{ height: '94px', width: '100%', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
                    <div style={item.chargeBarStyle} />
                  </div>
                  <div style={{ height: '94px', width: '100%', display: 'flex', alignItems: 'flex-start', justifyContent: 'center' }}>
                    <div style={item.dischargeBarStyle} />
                  </div>
                  <div style={{ height: '22px', display: 'flex', alignItems: 'center', fontFamily: "'IBM Plex Mono',monospace", fontSize: '9.5px', color: 'oklch(58% 0.02 240)' }}>{item.label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
        ) : (
          <div style={{ height: '210px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '6px', color: 'oklch(58% 0.02 240)', background: 'oklch(98% 0.004 240)', borderRadius: '12px', border: '1px dashed oklch(88% 0.01 240)' }}>
            <div style={{ fontSize: '14px', fontWeight: 600 }}>Chưa có dữ liệu telemetry hôm nay</div>
            <div style={{ fontSize: '12px' }}>Biểu đồ sẽ hiển thị khi thiết bị gửi dữ liệu về.</div>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: '12px', marginTop: '20px' }}>
          <div style={{ textAlign: 'center', padding: '12px', background: 'oklch(97% 0.005 240)', borderRadius: '10px' }}>
            <div style={{ fontSize: '11.5px', color: 'oklch(52% 0.02 240)' }}>Tổng nạp hôm nay</div>
            <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '16px', fontWeight: 600, color: CHARGE_GREEN, marginTop: '4px' }}>{totalCharge.toFixed(1)} kWh</div>
          </div>
          <div style={{ textAlign: 'center', padding: '12px', background: 'oklch(97% 0.005 240)', borderRadius: '10px' }}>
            <div style={{ fontSize: '11.5px', color: 'oklch(52% 0.02 240)' }}>Tổng xả hôm nay</div>
            <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '16px', fontWeight: 600, color: 'oklch(60% 0.15 70)', marginTop: '4px' }}>{totalDischarge.toFixed(1)} kWh</div>
          </div>
          <div style={{ textAlign: 'center', padding: '12px', background: 'oklch(97% 0.005 240)', borderRadius: '10px' }}>
            <div style={{ fontSize: '11.5px', color: 'oklch(52% 0.02 240)' }}>Đỉnh nạp</div>
            <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '16px', fontWeight: 600, marginTop: '4px' }}>{peakCharge.toFixed(1)} kW</div>
          </div>
          <div style={{ textAlign: 'center', padding: '12px', background: 'oklch(97% 0.005 240)', borderRadius: '10px' }}>
            <div style={{ fontSize: '11.5px', color: 'oklch(52% 0.02 240)' }}>Đỉnh xả</div>
            <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '16px', fontWeight: 600, marginTop: '4px' }}>{peakDischarge.toFixed(1)} kW</div>
          </div>
        </div>
      </div>

      {/* CHARGE / DISCHARGE CUTOFF STATUS */}
      <div style={{ ...cardStyle, marginBottom: '20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', marginBottom: '4px' }}>
          <h2 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '17px', fontWeight: 700, margin: 0 }}>Điều khiển bảo vệ sạc / xả</h2>
          <span style={{ fontSize: '11.5px', fontWeight: 700, padding: '3px 10px', borderRadius: '20px', whiteSpace: 'nowrap',
            color: !anyKnown ? 'oklch(50% 0.02 240)' : anyCut ? CUT_RED : OK_GREEN,
            background: !anyKnown ? 'oklch(95% 0.006 240)' : anyCut ? 'oklch(93% 0.06 25)' : 'oklch(93% 0.06 150)' }}>
            {!anyKnown ? 'Chưa có dữ liệu' : reasonLabel}
          </span>
        </div>
        <p style={{ fontSize: '12.5px', color: 'oklch(52% 0.02 240)', margin: '0 0 18px' }}>Thiết bị tự đóng/cắt relay đường sạc và đường xả theo ngưỡng của mode đang chọn (có hysteresis), ngay tại chỗ nên vẫn bảo vệ khi mất kết nối. Trạng thái dưới đây do thiết bị báo về.</p>
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '14px' }}>
          {protectRows.map((r) => (
            <div key={r.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '16px', borderRadius: '12px', border: '1px solid oklch(91% 0.01 240)', background: 'oklch(98% 0.004 240)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{ width: '10px', height: '10px', borderRadius: '50%', flexShrink: 0, background: r.color }} />
                <span style={{ fontSize: '14px', fontWeight: 600, color: 'oklch(24% 0.03 240)' }}>{r.label}</span>
              </div>
              <span style={{ fontSize: '13px', fontFamily: "'IBM Plex Mono',monospace", fontWeight: 600, color: r.color }}>{r.stateLabel}</span>
            </div>
          ))}
        </div>
        {!anyKnown && (
          <p style={{ fontSize: '11.5px', color: 'oklch(58% 0.02 240)', margin: '14px 0 0' }}>Trạm này chưa có thiết bị chạy firmware hỗ trợ báo trạng thái bảo vệ. Cập nhật firmware (xem docs/IOT.md) để bật điều khiển ngắt sạc/xả thực tế.</p>
        )}
      </div>

      {/* BATTERY PROTECTION MODE */}
      <div style={{ ...cardStyle, marginBottom: '40px' }}>
        <h2 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '17px', fontWeight: 700, margin: '0 0 4px' }}>Chế độ bảo vệ pin</h2>
        <p style={{ fontSize: '12.5px', color: 'oklch(52% 0.02 240)', margin: '0 0 18px' }}>Chọn mức độ bảo vệ phù hợp với nhu cầu sử dụng. Ngưỡng kỹ thuật chi tiết của từng mức do quản trị viên hệ thống cấu hình.</p>

        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)', gap: '14px' }}>
          {protectionModes.map((m) => (
            <div key={m.id} onClick={() => selectMode(m.id)} style={m.cardStyle}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                <span style={m.titleStyle}>{m.label}</span>
                {m.isActive && (
                  <span style={{ fontSize: '10.5px', fontWeight: 700, color: 'white', background: BLUE, padding: '2px 8px', borderRadius: '20px', flexShrink: 0, whiteSpace: 'nowrap' }}>Đang dùng</span>
                )}
              </div>
              <p style={{ fontSize: '12.5px', color: 'oklch(50% 0.02 240)', margin: 0, lineHeight: 1.5, flex: 1 }}>{m.desc}</p>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11.5px', color: 'oklch(52% 0.02 240)', paddingTop: '8px', borderTop: '1px solid oklch(95% 0.006 240)' }}>
                <span>SOC vận hành</span>
                <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontWeight: 600 }}>{m.rangeLabel}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </AppShell>
  );
}
