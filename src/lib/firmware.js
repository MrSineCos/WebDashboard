import { useEffect, useState } from 'react';
import { supabase } from './supabaseClient.js';
import { useAuth } from './AuthContext.jsx';

// Catalog bản firmware + đẩy OTA. Ba mảnh của luồng OTA (docs/IOT.md mục 10)
// đã có sẵn ở server — migration 0015 (bảng + bucket), Edge Function
// `send-ota-command` (chiều đẩy), `ingest-telemetry` (chiều thiết bị báo về);
// file này là mảnh còn thiếu ở phía trình duyệt.
//
// Ba thao tác, đúng ba đường khác nhau — không gộp được:
//   * Tải lên  → Storage (file .bin) + insert `firmware_releases` (metadata).
//   * Đẩy OTA  → Edge Function (cần service role để ghi `devices.fw_*`, và cần
//                khoá AWS để publish MQTT — cả hai đều không có ở client).
//   * Trạng thái nạp → đọc thẳng `devices` (RLS select-own), xem useDevices().

// Khớp FW_BOARD trong firmware/esp32s3.ino. Ảnh build cho board khác sẽ bị
// chính firmware từ chối (`board_mismatch`) chứ cloud không kiểm được — bảng
// `devices` chỉ có `type`, không có `board`.
export const DEFAULT_BOARD = 'esp32s3-solgrid';

// Khớp file_size_limit của bucket `firmware` (migration 0015). Kiểm ở client
// chỉ để báo lỗi tiếng Việt sớm; storage vẫn là chốt chặn thật.
export const FIRMWARE_MAX_BYTES = 16 * 1024 * 1024;

// Ba trạng thái "đang dở": lệnh đã rời khỏi cloud nhưng thiết bị chưa chốt
// thành công/thất bại. UI dùng để biết khi nào cần poll lại `devices`.
export const FW_IN_FLIGHT = new Set(['pending', 'downloading', 'applying']);

// `pending` là trạng thái do send-ota-command đặt ("đã gửi lệnh, thiết bị chưa
// lên tiếng") — thiết bị cố tình không được phép tự khai giá trị này, nên nhãn
// phải nói rõ đó là phía cloud, không phải phía thiết bị.
export const FW_STATUS_META = {
  idle: { label: 'Chưa đẩy', color: 'oklch(68% 0.015 250)', bg: 'oklch(26% 0.02 250)' },
  pending: { label: 'Đã gửi lệnh', color: 'oklch(78% 0.14 70)', bg: 'oklch(28% 0.05 70)' },
  downloading: { label: 'Đang tải', color: 'oklch(78% 0.14 70)', bg: 'oklch(28% 0.05 70)' },
  applying: { label: 'Đang nạp', color: 'oklch(78% 0.14 70)', bg: 'oklch(28% 0.05 70)' },
  success: { label: 'Thành công', color: 'oklch(70% 0.15 150)', bg: 'oklch(28% 0.05 150)' },
  failed: { label: 'Thất bại', color: 'oklch(70% 0.16 25)', bg: 'oklch(28% 0.06 25)' },
};

// `fw_status_detail` là chuỗi tự do do firmware đặt (setFwStatus trong
// esp32s3.ino) — dịch các trường hợp đã biết, giữ nguyên chuỗi thô cho phần
// còn lại thay vì nuốt mất thông tin chẩn đoán.
const FW_DETAIL_TEXT = {
  board_mismatch: 'ảnh build cho board khác — kiểm tra lại trường Board',
  sha_mismatch: 'hash không khớp, file tải về hỏng — đẩy lại',
  size_mismatch: 'dung lượng tải về khác với bản đã đăng ký',
  no_space: 'phân vùng OTA không đủ chỗ — chọn Partition Scheme có 2 app slot',
  no_content_length: 'máy chủ không trả Content-Length',
  http_begin: 'không mở được kết nối HTTPS tới Storage',
  wifi_down: 'thiết bị mất WiFi giữa chừng',
  bad_sha256_field: 'lệnh gửi xuống thiếu/sai trường sha256',
  bad_command: 'lệnh OTA không hợp lệ',
  activate_failed: 'không kích hoạt được phân vùng vừa ghi',
  already_running: 'thiết bị đã chạy đúng bản này',
  ota_not_configured: 'firmware thiếu SUPABASE_ROOT_CA (docs/IOT.md mục 10.7)',
  release_deleted: 'bản phát hành bị xoá khi thiết bị đang nạp dở',
};

export function fwStatusDetailText(detail) {
  if (!detail) return '';
  if (FW_DETAIL_TEXT[detail]) return FW_DETAIL_TEXT[detail];
  // Firmware sinh động `http_<mã>` khi tải file thất bại. 403 gần như luôn là
  // signed URL đã hết hạn trước khi thiết bị kịp tải (thiết bị offline lúc
  // publish rồi lên mạng muộn) — đẩy lại là có URL mới.
  const http = /^http_(\d+)$/.exec(detail);
  if (http) {
    const code = http[1];
    if (code === '403') return 'link tải đã hết hạn — đẩy lại để cấp link mới';
    if (code === '404') return 'file .bin không còn trong bucket';
    return `máy chủ trả lỗi HTTP ${code}`;
  }
  return detail;
}

