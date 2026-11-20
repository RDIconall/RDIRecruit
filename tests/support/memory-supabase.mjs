const SLOT = Symbol.for("rdi.recruit.memorySupabase");

export function getServiceSupabase() {
  const current = globalThis[SLOT];
  if (!current) throw new Error("memory supabase not installed");
  return current;
}

export function getAnonSupabase() {
  return getServiceSupabase();
}

export function setMemorySupabase(db) {
  globalThis[SLOT] = db;
}
