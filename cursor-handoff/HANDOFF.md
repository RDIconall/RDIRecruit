# RDIRecruit — Candidate Triage · Cursor handoff

A working visual + interaction reference for the candidate-triage tool.

- **`RDIRecruit (standalone).html`** — open in any browser. Fully offline, no build. This is the source of truth for layout, copy, colors, and behavior.
- **`RDIRecruit.dc.html`** — the source. Inline styles + one logic class (`class Component`). Read it for exact values; everything is plain HTML/JS.
- Target repo: **RDIconall/rditrialswebsite** (Next.js). Follow its `AGENTS.md`.

## The product in one line
AI protects Conall's interview time by **cutting weak candidates first**, ranking who to interview, and — only for candidates worth it — producing an RO-style career progression. It is a **decision tool**, not an ATS or a resume scorer.

## Screens
**Pool (cut-first)**
- Pool read + counts (To cut / Strong interview / Worth screening / Hold / Review blocked).
- **Cut list**, grouped by failure type (application-care / evidence / career-pattern / role-mismatch). Each row: candidate · role · cut reason + two buttons — **✕ disqualify** (persists, strikes the row) and **? run deep analysis**. "Disqualify all open" bulk action.
- **Interview priority** table below (decision, reviewer signal, why, ask/RO, main risk, next action).

**Candidate page**
1. Short decision read — **Decision · Why · Main risk · Next action · Sources** (the 15-second answer).
2. Reviewer signal (Conall/Lara lens) + human re-analysis when a human note changes the decision.
3. **Deep analysis — gated.** Ask-vs-pool, RO level vs pool, and the **RO-style time progression** (education, roles, gaps, language-level column, certificates) show by default **only for Interview first / Short screen / Verify first**. For Cut/Hold/Review blocked it's hidden behind **Run deep analysis anyway**.
4. Cover letter + application answers as **margin comments** (AI-written / wrong-company / contradiction / "paid attention"); reviewers can reply to train the model. Inline text is highlighted only where a comment flags it.
5. Logistics check (Van Nuys 5-day feasibility / remote track record).
6. Interview summary (transcript → fit) + **Fireflies** recordings.
7. **Candidate working file** (`<id>.md`) — corrections log + Download .md.

## Decision vocabulary (the ONLY status language — no scores, no tiers)
`Interview first` · `Short screen` · `Verify first` · `Hold` · `Cut` · `Review blocked`

## Mocked — wire to real services server-side
- **Workable** — deeplinks are built as `https://rditrials.workable.com/backend/jobs/{job}/candidates/{id}` from a hashed id (`wcand()`/`candUrl()` in the logic class). Replace with real candidate IDs from the Workable API, and pull candidate data (resume, cover letter, application answers, salary, logistics) from there.
- **Fireflies** — the recordings list and transcripts are sample data on each candidate (`fireflies: [...]`). Wire the Fireflies API to (a) list meetings matched to a candidate and (b) return the transcript on **Pull in**.
- **Persistence** — all human edits (disqualify, timeline corrections, comment replies, corrections log, transcripts, run-deep flags) are stored in `localStorage` under key `rdi-recruit-ws-v1` for the prototype. Move this to the DB. The per-candidate **working-file `.md`** (Download .md / `buildMd()`) is the intended record format for "one candidate = one living case file."

## Brand
RDI design system — **National 2 / Söhne Mono / Tiempos Headline**; navy `#162335`, orange `#E74424`, cream `#FAFAF7`; brick `#9E3B28` reserved for cut/flags. No new hues, no gradients, no emoji.

## Intentionally NOT in scope (removed on request)
- Numeric 0–100 scores / fit grades.
- Interview time-cost math.
- AI-generated interview / pressure-test plans.
