import { parse, toClientConfig } from "pg-connection-string";

/**
 * Build a `pg` client config that always uses TLS with certificate and
 * hostname verification.
 *
 * TLS parameters in the connection string (`sslmode`, `ssl`, `sslrootcert`,
 * `uselibpqcompat`, ...) are dropped: when `pg` is given a `connectionString`,
 * those parameters override the `ssl` option, so `sslmode=no-verify` or
 * `sslmode=disable` would silently turn verification back off.
 *
 * @param {string} connectionString Postgres URL (DATABASE_URL / SUPABASE_DB_URL).
 * @param {string | undefined} rootCertPem PEM CA bundle to trust instead of the
 *   default store, e.g. the Supabase root CA. Literal `\n` sequences are
 *   accepted so the PEM can be stored as a single-line env value.
 * @returns {import("pg").ClientConfig}
 */
export function verifiedPgConfig(connectionString, rootCertPem) {
  const parsed = parse(connectionString);
  for (const key of Object.keys(parsed)) {
    if (key.startsWith("ssl") || key === "uselibpqcompat") delete parsed[key];
  }

  const ca = rootCertPem?.trim() ? rootCertPem.replace(/\\n/g, "\n") : undefined;

  return {
    ...toClientConfig(parsed),
    ssl: ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true },
  };
}
