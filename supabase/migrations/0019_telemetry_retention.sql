-- Giữ database trong hạn mức free plan: dọn dữ liệu cũ theo số ngày người dùng
-- đặt trong DevConsole, và trước khi xoá thì nén telemetry theo THÁNG rồi đẩy
-- lên Storage (1 GB free, tách khỏi hạn mức 500 MB của database).
--
-- Vì sao cần: `telemetry` là bảng duy nhất tăng tuyến tính theo thời gian.
-- Firmware publish ~10 giây/lần → 8.640 dòng/ngày/thiết bị; mỗi dòng ~250 byte
-- kể cả hai index của 0003 → ~2,2 MB/ngày/thiết bị. Năm thiết bị chạy liên tục
-- chạm 500 MB sau khoảng sáu tuần, và khi database đầy thì ingest-telemetry
-- bắt đầu lỗi — mất dữ liệu mới chứ không phải dữ liệu cũ.
--
-- Kiến trúc:
--   * Cài đặt số ngày nằm ở `user_settings` (mỗi tài khoản một giá trị) —
--     lưu trữ là chuyện của cả tài khoản, không phải của từng trạm, nên
--     KHÔNG đặt ở `station_settings`: hai trạm cùng chủ mà giữ lịch sử dài
--     ngắn khác nhau thì con số "database còn bao nhiêu chỗ" không ai trả lời
--     được nữa.
--   * Nén + tải lên Storage do Edge Function `archive-telemetry` làm (Postgres
--     không gzip được), pg_cron gọi nó hằng ngày qua pg_net.
--   * Dọn `system_logs` (0018) thì thuần SQL — không có gì phải lưu trữ, log
--     đã hết hạn là bỏ.

-- ---------------------------------------------------------------------
-- 1. Cài đặt retention (mỗi tài khoản một hàng, sẵn có từ 0001)
--
-- Cận dưới 7 ngày: dưới mức đó thì trang Báo cáo (biểu đồ 7/14 ngày qua) mất
-- dữ liệu ngay khi mở. Cận trên 365 ngày: giữ lâu hơn thế trên free plan là
-- tự dẫn mình tới giới hạn, muốn vậy thì nên nâng plan chứ không nên chỉnh số.
-- ---------------------------------------------------------------------
alter table public.user_settings
  add column if not exists telemetry_retention_days integer not null default 30
    check (telemetry_retention_days between 7 and 365),
  -- false = xoá thẳng, không lưu lại gì. Để người dùng chủ động chọn: có người
  -- chỉ cần dashboard chạy được và không quan tâm lịch sử thô.
  add column if not exists telemetry_archive_enabled boolean not null default true,
  add column if not exists log_retention_days integer not null default 30
    check (log_retention_days between 7 and 365),
  -- Thời điểm Edge Function chạy xong lần gần nhất — UI hiển thị để phân biệt
  -- "chưa tới hạn dọn" với "job đã chết mấy hôm nay".
  add column if not exists archive_last_run_at timestamptz;

-- ---------------------------------------------------------------------
-- 2. Sổ theo dõi các gói đã lưu trữ
--
-- Mỗi hàng = một file .csv.gz trên Storage. Không suy ra danh sách bằng cách
-- liệt kê bucket vì (a) cần row_count/khoảng thời gian để UI nói được "gói này
-- chứa gì" mà không phải tải file về, (b) liệt kê Storage không lọc theo RLS
-- của bảng nên sẽ phải tự lọc bằng tay ở client.
--
-- Một tháng có thể gồm NHIỀU file: mỗi lần chạy chỉ xử lý một lô có giới hạn
-- (xem Edge Function) để không vượt bộ nhớ/thời gian của Edge Function. Ghép
-- lại thì phải tải file cũ về, giải nén, nối, nén lại — với file vài chục MB
-- là chắc chắn hết bộ nhớ. Vậy nên: cùng một tháng, nhiều `part`.
-- ---------------------------------------------------------------------
create table public.telemetry_archives (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  -- `on delete set null`: xoá trạm không được làm mất dấu file đã nằm trên
  -- Storage, nếu không sẽ có object mồ côi không ai biết để dọn.
  station_id uuid references public.stations (id) on delete set null,
  station_name text not null default '',
  -- Ngày đầu tháng của dữ liệu bên trong (2026-07-01 cho tháng 7/2026).
  month date not null,
  storage_path text not null unique,
  row_count integer not null check (row_count > 0),
  bytes_gzip bigint not null check (bytes_gzip >= 0),
  from_ts timestamptz not null,
  to_ts timestamptz not null,
  created_at timestamptz not null default now(),
  -- Cùng ràng buộc với firmware_releases (0015): object phải nằm dưới thư mục
  -- mang đúng uuid của chủ sở hữu, khớp policy storage bên dưới.
  constraint telemetry_archives_path_prefix
    check (storage_path like owner_id::text || '/%')
);

