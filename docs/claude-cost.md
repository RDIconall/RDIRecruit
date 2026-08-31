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
cheaper for the same work. Résumé chronology parsing and calibration-note
distilling carry no hiring judgment, so they move to `claude-haiku-4-5` at $1/$5.
All model IDs now resolve through `src/lib/ai/models.ts` and can be pinned per
deploy with `CLAUDE_MODEL_JUDGMENT` / `CLAUDE_MODEL_EXTRACTION`.

**Prompt caching of everything job-level.** The evaluator now sends two cached
prefix blocks — the global method doc (identical across every job, so it stays warm
for a whole run) then the seat brief (identical across every candidate on a seat).
The triage recalc does the same with methodology + spec + rubric + roster, about
7,000 tokens that were previously fresh on every single re-analysis. Only the
candidate's own file is billed at full input price. The chat marks its final turn
so a long conversation reads its own history back at a tenth of the price instead
of re-paying for it each turn.

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

## Estimated effect

Per-call estimates for a typical candidate (résumé ~12k characters, six answers, a
populated rubric and calibration, no interview transcript):

| Path | Before | After | Change |
| --- | --- | --- | --- |
| Candidate evaluation | ~$0.12 | ~$0.046 | −60% |
| Triage decision read | ~$0.088 | ~$0.046 | −48% |
| Résumé parse | ~$0.038 | ~$0.013 | −67% |
| Board summary (per job, per batch) | ~$0.005 | $0 | −100% |

End to end, a new applicant arriving from Workable cost about $0.16 in parse plus
evaluation and now costs about $0.06. A bulk reanalyze of a 200-candidate pool
drops from roughly $18 to roughly $9.

The caching gain scales with batch size and is close to zero for a single isolated
call — the first candidate in a pass pays a 1.25x write premium and every candidate
after it reads at 0.1x. The output trim and the model change apply to every call
regardless.

## What is still on the table

Ordered by size of the remaining prize.

**Batch API, for another 50%.** The two bulk paths — `scoreUnscoredAcrossJobs` and
`/api/cron/reanalyze` — are already asynchronous, time-budgeted and resumable,
which is exactly the shape the Message Batches API wants. Batch requests are half
price and stack with caching. This is the largest remaining lever and the reason it
was not done here: it needs a submit/poll/persist loop rather than a synchronous
call, so it is a real change to `workable-sync.ts` and the reanalyze route.

**Consolidate the two full candidate reads.** `scoring/evaluator.ts` and
`triage/recalc.ts` are both complete reads of the same candidate against the same
rubric, producing overlapping narratives. Today they fire from different triggers
so nothing pays for both automatically, but running deep analysis on a
freshly-synced candidate does pay both. Merging them would remove the larger of the
two calls outright, and would also remove a real source of disagreement between the
score-derived decision and the working-file read.

**Coalesce evidence-triggered re-scores.** `rescoreCandidateOnNewEvidence` runs a
full re-evaluation with `force: true, replace: true` from four separate triggers
(interview paste, async-video action, Fireflies webhook, VideoAsk webhook). A
VideoAsk webhook plus the Fireflies transcript for the same interview means two
full evaluations minutes apart. A short debounce keyed on candidate id, or a dirty
flag drained by the existing cron, would roughly halve this path.

**One-hour cache TTL on bulk passes.** The five-minute cache is refreshed on every
read, so a continuous batch stays warm — but a pass that stalls on rate limits
re-writes the whole prefix. A one-hour TTL costs 2x on the write and the same 0.1x
on reads, which is cheaper for any pass that runs longer than a few minutes.

**Confirm `score_inputs` is still wanted.** The `claims` array is still generated
with verbatim supporting quotes, and it is read only by a legacy candidate-detail
API and the score-input capture route. If that capture flow is not live, this is
another few hundred output tokens per evaluation.
