// Gửi thông báo đẩy (Web Push) cho các cảnh báo vừa mở.
//
// Chạy theo ba đường, tất cả đều vào cùng một thân hàm:
//   * trigger `alerts_notify_push` (0024 mục 5) — ngay khi một đợt cảnh báo mở;
//   * pg_cron `dispatch-push` mỗi 15 phút — lưới an toàn cho lần trigger hỏng;
//   * nút "Gửi thử" trong Cài đặt → Thông báo — JWT của người dùng, chỉ gửi cho
//     chính họ và KHÔNG đụng vào bảng alerts.
//
// Hai đường đầu gửi `Authorization: Bearer <MAINTENANCE_SHARED_SECRET>`, đường
// thứ ba gửi JWT — nên hàm phải deploy với --no-verify-jwt và tự xác thực bên
// dưới, y hệt archive-telemetry (0019). Không nới lỏng gì: request không mang
// đúng shared secret hoặc JWT hợp lệ vẫn nhận 401.
//
// Deploy:
//   supabase functions deploy send-push --no-verify-jwt
//
// Secrets:
//   supabase secrets set MAINTENANCE_SHARED_SECRET=...   (dùng chung với 0019)
//   supabase secrets set VAPID_KEYS='{"publicKey":{...},"privateKey":{...}}'
//   supabase secrets set VAPID_SUBJECT=mailto:ban@email.com
//
// Sinh cặp khoá VAPID: node tools/vapid-keys.mjs (xem docs/IOT.md mục 15).

import { createClient } from "jsr:@supabase/supabase-js@2";
import * as webpush from "jsr:@negrel/webpush@0.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SERVICE_ROLE_KEY")!;
const MAINTENANCE_SHARED_SECRET = Deno.env.get("MAINTENANCE_SHARED_SECRET") ?? "";
const VAPID_KEYS = Deno.env.get("VAPID_KEYS") ?? "";
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@solgrid.local";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Cảnh báo cũ hơn ngưỡng này chỉ được ĐÁNH DẤU đã xử lý chứ không gửi đi.
//
// Lý do: một thông báo "trạm mất kết nối" nảy lên lúc 9 giờ sáng về sự cố xảy
// ra từ 2 giờ đêm không giúp được gì mà còn làm người dùng mất tin vào kênh
// này. Trường hợp gặp ngưỡng này là khi Edge Function hỏng suốt đêm — lúc đó
// cảnh báo vẫn nằm nguyên trong Dashboard, chỉ là không đẩy nữa.
const MAX_ALERT_AGE_MS = 30 * 60 * 1000;

// Số lần gửi hỏng liên tiếp trước khi bỏ hẳn một đăng ký. Lỗi 404/410 thì xoá
// ngay không cần đếm (xem sendOne) — bộ đếm này dành cho lỗi mạng/5xx, vốn hay
// tự khỏi, nên phải kiên nhẫn hơn.
const MAX_FAILURES = 5;

// Mỗi lượt chạy xử lý tối đa ngần này cảnh báo. Vượt ra thì lượt sau xử lý
// tiếp — thà chậm còn hơn bị nền tảng cắt ngang giữa chừng.
const MAX_ALERTS_PER_RUN = 200;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

// ---------------------------------------------------------------------
// Máy chủ ứng dụng Web Push
//
// Dựng một lần cho cả vòng đời instance: nhập khoá VAPID là thao tác Web Crypto
// không rẻ, và mỗi lượt chạy gửi cho nhiều đăng ký.
// ---------------------------------------------------------------------
let appServerPromise: Promise<webpush.ApplicationServer> | null = null;

function getAppServer(): Promise<webpush.ApplicationServer> {
  if (!appServerPromise) {
    appServerPromise = (async () => {
      const keys = await webpush.importVapidKeys(JSON.parse(VAPID_KEYS), {
        extractable: false,
      });
      return await webpush.ApplicationServer.new({
        contactInformation: VAPID_SUBJECT,
        vapidKeys: keys,
      });
    })();
  }
  return appServerPromise;
}

type Subscription = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  failure_count: number;
};

