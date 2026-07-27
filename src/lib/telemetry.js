import { useEffect, useState } from 'react';
import { supabase } from './supabaseClient.js';
import { useAuth } from './AuthContext.jsx';

function mapRow(row) {
  return {
    id: row.id,
    ts: row.ts,
    solarKw: row.solar_kw,
    batteryPct: row.battery_pct,
    batteryVoltage: row.battery_voltage,
    loadW: row.load_w,
    tempC: row.temp_c,
    rssi: row.rssi,
    extra: row.extra || {},
  };
}

// Recent telemetry for one station, oldest-first (chart-ready), plus a live
// subscription so new device readings append without a refresh. RLS scopes
// rows to the signed-in owner; devices never write through this client.
export function useTelemetry(stationId, { limit = 60 } = {}) {
  const { user } = useAuth();
  const [readings, setReadings] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user || !stationId) {
      setReadings([]);
      setLoading(false);
      return;
    }
    let cancelled = false;

    async function load() {
      setLoading(true);
      const { data } = await supabase
        .from('telemetry')
        .select('*')
        .eq('station_id', stationId)
        .order('ts', { ascending: false })
        .limit(limit);
      if (cancelled) return;
      // Reverse to oldest-first for time-series rendering.
      setReadings((data || []).map(mapRow).reverse());
      setLoading(false);
    }

    load();

    // Realtime: append inserts for this station, keeping the window bounded.
    const channel = supabase
      .channel(`telemetry:${stationId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'telemetry', filter: `station_id=eq.${stationId}` },
        (payload) => {
          setReadings((prev) => [...prev, mapRow(payload.new)].slice(-limit));
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [user, stationId, limit]);

  const latest = readings.length ? readings[readings.length - 1] : null;

  return { readings, latest, loading };
}

// All telemetry since local midnight for one station, oldest-first, with a
// live subscription — used for "today" charge/discharge charts where a
// fixed-count window (useTelemetry's `limit`) wouldn't cover a full day.
export function useTelemetryToday(stationId) {
  const { user } = useAuth();
  const [readings, setReadings] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user || !stationId) {
      setReadings([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    async function load() {
      setLoading(true);
      const { data } = await supabase
        .from('telemetry')
        .select('*')
        .eq('station_id', stationId)
        .gte('ts', startOfDay.toISOString())
        .order('ts', { ascending: true })
        .limit(10000);
      if (cancelled) return;
      setReadings((data || []).map(mapRow));
      setLoading(false);
    }

    load();

    const channel = supabase
      .channel(`telemetry-today:${stationId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'telemetry', filter: `station_id=eq.${stationId}` },
        (payload) => {
          const row = mapRow(payload.new);
          if (new Date(row.ts) >= startOfDay) {
            setReadings((prev) => [...prev, row]);
          }
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [user, stationId]);

  return { readings, loading };
}

function mapDailyRow(row) {
  return { day: row.day, solarKwh: Number(row.solar_kwh) || 0, loadKwh: Number(row.load_kwh) || 0 };
}

// Per-day kWh for the last `days` calendar days (Asia/Ho_Chi_Minh), computed
// server-side by the `station_daily_energy` RPC (see migration 0005) so the
// client never has to pull raw telemetry to build the Reports chart.
export function useDailyEnergy(stationId, days = 14) {
  const { user } = useAuth();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user || !stationId) {
      setRows([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    supabase
      .rpc('station_daily_energy', { p_station_id: stationId, p_days: days })
      .then(({ data }) => {
        if (cancelled) return;
        setRows((data || []).map(mapDailyRow));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user, stationId, days]);

  return { rows, loading };
}

function mapHourlyRow(row) {
  return {
    hour: row.hour,
    avgSolarW: row.avg_solar_w == null ? null : Number(row.avg_solar_w),
    avgLoadW: row.avg_load_w == null ? null : Number(row.avg_load_w),
    avgBatteryVoltage: row.avg_battery_voltage == null ? null : Number(row.avg_battery_voltage),
  };
}

// Hourly averages (solar/load power, battery voltage) for one calendar day,
// via the `station_hourly_energy` RPC — backs the "selected day" chart.
export function useHourlyEnergy(stationId, day) {
  const { user } = useAuth();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user || !stationId || !day) {
      setRows([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    supabase
      .rpc('station_hourly_energy', { p_station_id: stationId, p_day: day })
      .then(({ data }) => {
        if (cancelled) return;
        setRows((data || []).map(mapHourlyRow));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user, stationId, day]);

  return { rows, loading };
}

// Devices registered under the signed-in owner. Reads are direct (RLS:
// select-own); telemetry writes still only ever happen server-side via the
// service role. `registerDevice`/`removeDevice` are the two client-writable
// paths — both go through security-definer RPCs (migrations 0008 and 0011)
// that re-check ownership themselves, since `devices` has no client
// insert/delete policy.
export function useDevices() {
  const { user } = useAuth();
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      const { data } = await supabase
        .from('devices')
        .select('*')
        .order('created_at');
      if (cancelled) return;
      setDevices(data || []);
      setLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [user]);

  async function registerDevice({ stationId, name, type, awsThingName }) {
    const { data, error } = await supabase.rpc('register_device', {
      p_station_id: stationId,
      p_name: name,
      p_type: type,
      p_aws_thing_name: awsThingName,
    });
    if (error) return { error };
    setDevices((prev) => [...prev, data]);
    return { data };
  }

  async function removeDevice(id) {
    const { error } = await supabase.rpc('delete_device', { p_device_id: id });
    if (error) return { error };
    setDevices((prev) => prev.filter((d) => d.id !== id));
    return {};
  }

  // Mints a fresh AWS IoT X.509 cert for one device and returns the blocks to
  // paste into firmware (Amazon Root CA, device cert, private key + endpoint).
  // The private key is generated server-side and returned ONCE — it is never
  // stored (see supabase/functions/provision-device). Each call creates a NEW
  // cert on AWS; earlier certs stay attached to the thing until pruned there.
  // On a non-2xx response, supabase.functions.invoke returns a FunctionsHttpError
  // and leaves `data` null — the JSON body (our { error, detail }) lives on
  // error.context (a Response). Pull the detail out so callers see the real AWS
  // error ("AccessDenied", "Region is missing"...) instead of a generic failure.
  async function invokeProvision(body) {
    const { data, error } = await supabase.functions.invoke('provision-device', { body });
    if (error) {
      let detail = error.message;
      try {
        const parsed = await error.context?.json?.();
        if (parsed?.detail || parsed?.error) detail = parsed.detail || parsed.error;
      } catch { /* body not JSON — keep error.message */ }
      return { error: new Error(detail) };
    }
    if (data?.error) return { error: new Error(data.detail || data.error) };
    return { data };
  }

  async function provisionDevice(id) {
    return invokeProvision({ device_id: id });
  }

  // Read-only: which certs are already attached to this device's thing on AWS
  // (id/status/created at + the certificate PEM itself — public info, safe to
  // re-show). Never returns a private key; AWS only hands that back once, at
  // creation time (see provisionDevice above).
  async function listDeviceCertificates(id) {
    return invokeProvision({ device_id: id, action: 'list' });
  }

  return { devices, registerDevice, removeDevice, provisionDevice, listDeviceCertificates, loading };
}
