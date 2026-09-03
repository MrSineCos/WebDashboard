// Tiện ích ngày/giờ theo MÚI GIỜ CỦA TRẠM (`stations.timezone`, migration 0021).
//
// Để HIỂN THỊ một mốc thời gian thì chỉ cần truyền `timeZone` cho
// toLocaleString (xem fmtClock trong Dashboard.jsx) — không cần file này.
//
// File này dành cho những chỗ GOM NHÓM dữ liệu theo lịch: "hôm nay bắt đầu từ
// lúc nào", "bản tin này rơi vào giờ nào", "khung 14 ngày gồm những ngày nào".
// Date.getHours()/getDate() luôn trả lời theo múi giờ TRÌNH DUYỆT, nên nếu để
// nguyên thì người ngồi ở Việt Nam mở trạm đặt tại Tokyo sẽ thấy nhãn trục ghi
// giờ Tokyo trong khi các cột lại được gom theo giờ Việt Nam — lệch đúng 2 giờ,
// và biểu đồ "hôm nay" thì bắt đầu sai chỗ.
//
// Quy ước `tz`: bỏ trống = múi giờ trình duyệt, giống hệt fmtClock.

// Các thành phần lịch của một thời điểm, đọc theo `tz`.
// hourCycle 'h23' để nửa đêm ra 0 chứ không phải 24 (locale en-US mặc định
// dùng đồng hồ 12 giờ, một số engine trả '24' cho 0h ở h24).
function partsIn(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const out = {};
  for (const p of dtf.formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return out;
}

// Chênh lệch giữa `tz` và UTC tại thời điểm `date` (ms, dương = sớm hơn UTC).
// Đọc lại chính thời điểm đó dưới dạng lịch của `tz` rồi coi như đó là giờ UTC
// — hiệu số của hai mốc chính là offset đang áp dụng (đã tính cả DST nếu có).
function offsetMs(date, tz) {
  const p = partsIn(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - (date.getTime() - date.getMilliseconds());
}

function isoOf(p) {
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

// 'YYYY-MM-DD' của `ts` theo `tz` — đây là khóa ngày dùng chung giữa client và
// RPC (tham số p_day của station_hourly_energy), nên phải sinh ra từ lịch của
// trạm chứ không phải Date#toISOString() (vốn luôn là UTC).
export function tzIsoDate(ts, tz) {
  return isoOf(partsIn(new Date(ts), tz));
}

// Giờ trong ngày (0–23) của `ts` theo `tz`.
export function tzHour(ts, tz) {
  return partsIn(new Date(ts), tz).hour;
}

// Mốc 0h00 (giờ `tz`) của ngày chứa `ts`, trả về thời điểm tuyệt đối.
// Tính hai lượt: mốc đoán lần đầu dùng offset tại `ts`, nhưng nếu ngày đó có
// chuyển DST thì offset lúc nửa đêm có thể khác — lượt hai hiệu chỉnh lại bằng
// offset đo tại chính mốc vừa đoán.
export function tzStartOfDay(ts, tz) {
  const date = new Date(ts);
  const p = partsIn(date, tz);
  const midnightAsUtc = Date.UTC(p.year, p.month - 1, p.day);
  const guess = new Date(midnightAsUtc - offsetMs(date, tz));
  return new Date(midnightAsUtc - offsetMs(guess, tz));
}

// `n` ngày gần nhất theo lịch của `tz`, cũ → mới, gồm cả hôm nay.
// Mỗi phần tử: { iso, year, date: 'DD/MM', dow } — `dow` là thứ (0 = Chủ nhật)
// để nơi gọi tự gắn nhãn theo ngôn ngữ của mình.
export function tzDayWindow(n, tz, now = Date.now()) {
  const todayStart = tzStartOfDay(now, tz).getTime();
  const days = [];
  for (let i = n - 1; i >= 0; i--) {
    // Lấy mốc GIỮA ngày (+12h) rồi mới lùi i ngày: cộng/trừ bội số của 24h từ
    // nửa đêm sẽ trượt sang ngày kề nếu quãng đó có chuyển DST, còn giữa trưa
    // thì lệch 1 giờ vẫn nằm trong đúng ngày cần lấy.
    const p = partsIn(new Date(todayStart + 12 * 3600 * 1000 - i * 86400000), tz);
    days.push({
      iso: isoOf(p),
      year: p.year,
      date: `${String(p.day).padStart(2, '0')}/${String(p.month).padStart(2, '0')}`,
      dow: new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay(),
    });
  }
  return days;
}
