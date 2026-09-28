# Chẩn đoán realtime và phạm vi tiếp theo

> [← Quay lại mục lục IoT](../IOT.md)

## 16. Vì sao dashboard "đứng số" rồi chỉ nhảy khi chuyển cửa sổ

Hai lỗi khác nhau chồng lên nhau, và cái thứ hai che mất cái thứ nhất. Ghi lại
đầy đủ vì cả hai đều tái diễn dễ dàng khi thêm bảng/hook mới.

### 16.1 Bảng chưa vào publication → realtime im lặng

`postgres_changes` chỉ nhận được thay đổi của bảng **nằm trong publication**
`supabase_realtime`. Thiếu bảng thì kênh vẫn `subscribe()` thành công và không
báo lỗi gì cả — đơn giản là không sự kiện nào tới. `telemetry` và `loads` được
subscribe từ đầu nhưng chưa migration nào thêm vào; migration `0026` sửa việc
đó (0018 và 0023 đã tự làm phần của mình).

Bảng `stations` còn hỏng theo kiểu nặng hơn: nó **không có subscription nào cả**
— `useStations` chỉ truy vấn một lần lúc mở trang. Trong khi đó mọi thứ đổi
`stations.status` đều chạy phía server (`apply_telemetry` đặt `'online'`,
`mark_stale_offline` của pg_cron đặt `'offline'` sau 90 giây im lặng). Hậu quả:
ESP32 gửi bản tin lên mà ô "Trạng thái hệ thống" vẫn đứng yên; ngắt kết nối thì
chuông cảnh báo kêu đúng giờ (`alerts` đã được publish từ 0023) nhưng ô trạng
thái vẫn ghi "Ổn định". Migration `0027` + subscription trong `lib/stations.js`
sửa việc này.

`devices` hỏng y hệt `stations` và lộ ra ngay sau khi 0027 vá xong: chạy
simulator thì đèn **trạm** chuyển xanh tức thì, còn khối "Tổng quan thiết bị"
trong DevConsole vẫn đứng nguyên — Thời gian hoạt động / Số lần khởi động lại
giữ giá trị lúc mở trang, "Kết nối MQTT Broker" vẫn ghi
`Disconnected`, dòng "nhận dữ liệu N phút trước" cứ già đi. Tất cả những trường
đó là **snapshot do server ghi** (`apply_telemetry` ở 0017, `mark_stale_offline`
ở 0006, `fw_status` ở 0015) nên trình duyệt không có cách nào tự biết. Migration
`0028` + subscription trong `useDevices` (`lib/telemetry.js`) sửa việc này.

**Cột sinh (GENERATED) có thể bị lược khỏi bản tin realtime.** `battery_cycles`
trên `stations` là cột sinh; tuỳ phiên bản Postgres mà replication có gửi kèm
hay không. Dùng thẳng `mapRow(payload.new)` thì ô "Chu kỳ sạc" đang hiện `0.2`
sẽ nhảy về `--` ngay khi có bản tin đầu tiên. `mergeRealtimeRow` giữ giá trị cũ
khi khoá vắng mặt — đúng trong cả hai trường hợp nên không phải phỏng đoán hành
vi của replication.

**Quy tắc:** thêm một `.on('postgres_changes', …)` mới thì phải thêm bảng đó vào
publication trong cùng migration. Và ngược lại — thêm một cột mà **server tự
đổi** (cron, trigger, Edge Function) thì phải hỏi: trình duyệt biết được bằng
cách nào? Nếu không có subscription thì câu trả lời là *không*. Kiểm tra bảng
nào đang được đẩy:

```sql
select tablename from pg_publication_tables where pubname = 'supabase_realtime';
```

Riêng bảng nào subscribe cả `DELETE` **kèm filter** thì cần thêm
`replica identity full` — mặc định bản ghi cũ chỉ mang khoá chính, Realtime
không có cột trong filter để đối chiếu nên loại bỏ luôn sự kiện xoá. Bảng chỉ
INSERT (như `telemetry`) thì không cần, và không nên bật vì WAL sẽ phình ra.

### 16.2 `SIGNED_IN` phát lại mỗi lần focus → cả trang tải lại