create index telemetry_archives_owner_month_idx
  on public.telemetry_archives (owner_id, month desc);

alter table public.telemetry_archives enable row level security;

create policy "telemetry_archives_select_own" on public.telemetry_archives
  for select using (owner_id = auth.uid());
-- Cho phép xoá: người dùng phải tự dọn được gói cũ khi Storage gần đầy. Client
-- xoá object trước rồi mới xoá hàng (xem src/lib/retention.js) — ngược lại sẽ
-- để lại object mồ côi không còn đường tìm ra.
create policy "telemetry_archives_delete_own" on public.telemetry_archives
  for delete using (owner_id = auth.uid());
-- Không có policy insert/update: chỉ Edge Function (service role) ghi vào đây.

-- ---------------------------------------------------------------------
-- 3. Bucket lưu trữ
--
-- PRIVATE, cùng lý do với bucket `firmware` (0015): đây là dữ liệu vận hành
-- của người dùng. Tải về qua signed URL ngắn hạn.
--
-- 50 MB/file: một lô 50.000 dòng CSV nén gzip rơi vào khoảng 1–3 MB, nên mức
-- này là chặn trên rất rộng — nó ở đây để một lỗi nào đó không đẩy nổi cả GB
-- lên trong một lần gọi.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'telemetry-archive',
  'telemetry-archive',
  false,
  52428800,
  array['application/gzip']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "telemetry_archive_select_own" on storage.objects;
drop policy if exists "telemetry_archive_delete_own" on storage.objects;

