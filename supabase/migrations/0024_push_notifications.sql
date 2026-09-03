-- Thông báo đẩy (push) cho cảnh báo — hoàn thiện thẻ "Tùy chọn thông báo".
--
-- Bối cảnh: sau 0023, cảnh báo đã là dữ liệu thật do database sinh ra, nhưng
-- chỉ tồn tại KHI CÓ NGƯỜI ĐANG MỞ dashboard. Một trạm mất kết nối lúc 2 giờ
-- sáng thì tới sáng hôm sau mới có ai biết. Đó là lỗ hổng thực sự của hệ thống
-- cảnh báo, không phải chuyện tiện nghi.
--
-- Migration này dựng phần database của kênh đẩy: chỗ lưu đăng ký của trình
-- duyệt, một cột đánh dấu "đã báo rồi", và hai đường kích hoạt Edge Function
-- `send-push`. Phần mã hoá và gửi đi nằm ở Edge Function (Postgres không nói
-- được Web Push), cùng cách chia việc với `archive-telemetry` (0019).
--
-- Ba tuỳ chọn cũ ở Cài đặt → Thông báo (`emailAlerts`, `weeklyReport`) bị BỎ:
-- dự án không nối dịch vụ gửi email. Còn lại đúng hai công tắc, và cả hai đều
-- có tác dụng thật — không còn công tắc nào bật lên mà không làm gì.

-- ---------------------------------------------------------------------
-- 1. Dọn hai khoá tuỳ chọn đã bỏ
--
-- `notif_prefs` là jsonb tự do nên hai khoá này không gây lỗi gì nếu để lại,
-- nhưng chúng sẽ nằm đó mãi như bằng chứng về một tính năng chưa từng chạy.
-- Xoá luôn để những gì còn trong cột đúng bằng những gì giao diện hiển thị.
-- ---------------------------------------------------------------------
update public.user_settings
set notif_prefs = notif_prefs - 'emailAlerts' - 'weeklyReport'
where notif_prefs ?| array['emailAlerts', 'weeklyReport'];

-- ---------------------------------------------------------------------
-- 2. push_subscriptions — một hàng = một TRÌNH DUYỆT/THIẾT BỊ đã cho phép
--
-- Không phải một hàng mỗi người dùng: cùng một tài khoản mở trên điện thoại và
-- trên máy tính là hai đăng ký khác nhau, phải nhận được cả hai. Đây cũng là lý
-- do bảng này tách khỏi `user_settings` (vốn đúng một hàng mỗi tài khoản) —
-- công tắc bật/tắt là ý muốn của NGƯỜI, còn đăng ký là năng lực của MÁY.
--
-- Cột `provider` có ngay từ đầu dù hiện chỉ dùng 'webpush'. Khi làm app Android
-- thì token FCM vào đúng bảng này với provider = 'fcm', và `send-push` rẽ nhánh
-- theo cột đó — không phải dựng lại bảng thứ hai và một đường gửi thứ hai song
-- song. Một cột text bây giờ rẻ hơn nhiều so với việc tách đôi về sau.
--
-- `endpoint` với Web Push là URL của push service (FCM/Mozilla/WNS tuỳ trình
-- duyệt); với FCM là registration token. `p256dh`/`auth` là cặp khoá do trình
-- duyệt sinh, dùng để mã hoá payload theo RFC 8291 — chỉ Web Push cần, nên để
-- nullable và ràng buộc theo provider bên dưới.
-- ---------------------------------------------------------------------
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  provider text not null default 'webpush' check (provider in ('webpush', 'fcm')),
  endpoint text not null,
  p256dh text,
  auth text,
  -- Để người dùng nhận ra "đây là máy nào" trong danh sách thiết bị đã bật.
  user_agent text,
  created_at timestamptz not null default now(),
  last_success_at timestamptz,
  -- Đếm lần gửi hỏng liên tiếp. Push service trả 404/410 = đăng ký đã chết hẳn
  -- (người dùng gỡ quyền, xoá dữ liệu trình duyệt) → `send-push` xoá ngay. Các
  -- lỗi khác (mạng, 5xx) chỉ tăng bộ đếm, đủ nhiều mới bỏ.
  failure_count int not null default 0,
  constraint push_subscriptions_webpush_keys
    check (provider <> 'webpush' or (p256dh is not null and auth is not null))
);

-- Một endpoint chỉ thuộc về một hàng. Trình duyệt trả lại đúng endpoint cũ khi
-- trang đăng ký lại (F5, mở tab thứ hai), nên không có ràng buộc này thì mỗi
-- lần tải trang lại đẻ thêm một hàng và người dùng nhận N thông báo trùng nhau.
create unique index if not exists push_subscriptions_endpoint_idx
  on public.push_subscriptions (endpoint);