export function formatBytes(n) {
  const size = Number(n) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(2)} MB`;
}

// board/version đi thẳng vào đường dẫn object (`<owner>/<board>/<version>.bin`)
// nên phải chặn ký tự có thể phá cấu trúc thư mục — RLS của storage.objects
// kiểm quyền bằng segment đầu của đường dẫn, một `..` lọt qua là hỏng cả ràng
// buộc đó lẫn check `firmware_releases_path_prefix`.
const PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;

function badSegment(value) {
  return !PATH_SEGMENT.test(value) || /^\.+$/.test(value);
}

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function mapRow(row) {
  return {
    id: row.id,
    board: row.board,
    version: row.version,
    storagePath: row.storage_path,
    sizeBytes: Number(row.size_bytes) || 0,
    sha256: row.sha256,
    releaseNotes: row.release_notes,
    createdAt: row.created_at,
  };
}

const OTA_ERROR_TEXT = {
  invalid_params: 'Chưa chọn bản firmware để đẩy.',
  need_device_id_or_station_id: 'Phải chọn đúng một đích: một thiết bị, hoặc cả trạm.',
  release_not_found: 'Bản phát hành không còn tồn tại — tải lại trang.',
  release_object_missing: 'File .bin của bản này không còn trong bucket. Xoá bản phát hành rồi tải lên lại.',
  no_target_device: 'Trạm này chưa có thiết bị ESP32 nào — chỉ ESP32 mới nhận được OTA.',
  publish_failed: 'Không gửi được lệnh tới AWS IoT. Kiểm tra secrets AWS_* của send-ota-command (docs/IOT.md mục 10.5).',
  unauthorized: 'Phiên đăng nhập đã hết hạn — đăng nhập lại.',
};

function otaErrorText(code, detail) {
  if (OTA_ERROR_TEXT[code]) return OTA_ERROR_TEXT[code];
  // Function chưa deploy là lỗi hay gặp nhất khi mới nối UI này vào — thông
  // báo mặc định của supabase-js ("Failed to send a request…") không nói ra.
  if (/failed to send|not found|404/i.test(code || '')) {
    return 'Không gọi được Edge Function send-ota-command — đã deploy chưa? (docs/IOT.md mục 10.5)';
  }
  return [code, detail].filter(Boolean).join(' — ') || 'Không đẩy được OTA, vui lòng thử lại.';
}

function uploadErrorText(error) {
  const raw = error?.message ?? '';
  if (/bucket not found/i.test(raw)) {
    return 'Chưa có bucket `firmware` trên máy chủ. Chạy migration 0015_firmware_ota.sql rồi thử lại.';
  }
  if (/already exists|duplicate/i.test(raw)) {
    return 'Đã có file cho đúng board + phiên bản này. Bản phát hành là bất biến — tăng số phiên bản thay vì tải đè.';
  }
  if (/mime type/i.test(raw)) {
    return 'Bucket chỉ nhận application/octet-stream — file này không phải ảnh firmware .bin.';
  }
  if (/payload too large|exceeded the maximum|file size/i.test(raw)) {
    return `File vượt quá giới hạn ${formatBytes(FIRMWARE_MAX_BYTES)} của bucket.`;
  }
  if (/row-level security|not authorized|violates/i.test(raw)) {
    return 'Không có quyền tải lên bucket `firmware`. Kiểm tra policy trong migration 0015.';
  }
  return raw || 'Không tải được file lên, vui lòng thử lại.';
}

function insertErrorText(error) {
  const raw = error?.message ?? '';
  if (/firmware_releases_board_version_uniq|duplicate key/i.test(raw)) {
    return 'Đã có bản phát hành với đúng board + phiên bản này. Tăng số phiên bản thay vì tải đè.';
  }
  return raw || 'Không lưu được thông tin bản phát hành.';
}

// Các bản firmware của người dùng đang đăng nhập. Phạm vi theo CHỦ SỞ HỮU chứ
// không theo trạm (migration 0015): một .bin gắn với loại board, đẩy được cho
// mọi ESP32 cùng loại ở mọi trạm — nên hook này không nhận stationId.
export function useFirmwareReleases() {
  const { user } = useAuth();
  const [releases, setReleases] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    async function load() {
      const { data } = await supabase
        .from('firmware_releases')
        .select('*')
        .order('created_at', { ascending: false });
      if (cancelled) return;
      setReleases((data || []).map(mapRow));
      setLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [user]);

  // Hai bước không nguyên tử: file vào bucket trước, rồi mới tới hàng metadata.
  // Thứ tự này là bắt buộc — `firmware_releases.storage_path` phải trỏ tới một
  // object có thật, nếu không "Đẩy OTA" sẽ cấp signed URL cho file rỗng.
  async function uploadRelease({ file, board, version, releaseNotes }) {
    if (!user) return { error: new Error('Chưa đăng nhập.') };
    if (!file) return { error: new Error('Chưa chọn file .bin.') };

    const cleanBoard = (board || '').trim();
    const cleanVersion = (version || '').trim();
    if (!cleanBoard || !cleanVersion) return { error: new Error('Nhập đủ Board và Phiên bản.') };
    if (badSegment(cleanBoard) || badSegment(cleanVersion)) {
      return { error: new Error('Board và Phiên bản chỉ được gồm chữ, số, dấu chấm, gạch ngang và gạch dưới.') };
    }
    if (file.size === 0) return { error: new Error('File rỗng.') };
    if (file.size > FIRMWARE_MAX_BYTES) {
      return { error: new Error(`File ${formatBytes(file.size)} vượt giới hạn ${formatBytes(FIRMWARE_MAX_BYTES)} của bucket.`) };
    }

    // Hash tính từ chính bytes sắp tải lên (không phải từ file trên đĩa lúc
    // khác) — firmware kiểm lại đúng chuỗi này trước khi kích hoạt ảnh, nên
    // hai bên phải nói về cùng một mảng byte.
    let sha256;
    try {
      sha256 = await sha256Hex(await file.arrayBuffer());
    } catch {
      return { error: new Error('Trình duyệt không băm được file — Web Crypto cần HTTPS hoặc localhost.') };
    }

    const path = `${user.id}/${cleanBoard}/${cleanVersion}.bin`;
    const { error: upErr } = await supabase.storage
      .from('firmware')
      .upload(path, file, { contentType: 'application/octet-stream' });
    if (upErr) return { error: new Error(uploadErrorText(upErr)) };

    const { data, error } = await supabase
      .from('firmware_releases')
      .insert({
        board: cleanBoard,
        version: cleanVersion,
        storage_path: path,
        size_bytes: file.size,
        sha256,
        release_notes: (releaseNotes || '').trim() || null,
      })
      .select()
      .single();

    if (error) {
      // Object vừa tạo trong chính lệnh này chưa có hàng nào trỏ tới — dọn đi
      // trước khi báo lỗi, nếu không nó thành mồ côi (docs/IOT.md mục 10.4).
      // `upload` không ghi đè nên object này chắc chắn không thuộc bản khác.
      await supabase.storage.from('firmware').remove([path]);
      return { error: new Error(insertErrorText(error)) };
    }

    const mapped = mapRow(data);
    setReleases((prev) => [mapped, ...prev]);
    return { data: mapped };
  }

  // Xoá file TRƯỚC rồi mới xoá hàng: SQL không xoá được object khỏi bucket nên
  // không có trigger nào dọn hộ, làm ngược lại là để lại file mồ côi vĩnh viễn.
  // Thiết bị đang nạp dở bản này sẽ được trigger devices_clear_fw_target đánh
  // 'failed' — đúng thực tế, vì signed URL của nó giờ trỏ vào hư không.
  async function deleteRelease(id) {
    const release = releases.find((r) => r.id === id);
    if (!release) return { error: new Error('Không tìm thấy bản phát hành.') };

    const { error: rmErr } = await supabase.storage.from('firmware').remove([release.storagePath]);
    if (rmErr) return { error: new Error(`Không xoá được file trong bucket — ${rmErr.message}`) };

    const { error } = await supabase.from('firmware_releases').delete().eq('id', id);
    if (error) return { error: new Error(error.message) };

    setReleases((prev) => prev.filter((r) => r.id !== id));
    return {};
  }

  // Đúng MỘT trong `deviceId` / `stationId` — Edge Function từ chối nếu nhận cả
  // hai hoặc không nhận gì, vì đây là thao tác ghi lên phần cứng thật.
  //
  // Trả về { published, failed, failed_devices, version } chứ không phải "đã
  // nạp xong": hàm này chỉ biết lệnh đã tới AWS. Thiết bị báo ngược fw_version/
  // fw_status qua telemetry — đọc ở useDevices().
  async function pushOta({ releaseId, deviceId, stationId }) {
    if (!releaseId) return { error: new Error(OTA_ERROR_TEXT.invalid_params) };
    const body = { release_id: releaseId };
    if (deviceId) body.device_id = deviceId;
    else body.station_id = stationId;

    const { data, error } = await supabase.functions.invoke('send-ota-command', { body });
    if (error) {
      // Non-2xx → FunctionsHttpError với data=null; JSON body thật ({error,
      // detail}) nằm trên error.context. Cùng cách bóc lỗi như invokeProvision
      // trong lib/telemetry.js.
      let code = error.message;
      let detail = '';
      try {
        const parsed = await error.context?.json?.();
        if (parsed?.error) {
          code = parsed.error;
          detail = parsed.detail || '';
        }
      } catch { /* body không phải JSON — giữ error.message */ }
      return { error: new Error(otaErrorText(code, detail)) };
    }
    if (data?.error) return { error: new Error(otaErrorText(data.error, data.detail)) };
    return { data };
  }

  return { releases, loading, uploadRelease, deleteRelease, pushOta };
}
