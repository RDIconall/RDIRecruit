# Claude cost review

Where this app's Anthropic spend goes, what was changed to reduce it, and what is
left on the table. Token counts are measured from the prompt builders at ~4
characters per token; dollar figures use the [published
rates](https://platform.claude.com/docs/en/about-claude/pricing) and are per-call
estimates for a typical candidate file, not a billing statement. Real spend is now
logged per call — grep Vercel logs for `"scope":"claude"`.

## Where the money goes

Nine distinct Claude call sites existed. Two of them accounted for essentially all
of the spend, because they are the only ones that run per candidate with a large
prompt and a large structured response:

| Call site | Runs when | Prompt shape | Output cap |
| --- | --- | --- | --- |
| `scoring/evaluator.ts` | Every new applicant, and every re-score | Method doc + seat rubric + all candidate materials | 8,000 |
| `triage/recalc.ts` | Correction / transcript / deep analysis / bulk reanalyze | Engine rules + methodology + spec + rubric + roster + working file | 4,500 |
| `triage/chat.ts` | Every war-room chat turn | Working file + materials + rubric + roster, plus history | 1,500 |
| `resume/parse-resume.ts` | Résumé ingest | Résumé text | 4,000 |
| `radar/score.ts` | Every unscored sourcing contact (cron, 15 min) | Scorecard + profile | 1,800 |
| `radar/sourcing.ts` · `radar/outreach.ts` | User action | Small | 1,800 / 1,200 |
| `calibration/service.ts` | Reviewer correction | Two calibration docs | 1,500 |
| `board/summary.ts` | Every scoring batch, per published job | Top six candidates | 400 |
| `scoring/engine.ts` | Never — unreachable | — | 2,000 |

Two structural facts drove most of the waste:

**Output is billed at five times input.** The evaluator's response was the single
most expensive thing in the app, and a large fraction of it was never read by
anything. `evidenceProvenance`, `alternateSeatSignals`, `composeQuestions` and
`roDiagnostic` were persisted and never queried. `liveValidationQuestions` was
generated and never even persisted. `roReads[].burden`/`quote` and
`answerGrades[].capabilities`/`liveValidationQuestion`/`answerQuality` had no
reader anywhere in `src/`. Largest of all, `answerGrades[].answer` echoed every
application answer back verbatim — paying output rates to copy text that was
already sitting in `applications.answers`.

**The stable half of each prompt was being re-sent as fresh input.** Both big call
sites cached only their static system prompt. Everything job-level — the seat
rubric, the dimension weights, the learned calibration, the alternate-seat
rubrics, the output schema, the methodology doc, the role spec, the pool roster —
sat in the per-candidate user message. Scoring a pool of 200 candidates therefore
paid full input price for the same several thousand tokens 200 times over.

## What changed

**Model tier.** Everything ran on `claude-sonnet-4-6` at $3/$15 per MTok, now a
legacy generation. Judgment calls move to `claude-sonnet-5` at $2/$10 — a third
cheaper for the same work. Calibration-note distilling carries no hiring judgment,
so it moves to `claude-haiku-4-5` at $1/$5. Résumé chronology is reshaped
deterministically from Workable's fields; the canonical analysis already reads the
full résumé, so a separate parsing call bought no additional hiring judgment.
All model IDs now resolve through `src/lib/ai/models.ts` and can be pinned per
deploy with `CLAUDE_MODEL_JUDGMENT` / `CLAUDE_MODEL_EXTRACTION`.

**Prompt caching of everything job-level.** The evaluator now sends two cached
prefix blocks — the global method doc (identical across every job, so it stays warm
for a whole run) then the seat brief (identical across every candidate on a seat).
Only the candidate's own file is billed at full input price. The chat marks its
final turn so a long conversation reads its own history back at a tenth of the
price instead of re-paying for it each turn.

**Output trimmed to what is read.** The dead fields above are gone from the
requested schema. Answer grades now carry only the question key and the UI joins
the answer text back from `applications.answers`, tolerating case, whitespace and
punctuation drift in the key and falling back to the stored echo for rows written
before the change. The per-answer provenance fields that actually drive decisions
are untouched.

**Unbounded inputs capped.** `interviewEvidence` and `recruiterComments` were
spliced into the evaluator prompt with no limit. Both grow without bound in
Supabase, so one candidate with a long Fireflies history could quietly become a
very large request. Both are now capped, generously enough that a normal file is
unaffected.

**Two call paths deleted.** `board/summary.ts` ran one Claude call per published
job every time the ten-minute reconcile cron scored anything, and its only reader
was in `archive/legacy-ui` — excluded from `tsconfig` and not routed by Next, so
the paragraph was never displayed. `scoring/engine.ts` held a second Claude call
from the retired feature-extraction path with no importer anywhere in the repo.

**One canonical candidate analysis.** The evaluator now also returns the
founder-facing decision prose, assessment and rubric read. The old
`triage/recalc.ts` second full-candidate call is gone. A normalized result is
written once to `candidate_analyses`, then projected into the compatibility tables
(`scores`, `evaluations`, `ro_assessments`, `candidate_overlay`) and
`candidate_working_files`. Every surface therefore derives from one response.

**Supabase fingerprint deduplication.** The canonical row is unique on candidate
plus a SHA-256 fingerprint of the model, source materials, evidence, human
corrections, active methodology, rubric and calibration. Duplicate Workable
events, repeated cron passes and repeated buttons reuse a completed or in-flight
row. New interview evidence legitimately creates one new analysis version.

**Message Batches for automated work.** Initial analysis, scoring-epoch refreshes,
bulk rubric recomputes, résumé-answer backfills and evidence webhooks enqueue
durable rows and submit them through Anthropic Message Batches at 50% pricing.
`claude_batches` holds the provider lifecycle so the ten-minute cron can submit,
return, then poll and stream results in a later invocation. A result is durable
before projections run; if a projection fails, the next cron replays it without
another Claude call.

## Estimated effect

Per-call estimates for a typical candidate (résumé ~12k characters, six answers, a
populated rubric and calibration, no interview transcript):

| Path | Before | After | Change |
| --- | --- | --- | --- |
| Canonical candidate analysis (interactive) | ~$0.21 across two calls | ~$0.055 in one call | −74% |
| Canonical candidate analysis (batch) | ~$0.21 across two calls | ~$0.028 in one batch request | −87% |
| Résumé parse | ~$0.038 | $0 | −100% |
| Board summary (per job, per batch) | ~$0.005 | $0 | −100% |

End to end, a new applicant arriving from Workable cost about $0.16 before anyone
opened the deep read, and roughly $0.25 after the second read. It now costs roughly
$0.03 in the automated batch path. A bulk reanalyze of a 200-candidate pool drops
from roughly $18 to roughly $5.50.

The caching gain scales with batch size and is close to zero for a single isolated
call — the first candidate in a pass pays a 1.25x write premium and every candidate
after it reads at 0.1x. The output trim and the model change apply to every call
regardless.

## What is still on the table

**One-hour cache TTL on large batches.** The five-minute cache is refreshed on
every read, but Anthropic does not guarantee batch request execution order or
spacing. A one-hour TTL costs 2x on the first write and the same 0.1x on reads.
Usage logs now show `cacheRead`, so this should be enabled only if production data
shows batch requests missing the five-minute cache.

**Confirm `score_inputs` is still wanted.** The `claims` array is still generated
with verbatim supporting quotes, and it is read only by a legacy candidate-detail
API and the score-input capture route. If that capture flow is not live, this is
another few hundred output tokens per evaluation.
