import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { isElectron } from './supabaseClient.js';

const DEFAULT_DEVICE_URL = 'http://192.168.4.1';
const DEVICE_URL = (import.meta.env.VITE_LOCAL_DEVICE_URL || DEFAULT_DEVICE_URL).replace(/\/$/, '');
const TELEMETRY_URL = `${DEVICE_URL}/api/telemetry`;
const DEVICE_MAP_KEY = 'solgrid.local.device-station-map.v1';
const CONNECTED_POLL_MS = 1000;
const DISCONNECTED_POLL_MS = 4000;
const REQUEST_TIMEOUT_MS = 2200;
const MAX_LOCAL_HISTORY = 3600;

const LocalConnectionContext = createContext(null);

function readDeviceMap() {
  try {
    const value = JSON.parse(localStorage.getItem(DEVICE_MAP_KEY) || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function sameStringArray(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function validSnapshot(value) {
  return value && value.mode === 'local' && typeof value.device === 'string' && value.device.length > 0;
}

export function localSnapshotToReading(snapshot) {
  if (!snapshot) return null;
  return {
    id: `local:${snapshot.device}:${snapshot.receivedAt}`,
    ts: snapshot.receivedAt,
    solarKw: Number(snapshot.solar_kw),
    batteryPct: Number(snapshot.battery_pct),
    batteryVoltage: Number(snapshot.battery_voltage),
    batteryCurrent: Number(snapshot.battery_current),
    loadW: Number(snapshot.load_w),
    tempC: Number(snapshot.temp_c),
    rssi: Number(snapshot.rssi),
    uptimeS: Number(snapshot.uptime_s),
    bootCount: Number(snapshot.boot_count),
    extra: {
      source: 'local',
      pv_voltage: Number(snapshot.pv_voltage),
      pv_current: Number(snapshot.pv_current),
      stm32_link: Boolean(snapshot.stm32_link),
    },
  };
}

export function LocalConnectionProvider({ children }) {
  const [snapshot, setSnapshot] = useState(null);
  const [history, setHistory] = useState([]);
  const [connected, setConnected] = useState(false);
  const [lastError, setLastError] = useState('');
  const [deviceStationMap, setDeviceStationMap] = useState(readDeviceMap);
  const [knownStationIds, setKnownStationIds] = useState([]);
  const failureCount = useRef(0);
  const lastDevice = useRef(null);

  // Bản web đã deploy chạy HTTPS nên trình duyệt sẽ chặn endpoint HTTP của
  // ESP32. App Windows dùng origin HTTP loopback; localhost dev cũng dùng HTTP
  // và đều có thể truy cập nhờ CORS/PNA header do firmware trả về.
  const canProbe = isElectron || window.location.protocol === 'http:';

  useEffect(() => {
    if (!canProbe) return undefined;
    let stopped = false;
    let timer = null;
    let controller = null;

    async function poll() {
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let nextDelay = DISCONNECTED_POLL_MS;
      try {
        const response = await fetch(TELEMETRY_URL, {
          cache: 'no-store',
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!validSnapshot(data)) throw new Error('invalid_local_payload');
        if (stopped) return;

        const next = { ...data, receivedAt: new Date().toISOString() };
        const deviceChanged = lastDevice.current && lastDevice.current !== next.device;
        lastDevice.current = next.device;
        failureCount.current = 0;
        setSnapshot(next);
        setConnected(true);
        setLastError('');
        setHistory((previous) => {
          const base = deviceChanged ? [] : previous;
          return [...base, next].slice(-MAX_LOCAL_HISTORY);
        });
        nextDelay = CONNECTED_POLL_MS;
      } catch (error) {
        if (stopped) return;
        failureCount.current += 1;
        setLastError(error?.name === 'AbortError' ? 'timeout' : String(error?.message || error));
        // Hai request hụt liên tiếp mới đổi nguồn để tránh giao diện chớp khi
        // radio ESP32 bận một nhịp MQTT/UART ngắn.
        if (failureCount.current >= 2) setConnected(false);
      } finally {
        window.clearTimeout(timeout);
        if (!stopped) timer = window.setTimeout(poll, nextDelay);
      }
    }

    poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      controller?.abort();
    };
  }, [canProbe]);

  const rememberDevices = useCallback((devices) => {
    if (!Array.isArray(devices) || devices.length === 0) return;
    setDeviceStationMap((previous) => {
      const next = { ...previous };
      let changed = false;
      devices.forEach((device) => {
        if (!device?.aws_thing_name || !device?.station_id) return;
        if (next[device.aws_thing_name] !== device.station_id) {
          next[device.aws_thing_name] = device.station_id;
          changed = true;
        }
      });
      if (!changed) return previous;
      localStorage.setItem(DEVICE_MAP_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const rememberStations = useCallback((stations) => {
    const ids = (stations || []).map((station) => station.id).filter(Boolean).sort();
    setKnownStationIds((previous) => (sameStringArray(previous, ids) ? previous : ids));
  }, []);

  const localStationId = useMemo(() => {
    if (!snapshot) return null;
    return deviceStationMap[snapshot.device]
      || (knownStationIds.length === 1 ? knownStationIds[0] : null)
      || `local:${snapshot.device}`;
  }, [snapshot, deviceStationMap, knownStationIds]);

  const value = useMemo(() => ({
    connected,
    snapshot,
    history,
    endpoint: DEVICE_URL,
    lastError,
    localStationId,
    rememberDevices,
    rememberStations,
  }), [connected, snapshot, history, lastError, localStationId, rememberDevices, rememberStations]);

  return <LocalConnectionContext.Provider value={value}>{children}</LocalConnectionContext.Provider>;
}

export function useLocalConnection() {
  const context = useContext(LocalConnectionContext);
  if (!context) throw new Error('useLocalConnection must be used within LocalConnectionProvider');
  return context;
}

export function LocalConnectionBanner({ dark = false, stationId = null }) {
  const { connected, snapshot, endpoint, localStationId } = useLocalConnection();
  if (!connected || !snapshot || (stationId && stationId !== localStationId)) return null;

  const colors = dark
    ? { background: 'oklch(24% 0.055 155)', border: 'oklch(47% 0.11 155)', title: 'oklch(86% 0.11 155)', text: 'oklch(75% 0.035 155)' }
    : { background: 'oklch(96% 0.035 155)', border: 'oklch(82% 0.09 155)', title: 'oklch(38% 0.12 155)', text: 'oklch(45% 0.045 155)' };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '11px 14px', marginBottom: '18px', borderRadius: '10px', background: colors.background, border: `1px solid ${colors.border}`, color: colors.text, fontSize: '12.5px', lineHeight: 1.45 }}>
      <span style={{ width: '9px', height: '9px', borderRadius: '50%', flexShrink: 0, background: 'oklch(67% 0.17 155)', boxShadow: '0 0 0 4px oklch(67% 0.17 155 / 0.16)' }} />
      <div>
        <strong style={{ color: colors.title }}>Kết nối cục bộ với {snapshot.device}</strong>
        {' · '}Dữ liệu đang đi trực tiếp từ ESP32 vào app qua {endpoint}.
        {!snapshot.mqtt_connected && ' Cloud đang ngoại tuyến; các thao tác cần Internet có thể không thực hiện được.'}
      </div>
    </div>
  );
}
