// Battery-protection config push — cloud → device.
//
// Đối xứng với send-load-command nhưng gửi NGƯỠNG bảo vệ pin thay vì lệnh
// bật/tắt tải. Được gọi khi người dùng đổi "Chế độ bảo vệ pin" (hoặc chỉnh
// ngưỡng của một mode) ở dashboard.
//
// Flow: verify JWT người dùng → đọc `station_settings` của trạm (RLS đã giới
// hạn về đúng chủ trạm) để lấy `battery_modes` + mode đang chọn → publish
// ngưỡng của mode đó tới TẤT CẢ thiết bị ESP32 của trạm trên
// `solgrid/<aws_thing_name>/command` với `{type:"battery_config", ...}`.
//
// Lưu ý an toàn: đây chỉ là kênh CẤU HÌNH. Việc thực sự đóng/cắt relay sạc/xả
// do firmware tự quyết theo ngưỡng nhận được (còn giữ khi mất mạng, nhờ NVS) —
// cloud không phải lớp bảo vệ real-time. Xem docs/IOT.md.
//
// Deploy:  supabase functions deploy send-battery-config
// Secrets: dùng chung cặp khoá iot:Publish + AWS_IOT_ENDPOINT với
//   send-load-command (topic đích cùng namespace solgrid/*/command).

import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  IoTDataPlaneClient,
  PublishCommand,
} from "npm:@aws-sdk/client-iot-data-plane@3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const iotData = new IoTDataPlaneClient({
  region: Deno.env.get("AWS_REGION")!,
  endpoint: `https://${Deno.env.get("AWS_IOT_ENDPOINT")!}`,
  credentials: {
    accessKeyId: Deno.env.get("AWS_ACCESS_KEY_ID")!,
    secretAccessKey: Deno.env.get("AWS_SECRET_ACCESS_KEY")!,
  },
});

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const VALID_MODES = new Set(["low", "balanced", "max"]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

// Ép các ngưỡng về số/boolean hợp lệ trước khi gửi xuống thiết bị, để một hàng
// battery_modes hỏng (thiếu trường, sai kiểu) không đẩy giá trị rác vào firmware.
function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: { station_id?: string; mode?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const { station_id } = body;
  if (!station_id) return json({ error: "invalid_params" }, 400);
  if (body.mode && !VALID_MODES.has(body.mode)) {
    return json({ error: "invalid_mode" }, 400);
  }

  // User-scoped client: RLS giới hạn về đúng trạm/thiết bị của người gọi.
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });

  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  const { data: settings, error: settingsErr } = await userClient
    .from("station_settings")
    .select("active_battery_mode, battery_modes")
    .eq("station_id", station_id)
    .maybeSingle();
  if (settingsErr) return json({ error: "lookup_failed", detail: settingsErr.message }, 500);
  if (!settings) return json({ error: "station_not_found" }, 404);

  const mode = body.mode ?? settings.active_battery_mode;
  const cfg = (settings.battery_modes ?? {})[mode];
  if (!cfg) return json({ error: "mode_config_missing" }, 400);

  // Payload ngưỡng gửi xuống thiết bị. Tên trường khớp firmware onCommand().
  const configPayload = {
    type: "battery_config",
    mode,
    minSoc: num(cfg.minSoc, 20),
    maxSoc: num(cfg.maxSoc, 90),
    maxVoltage: num(cfg.maxVoltage, 54.6),
    maxCurrent: num(cfg.maxCurrent, 25),
    deepDischargeProtect: cfg.deepDischargeProtect !== false,
    ts: Date.now(),
  };

  // Mọi ESP32 của trạm (mỗi thiết bị 1 topic command riêng).
  const { data: devices, error: devErr } = await userClient
    .from("devices")
    .select("aws_thing_name")
    .eq("station_id", station_id)
    .eq("type", "esp32");
  if (devErr) return json({ error: "lookup_failed", detail: devErr.message }, 500);
  if (!devices || devices.length === 0) {
    // Không có thiết bị điều khiển — cấu hình vẫn được lưu ở station_settings,
    // chỉ là chưa có đích để đẩy. Không coi là lỗi cứng.
    return json({ ok: true, published: 0, mode });
  }

  const encoded = new TextEncoder().encode(JSON.stringify(configPayload));
  const results = await Promise.allSettled(
    devices.map((d) =>
      iotData.send(
        new PublishCommand({
          topic: `solgrid/${d.aws_thing_name}/command`,
          payload: encoded,
          qos: 1,
        }),
      )
    ),
  );

  const published = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.length - published;
  if (published === 0) {
    return json({ error: "publish_failed", published, failed, mode }, 502);
  }
  return json({ ok: true, published, failed, mode });
});
