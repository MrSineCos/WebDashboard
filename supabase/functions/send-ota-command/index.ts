// OTA push — cloud → thiết bị. Gọi từ DevConsole ("Quản lý Firmware MCU" →
// "Đẩy OTA"), không phải từ AWS.
//
// Cùng họ với send-load-command / send-battery-config (publish thẳng vào AWS
// IoT Core, dùng chung cặp khoá iot:Publish), nhưng khác một điểm quan trọng:
// bản thân file .bin KHÔNG đi qua MQTT — nó nằm trong Storage bucket `firmware`
// (private, migration 0015). Lệnh MQTT chỉ mang **signed URL ngắn hạn** để
// thiết bị tự tải về qua HTTPS. Payload MQTT của AWS IoT giới hạn 128 KB, còn
// ảnh firmware ESP32-S3 cỡ vài MB — nên đây là cách duy nhất khả thi, và cũng
// tránh giữ bucket ở chế độ public.
//
// Flow: verify JWT người dùng → đọc `firmware_releases` (RLS select-own, nên
// đọc được đã chứng minh quyền sở hữu) → tạo signed URL cho storage_path →
// publish {type:"ota", url, version, board, sha256, size} tới từng ESP32 đích
// trên `solgrid/<aws_thing_name>/command` → đặt fw_target_id + fw_status
// ='pending' cho những thiết bị publish thành công.
//
// Xác nhận nạp xong KHÔNG suy ra từ đây: thiết bị báo ngược fw_version/
// fw_status qua telemetry (xem ingest-telemetry). Chênh lệch giữa fw_target_id
// và fw_version là tín hiệu phát hiện nạp hỏng — cùng nguyên tắc với
// loads.desired_state ↔ reported_state.
//
// Deploy:  supabase functions deploy send-ota-command
// Secrets: dùng chung cặp khoá iot:Publish + AWS_IOT_ENDPOINT với
//   send-load-command (mục 6.2 docs/IOT.md) — cùng namespace topic
//   solgrid/*/command. SUPABASE_URL / SUPABASE_ANON_KEY /
//   SUPABASE_SERVICE_ROLE_KEY được nạp tự động trên nền tảng hosted.
//   Tuỳ chọn: OTA_SIGNED_URL_TTL (giây, mặc định 3600).

import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  IoTDataPlaneClient,
  PublishCommand,
} from "npm:@aws-sdk/client-iot-data-plane@3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SERVICE_ROLE_KEY")!;

// Ghi `devices.fw_target_id`/`fw_status` cần service role: `devices` cố tình
// không có policy update cho client (0003) — nếu không, người dùng có thể tự
// khai thiết bị của mình đã lên bản mới mà chẳng nạp gì.
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

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

