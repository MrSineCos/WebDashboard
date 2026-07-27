// Telemetry ingestion endpoint.
//
// Called by the AWS IoT Core Rules Engine (HTTPS action), NOT by browsers.
// The Rule attaches `Authorization: Bearer <INGEST_SHARED_SECRET>` and posts the
// message payload. We authenticate the caller by that shared secret, map the
// device's AWS client id to a `devices` row, then insert one `telemetry` row
// using the service role (which bypasses RLS). A DB trigger updates the station
// snapshot and device liveness.
//
// Deploy:  supabase functions deploy ingest-telemetry --no-verify-jwt
// Secrets: supabase secrets set INGEST_SHARED_SECRET=... SERVICE_ROLE_KEY=...
//   (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically on the
//    hosted platform; we read a self-set SERVICE_ROLE_KEY as a fallback for
//    local `supabase functions serve`.)

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SERVICE_ROLE_KEY")!;
const INGEST_SHARED_SECRET = Deno.env.get("INGEST_SHARED_SECRET")!;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Fields a device may report. Everything else in the payload lands in `extra`.
const NUMERIC_FIELDS = [
  "solar_kw",
  "battery_pct",
  "battery_voltage",
  "battery_current",
  "load_w",
  "temp_c",
  "rssi",
] as const;

// Battery-protection state a device reports alongside telemetry (see the
// firmware protection loop + migration 0012). Booleans/string, so they're
// handled separately from NUMERIC_FIELDS.
const BOOL_FIELDS = ["charge_enabled", "discharge_enabled"] as const;
const STRING_FIELDS = ["protect_reason"] as const;

// SoftAP credentials the device broadcasts locally (migration 0014). These are
// the device's own truth, not a cloud setting — the dashboard only mirrors
// them. They go to `devices` (a snapshot), never to `telemetry`: the value
// barely changes, so copying it into every time-series row would be waste.
// Firmware only sends these on (re)connect, so most messages omit them.
const AP_FIELDS = ["ap_ssid", "ap_password"] as const;

// 802.11 / WPA2 limits. A device reporting something outside these can't
// actually be broadcasting it, so we treat the value as garbage rather than
// storing a password the user would type in and fail with.
const AP_SSID_MAX_BYTES = 32;
const AP_PASSWORD_MIN = 8;
const AP_PASSWORD_MAX = 63;

// Firmware version + OTA progress the device reports (migration 0015). Like
// the AP fields these are the device's own truth and live on `devices`, not on
// every `telemetry` row. Firmware sends `fw_version` on (re)connect; the
// `fw_status*` pair only while an OTA push is in flight.
const FW_FIELDS = ["fw_version", "fw_status", "fw_status_detail"] as const;

// Statuses a DEVICE may report. 'pending' is deliberately absent: it means
// "cloud has published the OTA command but the device hasn't spoken since"
// and is set only by send-ota-command. Letting a device claim 'pending' would
// let it erase evidence that it never picked the update up.
const DEVICE_FW_STATUSES = new Set([
  "idle",
  "downloading",
  "applying",
  "success",
  "failed",
]);

// Statuses meaning "an OTA is still in flight" — used to decide whether a
// version report finishes it (see section 8).
const FW_IN_FLIGHT = new Set(["pending", "downloading", "applying"]);

const FW_VERSION_MAX = 64;
const FW_DETAIL_MAX = 200;

