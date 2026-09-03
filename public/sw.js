// Service worker — chỉ để nhận thông báo đẩy.
//
// Cố ý KHÔNG cache gì cả: dashboard đọc dữ liệu realtime từ Supabase, một bản
// cache của trang sẽ hiển thị số đo cũ mà trông y như số đo mới — với một hệ
// thống giám sát năng lượng thì đó tệ hơn hẳn là báo lỗi mạng.
//
// File này nằm ở public/ nên Vite chép nguyên văn ra dist/ và nó được phục vụ
// tại /sw.js — đúng gốc site, điều kiện bắt buộc để service worker có scope cho
// toàn bộ ứng dụng.

// Kích hoạt bản mới ngay thay vì chờ mọi tab cũ đóng lại. Không có hai dòng này
// thì sau khi deploy, người dùng vẫn chạy service worker cũ cho tới lần đóng
// hẳn trình duyệt — có thể là hàng tuần.
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  // Payload do Edge Function send-push gửi. Push service có thể gửi tới một
  // thông báo rỗng (kiểm tra sức khoẻ endpoint), nên phải chịu được cả trường
  // hợp không có data.
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'SolGrid', body: event.data ? event.data.text() : '' };
  }

  const title = payload.title || 'SolGrid';
  const options = {
    body: payload.body || '',
    icon: '/favicon.svg',
    badge: '/favicon.svg',
    // Cùng `tag` = thay thế thông báo cũ thay vì xếp chồng. Mỗi đợt cảnh báo có
    // tag riêng nên hai sự cố khác nhau vẫn hiện thành hai dòng.
    tag: payload.tag || 'solgrid',
    // Cảnh báo nghiêm trọng ở lại màn hình cho tới khi người dùng chạm vào —
    // một sự cố mất điện toàn trạm không nên tự biến mất sau vài giây.
    requireInteraction: payload.severity === 'danger',
    data: { url: payload.url || '/' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';

  // Ưu tiên chuyển hướng một tab đang mở sẵn thay vì mở tab thứ hai của cùng
  // một ứng dụng — bấm vào ba thông báo không nên để lại ba tab SolGrid.
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (new URL(client.url).origin === self.location.origin && 'focus' in client) {
          if ('navigate' in client) client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