// Thời hạn signed URL. Phải đủ dài cho một ESP32 trên mạng yếu tải xong vài MB
// (và cho thiết bị đang bận vòng lặp bảo vệ pin xử lý muộn), nhưng vẫn hữu hạn
// để URL rò ra ngoài không dùng được mãi. Hết hạn trước khi tải xong → thiết bị
// báo fw_status='failed', đẩy lại là có URL mới.
const SIGNED_URL_TTL = Number(Deno.env.get("OTA_SIGNED_URL_TTL") ?? 3600);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: { release_id?: string; device_id?: string; station_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const { release_id, device_id, station_id } = body;
  if (!release_id) return json({ error: "invalid_params" }, 400);
  // Đúng một trong hai đích: một thiết bị cụ thể ("Cập nhật" trên một dòng)
  // hoặc cả trạm ("Đẩy OTA đến tất cả thiết bị"). Nhận cả hai thì không rõ ý
  // định — từ chối thay vì đoán, vì đây là thao tác ghi lên phần cứng thật.
  if (Boolean(device_id) === Boolean(station_id)) {
    return json({ error: "need_device_id_or_station_id" }, 400);
  }

  // User-scoped client: RLS giới hạn về đúng bản phát hành/thiết bị của người
  // gọi, nên đọc được hàng nào là đã chứng minh quyền sở hữu hàng đó.
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });

  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  const { data: release, error: relErr } = await userClient
    .from("firmware_releases")
    .select("id, board, version, storage_path, size_bytes, sha256")
    .eq("id", release_id)
    .maybeSingle();
  if (relErr) return json({ error: "lookup_failed", detail: relErr.message }, 500);
  if (!release) return json({ error: "release_not_found" }, 404);

  // Chỉ ESP32 mới nạp được firmware này (inverter/bms/sensor là thiết bị của
  // hãng khác, không nói giao thức OTA của ta).
  let deviceQuery = userClient
    .from("devices")
    .select("id, name, aws_thing_name, station_id")
    .eq("type", "esp32");
  deviceQuery = device_id
    ? deviceQuery.eq("id", device_id)
    : deviceQuery.eq("station_id", station_id!);

  const { data: devices, error: devErr } = await deviceQuery;
  if (devErr) return json({ error: "lookup_failed", detail: devErr.message }, 500);
  if (!devices || devices.length === 0) return json({ error: "no_target_device" }, 404);

  // Signed URL tạo bằng user client (không phải service role): policy
  // `firmware_objects_select_own` đã cho chủ sở hữu đọc object của mình, nên
  // không cần nâng quyền. Lỗi ở đây thường là object đã bị xoá khỏi bucket
  // trong khi hàng firmware_releases vẫn còn (xem docs/IOT.md mục 10.4).
  const { data: signed, error: signErr } = await userClient.storage
    .from("firmware")
    .createSignedUrl(release.storage_path, SIGNED_URL_TTL);
  if (signErr || !signed?.signedUrl) {
    return json(
      { error: "release_object_missing", detail: signErr?.message ?? "no signed url" },
      404,
    );
  }

  // Payload gửi xuống thiết bị. Tên trường khớp firmware onCommand().
  // `board` đi kèm để **firmware tự từ chối** ảnh build cho board khác: cloud
  // không biết chắc board của một thiết bị (bảng `devices` chỉ có `type`), còn
  // thiết bị thì biết chắc chắn — cùng nguyên tắc "thiết bị là nguồn sự thật"
  // như SoftAP (mục 9). `sha256` để verify trước khi commit ảnh; `size` để từ
  // chối sớm nếu không đủ chỗ trong slot OTA.
  const otaPayload = {
    type: "ota",
    release_id: release.id,
    board: release.board,
    version: release.version,
    url: signed.signedUrl,
    sha256: release.sha256,
    size: release.size_bytes,
    expires_in: SIGNED_URL_TTL,
    ts: Date.now(),
  };

  const encoded = new TextEncoder().encode(JSON.stringify(otaPayload));
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

  // Chỉ đánh dấu 'pending' cho thiết bị mà lệnh thật sự tới được AWS. Thiết bị
  // publish lỗi giữ nguyên trạng thái cũ, để lần đẩy sau không bị che mất.
  const okIds = devices.filter((_, i) => results[i].status === "fulfilled").map((d) => d.id);
  const failedNames = devices.filter((_, i) => results[i].status === "rejected").map((d) => d.name);

  if (okIds.length === 0) {
    const reason = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    return json(
      { error: "publish_failed", detail: String(reason?.reason ?? ""), published: 0, failed: devices.length },
      502,
    );
  }

  const { error: updateErr } = await admin
    .from("devices")
    .update({
      fw_target_id: release.id,
      fw_status: "pending",
      fw_status_detail: null,
      fw_status_at: new Date().toISOString(),
    })
    .in("id", okIds);
  // Lệnh đã rời khỏi đây rồi — thiết bị sẽ nạp dù cột trạng thái không ghi
  // được. Báo lỗi 500 ở đây sẽ khiến UI hiểu nhầm là "chưa đẩy gì cả", nên chỉ
  // log và vẫn trả ok kèm cảnh báo.
  if (updateErr) console.error("fw_status update failed:", updateErr.message);

  // Nhật ký hệ thống (0018). Ghi ở đây là ghi "đã GỬI lệnh" — kết quả nạp thật
  // sự do thiết bị báo về và được ingest-telemetry ghi tiếp thành ota_success /
  // ota_failed. Hai dòng đó ghép lại chính là thứ cho biết một thiết bị đã im
  // lặng nuốt mất bản cập nhật.
  const logStationId = station_id ?? devices[0].station_id;
  await admin.from("system_logs").insert({
    owner_id: user.id,
    station_id: logStationId,
    device_id: device_id ?? null,
    level: failedNames.length > 0 ? "warn" : "info",
    source: "ota",
    event: "ota_pushed",
    message: failedNames.length > 0
      ? `Đã gửi lệnh nạp firmware ${release.version} tới ${okIds.length} thiết bị; ` +
        `${failedNames.length} thiết bị không gửi được: ${failedNames.join(", ")}`
      : `Đã gửi lệnh nạp firmware ${release.version} tới ${okIds.length} thiết bị`,
    meta: {
      version: release.version,
      board: release.board,
      published: okIds.length,
      failed: failedNames.length,
    },
  });

  return json({
    ok: true,
    published: okIds.length,
    failed: failedNames.length,
    failed_devices: failedNames,
    version: release.version,
    board: release.board,
    expires_in: SIGNED_URL_TTL,
    status_write_failed: updateErr ? updateErr.message : undefined,
  });
});