type PushPayload = {
  title: string;
  body: string;
  // Gộp thông báo cùng một đợt cảnh báo lại thay vì xếp chồng nhiều dòng giống
  // nhau — trình duyệt dùng `tag` để thay thế thông báo cũ cùng nhãn.
  tag: string;
  severity: string;
  url: string;
};

// Trả về 'ok' | 'gone' | 'failed'. Gọi hàm này không ném lỗi ra ngoài: một
// đăng ký hỏng không được phép làm hỏng lượt gửi cho các đăng ký còn lại.
async function sendOne(sub: Subscription, payload: PushPayload): Promise<"ok" | "gone" | "failed"> {
  try {
    const appServer = await getAppServer();
    const subscriber = appServer.subscribe({
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth },
    });
    await subscriber.pushTextMessage(JSON.stringify(payload), {});
    return "ok";
  } catch (e) {
    // 404 = endpoint không còn tồn tại, 410 Gone = người dùng đã gỡ quyền hoặc
    // xoá dữ liệu trang. Cả hai đều là vĩnh viễn: thử lại chỉ tốn lượt gọi và
    // để rác lại trong bảng.
    const status = (e as { response?: { status?: number } })?.response?.status;
    if (status === 404 || status === 410) return "gone";
    console.error(`push failed for ${sub.endpoint.slice(0, 60)}…:`, e);
    return "failed";
  }
}

// Gửi một payload cho MỌI đăng ký của một tài khoản, rồi dọn bảng theo kết quả.
// Trả về số đăng ký nhận được.
async function pushToOwner(ownerId: string, payload: PushPayload): Promise<number> {
  const { data: subs } = await admin
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth, failure_count")
    .eq("owner_id", ownerId)
    .eq("provider", "webpush");

  if (!subs || subs.length === 0) return 0;

  let delivered = 0;
  const dead: string[] = [];

  for (const sub of subs as Subscription[]) {
    const result = await sendOne(sub, payload);

    if (result === "ok") {
      delivered += 1;
      // Gửi được thì bộ đếm hỏng phải về 0: năm lần hỏng rải rác suốt một tháng
      // không nói lên điều gì về một đăng ký vẫn đang hoạt động tốt.
      await admin
        .from("push_subscriptions")
        .update({ last_success_at: new Date().toISOString(), failure_count: 0 })
        .eq("id", sub.id);
      continue;
    }

    if (result === "gone") {
      dead.push(sub.id);
      continue;
    }

    const next = sub.failure_count + 1;
    if (next >= MAX_FAILURES) dead.push(sub.id);
    else await admin.from("push_subscriptions").update({ failure_count: next }).eq("id", sub.id);
  }

  if (dead.length > 0) {
    await admin.from("push_subscriptions").delete().in("id", dead);
  }

  return delivered;
}

// ---------------------------------------------------------------------
// Đường chính: quét cảnh báo chưa báo và đẩy đi
// ---------------------------------------------------------------------
type AlertRow = {
  id: string;
  owner_id: string;
  station_id: string;
  kind: string;
  severity: string;
  message: string;
  started_at: string;
};

