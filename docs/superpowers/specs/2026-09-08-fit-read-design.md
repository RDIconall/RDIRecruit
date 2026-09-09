# Fit read (no score) — 2026-09-08

## Intent

Stop ranking applicants with a hidden 0–100 score. Claude reads the job description plus what the candidate submitted, writes a free reply, and we group from that.

## Output

- `reply` — the read (prose)
- `sentiment` — good | neutral | negative
- `appliedFit` — fit to the posting they applied to
- `rdiFit` — person we’d want at RDI
- `suggestedSeat` — better real seat if this posting isn’t it (optional)

Inbox groups: Good / Neutral / Negative / Review blocked.  
Internal keys stay `interview` / `backup` / `reject` / `blocked`.  
Best new = first Good on a real (non-routing) seat.  
Human override still wins. Incomplete materials = blocked, not negative.

## Scoring

`scoreCandidate` writes a `fit_read` evaluation only. It does not insert `scores` or run the structured scorer. Existing score rows are ignored for ranking.
