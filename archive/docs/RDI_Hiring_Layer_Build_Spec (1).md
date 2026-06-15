# RDI Hiring Layer — Build Spec

**For:** Cursor / Claude Code
**Owner:** Conall, RDI Trials
**Stack:** Next.js (App Router) on Vercel · Supabase (Postgres + Auth + Storage) · Claude API
**Decision:** Build a thin intelligence layer **on top of Workable** (headless), not a full ATS. Workable stays the system of record for distribution, EEO/consent capture, candidate email threading, and retention. This layer owns ranking, scoring, provenance, the RO read, the life-narrative, and the comms loop. Reversible by design — if Workable ever becomes the constraint, the data is already mirrored in Postgres.

Brand tokens: Navy `#162335`, Orange `#E74424`, Cream `#FAFAF7`; Instrument Sans (body), Instrument Serif Italic (hero only).

---

## 1. Data flow

```
Workable ──webhook(candidate_created, candidate_moved)──▶ /api/hooks/workable ──▶ Supabase (upsert)
   ▲                                                                                    │
   │  write-back (tags, comments, stage)  ◀── rate-limited queue (10 req / 10s) ────────┤
   │                                                                                    ▼
Vercel Cron (nightly) ──poll Jobs API + Events API──▶ reconcile (catch dropped events)  Scoring engine
                                                                                        (rubric-as-data
VideoAsk ──webhook(response)──▶ /api/hooks/videoask ──▶ transcript ─┐                    + LLM extract
Calendly ──webhook(booking)──▶ /api/hooks/calendly ──▶ stage move   ├──▶ evidence rows ─▶ RO + fit +
Fireflies ──fetch(meeting_id)──▶ /api/ingest/fireflies ─────────────┤      re-score (versioned)
Workable templates ◀── stage-move fires send · Gmail (read-only) ──▶ reply capture ─┘      ─▶ re-rank
```

Every external signal normalizes into `events` (raw sink) and produces `evidence` rows with provenance. Nothing scores without a traceable source.

---

## 2. Services & env

| Concern | Service | Notes |
|---|---|---|
| App + API | Next.js on Vercel | App Router; serverless for hooks, Cron for reconcile |
| DB / auth / storage | Supabase | Postgres + RLS; Storage for recorded assets/transcripts |
| ATS of record | Workable API | `https://{sub}.workable.com/spi/v3`; token in env; scopes `r_candidates r_jobs w_candidates` |
| Scoring / extraction | Claude API | `claude-sonnet-4-6` for extraction + drafting |
| Send | Workable templates + stage automations | layer moves stage via API → Workable fires the templated email; tailored one-offs sent manually from the candidate profile. No custom send infra. |
| Reply capture | Gmail / M365 (read-only) | candidate replies thread into Workable and copy to the inbox; layer reads to attach as an evidence row |
| Async video | **VideoAsk** | browser-record, no install; API + webhooks; transcription on paid tier |
| Scheduling | Calendly | single-use scheduling links; booking webhook |
| Live-call transcript | Fireflies | fetch transcript by meeting id |
| Transcription (fallback) | Whisper / Deepgram | only if self-hosting capture instead of VideoAsk |
| Frame / crop capture | ffmpeg + PDF renderer (or provider thumbnail API) | render résumé pages and grab video frames at cited timestamps for the hover proof (§9a) |

Required env: `WORKABLE_TOKEN`, `WORKABLE_SUBDOMAIN`, `WORKABLE_WEBHOOK_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `ANTHROPIC_API_KEY`, `GMAIL_*` / `MS_*` (read-only — reply capture), `VIDEOASK_API_KEY`, `VIDEOASK_WEBHOOK_SECRET`, `CALENDLY_TOKEN`, `FIREFLIES_API_KEY`.

---

## 3. Data model (Postgres / Supabase)

```sql
create table jobs (
  shortcode        text primary key,        -- Workable shortcode
  workable_job_id  text,
  title            text not null,
  status           text,
  synced_at        timestamptz default now()
);

