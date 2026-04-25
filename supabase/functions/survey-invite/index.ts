import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const body = await request.json();
  const action = body.action as string | undefined;

  if (action === "list") {
    const { data, error } = await supabase
      .from("survey_invites")
      .select("invite_token, participant_label, group_code, status")
      .order("invite_token");
    if (error) return json({ error: error.message }, 500);
    return json({ invites: data });
  }

  const token = body.token as string | undefined;
  if (!token) return json({ error: "Missing invite token" }, 400);

  const { data: row, error: fetchError } = await supabase
    .from("survey_invites")
    .select("*")
    .eq("invite_token", token)
    .single();

  if (fetchError || !row) {
    return json({ error: "Unknown invite token" }, 404);
  }

  if (action === "load") {
    return json(row);
  }

  if (action === "save") {
    if (row.status === "submitted") {
      return json({ error: "Invite already submitted" }, 409);
    }
    const payload = body.payload ?? {};
    const participantName = String(payload.participant_name ?? "");
    const { data, error } = await supabase
      .from("survey_invites")
      .update({
        participant_name: participantName,
        draft_payload: payload,
        status: "in progress",
        updated_at: new Date().toISOString(),
      })
      .eq("invite_token", token)
      .select("*")
      .single();
    if (error) return json({ error: error.message }, 500);
    return json(data);
  }

  if (action === "submit") {
    if (row.status === "submitted") {
      return json({ error: "Invite already submitted" }, 409);
    }
    const payload = body.payload ?? {};
    const participantName = String(payload.participant_name ?? "");
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from("survey_invites")
      .update({
        participant_name: participantName,
        status: "submitted",
        draft_payload: payload,
        submitted_payload: payload,
        updated_at: now,
        submitted_at: now,
      })
      .eq("invite_token", token)
      .select("*")
      .single();
    if (error) return json({ error: error.message }, 500);
    return json(data);
  }

  return json({ error: "Unknown action" }, 400);
});
