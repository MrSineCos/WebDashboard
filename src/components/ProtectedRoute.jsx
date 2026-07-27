import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext.jsx';

const pageStyle = {
  minHeight: '100vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: "'Manrope',sans-serif",
  background: 'oklch(97% 0.005 240)',
  padding: '24px',
};

const cardStyle = {
  maxWidth: '440px',
  textAlign: 'center',
  background: 'white',
  border: '1px solid oklch(91% 0.01 240)',
  borderRadius: '16px',
  padding: '32px',
  boxShadow: '0 1px 2px oklch(0% 0 0 / 0.04)',
};

export default function ProtectedRoute({ children, requireAdmin = false }) {
  const { configured, loading, session, role, roleLoading } = useAuth();
  const location = useLocation();

  if (!configured) {
    return (
      <div style={pageStyle}>
        <div style={cardStyle}>
          <h1 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '18px', fontWeight: 700, margin: '0 0 8px', color: 'oklch(24% 0.04 240)' }}>Chưa cấu hình Supabase</h1>
          <p style={{ fontSize: '14px', color: 'oklch(52% 0.02 240)', margin: 0, lineHeight: 1.6 }}>
            Tạo file <code>.env</code> từ <code>.env.example</code> và điền
            <code> VITE_SUPABASE_URL</code> / <code>VITE_SUPABASE_ANON_KEY</code>, sau đó khởi động lại <code>npm run dev</code>.
          </p>
        </div>
      </div>
    );
  }

  if (loading) return null;

  if (!session) return <Navigate to="/login" replace />;

  // Role decides which surface the user belongs on. Wait for the role fetch
  // so we don't flash the wrong UI (e.g. Google OAuth lands on "/").
  if (roleLoading) return null;

  if (requireAdmin) {
    if (role !== 'admin') return <Navigate to="/" replace />;
  } else if (role === 'admin' && location.pathname === '/' && !location.state?.fromDev && !new URLSearchParams(location.search).has('view')) {
    // Default landing for admins is the Dev Console. They can still reach the
    // user Dashboard on purpose via a link that carries state.fromDev, or via
    // a `?view=` deep link — the OAuth redirect back from linking a Google
    // identity uses the latter, and must not be bounced to the Dev Console.
    return <Navigate to="/dev" replace />;
  }

  return children;
}
