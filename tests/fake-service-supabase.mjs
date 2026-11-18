// Stand-in for the PostgREST query the service key sends. Each call runs in one
// transaction as authenticator, then set_config('role','service_role', true),
// which is the switch PostgREST applies before the statement. The SQL itself
// is executed by Postgres.

function ident(value) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) {
    throw new Error(`refusing identifier ${value}`);
  }
  return `"${value}"`;
}

function columnList(columns) {
  if (columns.trim() === "*") return "*";
  return columns.split(",").map((column) => ident(column.trim())).join(", ");
}

async function runAsServiceRole(sql, params) {
  const pool = globalThis.__rdiPgPool;
  if (!pool) throw new Error("test database pool is not set");
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local session authorization authenticator");
    await client.query("select set_config('role', 'service_role', true)");
    const result = await client.query(sql, params);
    await client.query("commit");
    return { data: result.rows, error: null, rowCount: result.rowCount };
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // The transaction is already closed.
    }
    const message = error instanceof Error ? error.message : String(error);
    return { data: null, error: { message }, rowCount: 0 };
  } finally {
    client.release();
  }
}

function from(table) {
  const state = {
    table,
    columns: "*",
    filters: [],
    order: null,
    limit: null,
  };

  const execute = async (mode) => {
    const params = [];
    const where = [];
    for (const filter of state.filters) {
      if (filter.op === "eq") {
        params.push(filter.value);
        where.push(`${ident(filter.column)} = $${params.length}`);
      } else if (filter.op === "in") {
        const values = [...filter.value];
        if (!values.length) {
          where.push("false");
          continue;
        }
        const holders = values.map((value) => {
          params.push(value);
          return `$${params.length}`;
        });
        where.push(`${ident(filter.column)} in (${holders.join(", ")})`);
      } else {
        throw new Error(`unsupported filter ${filter.op}`);
      }
    }
    let sql = `select ${columnList(state.columns)} from ${ident(state.table)}`;
    if (where.length) sql += ` where ${where.join(" and ")}`;
    if (state.order) {
      sql += ` order by ${ident(state.order.column)} ${state.order.ascending ? "asc" : "desc"}`;
    }
    if (state.limit != null) sql += ` limit ${Number(state.limit)}`;
    const result = await runAsServiceRole(sql, params);
    if (result.error) return { data: null, error: result.error };
    if (mode === "many") return { data: result.data, error: null };
    if (mode === "maybe") {
      if (result.data.length > 1) return { data: null, error: { message: "multiple rows" } };
      return { data: result.data[0] ?? null, error: null };
    }
    if (result.data.length !== 1) return { data: null, error: { message: "expected one row" } };
    return { data: result.data[0], error: null };
  };

  const builder = {
    select(columns) {
      state.columns = columns;
      return builder;
    },
    eq(column, value) {
      state.filters.push({ op: "eq", column, value });
      return builder;
    },
    in(column, value) {
      state.filters.push({ op: "in", column, value });
      return builder;
    },
    order(column, options) {
      state.order = { column, ascending: options?.ascending !== false };
      return builder;
    },
    limit(count) {
      state.limit = count;
      return builder;
    },
    maybeSingle() {
      return execute("maybe");
    },
    single() {
      return execute("single");
    },
    then(resolve, reject) {
      return execute("many").then(resolve, reject);
    },
  };
  return builder;
}

export function getServiceSupabase() {
  return { from };
}

export function getAnonSupabase() {
  throw new Error("anon client is not used by the scoring path");
}
