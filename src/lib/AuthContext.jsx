import { createContext, useContext, useEffect, useState } from 'react';
import { isElectron, isSupabaseConfigured, supabase } from './supabaseClient.js';

const AuthContext = createContext(null);

// Hai phiên có nội dung y hệt nhau không?
//
// Cần đến hàm này vì supabase-js phát LẠI sự kiện `SIGNED_IN` mỗi lần cửa sổ
// được focus trở lại: `_onVisibilityChanged` → `_recoverAndRefresh` đọc phiên
// từ localStorage rồi báo cho mọi subscriber, kể cả khi chẳng có gì thay đổi.
// Object đó là object MỚI sau mỗi lần đọc, nên nếu cứ setState thẳng thì `user`
// đổi identity, mọi useEffect phụ thuộc `user` chạy lại, và toàn bộ dashboard
// nháy về "Đang tải…" mỗi lần người dùng quay lại app.
//
// So sánh cả `user` chứ không chỉ access_token: đổi ảnh đại diện gọi
// auth.updateUser, phát USER_UPDATED với CÙNG access_token nhưng user_metadata
// mới — sự kiện đó phải render lại thì ảnh mới mới hiện ra.
function isSameSession(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.access_token === b.access_token && JSON.stringify(a.user) === JSON.stringify(b.user);
}

// Mở trang đăng nhập của Google trong app Windows.
//
// Trên web, supabase-js tự chuyển hướng cả trang sang Google. Trong app thì
// không được: cửa sổ app phải ở lại đúng chỗ (nó đang giữ code verifier của
// PKCE trong localStorage) và Google cũng chặn đăng nhập trong webview nhúng.
// Nên ta xin URL bằng `skipBrowserRedirect` rồi nhờ tiến trình chính mở nó
// bằng trình duyệt hệ thống.
async function startOAuthInElectron(request) {
  const result = await request({
    redirectTo: window.electron.authRedirectUrl,
    skipBrowserRedirect: true,
  });
  if (result.data?.url) await window.electron.openExternal(result.data.url);
  return result;
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [fetchedRole, setFetchedRole] = useState(null);
  const [fetchedRoleUserId, setFetchedRoleUserId] = useState(null);
  // Lỗi phát sinh SAU khi người dùng rời app sang trình duyệt (từ chối cấp
  // quyền, đổi mã thất bại...). Không thể trả về từ chỗ bấm nút vì lúc đó
  // hàm đã kết thúc từ lâu, nên để ở context cho trang đăng nhập đọc.
  const [oauthError, setOauthError] = useState('');

  useEffect(() => {
    if (!isSupabaseConfigured) return;

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, newSession) => {
      // Giữ nguyên object cũ khi nội dung không đổi — xem isSameSession.
      setSession((prev) => (isSameSession(prev, newSession) ? prev : newSession));
    });

    return () => subscription.subscription.unsubscribe();
  }, []);

  // Nhận kết quả đăng nhập Google do tiến trình chính chuyển vào (app Windows).
  // Việc đổi mã lấy phiên phải làm ở ĐÂY chứ không phải ở tiến trình chính:
  // code verifier của PKCE nằm trong localStorage của chính cửa sổ này.
  useEffect(() => {
    if (!isSupabaseConfigured || !isElectron) return;
    return window.electron.onOAuthCallback(async ({ code, error }) => {
      if (error || !code) {
        setOauthError(error || 'Không nhận được mã xác thực từ Google.');
        return;
      }
      setOauthError('');
      const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
      if (exchangeError) setOauthError(exchangeError.message);
    });
  }, []);

  const userId = session?.user?.id ?? null;

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    const roleCacheKey = `solgrid.auth.role.${userId}`;
    const cachedRole = localStorage.getItem(roleCacheKey);
    if (cachedRole === 'admin' || cachedRole === 'user') {
      setFetchedRole(cachedRole);
      setFetchedRoleUserId(userId);
    }
    supabase
      .from('profiles')
      .select('role')
      .eq('id', userId)
      .single()
      .then(({ data }) => {
        if (cancelled) return;
        // Giữ role đã cache khi app đang ở WiFi local không có Internet. Khi
        // cloud truy cập được, dữ liệu server luôn ghi đè và làm mới cache.
        const nextRole = data?.role ?? cachedRole ?? 'user';
        setFetchedRole(nextRole);
        setFetchedRoleUserId(userId);
        if (data?.role) localStorage.setItem(roleCacheKey, data.role);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  // Derived (not stored in state) so there is no render where a role fetch
  // for the current user is in flight but roleLoading has not flipped true yet.
  const roleLoading = Boolean(userId) && fetchedRoleUserId !== userId;
  const role = roleLoading ? null : fetchedRole;

  const notConfiguredError = { data: {}, error: { message: 'Chưa cấu hình Supabase — xem .env.example.' } };

  const value = {
    configured: isSupabaseConfigured,
    session,
    user: session?.user ?? null,
    loading,
    role,
    roleLoading,
    isAdmin: role === 'admin',
    isElectron,
    oauthError,
    async signOut() {
      if (!isSupabaseConfigured) return notConfiguredError;
      return supabase.auth.signOut();
    },
    async signInWithGoogle() {
      if (!isSupabaseConfigured) return notConfiguredError;
      setOauthError('');
      if (isElectron) {
        return startOAuthInElectron((options) =>
          supabase.auth.signInWithOAuth({ provider: 'google', options }));
      }
      return supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.origin },
      });
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