async function dispatchAlerts(ownerFilter: string | null) {
  let query = admin
    .from("alerts")
    .select("id, owner_id, station_id, kind, severity, message, started_at")
    .is("notified_at", null)
    .is("resolved_at", null)
    .order("started_at", { ascending: true })
    .limit(MAX_ALERTS_PER_RUN);

  if (ownerFilter) query = query.eq("owner_id", ownerFilter);

  const { data: alerts, error } = await query;
  if (error) return { error: error.message };
  if (!alerts || alerts.length === 0) {
    return { alerts: 0, sent: 0, delivered: 0, skipped_stale: 0, skipped_pref: 0 };
  }

  // Gom theo tài khoản: tuỳ chọn bật/tắt và danh sách thiết bị đều ở mức tài
  // khoản, nên đọc một lần cho cả nhóm thay vì mỗi cảnh báo một lượt truy vấn.
  const byOwner = new Map<string, AlertRow[]>();
  for (const a of alerts as AlertRow[]) {
    const list = byOwner.get(a.owner_id);
    if (list) list.push(a);
    else byOwner.set(a.owner_id, [a]);
  }

  // Tên trạm để câu thông báo nói rõ "trạm nào" — `alerts.message` chỉ mô tả
  // sự cố. Người có ba trạm mà nhận được "Điện áp pin thấp" trống không thì
  // phải mở app ra mới biết cần đi đâu.
  const stationIds = [...new Set((alerts as AlertRow[]).map((a) => a.station_id))];
  const { data: stations } = await admin
    .from("stations")
    .select("id, name")
    .in("id", stationIds);
  const stationName = new Map((stations ?? []).map((s) => [s.id as string, s.name as string]));

  const now = Date.now();
  let sent = 0, delivered = 0, skippedStale = 0, skippedPref = 0;
  const handled: string[] = [];

  for (const [ownerId, ownerAlerts] of byOwner) {
    const { data: settings } = await admin
      .from("user_settings")
      .select("notif_prefs")
      .eq("owner_id", ownerId)
      .maybeSingle();

    // Mặc định BẬT khi khoá chưa có trong jsonb — khớp `?? true` mà giao diện
    // dùng để vẽ công tắc (Dashboard.jsx). Hai bên đọc mặc định khác nhau thì
    // người dùng thấy công tắc bật mà không nhận được gì.
    const pushOn = (settings?.notif_prefs as Record<string, boolean> | null)?.push ?? true;

    if (!pushOn) {
      // Vẫn đánh dấu đã xử lý: người dùng đã nói không muốn nhận, nên đây là
      // việc đã xong chứ không phải việc còn tồn. Bật lại về sau sẽ nhận cảnh
      // báo MỚI, không phải một loạt thông báo dồn từ lúc đang tắt.
      skippedPref += ownerAlerts.length;
      handled.push(...ownerAlerts.map((a) => a.id));
      continue;
    }

    for (const alert of ownerAlerts) {
      handled.push(alert.id);

      if (now - new Date(alert.started_at).getTime() > MAX_ALERT_AGE_MS) {
        skippedStale += 1;
        continue;
      }

      const name = stationName.get(alert.station_id) ?? "Trạm";
      const count = await pushToOwner(ownerId, {
        title: alert.severity === "danger" ? `⚠ ${name}` : name,
        body: alert.message,
        tag: `alert-${alert.id}`,
        severity: alert.severity,
        url: "/?view=alerts",
      });
      sent += 1;
      delivered += count;
    }
  }

  if (handled.length > 0) {
    await admin
      .from("alerts")
      .update({ notified_at: new Date().toISOString() })
      .in("id", handled);
  }

  return { alerts: alerts.length, sent, delivered, skipped_stale: skippedStale, skipped_pref: skippedPref };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  if (!VAPID_KEYS) {
    return json({ error: "vapid_not_configured", detail: "Chưa nạp secret VAPID_KEYS." }, 500);
  }

  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return json({ error: "unauthorized" }, 401);

  let body: { test?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    // pg_net gửi body rỗng ở một số phiên bản — coi như {}.
  }

  // Đường 1+2: pg_cron / trigger. Xử lý mọi tài khoản.
  if (MAINTENANCE_SHARED_SECRET && token === MAINTENANCE_SHARED_SECRET) {
    const result = await dispatchAlerts(null);
    return json({ ok: true, scope: "all", ...result });
  }

  // Đường 3: người dùng đã đăng nhập.
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: auth } },
  });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  if (body.test) {
    // Gửi thử KHÔNG đụng vào bảng alerts: mục đích của nút này là trả lời câu
    // "chuỗi trình duyệt → server → thiết bị có thông không", nên nó phải chạy
    // được cả khi hệ thống đang không có cảnh báo nào.
    const delivered = await pushToOwner(user.id, {
      title: "SolGrid",
      body: "Thông báo thử — kênh đẩy đang hoạt động bình thường.",
      tag: "test",
      severity: "info",
      url: "/?view=settings",
    });
    return json({ ok: true, scope: "test", delivered });
  }

  const result = await dispatchAlerts(user.id);
  return json({ ok: true, scope: "own", ...result });
});
