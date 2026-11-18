import "server-only";
import { auth } from "@clerk/nextjs/server";
import { actorLabel, founderKindFor } from "@/lib/triage/founders";
import type { ReviewerKind } from "@/lib/triage/types";

export interface Actor {
  /** Clerk user id of the signed-in caller — the only identity persisted on writes. */
  id: string;
  kind: ReviewerKind;
  label: string;
}

/** Resolve the signed-in caller from the Clerk session, or throw. */
export async function requireActor(): Promise<Actor> {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");
  return { id: userId, kind: founderKindFor(userId), label: actorLabel(userId) };
}
