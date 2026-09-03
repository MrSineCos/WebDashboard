import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabaseClient.js';
import { useAuth } from './AuthContext.jsx';

// Kênh thông báo đẩy phía trình duyệt (Web Push, RFC 8291).
//
// Ba trạng thái tách bạch nhau, đừng gộp lại — mỗi cái hỏng theo một kiểu và
// cần một câu trả lời khác nhau cho người dùng:
//   * `supported`  — trình duyệt có Service Worker + Push API không, và trang
//                    đã được cấu hình khoá VAPID chưa;
//   * `permission` — người dùng đã cho phép hiện thông báo chưa (quyền của
//                    TRÌNH DUYỆT, ứng dụng không tự đặt lại được khi đã bị chặn);
//   * `subscribed` — chính trình duyệt này đã có một hàng trong
//                    `push_subscriptions` chưa (0024).
//
// Một máy có thể `permission = 'granted'` mà vẫn chưa `subscribed` (vừa xoá
// đăng ký), và ngược lại không bao giờ xảy ra.
//
// Công tắc trong Cài đặt điều khiển ĐÚNG MÁY NÀY. `notif_prefs.push` là công
// tắc tổng ở mức tài khoản mà Edge Function `send-push` đọc — hook này KHÔNG tự
// ghi cột đó: `lib/userSettings.js` là nơi duy nhất ghi `notif_prefs` (nó gộp
// đúng các khoá còn lại), nên `enable`/`disable` chỉ trả kết quả về cho nơi gọi
// để nơi đó gọi tiếp setNotifPref. Hai chỗ cùng ghi một jsonb thì chỗ nào ghi
// sau sẽ xoá khoá của chỗ kia.

// `.trim()` vì giá trị đi qua .env → dotenv → bundle, và một khoảng trắng thừa
// ở cuối dòng là thứ không ai nhìn thấy nhưng đủ làm hỏng atob().
const VAPID_PUBLIC_KEY = (import.meta.env.VITE_VAPID_PUBLIC_KEY ?? '').trim();

// Khoá P-256 không nén là 65 byte → đúng 87 ký tự base64url. Kiểm tra độ dài
// ngay từ đầu thay vì để atob() ném ra "The string to be decoded is not
// correctly encoded": lỗi hay gặp nhất ở bước cài đặt là chuỗi bị cắt cụt lúc
// copy từ terminal, và thông báo của trình duyệt không hề gợi ý điều đó.
const VAPID_KEY_LENGTH = 87;

function vapidKeyProblem(key) {
  if (!key) return 'Chưa cấu hình khoá VAPID cho ứng dụng — xem docs/IOT.md mục 15.';
  if (!/^[A-Za-z0-9_-]+$/.test(key)) {
    return 'Khoá VAPID trong .env chứa ký tự không hợp lệ. Chạy lại: node tools/vapid-keys.mjs';
  }
  if (key.length !== VAPID_KEY_LENGTH) {
    return `Khoá VAPID trong .env dài ${key.length} ký tự, cần đúng ${VAPID_KEY_LENGTH} — nhiều khả năng bị cắt cụt lúc copy. Chạy lại: node tools/vapid-keys.mjs`;
  }
  return null;
}

const VAPID_PROBLEM = vapidKeyProblem(VAPID_PUBLIC_KEY);