create table candidates (
  workable_id      text primary key,
  job_shortcode    text references jobs(shortcode),
  name             text, email text, phone text,
  location         text,
  stage            text, stage_kind text,
  disqualified     boolean default false,
  source           text,
  raw              jsonb,                    -- full Workable payload
  created_at       timestamptz, synced_at timestamptz default now()
);

create table applications (
  id               uuid primary key default gen_random_uuid(),
  candidate_id     text references candidates(workable_id) on delete cascade,
  answers          jsonb,                    -- question -> answer
  cover_letter     text,
  resume_url       text,
  parsed_experience jsonb,                   -- [{title,company,start,end,current,summary}]
  parsed_education  jsonb
);

-- Rubric stored as DATA, versioned. Changing weights is config, not a deploy.
create table rubrics (
  id               uuid primary key default gen_random_uuid(),
  job_shortcode    text references jobs(shortcode),  -- null = global default; a job with no rubric inherits it
  version          int not null,
  name             text,
  raw_md           text not null,            -- the human-authored markdown = source of truth
  definition       jsonb not null,           -- parsed: categories, deduction rules, "dangerous candidate" flags
  weights          jsonb not null,           -- parsed: {principal:25, environment:20, scope:20, writing:15, tenure:10, local:10}
  active           boolean default false,
  created_at       timestamptz default now()
);

-- Fit scores. NEVER updated. Each re-score writes a new row -> full history + re-rank.
create table scores (
  id               uuid primary key default gen_random_uuid(),
  candidate_id     text references candidates(workable_id) on delete cascade,
  rubric_version   int not null,
  category_scores  jsonb not null,           -- {principal:24, environment:19, ...}
  total            int not null,
  salary_value     text,                     -- justified | great value | rich for fit | poor value | unstated
  model_version    text,
  evidence_through uuid[],                   -- evidence rows folded into this score
  confidence       text,                     -- high | medium | text-unreliable  (see §6)
  created_at       timestamptz default now()
);

-- Claim <-> source provenance. Each row = one claim + the captured proof behind it (see §9a).
create table score_inputs (
  id               uuid primary key default gen_random_uuid(),
  score_id         uuid references scores(id) on delete cascade,
  category         text,
  claim            text,                     -- the AI's assertion
  source_type      text,                     -- resume | answer | application_field | lookup | transcript | reference
  source_ref       text,                     -- "resume:NaviMed bullet 6" | "videoask:q2 02:14" | "ref:prior CEO"
  quote            text,                     -- verbatim supporting text (text fallback for the popover)
  capture_kind     text,                     -- image_crop | video_frame | field_render | text_card | citation
  capture_path     text,                     -- Storage path to the cropped image (null for render-on-the-fly kinds)
  capture_locator  jsonb,                    -- where it lives, for re-crop + deep-link (see §9a)
  capture_status   text default 'pending'    -- pending | ready | failed
);

-- Requisite Organization read. Versioned alongside scores.
create table ro_assessments (
  id               uuid primary key default gen_random_uuid(),
  candidate_id     text references candidates(workable_id) on delete cascade,
  per_role         jsonb not null,           -- [{role,company,years,stratum,stratum_range,verbs:{I:[],II:[],III:[]}}]
  seat_stratum     text,                     -- the role's required stratum, e.g. "IIb-IIa"
  current_capability text,                   -- e.g. "IIa-IIIc"
  trajectory       text,                     -- grows-the-role | bends-away | plateaued | regressed
  text_confidence  text,                     -- confirmed | downgraded | text-unreliable  (see §6)
  basis            text,                     -- reasoning | role-and-tenure | reference
  created_at       timestamptz default now()
);

