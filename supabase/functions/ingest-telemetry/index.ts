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
  // Hardware diagnostics (migration 0017). Note `temp_c` above is the battery
  // pack temperature the Battery page reads — a different quantity.
  "uptime_s",
  "boot_count",
] as const;

// Reported by devices but deliberately not stored anywhere (migration 0029
// dropped the column). Listed here — rather than just left out — so that units
// still running pre-0029 firmware have the field DISCARDED instead of quietly
// piling up inside `extra`, which is a jsonb column written every 10 seconds.
// Remove an entry once no device in the field can still send it.
const IGNORED_FIELDS = ["mcu_temp_c"] as const;

// integer/bigint columns. PostgREST rejects a JSON value with a decimal point
// outright (no implicit rounding), so a device reporting e.g. 69.9 for an
// integer column would fail the whole insert — round before sending.
// `rssi` belongs here too: it has always been an `integer` column (0003), so a
// device reporting -58.5 used to take the entire telemetry message down.
const INTEGER_FIELDS = new Set([
  "battery_pct",
  "rssi",
  "uptime_s",
  "boot_count",
]);

// Counters cannot be negative. A negative value means the firmware is broken
// (or an unsigned value overflowed on the way here), so drop that one field
// rather than put a nonsense number on the diagnostics panel.
const NON_NEGATIVE_FIELDS = new Set(["uptime_s", "boot_count"]);

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

// Firmware version + OTA progress the device reports (migrations 0015 + 0033). Like
// the AP fields these are the device's own truth and live on `devices`, not on
// every `telemetry` row. Firmware sends `fw_version` on (re)connect; the
// `fw_status*` + `fw_progress` only while an OTA push is in flight.
const FW_FIELDS = ["fw_version", "fw_status", "fw_status_detail", "fw_progress"] as const;

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

const CONFIG_ACK_STATUSES = new Set([
  "received",
  "applying",
  "applied",
  "already_applied",
  "rejected",
  "timeout",
]);

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

// Nhật ký hệ thống (migration 0018). Chỉ ghi những sự kiện RỜI RẠC — tuyệt đối
// không ghi mỗi bản tin telemetry: chu kỳ ~10 giây nghĩa là 8.640 dòng/ngày/
// thiết bị, tức nhật ký sẽ tốn chỗ hơn cả dữ liệu mà nó mô tả.
//
// Lỗi ghi log không được làm hỏng lượt ingest: telemetry mới là payload quan
// trọng và nó đã vào bảng rồi khi hàm này được gọi.
async function logEvent(
  ownerId: string,
  stationId: string | null,
  deviceId: string | null,
  level: "info" | "warn" | "error",
  event: string,
  message: string,
  meta: Record<string, unknown> = {},
) {
  const { error } = await admin.from("system_logs").insert({
    owner_id: ownerId,
    station_id: stationId,
    device_id: deviceId,
    level,
    source: "ingest",
    event,
    message,
    meta,
  });
  if (error) console.error("system_logs insert failed:", error.message);
}

