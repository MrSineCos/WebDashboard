// Load control endpoint — called directly by a signed-in browser user
// (unlike ingest-telemetry, which is called by the AWS IoT Rule). Toggling a
// load in the dashboard invokes this function with { load_id, action }.
//
// Flow: verify the caller's JWT → look up the load (RLS-scoped to that user)
// and the device (ESP32) assigned to switch it → publish an MQTT command to
// AWS IoT Core on `solgrid/<aws_thing_name>/command` → on publish success,
// set `loads.desired_state`. The physical on/off confirmation comes back
// later through the normal telemetry path (see ingest-telemetry's `loads`
// ack handling) and lands in `loads.reported_state`.
//
// Deploy:  supabase functions deploy send-load-command
// Secrets: supabase secrets set AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...
//   AWS_REGION=... AWS_IOT_ENDPOINT=<prefix>-ats.iot.<region>.amazonaws.com
//   (SUPABASE_URL / SUPABASE_ANON_KEY are injected automatically.)

import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  IoTDataPlaneClient,
  PublishCommand,
} from "npm:@aws-sdk/client-iot-data-plane@3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const iotData = new IoTDataPlaneClient({
  region: Deno.env.get("AWS_REGION")!,
  endpoint: `https://${Deno.env.get("AWS_IOT_ENDPOINT")!}`,
  credentials: {
    accessKeyId: Deno.env.get("AWS_ACCESS_KEY_ID")!,
    secretAccessKey: Deno.env.get("AWS_SECRET_ACCESS_KEY")!,
  },
});

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  // supabase-js adds x-client-info (+ x-supabase-api-version on newer versions)
  // to every functions.invoke — the browser preflight fails ("Failed to send a
  // request to the Edge Function") unless they're allowed here.
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: { load_id?: string; action?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const { load_id, action } = body;
  if (!load_id || (action !== "on" && action !== "off")) {
    return json({ error: "invalid_params" }, 400);
  }

  // User-scoped client: RLS enforces the caller can only see/touch their own
  // rows, so a valid response here already proves ownership.
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });

  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  const { data: load, error: loadErr } = await userClient
    .from("loads")
    .select("id, device_id")
    .eq("id", load_id)
    .maybeSingle();
  if (loadErr) return json({ error: "lookup_failed", detail: loadErr.message }, 500);
  if (!load) return json({ error: "load_not_found" }, 404);
  if (!load.device_id) return json({ error: "no_device_assigned" }, 400);

  const { data: device, error: deviceErr } = await userClient
    .from("devices")
    .select("aws_thing_name")
    .eq("id", load.device_id)
    .maybeSingle();
  if (deviceErr) return json({ error: "lookup_failed", detail: deviceErr.message }, 500);
  if (!device) return json({ error: "device_not_found" }, 404);

  try {
    await iotData.send(
      new PublishCommand({
        topic: `solgrid/${device.aws_thing_name}/command`,
        payload: new TextEncoder().encode(
          JSON.stringify({ load_id, action, ts: Date.now() }),
        ),
        qos: 1,
      }),
    );
  } catch (err) {
    return json({ error: "publish_failed", detail: String(err) }, 502);
  }

  // Command reached AWS IoT — record the user's intent. Actual confirmation
  // (reported_state) comes back later via ingest-telemetry.
  const { data: updated, error: updateErr } = await userClient
    .from("loads")
    .update({ desired_state: action === "on" })
    .eq("id", load_id)
    .select()
    .single();
  if (updateErr) return json({ error: "update_failed", detail: updateErr.message }, 500);

  return json({ ok: true, data: updated });
});