// applicationServerKey phải là Uint8Array; khoá VAPID công khai lưu dưới dạng
// base64url (không dấu '=' cuối, dùng '-' và '_'), nên phải đổi về base64
// chuẩn trước khi atob() đọc được.
function urlBase64ToUint8Array(base64Url) {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// PushSubscription.getKey() trả ArrayBuffer; database lưu base64url để hàng
// đọc được bằng mắt và đi thẳng vào thư viện web push ở phía Edge Function.
function arrayBufferToBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const BROWSER_SUPPORTED =
  typeof window !== 'undefined' &&
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  'Notification' in window;

export function usePush() {
  const { user } = useAuth();
  // Xem chú thích ở useTelemetry (lib/telemetry.js): effect bám vào user.id để
  // không chạy lại mỗi lần object `user` đổi identity.
  const userId = user?.id ?? null;
  const [permission, setPermission] = useState(() =>
    BROWSER_SUPPORTED ? Notification.permission : 'default',
  );
  const [subscribed, setSubscribed] = useState(false);
  const [deviceCount, setDeviceCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [testResult, setTestResult] = useState('');

  // Khoá hỏng cũng là "chưa cấu hình": công tắc phải mờ đi chứ không được cho
  // bấm rồi mới báo lỗi — bấm vào sẽ xin quyền trình duyệt (một hộp thoại người
  // dùng chỉ được hỏi vài lần trước khi Chrome tự chặn) cho một thao tác chắc
  // chắn thất bại ngay sau đó.
  const configured = BROWSER_SUPPORTED && VAPID_PROBLEM === null;

  // Số thiết bị đang bật của tài khoản — hiện dưới công tắc để người dùng biết
  // họ vừa tắt trên máy này chứ không phải tắt hết mọi nơi.
  const refreshDeviceCount = useCallback(async () => {
    if (!userId || !supabase) return;
    const { count } = await supabase
      .from('push_subscriptions')
      .select('id', { count: 'exact', head: true })
      .eq('owner_id', userId);
    setDeviceCount(count ?? 0);
  }, [userId]);

  useEffect(() => {
    if (!configured || !userId) {
      setLoading(false);
      return;
    }
    let cancelled = false;

    async function check() {
      try {
        const reg = await navigator.serviceWorker.register('/sw.js');
        const sub = await reg.pushManager.getSubscription();
        if (cancelled) return;
        setSubscribed(Boolean(sub));
        // Đăng ký còn trong trình duyệt nhưng hàng trong database đã bị dọn
        // (gửi hỏng nhiều lần, hoặc đổi tài khoản trên cùng máy) → coi như chưa
        // bật, để bấm công tắc lần nữa là tạo lại hàng.
        if (sub && supabase) {
          const { data } = await supabase
            .from('push_subscriptions')
            .select('id')
            .eq('endpoint', sub.endpoint)
            .eq('owner_id', userId)
            .maybeSingle();
          if (!cancelled && !data) setSubscribed(false);
        }
        await refreshDeviceCount();
      } catch (e) {
        if (!cancelled) setError(e?.message || 'Không kiểm tra được trạng thái thông báo.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    check();
    return () => {
      cancelled = true;
    };
  }, [configured, userId, refreshDeviceCount]);

  const enable = useCallback(async () => {
    if (!configured || !userId || !supabase) return;
    setBusy(true);
    setError('');
    setTestResult('');
    try {
      // requestPermission phải được gọi từ một cử chỉ của người dùng — đó là lý
      // do nó nằm ở đây (trong handler của công tắc) chứ không ở useEffect lúc
      // mount. Trình duyệt chặn thẳng lời gọi tự động và Chrome còn phạt trang
      // hay xin quyền mà không có tương tác.
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== 'granted') {
        setError(
          perm === 'denied'
            ? 'Trình duyệt đang chặn thông báo cho trang này. Mở phần cài đặt quyền của trình duyệt (biểu tượng ổ khoá cạnh thanh địa chỉ) để bỏ chặn rồi thử lại.'
            : 'Bạn chưa cho phép hiện thông báo.',
        );
        return;
      }

      const reg = await navigator.serviceWorker.register('/sw.js');
      // Chờ service worker sẵn sàng: subscribe() trên một đăng ký đang ở trạng
      // thái 'installing' sẽ ném lỗi trên Firefox.
      await navigator.serviceWorker.ready;

      // Đăng ký cũ có thể đã gắn với một khoá VAPID khác (khoá bị xoay vòng) —
      // lúc đó subscribe() ném InvalidStateError. Bỏ đăng ký cũ rồi tạo lại.
      let sub = await reg.pushManager.getSubscription();
      if (sub) {
        const currentKey = sub.options?.applicationServerKey;
        const wanted = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
        const same =
          currentKey &&
          new Uint8Array(currentKey).length === wanted.length &&
          new Uint8Array(currentKey).every((b, i) => b === wanted[i]);
        if (!same) {
          await sub.unsubscribe();
          sub = null;
        }
      }
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          // Bắt buộc true trên Chrome: mọi thông báo đẩy phải hiện ra cho người
          // dùng thấy, không được dùng làm kênh chạy nền im lặng.
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        });
      }

      const json = sub.toJSON();
      // Qua RPC chứ không upsert thẳng: trình duyệt trả lại đúng endpoint cũ khi
      // trang đăng ký lại, và endpoint đó có thể đang thuộc về một tài khoản
      // khác từng đăng nhập trên chính máy này — RLS không cho ta ghi đè hàng
      // đó, nên upsert sẽ chết vì trùng khoá. Xem 0024 mục 2b.
      const { error: dbError } = await supabase.rpc('claim_push_subscription', {
        p_endpoint: sub.endpoint,
        p_p256dh: json.keys?.p256dh ?? arrayBufferToBase64Url(sub.getKey('p256dh')),
        p_auth: json.keys?.auth ?? arrayBufferToBase64Url(sub.getKey('auth')),
        p_user_agent: navigator.userAgent,
        p_provider: 'webpush',
      });
      if (dbError) throw dbError;

      setSubscribed(true);
      await refreshDeviceCount();
      return { ok: true };
    } catch (e) {
      setError(e?.message || 'Không bật được thông báo đẩy.');
      return { ok: false };
    } finally {
      setBusy(false);
    }
  }, [configured, userId, refreshDeviceCount]);

  const disable = useCallback(async () => {
    if (!configured || !userId || !supabase) return;
    setBusy(true);
    setError('');
    setTestResult('');
    try {
      const reg = await navigator.serviceWorker.getRegistration('/sw.js');
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
        await sub.unsubscribe();
      }
      setSubscribed(false);

      const { count } = await supabase
        .from('push_subscriptions')
        .select('id', { count: 'exact', head: true })
        .eq('owner_id', userId);
      setDeviceCount(count ?? 0);
      // `remaining` để nơi gọi quyết định có tắt công tắc tổng hay không: tắt
      // trên điện thoại không được phép làm câm luôn cái máy tính ở nhà.
      return { ok: true, remaining: count ?? 0 };
    } catch (e) {
      setError(e?.message || 'Không tắt được thông báo đẩy.');
      return { ok: false };
    } finally {
      setBusy(false);
    }
  }, [configured, userId]);

  // Gửi một thông báo thử qua đúng đường mà cảnh báo thật sẽ đi (Edge Function
  // → push service → service worker). Đây là cách duy nhất để người dùng biết
  // chuỗi này thông trước khi có sự cố thật xảy ra.
  const sendTest = useCallback(async () => {
    if (!supabase) return;
    setBusy(true);
    setError('');
    setTestResult('');
    try {
      const { data, error: fnError } = await supabase.functions.invoke('send-push', {
        body: { test: true },
      });
      if (fnError) throw fnError;
      setTestResult(
        data?.delivered > 0
          ? `Đã gửi tới ${data.delivered} thiết bị. Thông báo sẽ hiện trong vài giây.`
          : 'Máy chủ nhận lệnh nhưng không có thiết bị nào đang đăng ký.',
      );
    } catch (e) {
      setError(e?.message || 'Không gửi được thông báo thử.');
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    supported: BROWSER_SUPPORTED,
    configured,
    // Nói rõ cái gì đang sai với khoá, để giao diện chỉ đúng việc cần làm thay
    // vì một câu "chưa cấu hình" chung cho mọi nguyên nhân.
    configProblem: VAPID_PROBLEM,
    permission,
    subscribed,
    deviceCount,
    loading,
    busy,
    error,
    testResult,
    enable,
    disable,
    sendTest,
  };
}
