import http from "node:http";

/**
 * Speaks the PostgREST requests that @supabase/postgrest-js 2.108.1 actually
 * sends (POST insert body, GET with select + eq filters, maybeSingle arrays).
 *
 * Acceptance matches Supabase Postgres: the service role bypasses row level
 * security (`create role service_role nologin noinherit bypassrls` in
 * supabase/postgres init-scripts/00000000000000-initial-schema.sql) and the
 * app's service client is the caller. Any other bearer is rejected, which is
 * what `comms_log` does with RLS enabled and no policy.
 */
export const SERVICE_KEY_PLACEHOLDER = "test-service-key-placeholder";
export const APPLICANT_EMAIL = "applicant@example.com";
export const APPLICANT_ID = "cand_real";

export type CapturedRequest = {
  method: string;
  path: string;
  body: unknown;
  authorization: string;
};

export type PostgrestStandIn = {
  url: string;
  requests: CapturedRequest[];
  rest: () => CapturedRequest[];
  writes: () => CapturedRequest[];
  close: () => Promise<void>;
};

export async function startPostgrestStandIn(): Promise<PostgrestStandIn> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = null;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      const authorization = req.headers.authorization ?? "";
      requests.push({
        method: req.method ?? "",
        path: `${url.pathname}${url.search}`,
        body,
        authorization,
      });

      if (!url.pathname.startsWith("/rest/v1/")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }

      const service = authorization === `Bearer ${SERVICE_KEY_PLACEHOLDER}`;
      if (!service) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "permission denied", code: "42501" }));
        return;
      }

      const table = url.pathname.slice("/rest/v1/".length).split("/")[0];
      if (req.method === "GET" && table === "candidates") {
        const filter = url.searchParams.get("email") ?? "";
        const email = filter.startsWith("eq.") ? filter.slice(3) : "";
        const rows =
          email === APPLICANT_EMAIL
            ? [{ workable_id: APPLICANT_ID, job_shortcode: "seat", stage: "applied" }]
            : [];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(rows));
        return;
      }

      if (req.method === "POST" && (table === "events" || table === "comms_log")) {
        const prefer = req.headers.prefer ?? "";
        const wantsRow = prefer.includes("return=representation");
        res.writeHead(201, { "content-type": "application/json" });
        res.end(wantsRow ? JSON.stringify([{ id: "row_test" }]) : "");
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "not found" }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("stand-in failed to bind");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    rest: () => requests.filter((request) => request.path.startsWith("/rest/v1/")),
    writes: () =>
      requests.filter(
        (request) =>
          request.path.startsWith("/rest/v1/") &&
          request.method !== "GET" &&
          request.method !== "HEAD",
      ),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
