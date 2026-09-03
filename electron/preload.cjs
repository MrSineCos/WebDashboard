// Cầu nối giữa tiến trình chính và giao diện React, chạy trong context cô lập
// (contextIsolation) trước khi trang nạp.
//
// Toàn bộ dữ liệu Supabase vẫn đi thẳng từ renderer qua fetch y hệt bản web —
// preload chỉ mở đúng ba thứ mà bản web không tự làm được: biết mình đang chạy
// trong app, mở trình duyệt hệ thống, và nhận kết quả đăng nhập Google.
const { contextBridge, ipcRenderer } = require('electron');

// Tiến trình chính truyền URL callback qua additionalArguments (electron/main.cjs)
// để hai bên không phải chép cứng cùng một số cổng.
const authRedirectUrl = process.argv
  .find((arg) => arg.startsWith('--auth-redirect-url='))
  ?.slice('--auth-redirect-url='.length) ?? null;

contextBridge.exposeInMainWorld('electron', {
  isElectron: true,
  authRedirectUrl,
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  // Trả về hàm huỷ đăng ký để React gọi trong cleanup của useEffect.
  onOAuthCallback: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('oauth-callback', listener);
    return () => ipcRenderer.off('oauth-callback', listener);
  },
});
