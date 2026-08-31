# Implementation Plan: Canonical Candidate Analysis

## Overview
Each material version of a candidate gets one canonical Claude analysis. Supabase
stores the input fingerprint, lifecycle, raw normalized result, usage, and provider
batch identity. Every live projection—scores, evaluation rows, RO assessment, and
the candidate working-file read—is derived from that stored result. Automated
work uses Anthropic Message Batches; explicit recruiter actions use the same
canonical contract synchronously so the UI can return a result immediately.

“Once per candidate” means once per unique decision-relevant input fingerprint.
New interview evidence or a human correction creates a new fingerprint and
therefore legitimately creates one new analysis. Duplicate webhooks and repeated
button presses reuse the completed or in-flight row.

## Architecture decisions
- Supabase is the durable source of truth for analysis lifecycle and result.
- One evaluator contract produces both internal score projections and the
  words-only `DecisionRead` shown by triage.
- Résumé ingest remains deterministic; it does not make a separate Claude call.
- Automated initial/stale analysis is queued and submitted with Message Batches.
- User-triggered analysis is synchronous but deduplicated by the same fingerprint.
- Existing projection tables stay in place for compatibility; persistence is
  centralized and idempotent.

## Tasks

### 1. Durable analysis lifecycle
- Add `candidate_analyses` and `claude_batches` tables with service-role-only RLS.
- Add uniqueness on `(candidate_id, input_hash)` and indexes for pending batches.
- Add an atomic claim RPC for synchronous work.
- Verify migration syntax and generated access patterns.

### 2. Canonical contract
- Split evaluator request construction, response parsing, and API transport.
- Add `DecisionRead` fields to the one evaluator response.
- Hash all decision-relevant candidate, job, method, rubric, evidence, and human
  workspace inputs.
- Unit test stable hashes and hash changes.

### 3. One persistence path
- Extract projection writes from `scoreCandidate`.
- Persist canonical result first, then project it to scores, evaluations,
  RO assessments, overlay, narratives, and candidate working file.
- Make repeat persistence idempotent.
- Unit test decision projection and working-file preservation.

### 4. Message Batch lifecycle
- Enqueue eligible candidates by input hash.
- Submit pending rows through `messages.batches.create`.
- Poll active batches and stream results through `messages.batches.results`.
- Persist successes and mark retryable/permanent failures without losing prior
  candidate reads.
- Unit test lifecycle transitions and custom-id parsing.

### 5. Trigger consolidation
- Make automated sync/webhooks enqueue instead of calling Claude inline.
- Make human correction/transcript/deep-analysis use canonical synchronous
  analysis and reuse in-flight/completed identical work.
- Remove the separate triage Claude recalculation path.
- Remove the Claude résumé parse call.

### 6. Verification
- Typecheck, lint, full tests, and production build.
- Review the branch for any remaining candidate-analysis Claude call path.
- Update cost documentation and PR.

## Risks and mitigations
| Risk | Mitigation |
| --- | --- |
| Batch completion can take up to 24 hours | Existing candidate read remains visible; lifecycle row exposes pending state; cron resumes processing. |
| One larger response may truncate | Keep the schema compact, validate required score/read sections, and retry only failed rows. |
| Projection write partly fails | Canonical result remains durable and can be replayed; projections use replace-after-success semantics. |
| Human actions race a batch | Unique fingerprint plus atomic claim; first completed result wins and duplicate response becomes a no-op. |
| Old databases lack the migration | Fail closed with a clear queue error; current migration mechanism applies additive schema. |

## Not doing
- Moving candidate PII to Anthropic Files API: Supabase already stores it and
  files would add a second retention surface without lowering token charges.
- Replacing existing projection tables in this change: too invasive; canonical
  storage plus deterministic projections gets the cost and consistency benefit.
- Long-lived summaries of candidate source text: summaries can discard hiring
  evidence and would themselves require another model call.
