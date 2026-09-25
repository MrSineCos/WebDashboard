#!/usr/bin/env python3
"""
SolGrid — tự động hoá việc cấp một "thing" + chứng chỉ X.509 trên AWS IoT Core
(thay cho việc gõ tay 4 lệnh `aws iot ...` ở docs/IOT.md mục 4.2).

Idempotent theo thing: nếu --thing-name đã tồn tại (VD bạn tạo tay trên AWS
Console như "solgrid-esp32-01"), script KHÔNG tạo lại thing, chỉ tạo một cert
+ key MỚI rồi gắn (attach) vào thing đó — đúng thứ bạn cần khi đã mất private
key cũ (AWS chỉ cho tải private key đúng 1 lần lúc tạo, không lấy lại được).

Cần: AWS credentials của TÀI KHOẢN CỦA BẠN (không phải cặp khoá
AWS_ACCESS_KEY_ID/SECRET dùng cho Supabase Edge Function — cái đó chỉ có
quyền publish, còn script này cần quyền quản trị IoT: CreateThing,
CreateKeysAndCertificate, CreatePolicy, AttachPolicy, AttachThingPrincipal,
DescribeEndpoint). Cấu hình qua `aws configure` hoặc biến môi trường
AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY/AWS_DEFAULT_REGION như bình thường.

Cài đặt:
    pip install -r requirements.txt

Chạy:
    python provision_device.py --thing-name solgrid-esp32-01
    python provision_device.py --thing-name solgrid-esp32-02 --write-config
"""

import argparse
import json
import sys
import urllib.request
from pathlib import Path

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

DEFAULT_POLICY_NAME = "solgrid-device-policy"
ROOT_CA_URL = "https://www.amazontrust.com/repository/AmazonRootCA1.pem"
# Không để boto3 treo vô hạn nếu mạng/proxy có vấn đề — timeout rõ ràng và
# báo lỗi thay vì im lặng chờ (đây là nguyên nhân màn hình đứng yên không in
# gì: lệnh AWS đầu tiên — sts get-caller-identity — chạy trước print đầu
# tiên trong main()).
BOTO_CONFIG = Config(connect_timeout=10, read_timeout=15, retries={"max_attempts": 2})


def policy_document(region, account_id):
    # Khớp docs/IOT.md mục 4.1 — các topic Jobs chỉ thuộc Thing của chứng chỉ.
    return json.dumps({
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Action": "iot:Connect",
                "Resource": f"arn:aws:iot:{region}:{account_id}:client/${{iot:Connection.Thing.ThingName}}",
            },
            {
                "Effect": "Allow",
                "Action": "iot:Publish",
                "Resource": [
                    f"arn:aws:iot:{region}:{account_id}:topic/solgrid/*/telemetry",
                    f"arn:aws:iot:{region}:{account_id}:topic/$aws/things/${{iot:Connection.Thing.ThingName}}/jobs/start-next",
                    f"arn:aws:iot:{region}:{account_id}:topic/$aws/things/${{iot:Connection.Thing.ThingName}}/jobs/*/update",
                ],
            },
            {
                "Effect": "Allow",
                "Action": "iot:Subscribe",
                "Resource": [
                    f"arn:aws:iot:{region}:{account_id}:topicfilter/solgrid/${{iot:Connection.Thing.ThingName}}/command",
                    f"arn:aws:iot:{region}:{account_id}:topicfilter/$aws/things/${{iot:Connection.Thing.ThingName}}/jobs/notify-next",
                    f"arn:aws:iot:{region}:{account_id}:topicfilter/$aws/things/${{iot:Connection.Thing.ThingName}}/jobs/start-next/accepted",
                    f"arn:aws:iot:{region}:{account_id}:topicfilter/$aws/things/${{iot:Connection.Thing.ThingName}}/jobs/start-next/rejected",
                ],
            },
            {
                "Effect": "Allow",
                "Action": "iot:Receive",
                "Resource": [
                    f"arn:aws:iot:{region}:{account_id}:topic/solgrid/${{iot:Connection.Thing.ThingName}}/command",
                    f"arn:aws:iot:{region}:{account_id}:topic/$aws/things/${{iot:Connection.Thing.ThingName}}/jobs/notify-next",
                    f"arn:aws:iot:{region}:{account_id}:topic/$aws/things/${{iot:Connection.Thing.ThingName}}/jobs/start-next/accepted",
                    f"arn:aws:iot:{region}:{account_id}:topic/$aws/things/${{iot:Connection.Thing.ThingName}}/jobs/start-next/rejected",
                ],
            },
        ],
    })


