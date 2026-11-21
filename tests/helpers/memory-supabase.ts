/**
 * In-memory stand-in for the Supabase query builder used by ingest and pool load.
 *
 * Rules copied from this repo's schema and from @supabase/postgrest-js@2.108.1:
 * - evidence.transcript is `text` with no length CHECK (supabase/migrations/001_initial_schema.sql)
 * - evidence.candidate_id references candidates(workable_id)
 * - candidates.job_shortcode references jobs(shortcode)
 * - unique (candidate_id, raw_ref) where raw_ref is not null
 *   (supabase/migrations/005_evidence_rescore.sql)
 * - insert() sends the row object through JSON.stringify with no truncation
 *   (node_modules/@supabase/postgrest-js/dist/index.mjs insert + then)
 * - maybeSingle: 0 rows -> data null, 1 row -> the object, >1 rows -> PGRST116
 */

export type Row = Record<string, unknown>;

export interface DbError {
  code: string;
  message: string;
  details?: string | null;
  hint?: string | null;
}

export interface QueryResult {
  data: Row | Row[] | null;
  error: DbError | null;
}

const CANDIDATE_FK = new Set([
  "evidence",
  "applications",
  "scores",
  "ro_assessments",
  "narratives",
  "activity",
  "candidate_overlay",
  "candidate_working_files",
]);

export class MemorySupabase {
  private tables = new Map<string, Row[]>();

  from(table: string): MemoryQuery {
    return new MemoryQuery(this, table);
  }

  rows(table: string): Row[] {
    return this.tables.get(table) ?? [];
  }

  reset(seed?: Record<string, Row[]>): void {
    this.tables.clear();
    if (!seed) return;
    for (const [table, rows] of Object.entries(seed)) {
      this.tables.set(
        table,
        rows.map((row) => structuredClone(row)),
      );
    }
  }

  ensure(name: string): Row[] {
    let rows = this.tables.get(name);
    if (!rows) {
      rows = [];
      this.tables.set(name, rows);
    }
    return rows;
  }
}

class MemoryQuery implements PromiseLike<QueryResult> {
  private operation: "select" | "insert" = "select";
  private columns = "*";
  private returning = false;
  private filters: Array<(row: Row) => boolean> = [];
  private orders: Array<{ column: string; ascending: boolean }> = [];
  private rangeStart = 0;
  private rangeEnd: number | null = null;
  private rowLimit: number | null = null;
  private asMaybeSingle = false;
  private insertRows: Row[] | null = null;

  constructor(
    private readonly db: MemorySupabase,
    private readonly table: string,
  ) {}

  select(columns = "*"): this {
    this.columns = columns;
    this.returning = true;
    return this;
  }

  insert(values: Row | Row[]): this {
    this.operation = "insert";
    this.insertRows = Array.isArray(values) ? values : [values];
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  neq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] !== value);
    return this;
  }

  in(column: string, values: readonly unknown[]): this {
    const allowed = new Set(values);
    this.filters.push((row) => allowed.has(row[column]));
    return this;
  }

  gte(column: string, value: unknown): this {
    this.filters.push((row) => String(row[column] ?? "") >= String(value ?? ""));
    return this;
  }

  /**
   * PostgREST `ilike` (postgrest-js ilike() appends `ilike.${pattern}`).
   * The ingest route passes an email with no % or _ wildcards, which is
   * case-insensitive equality.
   */
  ilike(column: string, pattern: string): this {
    const needle = pattern.toLowerCase();
    this.filters.push((row) => String(row[column] ?? "").toLowerCase() === needle);
    return this;
  }

  order(column: string, options?: { ascending?: boolean }): this {
    this.orders.push({ column, ascending: options?.ascending !== false });
    return this;
  }

  range(from: number, to: number): this {
    this.rangeStart = from;
    this.rangeEnd = to;
    return this;
  }

  limit(count: number): this {
    this.rowLimit = count;
    return this;
  }

  maybeSingle(): this {
    this.asMaybeSingle = true;
    return this;
  }

  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }

  private execute(): QueryResult {
    if (this.operation === "insert") return this.executeInsert();
    return this.finishSelect(this.project(this.slice(this.sort(this.matched()))));
  }

  private executeInsert(): QueryResult {
    const stored: Row[] = [];
    for (const input of this.insertRows ?? []) {
      const row = structuredClone(input);
      const fkError = this.foreignKeyError(row);
      if (fkError) return { data: null, error: fkError };
      const uniqueError = this.uniqueError(row);
      if (uniqueError) return { data: null, error: uniqueError };
      if (row.id == null) row.id = crypto.randomUUID();
      if (row.created_at == null && this.table !== "jobs") row.created_at = new Date().toISOString();
      this.db.ensure(this.table).push(row);
      stored.push(row);
    }
    if (!this.returning) return { data: null, error: null };
    return this.finishSelect(this.project(stored));
  }

  private finishSelect(rows: Row[]): QueryResult {
    if (!this.asMaybeSingle) return { data: rows, error: null };
    if (rows.length > 1) {
      return {
        data: null,
        error: {
          code: "PGRST116",
          message: "JSON object requested, multiple (or no) rows returned",
          details: `Results contain ${rows.length} rows`,
          hint: null,
        },
      };
    }
    return { data: rows[0] ?? null, error: null };
  }

  private foreignKeyError(row: Row): DbError | null {
    if (this.table === "candidates" && row.job_shortcode != null) {
      const jobs = this.db.rows("jobs");
      if (!jobs.some((job) => job.shortcode === row.job_shortcode)) {
        return { code: "23503", message: "insert or update on table candidates violates foreign key constraint" };
      }
    }
    if (CANDIDATE_FK.has(this.table) && row.candidate_id != null) {
      const candidates = this.db.rows("candidates");
      if (!candidates.some((candidate) => candidate.workable_id === row.candidate_id)) {
        return {
          code: "23503",
          message: `insert or update on table ${this.table} violates foreign key constraint`,
        };
      }
    }
    return null;
  }

  private uniqueError(row: Row): DbError | null {
    if (this.table !== "evidence" || row.raw_ref == null) return null;
    const clash = this.db.rows("evidence").some(
      (existing) => existing.candidate_id === row.candidate_id && existing.raw_ref === row.raw_ref,
    );
    if (!clash) return null;
    return {
      code: "23505",
      message: "duplicate key value violates unique constraint idx_evidence_candidate_raw_ref",
    };
  }

  private matched(): Row[] {
    return this.db.rows(this.table).filter((row) => this.filters.every((filter) => filter(row)));
  }

  private sort(rows: Row[]): Row[] {
    if (!this.orders.length) return rows;
    return [...rows].sort((a, b) => {
      for (const order of this.orders) {
        const left = String(a[order.column] ?? "");
        const right = String(b[order.column] ?? "");
        if (left < right) return order.ascending ? -1 : 1;
        if (left > right) return order.ascending ? 1 : -1;
      }
      return 0;
    });
  }

  private slice(rows: Row[]): Row[] {
    let out = rows;
    if (this.rowLimit != null) out = out.slice(0, this.rowLimit);
    if (this.rangeEnd != null) out = out.slice(this.rangeStart, this.rangeEnd + 1);
    return out;
  }

  private project(rows: Row[]): Row[] {
    if (!this.columns || this.columns.trim() === "*") {
      return rows.map((row) => structuredClone(row));
    }
    const columns = this.columns.split(",").map((column) => column.trim()).filter(Boolean);
    return rows.map((row) => {
      const projected: Row = {};
      for (const column of columns) projected[column] = row[column];
      return projected;
    });
  }
}
