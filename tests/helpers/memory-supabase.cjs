/**
 * In-memory stand-in for the Supabase client the server actions call.
 *
 * @supabase/postgrest-js 2.108.1 sends upsert/insert bodies with JSON.stringify
 * and does not trim string length (dist/index.mjs around the fetch body). This
 * client stores that same object and returns it on select. Foreign keys match
 * migrations 009 and 011: working files and activity rows require a candidate.
 */

function clone(value) {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

class MemoryQuery {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.filters = [];
    this.orders = [];
    this.rangeBounds = null;
    this.limitN = null;
    this.columns = "*";
    this.operation = "select";
    this.payload = null;
    this.onConflict = null;
    this.patch = null;
  }

  select(columns = "*") {
    this.columns = columns;
    return this;
  }

  eq(column, value) {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  neq(column, value) {
    this.filters.push((row) => row[column] !== value);
    return this;
  }

  in(column, values) {
    const allowed = new Set(values);
    this.filters.push((row) => allowed.has(row[column]));
    return this;
  }

  gte(column, value) {
    this.filters.push((row) => String(row[column] ?? "") >= String(value));
    return this;
  }

  order(column, options) {
    this.orders.push({ column, ascending: options?.ascending !== false });
    return this;
  }

  range(from, to) {
    this.rangeBounds = { from, to };
    return this;
  }

  limit(count) {
    this.limitN = count;
    return this;
  }

  insert(row) {
    this.operation = "insert";
    this.payload = row;
    return this;
  }

  upsert(row, options) {
    this.operation = "upsert";
    this.payload = row;
    this.onConflict = options?.onConflict ?? null;
    return this;
  }

  update(patch) {
    this.operation = "update";
    this.patch = patch;
    return this;
  }

  maybeSingle() {
    const result = this.execute();
    if (result.error) return Promise.resolve({ data: null, error: result.error });
    const rows = Array.isArray(result.data) ? result.data : result.data ? [result.data] : [];
    return Promise.resolve({ data: rows[0] ?? null, error: null });
  }

  single() {
    const result = this.execute();
    if (result.error) return Promise.resolve({ data: null, error: result.error });
    const row = Array.isArray(result.data) ? result.data[0] : result.data;
    if (!row) return Promise.resolve({ data: null, error: { message: "No rows" } });
    return Promise.resolve({ data: row, error: null });
  }

  then(onfulfilled, onrejected) {
    const result = this.execute();
    const data = Array.isArray(result.data) || result.data === null ? result.data : [result.data];
    return Promise.resolve({ data, error: result.error }).then(onfulfilled, onrejected);
  }

  project(row) {
    if (!this.columns || this.columns.trim() === "*") return clone(row);
    const out = {};
    for (const column of this.columns.split(",").map((part) => part.trim()).filter(Boolean)) {
      out[column] = clone(row[column]);
    }
    return out;
  }

  matching() {
    let rows = (this.db.tables[this.table] ?? []).filter((row) => this.filters.every((filter) => filter(row)));
    if (this.orders.length) {
      rows = [...rows].sort((left, right) => {
        for (const order of this.orders) {
          const a = left[order.column];
          const b = right[order.column];
          if (a === b) continue;
          if (a == null) return order.ascending ? -1 : 1;
          if (b == null) return order.ascending ? 1 : -1;
          if (a > b) return order.ascending ? 1 : -1;
          if (a < b) return order.ascending ? -1 : 1;
        }
        return 0;
      });
    }
    if (this.rangeBounds) rows = rows.slice(this.rangeBounds.from, this.rangeBounds.to + 1);
    if (this.limitN != null) rows = rows.slice(0, this.limitN);
    return rows;
  }

  candidateExists(candidateId) {
    return (this.db.tables.candidates ?? []).some((row) => row.workable_id === candidateId);
  }

  account(rows) {
    for (const row of rows) {
      if (this.table === "candidate_working_files") {
        const workspace = row.workspace ?? {};
        for (const message of workspace.chat ?? []) this.db.delivered.chatChars += String(message?.content ?? "").length;
        for (const correction of workspace.corrections ?? []) {
          this.db.delivered.correctionChars += String(correction?.text ?? "").length;
        }
        if (typeof workspace.transcript === "string") this.db.delivered.transcriptChars += workspace.transcript.length;
        for (const value of Object.values(workspace.replies ?? {})) {
          this.db.delivered.replyChars += String(value ?? "").length;
        }
        for (const item of workspace.ovr ?? []) {
          for (const value of Object.values(item ?? {})) {
            if (typeof value === "string") this.db.delivered.timelineChars += value.length;
          }
        }
      }
      if (this.table === "activity") this.db.delivered.activityChars += String(row.body ?? "").length;
    }
  }

  execute() {
    const table = (this.db.tables[this.table] ??= []);
    if (this.operation === "insert" || this.operation === "upsert") {
      const row = clone(this.payload ?? {});
      if (
        (this.table === "candidate_working_files" || this.table === "activity") &&
        !this.candidateExists(row.candidate_id)
      ) {
        return {
          data: null,
          error: { code: "23503", message: "insert or update violates foreign key constraint" },
        };
      }
      if (this.table === "activity") {
        if (!row.id) row.id = `act_${table.length + 1}`;
        if (!row.created_at) row.created_at = new Date().toISOString();
      }
      if (this.operation === "upsert") {
        const key = this.onConflict ?? "candidate_id";
        const index = table.findIndex((existing) => existing[key] === row[key]);
        if (index >= 0) table[index] = row;
        else table.push(row);
      } else {
        table.push(row);
      }
      const projected = this.project(row);
      this.account([projected]);
      return { data: projected, error: null };
    }
    if (this.operation === "update") {
      const rows = this.matching();
      for (const row of rows) Object.assign(row, clone(this.patch ?? {}));
      const projected = rows.map((row) => this.project(row));
      this.account(projected);
      return { data: projected, error: null };
    }
    const projected = this.matching().map((row) => this.project(row));
    this.account(projected);
    return { data: projected, error: null };
  }
}

class MemoryDb {
  constructor() {
    this.tables = {};
    this.resetDelivered();
  }

  from(table) {
    this.tables[table] ??= [];
    return new MemoryQuery(this, table);
  }

  resetDelivered() {
    this.delivered = {
      chatChars: 0,
      correctionChars: 0,
      transcriptChars: 0,
      replyChars: 0,
      timelineChars: 0,
      activityChars: 0,
    };
  }
}

const db = new MemoryDb();

module.exports = {
  db,
  createClient() {
    return db;
  },
};
