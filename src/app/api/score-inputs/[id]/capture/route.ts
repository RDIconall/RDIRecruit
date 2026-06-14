import { NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase/server";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const supabase = getServiceSupabase();
  const { data: input } = await supabase
    .from("score_inputs")
    .select("*")
    .eq("id", id)
    .single();

  if (!input) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let captureUrl: string | null = null;
  if (input.capture_path) {
    const { data } = await supabase.storage
      .from("captures")
      .createSignedUrl(input.capture_path, 3600);
    captureUrl = data?.signedUrl ?? null;
  }

  return NextResponse.json({
    caption: input.claim,
    kind: input.capture_kind,
    capture_url: captureUrl,
    quote: input.quote,
    source_ref: input.source_ref,
  });
}