// Biến thể có chặn tần suất (migration 0030 mục 2), cho những sự kiện mà THIẾT
// BỊ quyết định tần suất chứ không phải ta: firmware hỏng gửi sai định dạng
// hoặc gửi số âm thì nó gửi lại đúng như thế mỗi 10 giây. Ghi thẳng là 8.640
// dòng/ngày cho một thiết bị hỏng, đẩy mọi sự kiện khác ra khỏi tầm nhìn.
//
// Cửa sổ mặc định 60 phút: đủ thưa để nhật ký còn đọc được, đủ dày để một lỗi
// kéo dài vẫn hiện lại đều đặn thay vì chỉ có đúng một dòng từ hôm kia.
async function logEventThrottled(
  ownerId: string,
  stationId: string | null,
  deviceId: string | null,
  level: "info" | "warn" | "error",
  event: string,
  message: string,
  meta: Record<string, unknown> = {},
  windowMinutes = 60,
) {
  const { error } = await admin.rpc("log_event_throttled", {
    p_owner_id: ownerId,
    p_level: level,
    p_event: event,
    p_message: message,
    p_station_id: stationId,
    p_device_id: deviceId,
    p_meta: meta,
    p_source: "ingest",
    p_window: `${windowMinutes} minutes`,
  });
  if (error) console.error("log_event_throttled failed:", error.message);
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
      "id, name, station_id, owner_id, ap_ssid, ap_password, fw_version, fw_status, fw_target_id, " +
        "config_id_desired, config_version_desired, config_hash_desired, " +
        "config_sync_status, config_version_applied, config_hash_applied",
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

  // Trường bị loại vì sai định dạng/giá trị. Gom lại rồi ghi MỘT dòng nhật ký
  // sau vòng lặp: firmware hỏng thường sai vài trường cùng lúc, và ba dòng nói
  // về cùng một bản tin thì khó đọc hơn một dòng liệt kê cả ba.
  const rejected: string[] = [];

  for (const field of NUMERIC_FIELDS) {
    const v = payload[field];
    if (typeof v !== "number") continue;
    if (NON_NEGATIVE_FIELDS.has(field) && v < 0) {
      // Same policy as the AP/firmware reports below: one bad diagnostic field
      // is worth a log, not a 500 that drops the whole reading.
      console.warn(`ignoring negative ${field} from ${clientId}`);
      rejected.push(`${field}=${v} (âm)`);
      continue;
    }
    row[field] = INTEGER_FIELDS.has(field) ? Math.round(v) : v;
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
    ...IGNORED_FIELDS,
  ]);
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (!reserved.has(k)) extra[k] = v;
  }
  if (Object.keys(extra).length > 0) row.extra = extra;

  // 5. Insert. The `telemetry_apply` trigger updates stations + devices.
  const { error: insertErr } = await admin.from("telemetry").insert(row);
  if (insertErr) {
    // Đây là mất DỮ LIỆU MỚI, loại sự cố nặng nhất của hệ thống này (database
    // đầy, trường sai kiểu, RLS/schema lệch sau một migration hỏng) — và cho
    // tới giờ nó chỉ trả 500 về cho AWS IoT rồi biến mất khỏi mọi nơi người
    // dùng nhìn thấy. AWS thử lại rồi bỏ cuộc, còn dashboard thì chỉ im lặng
    // thiếu dữ liệu.
    //
    // Chặn tần suất 15 phút: nguyên nhân phổ biến nhất (database đầy) làm MỌI
    // bản tin của MỌI thiết bị lỗi cùng lúc, nên nếu ghi thẳng thì chính lúc
    // cần đọc nhật ký nhất lại là lúc nó bị ngập.
    await logEventThrottled(
      device.owner_id, device.station_id, device.id,
      "error", "telemetry_insert_failed",
      `Không ghi được dữ liệu từ ${device.name} vào database: ${insertErr.message}. ` +
        `Dữ liệu của bản tin này đã mất — kiểm tra dung lượng database ở mục ` +
        `"Lưu trữ & dọn dữ liệu".`,
      { detail: insertErr.message, client_id: clientId },
      15,
    );
    return json({ error: "insert_failed", detail: insertErr.message }, 500);
  }

  if (rejected.length > 0) {
    await logEventThrottled(
      device.owner_id, device.station_id, device.id,
      "warn", "telemetry_field_rejected",
      `Bỏ qua ${rejected.length} trường sai giá trị trong bản tin từ ${device.name}: ` +
        `${rejected.join(", ")}. Phần còn lại của bản tin vẫn được ghi nhận.`,
      { fields: rejected, client_id: clientId },
    );
  }

  // 6. BMS config acknowledgement. The device must echo the request identity
  // before this endpoint changes the snapshot. A telemetry message from the
  // right AWS Thing is authenticated, but an old/replayed ACK must still not
  // mark the current request as applied.
  const rawConfigAck = payload.bms_config_ack ?? payload.bmsConfigAck;
  if (rawConfigAck && typeof rawConfigAck === "object" && !Array.isArray(rawConfigAck)) {
    const ack = rawConfigAck as Record<string, unknown>;
    const rawStatus = ack.status;
    const status = rawStatus === "ok" ? "applied" : rawStatus;
    const configId = typeof (ack.config_id ?? ack.configId) === "string"
      ? String(ack.config_id ?? ack.configId)
      : "";
    const rawVersion = ack.config_version ?? ack.configVersion;
    const configVersion = typeof rawVersion === "number" && Number.isInteger(rawVersion)
      ? rawVersion
      : null;
    const configHash = typeof (ack.config_hash ?? ack.configHash) === "string"
      ? String(ack.config_hash ?? ack.configHash)
      : "";
    const detail = typeof ack.detail === "string"
      ? ack.detail.slice(0, 200)
      : typeof ack.error === "string"
        ? ack.error.slice(0, 200)
        : null;

    const identityMatches =
      typeof status === "string" &&
      CONFIG_ACK_STATUSES.has(status) &&
      configId === device.config_id_desired &&
      configVersion !== null &&
      configVersion === device.config_version_desired &&
      configHash === device.config_hash_desired;

    if (!identityMatches) {
      await logEventThrottled(
        device.owner_id,
        device.station_id,
        device.id,
        "warn",
        "bms_config_ack_rejected",
        `${device.name} báo ACK cấu hình BMS không khớp request đang chờ — không cập nhật trạng thái thiết bị.`,
        {
          client_id: clientId,
          status,
          config_id: configId || null,
          config_version: configVersion,
        },
      );
    } else {
      const now = new Date().toISOString();
      const applied = status === "applied" || status === "already_applied";
      const patch: Record<string, unknown> = {
        config_sync_status: status,
        config_sync_error: applied ? null : detail ?? status,
        config_sync_ack_at: now,
      };
      if (applied && configVersion !== null) {
        patch.config_version_applied = configVersion;
        patch.config_hash_applied = configHash || device.config_hash_desired;
      }

      const { error: configUpdateErr } = await admin
        .from("devices")
        .update(patch)
        .eq("id", device.id);
      if (configUpdateErr) {
        await logEventThrottled(
          device.owner_id,
          device.station_id,
          device.id,
          "error",
          "bms_config_ack_write_failed",
          `Không ghi được ACK cấu hình BMS của ${device.name} vào snapshot thiết bị.`,
          { detail: configUpdateErr.message, client_id: clientId },
        );
      } else if (applied || status === "rejected") {
        await logEvent(
          device.owner_id,
          device.station_id,
          device.id,
          applied ? "info" : "error",
          applied ? "bms_config_applied" : "bms_config_rejected",
          applied
            ? `${device.name} đã áp dụng cấu hình BMS version ${configVersion}.`
            : `${device.name} từ chối cấu hình BMS version ${configVersion ?? "không rõ"}${detail ? ` — ${detail}` : ""}.`,
          {
            config_id: configId || null,
            config_version: configVersion,
            config_hash: configHash || null,
            status,
          },
        );
      }
    }
  }

  // 7. Optional load-state ack: firmware that switches relays for one or
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

  // 8. Optional SoftAP report (migration 0014). Firmware sends `ap_ssid` +
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
      // Hậu quả thật của việc bỏ qua: mục "Cấu hình điểm phát WiFi" tiếp tục
      // hiện SSID/mật khẩu CŨ, người dùng mang thông tin đó ra hiện trường và
      // không kết nối được vào thiết bị. Nên đây là dòng nhật ký cần có, không
      // phải chi tiết nội bộ.
      await logEventThrottled(
        device.owner_id, device.station_id, device.id,
        "warn", "ap_report_rejected",
        `${device.name} báo thông tin điểm phát WiFi không hợp lệ (SSID tối đa ` +
          `${AP_SSID_MAX_BYTES} byte, mật khẩu ${AP_PASSWORD_MIN}–${AP_PASSWORD_MAX} ký tự) ` +
          `— dashboard vẫn đang hiển thị thông tin cũ.`,
        { client_id: clientId },
      );
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

  // 9. Optional firmware report (migration 0015) — the return leg of the OTA
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
        // Đáng ghi vì phiên bản là thứ quyết định OTA có được coi là xong hay
        // không (mục 8 bên dưới): firmware báo sai định dạng thì lần nạp nào
        // cũng treo ở 'downloading' mãi mà không ai hiểu vì sao.
        await logEventThrottled(
          device.owner_id, device.station_id, device.id,
          "warn", "fw_report_rejected",
          `${device.name} báo phiên bản firmware không hợp lệ (rỗng hoặc dài quá ` +
            `${FW_VERSION_MAX} ký tự) — dashboard vẫn ghi nhận phiên bản cũ ` +
            `${device.fw_version ?? "chưa rõ"}.`,
          { client_id: clientId },
        );
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
        await logEventThrottled(
          device.owner_id, device.station_id, device.id,
          "warn", "fw_report_rejected",
          `${device.name} báo trạng thái nạp firmware không hợp lệ ` +
            `("${String(status).slice(0, 40)}") — tiến trình OTA trên dashboard ` +
            `sẽ không cập nhật theo bản tin này.`,
          { client_id: clientId, reported: String(status).slice(0, 80) },
        );
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

        // Phần trăm đi cùng trạng thái của cùng một lần OTA. Chỉ nhận số nguyên
        // trong miền schema cho phép; một giá trị hỏng không được làm rơi cả
        // telemetry hoặc trạng thái hợp lệ còn lại trong bản tin.
        if ("fw_progress" in payload) {
          const progress = payload.fw_progress;
          if (
            typeof progress === "number" &&
            Number.isInteger(progress) &&
            progress >= 0 &&
            progress <= 100
          ) {
            patch.fw_progress = progress;
          } else {
            console.warn(`ignoring invalid fw_progress from ${clientId}`);
            await logEventThrottled(
              device.owner_id, device.station_id, device.id,
              "warn", "fw_report_rejected",
              `${device.name} báo phần trăm OTA không hợp lệ ` +
                `("${String(progress).slice(0, 40)}") — chỉ chấp nhận số nguyên từ 0 đến 100.`,
              { client_id: clientId, reported: String(progress).slice(0, 80) },
            );
          }
        } else if (status === "downloading") {
          // Firmware cũ biết báo trạng thái nhưng chưa biết báo phần trăm. Xoá
          // số 0 do cloud khởi tạo để UI không khẳng định sai rằng nó dừng ở 0%.
          patch.fw_progress = null;
        }

        // Hai trạng thái này có ý nghĩa phần byte đã hoàn tất chắc chắn. Chuẩn
        // hoá tại biên ingest để firmware tối giản không cần gửi thêm trường %.
        if (status === "applying" || status === "success") {
          patch.fw_progress = 100;
        } else if (status === "idle") {
          patch.fw_progress = null;
        }
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
        patch.fw_progress = 100;
        patch.fw_status_at = now;
      }
    }

    // `fw_target_id` is intentionally left alone: it records which release was
    // pushed, and the dashboard compares it against `fw_version` to tell a
    // finished update from one the device silently ignored.
    if (Object.keys(patch).length > 0) {
      await admin.from("devices").update(patch).eq("id", device.id);
    }

    // Nhật ký (0018): chỉ ghi khi một lần OTA KẾT THÚC, và chỉ khi trạng thái
    // thực sự đổi. Thiết bị lặp lại 'downloading' hàng chục lần trong một lần
    // nạp — ghi hết thì nhật ký thành bản sao của telemetry.
    const nextStatus = patch.fw_status as string | undefined;
    if (nextStatus && nextStatus !== device.fw_status) {
      const runningVersion = (patch.fw_version as string | undefined) ?? device.fw_version;
      if (nextStatus === "success") {
        await logEvent(
          device.owner_id, device.station_id, device.id,
          "info", "ota_success",
          `Cập nhật firmware ${runningVersion ?? ""} thành công trên ${device.name}`.trim(),
          { version: runningVersion },
        );
      } else if (nextStatus === "failed") {
        const detail = (patch.fw_status_detail as string | null) ?? null;
        await logEvent(
          device.owner_id, device.station_id, device.id,
          "error", "ota_failed",
          `Cập nhật firmware thất bại trên ${device.name}${detail ? ` — ${detail}` : ""}`,
          { detail, version: runningVersion },
        );
      }
    }
  }

  return json({ ok: true });
});