supabase-js gắn một listener `visibilitychange`: mỗi lần cửa sổ hiện trở lại,
`_onVisibilityChanged` → `_recoverAndRefresh()` đọc phiên từ localStorage rồi
gọi `_notifyAllSubscribers('SIGNED_IN', …)` — **kể cả khi chẳng có gì đổi**, và
không hề lọc trùng. Object phiên là object mới sau mỗi lần đọc.

Hệ quả dây chuyền: `AuthContext` setState → `user` đổi identity → mọi
`useEffect` có `user` trong mảng phụ thuộc chạy lại → `setLoading(true)` +
truy vấn lại + dựng lại kênh realtime → toàn bộ dashboard nháy về "Đang tải…".
Lượt truy vấn lại đó cũng chính là lý do các ô thông số *có vẻ* cập nhật khi
chuyển cửa sổ qua lại, che mất việc realtime chưa từng chạy (16.1).

Chặn ở hai tầng:

1. `AuthContext.isSameSession` giữ nguyên object phiên cũ khi nội dung không
   đổi. So cả `user` chứ không chỉ `access_token` — đổi ảnh đại diện phát
   `USER_UPDATED` với cùng token nhưng `user_metadata` mới, sự kiện đó **phải**
   đi qua.
2. Mọi hook tải dữ liệu phụ thuộc `user?.id` (chuỗi) thay vì object `user`. Nhờ
   vậy lần làm mới token mỗi giờ cũng không kéo theo một lượt tải lại toàn trang.

**Quy tắc:** trong `src/lib/*`, `useEffect`/`useCallback` không bao giờ nhận
object `user` làm phụ thuộc — dùng `const userId = user?.id ?? null`. Đọc `user`
trực tiếp thì chỉ đọc trong hàm xử lý sự kiện (không phải effect), nơi luôn thấy
giá trị của lần render hiện tại.

### 16.3 Tên kênh realtime phải duy nhất cho từng lần dùng hook

`supabase.channel(topic)` **trả về kênh đang có** nếu trùng tên
(`RealtimeClient.channel` — nó tìm trong `getChannels()` trước khi tạo mới).
Nên nếu một hook đặt tên kênh chỉ theo `userId`/`stationId` mà hook đó chạy hai
bản song song, bản thứ hai sẽ nhận đúng kênh bản thứ nhất đã `subscribe()` xong
và `.on()` ném:

```
Uncaught Error: cannot add `postgres_changes` callbacks for realtime:... after `subscribe()`
```

Lỗi này xảy ra **lúc render**, nên React gỡ toàn bộ cây và người dùng thấy một
cửa sổ trắng trơn — không chữ, không mã lỗi.

`useStations` chính là trường hợp đó: `RequireStation` bọc ngoài gọi nó một lần,
rồi trang bên trong gọi lại qua `useStationSelector`. Hậu tố `useId()` cho mỗi
bản một tên riêng. Trước khi thêm subscription vào một hook, hãy đếm xem hook đó
có thể mount đồng thời mấy bản.

Từ nay `ErrorBoundary` (bọc quanh toàn app trong `main.jsx`) hiện thẳng thông
báo lỗi thay vì để trắng trang — sự cố kiểu này không còn tốn hàng giờ để tìm
ra nữa.

## Ngoài phạm vi (làm sau)
- Kênh gửi email cho cảnh báo — đã **bỏ khỏi phạm vi** (mục 14.5), không phải
  việc còn tồn. Kênh đẩy ở mục 15 thay thế vai trò "báo ra ngoài".
- Thông báo khi cảnh báo **được khắc phục** — hiện chỉ đẩy lúc đợt mở. Cần một
  trigger thứ hai trên `resolve_alert` và một cột đánh dấu riêng.
- Nhánh `provider = 'fcm'` trong `send-push` — dựng sẵn chỗ cắm (mục 15.2) nhưng
  chưa có app Android nào đăng ký token.
- Tự vô hiệu/xoá cert cũ khi "Tạo lại chứng chỉ" (mục 4.4) — hiện mỗi lần cấp
  để lại cert cũ trên AWS, phải tự dọn trong AWS Console. (Cấp cert ngay trong
  DevConsole đã làm xong ở mục 4.4 qua Edge Function `provision-device`.)
- Audit log lịch sử lệnh điều khiển tải (hiện chỉ có 2 cột `desired_state`/`reported_state`, không lưu lịch sử từng lần bấm).
