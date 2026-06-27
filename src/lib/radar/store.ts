import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getServiceSupabase } from "../supabase/server";
import { defaultScorecard } from "./scorecard";
import { normalizeContact } from "./normalize";
import {
  EMPTY_CRITERIA,
  type ConsentStatus,
  type OutreachStatus,
  type Pipeline,
  type RadarContact,
  type RadarOutreach,
  type RadarScore,
  type RadarSearch,
  type RawContact,
  type SearchCriteria,
  type ScoreDimension,
} from "./types";

function db(): SupabaseClient {
  return getServiceSupabase();
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function mapCriteria(raw: unknown): SearchCriteria {
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const arr = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  return {
    titles: arr(c.titles),
    keywords: arr(c.keywords),
    companies: arr(c.companies),
    locations: arr(c.locations),
    relocationAllowed: c.relocationAllowed !== false,
    mustHave: arr(c.mustHave),
    exclude: arr(c.exclude),
  };
}

function mapSearch(r: Record<string, unknown>): RadarSearch {
  return {
    id: String(r.id),
    title: String(r.title ?? ""),
    pipeline: (r.pipeline as Pipeline) ?? "recruiting",
    criteria: mapCriteria(r.criteria),
    createdBy: (r.created_by as string) ?? null,
    createdAt: String(r.created_at ?? ""),
  };
}

function mapScore(r: Record<string, unknown>): RadarScore {
  return {
    id: String(r.id),
    contactId: String(r.contact_id),
    pipeline: (r.pipeline as Pipeline) ?? "recruiting",
    scorecardName: (r.scorecard_name as string) ?? null,
    dimensions: Array.isArray(r.dimensions) ? (r.dimensions as ScoreDimension[]) : [],
    overall: r.overall == null ? null : Number(r.overall),
    recommendation: (r.recommendation as string) ?? null,
    summary: (r.summary as string) ?? null,
    strongestSignal: (r.strongest_signal as string) ?? null,
    biggestConcern: (r.biggest_concern as string) ?? null,
    nextAction: (r.next_action as string) ?? null,
    model: (r.model as string) ?? null,
    createdAt: String(r.created_at ?? ""),
  };
}

function mapOutreach(r: Record<string, unknown>): RadarOutreach {
  return {
    id: String(r.id),
    contactId: String(r.contact_id),
    pipeline: (r.pipeline as Pipeline) ?? "recruiting",
    channel: (r.channel as RadarOutreach["channel"]) ?? "email",
    status: (r.status as OutreachStatus) ?? "drafted",
    owner: (r.owner as string) ?? null,
    subject: (r.subject as string) ?? null,
    body: (r.body as string) ?? null,
    lastContactDate: (r.last_contact_date as string) ?? null,
    nextFollowUpDate: (r.next_follow_up_date as string) ?? null,
    response: (r.response as string) ?? null,
    unsubscribeToken: String(r.unsubscribe_token ?? ""),
    createdAt: String(r.created_at ?? ""),
    updatedAt: String(r.updated_at ?? ""),
  };
}

function mapContact(r: Record<string, unknown>): RadarContact {
  return {
    id: String(r.id),
    searchId: (r.search_id as string) ?? null,
    pipeline: Array.isArray(r.pipeline) ? (r.pipeline as Pipeline[]) : ["recruiting"],
    fullName: (r.full_name as string) ?? null,
    firstName: (r.first_name as string) ?? null,
    lastName: (r.last_name as string) ?? null,
    title: (r.title as string) ?? null,
    company: (r.company as string) ?? null,
    location: (r.location as string) ?? null,
    linkedinUrl: (r.linkedin_url as string) ?? null,
    email: (r.email as string) ?? null,
    phone: (r.phone as string) ?? null,
    source: String(r.source ?? "Manual"),
    profileSummary: (r.profile_summary as string) ?? null,
    emailStatus: (r.email_status as RadarContact["emailStatus"]) ?? "unknown",
    consentStatus: (r.consent_status as ConsentStatus) ?? "unknown",
    optOut: Boolean(r.opt_out),
    optOutAt: (r.opt_out_at as string) ?? null,
    optOutReason: (r.opt_out_reason as string) ?? null,
    owner: (r.owner as string) ?? null,
    dedupeKey: (r.dedupe_key as string) ?? null,
    raw: (r.raw && typeof r.raw === "object" ? (r.raw as Record<string, unknown>) : {}),
    createdAt: String(r.created_at ?? ""),
    updatedAt: String(r.updated_at ?? ""),
  };
}

// ---------------------------------------------------------------------------
// Searches
// ---------------------------------------------------------------------------

export async function listSearches(pipeline?: Pipeline): Promise<RadarSearch[]> {
  let q = db().from("radar_searches").select("*").order("created_at", { ascending: false });
  if (pipeline) q = q.eq("pipeline", pipeline);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []).map(mapSearch);
}