create policy "telemetry_archive_select_own" on storage.objects
  for select to authenticated
  using (bucket_id = 'telemetry-archive' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "telemetry_archive_delete_own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'telemetry-archive' and (storage.foldername(name))[1] = auth.uid()::text);

-- Cố tình KHÔNG có policy insert cho `authenticated`: chỉ Edge Function được
-- tạo gói lưu trữ. Nếu trình duyệt tải file lên được thì nội dung "bản lưu
-- trữ telemetry" không còn là bằng chứng về dữ liệu đã từng có nữa.

-- ---------------------------------------------------------------------
-- 4. Dọn nhật ký hệ thống (0018) theo `log_retention_days`
-- ---------------------------------------------------------------------
create or replace function public.purge_system_logs()
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_deleted integer;
begin
  delete from public.system_logs l
  using public.user_settings us
  where us.owner_id = l.owner_id
    and l.created_at < now() - make_interval(days => us.log_retention_days);

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- ---------------------------------------------------------------------
-- 5. Lưới an toàn: xoá telemetry quá hạn RẤT lâu, kể cả khi chưa lưu trữ được
--
-- Đường dọn chính là Edge Function (mục 6): nó chỉ xoá sau khi đã tải gói lưu
-- trữ lên thành công. Nhưng nếu Edge Function chưa deploy, secret hết hạn,
-- hoặc Storage đã đầy, thì nó dừng lại — và `telemetry` cứ thế lớn cho tới khi
-- database đầy, lúc đó ingest-telemetry lỗi và ta mất DỮ LIỆU MỚI.
--
-- Đánh đổi ở đây là có chủ đích: sau hạn giữ + 30 ngày ân hạn, dữ liệu chưa
-- lưu trữ được vẫn bị xoá, kèm một dòng log mức 'error' mỗi lần xảy ra. Ba
-- mươi ngày là quãng để nhận ra và sửa (log hiện ngay trên DevConsole); mất
-- dữ liệu thô quá hạn hai tháng vẫn nhẹ hơn mất toàn bộ dữ liệu đang tới.
-- ---------------------------------------------------------------------
create or replace function public.purge_telemetry_overdue(p_grace_days integer default 30)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  r record;
  v_deleted integer;
  v_total integer := 0;
begin
  for r in
    select owner_id, telemetry_retention_days
    from public.user_settings
  loop
    delete from public.telemetry t
    where t.owner_id = r.owner_id
      and t.ts < now() - make_interval(days => r.telemetry_retention_days + p_grace_days);

    get diagnostics v_deleted = row_count;

    if v_deleted > 0 then
      v_total := v_total + v_deleted;
      perform public.log_event(
        r.owner_id, 'error', 'telemetry_hard_purge',
        format('Đã xoá %s bản ghi telemetry quá hạn %s ngày mà CHƯA lưu trữ được lên Storage. '
               || 'Kiểm tra Edge Function archive-telemetry và dung lượng Storage.',
               v_deleted, r.telemetry_retention_days + p_grace_days),
        null, null,
        jsonb_build_object('deleted', v_deleted, 'retention_days', r.telemetry_retention_days,
                           'grace_days', p_grace_days),
        'archive'
      );
    end if;
  end loop;

  return v_total;
end;
$$;

-- ---------------------------------------------------------------------
-- 5b. Xoá theo danh sách id, cho Edge Function gọi sau khi tải gói lên xong
--
-- Vì sao là RPC chứ không phải `.delete().in('id', ids)` của PostgREST: danh
-- sách id đi trong QUERY STRING ở dạng đó, và một lô hai vạn dòng thì URL dài
-- vài trăm KB — vượt giới hạn của gateway. Tham số của RPC đi trong body nên
-- một lô là một lượt gọi.
--
-- Chỉ service role gọi được: đây là đường xoá telemetry hàng loạt, không phải
-- thứ trình duyệt được phép chạm vào.
-- ---------------------------------------------------------------------
create or replace function public.delete_telemetry_rows(p_ids bigint[])
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_deleted integer;
begin
  delete from public.telemetry where id = any(p_ids);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.delete_telemetry_rows(bigint[]) from public;
revoke all on function public.delete_telemetry_rows(bigint[]) from anon;
revoke all on function public.delete_telemetry_rows(bigint[]) from authenticated;
grant execute on function public.delete_telemetry_rows(bigint[]) to service_role;

-- ---------------------------------------------------------------------
-- 6. Gọi Edge Function `archive-telemetry` từ pg_cron
--
-- Postgres không gzip và không nói chuyện được với Storage API, nên phần lưu
-- trữ bắt buộc nằm ở Edge Function; ở đây chỉ có phần hẹn giờ.
--
-- Hai secret phải nạp vào Vault TRƯỚC khi job có tác dụng (xem docs/IOT.md
-- mục 11.2). Đọc thẳng từ Vault chứ không nhúng khoá vào định nghĩa job vì
-- `cron.job` là bảng đọc được — nhúng service role key vào đó là để lộ khoá
-- toàn quyền cho bất kỳ ai xem được bảng đó.
--
--   select vault.create_secret('https://<ref>.supabase.co/functions/v1/archive-telemetry',
--                              'archive_telemetry_url');
--   select vault.create_secret('<MAINTENANCE_SHARED_SECRET>', 'archive_telemetry_key');
-- ---------------------------------------------------------------------
create extension if not exists pg_net;

create or replace function public.run_telemetry_archive()
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
      from vault.decrypted_secrets where name = 'archive_telemetry_url';
    select decrypted_secret into v_key
      from vault.decrypted_secrets where name = 'archive_telemetry_key';
  exception
    when others then
      -- Vault chưa bật / chưa có quyền: coi như chưa cấu hình, mục 5 vẫn giữ
      -- database không phình vô hạn.
      raise notice 'archive-telemetry: khong doc duoc Vault, bo qua lan chay nay';
      return;
  end;

  if v_url is null or v_key is null then
    raise notice 'archive-telemetry: chua nap secret archive_telemetry_url/key vao Vault';
    return;
  end if;

  -- Bắn đi rồi thôi: pg_net trả về request_id và chạy bất đồng bộ. Kết quả
  -- thực sự của lượt dọn nằm ở `system_logs` do chính Edge Function ghi lại —
  -- đó mới là chỗ người dùng nhìn thấy, chứ không phải log của cron.
  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_key
    ),
    body := jsonb_build_object('scope', 'all'),
    timeout_milliseconds := 55000
  );
