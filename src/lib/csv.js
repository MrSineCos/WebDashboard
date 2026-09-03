// Helpers dùng chung cho các nút "Xuất CSV" trong dashboard.

// Hai hằng dưới đây viết bằng escape ASCII để không lọt ký tự vô hình vào
// source (dễ bị editor hay copy-paste làm hỏng).
const BOM = String.fromCharCode(0xfeff);
// Dấu thanh tiếng Việt sau khi normalize('NFD') nằm trong dải U+0300..U+036F.
const COMBINING_MARKS = new RegExp('[\u0300-\u036f]', 'g');

// RFC 4180: bọc trong dấu nháy kép khi ô chứa dấu phẩy, nháy kép hoặc xuống
// dòng; nháy kép bên trong được nhân đôi. null/undefined -> ô rỗng.
function escapeCell(value) {
  if (value == null) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// `rows` là mảng các mảng ô (đã gồm cả dòng tiêu đề nếu cần); mảng rỗng cho
// ra một dòng trống, dùng để ngăn cách các khối trong báo cáo.
// Ngăn dòng bằng CRLF theo RFC 4180.
export function toCsv(rows) {
  return rows.map((row) => row.map(escapeCell).join(',')).join('\r\n');
}

// Tải chuỗi CSV về máy. BOM UTF-8 ở đầu file là bắt buộc, nếu không Excel
// sẽ đọc tiếng Việt có dấu thành ký tự lỗi.
export function downloadCsv(filename, csv) {
  const blob = new Blob([BOM + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Thu hồi ở tick sau — Safari huỷ tải nếu revoke ngay trong cùng tick.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// Bỏ dấu tiếng Việt + ký tự đặc biệt để tên file an toàn trên mọi hệ điều hành.
export function slugify(text) {
  return String(text)
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'export';
}
