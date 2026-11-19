const { memorySupabase } = require("./memory-supabase.cjs");

function getServiceSupabase() {
  return memorySupabase;
}

function getAnonSupabase() {
  return memorySupabase;
}

exports.getServiceSupabase = getServiceSupabase;
exports.getAnonSupabase = getAnonSupabase;