-- Every signal: application, async video, live screen, case study, reference.
create table evidence (
  id               uuid primary key default gen_random_uuid(),
  candidate_id     text references candidates(workable_id) on delete cascade,
  source_type      text not null,            -- application | async_video | screen | case_study | reference
  author           text,                     -- who ran it: Conall | Lara | candidate | prior principal
  captured_at      timestamptz,
  raw_ref          text,                     -- videoask response id, fireflies meeting id, etc.
  transcript       text,
  extracted        jsonb,                    -- rubric/RO moments w/ timestamps
  ai_likelihood    numeric,                  -- 0..1, see §7 (probabilistic, never auto-rejects)
  created_at       timestamptz default now()
);

-- Gap-free life narrative.
create table narratives (
  id               uuid primary key default gen_random_uuid(),
  candidate_id     text references candidates(workable_id) on delete cascade,
  segments         jsonb not null,           -- ordered [{span,type:role|gap|overlap,text,assumption:bool}]
  generated_at     timestamptz default now()
);

create table comms_log (
  id               uuid primary key default gen_random_uuid(),
  candidate_id     text references candidates(workable_id) on delete cascade,
  channel          text,                     -- gmail | m365 | resend | videoask | calendly
  direction        text,                     -- outbound | inbound
  template         text, subject text, body text,
  status           text,                     -- proposed | approved | sent | failed
  workable_logged  boolean default false,
  approved_by      text, sent_at timestamptz
);

create table events (
  id               uuid primary key default gen_random_uuid(),
  source           text,                     -- workable | calendly | videoask | fireflies | gmail
  type             text, payload jsonb,
  processed        boolean default false,
  received_at      timestamptz default now()
);

