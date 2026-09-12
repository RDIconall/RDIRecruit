import assert from "node:assert/strict";
import {
  decisionFromSentiment,
  fitReadFromCanonical,
  fitReadFromEvaluation,
  parseFitRead,
} from "./fit-read";

assert.equal(parseFitRead(null), null);
assert.equal(parseFitRead({ sentiment: "good" }), null);
assert.equal(parseFitRead({ reply: "They've run studies.", sentiment: "ok" }), null);

const ok = parseFitRead({
  reply: "Owned the BSL-2 stand-up at Labcorp; answers are specific.",
  sentiment: "GOOD",
  appliedFit: "Wrong for this generic posting.",
  rdiFit: "We would want them in the building.",
  suggestedSeat: "Head of Clinical Operations",
});
assert.ok(ok);
assert.equal(ok.sentiment, "good");
assert.equal(ok.suggestedSeat, "Head of Clinical Operations");
assert.equal(decisionFromSentiment("good"), "interview");
assert.equal(decisionFromSentiment("neutral"), "backup");
assert.equal(decisionFromSentiment("negative"), "reject");

assert.equal(
  fitReadFromCanonical({
    why: "Owned the BSL-2 stand-up.",
    personQuality: "high",
    seatVerdict: "routing",
    appliedFit: "Generic posting.",
    rdiFit: "Want them.",
    suggestedSeat: "Head of Clinical Operations",
  })?.sentiment,
  "good",
);

const fromEval = fitReadFromEvaluation({
  summary: "Fallback summary.",
  investHead: "Takes monitoring off the desk",
  complementRemoves: "site load",
  personQuality: "high",
  seatFit: { verdict: "routing", summary: "Wrong for this generic posting." },
  triage: { why: "Owned the BSL-2 stand-up." },
  alternateSeatSignals: [{ fit: "high_potential", seatLabel: "Head of Clinical Operations" }],
});
assert.ok(fromEval);
assert.equal(fromEval.sentiment, "good");
assert.equal(fromEval.reply, "Owned the BSL-2 stand-up.");
assert.equal(fromEval.suggestedSeat, "Head of Clinical Operations");

assert.equal(fitReadFromEvaluation({ summary: "", personQuality: "solid", seatFit: { verdict: "hold" } }), null);
assert.equal(
  fitReadFromEvaluation({
    summary: "Would be a read if this were real.",
    heuristic: true,
    personQuality: "high",
    seatFit: { verdict: "strong_seat" },
  }),
  null,
);

console.log("fit-read.test.ts: ok");
