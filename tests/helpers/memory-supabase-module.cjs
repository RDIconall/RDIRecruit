function getServiceSupabase() {
  const db = global.__RDI_MEMORY_SUPABASE__;
  if (!db) throw new Error("memory supabase was not installed");
  return db;
}

module.exports = {
  getServiceSupabase,
  getAnonSupabase: getServiceSupabase,
};
