-- Nền tảng lưu trữ cho OTA: catalog các bản firmware + nơi cất file .bin +
-- các cột theo dõi phiên bản trên `devices`.
--
-- Bối cảnh: khối "Quản lý Firmware MCU" trong DevConsole tới nay là giao diện
-- demo thuần (hằng số FIRMWARE_DEVICES/FIRMWARE_HISTORY trong DevConsole.jsx,
-- ô kéo-thả .bin không có handler). Migration này làm phần **lưu trữ** — bước
-- 1 của luồng OTA — chưa bao gồm hai phần còn lại (xem "Chưa có" ở cuối file).
--
-- Chia vai giống các cơ chế đã có trong hệ thống:
--   * Cloud → thiết bị (ra lệnh nạp bản nào): `devices.fw_target_id`, do Edge
--     Function đặt bằng service role — cùng chiều với send-load-command (0010)
--     và send-battery-config (0012).
--   * Thiết bị → cloud (đang chạy bản nào, nạp tới đâu): `devices.fw_version`,
--     `fw_status` — THIẾT BỊ là nguồn sự thật, y hệt `ap_ssid` (0014) và
--     `loads.reported_state` (0010). Cloud không được tự suy ra "đã nạp xong"
--     từ việc đã gửi lệnh; chênh lệch giữa fw_target_id và fw_version chính là
--     tín hiệu để phát hiện thiết bị nạp hỏng/không phản hồi.

-- ---------------------------------------------------------------------
-- 1. Catalog các bản firmware đã tải lên.
--
-- Phạm vi theo CHỦ SỞ HỮU chứ không theo trạm: một file .bin gắn với loại
-- board (`firmware/<board>/`), không gắn với một trạm cụ thể — cùng một bản
-- v2.3.1 của esp32s3-solgrid đẩy được cho mọi ESP32 của người đó, ở mọi trạm.
-- ---------------------------------------------------------------------
create table public.firmware_releases (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- Khớp tên thư mục trong repo: 'esp32s3-solgrid'. Một bản .bin build cho
  -- board này KHÔNG nạp được cho board khác (khác partition/flash layout), nên
  -- đây là phần bắt buộc của định danh bản phát hành.
  board text not null check (length(trim(board)) > 0),
  version text not null check (length(trim(version)) > 0),
  -- Đường dẫn object trong bucket `firmware` (mục 3). Quy ước:
  -- `<owner_id>/<board>/<version>.bin` — segment đầu là uuid chủ sở hữu để RLS
  -- của storage.objects kiểm tra được bằng storage.foldername(). Check ràng
  -- buộc dưới đây giữ hai bên (bảng này ↔ policy storage) không lệch nhau.
  storage_path text not null unique,
  size_bytes bigint not null check (size_bytes > 0),
  -- SHA-256 hex thường của đúng file .bin. Firmware tính lại hash khi tải về
  -- và chỉ commit ảnh nếu khớp — chốt chặn cuối chống file hỏng/bị thay giữa
  -- đường, độc lập với TLS.
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  release_notes text,
  created_at timestamptz not null default now(),

  -- Không cho tải lên đè cùng một (board, version): thiết bị đã báo
  -- fw_version='v2.3.1' thì chuỗi đó phải chỉ đúng một binary duy nhất, nếu
  -- không lịch sử phiên bản và rollback đều mất ý nghĩa.
  constraint firmware_releases_board_version_uniq unique (owner_id, board, version),
  -- Giữ storage_path đúng quy ước, khớp policy storage ở mục 3.
  constraint firmware_releases_path_prefix check (storage_path like owner_id::text || '/%')
);

create index firmware_releases_owner_board_idx
  on public.firmware_releases (owner_id, board, created_at desc);

alter table public.firmware_releases enable row level security;

create policy "firmware_releases_select_own" on public.firmware_releases
  for select using (owner_id = auth.uid());
create policy "firmware_releases_insert_own" on public.firmware_releases
  for insert with check (owner_id = auth.uid());
create policy "firmware_releases_update_own" on public.firmware_releases
  for update using (owner_id = auth.uid());
-- Xoá được (dọn bản cũ), nhưng LƯU Ý: xoá hàng ở đây KHÔNG xoá file trong
-- bucket. Client phải gọi storage.remove(storage_path) trước rồi mới xoá hàng,
-- nếu không object thành mồ côi (không có gì trỏ tới nữa nhưng vẫn tính dung
-- lượng). Không làm bằng trigger vì SQL không xoá được object khỏi S3.
create policy "firmware_releases_delete_own" on public.firmware_releases
  for delete using (owner_id = auth.uid());

-- Bản phát hành là BẤT BIẾN về mặt nội dung: chỉ `release_notes` sửa được.
-- Nếu cho đổi sha256/storage_path/version sau khi đã đẩy OTA, thiết bị đang
-- tải dở sẽ kiểm hash theo một giá trị khác với file nó thực sự nhận, và
-- `devices.fw_version` đã báo về sẽ trỏ tới một binary không còn tồn tại.
-- Cùng quy ước với loads_protect_reported_columns() (0010).
create or replace function public.firmware_releases_protect_identity()
returns trigger
language plpgsql
as $$
begin
  new.id := old.id;
  new.owner_id := old.owner_id;
  new.board := old.board;
  new.version := old.version;
  new.storage_path := old.storage_path;
  new.size_bytes := old.size_bytes;
  new.sha256 := old.sha256;
  new.created_at := old.created_at;
  return new;
