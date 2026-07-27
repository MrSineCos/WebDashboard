// Device provisioning endpoint — called by a signed-in browser user from
// DevConsole ("Tổng quan thiết bị" → mở thiết bị → "Tạo chứng chỉ mới").
// This is the in-browser equivalent of tools/mqtt-simulator/provision_device.py:
// it mints a fresh X.509 cert on AWS IoT Core for one of the caller's devices
// and returns the 3 blocks (Amazon Root CA, device cert, private key) plus the
// endpoint so they can be pasted straight into firmware secrets.h.
//
// Why an endpoint (and not just reading a stored cert): AWS only hands back the
// private key ONCE, at creation — the rest of this app deliberately never
// stores it (see docs/IOT.md, DeviceInfoModal). So "get the cert in the UI"
// necessarily means "generate a new one now, server-side, and stream it back
// once". The key is returned to the browser and NOT persisted anywhere.
//
// Two actions in one function (`body.action`), same auth/ownership check:
//   - "create" (default): mint a new cert, as above.
//   - "list": read-only — ListThingPrincipals + DescribeCertificate to show
//     which certs are ALREADY attached to this thing on AWS (id/status/created
//     at, plus the certificate PEM itself). The certificate is public info
//     signed by AWS (unlike the private key), so re-showing it on every open
//     is safe — it's what lets the modal say "this device already has N cert(s)"
//     instead of only ever offering "create a new one".
//
// Flow (create): verify caller JWT → look up the device (RLS-scoped, so a hit
// already proves ownership) → ensure thing + policy exist →
// CreateKeysAndCertificate → attach policy + thing principal →
// DescribeEndpoint → return blocks.
//
// Deploy:  supabase functions deploy provision-device
// Secrets (ADMIN IoT creds — broader than send-load-command's publish-only pair;
//   need iot:CreateThing, CreateKeysAndCertificate, CreatePolicy, AttachPolicy,
//   AttachThingPrincipal, DescribeEndpoint, sts:GetCallerIdentity):
//   supabase secrets set \
//     AWS_PROVISION_REGION=ap-southeast-1 \
//     AWS_PROVISION_ACCESS_KEY_ID=... \
//     AWS_PROVISION_SECRET_ACCESS_KEY=...
//   (falls back to AWS_REGION if AWS_PROVISION_REGION is unset.)

import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  IoTClient,
  DescribeThingCommand,
  CreateThingCommand,
  CreatePolicyCommand,
  ListPolicyVersionsCommand,
  GetPolicyVersionCommand,
  CreatePolicyVersionCommand,
  DeletePolicyVersionCommand,
  CreateKeysAndCertificateCommand,
  AttachPolicyCommand,
  AttachThingPrincipalCommand,
  DescribeEndpointCommand,
  ListThingPrincipalsCommand,
  DescribeCertificateCommand,
} from "npm:@aws-sdk/client-iot@3";
import { STSClient, GetCallerIdentityCommand } from "npm:@aws-sdk/client-sts@3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const REGION = Deno.env.get("AWS_PROVISION_REGION") ?? Deno.env.get("AWS_REGION")!;
const POLICY_NAME = Deno.env.get("SOLGRID_IOT_POLICY_NAME") ?? "solgrid-device-policy";
const ROOT_CA_URL = "https://www.amazontrust.com/repository/AmazonRootCA1.pem";

const awsCredentials = {
  accessKeyId: Deno.env.get("AWS_PROVISION_ACCESS_KEY_ID") ?? Deno.env.get("AWS_ACCESS_KEY_ID")!,
  secretAccessKey: Deno.env.get("AWS_PROVISION_SECRET_ACCESS_KEY") ?? Deno.env.get("AWS_SECRET_ACCESS_KEY")!,
};

const iot = new IoTClient({ region: REGION, credentials: awsCredentials });
const sts = new STSClient({ region: REGION, credentials: awsCredentials });

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  // supabase-js adds x-client-info (+ x-supabase-api-version on newer versions)
  // to every functions.invoke — the browser preflight fails ("Failed to send a
  // request to the Edge Function") unless they're allowed here alongside the
  // auth/content headers.
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

// Matches docs/IOT.md §4.1 and provision_device.py: publish own telemetry, and
// subscribe/receive load-control commands on this thing's own topic only.
function policyDocument(region: string, accountId: string): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: "iot:Connect",
        Resource: `arn:aws:iot:${region}:${accountId}:client/\${iot:Connection.Thing.ThingName}`,
      },
      {
        Effect: "Allow",
        Action: "iot:Publish",
        Resource: `arn:aws:iot:${region}:${accountId}:topic/solgrid/*/telemetry`,
      },
      {
        Effect: "Allow",
        Action: ["iot:Subscribe", "iot:Receive"],
        Resource: [
          `arn:aws:iot:${region}:${accountId}:topicfilter/solgrid/\${iot:Connection.Thing.ThingName}/command`,
          `arn:aws:iot:${region}:${accountId}:topic/solgrid/\${iot:Connection.Thing.ThingName}/command`,
        ],
      },
    ],
  });
}

async function ensureThing(thingName: string) {
  try {
    await iot.send(new DescribeThingCommand({ thingName }));
  } catch (err) {
    if ((err as { name?: string }).name !== "ResourceNotFoundException") throw err;
    await iot.send(new CreateThingCommand({ thingName }));
  }
}

