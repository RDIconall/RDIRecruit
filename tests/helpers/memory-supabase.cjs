"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var memory_supabase_exports = {};
__export(memory_supabase_exports, {
  MemorySupabase: () => MemorySupabase,
  memorySupabase: () => memorySupabase
});
module.exports = __toCommonJS(memory_supabase_exports);
let rowSeq = 0;
function likeToRegExp(pattern) {
  const body = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".");
  return new RegExp(`^${body}$`);
}
function project(row, columns) {
  if (!columns || columns.trim() === "*") return { ...row };
  const out = {};
  for (const column of columns.split(",").map((part) => part.trim()).filter(Boolean)) {
    out[column] = row[column];
  }
  return out;
}
class MemorySupabase {
  constructor() {
    this.tables = /* @__PURE__ */ new Map();
    this.upserts = [];
  }
  reset() {
    this.tables.clear();
    this.upserts.length = 0;
  }
  rows(table) {
    let rows = this.tables.get(table);
    if (!rows) {
      rows = [];
      this.tables.set(table, rows);
    }
    return rows;
  }
  from(table) {
    if (!this.tables.has(table)) this.tables.set(table, []);
    return new MemoryQuery(this, table);
  }
  rpc(name, _args) {
    if (name === "try_acquire_scoring_lock" || name === "release_scoring_lock" || name === "claim_candidate_analysis" || name === "claim_candidate_analysis_projection") {
      return Promise.resolve({ data: true, error: null, count: null });
    }
    return Promise.resolve({
      data: null,
      error: { message: `memory supabase has no rpc ${name}` },
      count: null
    });
  }
}
class MemoryQuery {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.op = "select";
    this.predicates = [];
    this.columns = "*";
    this.head = false;
    this.countExact = false;
    this.limitN = null;
    this.rangeFrom = null;
    this.rangeTo = null;
    this.orders = [];
    this.payload = null;
    this.onConflict = "id";
    this.ignoreDuplicates = false;
    this.mode = "many";
    this.executed = null;
  }
  select(columns = "*", options) {
    this.columns = columns;
    if (options?.head) this.head = true;
    if (options?.count === "exact") this.countExact = true;
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
    this.onConflict = options?.onConflict ?? "id";
    this.ignoreDuplicates = Boolean(options?.ignoreDuplicates);
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
  eq(column, value) {
    this.predicates.push((row) => row[column] === value);
    return this;
  }
  in(column, values) {
    const allowed = new Set(values);
    this.predicates.push((row) => allowed.has(row[column]));
    return this;
  }
  is(column, value) {
    this.predicates.push((row) => value === null ? row[column] == null : row[column] === value);
    return this;
  }
  like(column, pattern) {
    const expression = likeToRegExp(pattern);
    this.predicates.push((row) => expression.test(String(row[column] ?? "")));
    return this;
  }
  lt(column, value) {
    this.predicates.push((row) => row[column] < value);
    return this;
  }
  gte(column, value) {
    this.predicates.push((row) => row[column] >= value);
    return this;
  }
  order(column, options) {
    this.orders.push({ column, ascending: options?.ascending !== false });
    return this;
  }
  limit(count) {
    this.limitN = count;
    return this;
  }
  range(from, to) {
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }
  maybeSingle() {
    this.mode = "maybe";
    return this;
  }
  single() {
    this.mode = "single";
    return this;
  }
  then(onfulfilled, onrejected) {
    this.executed ??= this.execute();
    return this.executed.then(onfulfilled, onrejected);
  }
  tableRows() {
    return this.db.tables.get(this.table);
  }
  matching() {
    return this.tableRows().filter((row) => this.predicates.every((predicate) => predicate(row)));
  }
  async execute() {
    if (this.op === "insert") return this.executeInsert();
    if (this.op === "upsert") return this.executeUpsert();
    if (this.op === "update") return this.executeUpdate();
    if (this.op === "delete") return this.executeDelete();
    return this.executeSelect();
  }
  executeInsert() {
    const incoming = Array.isArray(this.payload) ? this.payload : [this.payload ?? {}];
    const stored = incoming.map((row) => {
      const next = { ...row };
      if (next.id == null) next.id = `row_${++rowSeq}`;
      if (next.created_at == null) next.created_at = (/* @__PURE__ */ new Date()).toISOString();
      this.tableRows().push(next);
      return next;
    });
    return this.finish(stored);
  }
  executeUpsert() {
    const incoming = { ...Array.isArray(this.payload) ? this.payload[0] : this.payload ?? {} };
    const keys = this.onConflict.split(",").map((key) => key.trim());
    const rows = this.tableRows();
    const index = rows.findIndex((row) => keys.every((key) => row[key] === incoming[key]));
    if (index >= 0 && this.ignoreDuplicates) {
      return { data: null, error: null, count: null };
    }
    let stored;
    if (index >= 0) {
      stored = { ...rows[index], ...incoming };
      rows[index] = stored;
    } else {
      if (incoming.id == null) incoming.id = `row_${++rowSeq}`;
      if (incoming.created_at == null) incoming.created_at = (/* @__PURE__ */ new Date()).toISOString();
      rows.push(incoming);
      stored = incoming;
    }
    this.db.upserts.push({ table: this.table, row: { ...stored } });
    return this.finish([stored]);
  }
  executeUpdate() {
    const patch = this.payload ?? {};
    const matched = this.matching();
    for (const row of matched) Object.assign(row, patch);
    return this.finish(matched);
  }
  executeDelete() {
    const rows = this.tableRows();
    const kept = [];
    const removed = [];
    for (const row of rows) {
      if (this.predicates.every((predicate) => predicate(row))) removed.push(row);
      else kept.push(row);
    }
    rows.splice(0, rows.length, ...kept);
    return this.finish(removed);
  }
  executeSelect() {
    let rows = this.matching();
    if (this.orders.length) {
      rows = [...rows].sort((left, right) => {
        for (const order of this.orders) {
          const a = left[order.column];
          const b = right[order.column];
          if (a === b) continue;
          const comparison = String(a ?? "") < String(b ?? "") ? -1 : 1;
          return order.ascending ? comparison : -comparison;
        }
        return 0;
      });
    }
    const count = rows.length;
    if (this.rangeFrom != null && this.rangeTo != null) {
      rows = rows.slice(this.rangeFrom, this.rangeTo + 1);
    } else if (this.limitN != null) {
      rows = rows.slice(0, this.limitN);
    }
    if (this.head) return { data: null, error: null, count };
    const result = this.finish(rows);
    if (this.countExact) result.count = count;
    return result;
  }
  finish(rows) {
    const projected = rows.map((row) => project(row, this.columns));
    if (this.mode === "many") {
      return { data: this.op === "update" || this.op === "delete" ? projected : projected, error: null, count: projected.length };
    }
    if (projected.length > 1) {
      return { data: null, error: { message: "multiple rows" }, count: projected.length };
    }
    if (projected.length === 0) {
      if (this.mode === "maybe") return { data: null, error: null, count: 0 };
      return { data: null, error: { message: "no rows" }, count: 0 };
    }
    return { data: projected[0] ?? null, error: null, count: 1 };
  }
}
const memorySupabase = new MemorySupabase();
