import { createContext, useContext, useEffect, useState } from 'react';
import { isSupabaseConfigured, supabase } from './supabaseClient.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [fetchedRole, setFetchedRole] = useState(null);
  const [fetchedRoleUserId, setFetchedRoleUserId] = useState(null);

  useEffect(() => {
    if (!isSupabaseConfigured) return;

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });

    return () => subscription.subscription.unsubscribe();
  }, []);

  const userId = session?.user?.id ?? null;

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    supabase
      .from('profiles')
      .select('role')
      .eq('id', userId)
      .single()
      .then(({ data }) => {
        if (cancelled) return;
        setFetchedRole(data?.role ?? 'user');
        setFetchedRoleUserId(userId);
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
    async signIn(email, password) {
      if (!isSupabaseConfigured) return notConfiguredError;
      return supabase.auth.signInWithPassword({ email, password });
    },
    async signUp(email, password, fullName) {
      if (!isSupabaseConfigured) return notConfiguredError;
      return supabase.auth.signUp({
        email,
        password,
        options: { data: { full_name: fullName } },
      });
    },
    async signOut() {
      if (!isSupabaseConfigured) return notConfiguredError;
      return supabase.auth.signOut();
    },
    async signInWithGoogle() {
      if (!isSupabaseConfigured) return notConfiguredError;
      return supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.origin },
      });
    },
    // --- Liên kết nhiều phương thức đăng nhập vào cùng 1 tài khoản ---
    // Cả linkIdentity lẫn unlinkIdentity đều yêu cầu bật "Enable Manual
    // Linking" trong Supabase (Authentication → Providers). Chưa bật thì
    // GoTrue trả lỗi "Manual linking is disabled" — UI dịch lỗi này ra
    // tiếng Việt thay vì hiện nguyên văn.
    async listIdentities() {
      if (!isSupabaseConfigured) return notConfiguredError;
      return supabase.auth.getUserIdentities();
    },
    async linkGoogle() {
      if (!isSupabaseConfigured) return notConfiguredError;
      // redirectTo quay lại đúng trang cài đặt để người dùng thấy kết quả
      // liên kết ngay, thay vì rơi về Dashboard mặc định.
      return supabase.auth.linkIdentity({
        provider: 'google',
        options: { redirectTo: `${window.location.origin}/?view=settings` },
      });
    },
    async unlinkIdentity(identity) {
      if (!isSupabaseConfigured) return notConfiguredError;
      return supabase.auth.unlinkIdentity(identity);
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
