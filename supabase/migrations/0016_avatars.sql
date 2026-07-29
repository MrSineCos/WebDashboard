-- Ảnh đại diện người dùng: bucket `avatars`.
--
-- Bối cảnh: tab Cài đặt → Tài khoản trước đây chỉ hiển thị lại ảnh Google lấy
-- từ `user_metadata.avatar_url`, còn nút "Đổi ảnh đại diện" không có handler.
-- Migration này làm phần lưu trữ cho luồng tải ảnh lên.
--
-- URL ảnh KHÔNG lưu vào bảng profiles mà lưu ở `user_metadata.custom_avatar_url`
-- (ghi qua supabase.auth.updateUser): sidebar chỉ có object `user` trong tay,
-- không truy vấn bảng profiles, và updateUser phát sự kiện USER_UPDATED giúp
-- mọi nơi hiện ảnh mới ngay lập tức. Nhờ vậy migration này cũng chỉ đụng tới
-- storage, không đổi schema — giao diện chạy được cả trước lẫn sau khi chạy nó
-- (chưa chạy thì chỉ riêng nút tải ảnh báo lỗi, phần còn lại bình thường).
--
-- Vì sao KHÔNG ghi đè `user_metadata.avatar_url`: mỗi lần đăng nhập Google,
-- GoTrue trộn lại claim `picture` từ Google vào đúng key đó — ảnh tự tải lên sẽ
-- biến mất sau lần đăng nhập kế tiếp.

-- ---------------------------------------------------------------------
-- Bucket `avatars`
--
-- PUBLIC (public=true), ngược với bucket `firmware` (0015): ảnh đại diện được
-- nhúng thẳng bằng thẻ <img> nên phải tải được mà không cần header
-- Authorization; signed URL sẽ hết hạn và làm ảnh vỡ. Nội dung cũng không nhạy
-- cảm như ảnh firmware. Đường dẫn có uuid + timestamp nên không đoán được.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatars',
  'avatars',
  true,
  2097152,   -- 2 MB, khớp AVATAR_MAX_BYTES trong src/lib/avatar.js
  array['image/png', 'image/jpeg', 'image/webp', 'image/gif']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Quy ước đường dẫn: `<user_id>/<timestamp>.<ext>` — segment đầu là uuid để
-- storage.foldername() kiểm được quyền, giống bucket `firmware`. Timestamp
-- trong tên file khiến mỗi lần đổi ảnh là một URL mới, tránh việc CDN vẫn trả
-- ảnh cũ khi ghi đè lên cùng một tên.
--
-- `drop ... if exists` để migration chạy lại được.
drop policy if exists "avatars_objects_read_all" on storage.objects;
drop policy if exists "avatars_objects_insert_own" on storage.objects;
drop policy if exists "avatars_objects_update_own" on storage.objects;
drop policy if exists "avatars_objects_delete_own" on storage.objects;

-- Bucket public đã cho đọc ẩn danh qua đường /object/public; policy select này
-- dành cho các API storage khác (list, download có xác thực).
create policy "avatars_objects_read_all" on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'avatars');

create policy "avatars_objects_insert_own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- Có policy update (khác bucket `firmware`, nơi object là bất biến): ảnh đại
-- diện vốn dĩ để thay đổi, và client có thể cần upsert khi tải lại.
create policy "avatars_objects_update_own" on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- Cần cho việc dọn ảnh cũ sau khi tải ảnh mới lên — không có thì mỗi lần đổi
-- ảnh để lại một object mồ côi vẫn tính vào dung lượng.
create policy "avatars_objects_delete_own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