export async function createSearch(input: {
  title: string;
  pipeline: Pipeline;
  criteria: SearchCriteria;
  createdBy?: string;
}): Promise<RadarSearch> {
  const { data, error } = await db()
    .from("radar_searches")
    .insert({
      title: input.title,
      pipeline: input.pipeline,
      criteria: input.criteria ?? EMPTY_CRITERIA,
      created_by: input.createdBy ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;
  return mapSearch(data);
}

export async function updateSearch(input: {
  id: string;
  pipeline: Pipeline;
  title: string;
  criteria: SearchCriteria;
}): Promise<RadarSearch> {
  const { data, error } = await db()
    .from("radar_searches")
    .update({
      title: input.title,
      criteria: input.criteria ?? EMPTY_CRITERIA,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.id)
    .eq("pipeline", input.pipeline)
    .select("*")
    .single();
  if (error) throw error;
  return mapSearch(data);
}

// ---------------------------------------------------------------------------
// Scorecards
// ---------------------------------------------------------------------------

export async function getActiveScorecard(pipeline: Pipeline): Promise<{ name: string; content: string }> {
  const { data } = await db()
    .from("radar_scorecards")
    .select("name, content")
    .eq("pipeline", pipeline)
    .eq("active", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (data) return { name: String(data.name), content: String(data.content) };
  const fallback = defaultScorecard(pipeline);
  return { name: fallback.name, content: fallback.content };
}

export async function saveScorecard(input: {
  pipeline: Pipeline;
  name: string;
  content: string;
  updatedBy?: string;
}): Promise<void> {
  const { dimensions } = defaultScorecard(input.pipeline);
  await db().from("radar_scorecards").update({ active: false }).eq("pipeline", input.pipeline);
  const { error } = await db().from("radar_scorecards").insert({
    pipeline: input.pipeline,
    name: input.name,
    content: input.content,
    dimensions,
    active: true,
    updated_by: input.updatedBy ?? null,
  });
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Contacts (upsert with dedupe-merge)
// ---------------------------------------------------------------------------

/** Insert or merge a raw contact. Returns { id, inserted }. */
export async function upsertContact(
  raw: RawContact,
  opts: { pipeline: Pipeline; searchId?: string | null; owner?: string | null },
): Promise<{ id: string; inserted: boolean }> {
  const n = normalizeContact(raw);
  const supabase = db();

  if (n.dedupeKey) {
    const { data: existing } = await supabase
      .from("radar_contacts")
      .select("id, pipeline")
      .eq("dedupe_key", n.dedupeKey)
      .maybeSingle();
    if (existing) {
      const merged = Array.from(new Set([...(existing.pipeline ?? []), opts.pipeline]));
      // Fill blanks only; never overwrite human/owner edits with provider nulls.
      await supabase
        .from("radar_contacts")
        .update({
          pipeline: merged,
          title: n.title ?? undefined,
          company: n.company ?? undefined,
          location: n.location ?? undefined,
          linkedin_url: n.linkedinUrl ?? undefined,
          email: n.email ?? undefined,
          phone: n.phone ?? undefined,
          profile_summary: n.profileSummary ?? undefined,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
      return { id: String(existing.id), inserted: false };
    }
  }

  const { data, error } = await supabase
    .from("radar_contacts")
    .insert({
      search_id: opts.searchId ?? null,
      pipeline: [opts.pipeline],
      full_name: n.fullName,
      first_name: n.firstName,
      last_name: n.lastName,
      title: n.title,
      company: n.company,
      location: n.location,
      linkedin_url: n.linkedinUrl,
      email: n.email,
      phone: n.phone,
      source: n.source,
      profile_summary: n.profileSummary,
      raw: n.raw,
      email_status: n.emailStatus,
      owner: opts.owner ?? null,
      dedupe_key: n.dedupeKey,
    })
    .select("id")
    .single();
  if (error) {
    // Unique-violation race: a concurrent insert won. Treat as merge.
    if ((error as { code?: string }).code === "23505" && n.dedupeKey) {
      const { data: ex } = await supabase
        .from("radar_contacts")
        .select("id")
        .eq("dedupe_key", n.dedupeKey)
        .maybeSingle();
      if (ex) return { id: String(ex.id), inserted: false };
    }
    throw error;
  }
  return { id: String(data.id), inserted: true };
}

export async function upsertMany(
  raws: RawContact[],
  opts: { pipeline: Pipeline; searchId?: string | null; owner?: string | null },
): Promise<{ inserted: number; duplicates: number; ids: string[] }> {
  let inserted = 0;
  let duplicates = 0;
  const ids: string[] = [];
  for (const raw of raws) {
    const res = await upsertContact(raw, opts);
    ids.push(res.id);
    if (res.inserted) inserted++;
    else duplicates++;
  }
  return { inserted, duplicates, ids };
}

export async function getContact(id: string): Promise<RadarContact | null> {
  const { data, error } = await db().from("radar_contacts").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? mapContact(data) : null;
}

export async function updateContactFields(
  id: string,
  fields: Partial<{
    pipeline: Pipeline[];
    owner: string | null;
    consentStatus: ConsentStatus;
    emailStatus: RadarContact["emailStatus"];
    title: string | null;
    company: string | null;
    location: string | null;
    email: string | null;
    phone: string | null;
    linkedinUrl: string | null;
    profileSummary: string | null;
  }>,
): Promise<void> {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (fields.pipeline) patch.pipeline = fields.pipeline;
  if (fields.owner !== undefined) patch.owner = fields.owner;
  if (fields.consentStatus) patch.consent_status = fields.consentStatus;
  if (fields.emailStatus) patch.email_status = fields.emailStatus;
  if (fields.title !== undefined) patch.title = fields.title;
  if (fields.company !== undefined) patch.company = fields.company;
  if (fields.location !== undefined) patch.location = fields.location;
  if (fields.email !== undefined) patch.email = fields.email;
  if (fields.phone !== undefined) patch.phone = fields.phone;
  if (fields.linkedinUrl !== undefined) patch.linkedin_url = fields.linkedinUrl;
  if (fields.profileSummary !== undefined) patch.profile_summary = fields.profileSummary;
  const { error } = await db().from("radar_contacts").update(patch).eq("id", id);
  if (error) throw error;
}

export async function setOptOut(id: string, reason: string): Promise<void> {
  const { error } = await db()
    .from("radar_contacts")
    .update({
      opt_out: true,
      opt_out_at: new Date().toISOString(),
      opt_out_reason: reason,
      consent_status: "withdrawn",
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) throw error;
  // Any pending/sent outreach for this person is now opted_out.
  await db()
    .from("radar_outreach")
    .update({ status: "opted_out", updated_at: new Date().toISOString() })
    .eq("contact_id", id)
    .not("status", "in", "(replied,meeting)");
}

export async function setOptOutByToken(token: string, reason: string): Promise<boolean> {
  const { data } = await db()
    .from("radar_outreach")
    .select("contact_id")
    .eq("unsubscribe_token", token)
    .maybeSingle();
  if (!data?.contact_id) return false;
  await setOptOut(String(data.contact_id), reason);
  return true;
}

// ---------------------------------------------------------------------------
// Scores
// ---------------------------------------------------------------------------

export async function saveScore(input: {
  contactId: string;
  pipeline: Pipeline;
  scorecardName: string;
  dimensions: ScoreDimension[];
  overall: number | null;
  recommendation: string;
  summary: string;
  strongestSignal: string;
  biggestConcern: string;
  nextAction: string;
  model: string;
}): Promise<RadarScore> {
  const { data, error } = await db()
    .from("radar_scores")
    .insert({
      contact_id: input.contactId,
      pipeline: input.pipeline,
      scorecard_name: input.scorecardName,
      dimensions: input.dimensions,
      overall: input.overall,
      recommendation: input.recommendation,
      summary: input.summary,
      strongest_signal: input.strongestSignal,
      biggest_concern: input.biggestConcern,
      next_action: input.nextAction,
      model: input.model,
    })
    .select("*")
    .single();
  if (error) throw error;
  return mapScore(data);
}

// ---------------------------------------------------------------------------
// Outreach
// ---------------------------------------------------------------------------

export async function saveOutreach(input: {
  contactId: string;
  pipeline: Pipeline;
  channel: RadarOutreach["channel"];
  subject?: string | null;
  body?: string | null;
  owner?: string | null;
  status?: OutreachStatus;
}): Promise<RadarOutreach> {
  const { data, error } = await db()
    .from("radar_outreach")
    .insert({
      contact_id: input.contactId,
      pipeline: input.pipeline,
      channel: input.channel,
      subject: input.subject ?? null,
      body: input.body ?? null,
      owner: input.owner ?? null,
      status: input.status ?? "drafted",
    })
    .select("*")
    .single();
  if (error) throw error;
  return mapOutreach(data);
}

export async function updateOutreach(
  id: string,
  fields: Partial<{
    status: OutreachStatus;
    owner: string | null;
    subject: string | null;
    body: string | null;
    lastContactDate: string | null;
    nextFollowUpDate: string | null;
    response: string | null;
  }>,
): Promise<RadarOutreach> {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (fields.status) patch.status = fields.status;
  if (fields.owner !== undefined) patch.owner = fields.owner;
  if (fields.subject !== undefined) patch.subject = fields.subject;
  if (fields.body !== undefined) patch.body = fields.body;
  if (fields.lastContactDate !== undefined) patch.last_contact_date = fields.lastContactDate;
  if (fields.nextFollowUpDate !== undefined) patch.next_follow_up_date = fields.nextFollowUpDate;
  if (fields.response !== undefined) patch.response = fields.response;
  const { data, error } = await db().from("radar_outreach").update(patch).eq("id", id).select("*").single();
  if (error) throw error;
  return mapOutreach(data);
}

// ---------------------------------------------------------------------------
// Import batches
// ---------------------------------------------------------------------------

export async function recordImportBatch(input: {
  filename?: string;
  source: string;
  pipeline: Pipeline;
  rowCount: number;
  inserted: number;
  duplicates: number;
  importedBy?: string;
}): Promise<void> {
  await db().from("radar_import_batches").insert({
    filename: input.filename ?? null,
    source: input.source,
    pipeline: input.pipeline,
    row_count: input.rowCount,
    inserted: input.inserted,
    duplicates: input.duplicates,
    imported_by: input.importedBy ?? null,
  });
}

// ---------------------------------------------------------------------------
// Loader: contacts joined with latest score + outreach
// ---------------------------------------------------------------------------

export async function loadContacts(opts: {
  pipeline: Pipeline;
  searchId?: string | null;
}): Promise<RadarContact[]> {
  let q = db().from("radar_contacts").select("*").order("created_at", { ascending: false });
  q = q.contains("pipeline", [opts.pipeline]);
  if (opts.searchId) q = q.eq("search_id", opts.searchId);
  const { data, error } = await q;
  if (error) throw error;
  const contacts = (data ?? []).map(mapContact);
  if (!contacts.length) return [];

  const ids = contacts.map((c) => c.id);
  const [{ data: scoreRows }, { data: outreachRows }] = await Promise.all([
    db().from("radar_scores").select("*").in("contact_id", ids).order("created_at", { ascending: false }),
    db().from("radar_outreach").select("*").in("contact_id", ids).order("created_at", { ascending: false }),
  ]);

  const latestScore = new Map<string, RadarScore>();
  for (const r of scoreRows ?? []) {
    const s = mapScore(r);
    if (!latestScore.has(s.contactId)) latestScore.set(s.contactId, s);
  }
  const outreachByContact = new Map<string, RadarOutreach[]>();
  for (const r of outreachRows ?? []) {
    const o = mapOutreach(r);
    const arr = outreachByContact.get(o.contactId) ?? [];
    arr.push(o);
    outreachByContact.set(o.contactId, arr);
  }

  for (const c of contacts) {
    c.score = latestScore.get(c.id) ?? null;
    c.outreach = outreachByContact.get(c.id) ?? [];
  }
  return contacts;
}
