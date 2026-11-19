// In-memory stand-in for getServiceSupabase(). Query shape follows the
// @supabase/supabase-js builder the webhook, rescore, and batch projection
// actually await: insert/upsert/update/delete/select plus eq, in, is, gte, lt,
// order, limit, range, maybeSingle, single, and the three RPCs in
// supabase/migrations/20260831002527_canonical_candidate_analyses.sql and
// 20260831005051_harden_canonical_analysis_lifecycle.sql.
// Evidence dedupe matches the partial unique index in
// supabase/migrations/005_evidence_rescore.sql.

const { randomUUID } = require("node:crypto");

const tables = new Map();

function rowsOf(table) {
  if (!tables.has(table)) tables.set(table, []);
  return tables.get(table);
}

function resetDb() {
  tables.clear();
}

function tableRows(table) {
  return rowsOf(table).map((row) => structuredClone(row));
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function matches(row, filter) {
  const current = row[filter.column];
  switch (filter.op) {
    case "eq":
      return current === filter.value;
    case "in":
      return filter.value.includes(current);
    case "is":
      return filter.value == null ? current == null : current === filter.value;
    case "gte":
      return current != null && String(current) >= String(filter.value);
    case "lt":
      return current != null && String(current) < String(filter.value);
    default:
      return false;
  }
}

class Query {
  constructor(table) {
    this.table = table;
    this.filters = [];
    this.operation = "select";
    this.payload = null;
    this.onConflict = null;
    this.ignoreDuplicates = false;
    this.orders = [];
    this.limitN = null;
    this.rangeBounds = null;
    this.singleMode = null;
    this.head = false;
    this.returning = false;
  }

  select(_columns, options) {
    this.returning = true;
    if (options?.head) this.head = true;
    return this;
  }

  insert(payload) {
    this.operation = "insert";
    this.payload = payload;
    return this;
  }

  upsert(payload, options = {}) {
    this.operation = "upsert";
    this.payload = payload;
    this.onConflict = options.onConflict ?? null;
    this.ignoreDuplicates = Boolean(options.ignoreDuplicates);
    return this;
  }

  update(payload) {
    this.operation = "update";
    this.payload = payload;
    return this;
  }

  delete() {
    this.operation = "delete";
    return this;
  }

  eq(column, value) {
    this.filters.push({ op: "eq", column, value });
    return this;
  }

  in(column, value) {
    this.filters.push({ op: "in", column, value });
    return this;
  }

  is(column, value) {
    this.filters.push({ op: "is", column, value });
    return this;
  }

  gte(column, value) {
    this.filters.push({ op: "gte", column, value });
    return this;
  }

  lt(column, value) {
    this.filters.push({ op: "lt", column, value });
    return this;
  }

  order(column, options = {}) {
    this.orders.push({ column, ascending: options.ascending !== false });
    return this;
  }

  limit(count) {
    this.limitN = count;
    return this;
  }

  range(from, to) {
    this.rangeBounds = [from, to];
    return this;
  }

  maybeSingle() {
    this.singleMode = "maybe";
    this.returning = true;
    return this;
  }

  single() {
    this.singleMode = "single";
    this.returning = true;
    return this;
  }

  storedMatches() {
    return rowsOf(this.table).filter((row) => this.filters.every((filter) => matches(row, filter)));
  }

  ordered(list) {
    const copy = [...list];
    for (let index = this.orders.length - 1; index >= 0; index -= 1) {
      const { column, ascending } = this.orders[index];
      copy.sort((left, right) => {
        const a = left[column];
        const b = right[column];
        if (a == null && b == null) return 0;
        if (a == null) return ascending ? -1 : 1;
        if (b == null) return ascending ? 1 : -1;
        if (a < b) return ascending ? -1 : 1;
        if (a > b) return ascending ? 1 : -1;
        return 0;
      });
    }
    return copy;
  }

  window(list) {
    let start = 0;
    let end = list.length;
    if (this.rangeBounds) {
      start = this.rangeBounds[0];
      end = Math.min(list.length, this.rangeBounds[1] + 1);
    }
    const sliced = list.slice(start, end);
    if (this.limitN != null) return sliced.slice(0, this.limitN);
    return sliced;
  }

  evidenceConflict(row) {
    if (this.table !== "evidence" || row.raw_ref == null) return false;
    return rowsOf("evidence").some(
      (existing) =>
        existing !== row &&
        existing.candidate_id === row.candidate_id &&
        existing.raw_ref != null &&
        existing.raw_ref === row.raw_ref,
    );
  }

  materialize(payload) {
    const now = new Date().toISOString();
    const row = { ...clone(payload) };
    if (row.id == null) row.id = randomUUID();
    if (row.created_at == null && this.table !== "candidate_analyses") row.created_at = now;
    if (this.table === "candidate_analyses") {
      if (row.requested_at == null) row.requested_at = now;
      if (row.updated_at == null) row.updated_at = now;
      if (row.attempt_count == null) row.attempt_count = 0;
      if (row.status == null) row.status = "pending";
    }
    return row;
  }

  finish(list, error = null) {
    if (error) return { data: null, error, count: null };
    const count = list.length;
    if (this.head) return { data: null, error: null, count };
    if (this.singleMode === "maybe") {
      if (list.length > 1) {
        return { data: null, error: { code: "PGRST116", message: "multiple rows" }, count };
      }
      return { data: list[0] ? clone(list[0]) : null, error: null, count };
    }
    if (this.singleMode === "single") {
      if (list.length !== 1) {
        return {
          data: null,
          error: { code: "PGRST116", message: `expected 1 row, got ${list.length}` },
          count,
        };
      }
      return { data: clone(list[0]), error: null, count };
    }
    if (!this.returning && (this.operation === "insert" || this.operation === "upsert" || this.operation === "update" || this.operation === "delete")) {
      return { data: null, error: null, count };
    }
    return { data: list.map((row) => clone(row)), error: null, count };
  }

  execute() {
    if (this.operation === "select") {
      return this.finish(this.window(this.ordered(this.storedMatches())));
    }

    if (this.operation === "delete") {
      const doomed = new Set(this.storedMatches());
      const kept = rowsOf(this.table).filter((row) => !doomed.has(row));
      tables.set(this.table, kept);
      return this.finish([...doomed]);
    }

    if (this.operation === "update") {
      const matched = this.storedMatches();
      for (const row of matched) Object.assign(row, clone(this.payload));
      return this.finish(this.window(this.ordered(matched)));
    }

    const incoming = Array.isArray(this.payload) ? this.payload : [this.payload];
    if (this.operation === "insert") {
      const created = [];
      for (const payload of incoming) {
        const row = this.materialize(payload);
        if (this.evidenceConflict(row)) {
          return {
            data: null,
            error: { code: "23505", message: "duplicate key value violates unique constraint" },
            count: null,
          };
        }
        rowsOf(this.table).push(row);
        created.push(row);
      }
      return this.finish(created);
    }

    const keys = (this.onConflict ?? "").split(",").map((key) => key.trim()).filter(Boolean);
    const created = [];
    for (const payload of incoming) {
      const row = this.materialize(payload);
      const conflict =
        keys.length > 0
          ? rowsOf(this.table).find((existing) => keys.every((key) => existing[key] === row[key]))
          : null;
      if (conflict && this.ignoreDuplicates) continue;
      if (conflict) {
        const id = conflict.id;
        Object.assign(conflict, row, { id });
        created.push(conflict);
        continue;
      }
      if (this.evidenceConflict(row)) {
        return {
          data: null,
          error: { code: "23505", message: "duplicate key value violates unique constraint" },
          count: null,
        };
      }
      rowsOf(this.table).push(row);
      created.push(row);
    }
    return this.finish(created);
  }

  then(resolve, reject) {
    try {
      resolve(this.execute());
    } catch (error) {
      reject(error);
    }
  }
}

function claimCandidateAnalysis(id) {
  const row = rowsOf("candidate_analyses").find((item) => item.id === id);
  if (!row || row.batch_id != null || (row.status !== "pending" && row.status !== "failed")) {
    return { data: false, error: null };
  }
  const now = new Date().toISOString();
  row.status = "processing";
  row.started_at = now;
  row.updated_at = now;
  row.attempt_count += 1;
  row.error = null;
  return { data: true, error: null };
}

function attachCandidateAnalyses(batchId, ids) {
  const now = new Date().toISOString();
  for (const id of ids ?? []) {
    const row = rowsOf("candidate_analyses").find((item) => item.id === id);
    if (!row || row.batch_id != null || row.status !== "processing") continue;
    row.status = "submitted";
    row.batch_id = batchId;
    row.submitted_at = now;
    row.updated_at = now;
    row.error = null;
  }
  const attached = rowsOf("candidate_analyses").filter(
    (row) => (ids ?? []).includes(row.id) && row.batch_id === batchId && row.status === "submitted",
  ).length;
  return { data: attached, error: null };
}

function claimProjection(id) {
  const row = rowsOf("candidate_analyses").find((item) => item.id === id);
  if (!row || row.status !== "completed" || row.projected_at != null || row.projection_started_at != null) {
    return { data: false, error: null };
  }
  const now = new Date().toISOString();
  row.projection_started_at = now;
  row.updated_at = now;
  return { data: true, error: null };
}

const client = {
  from(table) {
    return new Query(table);
  },
  rpc(name, args = {}) {
    if (name === "claim_candidate_analysis") return Promise.resolve(claimCandidateAnalysis(args.p_analysis_id));
    if (name === "attach_candidate_analyses_to_batch") {
      return Promise.resolve(attachCandidateAnalyses(args.p_batch_id, args.p_analysis_ids));
    }
    if (name === "claim_candidate_analysis_projection") {
      return Promise.resolve(claimProjection(args.p_analysis_id));
    }
    return Promise.resolve({
      data: null,
      error: { code: "42883", message: `unknown rpc ${name}` },
    });
  },
};

function getServiceSupabase() {
  return client;
}

function getAnonSupabase() {
  return client;
}

// Assignments cjs-module-lexer can see, so a dynamic import() gets named exports.
exports.getServiceSupabase = getServiceSupabase;
exports.getAnonSupabase = getAnonSupabase;
exports.resetDb = resetDb;
exports.tableRows = tableRows;
exports.__esModule = true;
