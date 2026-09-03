import { Component } from 'react';

// Bắt lỗi phát sinh lúc render và hiện ra thay vì để trắng trang.
//
// Không có nó, một lỗi trong bất kỳ component nào cũng khiến React gỡ toàn bộ
// cây và người dùng nhận được đúng một cửa sổ trắng — không chữ, không mã lỗi,
// không phân biệt nổi với "chưa tải xong" hay "mất mạng". Trong app Windows thì
// còn tệ hơn bản web vì không có sẵn thanh địa chỉ hay F5 để thử lại, và console
// nằm sau một tổ hợp phím không ai biết.
//
// Cố ý hiện luôn thông báo lỗi kỹ thuật: người dùng của dashboard này cũng là
// người dựng ra nó, và một dòng "cannot add postgres_changes callbacks after
// subscribe()" tiết kiệm được hàng giờ so với một màn hình trắng.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[SolGrid] Lỗi khi render:', error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px', fontFamily: "'Manrope',sans-serif", background: 'oklch(97% 0.005 240)' }}>
        <div style={{ maxWidth: '560px', width: '100%', background: 'white', border: '1px solid oklch(91% 0.01 240)', borderRadius: '16px', padding: '32px' }}>
          <h1 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: '19px', fontWeight: 700, margin: '0 0 8px', color: 'oklch(24% 0.04 240)' }}>
            Giao diện gặp lỗi
          </h1>
          <p style={{ fontSize: '13.5px', color: 'oklch(52% 0.02 240)', margin: '0 0 18px', lineHeight: 1.6 }}>
            Ứng dụng không dựng được màn hình này. Thử tải lại; nếu vẫn lỗi, gửi kèm đoạn dưới đây khi báo lỗi.
          </p>
          <pre style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: '12px', lineHeight: 1.55, color: 'oklch(45% 0.15 25)', background: 'oklch(97% 0.01 25)', border: '1px solid oklch(90% 0.04 25)', borderRadius: '9px', padding: '12px 14px', margin: '0 0 20px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '220px', overflow: 'auto' }}>
            {String(this.state.error?.stack || this.state.error?.message || this.state.error)}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{ padding: '11px 20px', borderRadius: '9px', border: 'none', background: 'oklch(54% 0.15 240)', color: 'white', fontSize: '14px', fontWeight: 700, cursor: 'pointer', fontFamily: "'Manrope',sans-serif" }}
          >
            Tải lại
          </button>
        </div>
      </div>
    );
  }
}