end;
$$;

create trigger firmware_releases_protect_identity
  before update on public.firmware_releases
  for each row execute function public.firmware_releases_protect_identity();

-- ---------------------------------------------------------------------
-- 2. devices: phiên bản đang chạy + tiến trình nạp.
--
-- `devices` không có policy insert/update cho client (0003) — mọi ghi đi qua
-- service role — nên không cần trigger bảo vệ như `loads`: người dùng vốn đã
-- không tự khai được "thiết bị của tôi đã lên v2.3.1".
-- ---------------------------------------------------------------------
alter table public.devices
  -- Thiết bị tự báo qua telemetry. null = firmware cũ chưa biết báo → UI hiển
  -- thị "chưa báo" thay vì đoán bừa, giống ap_ssid (0014).
  add column if not exists fw_version text,
  add column if not exists fw_reported_at timestamptz,
  -- Bản mà cloud đã ra lệnh nạp. `on delete set null`: xoá một bản phát hành
  -- khỏi catalog không được làm hỏng hàng devices.
  add column if not exists fw_target_id uuid references public.firmware_releases (id) on delete set null,
  -- Tiến trình lần nạp gần nhất. 'pending' do Edge Function đặt lúc publish
  -- lệnh; 4 trạng thái còn lại do chính thiết bị báo về.
  add column if not exists fw_status text not null default 'idle'
    check (fw_status in ('idle', 'pending', 'downloading', 'applying', 'success', 'failed')),
  -- Lý do khi fw_status='failed' (chuỗi tự do do firmware đặt: 'sha_mismatch',
  -- 'http_404', 'no_space'...). UI hiển thị thô nếu không nhận ra.
  add column if not exists fw_status_detail text,
  add column if not exists fw_status_at timestamptz;

create index if not exists devices_fw_target_id_idx on public.devices (fw_target_id);

-- Xoá một bản phát hành khi có thiết bị đang nạp dở nó: FK `on delete set null`
-- gỡ fw_target_id, nhưng fw_status sẽ kẹt ở 'pending'/'downloading' mãi mãi vì
-- không còn gì để hoàn tất. Đánh dấu hỏng luôn — đúng với thực tế: signed URL
-- trỏ tới object đã xoá nên thiết bị chắc chắn tải thất bại.
create or replace function public.devices_clear_fw_target()
returns trigger
language plpgsql
as $$
begin
  if new.fw_target_id is null and old.fw_target_id is not null
     and new.fw_status in ('pending', 'downloading', 'applying') then
    new.fw_status := 'failed';
    new.fw_status_detail := coalesce(new.fw_status_detail, 'release_deleted');
    new.fw_status_at := now();
  end if;
  return new;
end;
$$;

create trigger devices_clear_fw_target
  before update on public.devices
  for each row execute function public.devices_clear_fw_target();

-- ---------------------------------------------------------------------
-- 3. Bucket `firmware` — nơi cất file .bin.
--
-- PRIVATE (public=false), khác với ảnh/avatar: file .bin là ảnh firmware chạy
-- trên phần cứng thật, để public nghĩa là ai đoán ra URL cũng tải về đọc/dịch
-- ngược được (bên trong có thể lộ endpoint, chuỗi cấu hình). Thiết bị tải qua
-- **signed URL ngắn hạn** do Edge Function cấp bằng service role — service
-- role bỏ qua RLS nên các policy dưới đây chỉ chi phối trình duyệt.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'firmware',
  'firmware',
  false,
  16777216,                          -- 16 MB: dư cho app partition của ESP32-S3
                                     -- (~3–4 MB), vẫn chặn file tải nhầm.
  array['application/octet-stream']  -- Client phải upload kèm
                                     -- { contentType: 'application/octet-stream' }.
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Policy trên storage.objects: chỉ thao tác trong bucket `firmware`, và chỉ
-- với những object nằm dưới thư mục mang đúng uuid của mình
-- (`<owner_id>/<board>/<version>.bin` — khớp check firmware_releases_path_prefix).
-- `drop ... if exists` để migration chạy lại được.
drop policy if exists "firmware_objects_select_own" on storage.objects;
drop policy if exists "firmware_objects_insert_own" on storage.objects;
drop policy if exists "firmware_objects_delete_own" on storage.objects;

create policy "firmware_objects_select_own" on storage.objects
  for select to authenticated
  using (bucket_id = 'firmware' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "firmware_objects_insert_own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'firmware' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "firmware_objects_delete_own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'firmware' and (storage.foldername(name))[1] = auth.uid()::text);

-- Cố tình KHÔNG có policy update: một object đã tải lên là bất biến, cùng lý
-- do với trigger firmware_releases_protect_identity ở mục 1. Sửa bản phát
-- hành = tải lên version mới.

-- ---------------------------------------------------------------------
-- Chưa có (làm ở bước sau, xem docs/IOT.md mục 10):
--   * Edge Function `send-ota-command`: cấp signed URL + publish
--     {type:"ota", url, version, sha256} lên solgrid/<thing>/command, đặt
--     fw_target_id/fw_status='pending'.
--   * ingest-telemetry đọc fw_version/fw_status từ payload thiết bị.
--   * Firmware: HTTPUpdate + kiểm SHA-256 + partition 2 slot OTA + rollback.
--   * DevConsole: thay FIRMWARE_DEVICES/FIRMWARE_HISTORY bằng dữ liệu thật.
-- ---------------------------------------------------------------------
