#!/usr/bin/env node
/**
 * Revert (undo) candidate disqualifications on specific Workable jobs.
 *
 * Use this to reverse disqualifications that were applied automatically in
 * error. It is DRY-RUN by default: it prints exactly what it would revert and
 * changes nothing until you pass --apply.
 *
 * Usage:
 *   node --env-file=.env.local scripts/revert-disqualifications.mjs            # dry run
 *   node --env-file=.env.local scripts/revert-disqualifications.mjs --apply    # perform reverts
 *
 * Optional flags:
 *   --jobs="clinical data manager,principal cra"   override the job title matches
 *   --member=<member_id>                            member id credited with the revert
 *   --reason-contains="<text>"                      only revert when the disqualification
 *                                                   reason/note contains this text
 *   --actor="<name or id>"                          only revert candidates whose
 *                                                   disqualification was performed by this
 *                                                   actor (the automation). Substring,
 *                                                   case-insensitive. Without it, the dry run
 *                                                   just reports the actor for each candidate.
 *
 * Required env (in .env.local or the shell):
 *   WORKABLE_TOKEN       SPI v3 bearer token (scope: r_jobs, r_candidates, w_candidates)
 *   WORKABLE_SUBDOMAIN   account subdomain (defaults to "rditrials")
 *   WORKABLE_MEMBER_ID   optional default member id (else first admin is used)
 */

const TOKEN = process.env.WORKABLE_TOKEN ?? process.env.WORKABLE_API_KEY;
const SUBDOMAIN = process.env.WORKABLE_SUBDOMAIN || "rditrials";
const BASE = `https://${SUBDOMAIN}.workable.com/spi/v3`;

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const getFlag = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

const DEFAULT_JOB_MATCHES = ["clinical data manager", "principal cra"];
const JOB_MATCHES = (getFlag("jobs") ?? DEFAULT_JOB_MATCHES.join(","))
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const MEMBER_OVERRIDE = getFlag("member") ?? process.env.WORKABLE_MEMBER_ID;
const REASON_CONTAINS = (getFlag("reason-contains") ?? "").trim().toLowerCase();
const ACTOR_FILTER = (getFlag("actor") ?? "").trim().toLowerCase();

if (!TOKEN) {
  console.error(
    "Missing WORKABLE_TOKEN. Add it to .env.local and run with --env-file=.env.local",
  );
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
  Accept: "application/json",
};

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Workable ${res.status} on ${path}: ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

async function listAllJobs() {
  const out = [];
  let url = "/jobs?limit=100";
  for (let i = 0; i < 50 && url; i += 1) {
    const data = await api(url);
    out.push(...(data.jobs ?? []));
    const next = data.paging?.next;
    url = next ? next.replace(BASE, "") : null;
  }
  return out;
}

async function listDisqualifiedCandidates(shortcode) {
  const out = [];
  let url = `/jobs/${shortcode}/candidates?limit=100`;
  for (let i = 0; i < 50 && url; i += 1) {
    const data = await api(url);
    out.push(...(data.candidates ?? []));
    const next = data.paging?.next;
    url = next ? next.replace(BASE, "") : null;
  }
  return out.filter((c) => c.disqualified === true);
}

async function getDisqualifier(candidateId) {
  let activities = [];
  try {
    const data = await api(
      `/candidates/${candidateId}/activities?limit=100`,
    );
    activities = data.activities ?? [];
  } catch {
    return { actor: "(activities unavailable)", at: null };
  }
  const disq = activities
    .filter((a) => `${a.action ?? ""}`.toLowerCase().includes("disqualif"))
    .filter((a) => !`${a.action ?? ""}`.toLowerCase().includes("revert"));
  const latest = disq[0] ?? null;
  if (!latest) return { actor: "(no disqualify activity)", at: null };
  const m = latest.member ?? latest.actor ?? {};
  const actorName = m.name ?? m.id ?? "(unknown)";
  const actorId = m.id ?? "";
  return { actor: actorName, actorId, at: latest.created_at ?? null };
}

