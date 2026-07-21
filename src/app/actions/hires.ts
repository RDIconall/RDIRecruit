"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@clerk/nextjs/server";
import { markAllHiresRead, markHireRead } from "@/lib/hires/store";

async function requireAuth(): Promise<string> {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");
  return userId;
}

export async function markHireReadAction(input: {
  candidateIds: string[];
  read: boolean;
}): Promise<{ ok: boolean; message?: string }> {
  try {
    const userId = await requireAuth();
    if (!input.candidateIds?.length) {
      return { ok: false, message: "No candidates selected" };
    }
    await markHireRead({
      candidateIds: input.candidateIds,
      read: input.read,
      readBy: userId,
    });
    revalidatePath("/hires");
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Failed" };
  }
}

export async function markAllHiresReadAction(): Promise<{
  ok: boolean;
  marked: number;
  message?: string;
}> {
  try {
    const userId = await requireAuth();
    const marked = await markAllHiresRead(userId);
    revalidatePath("/hires");
    return { ok: true, marked };
  } catch (err) {
    return {
      ok: false,
      marked: 0,
      message: err instanceof Error ? err.message : "Failed",
    };
  }
}
