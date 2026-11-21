/**
 * Stand-in for the service-role Supabase client used by the hiring actions.
 *
 * The stand-in follows the schema at this commit: `activity.body` and
 * `candidate_working_files.workspace` / `content` are unbounded text/jsonb
 * (supabase/migrations/011_activity_log.sql, supabase/migrations/009_working_files.sql).
 * It applies the column list passed to `.select()`, the filters, order, and
 * range the caller asks for, and the foreign keys those migrations declare.
 * It does not add a length check the database does not have.
 *
 * Clerk's `auth` / `currentUser` are the signed-in session the actions read.
 * `next/cache` `revalidatePath` is the success path from
 * next@16.2.9 `dist/server/web/spec-extension/revalidate.js` (records a tag
 * when a request store exists). Outside a request that call throws
 * "static generation store missing", which is not how a server action runs.
 */
import Module from "node:module";

type Row = Record<string, unknown>;

export const JOB = "JOB-NOTE-1";
export const CANDIDATE_ID = "cand-note-1";

/** Signed-in account created through the public sign-up route. No staff role. */
export const session: { userId: string | null } = {
  userId: "user_public_signup",
};

export let capturedMiddleware: ((auth: { protect: () => Promise<void> }, request: { nextUrl: { pathname: string } }) => Promise<void>) | null = null;

type ReadListener = (table: string, row: Row) => void;