function validApReport(ssid: unknown, password: unknown): boolean {
  if (typeof ssid !== "string" || typeof password !== "string") return false;
  if (ssid.length === 0) return false;
  if (new TextEncoder().encode(ssid).length > AP_SSID_MAX_BYTES) return false;
  return password.length >= AP_PASSWORD_MIN && password.length <= AP_PASSWORD_MAX;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  // 1. Parse payload first — AWS IoT sends a one-time confirmation request when
  //    you register this URL as an HTTP topic-rule destination. That request has
  //    no Bearer header, so we must handle it before the auth check.
  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  // AWS IoT topic-rule-destination confirmation. The body carries an `enableUrl`
  // (and `confirmationToken`). We log the enableUrl so you can open it once in a
  // browser to activate the destination. See docs/IOT.md.
  const enableUrl = (payload.enableUrl ?? payload.confirmationUrl) as
    | string
    | undefined;
  if (enableUrl || payload.confirmationToken) {
    console.log("AWS IoT destination confirmation. Open this URL once to enable:", enableUrl);
    return json({ ok: true, action: "confirmation_received", enableUrl });
  }

  // 2. Authenticate the caller (the AWS IoT Rule) for real telemetry messages.
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!INGEST_SHARED_SECRET || token !== INGEST_SHARED_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }

  const clientId =
    (payload.client_id as string) ?? (payload.thing_name as string) ?? "";
  if (!clientId) {
    return json({ error: "missing_client_id" }, 400);
  }

  // 3. Map the device by its AWS thing name.
  const { data: device, error: deviceErr } = await admin
    .from("devices")
    .select(
      "id, station_id, owner_id, ap_ssid, ap_password, fw_version, fw_status, fw_target_id",
    )
    .eq("aws_thing_name", clientId)
    .maybeSingle();

  if (deviceErr) {
    return json({ error: "lookup_failed" }, 500);
  }
  if (!device) {
    return json({ error: "unknown_device" }, 403);
  }

  // 4. Build the telemetry row. Known numeric fields become columns; the rest
  //    of the payload (minus routing/reserved keys) is kept in `extra`.
  const row: Record<string, unknown> = {
    device_id: device.id,
    station_id: device.station_id,
    owner_id: device.owner_id,
  };

  const tsRaw = payload.ts;
  if (typeof tsRaw === "number") {
    // AWS timestamp() is epoch milliseconds.
    row.ts = new Date(tsRaw).toISOString();
  } else if (typeof tsRaw === "string") {
    row.ts = tsRaw;
  }

  for (const field of NUMERIC_FIELDS) {
    const v = payload[field];
    if (typeof v !== "number") continue;
    // `battery_pct` is an `integer` column; PostgREST rejects a JSON value
    // with a decimal point outright (no implicit rounding), so a device
    // reporting e.g. 69.9 would fail the insert.
    row[field] = field === "battery_pct" ? Math.round(v) : v;
  }

  for (const field of BOOL_FIELDS) {
    if (typeof payload[field] === "boolean") row[field] = payload[field];
  }
  for (const field of STRING_FIELDS) {
    if (typeof payload[field] === "string") row[field] = payload[field];
  }

  const reserved = new Set([
    "client_id",
    "thing_name",
    "ts",
    "topic",
    "loads",
    ...AP_FIELDS,
    ...FW_FIELDS,
    ...NUMERIC_FIELDS,
    ...BOOL_FIELDS,
    ...STRING_FIELDS,
  ]);
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (!reserved.has(k)) extra[k] = v;
  }
  if (Object.keys(extra).length > 0) row.extra = extra;

  // 5. Insert. The `telemetry_apply` trigger updates stations + devices.
  const { error: insertErr } = await admin.from("telemetry").insert(row);
  if (insertErr) {
    return json({ error: "insert_failed", detail: insertErr.message }, 500);
  }

  // 6. Optional load-state ack: firmware that switches relays for one or
  // more loads (see send-load-command) may report their actual state back
  // in the same telemetry message as `"loads": {"<load_id>": "on"|"off"}`.
  // We use the service role here (same as everywhere in this function) —
  // this is the one path allowed to write `loads.reported_state` (see the
  // `loads_protect_reported_columns` trigger, migration 0010).
  const loadsAck = payload.loads;
  if (loadsAck && typeof loadsAck === "object") {
    const now = new Date().toISOString();
    for (const [loadId, state] of Object.entries(loadsAck as Record<string, unknown>)) {
      if (state !== "on" && state !== "off") continue;
      await admin
        .from("loads")
        .update({ reported_state: state === "on", reported_at: now })
        .eq("id", loadId)
        .eq("device_id", device.id);
    }
  }

  // 7. Optional SoftAP report (migration 0014). Firmware sends `ap_ssid` +
  // `ap_password` on its first publish after each (re)connect, so the
  // dashboard shows the network the device is really broadcasting. Skipped
  // when unchanged to avoid a write every reconnect.
  if (AP_FIELDS.some((f) => f in payload)) {
    const ssid = payload.ap_ssid;
    const password = payload.ap_password;
    if (!validApReport(ssid, password)) {
      // Don't fail the whole request — telemetry already landed and is the
      // more important payload; a bad AP report is worth a log, not a 500.
      console.warn(`ignoring invalid ap report from ${clientId}`);
    } else if (ssid !== device.ap_ssid || password !== device.ap_password) {
      await admin
        .from("devices")
        .update({
          ap_ssid: ssid,
          ap_password: password,
          ap_reported_at: new Date().toISOString(),
        })
        .eq("id", device.id);
    }
  }

  // 8. Optional firmware report (migration 0015) — the return leg of the OTA
  // flow started by send-ota-command. Two independent things a device may
  // send: `fw_version` (what it is ACTUALLY running) and `fw_status` +
  // `fw_status_detail` (how the last OTA attempt is going). This is the only
  // path that writes them — `devices` has no client update policy (0003), so
  // a user can never claim their device is on a build it isn't.
  if (FW_FIELDS.some((f) => f in payload)) {
    const patch: Record<string, unknown> = {};
    const now = new Date().toISOString();

    if ("fw_version" in payload) {
      const raw = payload.fw_version;
      const version = typeof raw === "string" ? raw.trim() : "";
      if (!version || version.length > FW_VERSION_MAX) {
        // Same policy as the AP report: telemetry already landed and matters
        // more, so a garbage version is worth a log, not a 500.
        console.warn(`ignoring invalid fw_version from ${clientId}`);
      } else if (version !== device.fw_version) {
        // Only on change — a device republishes its version on every
        // reconnect, and `fw_reported_at` is more useful as "when this build
        // started running" than as a duplicate of `last_seen_at`.
        patch.fw_version = version;
        patch.fw_reported_at = now;
      }
    }

    if ("fw_status" in payload) {
      const status = payload.fw_status;
      if (typeof status !== "string" || !DEVICE_FW_STATUSES.has(status)) {
        console.warn(`ignoring invalid fw_status from ${clientId}`);
      } else {
        patch.fw_status = status;
        patch.fw_status_at = now;
        // Detail belongs to the status it arrived with, so it is rewritten
        // (or cleared) every time — otherwise the reason for an old failure
        // would linger next to a fresh 'downloading'.
        const detail = payload.fw_status_detail;
        patch.fw_status_detail =
          typeof detail === "string" && detail.trim()
            ? detail.trim().slice(0, FW_DETAIL_MAX)
            : null;
      }
    }

    // Minimal firmware may only ever report `fw_version` and never a status.
    // If the version we just heard equals the version of the release that was
    // pushed, the update plainly succeeded — record that instead of leaving
    // `fw_status` stuck at 'pending' forever. Costs one extra query, and only
    // while an OTA is actually in flight.
    const version = (patch.fw_version as string | undefined) ?? device.fw_version;
    const status = (patch.fw_status as string | undefined) ?? device.fw_status;
    if (device.fw_target_id && version && FW_IN_FLIGHT.has(status)) {
      const { data: target } = await admin
        .from("firmware_releases")
        .select("version")
        .eq("id", device.fw_target_id)
        .maybeSingle();
      if (target?.version === version) {
        patch.fw_status = "success";
        patch.fw_status_detail = null;
        patch.fw_status_at = now;
      }
    }

    // `fw_target_id` is intentionally left alone: it records which release was
    // pushed, and the dashboard compares it against `fw_version` to tell a
    // finished update from one the device silently ignored.
    if (Object.keys(patch).length > 0) {
      await admin.from("devices").update(patch).eq("id", device.id);
    }
  }

  return json({ ok: true });
});
