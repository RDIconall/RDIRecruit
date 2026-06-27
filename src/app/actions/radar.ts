"use server";

import { revalidatePath } from "next/cache";
import { auth, currentUser } from "@clerk/nextjs/server";
import { csvToRawContacts } from "@/lib/radar/csv";
import { draftOutreach, unsubscribeFooter } from "@/lib/radar/outreach";
import { runProviders } from "@/lib/radar/providers";
import { scoreContact } from "@/lib/radar/score";
import {
  createSearch,
  getActiveScorecard,
  getContact,
  loadContacts,
  recordImportBatch,
  saveOutreach,
  saveScore,
  saveScorecard,
  setOptOut,
  updateContactFields,
  updateOutreach,
  updateSearch,
  upsertContact,
  upsertMany,
} from "@/lib/radar/store";
import type {
  ConsentStatus,
  OutreachChannel,
  OutreachStatus,
  Pipeline,
  RawContact,
  SearchCriteria,
} from "@/lib/radar/types";

async function requireAuth(): Promise<string> {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");
  return userId;
}

async function actorLabel(): Promise<string> {
  try {
    const user = await currentUser();
    if (!user) return "RDI";
    const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
    const email = user.emailAddresses?.[0]?.emailAddress;
    return name || (email ? email.split("@")[0] : "RDI");
  } catch {
    return "RDI";
  }
}

function revalidate() {
  revalidatePath("/radar");
}

// ---------------------------------------------------------------------------
// Searches + enrichment
// ---------------------------------------------------------------------------

export async function createSearchAction(input: {
  title: string;
  pipeline: Pipeline;
  criteria: SearchCriteria;
}): Promise<{ ok: boolean; searchId?: string; error?: string }> {
  try {
    await requireAuth();
    const createdBy = await actorLabel();
    const search = await createSearch({ ...input, createdBy });
    revalidate();
    return { ok: true, searchId: search.id };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Failed to create search" };
  }
}

export async function updateSearchAction(input: {
  id: string;
  title: string;
  pipeline: Pipeline;
  criteria: SearchCriteria;
}): Promise<{ ok: boolean; searchId?: string; error?: string }> {
  try {
    await requireAuth();
    const search = await updateSearch(input);
    revalidate();
    return { ok: true, searchId: search.id };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Failed to update search" };
  }
}

/**
 * Query the configured people/contact providers (Seamless/Apollo) for a search's
 * criteria, normalize + dedupe-merge the results into radar_contacts.
 */