// Idempotent: create the policy, or if it already exists but its default
// version differs from the current document (e.g. an older one missing the
// Subscribe/Receive statements), roll a new default version — same
// reconciliation provision_device.py does, so load control keeps working.
async function ensurePolicy(policyName: string, document: string) {
  try {
    await iot.send(new CreatePolicyCommand({ policyName, policyDocument: document }));
    return;
  } catch (err) {
    if ((err as { name?: string }).name !== "ResourceAlreadyExistsException") throw err;
  }

  const { policyVersions = [] } = await iot.send(new ListPolicyVersionsCommand({ policyName }));
  const defaultVersion = policyVersions.find((v) => v.isDefaultVersion);
  const current = await iot.send(
    new GetPolicyVersionCommand({ policyName, policyVersionId: defaultVersion!.versionId }),
  );
  if (current.policyDocument && JSON.stringify(JSON.parse(current.policyDocument)) === JSON.stringify(JSON.parse(document))) {
    return;
  }

  // AWS caps a policy at 5 versions — drop the oldest non-default before adding.
  if (policyVersions.length >= 5) {
    const oldest = policyVersions
      .filter((v) => !v.isDefaultVersion)
      .sort((a, b) => Number(a.versionId) - Number(b.versionId))[0];
    if (oldest) await iot.send(new DeletePolicyVersionCommand({ policyName, policyVersionId: oldest.versionId }));
  }
  await iot.send(new CreatePolicyVersionCommand({ policyName, policyDocument: document, setAsDefault: true }));
}

async function fetchRootCa(): Promise<string> {
  const res = await fetch(ROOT_CA_URL);
  if (!res.ok) throw new Error(`root_ca_fetch_failed_${res.status}`);
  return (await res.text()).trim();
}

// Read-only: what's already attached to this thing on AWS, if anything. A
// principal ARN for a thing is either a cert or (rarely) a Cognito identity —
// this app only ever attaches certs, so a DescribeCertificate 404 on a
// principal just means "not a cert" and that entry is skipped rather than
// failing the whole list.
async function listCertificates(thingName: string) {
  try {
    await iot.send(new DescribeThingCommand({ thingName }));
  } catch (err) {
    if ((err as { name?: string }).name === "ResourceNotFoundException") {
      return { thing_exists: false, certificates: [] as unknown[] };
    }
    throw err;
  }

  const { principals = [] } = await iot.send(new ListThingPrincipalsCommand({ thingName }));
  const certificates = [];
  for (const arn of principals) {
    const certificateId = arn.split("/").pop();
    if (!certificateId) continue;
    try {
      const { certificateDescription } = await iot.send(new DescribeCertificateCommand({ certificateId }));
      if (!certificateDescription) continue;
      certificates.push({
        certificate_id: certificateDescription.certificateId,
        status: certificateDescription.status,
        created_at: certificateDescription.creationDate,
        certificate_pem: certificateDescription.certificatePem,
      });
    } catch (err) {
      if ((err as { name?: string }).name !== "ResourceNotFoundException") throw err;
    }
  }
  certificates.sort((a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime());
  return { thing_exists: true, certificates };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: { device_id?: string; action?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const deviceId = body.device_id;
  const action = body.action === "list" ? "list" : "create";
  if (!deviceId) return json({ error: "invalid_params" }, 400);

  // User-scoped client: RLS (select-own on devices) means a returned row already
  // proves the caller owns this device — same trust model as send-load-command.
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });

  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  const { data: device, error: deviceErr } = await userClient
    .from("devices")
    .select("id, aws_thing_name")
    .eq("id", deviceId)
    .maybeSingle();
  if (deviceErr) return json({ error: "lookup_failed", detail: deviceErr.message }, 500);
  if (!device) return json({ error: "device_not_found" }, 404);

  const thingName = device.aws_thing_name as string;

  if (action === "list") {
    try {
      const result = await listCertificates(thingName);
      return json({ ok: true, thing_name: thingName, ...result });
    } catch (err) {
      return json({ error: "list_failed", detail: String(err) }, 502);
    }
  }

  try {
    const { Account: accountId } = await sts.send(new GetCallerIdentityCommand({}));

    await ensureThing(thingName);
    await ensurePolicy(POLICY_NAME, policyDocument(REGION, accountId!));

    const cert = await iot.send(new CreateKeysAndCertificateCommand({ setAsActive: true }));
    await iot.send(new AttachPolicyCommand({ policyName: POLICY_NAME, target: cert.certificateArn }));
    await iot.send(new AttachThingPrincipalCommand({ thingName, principal: cert.certificateArn }));

    const endpointRes = await iot.send(new DescribeEndpointCommand({ endpointType: "iot:Data-ATS" }));
    const rootCa = await fetchRootCa();

    return json({
      ok: true,
      thing_name: thingName,
      region: REGION,
      endpoint: endpointRes.endpointAddress,
      root_ca: rootCa,
      certificate_id: cert.certificateId,
      certificate_pem: cert.certificatePem,
      private_key: cert.keyPair?.PrivateKey,
    });
  } catch (err) {
    return json({ error: "provision_failed", detail: String(err) }, 502);
  }
});
