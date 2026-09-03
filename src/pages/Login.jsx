import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useIsMobile } from '../lib/useIsMobile.js';
import { useAuth } from '../lib/AuthContext.jsx';

const NAVY = 'oklch(24% 0.05 240)';
const NAVY_DEEP = 'oklch(20% 0.045 240)';

export default function Login() {
  const isMobile = useIsMobile(860);
  const navigate = useNavigate();
  const { configured, session, role, roleLoading, signInWithGoogle, isElectron, oauthError } = useAuth();
  const [googleSubmitting, setGoogleSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (session && !roleLoading) {
      navigate(role === 'admin' ? '/dev' : '/', { replace: true });
    }
  }, [session, role, roleLoading, navigate]);

  // Trong app Windows, đăng nhập Google diễn ra ở trình duyệt ngoài nên nút bấm
  // ở lại trạng thái chờ cho tới khi có kết quả trả về. Có lỗi thì mở khoá nút
  // để người dùng thử lại được.
  useEffect(() => {
    if (oauthError) setGoogleSubmitting(false);
  }, [oauthError]);

  async function handleGoogleSignIn() {
    setError('');
    setGoogleSubmitting(true);
    const { error: authError } = await signInWithGoogle();
    if (authError) {
      setGoogleSubmitting(false);
      setError(authError.message);
    }
  }

  const pageStyle = {
    minHeight: '100vh',
    display: 'flex',
    flexDirection: isMobile ? 'column' : 'row',
    fontFamily: "'Manrope',sans-serif",
    background: 'oklch(98% 0.004 240)',
  };

  const brandPanelStyle = {
    background: `linear-gradient(160deg, ${NAVY}, ${NAVY_DEEP})`,
    color: 'white',
    flex: isMobile ? '0 0 auto' : '0 0 42%',
    padding: isMobile ? '28px 24px' : '56px 56px',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: isMobile ? 'flex-start' : 'space-between',
    boxSizing: 'border-box',
    gap: isMobile ? '0' : '40px',
  };

  const formPanelStyle = {
    flex: '1',
    display: 'flex',
    alignItems: isMobile ? 'flex-start' : 'center',
    justifyContent: 'center',
    padding: isMobile ? '32px 20px 48px' : '48px 24px',
    boxSizing: 'border-box',
  };

  const logoSize = isMobile ? 34 : 40;

  return (
    <div className="login-page" style={pageStyle}>
      {/* BRAND PANEL */}
      <div style={brandPanelStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <svg width={logoSize} height={logoSize} viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="34" fill="none" stroke="oklch(80% 0.06 240)" strokeWidth="6" />
            <polygon points="56,22 38,54 49,54 44,80 66,46 54,46" fill="oklch(78% 0.13 70)" />
          </svg>
          <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '22px', fontWeight: 700, color: 'white' }}>SolGrid</span>
        </div>

        {!isMobile && (
          <div>
            <h1 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '34px', fontWeight: 700, color: 'white', lineHeight: 1.25, margin: '0 0 16px', maxWidth: '380px' }}>Giám sát &amp; điều khiển microgrid mặt trời của bạn, mọi lúc mọi nơi.</h1>
            <p style={{ fontSize: '15px', color: 'oklch(80% 0.03 240)', lineHeight: 1.7, maxWidth: '360px', margin: '0 0 32px' }}>Theo dõi năng lượng mặt trời, pin lưu trữ và tải tiêu thụ theo thời gian thực qua web &amp; mobile.</p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div style={{ width: '34px', height: '34px', borderRadius: '9px', background: 'oklch(38% 0.07 240)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <svg width="16" height="16" viewBox="0 0 24 24"><path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8" stroke="oklch(78% 0.13 70)" strokeWidth="2" strokeLinecap="round" /><circle cx="12" cy="12" r="4" fill="oklch(78% 0.13 70)" /></svg>
                </div>
                <span style={{ fontSize: '14px', color: 'oklch(88% 0.02 240)' }}>Dữ liệu thời gian thực từ ESP32</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div style={{ width: '34px', height: '34px', borderRadius: '9px', background: 'oklch(38% 0.07 240)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <svg width="16" height="16" viewBox="0 0 24 24"><path d="M6 12l3 3 9-9" stroke="oklch(78% 0.13 70)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" fill="none" /></svg>
                </div>
                <span style={{ fontSize: '14px', color: 'oklch(88% 0.02 240)' }}>Điều khiển tải từ xa</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div style={{ width: '34px', height: '34px', borderRadius: '9px', background: 'oklch(38% 0.07 240)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <svg width="16" height="16" viewBox="0 0 24 24"><path d="M12 3l8 4v5c0 5-3.4 8.4-8 9-4.6-.6-8-4-8-9V7l8-4z" stroke="oklch(78% 0.13 70)" strokeWidth="2" fill="none" /></svg>
                </div>
                <span style={{ fontSize: '14px', color: 'oklch(88% 0.02 240)' }}>Cảnh báo sự cố tức thì</span>
              </div>
            </div>
          </div>
        )}

        {!isMobile && (
          <div style={{ fontSize: '12.5px', color: 'oklch(62% 0.03 240)' }}>© 2026 SolGrid. Giải pháp microgrid cho khu vực nông thôn.</div>
        )}
      </div>

      {/* FORM PANEL */}
      <div style={formPanelStyle}>
        <div style={{ width: '100%', maxWidth: '400px' }}>
          {!configured && (
            <p style={{ fontSize: '13px', color: 'oklch(52% 0.13 70)', background: 'oklch(95% 0.06 70)', borderRadius: '8px', padding: '10px 12px', margin: '0 0 20px' }}>
              Chưa cấu hình Supabase — tạo file <code>.env</code> từ <code>.env.example</code> rồi khởi động lại.
            </p>
          )}
          <h2 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '24px', fontWeight: 700, color: 'oklch(24% 0.04 240)', margin: '0 0 6px' }}>Chào mừng trở lại</h2>
          <p style={{ fontSize: '14px', color: 'oklch(52% 0.02 240)', margin: '0 0 28px' }}>Đăng nhập bằng tài khoản Google để tiếp tục theo dõi hệ thống microgrid.</p>

          <button type="button" onClick={handleGoogleSignIn} disabled={googleSubmitting} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', padding: '13px', borderRadius: '10px', border: '1px solid oklch(88% 0.01 240)', background: 'white', cursor: googleSubmitting ? 'wait' : 'pointer', fontSize: '14.5px', fontWeight: 600, color: 'oklch(28% 0.03 240)', marginBottom: '18px', opacity: googleSubmitting ? 0.7 : 1 }}>
            <svg width="18" height="18" viewBox="0 0 18 18">
              <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84c-.21 1.12-.85 2.08-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z" />
              <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.95v2.33C2.43 15.98 5.48 18 9 18z" />
              <path fill="#FBBC05" d="M3.97 10.72c-.18-.54-.28-1.11-.28-1.72s.1-1.18.28-1.72V4.95H.95C.35 6.17 0 7.55 0 9s.35 2.83.95 4.05l3.02-2.33z" />
              <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0 5.48 0 2.43 2.02.95 4.95l3.02 2.33C4.68 5.16 6.66 3.58 9 3.58z" />
            </svg>
            {googleSubmitting
              ? (isElectron ? 'Đang chờ đăng nhập ở trình duyệt…' : 'Đang chuyển hướng…')
              : 'Tiếp tục với Google'}
          </button>

          {(error || oauthError) && (
            <p style={{ fontSize: '13px', color: 'oklch(50% 0.18 25)', background: 'oklch(93% 0.06 25)', borderRadius: '8px', padding: '10px 12px', margin: '0 0 16px' }}>{error || oauthError}</p>
          )}

          <p style={{ fontSize: '12.5px', color: 'oklch(58% 0.02 240)', lineHeight: 1.7, margin: 0 }}>
            Tài khoản được tạo tự động trong lần đăng nhập Google đầu tiên — không cần đăng ký riêng.
          </p>
        </div>
      </div>
    </div>
  );
}