def ensure_thing(iot, thing_name):
    try:
        iot.describe_thing(thingName=thing_name)
        print(f"Thing '{thing_name}' đã tồn tại — bỏ qua bước tạo, chỉ cấp cert mới.")
    except ClientError as e:
        if e.response["Error"]["Code"] != "ResourceNotFoundException":
            raise
        iot.create_thing(thingName=thing_name)
        print(f"Đã tạo thing '{thing_name}'.")


def ensure_policy(iot, policy_name, document):
    try:
        iot.create_policy(policyName=policy_name, policyDocument=document)
        print(f"Đã tạo policy '{policy_name}'.")
        return
    except ClientError as e:
        if e.response["Error"]["Code"] != "ResourceAlreadyExistsException":
            raise

    # Policy trùng tên đã tồn tại (VD tạo tay từ trước, thiếu quyền
    # Subscribe/Receive cho topic lệnh điều khiển tải) — so với bản default
    # hiện tại, nếu khác thì tạo version mới đúng nội dung và set làm
    # default, thay vì im lặng giữ policy cũ thiếu quyền (lỗi ở bản trước
    # của script này — gây AWS ngắt kết nối khi thiết bị subscribe topic
    # không được phép).
    versions = iot.list_policy_versions(policyName=policy_name)["policyVersions"]
    default_version_id = next(v["versionId"] for v in versions if v["isDefaultVersion"])
    current_doc = iot.get_policy_version(policyName=policy_name, policyVersionId=default_version_id)["policyDocument"]

    if json.loads(current_doc) == json.loads(document):
        print(f"Policy '{policy_name}' đã tồn tại và đã đúng nội dung mới nhất.")
        return

    if len(versions) >= 5:
        oldest = min((v for v in versions if not v["isDefaultVersion"]), key=lambda v: v["versionId"])
        iot.delete_policy_version(policyName=policy_name, policyVersionId=oldest["versionId"])

    iot.create_policy_version(policyName=policy_name, policyDocument=document, setAsDefault=True)
    print(f"Policy '{policy_name}' đã tồn tại nhưng thiếu quyền mới (VD Subscribe/Receive) — đã tạo version mới và set làm default.")


def create_and_attach_cert(iot, thing_name, policy_name):
    cert = iot.create_keys_and_certificate(setAsActive=True)
    cert_arn = cert["certificateArn"]
    iot.attach_policy(policyName=policy_name, target=cert_arn)
    iot.attach_thing_principal(thingName=thing_name, principal=cert_arn)
    print(f"Đã tạo cert mới và gắn vào thing '{thing_name}' + policy '{policy_name}'.")
    return cert


def download_root_ca(dest):
    if dest.exists():
        return
    print(f"Tải Amazon Root CA1 -> {dest}")
    urllib.request.urlretrieve(ROOT_CA_URL, dest)