export const db = {
  tables: new Map<string, Row[]>(),
  onRead: null as ReadListener | null,
  /** Every row handed to insert, upsert, or update, including ones later overwritten. */
  writes: [] as string[],
  table(name: string): Row[] {
    const rows = this.tables.get(name);
    if (rows) return rows;
    const created: Row[] = [];
    this.tables.set(name, created);
    return created;
  },
  resetWrites(): void {
    this.tables.set("activity", []);
    this.tables.set("candidate_working_files", []);
    this.tables.set("job_rubrics", []);
    this.writes = [];
  },
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function project(row: Row, columns: string): Row {
  if (!columns || columns.trim() === "*") return clone(row);
  const out: Row = {};
  for (const part of columns.split(",")) {
    const key = part.trim();
    if (!key || key === "*") return clone(row);
    out[key] = key in row ? clone(row[key]) : null;
  }
  return out;
}

class Query {
  private filters: Array<(row: Row) => boolean> = [];
  private orders: Array<{ column: string; ascending: boolean }> = [];
  private operation: "select" | "insert" | "upsert" | "update" = "select";
  private payload: Row | Row[] | null = null;
  private onConflict: string | null = null;
  private columns = "*";
  private limitN: number | null = null;
  private rangeBounds: { from: number; to: number } | null = null;
  private mode: "many" | "single" | "maybe" = "many";

  constructor(
    private readonly table: string,
  ) {}

  select(columns = "*"): this {
    this.columns = columns ?? "*";
    return this;
  }

  insert(payload: Row | Row[]): this {
    this.operation = "insert";
    this.payload = payload;
    return this;
  }

  upsert(payload: Row, options?: { onConflict?: string }): this {
    this.operation = "upsert";
    this.payload = payload;
    this.onConflict = options?.onConflict ?? null;
    return this;
  }

  update(payload: Row): this {
    this.operation = "update";
    this.payload = payload;
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
    this.filters.push((row) => String(row[column] ?? "") >= String(value));
    return this;
  }

  order(column: string, options?: { ascending?: boolean }): this {
    this.orders.push({ column, ascending: options?.ascending !== false });
    return this;
  }

  limit(count: number): this {
    this.limitN = count;
    return this;
  }

  range(from: number, to: number): this {
    this.rangeBounds = { from, to };
    return this;
  }

  maybeSingle(): Promise<{ data: Row | null; error: { message: string; code: string } | null }> {
    this.mode = "maybe";
    return this.execute() as Promise<{ data: Row | null; error: { message: string; code: string } | null }>;
  }

  single(): Promise<{ data: Row | null; error: { message: string; code: string } | null }> {
    this.mode = "single";
    return this.execute() as Promise<{ data: Row | null; error: { message: string; code: string } | null }>;
  }

  then<TResult1 = { data: Row[] | null; error: { message: string; code: string } | null }, TResult2 = never>(
    onfulfilled?: ((value: { data: Row[] | null; error: { message: string; code: string } | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private matching(live: boolean): Row[] {
    const source = db.table(this.table);
    let rows = source.filter((row) => this.filters.every((filter) => filter(row)));
    if (this.orders.length) {
      rows = [...rows].sort((a, b) => {
        for (const order of this.orders) {
          const av = String(a[order.column] ?? "");
          const bv = String(b[order.column] ?? "");
          if (av < bv) return order.ascending ? -1 : 1;
          if (av > bv) return order.ascending ? 1 : -1;
        }
        return 0;
      });
    }
    if (this.rangeBounds) {
      rows = rows.slice(this.rangeBounds.from, this.rangeBounds.to + 1);
    } else if (this.limitN != null) {
      rows = rows.slice(0, this.limitN);
    }
    return live ? rows : rows.map((row) => project(row, this.columns));
  }

  private shape(rows: Row[]): { data: Row | Row[] | null; error: { message: string; code: string } | null } {
    if (db.onRead && this.operation === "select") {
      for (const row of rows) db.onRead(this.table, row);
    }
    if (this.mode === "many") return { data: rows, error: null };
    if (rows.length === 1) return { data: rows[0] ?? null, error: null };
    if (this.mode === "maybe" && rows.length === 0) return { data: null, error: null };
    return {
      data: null,
      error: { message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116" },
    };
  }

  private foreignKeyError(candidateId: unknown): { data: null; error: { message: string; code: string } } | null {
    if (this.table !== "activity" && this.table !== "candidate_working_files") return null;
    const ids = new Set(db.table("candidates").map((row) => row.workable_id));
    if (!ids.has(candidateId)) {
      return {
        data: null,
        error: {
          message: `insert or update on table "${this.table}" violates foreign key constraint`,
          code: "23503",
        },
      };
    }
    return null;
  }

  private execute(): Promise<{ data: Row | Row[] | null; error: { message: string; code: string } | null }> {
    if (this.operation === "insert" || this.operation === "upsert") {
      const incoming = Array.isArray(this.payload) ? this.payload : [this.payload ?? {}];
      const stored: Row[] = [];
      for (const raw of incoming) {
        const row: Row = { ...raw };
        const fk = this.foreignKeyError(row.candidate_id);
        if (fk) return Promise.resolve(fk);
        if (this.table === "activity") {
          if (row.body == null) {
            return Promise.resolve({
              data: null,
              error: { message: 'null value in column "body" violates not-null constraint', code: "23502" },
            });
          }
          if (!row.id) row.id = crypto.randomUUID();
          if (!row.created_at) row.created_at = new Date().toISOString();
          if (!row.type) row.type = "note";
        }
        db.writes.push(JSON.stringify(row));
        if (this.operation === "upsert" && this.onConflict) {
          const key = this.onConflict;
          const existing = db.table(this.table).find((item) => item[key] === row[key]);
          if (existing) {
            Object.assign(existing, row);
            stored.push(existing);
            continue;
          }
        }
        db.table(this.table).push(row);
        stored.push(row);
      }
      const projected = stored.map((row) => project(row, this.columns));
      return Promise.resolve(this.shape(projected));
    }

    if (this.operation === "update") {
      const matches = this.matching(true);
      for (const row of matches) {
        Object.assign(row, this.payload ?? {});
        db.writes.push(JSON.stringify(row));
      }
      return Promise.resolve(this.shape(matches.map((row) => project(row, this.columns))));
    }

    return Promise.resolve(this.shape(this.matching(false)));
  }
}

function createClient() {
  return {
    from(table: string) {
      return new Query(table);
    },
  };
}

const client = createClient();

type ModuleLoad = (this: unknown, request: string, parent: { filename?: string } | undefined, isMain: boolean) => unknown;

const moduleWithLoad = Module as unknown as { _load: ModuleLoad };
const originalLoad = moduleWithLoad._load;

moduleWithLoad._load = function patchedLoad(request: string, parent, isMain) {
  const parentFile = parent?.filename ?? "";
  const fromApp = parentFile.includes("/src/") || parentFile.includes("/tests/") || parentFile.includes("\\src\\");
  const normalized = request.replace(/\\/g, "/");

  if (fromApp && (normalized === "server-only" || normalized.endsWith("/server-only"))) {
    return {};
  }

  if (fromApp && (normalized === "next/cache" || normalized.endsWith("/next/cache"))) {
    return {
      revalidatePath() {},
      revalidateTag() {},
      updateTag() {},
      refresh() {},
    };
  }

  if (
    fromApp &&
    (normalized.endsWith("/supabase/server") ||
      normalized.endsWith("/supabase/server.ts") ||
      normalized.includes("/lib/supabase/server"))
  ) {
    return {
      getServiceSupabase: () => client,
      getAnonSupabase: () => client,
    };
  }

  if (fromApp && (normalized === "@clerk/nextjs/server" || normalized.endsWith("/@clerk/nextjs/server"))) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "auth") {
          return async () => ({ userId: session.userId });
        }
        if (prop === "currentUser") {
          return async () =>
            session.userId
              ? {
                  id: session.userId,
                  firstName: "Pat",
                  lastName: "Public",
                  emailAddresses: [{ emailAddress: "pat.public@example.com" }],
                }
              : null;
        }
        if (prop === "clerkMiddleware") {
          return (handler: typeof capturedMiddleware) => {
            capturedMiddleware = handler;
            return () => {};
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  return originalLoad.call(this, request, parent, isMain);
};

process.env.SUPABASE_URL = "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_KEY = "test-service-key-placeholder";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.WORKABLE_TOKEN;
delete process.env.WORKABLE_API_KEY;

const appliedAt = new Date().toISOString();

db.table("jobs").push({
  shortcode: JOB,
  title: "Clinical Data Manager",
  status: "published",
  department: "Operations",
  location: "Van Nuys, CA",
  raw: null,
});

db.table("candidates").push({
  workable_id: CANDIDATE_ID,
  job_shortcode: JOB,
  name: "Alex Applicant",
  email: null,
  phone: null,
  location: "Los Angeles, CA",
  stage: "Applied",
  stage_kind: "applied",
  disqualified: false,
  source: "applied",
  assignee_id: null,
  raw: {},
  photo_url: null,
  created_at: appliedAt,
  synced_at: appliedAt,
});

export function activityBodies(): string[] {
  return db.table("activity").map((row) => String(row.body ?? ""));
}

export function workingSlice(): Row | null {
  const row = db.table("candidate_working_files").find((item) => item.candidate_id === CANDIDATE_ID);
  if (!row) return null;
  return (row.workspace as Row | undefined) ?? null;
}
