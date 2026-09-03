// Sinh cặp khoá VAPID cho kênh thông báo đẩy (Web Push).
//
//   node tools/vapid-keys.mjs [email-lien-he]
//
// Script GHI THẲNG ra hai file thay vì in chuỗi để bạn copy tay:
//   * .env       → thêm/cập nhật VITE_VAPID_PUBLIC_KEY (khoá công khai)
//   * .vapid.env → VAPID_KEYS + VAPID_SUBJECT, nạp bằng:
//                    npx supabase secrets set --env-file .vapid.env
//
// Vì sao không in ra màn hình: khoá công khai dài 87 ký tự và khoá riêng là một
// khối JSON dài hơn nữa. Copy tay từ terminal rất dễ đứt giữa chừng khi dòng bị
// wrap, và một chuỗi base64url thiếu vài ký tự cuối vẫn trông "có vẻ đúng" —
// lỗi chỉ lộ ra ở trình duyệt dưới dạng "atob: string not correctly encoded".
//
// Chạy đúng MỘT LẦN cho cả dự án. Sinh cặp mới sẽ làm chết mọi đăng ký hiện có:
// trình duyệt gắn đăng ký với khoá công khai đã dùng lúc subscribe.
//
// Không phụ thuộc thư viện nào: VAPID chỉ là một cặp khoá ECDSA P-256, và
// Web Crypto có sẵn trong Node 18+ sinh được. Định dạng JWK xuất ra ở đây đúng
// bằng thứ `webpush.importVapidKeys()` phía Edge Function nhận vào.

import { webcrypto } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const subject = process.argv[2] || 'mailto:admin@solgrid.local';
if (!subject.startsWith('mailto:') && !subject.startsWith('https://')) {
  console.error(`Địa chỉ liên hệ phải bắt đầu bằng "mailto:" — nhận được: ${subject}`);
  process.exit(1);
}

const pair = await webcrypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  true,
  ['sign', 'verify'],
);

const publicKey = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
const privateKey = await webcrypto.subtle.exportKey('jwk', pair.privateKey);

// `ext`/`key_ops` là siêu dữ liệu của lần xuất này, không phải một phần của
// khoá. Bỏ đi để lần nhập ở phía Edge Function tự quyết định quyền dùng — giữ
// lại `key_ops: ['verify']` có thể làm importKey từ chối khi nó xin quyền khác.
for (const jwk of [publicKey, privateKey]) {
  delete jwk.ext;
  delete jwk.key_ops;
}

// applicationServerKey của trình duyệt cần khoá công khai ở dạng chuỗi base64url
// của điểm P-256 KHÔNG NÉN (65 byte: tiền tố 0x04 + toạ độ x + toạ độ y), không
// phải JWK. JWK đã cho sẵn x và y dưới dạng base64url nên chỉ cần ghép lại.
const x = Buffer.from(publicKey.x, 'base64url');
const y = Buffer.from(publicKey.y, 'base64url');
const uncompressed = Buffer.concat([Buffer.from([0x04]), x, y]);

if (uncompressed.length !== 65) {
  console.error(`Khoá công khai dài ${uncompressed.length} byte, đáng lẽ phải 65. Dừng lại.`);
  process.exit(1);
}

const publicB64 = uncompressed.toString('base64url');
// Chốt chặn cuối: đúng thứ mà lib/push.js sẽ kiểm tra lại ở phía trình duyệt.
if (publicB64.length !== 87) {
  console.error(`Khoá base64url dài ${publicB64.length} ký tự, đáng lẽ phải 87. Dừng lại.`);
  process.exit(1);
}

// --- Ghi .env (giữ nguyên các dòng khác) ---
const ENV_PATH = '.env';
const LINE = `VITE_VAPID_PUBLIC_KEY=${publicB64}`;
let env = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
if (/^VITE_VAPID_PUBLIC_KEY=.*$/m.test(env)) {
  env = env.replace(/^VITE_VAPID_PUBLIC_KEY=.*$/m, LINE);
} else {
  if (env && !env.endsWith('\n')) env += '\n';
  env += LINE + '\n';
}
writeFileSync(ENV_PATH, env);

// --- Ghi .vapid.env cho `supabase secrets set --env-file` ---
// Một dòng một biến, không dấu nháy: đây là định dạng dotenv mà CLI đọc, và
// tránh hẳn chuyện shell quoting làm hỏng khối JSON.
const SECRETS_PATH = '.vapid.env';
writeFileSync(
  SECRETS_PATH,
  `VAPID_KEYS=${JSON.stringify({ publicKey, privateKey })}\n` +
    `VAPID_SUBJECT=${subject}\n`,
);

console.log(`
Đã sinh cặp khoá VAPID mới.

  ✓ ${ENV_PATH}          → VITE_VAPID_PUBLIC_KEY (${publicB64.length} ký tự)
  ✓ ${SECRETS_PATH}    → VAPID_KEYS + VAPID_SUBJECT (${subject})

Còn hai việc:

  1. npx supabase secrets set --env-file ${SECRETS_PATH}
  2. khởi động lại dev server / build lại  (Vite chỉ đọc .env lúc start)

Xong thì xoá ${SECRETS_PATH} — nó chứa khoá RIÊNG. File đã nằm trong .gitignore
nên không lên Git, nhưng không có lý do gì để nó ở lại trên đĩa.
`);
