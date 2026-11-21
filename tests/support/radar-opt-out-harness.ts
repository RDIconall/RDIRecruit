import assert from "node:assert/strict";
import { NextRequest } from "next/server";

/**
 * In-memory PostgREST for the unsubscribe tests.
 *
 * The route and store run for real. `@supabase/supabase-js` 2.108.1 and
 * `@supabase/postgrest-js` 2.108.1 build the HTTP call:
 * - from() requests `/rest/v1/{table}` (supabase-js dist/index.mjs, PostgrestClient)
 * - select() issues GET and sets `select` (postgrest-js dist/index.mjs select)
 * - eq() appends `column=eq.value` (postgrest-js eq)
 * - not() appends `column=not.operator.value` (postgrest-js not)
 * - maybeSingle() unwraps a one-element JSON array (postgrest-js processResponse)
 * - update() sends PATCH with a JSON body (postgrest-js update)
 * - fetchWithAuth adds the apikey header and calls global fetch
 *
 * This fake applies those filters and writes. It does not invent a second
 * query shape. An operator it does not recognize throws, so a skipped filter
 * cannot look like a successful opt-out.
 */

export const PLACEHOLDER_SUPABASE_URL = "http://127.0.0.1:54321";
export const PLACEHOLDER_SERVICE_KEY = "placeholder-service-key";
export const PUBLIC_ORIGIN = "https://recruit.example.test";

export const CONTACT_A = "11111111-1111-4111-8111-111111111111";
export const CONTACT_B = "22222222-2222-4222-8222-222222222222";
export const TOKEN_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const TOKEN_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

export const OPT_OUT_REASON = "Unsubscribed via email link";

type Row = Record<string, string | boolean | null>;

const contacts: Row[] = [];
const outreach: Row[] = [];

/** When set, the second token lookup returns this contact id instead of the stored one. */
let reboundContactId: string | null = null;
let tokenLookups = 0;

const CANCELLED_STATUSES = ["sent", "drafted", "not_started", "bounced", "no_response"] as const;
const KEPT_STATUSES = ["replied", "meeting"] as const;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function installPlaceholderEnv(): void {
  process.env.SUPABASE_URL = PLACEHOLDER_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_KEY = PLACEHOLDER_SERVICE_KEY;
  process.env.RADAR_PUBLIC_URL = PUBLIC_ORIGIN;
}

