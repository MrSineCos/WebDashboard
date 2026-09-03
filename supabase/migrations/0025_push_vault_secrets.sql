-- Nạp Vault cho `send-push` bằng cách suy ra từ cặp secret của archive-telemetry.
--
-- Bối cảnh: 0024 mục 4 cần hai secret trong Vault (`send_push_url`,
-- `send_push_key`) thì `dispatch_push()` mới bắn được HTTP. Migration 0024 cố ý
-- không tạo chúng — giá trị là secret thật, viết vào file SQL là commit nó lên
-- Git. Nên hướng dẫn để người triển khai tự chạy `vault.create_secret` bằng tay.
--
-- Bước thủ công đó hỏng theo kiểu tệ nhất có thể: bỏ sót nó KHÔNG gây lỗi ở đâu
-- cả. Cảnh báo vẫn vào database, trigger vẫn chạy, `dispatch_push()` vẫn trả về
-- thành công — nó chỉ lặng lẽ `raise notice` rồi thoát. Người dùng chỉ phát hiện
-- vào lúc có sự cố thật mà không ai được báo, tức là đúng lúc không được phép hỏng.
--
-- Cách thoát: KHÔNG cần viết secret vào file này. Cả hai giá trị đã nằm sẵn
-- trong Vault từ 0019 cho `archive-telemetry`, và 0024 đã chọn dùng CHUNG shared
-- secret với nó (xem chú thích ở mục 4). Nên suy ra được:
--
--   * key = đúng giá trị của `archive_telemetry_key`;
--   * url = url của archive-telemetry, đổi tên function ở cuối đường dẫn.
--
-- Không có secret nào lộ ra trong Git, và môi trường mới dựng sau này chỉ cần
-- `db push` là xong thay vì nhớ một bước thủ công không có gì nhắc.

do $$
declare
  v_archive_url text;
  v_archive_key text;
  v_have_url boolean;
  v_have_key boolean;
begin
  select exists (select 1 from vault.secrets where name = 'send_push_url'),
         exists (select 1 from vault.secrets where name = 'send_push_key')
    into v_have_url, v_have_key;

  if v_have_url and v_have_key then
    raise notice 'send-push: Vault da co du hai secret, khong lam gi';
    return;
  end if;

  begin
    select decrypted_secret into v_archive_url
      from vault.decrypted_secrets where name = 'archive_telemetry_url';
    select decrypted_secret into v_archive_key
      from vault.decrypted_secrets where name = 'archive_telemetry_key';
  exception
    when others then
      raise notice 'send-push: khong doc duoc Vault (thieu quyen?), bo qua';
      return;
  end;

  -- Chưa cấu hình archive-telemetry thì không có gì để suy ra. Nói thẳng phải
  -- làm gì thay vì tạo ra một secret sai rồi để nó hỏng ở tầng dưới.
  if v_archive_url is null or v_archive_key is null then
    raise notice 'send-push: chua co archive_telemetry_url/key trong Vault. '
                 'Tao tay hai secret send_push_url va send_push_key — xem docs/IOT.md muc 15.4.';
    return;
  end if;

  -- Thay đúng tên function ở cuối đường dẫn; phần project-ref và host giữ nguyên
  -- nên không phải hardcode ref của một project cụ thể vào file này.
  if not v_have_url then
    perform vault.create_secret(
      replace(v_archive_url, 'archive-telemetry', 'send-push'),
      'send_push_url'
    );
    raise notice 'send-push: da tao send_push_url';
  end if;

  if not v_have_key then
    perform vault.create_secret(v_archive_key, 'send_push_key');
    raise notice 'send-push: da tao send_push_key';
  end if;
end;
$$;