create index if not exists push_subscriptions_owner_idx
  on public.push_subscriptions (owner_id);

alter table public.push_subscriptions enable row level security;

-- Client được ghi thẳng vào bảng này — khác với `alerts`/`telemetry`. Hợp lý:
-- nội dung ở đây là thứ chính trình duyệt đó vừa tạo ra và chỉ nó biết, không
-- phải bằng chứng về điều đã xảy ra ở trạm. Rủi ro cao nhất khi một người tự
-- thêm hàng là họ tự gửi thông báo cho chính mình.
create policy "push_subscriptions_select_own" on public.push_subscriptions
  for select using (owner_id = auth.uid());

create policy "push_subscriptions_insert_own" on public.push_subscriptions
  for insert with check (owner_id = auth.uid());

create policy "push_subscriptions_update_own" on public.push_subscriptions
  for update using (owner_id = auth.uid());

create policy "push_subscriptions_delete_own" on public.push_subscriptions
  for delete using (owner_id = auth.uid());

-- ---------------------------------------------------------------------
-- 2b. claim_push_subscription — lối ghi duy nhất từ trình duyệt
--
-- Vì sao không upsert thẳng từ client: một endpoint thuộc về đúng MỘT hồ sơ
-- trình duyệt, nhưng một hồ sơ trình duyệt có thể lần lượt đăng nhập nhiều tài
-- khoản (máy dùng chung, hoặc chính chủ có tài khoản thử nghiệm). Khi tài khoản
-- B đăng ký trên máy mà tài khoản A từng đăng ký, endpoint đã có chủ:
--
--   * upsert on conflict (endpoint) không sửa được hàng của A vì RLS không cho
--     B nhìn thấy hàng đó → lỗi trùng khoá, công tắc không bật lên được;
--   * bỏ unique index đi thì cả A lẫn B cùng giữ endpoint ấy, và cảnh báo của A
--     sẽ nảy lên trên màn hình đúng lúc B đang dùng máy.
--
-- "Giành lấy" mới là mô hình đúng: security definer để xoá được hàng cũ bất kể
-- chủ nào, rồi chèn hàng mới cho người gọi. A mất đăng ký trên máy này — đúng
-- như thực tế, vì trình duyệt chỉ giữ một đăng ký cho mỗi khoá VAPID.
-- ---------------------------------------------------------------------
create or replace function public.claim_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_user_agent text default null,
  p_provider text default 'webpush'
)
returns public.push_subscriptions
language plpgsql
security definer set search_path = public
as $$
declare
  v_row public.push_subscriptions;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  delete from public.push_subscriptions where endpoint = p_endpoint;

  insert into public.push_subscriptions (owner_id, provider, endpoint, p256dh, auth, user_agent)
  values (auth.uid(), p_provider, p_endpoint, p_p256dh, p_auth, left(p_user_agent, 300))
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.claim_push_subscription(text, text, text, text, text) from public;
grant execute on function public.claim_push_subscription(text, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 3. alerts.notified_at — đã báo ra ngoài chưa
--
-- Nếu không có cột này thì mỗi lượt quét lại gửi lại toàn bộ cảnh báo đang mở:
-- một trạm offline ba ngày sẽ đẩy thông báo mỗi lần cron chạy cho tới khi người
-- dùng tắt hẳn tính năng. "Đã báo" là thuộc tính của chính đợt cảnh báo nên nó
-- thuộc về bảng này, không phải một bảng nhật ký gửi riêng.
--
-- Cố ý null cho các hàng đã có: chúng là lịch sử, không phải việc cần báo. Mục
-- 5 chỉ gửi cảnh báo mới hơn một khung thời gian ngắn nên chúng không bị dựng
-- dậy — nhưng vẫn được đánh dấu để lượt quét sau khỏi xét lại.
-- ---------------------------------------------------------------------
alter table public.alerts
  add column if not exists notified_at timestamptz;

-- Chỉ mục một phần đúng bằng tập hàng mà `send-push` tìm: hàng chờ gửi luôn là
-- một nhúm rất nhỏ so với cả bảng, nên quét toàn bảng mỗi lần là lãng phí.
create index if not exists alerts_pending_notify_idx
  on public.alerts (started_at)
  where notified_at is null and resolved_at is null;

-- Trigger bảo vệ của 0023 liệt kê từng cột, nên cột mới phải được thêm vào tay.
-- Thiếu bước này thì trình duyệt đặt lại `notified_at := null` được, và mỗi lần
-- làm vậy là một lượt gửi trùng cho tất cả thiết bị của tài khoản đó.
create or replace function public.alerts_protect_columns()
returns trigger
language plpgsql
as $$
begin
  if auth.role() <> 'service_role' then
    new.station_id := old.station_id;
    new.owner_id := old.owner_id;
    new.kind := old.kind;
    new.severity := old.severity;
    new.message := old.message;
    new.value := old.value;
    new.threshold := old.threshold;
    new.meta := old.meta;
    new.started_at := old.started_at;
    new.resolved_at := old.resolved_at;
    new.notified_at := old.notified_at;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 4. Gọi Edge Function `send-push`
--
-- Cùng khuôn Vault + pg_net với `run_telemetry_archive` (0019 mục 6): URL và
-- khoá đọc từ Vault chứ không nhúng vào định nghĩa job/hàm, vì `cron.job` và
-- `pg_proc` đều đọc được.
--
--   select vault.create_secret('https://<ref>.supabase.co/functions/v1/send-push',
--                              'send_push_url');
--   select vault.create_secret('<MAINTENANCE_SHARED_SECRET>', 'send_push_key');
--
-- Dùng lại chính MAINTENANCE_SHARED_SECRET của archive-telemetry — cùng hạng
-- credential (chỉ mở được endpoint bảo trì), thêm một secret nữa chỉ tăng số
-- thứ phải xoay vòng mà không giảm thiệt hại nếu lộ.
-- ---------------------------------------------------------------------
create extension if not exists pg_net;

create or replace function public.dispatch_push()
returns void
language plpgsql
security definer set search_path = public, extensions
as $$
declare
  v_url text;
  v_key text;
begin
  begin
    select decrypted_secret into v_url
      from vault.decrypted_secrets where name = 'send_push_url';
    select decrypted_secret into v_key
      from vault.decrypted_secrets where name = 'send_push_key';
  exception
    when others then
      raise notice 'send-push: khong doc duoc Vault, bo qua';
      return;
  end;

  if v_url is null or v_key is null then
    raise notice 'send-push: chua nap secret send_push_url/key vao Vault';
    return;
  end if;

  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_key
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
end;
$$;

-- ---------------------------------------------------------------------
-- 5. Hai đường kích hoạt
--
-- Đường 1 — trigger ngay khi cảnh báo mở. Một hệ thống cảnh báo mà chờ tới nhịp
-- quét kế tiếp mới báo thì đã đánh mất phần lớn giá trị của nó: người dùng cần
-- biết trạm mất kết nối trong vòng vài giây, không phải "trong vòng 15 phút".
--
-- Chi phí thấp vì `alerts` là bảng ĐỢT, không phải bảng số đo: raise_alert dùng
-- ON CONFLICT DO NOTHING nên bản tin thứ hai trở đi của cùng một sự cố không
-- chèn hàng nào, và trigger AFTER INSERT không chạy khi không có hàng nào được
-- chèn. Một đợt cảnh báo kéo dài cả ngày vẫn chỉ gọi đúng một lần.
--
-- Đường 2 — cron 15 phút, làm lưới an toàn. pg_net bắn đi rồi thôi (không biết
-- kết quả), Edge Function có thể đang deploy dở hoặc hết hạn mức. Không có lưới
-- này thì một lần hỏng là mất hẳn thông báo đó, vì trigger không bao giờ chạy
-- lại cho cùng một hàng.
-- ---------------------------------------------------------------------
create or replace function public.notify_new_alert()
returns trigger
language plpgsql
security definer set search_path = public, extensions
as $$
begin
  -- Lỗi ở đây tuyệt đối không được làm hỏng lượt ghi telemetry đã sinh ra cảnh
  -- báo này: cảnh báo nằm trong database mới là thứ quan trọng, gửi được ra
  -- ngoài hay không là chuyện thứ hai (và cron mục 5 sẽ thử lại).
  begin
    perform public.dispatch_push();
  exception
    when others then
      raise notice 'notify_new_alert: dispatch_push loi, bo qua';
  end;
  return null;
end;
$$;

drop trigger if exists alerts_notify_push on public.alerts;
create trigger alerts_notify_push
  after insert on public.alerts
  for each row execute function public.notify_new_alert();

-- Ba job của 0019 chạy lúc 19:xx UTC mỗi đêm; kênh đẩy phải chạy theo phút nên
-- có lịch riêng. cron.schedule ghi đè job cùng tên nếu đã tồn tại.
select cron.schedule(
  'dispatch-push',
  '*/15 * * * *',
  $$select public.dispatch_push()$$
);

-- Client không được gọi thẳng: đây là đường bắn HTTP kèm credential của hệ
-- thống, không phải một hành động của người dùng. Cùng quy ước với log_event
-- (0018) và raise_alert (0023).
revoke all on function public.dispatch_push() from public;
revoke all on function public.dispatch_push() from authenticated;
revoke all on function public.notify_new_alert() from public;
revoke all on function public.notify_new_alert() from authenticated;
