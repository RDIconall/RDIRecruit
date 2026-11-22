import path from "node:path";
import { pathToFileURL } from "node:url";
import { mock } from "node:test";

export type TableRow = Record<string, unknown>;

type Filter = (row: TableRow) => boolean;

/**
 * In-memory stand-in for the Supabase query builder the capture and pool
 * loaders actually call. Filters run on a copy of the stored rows, and insert
 * / upsert write back into that store, so a later select sees the write.
 */
export function createMemorySupabase(initial: Record<string, TableRow[]> = {}) {
  const tables = new Map<string, TableRow[]>();
  for (const [name, rows] of Object.entries(initial)) {
    tables.set(name, rows.map((row) => ({ ...row })));
  }

  function stored(table: string): TableRow[] {
    let rows = tables.get(table);
    if (!rows) {
      rows = [];
      tables.set(table, rows);
    }
    return rows;
  }

  function builder(table: string) {
    let rows = stored(table).map((row) => ({ ...row }));
    let head = false;
    let counting = false;

    const api = {
      select(_columns?: string, options?: { count?: "exact"; head?: boolean }) {
        if (options?.head) head = true;
        if (options?.count) counting = true;
        return api;
      },
      insert(payload: TableRow | TableRow[]) {
        const incoming = Array.isArray(payload) ? payload : [payload];
        const written = incoming.map((row) => ({
          id: crypto.randomUUID(),
          created_at: new Date().toISOString(),
          ...row,
        }));
        stored(table).push(...written);
        rows = written;
        return api;
      },
      upsert(payload: TableRow) {
        const list = stored(table);
        const key = payload.candidate_id;
        const index =
          key === undefined ? -1 : list.findIndex((row) => row.candidate_id === key);
        const written = {
          id: crypto.randomUUID(),
          created_at: new Date().toISOString(),
          ...(index >= 0 ? list[index] : {}),
          ...payload,
        };
        if (index >= 0) list[index] = written;
        else list.push(written);
        rows = [written];
        return api;
      },
      update(patch: TableRow) {
        rows = rows.map((row) => ({ ...row, ...patch }));
        return api;
      },
      delete() {
        return api;
      },
      eq(column: string, value: unknown) {
        return filter((row) => row[column] === value);
      },
      neq(column: string, value: unknown) {
        return filter((row) => row[column] !== value);
      },
      in(column: string, values: unknown[]) {
        const allowed = new Set(values);
        return filter((row) => allowed.has(row[column]));
      },
      gte(column: string, value: unknown) {
        return filter((row) => String(row[column] ?? "") >= String(value));
      },
      lte(column: string, value: unknown) {
        return filter((row) => String(row[column] ?? "") <= String(value));
      },
      lt(column: string, value: unknown) {
        return filter((row) => String(row[column] ?? "") < String(value));
      },
      is(column: string, value: unknown) {
        return filter((row) => (row[column] ?? null) === value);
      },
      order() {
        return api;
      },
      limit(count: number) {
        rows = rows.slice(0, count);
        return api;
      },
      range(from: number, to: number) {
        rows = rows.slice(from, to + 1);
        return api;
      },
      maybeSingle() {
        return Promise.resolve(result(rows[0] ?? null));
      },
      single() {
        const row = rows[0] ?? null;
        return Promise.resolve({
          ...result(row),
          error: row ? null : { message: "No row", code: "PGRST116" },
        });
      },
      then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
        return Promise.resolve(result(head ? null : rows)).then(resolve, reject);
      },
    };

    function filter(predicate: Filter) {
      rows = rows.filter(predicate);
      return api;
    }

    function result(data: unknown) {
      return { data, error: null, count: counting ? rows.length : null };
    }

    return api;
  }

  return {
    from(table: string) {
      return builder(table);
    },
    rows(table: string): TableRow[] {
      return stored(table).map((row) => ({ ...row }));
    },
  };
}

export function installSupabaseMock(supabase: ReturnType<typeof createMemorySupabase>) {
  const href = pathToFileURL(path.resolve("src/lib/supabase/server.ts")).href;
  mock.module(href, {
    namedExports: {
      getServiceSupabase: () => supabase,
      getAnonSupabase: () => supabase,
    },
  });
}

export function installServerOnlyMock() {
  mock.module("server-only", { namedExports: {} });
}
