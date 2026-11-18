/** Shared stand-in state for the founder-identity tests. Not production code. */

function harness() {
  if (!globalThis.__founderIdentityHarness) {
    globalThis.__founderIdentityHarness = {
      user: null,
      tables: {},
      writes: [],
      grading: [],
      idSeq: 1,
    };
  }
  return globalThis.__founderIdentityHarness;
}

function resetHarness() {
  const state = harness();
  state.user = null;
  state.tables = {};
  state.writes = [];
  state.grading = [];
  state.idSeq = 1;
}

module.exports = { harness, resetHarness };
