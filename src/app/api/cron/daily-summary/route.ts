import { NextRequest, NextResponse } from "next/server";
import { env, summaryRecipients } from "@/lib/env";
import {
  collectDailySummary,
  renderSummaryHtml,
  renderSummaryText,
  summarySubject,
} from "@/lib/triage/daily-summary";
import { sendEmail } from "@/lib/email/send";

export const maxDuration = 300;

/**
 * Daily applicant summary: every candidate who applied in the last N hours
 * (default 24), with one highlighted top candidate and the rest grouped by
 * their triage status + the "why". Emailed via Resend.
 *
 * Query params:
 *   ?hours=<n>  — change the look-back window (default 24)
 *   ?dry=1      — render and return the email without sending (preview/testing)
 *   ?to=<csv>   — override recipients (testing); defaults to SUMMARY_EMAIL_TO
 */
export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (env.CRON_SECRET && auth !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const hoursRaw = Number(params.get("hours"));
  const windowHours = Number.isFinite(hoursRaw) && hoursRaw > 0 ? Math.min(hoursRaw, 168) : 24;
  const dry = params.get("dry") === "1";
  const toOverride = params.get("to");

  try {
    const summary = await collectDailySummary(windowHours);
    const html = renderSummaryHtml(summary);
    const text = renderSummaryText(summary);
    const subject = summarySubject(summary);

    if (dry) {
      return new NextResponse(html, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    const recipients = toOverride
      ? toOverride.split(",").map((a) => a.trim()).filter(Boolean)
      : summaryRecipients();

    const result = await sendEmail({ to: recipients, subject, html, text });

    return NextResponse.json({
      ok: true,
      windowHours,
      total: summary.total,
      top: summary.top?.firstName ?? null,
      groups: summary.groups.map((g) => ({ status: g.label, count: g.candidates.length })),
      email: result,
    });
  } catch (error) {
    console.error("daily-summary cron failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Daily summary failed" },
      { status: 500 },
    );
  }
}