def write_config(out_dir, endpoint, thing_name, station_slug):
    example = Path(__file__).parent / "config.example.py"
    target = Path(__file__).parent / "config.py"
    if target.exists():
        print(f"'{target.name}' đã tồn tại — không ghi đè, tự cập nhật giá trị bên dưới thủ công.")
        return
    text = example.read_text(encoding="utf-8")
    text = text.replace(
        'AWS_IOT_ENDPOINT = "xxxxxxxxxx-ats.iot.ap-southeast-1.amazonaws.com"',
        f'AWS_IOT_ENDPOINT = "{endpoint}"',
    )
    text = text.replace('THING_NAME = "solgrid-esp32-01"', f'THING_NAME = "{thing_name}"')
    text = text.replace('STATION_SLUG = "tram01"', f'STATION_SLUG = "{station_slug}"')
    text = text.replace("./certs/AmazonRootCA1.pem", str(out_dir / "AmazonRootCA1.pem"))
    text = text.replace("./certs/cert.pem", str(out_dir / f"{thing_name}-cert.pem"))
    text = text.replace("./certs/priv.key", str(out_dir / f"{thing_name}-priv.key"))
    target.write_text(text, encoding="utf-8")
    print(f"Đã sinh '{target.name}' — chỉ còn thiếu RELAYS nếu bạn cần test điều khiển tải.")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--thing-name", help="Tên thing = client id = devices.aws_thing_name (bắt buộc khi tạo cert)")
    parser.add_argument("--station-slug", default="tram01", help="Dùng dựng topic solgrid/<slug>/telemetry")
    parser.add_argument("--policy-name", default=DEFAULT_POLICY_NAME)
    parser.add_argument("--region", default=None, help="Mặc định lấy từ AWS config/profile hiện tại")
    parser.add_argument("--out-dir", default="./certs", help="Nơi lưu cert/key/CA")
    parser.add_argument("--write-config", action="store_true", help="Sinh config.py từ config.example.py nếu chưa có")
    parser.add_argument("--sync-policy-only", action="store_true", help="Chỉ cập nhật policy hiện có; không tạo thing hoặc cert mới")
    args = parser.parse_args()
    if not args.sync_policy_only and not args.thing_name:
        parser.error("--thing-name is required unless --sync-policy-only is used")
    print("Bắt đầu provisioning...", flush=True)

    session = boto3.Session(region_name=args.region)
    region = session.region_name
    if not region:
        sys.exit("Không xác định được AWS region — truyền --region hoặc chạy `aws configure`.")
    print(f"Region: {region}", flush=True)

    iot = session.client("iot", config=BOTO_CONFIG)
    print("Đang xác thực với AWS (sts get-caller-identity)...", flush=True)
    try:
        account_id = session.client("sts", config=BOTO_CONFIG).get_caller_identity()["Account"]
    except Exception as e:
        sys.exit(
            f"Không gọi được AWS STS: {e}\n"
            "Kiểm tra: `aws sts get-caller-identity` chạy trực tiếp có được không? "
            "Nếu cũng treo/lỗi thì đây là vấn đề mạng/proxy/credentials, không phải do script này. "
            "Thử đặt AWS_EC2_METADATA_DISABLED=true nếu đang chạy trong container/Codespaces "
            "(tránh boto3 chờ dò EC2 instance metadata không tồn tại)."
        )
    print(f"Account ID: {account_id}", flush=True)

    if args.sync_policy_only:
        ensure_policy(iot, args.policy_name, policy_document(region, account_id))
        print(f"Đã đồng bộ policy '{args.policy_name}' — không tạo chứng chỉ mới.")
        return

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    ensure_thing(iot, args.thing_name)
    ensure_policy(iot, args.policy_name, policy_document(region, account_id))
    cert = create_and_attach_cert(iot, args.thing_name, args.policy_name)

    cert_path = out_dir / f"{args.thing_name}-cert.pem"
    key_path = out_dir / f"{args.thing_name}-priv.key"
    cert_path.write_text(cert["certificatePem"], encoding="utf-8")
    key_path.write_text(cert["keyPair"]["PrivateKey"], encoding="utf-8")
    download_root_ca(out_dir / "AmazonRootCA1.pem")

    endpoint = iot.describe_endpoint(endpointType="iot:Data-ATS")["endpointAddress"]

    print()
    print("=== Xong. Dán vào config.py (hoặc dùng --write-config để tự sinh) ===")
    print(f'AWS_IOT_ENDPOINT = "{endpoint}"')
    print(f'THING_NAME = "{args.thing_name}"')
    print(f'STATION_SLUG = "{args.station_slug}"')
    print(f'CA_CERT_PATH = "{out_dir / "AmazonRootCA1.pem"}"')
    print(f'DEVICE_CERT_PATH = "{cert_path}"')
    print(f'DEVICE_KEY_PATH = "{key_path}"')
    print()
    print(f"Nhớ vào DevConsole → Quản lý trạm → + Thêm thiết bị, gõ đúng "
          f'aws_thing_name = "{args.thing_name}" cho hàng thiết bị của trạm '
          f"tương ứng — nếu không ingest-telemetry sẽ trả unknown_device (403).")

    if args.write_config:
        write_config(out_dir, endpoint, args.thing_name, args.station_slug)


if __name__ == "__main__":
    main()