export function seedOutreach(): void {
  contacts.length = 0;
  outreach.length = 0;
  tokenLookups = 0;
  reboundContactId = null;
  for (const id of [CONTACT_A, CONTACT_B]) {
    contacts.push({
      id,
      opt_out: false,
      opt_out_at: null,
      opt_out_reason: null,
      consent_status: "implied",
    });
  }
  const rows: Array<[string, string, string, string]> = [
    ["outreach-a-sent", CONTACT_A, "sent", TOKEN_A],
    ["outreach-a-drafted", CONTACT_A, "drafted", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01"],
    ["outreach-a-not-started", CONTACT_A, "not_started", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02"],
    ["outreach-a-bounced", CONTACT_A, "bounced", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03"],
    ["outreach-a-no-response", CONTACT_A, "no_response", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa04"],
    ["outreach-a-replied", CONTACT_A, "replied", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa05"],
    ["outreach-a-meeting", CONTACT_A, "meeting", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa06"],
    ["outreach-b-sent", CONTACT_B, "sent", TOKEN_B],
    ["outreach-b-drafted", CONTACT_B, "drafted", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb01"],
  ];
  for (const [id, contactId, status, token] of rows) {
    outreach.push({
      id,
      contact_id: contactId,
      status,
      unsubscribe_token: token,
    });
  }
}

/**
 * Simulates the token's contact changing after the first lookup in the next
 * opt-out. Lookups already performed (for example a confirmation GET) do not count.
 */
export function rebindTokenOnNextLookup(contactId: string): void {
  reboundContactId = contactId;
  tokenLookups = 0;
}

export function contactRow(id: string): Row {
  const row = contacts.find((item) => item.id === id);
  assert.ok(row, `missing contact ${id}`);
  return row;
}

export function outreachStatus(id: string): string {
  const row = outreach.find((item) => item.id === id);
  assert.ok(row, `missing outreach ${id}`);
  return String(row.status);
}

export function snapshotState(): unknown {
  return {
    contacts: clone(contacts).map((row) => ({
      id: row.id,
      opt_out: row.opt_out,
      opt_out_at: row.opt_out_at,
      opt_out_reason: row.opt_out_reason,
      consent_status: row.consent_status,
    })),
    outreach: clone(outreach).map((row) => ({
      id: row.id,
      contact_id: row.contact_id,
      status: row.status,
    })),
  };
}

export function assertStillInOutreach(): void {
  const contact = contactRow(CONTACT_A);
  assert.equal(contact.opt_out, false);
  assert.equal(contact.consent_status, "implied");
  assert.equal(contact.opt_out_reason, null);
  for (const status of CANCELLED_STATUSES) {
    const row = outreach.find((item) => item.contact_id === CONTACT_A && item.status === status);
    assert.ok(row, `contact A should still have a ${status} outreach row`);
  }
  for (const status of KEPT_STATUSES) {
    const row = outreach.find((item) => item.contact_id === CONTACT_A && item.status === status);
    assert.ok(row, `contact A should still have a ${status} outreach row`);
  }
  assert.equal(contactRow(CONTACT_B).opt_out, false);
  assert.equal(outreachStatus("outreach-b-sent"), "sent");
  assert.equal(outreachStatus("outreach-b-drafted"), "drafted");
}

export function assertOptedOutOnlyContactA(): void {
  const contact = contactRow(CONTACT_A);
  assert.equal(contact.opt_out, true);
  assert.equal(contact.consent_status, "withdrawn");
  assert.equal(contact.opt_out_reason, OPT_OUT_REASON);
  assert.equal(typeof contact.opt_out_at, "string");
  assert.ok(contact.opt_out_at);
  for (const id of [
    "outreach-a-sent",
    "outreach-a-drafted",
    "outreach-a-not-started",
    "outreach-a-bounced",
    "outreach-a-no-response",
  ]) {
    assert.equal(outreachStatus(id), "opted_out", id);
  }
  assert.equal(outreachStatus("outreach-a-replied"), "replied");
  assert.equal(outreachStatus("outreach-a-meeting"), "meeting");
  assert.equal(contactRow(CONTACT_B).opt_out, false);
  assert.equal(contactRow(CONTACT_B).consent_status, "implied");
  assert.equal(outreachStatus("outreach-b-sent"), "sent");
  assert.equal(outreachStatus("outreach-b-drafted"), "drafted");
}

function tableFor(pathname: string): Row[] {
  if (pathname === "/rest/v1/radar_contacts") return contacts;
  if (pathname === "/rest/v1/radar_outreach") return outreach;
  throw new Error(`unexpected PostgREST table ${pathname}`);
}

function matches(row: Row, params: URLSearchParams): boolean {
  for (const [key, value] of params.entries()) {
    if (key === "select" || key === "order" || key === "limit" || key === "offset") continue;
    if (value.startsWith("eq.")) {
      if (String(row[key]) !== value.slice(3)) return false;
      continue;
    }
    if (value.startsWith("not.in.")) {
      const raw = value.slice("not.in.".length);
      if (!raw.startsWith("(") || !raw.endsWith(")")) {
        throw new Error(`unsupported not.in filter ${key}=${value}`);
      }
      const items = raw.slice(1, -1).split(",").filter((item) => item.length > 0);
      if (items.includes(String(row[key]))) return false;
      continue;
    }
    throw new Error(`unsupported PostgREST filter ${key}=${value}`);
  }
  return true;
}

function project(row: Row, select: string | null): Row {
  if (!select || select === "*") return { ...row };
  const projected: Row = {};
  for (const column of select.split(",")) {
    projected[column] = row[column] ?? null;
  }
  return projected;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function readBody(init?: RequestInit): Promise<string> {
  const body = init?.body;
  if (body == null) return "";
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof URLSearchParams) return body.toString();
  throw new Error("unsupported PostgREST body type");
}

export function installPostgrestFetch(): void {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.startsWith("/rest/v1/")) {
      const method = (init?.method ?? "GET").toUpperCase();
      const apikey = new Headers(init?.headers).get("apikey");
      if (apikey !== PLACEHOLDER_SERVICE_KEY) {
        throw new Error("PostgREST call did not use the service-role client");
      }
      const rows = tableFor(url.pathname);
      if (method === "GET" || method === "HEAD") {
        let matched = rows.filter((row) => matches(row, url.searchParams));
        const token = url.searchParams.get("unsubscribe_token");
        if (token?.startsWith("eq.")) {
          tokenLookups += 1;
          if (tokenLookups > 1 && reboundContactId) {
            matched = matched.map((row) => ({ ...row, contact_id: reboundContactId }));
          }
        }
        if (method === "HEAD") return new Response(null, { status: 200 });
        return json(matched.map((row) => project(row, url.searchParams.get("select"))), 200);
      }
      if (method === "PATCH") {
        const patch = JSON.parse(await readBody(init)) as Row;
        const updated: Row[] = [];
        for (const row of rows) {
          if (!matches(row, url.searchParams)) continue;
          Object.assign(row, patch);
          updated.push(row);
        }
        const prefer = new Headers(init?.headers).get("prefer") ?? "";
        if (prefer.includes("return=representation")) return json(updated, 200);
        return new Response(null, { status: 204 });
      }
      throw new Error(`unsupported PostgREST method ${method} ${url.pathname}`);
    }
    if (url.hostname === "127.0.0.1") {
      return json({}, 200);
    }
    throw new Error(`refusing network fetch to ${url.origin}${url.pathname}`);
  };
}

const SCANNER_UA = "Mozilla/5.0 (compatible; MailScanner/1.0; +https://example.test/scanner)";

export function requestFromFooter(footer: string, extra?: { method?: string; headers?: Record<string, string> }): NextRequest {
  const link = footer.match(/https?:\/\/\S+/)?.[0];
  assert.ok(link, "outreach footer did not contain an unsubscribe URL");
  return new NextRequest(link, {
    method: extra?.method ?? "GET",
    headers: {
      accept: "text/html, */*",
      "user-agent": SCANNER_UA,
      ...extra?.headers,
    },
  });
}

/**
 * Builds the POST a browser would send for the first form on the confirmation page.
 * The token may travel in a field or in the form action. The test does not
 * require a particular field name beyond "the submitted request still carries
 * the token from the emailed link".
 */
export function confirmationPost(html: string, pageUrl: string, token: string): NextRequest {
  assert.doesNotMatch(html, /<script\b/i, "confirmation page must not run script that could submit on prefetch");
  assert.doesNotMatch(html, /http-equiv\s*=\s*["']?\s*refresh/i, "confirmation page must not meta-refresh into the opt-out");
  const form = html.match(/<form\b([^>]*)>([\s\S]*?)<\/form>/i);
  assert.ok(form, "emailed link must render a confirmation form");
  const attrs = form[1] ?? "";
  const methodMatch = attrs.match(/\bmethod\s*=\s*["']?\s*([a-z]+)/i);
  const method = (methodMatch?.[1] ?? "get").toUpperCase();
  assert.equal(method, "POST", "confirmation form must submit with POST");
  const action = attrs.match(/\baction\s*=\s*["']([^"']*)["']/i)?.[1] ?? pageUrl;
  const actionUrl = new URL(action, pageUrl);
  const body = new URLSearchParams();
  const inner = form[2] ?? "";
  for (const tag of inner.matchAll(/<input\b([^>]*)>/gi)) {
    const element = tag[1] ?? "";
    if (/\bdisabled\b/i.test(element)) continue;
    const type = (element.match(/\btype\s*=\s*["']([^"']*)["']/i)?.[1] ?? "text").toLowerCase();
    if (type === "submit" || type === "button" || type === "image") continue;
    const name = element.match(/\bname\s*=\s*["']([^"']*)["']/i)?.[1];
    if (!name) continue;
    const value = element.match(/\bvalue\s*=\s*["']([^"']*)["']/i)?.[1] ?? "";
    body.set(name, value);
  }
  const carried = body.get("token") ?? actionUrl.searchParams.get("token");
  assert.equal(carried, token, "confirmation form must submit the token from the emailed link");
  return new NextRequest(actionUrl, {
    method: "POST",
    headers: {
      accept: "text/html",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "Mozilla/5.0",
    },
    body,
  });
}
