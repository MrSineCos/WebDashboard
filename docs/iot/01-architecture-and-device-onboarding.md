# SolGrid IoT — kết nối thiết bị thật (AWS IoT Core → Supabase)

Tài liệu này mô tả cách đưa dữ liệu ESP32 thật vào SolGrid.

## Luồng dữ liệu

```
ESP32 ──MQTT/TLS + X.509 cert──▶ AWS IoT Core ──Rule + HTTPS action──▶ Supabase Edge Function
   (mỗi thiết bị 1 cert)          (broker + auth + rules)  (Bearer secret)   ingest-telemetry
                                                                                   │ service role
                                                                                   ▼
                                     insert telemetry → trigger cập nhật stations + devices
                                                                                   │ RLS (auth.uid)
                                                                                   ▼
                                                                     React dashboard đọc dữ liệu thật
```

Hai tầng xác thực:
1. **Thiết bị ↔ AWS IoT Core**: X.509 mutual TLS, mỗi thiết bị một cert riêng.
2. **AWS IoT Rule ↔ Edge Function**: header `Authorization: Bearer <INGEST_SHARED_SECRET>`.

## 1. Cơ sở dữ liệu

Áp các migration `supabase/migrations/0003_devices_telemetry.sql` và
`0010_loads.sql`:

```bash
supabase db push          # hoặc `supabase db reset` khi dev local
```

Bảng: `devices` (ánh xạ 1 thiết bị ↔ 1 AWS "thing"), `telemetry` (time-series),
`loads` (tải người dùng thêm/xóa ở Dashboard → Điều khiển tải, mỗi tải có
thể gắn `device_id` là ESP32 phụ trách đóng/cắt nó).
RLS trên `devices`/`telemetry` chỉ cho **SELECT** theo `owner_id = auth.uid()`;
mọi ghi đi qua service role. `loads` thì khác — người dùng CRUD trực tiếp
(thêm/xóa/đổi tên/đặt `desired_state`) vì đó là cấu hình của họ; chỉ riêng
`reported_state`/`reported_at` (thiết bị thật sự xác nhận) bị khoá, chỉ
service role ghi được (trigger `loads_protect_reported_columns`).

## 2. Đăng ký thiết bị trong Supabase

Mỗi thiết bị cần một hàng trong `devices`, với `aws_thing_name` **trùng** client id sẽ dùng ở AWS.

**Cách khuyến nghị:** DevConsole → *Quản lý trạm* → chọn trạm → *+ Thêm thiết bị*.
Form này gọi RPC `register_device` (migration `0008_register_device_rpc.sql`),
tự kiểm tra bạn là chủ trạm nên không cần service role. Trang này cũng hiện
sẵn `station-uuid`/`owner-uuid` (có nút copy) nếu bạn cần dùng cho SQL thủ công.

Cách thủ công (fallback, chạy với service role / SQL editor):

```sql
insert into public.devices (station_id, owner_id, name, type, aws_thing_name)
values (
  '<station-uuid>',                       -- trạm thiết bị thuộc về
  '<owner-uuid>',                         -- = stations.owner_id của trạm đó
  'ESP32 Trạm 01', 'esp32',
  'solgrid-esp32-01'                      -- = AWS thing name / MQTT client id
);
```

## 3. Deploy Edge Function

```bash
# Secrets (KHÔNG để trong .env frontend):
supabase secrets set INGEST_SHARED_SECRET="$(openssl rand -hex 32)"
# SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY được nạp tự động trên nền tảng hosted.

# Deploy — tắt verify JWT vì caller là AWS, không phải user Supabase:
supabase functions deploy ingest-telemetry --no-verify-jwt
```

URL sau khi deploy: `https://<project-ref>.functions.supabase.co/ingest-telemetry`.

Test nhanh (giả lập AWS gọi):

```bash
curl -X POST "https://<project-ref>.functions.supabase.co/ingest-telemetry" \
  -H "Authorization: Bearer <INGEST_SHARED_SECRET>" \
  -H "content-type: application/json" \
  -d '{"client_id":"solgrid-esp32-01","solar_kw":2.1,"battery_pct":80,"battery_voltage":48.5}'
# → {"ok":true}; sai secret → 401; client_id lạ → 403
```

## 4. Cấu hình AWS IoT Core

### 4.1 Policy

