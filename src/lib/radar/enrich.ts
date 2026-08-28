import "server-only";
import { providerOf, runEnrichment } from "./providers";
import { applyEnrichment, getContact, listContactsNeedingEmail } from "./store";
import type { Pipeline } from "./types";

export interface EnrichEmailsResult {
  attempted: number;
  emailsFound: number;
  errors: { provider: string; message: string }[];
}

/**
 * Fetch the contact details providers only hand over on a second, credit-
 * consuming call, and write them back onto the stored contacts.
 *
 * Shared by the Clerk-gated server action and the cron route, so the credit-
 * spending logic lives in exactly one place. Callers own authorization.
 */
export async function enrichContactEmails(input: {
  pipeline: Pipeline;
  searchId?: string | null;
  contactIds?: string[];
  limit?: number;
}): Promise<EnrichEmailsResult> {
  const targets = input.contactIds?.length
    ? (await Promise.all(input.contactIds.map((id) => getContact(id)))).filter(
        (c): c is NonNullable<typeof c> => Boolean(c && !c.optOut && c.providerRef && !c.email),
      )
    : await listContactsNeedingEmail({
        pipeline: input.pipeline,
        searchId: input.searchId ?? null,
        limit: input.limit ?? 25,
      });

  if (!targets.length) return { attempted: 0, emailsFound: 0, errors: [] };

  const byRef = new Map(targets.map((c) => [c.providerRef as string, c]));
  const seamless: string[] = [];
  const apollo: string[] = [];
  for (const contact of targets) {
    const provider = providerOf(contact.source);
    if (provider === "seamless") seamless.push(contact.providerRef as string);
    else if (provider === "apollo") apollo.push(contact.providerRef as string);
  }

  const { details, errors } = await runEnrichment({ seamless, apollo });

  let emailsFound = 0;
  for (const detail of details) {
    const contact = byRef.get(detail.providerRef);
    if (!contact) continue;
    await applyEnrichment(contact.id, detail);
    if (detail.email) emailsFound++;
  }

  return { attempted: targets.length, emailsFound, errors };
}