export async function runEnrichmentAction(input: {
  searchId: string;
  pipeline: Pipeline;
  criteria: SearchCriteria;
  limit?: number;
}): Promise<{ ok: boolean; inserted?: number; duplicates?: number; providers?: { provider: string; configured: boolean; count: number; error?: string }[]; error?: string }> {
  try {
    await requireAuth();
    const owner = await actorLabel();
    const { results, contacts } = await runProviders(input.criteria, { limit: input.limit ?? 50 });
    const { inserted, duplicates } = await upsertMany(contacts, {
      pipeline: input.pipeline,
      searchId: input.searchId,
      owner,
    });
    await recordImportBatch({
      source: "API enrichment",
      pipeline: input.pipeline,
      rowCount: contacts.length,
      inserted,
      duplicates,
      importedBy: owner,
    });
    revalidate();
    return {
      ok: true,
      inserted,
      duplicates,
      providers: results.map((r) => ({ provider: r.provider, configured: r.configured, count: r.contacts.length, error: r.error })),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Enrichment failed" };
  }
}

// ---------------------------------------------------------------------------
// Manual add + CSV import
// ---------------------------------------------------------------------------

export async function addContactAction(input: {
  pipeline: Pipeline;
  searchId?: string | null;
  contact: RawContact;
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    await requireAuth();
    const owner = await actorLabel();
    const res = await upsertContact(
      { ...input.contact, source: input.contact.source || "Manual" },
      { pipeline: input.pipeline, searchId: input.searchId ?? null, owner },
    );
    revalidate();
    return { ok: true, id: res.id };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Failed to add contact" };
  }
}

export async function importCsvAction(input: {
  pipeline: Pipeline;
  searchId?: string | null;
  filename?: string;
  source?: string;
  csv: string;
}): Promise<{ ok: boolean; inserted?: number; duplicates?: number; total?: number; error?: string }> {
  try {
    await requireAuth();
    const owner = await actorLabel();
    const source = input.source?.trim() || `CSV: ${input.filename ?? "upload"}`;
    const raws = csvToRawContacts(input.csv, source);
    if (!raws.length) return { ok: false, error: "No usable rows found. CSV needs at least a name plus an email or LinkedIn URL column." };
    const { inserted, duplicates } = await upsertMany(raws, {
      pipeline: input.pipeline,
      searchId: input.searchId ?? null,
      owner,
    });
    await recordImportBatch({
      filename: input.filename,
      source,
      pipeline: input.pipeline,
      rowCount: raws.length,
      inserted,
      duplicates,
      importedBy: owner,
    });
    revalidate();
    return { ok: true, inserted, duplicates, total: raws.length };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Import failed" };
  }
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export async function scoreContactAction(input: {
  contactId: string;
  pipeline: Pipeline;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    await requireAuth();
    const contact = await getContact(input.contactId);
    if (!contact) return { ok: false, error: "Contact not found" };
    const scorecard = await getActiveScorecard(input.pipeline);
    const result = await scoreContact(contact, input.pipeline, scorecard.content);
    if (!result) return { ok: false, error: "Scoring unavailable (no ANTHROPIC_API_KEY or the model call failed)." };
    await saveScore({
      contactId: contact.id,
      pipeline: input.pipeline,
      scorecardName: scorecard.name,
      dimensions: result.dimensions,
      overall: result.overall,
      recommendation: result.recommendation,
      summary: result.summary,
      strongestSignal: result.strongestSignal,
      biggestConcern: result.biggestConcern,
      nextAction: result.nextAction,
      model: result.model,
    });
    revalidate();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Scoring failed" };
  }
}

export async function scoreAllAction(input: {
  pipeline: Pipeline;
  searchId?: string | null;
  onlyUnscored?: boolean;
  limit?: number;
}): Promise<{ ok: boolean; scored?: number; error?: string }> {
  try {
    await requireAuth();
    const scorecard = await getActiveScorecard(input.pipeline);
    const contacts = await loadContacts({ pipeline: input.pipeline, searchId: input.searchId ?? null });
    const targets = (input.onlyUnscored ? contacts.filter((c) => !c.score) : contacts).slice(0, input.limit ?? 25);
    let scored = 0;
    for (const contact of targets) {
      const result = await scoreContact(contact, input.pipeline, scorecard.content);
      if (!result) continue;
      await saveScore({
        contactId: contact.id,
        pipeline: input.pipeline,
        scorecardName: scorecard.name,
        dimensions: result.dimensions,
        overall: result.overall,
        recommendation: result.recommendation,
        summary: result.summary,
        strongestSignal: result.strongestSignal,
        biggestConcern: result.biggestConcern,
        nextAction: result.nextAction,
        model: result.model,
      });
      scored++;
    }
    revalidate();
    return { ok: true, scored };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Batch scoring failed" };
  }
}

// ---------------------------------------------------------------------------
// Outreach drafting + tracking
// ---------------------------------------------------------------------------

export async function draftOutreachAction(input: {
  contactId: string;
  pipeline: Pipeline;
}): Promise<{ ok: boolean; emailSubject?: string; emailBody?: string; linkedinMessage?: string; outreachId?: string; error?: string }> {
  try {
    await requireAuth();
    const owner = await actorLabel();
    const base = await getContact(input.contactId);
    if (!base) return { ok: false, error: "Contact not found" };
    if (base.optOut) return { ok: false, error: "This person has opted out — outreach is blocked." };
    // Pull the latest score in for personalization context.
    const withScore = (await loadContacts({ pipeline: input.pipeline })).find((c) => c.id === base.id);
    const contact = withScore ?? base;
    const draft = await draftOutreach(contact, input.pipeline, owner);
    if (!draft) return { ok: false, error: "Drafting unavailable (no ANTHROPIC_API_KEY or the model call failed)." };

    const saved = await saveOutreach({
      contactId: contact.id,
      pipeline: input.pipeline,
      channel: "email",
      subject: draft.emailSubject,
      body: draft.emailBody,
      owner,
      status: "drafted",
    });
    const bodyWithFooter = draft.emailBody + unsubscribeFooter(saved.unsubscribeToken);
    await updateOutreach(saved.id, { body: bodyWithFooter });

    revalidate();
    return {
      ok: true,
      emailSubject: draft.emailSubject,
      emailBody: bodyWithFooter,
      linkedinMessage: draft.linkedinMessage,
      outreachId: saved.id,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Drafting failed" };
  }
}

export async function updateOutreachAction(input: {
  outreachId: string;
  status?: OutreachStatus;
  owner?: string | null;
  subject?: string | null;
  body?: string | null;
  lastContactDate?: string | null;
  nextFollowUpDate?: string | null;
  response?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    await requireAuth();
    const { outreachId, ...fields } = input;
    await updateOutreach(outreachId, fields);
    revalidate();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Update failed" };
  }
}

export async function logManualOutreachAction(input: {
  contactId: string;
  pipeline: Pipeline;
  channel: OutreachChannel;
  status: OutreachStatus;
  subject?: string;
  body?: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    await requireAuth();
    const owner = await actorLabel();
    await saveOutreach({
      contactId: input.contactId,
      pipeline: input.pipeline,
      channel: input.channel,
      subject: input.subject ?? null,
      body: input.body ?? null,
      owner,
      status: input.status,
    });
    revalidate();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Failed to log outreach" };
  }
}

// ---------------------------------------------------------------------------
// Contact edits, owner assignment, consent / opt-out
// ---------------------------------------------------------------------------

export async function updateContactAction(input: {
  contactId: string;
  owner?: string | null;
  consentStatus?: ConsentStatus;
  pipeline?: Pipeline[];
  title?: string | null;
  company?: string | null;
  location?: string | null;
  email?: string | null;
  phone?: string | null;
  linkedinUrl?: string | null;
  profileSummary?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    await requireAuth();
    const { contactId, ...fields } = input;
    await updateContactFields(contactId, fields);
    revalidate();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Update failed" };
  }
}

export async function optOutAction(input: {
  contactId: string;
  reason?: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const who = await actorLabel();
    await requireAuth();
    await setOptOut(input.contactId, input.reason?.trim() || `Manual opt-out by ${who}`);
    revalidate();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Opt-out failed" };
  }
}

// ---------------------------------------------------------------------------
// Scorecard editing
// ---------------------------------------------------------------------------

export async function saveScorecardAction(input: {
  pipeline: Pipeline;
  name: string;
  content: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    await requireAuth();
    const updatedBy = await actorLabel();
    await saveScorecard({ ...input, updatedBy });
    revalidate();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Failed to save scorecard" };
  }
}
