import { NextRequest, NextResponse } from "next/server";
import { hasSupabase } from "@/lib/env";
import { setOptOutByToken } from "@/lib/radar/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Public opt-out endpoint hit from the unsubscribe link in outbound emails.
// One-click: marks the contact opted out and cancels pending/sent outreach.
// Always returns a friendly confirmation page (even on unknown token) so the
// recipient is never shown an error and never told whether a token was valid.
function page(message: string): NextResponse {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Unsubscribed — RDI</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#fafaf7;color:#162335;font-family:-apple-system,system-ui,sans-serif}
  .card{max-width:480px;padding:40px;text-align:center}
  h1{font-size:20px;margin:0 0 12px}
  p{font-size:15px;line-height:1.5;color:rgba(22,35,53,.7);margin:0}
  .mark{width:40px;height:40px;border-radius:10px;background:#e74424;margin:0 auto 20px}
</style></head><body><div class="card"><div class="mark"></div>
<h1>You're unsubscribed</h1><p>${message}</p></div></body></html>`;
  return new NextResponse(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  if (!token) {
    return page("No record matched this link, but you won't receive further outreach if you replied to opt out.");
  }
  if (!hasSupabase()) {
    return page("Your request was received. You won't receive further outreach from RDI.");
  }
  try {
    await setOptOutByToken(token, "Unsubscribed via email link");
  } catch {
    // Swallow — never surface an error to the recipient.
  }
  return page("You won't receive any further outreach from RDI. Thank you.");
}
