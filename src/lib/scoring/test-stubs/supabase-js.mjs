export function createClient() {
  const client = globalThis.__RDI_TEST_SUPABASE__;
  if (!client) throw new Error("test supabase client was not installed");
  return client;
}