create table audit_log (
  id uuid primary key default gen_random_uuid(),
  actor text, action text, entity text, entity_id text,
  detail jsonb, at timestamptz default now()
);
```

RLS: enable on `candidates`, `applications`, `evidence`, `comms_log`, `narratives` (PII). Backend uses the service role; any human-facing read goes through authenticated Supabase users scoped to RDI. Raw `transcript` access is the most sensitive — log every read to `audit_log`.

---

## 4. Sync layer

- **Webhooks in:** subscribe via `POST /spi/v3/subscriptions` to `candidate_created` and `candidate_moved` (filter by job). Verify the `X-Workable-Signature` HMAC-SHA256 against `WORKABLE_WEBHOOK_SECRET`. Upsert into `candidates`/`applications`, keyed on `workable_id` (idempotent).
- **Reconciler (Vercel Cron, nightly):** Workable has **no job-level webhooks**, and webhooks drop. Poll the Jobs API + Events API, diff against Postgres, repair. Belt and suspenders.
- **Write-back queue:** Workable rate limit is **10 requests / 10 seconds** (429 on exceed). All writes (tags, comments, stage moves) go through a single queue with backoff. A 12-candidate bulk re-tag must drain through this, not fire in parallel.
- **Conflict policy:** Workable wins on candidate/stage facts; this layer wins on derived fields (scores, RO, narrative). The layer NEVER silently overwrites a Workable stage.

---

## 5. Scoring engine (fit, 100-pt)

- Rubric is **data** (`rubrics.definition` + `weights`), six categories: Principal 25 / Environment 20 / Scope 20 / Writing 15 / Tenure 10 / Local 10, with the deduction rules and the "dangerous candidate" flags encoded as definition entries.
- Two parts kept separate:
  1. **Deterministic math** in TypeScript over structured features (pure, testable).
  2. **LLM feature extraction** (Claude): parse résumé + answers into structured signals (principal type, company size, tenure, scope verbs, AI-boilerplate tell). Store the *features and their source quotes*, not just the number, so a rubric change re-scores without re-calling the model.
- Salary-value lens is a separate computed field: a high ask is only a problem when fit doesn't justify it (`justified | great value | rich for fit | poor value | unstated`). It does not change the fit rank.
- Every category writes a `score_inputs` row: `claim` (left pane) + `source_type`/`source_ref`/`quote` (right pane). This powers the audit UI; no claim ships without a receipt.

### 5a. Rubric lifecycle — per-job markdown, edit triggers full re-score
- **Source of truth:** each job's rubric is authored in **markdown** (the format you already write) and stored in `rubrics.raw_md`, scoped by `job_shortcode` (null = global default; a job with no rubric inherits it). EA and Controller carry different rubrics.
- **Where you load/edit it:** a **Rubric editor** screen per job in the app — paste or upload the `.md`, preview the parsed weights + flags, Save. Save parses the markdown → `definition` + `weights`, writes a **new** `rubrics` row (`version`++), and marks it active. No deploy. (Optional: also keep `rubrics/<job>.md` in the repo with a CLI/admin action that upserts versions, if you want it git-tracked — but the in-app editor is the primary path so a rubric change never needs a deploy.)
- **Saving triggers a re-score over the evidence already on file** — no re-interviewing, no new collection. The job enqueues a recompute for every candidate on that job. Two paths:
  - **Weights / thresholds / tiers changed** (e.g., Writing 15→20, or a tier cutoff): pure deterministic recompute over the already-extracted features. Fast, cheap, zero LLM calls.
  - **A category or its evidence definition changed** (e.g., add a "discretion" dimension): the LLM feature-extraction re-runs over the **stored raw evidence** (résumé text, transcripts) to pull the new feature, then recomputes. More expensive, but still reads only what's already stored.
- Each recompute writes a **new** `scores` (and `ro_assessments`) row stamped with the new `rubric_version` and the `evidence_through` it used; the board re-ranks. Old scores stay attached to their old rubric version, so "91 under v3 / 88 under v4" is fully auditable, and a diff view shows who moved when the rubric changed.
- **Scope control:** default to re-scoring the active pipeline; archived/hired/rejected candidates can be left as-is or re-scored for analysis — chosen per run.

This is why §5 stores extracted *features* and raw evidence separately from the final number: a rubric change is a **recompute, not a re-collection**.

---

## 6. RO stratum module + the validation gate  *(core logic)*

### 6a. Stratum inference (hypothesis from text)
Apply the T. Owen Jacobs / Requisite Organization frame: a role's stratum is set by the **time-span of discretion** and **mental-processing complexity**, read off the *verbs* the candidate uses.

- **Stratum I** (concrete, days–weeks): scheduled, booked, filed, processed, greeted, entered.
- **Stratum II** (diagnostic, weeks–months): managed, triaged, anticipated, prioritized competing demands, owned end-to-end, maintained confidential.
- **Stratum III** (builds systems, quarters–year+): led [a multi-month project], built [a system], redesigned [a process] to prevent recurrence, established standards/templates, strategic partner across functions.

Output per role: a stratum + sub-level (a/b/c) and a range where the role spans levels. Plus: `seat_stratum` (what the RDI EA role requires — Stratum IIb–IIa), `current_capability`, and a `trajectory` (`grows-the-role | bends-away | plateaued | regressed`). **This is a hypothesis from self-reported text only.**

### 6b. The validation gate — protect against AI-overwritten text
When interview/answer evidence arrives, run two independent reads on the *answer itself*:

1. **Reasoning-stratum:** apply the same stratum model to *how they reason in the answer* (not what they claim). Does the thinking actually demonstrate Stratum II/III?
2. **AI-likelihood:** score whether the answer is machine-generated (§7).

Then resolve:

| Answer is… | Reasoning vs résumé claim | Result |
|---|---|---|
| Human-authentic | matches claimed stratum | **CONFIRMED** — trust the stratum; `text_confidence = confirmed`, `basis = reasoning` |
| Human-authentic | weaker than claimed | **DOWNGRADE** to the demonstrated level; the résumé over-claimed; `basis = reasoning` |
| Likely AI (and/or résumé shows the same inflation signature) | — | **TEXT UNRELIABLE** — capability is unjudgeable from words. Stop scoring stratum/writing from text. `text_confidence = text-unreliable` |

### 6c. Fallback when text is unreliable
When `text-unreliable` fires, do **not** guess capability from prose. Default to the channels that are expensive or impossible to fake, in this priority:

1. **Tenure** — sustained multi-year duration in a role (hard to fabricate). Long tenure at a level is weak-but-real evidence they could hold it.
2. **Role-level deduction** — the stratum the *actual job* inherently required, independent of bullet wording. (Sole EA to a CEO at a real PE firm for 4 years implies ≥ Stratum II no matter how the bullet reads.)
3. **Reference / principal judgment** — the revealed assessment of the people who hired, trusted, and retained them. **Weight this highest when text is poisoned.**

Set `basis = role-and-tenure` or `reference` accordingly, and surface the confidence label in the UI so a human reads "this score rests on references, not on their writing." The fit `scores.confidence` mirrors this (`high | medium | text-unreliable`).

### 6d. References as first-class evidence
Because 6c leans on prior principals, references are a normal `evidence.source_type = reference`, `author = prior principal`. The comms layer can *request* a structured reference (email to the prior principal with 3–4 targeted questions) the same way it requests a video. Reference responses score and re-rank like any other evidence, and carry the most weight when the text channel is unreliable.

---

## 7. AI-answer detection (flag, never auto-reject)
`ai_likelihood` is a **probability**, used only to *lower the text channel's weight* and trigger §6c — it must never auto-disqualify (false-accusation harm, and detection is imperfect). Signals to combine:
- Mirroring the job-post language back verbatim; generic closers ("maintain a positive working relationship / prevent recurrence").
- Stylometric uniformity / low burstiness vs. the candidate's other writing.
- Mismatch between the polish of the answer and the specificity of its content (lots of structure, no concrete detail).
- Cross-source inconsistency (e.g., a cover letter describing a different current employer than the résumé).
Surface the flag and the reasons; let a human confirm. The only automatic consequence is the fallback in §6c.

---

## 8. Life-narrative module
Generate a **gap-free** chronology from `parsed_experience` + `parsed_education`: every span from start of education to today must be accounted for.
- Unexplained gaps → an explicit bracketed assumption segment (`assumption:true`), e.g. "[~5 months between roles — likely job search]".
- Overlapping roles → a single "held two roles concurrently (dates)" segment, flagged to clarify (overlap can be a data error).
- Surfaces relocation gaps and résumé/cover-letter contradictions as their own segments.
Store ordered `segments`; render as the continuous timeline. A chronology that won't reconcile is itself a signal.

---

## 9. Evidence loop & re-ranking
- Sources: `application`, `async_video` (VideoAsk), `screen` (Fireflies, author = Conall/Lara), `case_study`, `reference`.
- Each ingestion: pull transcript/text → Claude extracts rubric + RO moments with provenance → write `evidence` row → re-run scorer → write a **new** `scores` row (and `ro_assessments` row) → re-rank the board.
- **Live evidence outranks paper:** a transcript can confirm, raise, or cut a category/stratum. The audit pane always shows which source currently drives each line.
- Author attribution is first-class: if Conall's and Lara's reads diverge on the same candidate, that divergence is visible.
- **Many videos per candidate, analyzed together:** a candidate accumulates N `evidence` rows (multiple VideoAsk responses, a Loom, your screen, Lara's screen, an emailed reply). Beyond per-video scoring, Claude runs a **cross-source consistency** pass — does the reasoning hold from the scripted async answer to the unrehearsed live screen; do Conall's and Lara's reads agree; does the spoken answer match the written application. Consistent Stratum-III reasoning across a scripted video AND a live, interrupted screen is far harder to fake than any single answer — so more videos strengthen the §6 validation, and disagreement between them is itself a signal.

---

## 9a. Source capture — the hover/tap proof  *(powers Component B in the design brief)*
Every scored claim must reveal **where it came from on hover/tap** — a screenshot of the source, not retyped text. The proof is captured **at scoring/ingest time and frozen**, so the popover is instant and survives later edits to the underlying record. Each `score_inputs` row (one claim↔source pair) carries its own capture in the columns above.

**How the crop is produced, per source type**
- **Résumé (`resume`)** — render the résumé (PDF/docx) to page images at ingest, stored under `captures/{candidate}/resume/`. LLM extraction returns the quote **plus a locator** (page + text span or bbox). Crop that region with light padding → `capture_path`, `capture_kind = image_crop`. If only a text span is known, locate it on the rendered page and crop around the highlighted line. A scanned/image résumé gives an approximate OCR locator → fall back to a page-level crop with the matched line highlighted.
- **Application field (`application_field`)** — a structured Workable answer (salary, work auth, in-office) has no native screenshot. Render a **field card** on the fly (label + verbatim value in app type); `capture_kind = field_render`, no stored image.
- **Cover letter / free-text (`answer`)** — render the quoted passage as a highlighted text card (surrounding sentence, quote emphasized); `capture_kind = text_card`.
- **Video (`async_video` / `screen` / `transcript`)** — grab the **frame at the cited timestamp** (poster frame via ffmpeg at ingest, or the provider thumbnail API) plus the transcript line; `capture_kind = video_frame`. The popover shows the frame captioned with the line and a **play affordance that deep-links to that timestamp**. VideoAsk and Fireflies both expose the timestamps.
- **Lookup (`lookup`)** — a rendered citation card of the enrichment record (e.g., the company-size source); `capture_kind = citation`.
- **Reference (`reference`)** — render the relevant **Q→A snippet** as a card. Do **not** screenshot a person's email — privacy.

**Locator shapes** (`capture_locator`, so a crop can be regenerated and a deep-link built):
```
resume :  { "kind":"pdf_region", "page":1, "bbox":[x,y,w,h], "doc_ref":"applications.resume_url" }
field  :  { "kind":"field", "field":"salary_expectation", "application_id":"…" }
video  :  { "kind":"video_frame", "evidence_id":"…", "t_seconds":134, "raw_ref":"videoask:resp_x" }
```

**Storage** — a **private** Supabase Storage bucket `captures/` (signed URLs only; never public). Path convention `captures/{candidate_id}/{score_input_id}.png`; video frames under `captures/{candidate_id}/frames/`.

**Frontend contract** — given a `score_input_id`, the API returns `{ caption, kind, capture_url (signed), deeplink? }`. Hover (desktop) / tap (mobile) → fetch + cache → show the image + caption; video kinds render a play button to the timestamp. Keyboard-focusable; dismisses on blur/scroll. **Always falls back to the verbatim `quote` if the capture is missing or `failed` — the popover is never blank.**

**When it runs** — capture is produced when the `score_inputs` row is written (scoring or evidence ingest), then `capture_status = ready`. A re-score (§5a) **reuses existing captures** unless the underlying evidence changed; a new video or reply produces captures only for its new rows.

**Compliance (extends §11)** — capture only the **claim's own region**, never the whole document; extraction already strips protected-class fields, so they never become a crop. The `captures/` bucket is RLS-locked with signed URLs, and every capture read is `audit_log`-tracked, like raw transcripts.

---

## 10. Comms layer  *(send lives in Workable — no custom send infra)*
- **Sending is Workable's job.** Use Workable communication templates (with variables). Two triggers: (a) **stage automations** — the layer moves a candidate's stage via the API and Workable fires the template bound to that stage (move to "Async interview" → VideoAsk-invite template; move to "Phone screen" → Calendly template; early-stage disqualify → rejection template); (b) **manual** — for a tailored one-off, send from the candidate profile, pick the template, edit in the one custom question. The layer never sends email itself; it proposes (candidate + which template + the tailored insert) and moves the stage.
- **Reply capture (read-only).** Because mail goes through Workable, a candidate reply threads onto the candidate timeline AND copies to the connected Gmail/M365 inbox. The layer reads it (cleanest via the Gmail API, matched by thread to the candidate), files it as `evidence(source_type='answer')`, runs rubric/RO/AI-likelihood, re-ranks. No manual forwarding. Rule: only ever send from a watched channel (Workable, or connected Gmail) so a reply can't land unseen.
- **Async video (VideoAsk):** invite template embeds the VideoAsk link. Candidate records **in-browser, no install**, phone or desktop. VideoAsk webhook → response (+ transcript on paid tier) → `evidence(async_video)` → score → re-rank. Question design in §10a.
- **Live screen (Calendly):** single-use link (Conall or Lara) in the screen template. Booking webhook → log + move stage + set interviewer. Call recorded by Fireflies → transcript by meeting id → evidence.
- **Loom:** optional, behind VideoAsk. No connected connector and limited transcript access — wire its API specially or paste the transcript/link. Not required if VideoAsk is the async path.
- **Inbound/state:** Gmail read (replies), Calendly webhooks (bookings), VideoAsk webhooks (responses), Fireflies (transcripts), Workable webhooks (stage). All into `events`; reconciler cron catches drops.

### 10a. The async step (VideoAsk) — questions in the email, video is the recording surface
Candidate flow:
1. **Intro video** — you explaining the role (recorded once, reused). This folds the role-intro link into VideoAsk; they meet you before they answer.
2. **Answer slot 1** — they record their answer to Q1.
3. **Answer slot 2** — they record their answers to Q2/Q3.
4. **Submit.**

- **Questions live in the invite email** (Workable template + your per-candidate tailored insert), not typed into VideoAsk. VideoAsk holds only the intro video and the open-ended answer slots.
- **What to ask** (selection logic unchanged): don't re-ask the application's factual gates (salary, work auth, in-office). Use **one repeated judgment anchor** — a scenario also in the written application — as the **cross-modal authenticity check** (does the spoken, unscripted reasoning match the written text? a mismatch feeds §6b), plus **one or two tailored risk probes** (writing soft-spot, timeline contradiction, stepping-stone). Job-relevant only.
- **Bind answers to questions.** Because the prompts sit in the email and VideoAsk captures only spoken answers, the layer reads the question set from the **actually-sent email** (back from the Workable timeline / connected Gmail, so your hand-edits are reflected) and maps response steps → questions (step 2 → Q1, step 3 → Q2/Q3). It's stored on the `evidence(async_video)` row so each answer is scored against the exact question asked, and the §6 cross-modal check knows the prompt.

---

## 11. Compliance firewall  *(non-negotiable)*
- Ingest only **job-relevant** fields. Hard-exclude protected-class data (age, religion, national origin, health, etc.) at extraction time — including from transcripts, which leak far more than a résumé.
- **No social-media trawl.** Not a feature. If background screening is ever needed, route to an FCRA-compliant third party post-conditional-offer, with consent, filtered before it reaches a human.
- Consent line in every async invite. Raw transcript access is RLS-locked and `audit_log`-tracked.
- Send-domain auth: SPF / DKIM / DMARC on `rditrials` so mail lands.

---

## 12. UI surfaces (Next.js + brand)
1. **Ranked board** — all candidates by fit, salary-value sub-line, tier filter, NEW applicants slot in at their rank; bulk select → Advance / Hold / Deny.
2. **Candidate detail — claim↔source** — each scoring claim is a one-line assertion; hover/tap reveals the **captured source image** (§9a) — résumé crop, field card, or video frame at the cited timestamp — with the verbatim quote as fallback.
3. **RO panel** — per-role stratum progression vs the seat band, the language buckets (I/II/III), trajectory word, and the confidence label + basis (reasoning / role-and-tenure / reference).
4. **Life-narrative timeline** — gap-free, bracketed assumptions, overlap merges.
5. **Invite composer** — AI-suggested risk questions, VideoAsk capture (intro video + answer slots), Calendly (Conall/Lara), gated send.

---

## 12a. Access, roles & assignment
- **One login per user** (Supabase Auth) to the layer — no per-tool logins to review. The layer holds the Workable / VideoAsk / Fireflies tokens centrally; users see synced data, videos, and scores in one place.
- **Roles:** `admin` (Conall — all jobs, manages rubrics, assigns users), `recruiter` / `hiring_manager` (Lara — scoped to assigned jobs), `viewer` (read-only). RLS keys off role + job membership.
- **You assign users to jobs, and candidates to people:**

```sql
create table app_users (
  id          uuid primary key,                   -- = Supabase auth.uid
  name        text, email text,
  role        text not null default 'recruiter'   -- admin | recruiter | hiring_manager | viewer
);
create table job_members (                         -- who works (and is alerted) on which job
  job_shortcode text references jobs(shortcode),
  user_id       uuid references app_users(id),
  role          text,                              -- owner | interviewer | viewer
  primary key (job_shortcode, user_id)
);
alter table candidates add column assignee_id uuid references app_users(id);  -- "Assign to Lara"
```

- A non-admin sees candidates only for jobs they're a `job_members` row on; admin sees all (RLS-enforced). **"Assign to Lara"** sets `assignee_id`, pushes the candidate into her queue, and notifies her even if it's outside her usual job scope. Interviewer attribution (`evidence.author`) ties to the assigned user.

## 12b. Alerts & notifications
- **Channels: email + in-app dashboard inbox** — both.
- **Instant push** when: (a) a new application **crosses the job's Strong threshold** (the rubric tier cutoff from §5a — "great candidate" is defined by your rubric, not a hardcoded number); (b) an **async video is submitted** and scored; optionally (c) a candidate **reply** arrives or (d) a screen is **booked**.
- **Digest** for everything below the bar — daily or weekly — so the instant alerts stay signal, not noise.
- **Routing:** a user is alerted for jobs they're a `job_members` of; admin gets every strong-fit across all reqs; "Assign to Lara" notifies her regardless of job scope.
- **Throttle / de-dup:** one alert per candidate per threshold-crossing — a later re-score that merely keeps them Strong doesn't re-ping; a *new* crossing or a *new* video does.
- Email alerts are **internal** (to the team), sent via a lightweight transactional sender or the connected Gmail — separate from candidate comms, which stay in Workable.

```sql
create table notifications (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references app_users(id),
  type         text,                          -- strong_fit | async_in | reply | booked | digest
  candidate_id text references candidates(workable_id),
  channel      text,                          -- email | in_app
  payload      jsonb, read boolean default false,
  created_at   timestamptz default now(), sent_at timestamptz
);
```

---

## 13. Build sequence (each step usable alone)
1. **Read-only mirror** — Workable webhook + cron → Supabase; see the pipeline in your own UI. (~weekend)
2. **Fit scorer** — rubric-as-data, deterministic + LLM extraction, provenance, ranked board.
3. **Write-back** — tags/comments/stage to Workable through the queue (automates what's been done by hand).
4. **RO module + validation gate (§6)** — stratum inference, the AI-contamination fallback, reference evidence.
5. **Life-narrative** + claim↔source audit UI **with source capture (§9a)** — render/crop at scoring time so the hover proof is ready.
6. **Comms loop** — Gmail/Resend send, VideoAsk async, Calendly, Fireflies ingestion, evidence-driven re-rank.
7. Rubric editor, score/RO version history, audit log.

**Highest-risk components (watch these):**
- Sync integrity — idempotent upserts, webhook+cron reconcile, conflict policy.
- The rate-limited write queue — or bulk actions 429.
- The §6 validation gate — getting the AI-contamination fallback honest (demote text, lean on tenure/role-level/references; never auto-reject on an AI flag).
- The compliance firewall on extraction inputs.
- Source-capture fidelity (§9a) — résumé text→bbox accuracy and video frame grabs; degrade to a line-highlight or the text fallback, never a blank popover.

---

## 14. Open config decisions
- VideoAsk plan (conditional logic + transcription are paid-tier) vs. self-hosted recorder (Whisper/Deepgram).
- Gmail vs Microsoft 365 as the 1:1 sender (both connected).
- Reference-request flow: who is contacted, what 3–4 questions, and how the response is weighted into `basis = reference`.
- Whether RO `seat_stratum` is fixed per req or set by you per role.