async function pickMemberId() {
  if (MEMBER_OVERRIDE) return MEMBER_OVERRIDE;
  const data = await api("/members");
  const members = data.members ?? [];
  const admin =
    members.find((m) => (m.role ?? "").toLowerCase() === "admin") ?? members[0];
  if (!admin) throw new Error("No members found to credit the revert to");
  return admin.id;
}

function fmt(c) {
  const reason = c.disqualification_reason ?? c.disqualified_reason ?? "";
  return `${c.name} <${c.email ?? "no-email"}> [${c.id}] stage="${c.stage}" reason="${reason}"`;
}

async function main() {
  console.log(
    `Mode: ${APPLY ? "APPLY (will revert)" : "DRY RUN (no changes)"}  subdomain=${SUBDOMAIN}`,
  );
  console.log(`Matching jobs whose title contains: ${JOB_MATCHES.join(" | ")}`);
  if (REASON_CONTAINS) console.log(`Filter: reason contains "${REASON_CONTAINS}"`);

  const jobs = await listAllJobs();
  const matched = jobs.filter((j) =>
    JOB_MATCHES.some((m) => j.title.toLowerCase().includes(m)),
  );

  if (!matched.length) {
    console.error("\nNo jobs matched. Available jobs:");
    for (const j of jobs) console.error(`  - ${j.title}  (${j.shortcode}, ${j.state})`);
    process.exit(1);
  }

  console.log("\nMatched jobs:");
  for (const j of matched) console.log(`  - ${j.title}  (${j.shortcode}, ${j.state})`);

  const memberId = await pickMemberId();
  console.log(`\nReverts credited to member_id=${memberId}`);

  let totalReverted = 0;
  let totalSkipped = 0;

  for (const job of matched) {
    const disq = await listDisqualifiedCandidates(job.shortcode);

    // Annotate every disqualified candidate with who performed the disqualification.
    const annotated = [];
    for (const c of disq) {
      const who = await getDisqualifier(c.id);
      annotated.push({ ...c, _by: who.actor, _byId: who.actorId, _at: who.at });
      await new Promise((r) => setTimeout(r, 150));
    }

    const reasonOk = (c) =>
      !REASON_CONTAINS ||
      `${c.disqualification_reason ?? ""} ${c.disqualified_reason ?? ""}`
        .toLowerCase()
        .includes(REASON_CONTAINS);
    const actorOk = (c) =>
      !ACTOR_FILTER ||
      `${c._by ?? ""} ${c._byId ?? ""}`.toLowerCase().includes(ACTOR_FILTER);

    const targets = annotated.filter((c) => reasonOk(c) && actorOk(c));

    console.log(
      `\n=== ${job.title} (${job.shortcode}) — ${disq.length} disqualified, ${targets.length} selected ===`,
    );
    // Show the full disqualified set so human-made ones are visible and verifiable.
    for (const c of annotated) {
      const mark = targets.includes(c) ? "REVERT" : "keep  ";
      console.log(`   [${mark}] by="${c._by}" at=${c._at ?? "?"}  ${fmt(c)}`);
    }

    if (!ACTOR_FILTER && !REASON_CONTAINS) {
      const actors = [...new Set(annotated.map((c) => c._by))];
      console.log(
        `   distinct disqualifiers on this job: ${actors.map((a) => `"${a}"`).join(", ")}`,
      );
    }

    if (!APPLY) {
      totalSkipped += targets.length;
      continue;
    }

    for (const c of targets) {
      try {
        await api(`/candidates/${c.id}/revert`, {
          method: "POST",
          body: JSON.stringify({ member_id: memberId }),
        });
        totalReverted += 1;
        console.log(`     reverted ${c.id}`);
      } catch (err) {
        console.error(`     FAILED ${c.id}: ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  console.log("\n----------------------------------------");
  if (APPLY) {
    console.log(`Done. Reverted ${totalReverted} candidate(s).`);
  } else {
    console.log(
      `Dry run complete. ${totalSkipped} candidate(s) would be reverted. Re-run with --apply to perform.`,
    );
  }
}

main().catch((err) => {
  console.error("\nError:", err.message);
  process.exit(1);
});
