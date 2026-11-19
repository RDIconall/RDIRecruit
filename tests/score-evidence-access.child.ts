/**
 * Assertions for the score-evidence access tests. Loaded only in a child
 * process whose environment already points at the local Data API harness.
 */
import assert from "node:assert/strict";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { GET } from "../src/app/api/score-inputs/[id]/capture/route";

const QUOTE = "verbatim-grade-quote";
const CLAIM = "owns the study startup";
const SOURCE = "resume:bullet-2";
const POISONED_PATH = "cand_victim/resume.pdf";
const SWAPPED_PATH = "cand_other/resume.pdf";

const READ_ROW = "11111111-1111-4111-8111-111111111111";
const ANON_UPDATE_ROW = "22222222-2222-4222-8222-222222222222";
const ANON_DELETE_ROW = "33333333-3333-4333-8333-333333333333";
const CAPTURE_ROW = "44444444-4444-4444-8444-444444444444";
const ANON_PLANT_ROW = "55555555-5555-4555-8555-555555555555";
const AUTH_UPDATE_ROW = "66666666-6666-4666-8666-666666666666";
const AUTH_DELETE_ROW = "77777777-7777-4777-8777-777777777777";
const AUTH_PLANT_ROW = "88888888-8888-4888-8888-888888888888";

function client(key: string): SupabaseClient {
  return createClient(process.env.SUPABASE_URL!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function rowsOf(data: unknown): Array<Record<string, unknown>> {
  if (!data) return [];
  return Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [data as Record<string, unknown>];
}

async function assertCannotRead(role: SupabaseClient, label: string) {
  const { data, error } = await role
    .from("score_inputs")
    .select("id, claim, quote, source_ref, capture_path");
  const leaked = rowsOf(data).some(
    (row) => row.quote === QUOTE || row.claim === CLAIM || row.source_ref === SOURCE,
  );
  assert.equal(leaked, false, `${label} read score evidence (${error ? error.message : JSON.stringify(data)})`);
}

async function assertCannotUpdate(role: SupabaseClient, service: SupabaseClient, label: string, updateRow: string) {
  await role
    .from("score_inputs")
    .update({ quote: `tampered-by-${label}`, capture_path: SWAPPED_PATH })
    .eq("id", updateRow);
  const { data: afterUpdate, error: readError } = await service
    .from("score_inputs")
    .select("quote, capture_path")
    .eq("id", updateRow)
    .single();
  assert.equal(readError, null, `service role could not read ${updateRow}: ${readError?.message}`);
  assert.equal(afterUpdate?.quote, QUOTE, `${label} changed a grade quote`);
  assert.equal(afterUpdate?.capture_path, null, `${label} wrote a capture path`);
}

async function assertCannotDelete(role: SupabaseClient, service: SupabaseClient, label: string, deleteRow: string) {
  await role.from("score_inputs").delete().eq("id", deleteRow);
  const { data: afterDelete } = await service.from("score_inputs").select("id").eq("id", deleteRow).maybeSingle();
  assert.ok(afterDelete?.id, `${label} deleted score evidence`);
}

async function assertCannotInsert(role: SupabaseClient, service: SupabaseClient, label: string, plantRow: string) {
  await role.from("score_inputs").insert({
    id: plantRow,
    score_id: process.env.SCORE_ID,
    claim: "planted claim",
    quote: "planted quote",
    source_ref: "planted",
    capture_path: POISONED_PATH,
  });
  const { data: planted } = await service.from("score_inputs").select("id").eq("id", plantRow).maybeSingle();
  assert.equal(planted, null, `${label} inserted score evidence`);
}

async function captureBody(): Promise<string> {
  const response = await GET(new Request(`http://localhost/api/score-inputs/${CAPTURE_ROW}/capture`), {
    params: Promise.resolve({ id: CAPTURE_ROW }),
  });
  return response.text();
}

async function assertCaptureRouteDoesNotSign(body: string) {
  assert.equal(
    body.includes(POISONED_PATH) || body.includes(SWAPPED_PATH) || body.includes("token="),
    false,
    `capture route signed a path scoring ingest did not write: ${body}`,
  );
}

async function assertCaptureRouteDoesNotReturnEvidence(body: string) {
  assert.equal(
    body.includes(QUOTE) || body.includes(CLAIM) || body.includes(SOURCE),
    false,
    `capture route returned grade evidence: ${body}`,
  );
}

const failures: string[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main() {
  const anon = client(process.env.ANON_JWT!);
  const authenticated = client(process.env.AUTHENTICATED_JWT!);
  const service = client(process.env.SUPABASE_SERVICE_KEY!);

  await check("anon select", () => assertCannotRead(anon, "anon"));
  await check("authenticated select", () => assertCannotRead(authenticated, "authenticated"));
  await check("anon update", () => assertCannotUpdate(anon, service, "anon", ANON_UPDATE_ROW));
  await check("anon delete", () => assertCannotDelete(anon, service, "anon", ANON_DELETE_ROW));
  await check("anon insert", () => assertCannotInsert(anon, service, "anon", ANON_PLANT_ROW));
  await check("authenticated update", () =>
    assertCannotUpdate(authenticated, service, "authenticated", AUTH_UPDATE_ROW),
  );
  await check("authenticated delete", () =>
    assertCannotDelete(authenticated, service, "authenticated", AUTH_DELETE_ROW),
  );
  await check("authenticated insert", () =>
    assertCannotInsert(authenticated, service, "authenticated", AUTH_PLANT_ROW),
  );
  await check("service role read", async () => {
    const { data, error } = await service.from("score_inputs").select("quote").eq("id", READ_ROW).single();
    assert.equal(error, null, error?.message);
    assert.equal(data?.quote, QUOTE);
  });
  const captureResponse = await captureBody().catch((error: unknown) => {
    failures.push(`capture route: ${error instanceof Error ? error.message : String(error)}`);
    return "";
  });
  if (captureResponse) {
    await check("capture route sign", () => assertCaptureRouteDoesNotSign(captureResponse));
    await check("capture route evidence", () => assertCaptureRouteDoesNotReturnEvidence(captureResponse));
  }

  if (failures.length) {
    throw new Error(failures.join("\n"));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