Tạo IoT policy `solgrid-device-policy` cho phép connect + publish topic riêng của mỗi thiết bị:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "iot:Connect",
      "Resource": "arn:aws:iot:<region>:<account>:client/${iot:Connection.Thing.ThingName}" },
    { "Effect": "Allow", "Action": "iot:Publish",
      "Resource": [
        "arn:aws:iot:<region>:<account>:topic/solgrid/*/telemetry",
        "arn:aws:iot:<region>:<account>:topic/$aws/things/${iot:Connection.Thing.ThingName}/jobs/start-next",
        "arn:aws:iot:<region>:<account>:topic/$aws/things/${iot:Connection.Thing.ThingName}/jobs/*/update"
      ] },
    { "Effect": "Allow", "Action": "iot:Subscribe",
      "Resource": [
        "arn:aws:iot:<region>:<account>:topicfilter/solgrid/${iot:Connection.Thing.ThingName}/command",
        "arn:aws:iot:<region>:<account>:topicfilter/$aws/things/${iot:Connection.Thing.ThingName}/jobs/notify-next",
        "arn:aws:iot:<region>:<account>:topicfilter/$aws/things/${iot:Connection.Thing.ThingName}/jobs/start-next/accepted",
        "arn:aws:iot:<region>:<account>:topicfilter/$aws/things/${iot:Connection.Thing.ThingName}/jobs/start-next/rejected"
      ]
    },
    { "Effect": "Allow", "Action": "iot:Receive",
      "Resource": [
        "arn:aws:iot:<region>:<account>:topic/solgrid/${iot:Connection.Thing.ThingName}/command",
        "arn:aws:iot:<region>:<account>:topic/$aws/things/${iot:Connection.Thing.ThingName}/jobs/notify-next",
        "arn:aws:iot:<region>:<account>:topic/$aws/things/${iot:Connection.Thing.ThingName}/jobs/start-next/accepted",
        "arn:aws:iot:<region>:<account>:topic/$aws/things/${iot:Connection.Thing.ThingName}/jobs/start-next/rejected"
      ]
    }
  ]
}
```

Các quyền Jobs khớp với `esp32s3.ino`: subscribe `notify-next` và phản hồi
`start-next`; publish `start-next` và cập nhật trạng thái từng Job. Chỉ cấp
quyền trên Thing của chính chứng chỉ. `iot:Subscribe` dùng ARN `topicfilter/`,
còn `iot:Publish` và `iot:Receive` dùng ARN `topic/`. Policy này gồm cả hai
kênh vì firmware hỗ trợ AWS IoT Jobs, trong khi Dashboard hiện đẩy OTA qua
topic lệnh trực tiếp `solgrid/<thing>/command` (mục 10.5).

Nếu chứng chỉ đã được cấp từ policy cũ, cập nhật **default version** của policy
đang gắn với chứng chỉ (AWS IoT Core → Security → Certificates → Policies):

```bash
python tools/mqtt-simulator/provision_device.py --sync-policy-only --region <region> --policy-name solgrid-device-policy
```

Lệnh này không tạo Thing hoặc chứng chỉ mới. Cần có AWS credentials với quyền
đọc/tạo policy version và chạy từ thư mục gốc repo sau khi cài
`tools/mqtt-simulator/requirements.txt`. Có thể sửa policy trực tiếp trong AWS
Console. Deploy `provision-device` riêng không cập nhật policy đang chạy; thiết
bị hiện tại chỉ hết reconnect sau khi default version trên AWS đã được đổi.

### 4.2 Provisioning mỗi thiết bị

Trên AWS Console (IoT Core → Manage → Things) hoặc CLI:

```bash
aws iot create-thing --thing-name solgrid-esp32-01
aws iot create-keys-and-certificate --set-as-active \
  --certificate-pem-outfile cert.pem \
  --public-key-outfile pub.key --private-key-outfile priv.key
