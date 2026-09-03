// Tiến trình chính của app Windows đóng gói quanh Dashboard React hiện có.
//
// Không tải file dist/index.html qua file:// — react-router-dom dùng
// BrowserRouter (đường dẫn thật /battery, /reports,...), thứ này cần một
// origin http(s) thật để điều hướng client-side hoạt động đúng. Vì vậy khi đã
// build, ta tự phục vụ thư mục dist/ qua một HTTP server nội bộ (127.0.0.1,
// cổng cố định) rồi loadURL vào đó — hành vi giống hệt bản web đã deploy.
//
// Server nội bộ này còn kiêm việc nhận kết quả đăng nhập Google (xem
// handleAuthCallback bên dưới), nên nó chạy cả ở chế độ dev lẫn bản đóng gói.
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');

const DEV_SERVER_URL = process.env.ELECTRON_START_URL;
const DIST_DIR = path.join(__dirname, '..', 'dist');

// Cổng CỐ ĐỊNH (không phải ngẫu nhiên): đây là địa chỉ mà Google trả kết quả
// đăng nhập về, và Supabase chỉ chấp nhận redirect tới URL đã khai sẵn trong
// Authentication → URL Configuration. Cổng đổi mỗi lần chạy thì không khai
// trước được, nên phải cố định — khai một lần hai URL dưới đây là dùng mãi.
const PORT = 45679;
const APP_ORIGIN = `http://127.0.0.1:${PORT}`;
// Đường dẫn nhận callback OAuth. Renderer đọc hằng số này qua preload để đặt
// `redirectTo`, nên hai bên luôn khớp nhau (xem electron/preload.cjs).
const AUTH_CALLBACK_PATH = '/auth/callback';
const AUTH_REDIRECT_URL = `${APP_ORIGIN}${AUTH_CALLBACK_PATH}`;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// Trang hiển thị trong TRÌNH DUYỆT sau khi Google trả kết quả về. Cửa sổ app
// mới là nơi phiên đăng nhập thật sự được tạo, nên trang này chỉ cần báo cho
// người dùng biết là xong và quay lại app — cố ý không nhúng dashboard ở đây.
function callbackPage(title, message, ok) {
  return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><title>SolGrid</title></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f1622;color:#fff;font-family:'Segoe UI',system-ui,sans-serif">
  <div style="text-align:center;padding:32px;max-width:420px">
    <div style="font-size:44px;margin-bottom:16px">${ok ? '✓' : '⚠'}</div>
    <h1 style="font-size:21px;margin:0 0 10px">${title}</h1>
    <p style="font-size:14.5px;line-height:1.6;color:#9fb0c6;margin:0">${message}</p>
  </div>
</body></html>`;
}

// Google chuyển hướng trình duyệt về đây kèm `?code=...` (luồng PKCE — xem
// src/lib/supabaseClient.js). Mã này phải được đổi lấy phiên ở PHÍA RENDERER
// chứ không phải ở đây: code verifier của PKCE nằm trong localStorage của cửa
// sổ app, tiến trình chính không có nó. Vậy nên ở đây chỉ chuyển tiếp mã vào
// renderer rồi kéo cửa sổ app lên trước.
function handleAuthCallback(req, res) {
  const { searchParams } = new URL(req.url, APP_ORIGIN);
  const code = searchParams.get('code');
  const error = searchParams.get('error_description') || searchParams.get('error');

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  if (error) {
    res.end(callbackPage('Đăng nhập không thành công', error, false));
  } else if (!code) {
    // Không có `code` nghĩa là client đang chạy luồng implicit — token nằm ở
    // hash fragment, thứ trình duyệt không bao giờ gửi lên server nên app
    // không thể nhận lại được. Nói thẳng nguyên nhân thay vì treo im lặng.
    res.end(callbackPage('Thiếu mã xác thực', 'Phản hồi từ Google không có mã xác thực. Hãy thử đăng nhập lại từ app.', false));
  } else {
    res.end(callbackPage('Đăng nhập thành công', 'Bạn có thể đóng thẻ này và quay lại app SolGrid.', true));
  }

  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('oauth-callback', { code, error });
  focusMainWindow();
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function serveStaticFile(req, res) {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const resolved = path.normalize(path.join(DIST_DIR, urlPath));
  // Chặn path traversal (vd "..%2f..%2f") — resolved phải nằm trong DIST_DIR.
  let filePath = resolved.startsWith(DIST_DIR) ? resolved : DIST_DIR;
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    // Không khớp file tĩnh nào → coi là route của react-router, trả về
    // index.html để app tự điều hướng phía client (lịch sử SPA fallback).
    filePath = path.join(DIST_DIR, 'index.html');
  }
  const ext = path.extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if ((req.url || '/').split('?')[0] === AUTH_CALLBACK_PATH) {
        handleAuthCallback(req, res);
        return;
      }
      // Ở chế độ dev, giao diện được Vite phục vụ tại cổng 5173; server này chỉ
      // tồn tại để bắt callback OAuth, nên dist/ (có thể đã cũ) không được dùng.
      if (DEV_SERVER_URL) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      serveStaticFile(req, res);
    });
    server.on('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

let mainWindow;
let server;

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1024,
    minHeight: 680,
    title: 'SolGrid Dashboard',
    backgroundColor: '#f5f6f8',
    autoHideMenuBar: true,
    // Chỉ hiện cửa sổ khi nội dung đã sẵn sàng vẽ. Hiện ngay từ đầu (mặc định)
    // thì trên Windows cửa sổ có thể đứng nguyên một mảng trắng: khung đã lên
    // màn hình trước khi renderer vẽ khung hình đầu tiên, và tuỳ máy/driver mà
    // nó không tự vẽ lại cho tới khi người dùng chạm vào cửa sổ. Người dùng
    // nhìn thấy "app không load được" dù trang đã tải xong hoàn toàn.
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Preload chạy trong sandbox nên không require được file cục bộ — truyền
      // URL callback qua argv để renderer và tiến trình chính dùng chung đúng
      // một hằng số, thay vì chép cứng cổng ở hai nơi rồi lệch nhau.
      additionalArguments: [`--auth-redirect-url=${AUTH_REDIRECT_URL}`],
    },
  });

  // Link ngoài mở bằng window.open() thì bật trình duyệt hệ thống thay vì tạo
  // cửa sổ Electron mới — cửa sổ app chỉ phục vụ đúng origin nội bộ.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  const appOrigin = DEV_SERVER_URL ? new URL(DEV_SERVER_URL).origin : APP_ORIGIN;

  // Lưới an toàn: nếu có gì đó cố điều hướng cả cửa sổ ra ngoài origin của app
  // (vd một liên kết đăng nhập mở inline), mở bằng trình duyệt hệ thống rồi
  // giữ nguyên cửa sổ app tại chỗ.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin === appOrigin) return;
    event.preventDefault();
    shell.openExternal(url);
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Tải hỏng phải nói ra. Trước đây nhánh này im lặng, và một cửa sổ trắng
  // không kèm thông tin gì là loại sự cố người dùng không thể tự chẩn đoán —
  // không phân biệt được "chưa build dist/" với "sai địa chỉ" hay "lỗi mạng".
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    const message = `Không tải được ${validatedURL}\n${errorDescription} (mã ${errorCode})`;
    console.error('[SolGrid]', message);
    if (!mainWindow.isVisible()) mainWindow.show();
    dialog.showErrorBox('Không tải được giao diện SolGrid', message);
  });

  const target = DEV_SERVER_URL || `${APP_ORIGIN}/`;
  try {
    await mainWindow.loadURL(target);
  } catch (err) {
    console.error('[SolGrid] loadURL thất bại:', target, err);
  }

  // Lưới an toàn cho `show: false`: nếu vì lý do nào đó 'ready-to-show' không
  // bao giờ bắn, thà hiện một cửa sổ chưa vẽ xong còn hơn không hiện gì cả.
  if (!mainWindow.isDestroyed() && !mainWindow.isVisible()) mainWindow.show();
}

// Renderer nhờ mở trang đăng nhập Google bằng trình duyệt hệ thống. Chỉ chấp
// nhận http/https để một URL dựng sai không thể biến thành lệnh mở file hay
// chương trình bất kỳ trên máy.
ipcMain.handle('open-external', (_event, url) => {
  const { protocol } = new URL(url);
  if (protocol !== 'http:' && protocol !== 'https:') return false;
  shell.openExternal(url);
  return true;
});

// Chỉ cho phép MỘT bản chạy cùng lúc. Bắt buộc chứ không phải cho đẹp: server
// loopback dùng cổng cố định (bắt buộc, xem PORT), nên bản thứ hai sẽ không mở
// nổi cổng và trước đây chỉ đứng im không cửa sổ nào — người dùng bấm vào biểu
// tượng mà tưởng như app hỏng. Giờ bản thứ hai bàn giao lại cho bản đang chạy
// rồi tự thoát.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', focusMainWindow);

  app.whenReady()
    .then(async () => {
      server = await startServer();
      await createWindow();
    })
    .catch((err) => {
      // Không nuốt lỗi: khởi động hỏng mà im lặng thì app hiện ra dưới dạng
      // "bấm vào không thấy gì", loại sự cố không thể tự chẩn đoán được.
      dialog.showErrorBox(
        'Không khởi động được SolGrid',
        err?.code === 'EADDRINUSE'
          ? `Cổng ${PORT} đang bị chương trình khác chiếm. Đóng chương trình đó rồi mở lại SolGrid.`
          : String(err?.stack || err),
      );
      app.quit();
    });

  app.on('window-all-closed', () => {
    if (server) server.close();
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}
