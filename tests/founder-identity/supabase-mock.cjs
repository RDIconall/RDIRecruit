/**
 * In-memory stand-in for the Supabase query builder used by the triage actions
 * and scoreCandidate. It stores the rows those functions write and returns them
 * on the later reads those same functions make. It does not interpret identity.
 */
const { harness } = require("./state.cjs");

function clone(value) {
  return value === undefined ? value : structuredClone(value);
}

function rowsOf(table) {
  const state = harness();
  if (!state.tables[table]) state.tables[table] = [];
  return state.tables[table];
}

function match(row, filters) {
  return filters.every((filter) => {
    const value = row[filter.column];
    if (filter.op === "eq") return value === filter.value;
    if (filter.op === "neq") return value !== filter.value;
    if (filter.op === "in") return filter.value.includes(value);
    if (filter.op === "gte") return value >= filter.value;
    if (filter.op === "is") return value === filter.value;
    return false;
  });
}

function project(row, columns) {
  if (!columns || columns === "*" || columns.trim() === "*") return clone(row);
  const out = {};
  for (const column of columns.split(",").map((part) => part.trim()).filter(Boolean)) {
    out[column] = row[column];
  }
  return out;
}

class Query {
  constructor(table) {
    this.table = table;
    this.filters = [];
    this.orders = [];
    this.limitN = null;
    this.rangeBounds = null;
    this.columns = "*";
    this.op = "select";
    this.payload = null;
    this.onConflict = null;
  }

  select(columns = "*") {
    this.columns = columns;
    return this;
  }

  eq(column, value) {
    this.filters.push({ op: "eq", column, value });
    return this;
  }

  neq(column, value) {
    this.filters.push({ op: "neq", column, value });
    return this;
  }

  in(column, value) {
    this.filters.push({ op: "in", column, value: value ?? [] });
    return this;
  }

  gte(column, value) {
    this.filters.push({ op: "gte", column, value });
    return this;
  }

  is(column, value) {
    this.filters.push({ op: "is", column, value });
    return this;
  }

  order(column, options) {
    this.orders.push({ column, ascending: options?.ascending !== false });
    return this;
  }

  limit(n) {
    this.limitN = n;
    return this;
  }

  range(from, to) {
    this.rangeBounds = [from, to];
    return this;
  }

  insert(payload) {
    this.op = "insert";
    this.payload = payload;
    return this;
  }

  upsert(payload, options) {
    this.op = "upsert";
    this.payload = payload;
    this.onConflict = options?.onConflict ?? null;
    return this;
  }

  update(payload) {
    this.op = "update";
    this.payload = payload;
    return this;
  }

  delete() {
    this.op = "delete";
    return this;
  }

  maybeSingle() {
    return this.exec("maybe");
  }

  single() {
    return this.exec("one");
  }

  then(resolve, reject) {
    return this.exec("many").then(resolve, reject);
  }

  exec(mode) {
    try {
      return Promise.resolve(this.run(mode));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  run(mode) {
    const table = rowsOf(this.table);
    if (this.op === "insert") return this.writeInsert(table, mode);
    if (this.op === "upsert") return this.writeUpsert(table, mode);
    if (this.op === "update") return this.writeUpdate(table, mode);
    if (this.op === "delete") return this.writeDelete(table, mode);
    return this.read(table, mode);
  }

  selected(table, mode) {
    let rows = table.filter((row) => match(row, this.filters));
    for (const order of this.orders) {
      rows = [...rows].sort((a, b) => {
        const av = a[order.column];
        const bv = b[order.column];
        if (av === bv) return 0;
        const cmp = av > bv ? 1 : -1;
        return order.ascending ? cmp : -cmp;
      });
    }
    if (this.rangeBounds) {
      const [from, to] = this.rangeBounds;
      rows = rows.slice(from, to + 1);
    }
    if (this.limitN != null) rows = rows.slice(0, this.limitN);
    const projected = rows.map((row) => project(row, this.columns));
    if (mode === "many") return { data: projected, error: null };
    if (projected.length === 1 || (mode === "maybe" && projected.length === 0)) {
      return { data: projected[0] ?? null, error: null };
    }
    if (mode === "maybe") {
      return { data: null, error: { message: `multiple rows for ${this.table}` } };
    }
    return {
      data: null,
      error: { message: `JSON object requested for ${this.table}` },
    };
  }

  read(table, mode) {
    return this.selected(table, mode);
  }

  record(op, row) {
    harness().writes.push({ table: this.table, op, row: clone(row) });
  }

  writeInsert(table, mode) {
    const incoming = Array.isArray(this.payload) ? this.payload : [this.payload];
    const stored = incoming.map((row) => {
      const next = clone(row);
      if (!next.id) next.id = `row_${harness().idSeq++}`;
      if (!next.created_at) next.created_at = new Date().toISOString();
      table.push(next);
      this.record("insert", next);
      return next;
    });
    if (mode === "many" && this.columns === "*" && !this.payload) {
      return { data: stored.map((row) => project(row, this.columns)), error: null };
    }
    return this.selected(stored, mode === "many" && this.columns === "*" ? "many" : mode);
  }

  writeUpsert(table, mode) {
    const incoming = Array.isArray(this.payload) ? this.payload : [this.payload];
    const key = this.onConflict || (incoming[0] && "candidate_id" in incoming[0] ? "candidate_id" : "id");
    const stored = incoming.map((row) => {
      const next = clone(row);
      const index = table.findIndex((existing) => existing[key] === next[key]);
      if (index >= 0) table[index] = { ...table[index], ...next };
      else {
        if (!next.id) next.id = `row_${harness().idSeq++}`;
        table.push(next);
      }
      const saved = index >= 0 ? table[index] : table[table.length - 1];
      this.record("upsert", saved);
      return saved;
    });
    return this.selected(stored, mode);
  }

  writeUpdate(table, mode) {
    const saved = [];
    for (const row of table) {
      if (!match(row, this.filters)) continue;
      Object.assign(row, clone(this.payload));
      saved.push(row);
      this.record("update", row);
    }
    return this.selected(saved, mode);
  }

  writeDelete(table, mode) {
    const kept = [];
    for (const row of table) {
      if (match(row, this.filters)) this.record("delete", row);
      else kept.push(row);
    }
    table.splice(0, table.length, ...kept);
    return this.selected([], mode);
  }
}

const client = {
  from(table) {
    return new Query(table);
  },
};

function getServiceSupabase() {
  return client;
}

function getAnonSupabase() {
  return client;
}

module.exports = { getServiceSupabase, getAnonSupabase };
