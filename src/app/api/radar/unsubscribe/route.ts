import { NextRequest, NextResponse } from "next/server";
import { hasSupabase } from "@/lib/env";
import { setOptOutByToken } from "@/lib/radar/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Public opt-out endpoint for the unsubscribe link in outbound emails.
// Opening the link (GET/HEAD) only renders a confirmation form and never
// writes: mail scanners and link previewers fetch footer links before the
// recipient chooses anything. The opt-out is applied only by the POST the
// recipient submits from that form.
// Always returns a friendly page (even on unknown token) so the recipient is
// never shown an error and never told whether a token was valid.

const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const token = value.trim();
  return TOKEN_PATTERN.test(token) ? token : null;
}

function page(title: string, body: string): NextResponse {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex, nofollow"/>
<title>${title} — RDI</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#fafaf7;color:#162335;font-family:-apple-system,system-ui,sans-serif}
  .card{max-width:480px;padding:40px;text-align:center}
  h1{font-size:20px;margin:0 0 12px}
  p{font-size:15px;line-height:1.5;color:rgba(22,35,53,.7);margin:0}
  .mark{width:40px;height:40px;border-radius:10px;background:#e74424;margin:0 auto 20px}
  button{margin-top:24px;padding:10px 20px;font-size:15px;border:0;border-radius:8px;
    background:#162335;color:#fff;cursor:pointer}
</style></head><body><div class="card"><div class="mark"></div>
<h1>${title}</h1>${body}</div></body></html>`;
  return new NextResponse(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

function confirmationPage(token: string): NextResponse {
  return page(
    "Unsubscribe from RDI outreach?",
    `<p>Confirm below and you won't receive any further outreach from RDI.</p>
<form method="post" action="/api/radar/unsubscribe">
<input type="hidden" name="token" value="${token}"/>
<button type="submit">Unsubscribe</button>
</form>`,
  );
}

function donePage(message: string): NextResponse {
  return page("You're unsubscribed", `<p>${message}</p>`);
}

export async function GET(request: NextRequest) {
  const token = parseToken(request.nextUrl.searchParams.get("token"));
  if (!token) {
    return page(
      "Unsubscribe from RDI outreach",
      "<p>This link is incomplete. Reply to the email you received to opt out and you won't receive further outreach.</p>",
    );
  }
  return confirmationPage(token);
}

export async function POST(request: NextRequest) {
  let token: string | null = null;
  try {
    const form = await request.formData();
    token = parseToken(form.get("token"));
  } catch {
    // Not a form submission — treat as no token.
  }
  if (!token) {
    return donePage("No record matched this link, but you won't receive further outreach if you replied to opt out.");
  }
  // A browser POST from another site (e.g. an auto-submitting form) is not the
  // recipient confirming on our page; ask them to confirm here instead.
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return confirmationPage(token);
  }
  if (!hasSupabase()) {
    return donePage("Your request was received. You won't receive further outreach from RDI.");
  }
  try {
    await setOptOutByToken(token, "Unsubscribed via email link");
  } catch {
    // Swallow — never surface an error to the recipient.
  }
  return donePage("You won't receive any further outreach from RDI. Thank you.");
}
