import { useEffect, useState } from 'react';
import { avatarInitial } from '../lib/avatar.js';

// Ảnh đại diện tròn, có 2 lớp phòng vệ mà một thẻ <img> trần không có:
//
//  1. referrerPolicy="no-referrer" — ảnh Google (lh3.googleusercontent.com)
//     trả 403/429 khi request mang theo header Referer của origin lạ
//     (localhost, domain preview…). URL vẫn đúng nhưng ảnh không tải được,
//     đây chính là icon "ảnh vỡ" thấy ở tab Cài đặt.
//  2. onError → rơi về chữ cái đầu. Kể cả khi URL hỏng thật (ảnh Google đã
//     hết hạn, object trong storage bị xoá) thì vẫn thấy một hình tròn tử tế
//     chứ không phải icon ảnh vỡ kèm chữ "alt" tràn ra ngoài.
export default function Avatar({ url, name, email, size = 40, background, color, border, style }) {
  const [failed, setFailed] = useState(false);
  // Đổi ảnh (vừa tải lên ảnh mới) thì cho phép thử lại từ đầu.
  useEffect(() => { setFailed(false); }, [url]);

  const base = {
    width: `${size}px`,
    height: `${size}px`,
    borderRadius: '50%',
    flexShrink: 0,
    ...style,
  };

  if (url && !failed) {
    return (
      <img
        src={url}
        alt="Ảnh đại diện"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        style={{ ...base, objectFit: 'cover', background }}
      />
    );
  }

  return (
    <div
      style={{
        ...base,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: 700,
        fontSize: `${Math.round(size * 0.4)}px`,
        userSelect: 'none',
        background,
        color,
        border,
      }}
    >
      {avatarInitial(name, email)}
    </div>
  );
}
