import { randomUUID } from "node:crypto";

/**
 * In-memory stand-in for the Supabase client methods this attack uses.
 *
 * The real client (@supabase/postgrest-js 2.108.1) posts the insert value as
 * JSON with no length rewrite (PostgrestQueryBuilder.insert sets `body` to the
 * row; PostgrestBuilder fetches `JSON.stringify(this.body)` and only rewrites
 * bigints). Postgres `text` / `jsonb` then store that value up to about 1GB.
 * This double keeps the same row object the route handed to `.insert()` and
 * returns only the columns `.select()` asked for, which is what PostgREST
 * would send back.
 */
export function createMemorySupabase() {
  const tables = new Map();
  const writes = [];
  const selects = [];

  function tableRows(table) {
    let rows = tables.get(table);
    if (!rows) {
      rows = [];
      tables.set(table, rows);
    }
    return rows;
  }

  function project(list, columns) {
    if (!columns || columns.trim() === "*") return list.map((row) => ({ ...row }));
    const cols = columns.split(",").map((col) => col.trim()).filter(Boolean);
    return list.map((row) => {
      const out = {};
      for (const col of cols) out[col] = row[col];
      return out;
    });
  }

  function from(table) {
    const state = {
      op: "select",
      filters: [],
      columns: null,
      orders: [],
      range: null,
      limit: null,
      insertRows: null,
      patch: null,
      single: null,
    };

    const api = {
      insert(row) {
        state.op = "insert";
        state.insertRows = Array.isArray(row) ? row : [row];
        return api;
      },
      upsert(row) {
        return api.insert(row);
      },
      update(patch) {
        state.op = "update";
        state.patch = patch;
        return api;
      },
      select(columns = "*") {
        state.columns = columns;
        if (state.op !== "insert") {
          selects.push({ table, columns: String(columns) });
        }
        return api;
      },
      eq(col, val) {
        state.filters.push((row) => row[col] === val);
        return api;
      },
      neq(col, val) {
        state.filters.push((row) => row[col] !== val);
        return api;
      },
      ilike(col, val) {
        const needle = String(val).toLowerCase();
        state.filters.push((row) => String(row[col] ?? "").toLowerCase() === needle);
        return api;
      },
      in(col, vals) {
        const allowed = new Set(vals);
        state.filters.push((row) => allowed.has(row[col]));
        return api;
      },
      gte(col, val) {
        state.filters.push((row) => String(row[col] ?? "") >= String(val));
        return api;
      },
      order(col, opts) {
        state.orders.push({ col, ascending: opts?.ascending !== false });
        return api;
      },
      range(fromIdx, toIdx) {
        state.range = [fromIdx, toIdx];
        return api;
      },
      limit(n) {
        state.limit = n;
        return api;
      },
      maybeSingle() {
        state.single = "maybe";
        return api.execute();
      },
      single() {
        state.single = "one";
        return api.execute();
      },
      then(resolve, reject) {
        return api.execute().then(resolve, reject);
      },
      execute() {
        if (state.op === "insert") {
          const stored = state.insertRows.map((row) => {
            const copy = { ...row };
            if (!copy.id) copy.id = randomUUID();
            if (!copy.created_at) copy.created_at = new Date().toISOString();
            tableRows(table).push(copy);
            writes.push({ table, row: copy });
            return copy;
          });
          const data = state.columns ? project(stored, state.columns) : stored;
          if (state.single) return Promise.resolve({ data: data[0] ?? null, error: null });
          return Promise.resolve({ data: state.columns ? data : null, error: null });
        }

        if (state.op === "update") {
          const matched = tableRows(table).filter((row) => state.filters.every((fn) => fn(row)));
          for (const row of matched) Object.assign(row, state.patch);
          return Promise.resolve({ data: null, error: null });
        }

        let list = tableRows(table).filter((row) => state.filters.every((fn) => fn(row)));
        if (state.orders.length) {
          list = [...list].sort((a, b) => {
            for (const order of state.orders) {
              const av = a[order.col] ?? "";
              const bv = b[order.col] ?? "";
              if (av < bv) return order.ascending ? -1 : 1;
              if (av > bv) return order.ascending ? 1 : -1;
            }
            return 0;
          });
        }
        if (state.range) list = list.slice(state.range[0], state.range[1] + 1);
        else if (state.limit != null) list = list.slice(0, state.limit);
        const data = project(list, state.columns ?? "*");
        if (state.single) return Promise.resolve({ data: data[0] ?? null, error: null });
        return Promise.resolve({ data, error: null });
      },
    };

    return api;
  }

  return {
    from,
    writes,
    selects,
    rows(table) {
      return tableRows(table);
    },
    /** Insert rows immediately. Seed data is not an attack write. */
    seed(table, rowOrRows) {
      const list = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
      for (const row of list) {
        tableRows(table).push({
          id: randomUUID(),
          created_at: new Date().toISOString(),
          ...row,
        });
      }
    },
  };
}