end;
$$;

-- ---------------------------------------------------------------------
-- 6b. Số liệu dung lượng cho DevConsole
--
-- Trả về một JSON để UI vẽ được thanh "đang dùng bao nhiêu trên hạn mức" mà
-- không phải tự đếm bằng cách kéo dữ liệu về trình duyệt.
--
-- Đếm telemetry qua join `stations` chứ không `where owner_id = auth.uid()`:
-- `telemetry` không có index nào trên owner_id (0003 chỉ index theo
-- station_id/device_id), nên lọc thẳng theo owner sẽ seq-scan cả bảng — đúng
-- cái bảng đang lớn nhất trong database.
--
-- `pg_total_relation_size` là kích thước bảng + index của TOÀN BỘ tài khoản
-- trên instance, không phải phần riêng của người gọi; nhưng chính con số đó
-- mới là thứ đo vào hạn mức 500 MB của free plan, nên đó là số cần hiện.
-- ---------------------------------------------------------------------
create or replace function public.storage_usage()
returns json
language plpgsql
security definer set search_path = public, pg_catalog
as $$
declare
  v_uid uuid := auth.uid();
  v json;
begin
  if v_uid is null then
    raise exception 'unauthorized';
  end if;

  select json_build_object(
    'telemetry_rows', (
      select count(*) from public.telemetry t
      join public.stations s on s.id = t.station_id
      where s.owner_id = v_uid
    ),
    'telemetry_oldest', (
      select min(t.ts) from public.telemetry t
      join public.stations s on s.id = t.station_id
      where s.owner_id = v_uid
    ),
    'telemetry_bytes', pg_total_relation_size('public.telemetry'),
    'logs_rows', (select count(*) from public.system_logs where owner_id = v_uid),
    'logs_bytes', pg_total_relation_size('public.system_logs'),
    'database_bytes', pg_database_size(current_database()),
    'archive_files', (select count(*) from public.telemetry_archives where owner_id = v_uid),
    'archive_rows', (select coalesce(sum(row_count), 0) from public.telemetry_archives where owner_id = v_uid),
    'archive_bytes', (select coalesce(sum(bytes_gzip), 0) from public.telemetry_archives where owner_id = v_uid)
  ) into v;

  return v;
end;
$$;

revoke all on function public.storage_usage() from public;
grant execute on function public.storage_usage() to authenticated;

-- ---------------------------------------------------------------------
-- 7. Lịch chạy
--
-- pg_cron trên Supabase dùng giờ UTC. 19:00 UTC = 02:00 giờ Việt Nam — chọn
-- ban đêm theo giờ địa phương vì lượt lưu trữ đọc và xoá hàng chục nghìn hàng.
-- Ba job cách nhau để không chồng lên nhau trên instance free.
-- ---------------------------------------------------------------------
select cron.schedule(
  'archive-telemetry',
  '0 19 * * *',
  $$select public.run_telemetry_archive()$$
);

select cron.schedule(
  'purge-system-logs',
  '20 19 * * *',
  $$select public.purge_system_logs()$$
);

select cron.schedule(
  'purge-telemetry-overdue',
  '40 19 * * *',
  $$select public.purge_telemetry_overdue()$$
);
