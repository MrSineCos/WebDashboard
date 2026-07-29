// Nguồn ảnh đại diện của một user, theo thứ tự ưu tiên.
//
// `custom_avatar_url` là ảnh người dùng tự tải lên (bucket `avatars`, xem
// migration 0016) — ưu tiên cao nhất vì đó là lựa chọn có chủ đích, và vì phải
// là một KEY RIÊNG: mỗi lần đăng nhập Google lại, GoTrue ghi đè
// `user_metadata.avatar_url` bằng claim `picture` mới nhất từ Google, nên nếu
// lưu đè lên đúng key đó thì ảnh tự tải lên sẽ bị mất sau lần đăng nhập kế.
//
// Cố tình KHÔNG lọc theo `app_metadata.provider === 'google'`: tài khoản tạo
// bằng email rồi mới liên kết Google vẫn giữ provider = 'email' trong khi
// user_metadata đã có avatar_url — lọc như vậy sẽ giấu mất ảnh hợp lệ.
export function userAvatarUrl(user) {
  const meta = user?.user_metadata;
  if (!meta) return null;
  return meta.custom_avatar_url || meta.avatar_url || meta.picture || null;
}

// Chữ cái hiển thị khi không có ảnh (hoặc ảnh tải hỏng).
export function avatarInitial(...candidates) {
  for (const value of candidates) {
    const ch = typeof value === 'string' ? value.trim()[0] : '';
    if (ch) return ch.toUpperCase();
  }
  return '?';
}

// Giới hạn khớp với cấu hình bucket `avatars` trong migration 0016 — kiểm ở
// client chỉ để báo lỗi tiếng Việt sớm; storage vẫn là chốt chặn thật.
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

// Đổi URL public của bucket `avatars` ngược lại thành object path để xoá được
// ảnh cũ. Trả null nếu URL không phải ảnh nằm trong thư mục của chính user —
// ảnh Google, hay ảnh của người khác, thì không được đụng vào.
export function ownAvatarStoragePath(url, userId) {
  if (typeof url !== 'string' || !userId) return null;
  const marker = '/storage/v1/object/public/avatars/';
  const at = url.indexOf(marker);
  if (at === -1) return null;
  const path = decodeURIComponent(url.slice(at + marker.length).split('?')[0]);
  return path.startsWith(`${userId}/`) ? path : null;
}
