# RDIRecruit — start here (for Cursor)

We are building **our review/intelligence UI on top of Workable**. Workable stays the
system of record; our DB caches everything so Claude is called **once per piece of
evidence, never per page view**; and anywhere a feature is painful to build natively we
**open Workable in a new tab** instead.

**Read in this order:**
1. `RDIRecruit_Build_Spec.md` — this delta spec: the caching contract, the
   Workable-first / link-out rule, the screens as built, the data model additions.
2. `RDIRecruit.dc.html` — the **working mock** (in this folder). It is the pixel +
   interaction contract: copy its inline styles, layout, copy, and behaviour. Open it in a
   browser. (`Fillmore-Resume.docx` and `logo-mark.svg` are its assets.)
3. `../uploads/RDI_Hiring_Layer_Build_Spec (1).md` — the full Workable sync layer,
   base data model, §9a source-capture, comms loop. Don't re-derive it; extend it.
4. `../uploads/RDI_How_We_Evaluate.md` — the evaluation philosophy the reads encode
   (gap-not-person, salary-as-vector, technician vs owner complement, gates vs scores).

**The two rules that shape every decision** (full detail in §0 of the spec):
- **Cache-first:** Claude only at evidence ingest → persist features + scores + reads →
  every render/re-rank/rubric-tweak reads from Postgres. Pool/investment math is plain
  app code, never a model call.
- **Workable-first:** prefer Workable's native capability; deep-link out (`target="_blank"`)
  wherever building it ourselves isn't worth it.