aws iot attach-policy --policy-name solgrid-device-policy --target <cert-arn>
aws iot attach-thing-principal --thing-name solgrid-esp32-01 --principal <cert-arn>
```

Hoặc chạy 1 lệnh bằng `tools/mqtt-simulator/provision_device.py` (tạo thing
nếu chưa có, tạo policy nếu chưa có, luôn tạo **cert mới** và gắn vào thing —
kể cả khi thing đã tồn tại từ trước và bạn chỉ mất private key cũ):

```bash
cd tools/mqtt-simulator
pip install -r requirements.txt
python provision_device.py --thing-name solgrid-esp32-01 --write-config
```

In ra endpoint + đường dẫn cert để dán vào `config.py`/firmware (dùng
`--write-config` để tự sinh luôn `config.py` cho simulator ở mục 7.1).
Cần AWS credentials của tài khoản bạn (`aws configure`) với quyền quản trị
IoT — khác với cặp `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` chỉ có quyền
`iot:Publish` mà `send-load-command` dùng ở mục 6.2.

Nạp `cert.pem` + `priv.key` + AWS root CA (AmazonRootCA1.pem) vào firmware (mục 5).
**Thing name phải khớp `devices.aws_thing_name` và MQTT client id.**

### 4.3 Rule chuyển tiếp về Supabase

IoT Core → Message routing → Rules → Create:

- **SQL**: `SELECT *, clientid() AS client_id, timestamp() AS ts FROM 'solgrid/+/telemetry'`
- **Action**: HTTPS
  - URL: `https://<project-ref>.supabase.co/functions/v1/ingest-telemetry`
  - Header: `Authorization: Bearer <INGEST_SHARED_SECRET>`
  - **Xác nhận destination:** lần đầu, AWS gửi một request xác nhận tới URL. Edge Function
    đã ghi `enableUrl` ra log. CLI bản hiện tại không có `supabase functions logs`; xem log
    qua Dashboard: **Project → Edge Functions → ingest-telemetry → Logs**, tìm dòng
    `AWS IoT destination confirmation...` rồi mở `enableUrl` một lần trên trình duyệt để
    kích hoạt (destination chuyển sang ENABLED).

### 4.4 Cấp chứng chỉ ngay trong DevConsole (không cần CLI)

Thay cho việc chạy tay `provision_device.py` (mục 4.2), có thể cấp cert thẳng
trong web: **DevConsole → Tổng quan thiết bị → bấm vào thiết bị → "Tạo chứng
chỉ mới"**. Edge Function `provision-device` sẽ tạo thing (nếu chưa có) +
policy + **cert/key mới**, gắn vào thing, rồi trả về 3 khối (Amazon Root CA,
cert.pem, priv.key) + endpoint và một block `secrets.h` sẵn sàng dán vào
firmware (mục 5). Private key chỉ trả về **đúng 1 lần** ra trình duyệt,
**không được lưu** ở server — copy ngay. Mỗi lần bấm lại tạo **thêm** một cert
mới trên AWS (cert cũ vẫn còn cho tới khi tự vô hiệu/xoá trong AWS Console).

Mở modal cũng tự động gọi `provision-device` với `{ action: "list" }` để hỏi
AWS (`ListThingPrincipals` + `DescribeCertificate`) xem thiết bị **đã có cert
nào gắn sẵn chưa** — hiện thành danh sách (id, trạng thái Active/Inactive,
ngày cấp) phía trên nút tạo, mỗi cert có thể bấm xem lại `cert.pem` (phần
certificate là public, AWS cho xem lại thoải mái; chỉ private key là không
bao giờ lấy lại được, đúng giới hạn của AWS).

Function này cần **AWS credentials quyền quản trị IoT** — rộng hơn cặp khoá
`iot:Publish` mà `send-load-command` dùng (mục 6.2): cần `iot:CreateThing`,
`CreateKeysAndCertificate`, `CreatePolicy`, `AttachPolicy`,
`AttachThingPrincipal`, `DescribeEndpoint`, `ListThingPrincipals`,
`DescribeCertificate`, `sts:GetCallerIdentity` — `AWSIoTFullAccess` (policy
quản lý của AWS) là đủ; đúng bằng quyền mà `provision_device.py` cần (mục 4.2)
cộng thêm hai quyền đọc cho phần liệt kê.

```bash
supabase secrets set \
  AWS_PROVISION_REGION="ap-southeast-1" \
  AWS_PROVISION_ACCESS_KEY_ID="..." \
  AWS_PROVISION_SECRET_ACCESS_KEY="..."
# Có verify JWT (mặc định) — chỉ chủ trạm (RLS select-own trên devices) mới
# cấp được cert cho thiết bị của mình:
supabase functions deploy provision-device
```

Nếu không set `AWS_PROVISION_*`, function fallback về `AWS_REGION` /
`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` — nhưng **đừng** tái dùng cặp
khoá publish-only của `send-load-command` vì nó thiếu quyền provisioning.
