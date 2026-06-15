# RDIRecruit — spec (canonical: candidate triage)

This folder holds the **canonical specification for the candidate-triage decision tool** —
the product RDIRecruit actually is today. RDIRecruit protects interview time: it cuts weak
candidates first, ranks who to interview, and builds a deep read only for the ones worth it.
There are **no numeric scores and no tiers** — only the decision vocabulary
_Interview first · Short screen · Verify first · Hold · Cut · Review blocked_.

**Read in this order:**

1. **`HANDOFF.md`** — the product brief: screens (Pool cut-first + Candidate page),
   decision vocabulary, what is mocked vs wired to real services, brand tokens.
2. **`RDIRecruit (standalone).html`** — open in any browser. Fully offline, no build.
   The source of truth for layout, copy, colors, and interaction behaviour.
3. **`RDIRecruit.dc.html`** — the same triage mock with inline styles + one logic class
   (`class Component`). Read it for exact pixel/copy/behaviour values; the live React
   screens (`src/components/triage/`) are ported from this file.

`logo-mark.svg` is the brand mark used by the app (`public/logo-mark.svg`).

## Canonical vs legacy

- **Canonical (this triage spec):** `HANDOFF.md`, `RDIRecruit (standalone).html`,
  `RDIRecruit.dc.html`. These describe the shipping triage product and are the layout +
  behaviour contract for the live app.
- **Legacy (superseded):** `RDIRecruit_Build_Spec.md` and `Fillmore-Resume.docx` describe
  the earlier **scoring-centric board** (fit numbers, tiers, ranked ledger). That direction
  was explicitly pivoted away from (see `AGENTS.md`): the product now speaks decision
  vocabulary only. The scoring tables are retained solely as *internal* inputs to
  `deriveDecision()` and never reach the screen. Where the two disagree, the triage spec wins.

See `docs/RDIRecruit-build-notes.md` for how the live Supabase-backed build maps to this spec.
