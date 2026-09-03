// Lưu trữ + dọn telemetry cũ.
//
// Chạy theo hai đường:
//   * pg_cron hằng ngày (migration 0019, `run_telemetry_archive()`) — gửi
//     `Authorization: Bearer <MAINTENANCE_SHARED_SECRET>`, xử lý MỌI tài khoản.
//   * Nút "Chạy dọn ngay" trong DevConsole — gửi JWT của người dùng, chỉ xử lý
//     đúng tài khoản đó.
//
// Với mỗi trạm: đọc telemetry cũ hơn `telemetry_retention_days`, gom theo
// THÁNG, xuất CSV, nén gzip, đẩy lên bucket `telemetry-archive`, ghi một hàng
// vào `telemetry_archives`, RỒI mới xoá khỏi bảng `telemetry`.
//
// Thứ tự đó là điểm quan trọng nhất của cả file: tải lên trước, xoá sau. Nếu
// bước xoá hỏng, lần chạy sau sẽ lưu trữ lại đúng những dòng đó thành một gói
// nữa — thừa dữ liệu trong kho lạnh, chứ không mất. Đảo thứ tự lại thì một lỗi
// mạng giữa chừng là mất hẳn.
//
// Vì sao gom theo tháng mà một tháng vẫn có thể nhiều file: mỗi lần chạy chỉ
// xử lý một lô có giới hạn để không vượt bộ nhớ/thời gian của Edge Function.
// Muốn mỗi tháng đúng một file thì phải tải file cũ về, giải nén, nối thêm,
// nén lại — với gói vài chục MB là hết bộ nhớ. Nên: một thư mục `YYYY-MM`,
// nhiều `part-*.csv.gz` bên trong.
//
// Deploy:  supabase functions deploy archive-telemetry --no-verify-jwt
//
//   `--no-verify-jwt` là BẮT BUỘC, cùng lý do với ingest-telemetry: hàm này
//   nhận hai loại credential khác nhau, mà cổng Edge Functions chỉ hiểu được
//   một. pg_cron gửi `Bearer <MAINTENANCE_SHARED_SECRET>` (chuỗi hex, không
//   phải JWT) nên cổng chặn ngay với UNAUTHORIZED_INVALID_JWT_FORMAT trước khi
//   code này chạy. Tắt kiểm tra ở cổng rồi tự xác thực bên dưới (xem Deno.serve)
//   — không nới lỏng gì cả: request không mang shared secret ĐÚNG hoặc JWT hợp
//   lệ vẫn nhận 401, chỉ khác là do hàm này từ chối chứ không phải cổng.
//
// Secrets: supabase secrets set MAINTENANCE_SHARED_SECRET=...
//   Tuỳ chọn: ARCHIVE_STORAGE_BUDGET_BYTES (mặc định 900 MB — chừa chỗ so với
//   hạn mức 1 GB của free plan).

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SERVICE_ROLE_KEY")!;
const MAINTENANCE_SHARED_SECRET = Deno.env.get("MAINTENANCE_SHARED_SECRET") ?? "";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const BUCKET = "telemetry-archive";

// Số dòng đọc mỗi lượt. 20.000 dòng CSV ≈ 4 MB trong bộ nhớ trước khi nén —
// thoải mái trong hạn mức của Edge Function, và đủ lớn để một trạm chạy 10
// giây/bản tin dọn xong hơn hai ngày dữ liệu trong một lượt.
const BATCH_ROWS = 20000;

// Chặn trên cho một lần gọi. Tồn đọng lớn hơn thì lần chạy kế tiếp xử lý tiếp —
// thà chạy nhiều đêm còn hơn bị cắt giữa chừng ở một chỗ không đoán trước.
const MAX_ROWS_PER_RUN = 200000;

// Dừng sớm và trả lời tử tế trước khi nền tảng cắt ngang. Việc đã làm xong
// (đã tải lên + đã xoá) vẫn giữ nguyên vì mỗi lô là một đơn vị hoàn chỉnh.
const DEADLINE_MS = 100000;

// Free plan cho 1 GB Storage. Chừa lại ~100 MB cho bucket `firmware` và
// `avatars` — vượt ngưỡng này thì DỪNG lưu trữ (và do đó không xoá gì cả),
// ghi log mức 'error' để người dùng vào dọn gói cũ.
const STORAGE_BUDGET_BYTES = Number(
  Deno.env.get("ARCHIVE_STORAGE_BUDGET_BYTES") ?? 900 * 1024 * 1024,
);

// Cột bỏ khỏi CSV vì đã nằm ở đường dẫn file + hàng `telemetry_archives`, lặp
// lại trong từng dòng chỉ tốn chỗ (mỗi uuid 36 ký tự × hàng vạn dòng).
const OMIT_COLUMNS = new Set(["owner_id", "station_id"]);

