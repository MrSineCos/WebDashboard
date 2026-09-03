import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(url && anonKey);

// Đang chạy trong app Windows (Electron) hay trên trình duyệt? Cờ này do
// electron/preload.cjs gắn vào; trên web thì `window.electron` không tồn tại.
export const isElectron = typeof window !== 'undefined' && window.electron?.isElectron === true;

// App Windows bắt buộc dùng luồng PKCE, bản web giữ nguyên luồng implicit mặc
// định. Lý do: đăng nhập Google trong app diễn ra ở trình duyệt ngoài, kết quả
// trả về địa chỉ loopback do tiến trình chính lắng nghe. Luồng implicit đặt
// token trên hash fragment — phần mà trình duyệt KHÔNG BAO GIỜ gửi lên server —
// nên app không thể nhận lại được phiên. PKCE trả `?code=` trên query string,
// tiến trình chính đọc được rồi chuyển vào cửa sổ app để đổi lấy phiên.
//
// Cố ý không đổi luồng của bản web: link xác nhận email / đặt lại mật khẩu của
// luồng implicit mở được ở bất kỳ trình duyệt nào, còn PKCE thì bắt buộc mở
// đúng trình duyệt đã gửi yêu cầu (code verifier nằm trong localStorage của nó).
const options = isElectron ? { auth: { flowType: 'pkce' } } : undefined;

export const supabase = isSupabaseConfigured ? createClient(url, anonKey, options) : null;