// Thứ tự cột ưu tiên, để file mở bằng bảng tính đọc được ngay. Cột mới do
// migration sau này thêm vào sẽ tự xếp phía sau theo thứ tự chữ cái — cố tình
// không hardcode danh sách đầy đủ, vì `telemetry` đã được mở rộng ba lần
// (0012, 0017) và một danh sách cứng ở đây sẽ âm thầm làm rơi cột mới.
const COLUMN_ORDER = [
  "id",
  "ts",
  "device_id",
  "solar_kw",
  "battery_pct",
  "battery_voltage",
  "battery_current",
  "load_w",
  "temp_c",
  "rssi",
  "uptime_s",
  "boot_count",
  "charge_enabled",
  "discharge_enabled",
  "protect_reason",
  "extra",
];

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

type Row = Record<string, unknown>;

function orderedColumns(row: Row): string[] {
  const keys = Object.keys(row).filter((k) => !OMIT_COLUMNS.has(k));
  const known = COLUMN_ORDER.filter((c) => keys.includes(c));
  const rest = keys.filter((k) => !COLUMN_ORDER.includes(k)).sort();
  return [...known, ...rest];
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "object" ? JSON.stringify(value) : String(value);
  // Chỉ bọc khi cần — phần lớn ô là số, bọc hết sẽ phình file vô ích.
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function toCsv(rows: Row[]): string {
  const cols = orderedColumns(rows[0]);
  const lines = [cols.join(",")];
  for (const row of rows) {
    lines.push(cols.map((c) => csvCell(row[c])).join(","));
  }
  return lines.join("\n") + "\n";
}

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Tháng theo UTC. Cố ý không dùng giờ Việt Nam: ranh giới tháng chỉ để đặt tên
// và gom file, còn `from_ts`/`to_ts` trong `telemetry_archives` mới là mốc
// chính xác. Dùng UTC thì tên file không đổi nghĩa khi đổi múi giờ máy chủ.
function monthKey(ts: string): string {
  return ts.slice(0, 7); // "2026-07"
}

async function logEvent(
  ownerId: string,
  level: "info" | "warn" | "error",
  event: string,
  message: string,
  meta: Record<string, unknown> = {},
  stationId: string | null = null,
) {
  const { error } = await admin.from("system_logs").insert({
    owner_id: ownerId,
    station_id: stationId,
    level,
    source: "archive",
    event,
    message,
    meta,
  });
  if (error) console.error("system_logs insert failed:", error.message);
}

async function usedArchiveBytes(ownerId: string): Promise<number> {
  const { data, error } = await admin
    .from("telemetry_archives")
    .select("bytes_gzip")
    .eq("owner_id", ownerId);
  if (error || !data) return 0;
  return data.reduce((sum, r) => sum + Number(r.bytes_gzip ?? 0), 0);
}

type OwnerResult = {
  owner_id: string;
  archived_rows: number;
  deleted_rows: number;
  files: number;
  bytes: number;
  skipped?: string;
};

async function processOwner(ownerId: string, startedAt: number): Promise<OwnerResult> {
  const result: OwnerResult = {
    owner_id: ownerId,
    archived_rows: 0,
    deleted_rows: 0,
    files: 0,
    bytes: 0,
  };

  const { data: settings } = await admin
    .from("user_settings")
    .select("telemetry_retention_days, telemetry_archive_enabled")
    .eq("owner_id", ownerId)
    .maybeSingle();

  // Không có hàng cài đặt thì không có hạn giữ nào để áp — bỏ qua thay vì đoán
  // một con số rồi xoá dữ liệu theo nó.
  if (!settings) {
    result.skipped = "no_settings";
    return result;
  }

  const retentionDays = Number(settings.telemetry_retention_days);
  const archiveEnabled = Boolean(settings.telemetry_archive_enabled);
  const cutoff = new Date(Date.now() - retentionDays * 86400_000).toISOString();

  let budgetLeft = Infinity;
  if (archiveEnabled) {
    const used = await usedArchiveBytes(ownerId);
    budgetLeft = STORAGE_BUDGET_BYTES - used;
    if (budgetLeft <= 0) {
      // Không xoá gì cả trong trường hợp này: xoá mà không lưu được là đúng
      // thứ người dùng đã tắt bằng cách bật `telemetry_archive_enabled`.
      await logEvent(
        ownerId,
        "error",
        "archive_storage_full",
        `Storage lưu trữ đã dùng ${(used / 1048576).toFixed(0)} MB, vượt hạn mức ` +
          `${(STORAGE_BUDGET_BYTES / 1048576).toFixed(0)} MB — đã DỪNG lưu trữ và ` +
          `không xoá bản ghi nào. Hãy xoá bớt gói lưu trữ cũ trong DevConsole.`,
        { used_bytes: used, budget_bytes: STORAGE_BUDGET_BYTES },
      );
      result.skipped = "storage_full";
      return result;
    }
  }

  const { data: stations } = await admin
    .from("stations")
    .select("id, name")
    .eq("owner_id", ownerId);

  for (const station of stations ?? []) {
    for (;;) {
      if (Date.now() - startedAt > DEADLINE_MS) return result;
      // max() chứ không phải tổng: khi bật lưu trữ, cùng một dòng được đếm ở
      // cả `archived_rows` lẫn `deleted_rows`, cộng lại sẽ chạm trần khi mới
      // xử lý được một nửa hạn mức thật.
      if (Math.max(result.archived_rows, result.deleted_rows) >= MAX_ROWS_PER_RUN) return result;

      // Dùng đúng index `telemetry_station_ts_idx` (0003) — đó là lý do vòng
      // lặp đi theo từng trạm thay vì quét thẳng theo owner_id, vốn không có
      // index nào phục vụ và sẽ seq-scan cả bảng.
      const { data: rows, error: selErr } = await admin
        .from("telemetry")
        .select("*")
        .eq("station_id", station.id)
        .lt("ts", cutoff)
        .order("ts", { ascending: true })
        .limit(BATCH_ROWS);

      if (selErr) {
        await logEvent(
          ownerId,
          "error",
          "archive_read_failed",
          `Không đọc được telemetry của trạm ${station.name}: ${selErr.message}`,
          { station_id: station.id },
          station.id,
        );
        break;
      }
      if (!rows || rows.length === 0) break;

      const ids = rows.map((r) => r.id as number);

      // --- Nhánh không lưu trữ: xoá thẳng ---
      if (!archiveEnabled) {
        const { data: deleted, error: delErr } = await admin.rpc("delete_telemetry_rows", {
          p_ids: ids,
        });
        if (delErr) {
          await logEvent(
            ownerId,
            "error",
            "purge_failed",
            `Không xoá được telemetry của trạm ${station.name}: ${delErr.message}`,
            { station_id: station.id },
            station.id,
          );
          break;
        }
        result.deleted_rows += Number(deleted ?? 0);
        continue;
      }

      // --- Nhánh lưu trữ: gom theo tháng, nén, tải lên, rồi mới xoá ---
      const byMonth = new Map<string, Row[]>();
      for (const row of rows as Row[]) {
        const key = monthKey(String(row.ts));
        const bucketRows = byMonth.get(key);
        if (bucketRows) bucketRows.push(row);
        else byMonth.set(key, [row]);
      }

      const archivedIds: number[] = [];
      let batchFailed = false;

      for (const [month, monthRows] of byMonth) {
        const gz = await gzip(toCsv(monthRows));

        if (gz.byteLength > budgetLeft) {
          await logEvent(
            ownerId,
            "error",
            "archive_storage_full",
            `Không đủ dung lượng Storage cho gói ${month} của trạm ${station.name} ` +
              `(cần ${(gz.byteLength / 1048576).toFixed(1)} MB). Đã dừng lưu trữ và ` +
              `không xoá bản ghi nào — hãy xoá bớt gói cũ trong DevConsole.`,
            { month, station_id: station.id, needed_bytes: gz.byteLength },
            station.id,
          );
          batchFailed = true;
          break;
        }

        const path = `${ownerId}/${station.id}/${month}/part-${Date.now()}-${monthRows.length}.csv.gz`;
        const { error: upErr } = await admin.storage
          .from(BUCKET)
          .upload(path, gz, { contentType: "application/gzip", upsert: false });

        if (upErr) {
          await logEvent(
            ownerId,
            "error",
            "archive_upload_failed",
            `Không tải được gói lưu trữ ${month} của trạm ${station.name} lên Storage: ${upErr.message}`,
            { month, station_id: station.id, path },
            station.id,
          );
          batchFailed = true;
          break;
        }

        const { error: recErr } = await admin.from("telemetry_archives").insert({
          owner_id: ownerId,
          station_id: station.id,
          station_name: station.name,
          month: `${month}-01`,
          storage_path: path,
          row_count: monthRows.length,
          bytes_gzip: gz.byteLength,
          from_ts: monthRows[0].ts,
          to_ts: monthRows[monthRows.length - 1].ts,
        });

        if (recErr) {
          // Object đã nằm trên Storage nhưng không có hàng nào trỏ tới nó →
          // dọn ngay, nếu không sẽ thành file mồ côi chiếm chỗ mãi mãi mà
          // không hiện trong danh sách của người dùng.
          await admin.storage.from(BUCKET).remove([path]);
          await logEvent(
            ownerId,
            "error",
            "archive_record_failed",
            `Không ghi được sổ lưu trữ cho gói ${month} của trạm ${station.name}: ${recErr.message}`,
            { month, station_id: station.id },
            station.id,
          );
          batchFailed = true;
          break;
        }

        budgetLeft -= gz.byteLength;
        result.files += 1;
        result.bytes += gz.byteLength;
        result.archived_rows += monthRows.length;
        archivedIds.push(...monthRows.map((r) => r.id as number));
      }

      // Chỉ xoá đúng những dòng đã có gói lưu trữ trên Storage.
      if (archivedIds.length > 0) {
        const { data: deleted, error: delErr } = await admin.rpc("delete_telemetry_rows", {
          p_ids: archivedIds,
        });
        if (delErr) {
          // Dữ liệu đã an toàn trên Storage rồi; lần chạy sau sẽ lưu trữ lại
          // đúng những dòng này thành gói thứ hai. Thừa, nhưng không mất.
          await logEvent(
            ownerId,
            "warn",
            "archive_delete_failed",
            `Đã lưu trữ ${archivedIds.length} bản ghi của trạm ${station.name} nhưng chưa xoá ` +
              `được khỏi database: ${delErr.message}. Lần chạy sau sẽ thử lại.`,
            { station_id: station.id, rows: archivedIds.length },
            station.id,
          );
          batchFailed = true;
        } else {
          result.deleted_rows += Number(deleted ?? 0);
        }
      }

      if (batchFailed) break;
    }
  }

  await admin
    .from("user_settings")
    .update({ archive_last_run_at: new Date().toISOString() })
    .eq("owner_id", ownerId);

  if (result.archived_rows > 0 || result.deleted_rows > 0) {
    await logEvent(
      ownerId,
      "info",
      archiveEnabled ? "archive_completed" : "purge_completed",
      archiveEnabled
        ? `Đã nén và lưu trữ ${result.archived_rows.toLocaleString("vi-VN")} bản ghi telemetry ` +
          `cũ hơn ${retentionDays} ngày thành ${result.files} gói ` +
          `(${(result.bytes / 1048576).toFixed(1)} MB) và giải phóng khỏi database.`
        : `Đã xoá ${result.deleted_rows.toLocaleString("vi-VN")} bản ghi telemetry cũ hơn ` +
          `${retentionDays} ngày (chế độ lưu trữ đang tắt).`,
      {
        archived_rows: result.archived_rows,
        deleted_rows: result.deleted_rows,
        files: result.files,
        bytes: result.bytes,
        retention_days: retentionDays,
      },
    );
  }

  return result;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return json({ error: "unauthorized" }, 401);

  // Đường 1: pg_cron. So sánh với shared secret riêng chứ không phải service
  // role key — khoá này nằm trong Vault và chỉ mở được đúng một endpoint, lộ
  // ra thì thiệt hại giới hạn ở việc ai đó kích hoạt lượt dọn sớm hơn lịch.
  let owners: string[];
  if (MAINTENANCE_SHARED_SECRET && token === MAINTENANCE_SHARED_SECRET) {
    const { data, error } = await admin.from("user_settings").select("owner_id");
    if (error) return json({ error: "lookup_failed", detail: error.message }, 500);
    owners = (data ?? []).map((r) => r.owner_id as string);
  } else {
    // Đường 2: người dùng bấm "Chạy dọn ngay" trong DevConsole.
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
      global: { headers: { Authorization: auth } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
    owners = [user.id];
  }

  const startedAt = Date.now();
  const results: OwnerResult[] = [];
  for (const ownerId of owners) {
    if (Date.now() - startedAt > DEADLINE_MS) break;
    try {
      results.push(await processOwner(ownerId, startedAt));
    } catch (e) {
      console.error(`archive failed for ${ownerId}:`, e);
      await logEvent(
        ownerId,
        "error",
        "archive_crashed",
        `Lượt dọn dữ liệu dừng giữa chừng: ${e instanceof Error ? e.message : String(e)}`,
      );
      results.push({
        owner_id: ownerId,
        archived_rows: 0,
        deleted_rows: 0,
        files: 0,
        bytes: 0,
        skipped: "error",
      });
    }
  }

  return json({
    ok: true,
    owners: results.length,
    archived_rows: results.reduce((s, r) => s + r.archived_rows, 0),
    deleted_rows: results.reduce((s, r) => s + r.deleted_rows, 0),
    files: results.reduce((s, r) => s + r.files, 0),
    bytes: results.reduce((s, r) => s + r.bytes, 0),
    elapsed_ms: Date.now() - startedAt,
    results,
  });
});
